/**
 * Interactive `/debate setup` wizard (§13.55).
 *
 * Intentionally lives outside index.ts: it is a small, testable boundary between pi's
 * dialogs and the configuration file. It never reads or displays a credential; it uses
 * ModelRegistry's configured/not-configured status only, so the provider check is safe
 * to run in a transcript or RPC client.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  DURATION_EXAMPLES,
  formatDuration,
  parseDuration,
  ROLES,
  TIERS,
  type DebateConfig,
  type Role,
} from "./config.ts";
import { readSeedFile } from "./command.ts";

/** Small structural slice of pi's command context. Kept host-package-free so the
 * offline suite can type-check this wizard without installing pi as a dependency. */
export interface SetupContext {
  cwd: string;
  hasUI: boolean;
  isProjectTrusted?: () => boolean;
  scopedModels: Array<{ model: { provider: string; id: string } }>;
  modelRegistry: {
    getProviderAuthStatus(provider: string): { configured: boolean };
    getAvailable(): Array<{ provider: string; id: string }>;
  };
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    editor(title: string, prefilled?: string): Promise<string | undefined>;
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}

export interface SetupResult {
  /** Config reloaded after the user approved the final summary. */
  config: DebateConfig;
  seedText: string;
  seedSource: string;
  /** Model selection is usable even if the project was not trusted on entry: setup wrote trust. */
  projectTrusted: boolean;
}

type JsonObject = Record<string, unknown>;
type Scope = "global" | "local";

const FREE_PROVIDER = "ibm-services-essentials";
const RECOMMENDED_TIER = "ibm";

function agentDir(): string {
  return process.env.PI_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
}

function readObject(path: string): JsonObject {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as JsonObject;
}

