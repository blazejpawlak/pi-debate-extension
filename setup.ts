/**
 * Interactive `/debate setup` wizard (§13.55).
 *
 * Intentionally lives outside index.ts: it is a small, testable boundary between pi's
 * dialogs and the configuration file. It never reads or displays a credential; it uses
 * ModelRegistry's configured/not-configured status only, so the provider check is safe
 * to run in a transcript or RPC client.
 */

import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

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

/**
 * Public picker copy — deliberately separate from TIERS' engineering notes. `TIERS.note`
 * records historical probes and implementation rationale; it must never become end-user
 * UI copy. Keep labels compact enough for an 80-column terminal.
 */
export const TIER_PICKER_COPY: Record<string, { name: string; cost: string; summary: string }> = {
  ibm: {
    name: "IBM (recommended)",
    cost: "$0",
    summary: "3 distinct model perspectives",
  },
  free: {
    name: "Free starter",
    cost: "$0",
    summary: "limited independent review",
  },
  cheap: {
    name: "Lower cost",
    cost: "low cost",
    summary: "3 distinct model perspectives",
  },
  default: {
    name: "Balanced",
    cost: "paid",
    summary: "high-quality 3-model review",
  },
  strong: {
    name: "Max scrutiny",
    cost: "paid",
    summary: "needs Codex access",
  }
};
const TIER_PICKER_ORDER = ["ibm", "free", "cheap", "default", "strong"];
const PROVIDER_DISPLAY: Record<string, string> = {
  "ibm-services-essentials": "IBM",
  "openai-codex": "Codex",
  openrouter: "OpenRouter",
};

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
  return auth.configured ? "configured" : "sign in needed";
}

/** Compact, public-only tier label for pi's string-only select dialog. */
export function tierPickerLabel(
  tier: string,
  providerConfigured: (provider: string) => boolean,
): string {
  const copy = TIER_PICKER_COPY[tier];
  if (!copy || !TIERS[tier]) throw new Error(`unknown debate tier: ${tier}`);
  const providers = [...new Set(Object.values(TIERS[tier]!.models).map((model) => splitModel(model)[0]))];
  const badges = providers.map((provider) => {
    const name = PROVIDER_DISPLAY[provider] ?? provider;
    return providerConfigured(provider) ? `${name} ✓` : `${name} · sign in`;
  });
  return `${copy.name} · ${copy.cost} · ${copy.summary} · ${badges.join(" ")}`;
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

const FILE_PICKER_MANUAL = "Type a file path instead…";
const FILE_PICKER_SKIP = new Set([".git", ".debate", ".pi", "node_modules", "dist", "build", "coverage"]);

/**
 * A bounded project file picker for dialogs. pi's main editor supplies `@` completion,
 * but `ctx.ui.editor()` intentionally does not, so relying on `@` here made file debate
 * look broken. Ignore generated/private directories and symlinks, cap both depth and
 * entries, and return cwd-relative paths suitable for readSeedFile().
 */
export function listProjectFiles(cwd: string, max = 200): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || files.length >= max) return;
    const entries = (() => {
      try { return readdirSync(dir, { withFileTypes: true }); } catch { return null; }
    })();
    if (!entries) return;
    for (const entry of entries) {
      if (files.length >= max) return;
      // Hidden files commonly contain credentials (.env, .npmrc, etc.); do not make
      // them one accidental selection away from being sent to debate models.
      if (entry.isSymbolicLink() || entry.name.startsWith(".") || FILE_PICKER_SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path, depth + 1); continue; }
      if (!entry.isFile()) continue;
      try {
        // Do not offer a multi-megabyte binary/blob as a debate seed.
        if (statSync(path).size > 2 * 1024 * 1024) continue;
        files.push(relative(cwd, path));
      } catch { /* raced/deleted files are simply absent */ }
    }
  };
  walk(cwd, 0);
  return files.sort((a, b) => a.localeCompare(b));
}