/** Atomic enough for a user config: never leave a truncated JSON file after Ctrl-C. */
function writeJson(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function splitModel(value: string): [provider: string, id: string] {
  const slash = value.indexOf("/");
  return slash < 0 ? [value, ""] : [value.slice(0, slash), value.slice(slash + 1)];
}

function authLabel(ctx: SetupContext, provider: string): string {
  const auth = ctx.modelRegistry.getProviderAuthStatus(provider);
  // This is intentionally a credential-resolution check, not a paid model probe:
  // selecting a roster must not itself consume tokens or create a bill. It is evaluated
  // against pi's live session registry on every wizard invocation (env/stored/OAuth).
  return auth.configured ? "credentials configured" : "NO credentials";
}

function knownModels(ctx: SetupContext, recommended: Record<Role, string>): string[] {
  // Honour scoped models if the session has them; otherwise use pi's full current catalogue.
  const catalogue = ctx.scopedModels.length > 0
    ? ctx.scopedModels.map((entry) => entry.model)
    : ctx.modelRegistry.getAvailable();
  const values = catalogue.map((model) => `${model.provider}/${model.id}`);
  return [...new Set([...Object.values(recommended), ...values])].sort();
}

async function askDuration(
  ctx: SetupContext,
  title: string,
  defaultMs: number,
): Promise<string | null> {
  const hint = `${formatDuration(defaultMs)}. Examples: ${DURATION_EXAMPLES}`;
  while (true) {
    const raw = await ctx.ui.input(title, hint);
    if (raw === undefined) return null;
    try {
      // Parse now (hard failure), but retain the human spelling in the generated JSON.
      parseDuration(raw, title);
      return raw.trim();
    } catch (e) {
      ctx.ui.notify((e as Error).message, "error");
    }
  }
}

async function askPositiveNumber(
  ctx: SetupContext,
  title: string,
  placeholder: string,
): Promise<number | null> {
  while (true) {
    const raw = await ctx.ui.input(title, placeholder);
    if (raw === undefined) return null;
    const value = Number(raw.trim());
    if (Number.isFinite(value) && value > 0) return value;
    ctx.ui.notify(`${title}: enter a positive number`, "error");
  }
}

async function chooseModels(
  ctx: SetupContext,
  tier: string,
): Promise<Record<Role, string> | null> {
  const selected = { ...TIERS[tier]!.models };
  const customize = await ctx.ui.confirm(
    "Customise roles?",
    "Recommended roster selected. Choose provider/model separately for Ideator, Skeptic, and judge?",
  );
  if (!customize) return selected;

  const all = knownModels(ctx, selected);
  for (const role of ROLES) {
    const [recommendedProvider] = splitModel(selected[role]);
    const providers = [...new Set([recommendedProvider, ...all.map((value) => splitModel(value)[0])])]
      .sort();
    const providerChoices = providers.map((provider) =>
      `${provider} — ${provider === recommendedProvider ? "recommended; " : ""}${authLabel(ctx, provider)}`,
    );
    while (true) {
      const providerChoice = await ctx.ui.select(`${role}: provider`, providerChoices);
      if (providerChoice === undefined) return null;
      const provider = providerChoice.split(" — ")[0]!;

      const models = all.filter((value) => splitModel(value)[0] === provider);
      const recommended = selected[role];
      if (!models.includes(recommended) && provider === recommendedProvider) models.unshift(recommended);
      if (models.length === 0) {
        ctx.ui.notify(`No registered models for ${provider}; choose another provider.`, "warning");
        continue;
      }
      const modelChoice = await ctx.ui.select(
        `${role}: model`,
        models.map((value) => value === recommended ? `${value} — recommended` : value),
      );
      if (modelChoice === undefined) return null;
      selected[role] = modelChoice.replace(/ — recommended$/, "");
      break;
    }
  }
  return selected;
}

function isAllFree(models: Record<Role, string>): boolean {
  return Object.values(models).every((model) => splitModel(model)[0] === FREE_PROVIDER);
}

async function chooseBudget(
  ctx: SetupContext,
  config: DebateConfig,
  models: Record<Role, string>,
): Promise<JsonObject | null> {
  if (isAllFree(models)) {
    ctx.ui.notify(
      "IBM is a fixed-credit/free provider: dollar caps cannot stop a run. Time and token caps are the real guardrails.",
      "warning",
    );
    const total = await askDuration(ctx, "Whole-run time limit", config.timeouts.totalMs);
    if (total === null) return null;
    const turn = await askDuration(ctx, "Per-turn time limit", config.timeouts.turnMs);
    if (turn === null) return null;
    const tokens = await askPositiveNumber(ctx, "Whole-run token limit", String(config.budget.tokens));
    if (tokens === null) return null;
    return { timeouts: { total, turn }, budget: { tokens } };
  }

  const usd = await askPositiveNumber(ctx, "Maximum spend for this run (USD)", String(config.budget.usd));
  if (usd === null) return null;
  const perTurnUsd = Math.min(config.budget.perTurnUsd, usd);
  const budget: JsonObject = { budget: { usd, perTurnUsd } };

  // A mixed roster can incur a bill on one role and burn fixed credits on another. USD
  // caps are real only for the former, so ask for time as well instead of pretending
  // one control protects both.
  const hasFixedCredit = Object.values(models).some(
    (model) => splitModel(model)[0] === FREE_PROVIDER,
  );
  if (hasFixedCredit) {
    ctx.ui.notify(
      "This roster mixes metered and IBM fixed-credit models. USD limits do not bound the IBM role; add time limits too.",
      "warning",
    );
    const total = await askDuration(ctx, "Whole-run time limit", config.timeouts.totalMs);
    if (total === null) return null;
    const turn = await askDuration(ctx, "Per-turn time limit", config.timeouts.turnMs);
    if (turn === null) return null;
    budget.timeouts = { total, turn };
  }
  return budget;
}

async function chooseTopic(
  ctx: SetupContext,
): Promise<{ seedText: string; seedSource: string } | null> {
  while (true) {
    const value = await ctx.ui.editor(
      "What should the debate examine?",
      "Paste or write the topic here. Or enter @path/to/a-file.md to debate a file.",
    );
    if (value === undefined) return null;
    const text = value.trim();
    if (!text) {
      ctx.ui.notify("A topic or @file path is required.", "error");
      continue;
    }
    if (/^@\S+$/.test(text)) {
      try {
        const file = readSeedFile(ctx.cwd, text.slice(1));
        return { seedText: file.text, seedSource: file.path };
      } catch (e) {
        ctx.ui.notify((e as Error).message, "error");
        continue;
      }
    }
    return { seedText: value, seedSource: "setup editor" };
  }
}

function buildPatch(
  tier: string,
  models: Record<Role, string>,
  budget: JsonObject,
): JsonObject {
  const patch: JsonObject = { tier, ...budget };
  const tierModels = TIERS[tier]!.models;
  // Only write role overrides where the user departed from the selected recommendation.
  const roles: JsonObject = {};
  for (const role of ROLES) {
    if (models[role] !== tierModels[role]) roles[role] = { model: models[role] };
  }
  if (Object.keys(roles).length > 0) patch.roles = roles;
  return patch;
}

function saveConfig(scope: Scope, cwd: string, patch: JsonObject): string {
  if (scope === "local") {
    const path = join(cwd, ".pi", "debate.json");
    // Deliberately overwrite. The user confirmed the generated summary; merge would leave
    // stale per-role overrides, the most confusing possible outcome for a setup wizard.
    writeJson(path, patch);
    return path;
  }
  const path = join(agentDir(), "settings.json");
  const settings = readObject(path);
  settings.debate = patch;
  writeJson(path, settings);
  return path;
}

function trustProject(cwd: string): void {
  const path = join(agentDir(), "trust.json");
  const trust = readObject(path);
  trust[cwd] = true;
  writeJson(path, trust);
}

/**
 * Ask for a minimally scoped config, write it only after review, and return the topic.
 * `reload` is injected so index.ts owns the config layering policy and this module stays
 * UI/file focused.
 */
export async function runSetupWizard(
  ctx: SetupContext,
  current: DebateConfig,
  reload: (projectTrusted: boolean) => DebateConfig,
): Promise<SetupResult | null> {
  if (!ctx.hasUI) return null;

  const scopeChoice = await ctx.ui.select("Where should debate settings be saved?", [
    "Global — use in every directory",
    "This project — write .pi/debate.json",
  ]);
  if (scopeChoice === undefined) return null;
  const scope: Scope = scopeChoice.startsWith("Global") ? "global" : "local";

  let trust = ctx.isProjectTrusted?.() ?? true;
  if (scope === "local" && !trust) {
    trust = await ctx.ui.confirm(
      "Trust this project?",
      "A project debate config can select paid models. Trust this project so its .pi/debate.json can take effect?",
    );
    if (!trust) {
      ctx.ui.notify("Setup cancelled: an untrusted project cannot use its local debate configuration.", "warning");
      return null;
    }
  }

  const tierChoices = Object.entries(TIERS).map(([name, value]) => {
    const providers = [...new Set(Object.values(value.models).map((model) => splitModel(model)[0]))];
    const auth = providers.map((provider) => `${provider}: ${authLabel(ctx, provider)}`).join(", ");
    return `${name}${name === RECOMMENDED_TIER ? " — recommended" : ""} · ${value.note} · ${auth}`;
  });
  const tierChoice = await ctx.ui.select("Choose a recommended model roster", tierChoices);
  if (tierChoice === undefined) return null;
  const tier = tierChoice.split(/ — | · /)[0]!;

  const models = await chooseModels(ctx, tier);
  if (!models) return null;
  const budget = await chooseBudget(ctx, current, models);
  if (!budget) return null;
  const topic = await chooseTopic(ctx);
  if (!topic) return null;

  const patch = buildPatch(tier, models, budget);
  const target = scope === "local" ? join(ctx.cwd, ".pi", "debate.json") : join(agentDir(), "settings.json");
  const summary = [
    `Save: ${target}${scope === "local" ? " (overwrite)" : " (replace settings.debate only)"}`,
    `Roster: ${ROLES.map((role) => `${role}=${models[role]}`).join("; ")}`,
    `Guardrails: ${JSON.stringify(budget)}`,
    `Topic: ${topic.seedSource} (${topic.seedText.length.toLocaleString()} chars)`,
  ];
  if (!await ctx.ui.confirm("Start this debate?", `${summary.join("\n")}\n\nThe config is only written if you confirm.`)) {
    return null;
  }

  const path = saveConfig(scope, ctx.cwd, patch);
  if (scope === "local" && trust && !(ctx.isProjectTrusted?.() ?? false)) trustProject(ctx.cwd);
  ctx.ui.notify(`Saved ${path}`, "info");
  return { config: reload(scope === "local" ? trust : (ctx.isProjectTrusted?.() ?? true)), ...topic, projectTrusted: trust };
}