async function readTopicFile(ctx: SetupContext, path: string): Promise<{ seedText: string; seedSource: string } | null> {
  try {
    const file = readSeedFile(ctx.cwd, path.replace(/^@/, ""));
    return { seedText: file.text, seedSource: file.path };
  } catch (e) {
    ctx.ui.notify((e as Error).message, "error");
    return null;
  }
}

async function chooseFile(ctx: SetupContext): Promise<{ seedText: string; seedSource: string } | null> {
  const files = listProjectFiles(ctx.cwd);
  if (files.length > 0) {
    const selected = await ctx.ui.select("Choose a file to debate", [...files, FILE_PICKER_MANUAL]);
    if (selected === undefined) return null;
    if (selected !== FILE_PICKER_MANUAL) return readTopicFile(ctx, selected);
  }
  const path = await ctx.ui.input("File to debate", "path/to/plan.md (or an absolute path)");
  if (path === undefined) return null;
  return path.trim() ? readTopicFile(ctx, path.trim()) : null;
}

async function chooseTopic(
  ctx: SetupContext,
): Promise<{ seedText: string; seedSource: string } | null> {
  const source = await ctx.ui.select("What should the debate examine?", [
    "Choose a file from this project",
    "Paste or write a topic",
    "Type a file path",
  ]);
  if (source === undefined) return null;
  if (source === "Choose a file from this project") return chooseFile(ctx);
  if (source === "Type a file path") {
    const path = await ctx.ui.input("File to debate", "path/to/plan.md (or an absolute path)");
    return path?.trim() ? readTopicFile(ctx, path.trim()) : null;
  }

  while (true) {
    const value = await ctx.ui.editor(
      "Write or paste the topic",
      "Paste the plan, question, or proposal to debate. For a file, cancel and choose ‘Choose a file’. ",
    );
    if (value === undefined) return null;
    const text = value.trim();
    if (!text) {
      ctx.ui.notify("A topic is required.", "error");
      continue;
    }
    // Keep @path as a convenient manual shortcut, but do not claim it opens a picker.
    if (/^@\S+$/.test(text)) {
      const file = await readTopicFile(ctx, text);
      if (file) return file;
      continue;
    }
    return { seedText: value, seedSource: "setup editor" };
  }
}

function buildPatch(
  tier: string,
  models: Record<Role, string>,
  budget: JsonObject,
  artifactEnabled: boolean,
): JsonObject {
  const patch: JsonObject = { tier, ...budget, artifact: { enabled: artifactEnabled } };
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

  const tierChoices = TIER_PICKER_ORDER
    .filter((tier) => TIERS[tier] !== undefined)
    .map((tier) => ({
      tier,
      label: tierPickerLabel(tier, (provider) => ctx.modelRegistry.getProviderAuthStatus(provider).configured),
    }));
  const tierChoice = await ctx.ui.select(
    "Choose a review profile",
    tierChoices.map((choice) => choice.label),
  );
  if (tierChoice === undefined) return null;
  const tier = tierChoices.find((choice) => choice.label === tierChoice)?.tier;
  if (!tier) throw new Error("selected an unknown review profile");

  const models = await chooseModels(ctx, tier);
  if (!models) return null;
  const budget = await chooseBudget(ctx, current, models);
  if (!budget) return null;
  const topic = await chooseTopic(ctx);
  if (!topic) return null;
  const artifactEnabled = await ctx.ui.confirm(
    "Create a corrected draft?",
    "After the review, run one bounded editor pass to create a separate human-review-only draft. " +
    "It never replaces the source and adds one model turn to cost/time.",
  );

  const patch = buildPatch(tier, models, budget, artifactEnabled);
  const target = scope === "local" ? join(ctx.cwd, ".pi", "debate.json") : join(agentDir(), "settings.json");
  const summary = [
    `Save: ${target}${scope === "local" ? " (overwrite)" : " (replace settings.debate only)"}`,
    `Roster: ${ROLES.map((role) => `${role}=${models[role]}`).join("; ")}`,
    `Guardrails: ${JSON.stringify(budget)}`,
    `Corrected draft: ${artifactEnabled ? "enabled (human review required)" : "disabled"}`,
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
