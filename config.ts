/**
 * config.ts — defaults <- settings.json "debate" <- <workspace>/.pi/debate.json
 *
 * Design refs: §9.5 (config shape), §4 (models), §13 items 14/15/16/18/19 (WP0 findings).
 *
 * Two deviations from §9.5, both recorded in §13 and both consequences of WP0:
 *   - Default models are the WP0-verified roster, not the §4 literals. ibm-services-essentials
 *     reports cost.total==0 for all 19 models (§13.14) and opencode has no balance (§13.15).
 *   - budget gains `perTurnTokens` and `costReporting` (§13.19): a USD cap is only enforceable
 *     when the provider ships a price table, so tokens are the always-on backstop.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type Severity = "low" | "medium" | "high" | "critical";
export type Mode = "review" | "explore";
export type RunnerKind = "direct" | "harness" | "fake";
export type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
/**
 * How to treat a turn that completes with usage.tokens > 0 but cost.total == 0.
 *  warn    - log `cost_unreported`, keep going, mark run costTrusted:false (default)
 *  require - treat as a budget violation and stop the run; use when the $ cap must be real
 *  ignore  - old behavior; the cost cap silently does nothing for that provider
 */
export type CostReporting = "warn" | "require" | "ignore";

/**
 * Per-role overrides (§13.28). Every field is optional; anything omitted falls back to
 * the run-level default, so a bare `{}` behaves exactly as before this existed.
 *
 * `budget.usd`/`budget.tokens` stay the run-level ceilings. A role budget is an
 * ADDITIONAL, narrower constraint - it can only ever stop a role sooner than the run
 * cap would, never authorize it to exceed the run cap. That ordering matters: it means
 * adding role budgets can never increase total spend.
 */
export interface RoleBudget {
  /** Cumulative USD this role may spend across all its turns in a run. */
  usd?: number;
  /** Cumulative tokens this role may spend across all its turns in a run. */
  tokens?: number;
  /** Mid-turn kill ceiling for this role's turns, overriding budget.perTurnUsd. */
  perTurnUsd?: number;
  /** Mid-turn token ceiling for this role's turns, overriding budget.perTurnTokens. */
  perTurnTokens?: number;
  /** Per-turn wall clock for this role, overriding timeouts.turnMs. */
  turnMs?: number;
}

/** Full per-role configuration: which model, how it thinks, what it may spend. */
export interface RoleConfig {
  /** "<provider>/<model>", split on the FIRST slash only (§4). null = persona frontmatter. */
  model?: string | null;
  thinking?: ThinkingLevel;
  /** Explicit tool allowlist. Omitted = the role's default set. */
  tools?: string[] | "none";
  budget?: RoleBudget;
  /**
   * Declare this model as billing nothing (§13.29). Suppresses the `cost_unreported`
   * warning and excludes the role from `costReporting: "require"`, because a free
   * model legitimately reports cost.total = 0 and is not evidence of a broken
   * price table. Token caps still apply - free is not unlimited.
   */
  free?: boolean;
}

export type Role = "ideator" | "skeptic" | "synthesizer";
export const ROLES: Role[] = ["ideator", "skeptic", "synthesizer"];

export interface RoleModel {
  /** provider id passed to `--provider` */
  provider: string | null;
  /** model id passed to `--model`; may itself contain slashes (openrouter) */
  model: string;
}

export interface DebateConfig {
  runner: RunnerKind;
  /**
   * Named roster preset: "free" | "cheap" | "default" (§13.30). Applied after config
   * merge; an explicit `roles.<role>.model` always overrides it. null = no tier.
   */
  tier: string | null;
  mode: { reviewThresholdChars: number };
  rounds: { max: number; gateSeverity: Severity };
  timeouts: { turnMs: number; totalMs: number;
    /**
     * §13.50: extra wall clock the judge may use AFTER `totalMs` is exhausted.
     *
     * `totalMs` deliberately stops rounds but not the verdict — a debate that spends its
     * budget and returns nothing is worse than one that returns a `partial` verdict. But
     * unbounded is wrong too: the judge is the largest single turn (the whole seed is
     * inlined for it), and on a slow zero-dollar provider it is the realistic runaway.
     * This is that bound. Set 0 to forbid a judge turn once the budget is gone.
     */
    verdictGraceMs: number };
  budget: {
    tokens: number;
    usd: number;
    perTurnUsd: number;
    /** WP0 addition (§13.19): bounds a runaway loop even with no price table. */
    perTurnTokens: number;
    /** WP0 addition (§13.19). */
    costReporting: CostReporting;
  };
  repairs: { max: number };
  /**
   * Legacy flat form, kept working: `models.ideator = "provider/model"`.
   * Prefer `roles.<role>.model`. When both are set, `roles` wins and a warning is
   * emitted, because silently preferring one would make the effective model unguessable.
   */
  models: {
    ideator: string | null;
    skeptic: string | null;
    synthesizer: string | null;
  };
  /** Per-role model / thinking / tools / budget (§13.28). */
  roles: Record<Role, RoleConfig>;
  /**
   * Models known to bill nothing, as "<provider>/<model>" (§13.29). Matched exactly
   * against the resolved provider/model string. A role whose model is listed here is
   * treated as `free: true` without needing a per-role flag.
   */
  freeModels: string[];
  thinking: {
    ideator: ThinkingLevel;
    skeptic: ThinkingLevel;
    synthesizer: ThinkingLevel;
  };
  skeptic: {
    allowBash: boolean;
    freeAgreements: number;
    minFlaws: number;
    /**
     * §13.36 (WP5 fix): how many of the Skeptic's flaws must carry ACTUAL command output
     * in `evidence` each round. WP5 measured 3 bash calls per run against a baseline's 28;
     * asking for tests as strings produced strings.
     */
    minEvidencedFlaws: number;
  };
  /**
   * §13.35 (WP5 fix, revised): flag a high/critical claim asserted without evidence as
   * `high_severity_unverified` and treat it as an open question in the judge's audit and
   * the verdict. The severity is NOT demoted - demoting removes it from the R3 gate,
   * which suppresses the very scrutiny it needs. Set false to disable the flagging.
   */
  requireEvidenceForHigh: boolean;
  synthesizer: { inlineFullSeedUnderChars: number };
  children: { contextFiles: boolean; extraArgs: string[] };
  lessons: { enabled: boolean; maxLines: number };
  inject: "nextTurn" | "followUp" | "none";
  publish: { enabled: boolean; channel: string };
  /**
   * §13.48: let other swarm agents comment into a debate.
   *
   * `trust: "comments"` is the ONLY level implemented, deliberately. Comments become
   * labelled context for the debaters and the judge; they never enter `ledger.json`, so
   * §8.1's field permissions and §13.39's cross-author protection are untouched. Letting
   * outside agents write claims would need a third author class with its own permission
   * table — see docs/design/two-way-participation-sketch.md §3.
   */
  participate: {
    enabled: boolean;
    /** Channel to read. Defaults to `publish.channel` when empty. */
    channel: string;
    /** Hard cap per read, so a chatty agent cannot inflate mission size or cost. */
    maxComments: number;
    trust: "comments";
  };
}

/**
 * §4 roster as literally written in the design doc. Kept so we can detect and explain
 * a same-family override, and so §13's swaps stay auditable rather than invisible.
 */
export const DESIGN_MODELS = {
  ideator: "ibm-services-essentials/claude-opus-5",
  skeptic: "openai-codex/gpt-6-astra",
  synthesizer: "opencode/gemini-3.1-pro",
} as const;

/** Providers WP0 proved cannot support the cost cap or cannot run at all. */
export const PROVIDER_WARNINGS: Record<string, string> = {
  "ibm-services-essentials":
    "reports cost.total=0 for all models (fixed-credit plan), so USD budget caps cannot bind (§13.14)",
  opencode:
    "returned 401 CreditsError (insufficient balance) during WP0 (§13.15)",
  "openai-codex":
    "subscription usage limit was reached 2026-09-07; turns fail with " +
    "stopReason:error \"usage limit has been reached\" (§13.41)",
};

/**
 * Models that bill nothing on this machine. Verified 2026-09-07 against the IBM
 * Advantage Credits dashboard ("Free models - these don't use your credits") AND by a
 * live call each. Note two traps:
 *  - `gpt-5.6-luna` is advertised as free but this team is 403 denied, so it is NOT here.
 *  - free models still report cost.total = 0, which is indistinguishable from the
 *    broken-price-table case in §13.14 unless they are declared, which is why this
 *    list exists.
 */
export const KNOWN_FREE_MODELS = [
  "ibm-services-essentials/claude-haiku-4-5",
  "ibm-services-essentials/gemma-4-26b-a4b-it",
  "ibm-services-essentials/ibm/granite-4-h-small",
  "ibm-services-essentials/meta-llama/llama-4-maverick-17b-128e-instruct-fp8",
] as const;

export const DEFAULTS: DebateConfig = {
  runner: "direct",
  tier: null,
  mode: { reviewThresholdChars: 2000 },
  rounds: { max: 3, gateSeverity: "high" },
  timeouts: { turnMs: 240_000, totalMs: 900_000, verdictGraceMs: 300_000 },
  budget: {
    tokens: 1_500_000,
    usd: 5,
    perTurnUsd: 2,
    perTurnTokens: 400_000,
    costReporting: "warn",
  },
  repairs: { max: 2 },
  // WP0-verified roster. Families still Anthropic / OpenAI / Google per D8.
  // NOTE: openrouter ids must be HYPHENATED here (§13.16) - the dotted ids from
  // models-store.json 404 through this gateway.
  models: {
    ideator: "openrouter/anthropic/claude-opus-4-8",
    skeptic: "openrouter/openai/gpt-5.6-sol",
    synthesizer: "openrouter/google/gemini-3.1-pro-preview",
  },
  // Per-role config. The skeptic carries a cost cap because it is empirically the
  // dominant spender: 95.3% of the WP5 re-probe's $2.11 ($2.0101 of it) across three
  // near-constant-cost turns. $1.20 leaves room for two full tool-heavy turns and
  // stops a third from repeating verification it already did (§13.41).
  roles: {
    ideator: {},
    skeptic: { budget: { usd: 1.2 } },
    synthesizer: {},
  },
  freeModels: [...KNOWN_FREE_MODELS],
  thinking: { ideator: "high", skeptic: "high", synthesizer: "high" },
  skeptic: { allowBash: true, freeAgreements: 1, minFlaws: 3, minEvidencedFlaws: 2 },
  requireEvidenceForHigh: true,
  synthesizer: { inlineFullSeedUnderChars: 40_000 },
  children: { contextFiles: false, extraArgs: [] },
  lessons: { enabled: true, maxLines: 200 },
  inject: "nextTurn",
  publish: { enabled: false, channel: "debate" },
  // Off by default: reading a shared channel changes what the models see, so it must be
  // an explicit choice. `maxComments: 5` bounds mission growth and therefore cost.
  participate: { enabled: false, channel: "", maxComments: 5, trust: "comments" },
};

/**
 * Deep merge of plain objects. Arrays and scalars replace wholesale.
 *
 * Always returns a fresh structure for object inputs and never aliases `base`, because
 * `base` is the exported DEFAULTS singleton: aliasing it once let `applyTier` mutate
 * DEFAULTS and permanently corrupt every subsequent loadConfig in the process.
 */
function mergeDeep<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return clone(base);
  if (typeof patch !== "object" || Array.isArray(patch)) return patch as T;
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    return clone(patch) as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (k.startsWith("_")) continue; // `_models_note` and friends are documentation
    const prev = (base as Record<string, unknown>)[k];
    out[k] = prev === undefined ? clone(v) : mergeDeep(prev as unknown, v);
  }
  // Deep-clone any key the patch did not touch, so the result shares nothing with base.
  for (const k of Object.keys(out)) {
    if (!(patch as Record<string, unknown>)[k]) out[k] = clone(out[k]);
  }
  return out as T;
}

/** Structural clone that is safe for the plain-JSON config tree. */
function clone<T>(v: T): T {
  if (v === null || typeof v !== "object") return v;
  return JSON.parse(JSON.stringify(v)) as T;
}

function readJsonIfPresent(path: string, warnings: string[]): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warnings.push(`ignored malformed config ${path}: ${(e as Error).message}`);
    return undefined;
  }
}

export interface LoadedConfig {
  config: DebateConfig;
  /** Non-fatal problems worth showing the user (bad JSON, risky provider, etc.). */
  warnings: string[];
  sources: string[];
}

/**
 * §4: split the persona/config model string on the FIRST slash only, so that
 * openrouter model ids containing slashes survive intact.
 *   "openrouter/google/gemini-3.1-pro-preview" -> provider=openrouter, model=google/gemini-3.1-pro-preview
 *   "gpt-6-astra"                              -> provider=null (pi default), model=gpt-6-astra
 */
export function splitModelRef(ref: string): RoleModel {
  const trimmed = ref.trim();
  const i = trimmed.indexOf("/");
  if (i <= 0) return { provider: null, model: trimmed };
  return { provider: trimmed.slice(0, i), model: trimmed.slice(i + 1) };
}

/**
 * D8 check: the three roles should come from three distinct families. §4 says to keep
 * this even though the shipped roster satisfies it, because config can override.
 */
export function familyOf(provider: string | null, model: string): string {
  const s = `${provider ?? ""}/${model}`.toLowerCase();
  if (s.includes("claude") || s.includes("anthropic")) return "anthropic";
  if (s.includes("gpt") || s.includes("openai") || s.includes("codex")) return "openai";
  if (s.includes("gemini") || s.includes("google") || s.includes("gemma")) return "google";
  if (s.includes("grok") || s.includes("x-ai")) return "xai";
  if (s.includes("deepseek")) return "deepseek";
  if (s.includes("minimax")) return "minimax";
  if (s.includes("llama") || s.includes("mistral") || s.includes("granite")) return "open";
  return `unknown:${s}`;
}

/**
 * Named model tiers, so switching the whole roster is one word instead of three
 * hand-copied model ids (§13.30). Apply with `"tier": "free"` in config.
 *
 * `free`: costs nothing against IBM Advantage Credits. All three roles run on
 * `ibm-services-essentials` free models. NOTE this deliberately VIOLATES D8's
 * three-distinct-families rule — the only capable free models are Anthropic
 * (haiku-4-5) plus small open models with no thinking support, so the judge cannot be
 * fully independent. loadConfig still emits the D8 warning; that is the honest trade,
 * and the reason `free` is not the default.
 *
 * `cheap`: paid but roughly an order of magnitude below `default`, three real families.
 * Replaces §4's cheap tier, whose entries were all dead `opencode` models (§13.15).
 *
 * `default`: the WP0-verified roster (§13.14/13.15/13.16).
 */
export const TIERS: Record<string, {
  models: Record<Role, string>;
  note: string;
  /**
   * Optional per-role budget the tier applies when the user has not set one. Exists
   * because a zero-dollar provider makes USD caps inert (§13.14), so such a tier must be
   * able to ship token-denominated bounds instead of silently inheriting USD ones.
   */
  budgets?: Partial<Record<Role, RoleBudget>>;
}> = {
  free: {
    models: {
      // The only free model with thinking + tools + reliable ledger-block compliance.
      ideator: "ibm-services-essentials/claude-haiku-4-5",
      skeptic: "ibm-services-essentials/claude-haiku-4-5",
      // A different family for the judge, but no thinking support and a small context.
      synthesizer: "ibm-services-essentials/gemma-4-26b-a4b-it",
    },
    note:
      "zero credit cost; two families only, so the judge is not fully independent (D8), " +
      "and gemma has no thinking support",
  },
  /**
   * All three roles on `ibm-services-essentials`, which is a fixed-credit plan: from the
   * user's perspective these cost no money, and the worst case is running out of quota
   * for a while (a recoverable failure, unlike a surprise bill).
   *
   * Unlike `free`, this tier keeps **three distinct families** (claude / gpt / gemini),
   * so D8's independent-judge property holds — IBM fronts all three vendors. That makes
   * it the only zero-dollar roster that is not also a D8 violation.
   *
   * THE TRADE, stated plainly: every IBM model reports `cost.total = 0` with real token
   * usage (§13.14), so **every USD cap is inert here** — `budget.usd`, `perTurnUsd`, and
   * the skeptic's $1.20 role cap all sum to zero and can never trip. Token caps are the
   * only live guardrail, so this tier sets them explicitly rather than inheriting
   * defaults tuned for a metered provider. Measured 2026-09-07: a 2-bash-call turn cost
   * 16.3K tokens through IBM versus ~420 through OpenRouter for the same task, because
   * there is no cache-read discount to earn when the price table is all zeros — so token
   * budgets must be substantially larger here than a USD-equivalent intuition suggests.
   *
   * These models are deliberately NOT declared `free`: `free: true` suppresses the
   * `cost_unreported` warning (§13.29), and here that warning is telling the truth — the
   * dollar figure really is unenforceable. Leaving it on keeps `costTrusted: false` and
   * the verdict's `$?` marker, so no run ever presents a fake $0.00 as fact.
   */
  ibm: {
    models: {
      ideator: "ibm-services-essentials/claude-opus-4-8",
      skeptic: "ibm-services-essentials/gpt-5.6-sol",
      synthesizer: "ibm-services-essentials/gemini-3.7-flash",
    },
    note:
      "zero dollar cost on the IBM fixed-credit plan, three distinct families (D8 holds); " +
      "USD caps are inert so token caps are the only real bound, and quota exhaustion " +
      "is the expected failure mode",
    // Token caps sized against the measured 16.3K-tokens-per-tool-turn on this provider:
     // the skeptic gets room for ~3 tool-heavy turns, the cheap roles much less. These
    // are the ONLY enforceable limits on this tier.
    budgets: {
      skeptic: { tokens: 900_000, perTurnTokens: 350_000 },
      ideator: { tokens: 300_000, perTurnTokens: 150_000 },
      synthesizer: { tokens: 300_000, perTurnTokens: 150_000 },
    },
  },
  cheap: {
    models: {
      ideator: "ibm-services-essentials/claude-sonnet-5",
      skeptic: "openai-codex/gpt-5.4-mini",
      synthesizer: "openrouter/google/gemini-3.1-pro-preview",
    },
    note: "three families, roughly 10x cheaper than default",
  },
  default: {
    models: {
      ideator: "openrouter/anthropic/claude-opus-4-8",
      skeptic: "openrouter/openai/gpt-5.6-sol",
      synthesizer: "openrouter/google/gemini-3.1-pro-preview",
    },
    note:
      "three families; skeptic on gpt-5.6-sol after the codex subscription was " +
      "exhausted and the 16.6x cost ruling (§13.41)",
  },
  /**
   * The pre-§13.41 roster: skeptic on `openai-codex/gpt-6-astra`. Kept so the WP5
   * re-probe numbers stay reproducible, and usable again if the codex subscription
   * is restored. NOTE gpt-6-astra via openrouter costs real money (~$3.54/run at the
   * re-probe's skeptic token volume) where the subscription billed it as $2.01.
   */
  strong: {
    models: {
      ideator: "openrouter/anthropic/claude-opus-4-8",
      skeptic: "openai-codex/gpt-6-astra",
      synthesizer: "openrouter/google/gemini-3.1-pro-preview",
    },
    note:
      "the WP5 re-probe roster; requires a working openai-codex subscription, " +
      "otherwise the skeptic turn fails with a usage-limit error",
  },
};

/** Apply a named tier into `roles.<role>.model`, unless the user set one explicitly. */
function applyTier(c: DebateConfig, tier: string, warnings: string[]): void {
  const t = TIERS[tier];
  if (!t) {
    warnings.push(`unknown tier "${tier}"; known tiers: ${Object.keys(TIERS).join(", ")}`);
    return;
  }
  c.roles ??= { ideator: {}, skeptic: {}, synthesizer: {} };
  for (const role of ROLES) {
    c.roles[role] ??= {};
    // An explicit per-role model always beats the tier.
    if (c.roles[role]!.model) continue;
    c.roles[role]!.model = t.models[role];
    // Clear the legacy flat entry so it cannot shadow the tier during resolution.
    c.models[role] = null;
    // Only mark free the roles the tier actually placed. A role the user pinned to a
    // paid model must not inherit the tier's free flag, or its real cost would be
    // reported as $0 and escape the budget entirely.
    if (tier === "free") c.roles[role]!.free ??= true;
    // A tier may ship budgets (token caps for zero-dollar providers). Only fill fields
    // the user left unset, so an explicit budget is never silently widened or narrowed.
    const tb = t.budgets?.[role];
    if (tb) {
      const existing = (c.roles[role]!.budget ??= {});
      for (const [k, v] of Object.entries(tb) as [keyof RoleBudget, number][]) {
        if (existing[k] === undefined) existing[k] = v;
      }
    }
  }
}

export function loadConfig(cwd: string, projectTrusted = true): LoadedConfig {
  const warnings: string[] = [];
  const sources: string[] = ["defaults"];

  const globalSettingsPath = join(homedir(), ".pi", "agent", "settings.json");
  const globalSettings = readJsonIfPresent(globalSettingsPath, warnings) as
    | { debate?: unknown }
    | undefined;

  // Start from a deep copy: DEFAULTS is a shared singleton and applyTier/validate both
  // mutate the config they are given.
  let config = clone(DEFAULTS);
  if (globalSettings?.debate) {
    config = mergeDeep(config, globalSettings.debate);
    sources.push(`${globalSettingsPath}#debate`);
  }

  // Project-local override is only honored for a trusted project: it can change which
  // model (and therefore whose money) a run spends.
  const projectPath = join(cwd, ".pi", "debate.json");
  if (existsSync(projectPath)) {
    if (projectTrusted) {
      const projectCfg = readJsonIfPresent(projectPath, warnings);
      if (projectCfg) {
        config = mergeDeep(config, projectCfg);
        sources.push(projectPath);
      }
    } else {
      warnings.push(
        `ignored ${projectPath}: project is not trusted (it can redirect model spend)`,
      );
    }
  }

  // Tier is applied AFTER both config layers merge, so `"tier": "free"` in the project
  // file can override a tier set globally, and explicit per-role models still win.
  if (config.tier) applyTier(config, config.tier, warnings);

  validate(config, warnings);
  return { config, warnings, sources };
}

function validate(c: DebateConfig, warnings: string[]): void {
  if (["direct", "harness", "fake"].includes(c.runner) === false) {
    warnings.push(`unknown runner "${c.runner}"; falling back to "direct"`);
    c.runner = "direct";
  }
  if (c.rounds.max < 2 || c.rounds.max > 3) {
    warnings.push(`rounds.max must be 2 or 3 (got ${c.rounds.max}); clamping`);
    c.rounds.max = Math.min(3, Math.max(2, c.rounds.max));
  }
  if (c.budget.perTurnUsd > c.budget.usd) {
    warnings.push(
      `budget.perTurnUsd (${c.budget.perTurnUsd}) exceeds budget.usd (${c.budget.usd}); ` +
        `a single turn could consume the whole run budget`,
    );
  }
  for (const [k, v] of Object.entries(c.budget)) {
    if (typeof v === "number" && v <= 0) {
      warnings.push(`budget.${k} must be > 0 (got ${v})`);
    }
  }
  if (c.timeouts.turnMs > c.timeouts.totalMs) {
    warnings.push(
      `timeouts.turnMs (${c.timeouts.turnMs}) exceeds totalMs (${c.timeouts.totalMs})`,
    );
  }
  // §13.50: tolerate configs written before verdictGraceMs existed, and normalize a
  // negative value rather than letting it silently disable the judge.
  if (typeof c.timeouts.verdictGraceMs !== "number" || c.timeouts.verdictGraceMs < 0) {
    c.timeouts.verdictGraceMs = DEFAULTS.timeouts.verdictGraceMs;
  }
  if (!["warn", "require", "ignore"].includes(c.budget.costReporting)) {
    warnings.push(
      `unknown budget.costReporting "${c.budget.costReporting}"; using "warn"`,
    );
    c.budget.costReporting = "warn";
  }

  // D8: three distinct families, and flag providers WP0 proved problematic.
  const fams: string[] = [];
  for (const role of ROLES) {
    const roleModel = c.roles?.[role]?.model;
    const flatModel = c.models[role];
    if (roleModel && flatModel && roleModel !== flatModel) {
      warnings.push(
        `both roles.${role}.model ("${roleModel}") and models.${role} ("${flatModel}") are set; ` +
        `roles.${role}.model wins`,
      );
    }
    const ref = roleModel ?? flatModel;
    if (!ref) continue; // null = persona frontmatter, resolved later
    const { provider, model } = splitModelRef(ref);
    fams.push(familyOf(provider, model));

    const full = provider ? `${provider}/${model}` : model;
    const declaredFree = c.roles?.[role]?.free ?? c.freeModels.includes(full);
    // §13.14's warning is about a broken price table. A model declared free reports
    // cost 0 legitimately, so warning about it would train the user to ignore warnings.
    if (provider && PROVIDER_WARNINGS[provider] && !declaredFree) {
      warnings.push(`roles.${role} uses provider "${provider}": ${PROVIDER_WARNINGS[provider]}`);
    }

    // A free role with no token cap is unbounded in everything but wall clock.
    if (declaredFree) {
      const rb = c.roles?.[role]?.budget;
      if (rb?.tokens === undefined && c.budget.tokens <= 0) {
        warnings.push(
          `roles.${role} is free but no token budget bounds it; free is not unlimited`,
        );
      }
    }

    // Role budgets that exceed the run cap are silently clamped; say so.
    const rb = c.roles?.[role]?.budget;
    if (rb?.usd !== undefined && rb.usd > c.budget.usd) {
      warnings.push(
        `roles.${role}.budget.usd (${rb.usd}) exceeds budget.usd (${c.budget.usd}); ` +
        `clamped to the run cap — a role budget can only narrow, never widen`,
      );
    }
    if (rb?.tokens !== undefined && rb.tokens > c.budget.tokens) {
      warnings.push(
        `roles.${role}.budget.tokens (${rb.tokens}) exceeds budget.tokens (${c.budget.tokens}); clamped`,
      );
    }
  }
  if (fams.length === 3 && new Set(fams).size < 3) {
    warnings.push(
      `D8 violation: roles span only ${new Set(fams).size} model family/families (${fams.join(", ")}). ` +
        `A judge from the same family as a debater is biased toward it.`,
    );
  }

  // A tool-less debater cannot read the seed, which every mission tells it to do.
  for (const role of ["ideator", "skeptic"] as const) {
    if (c.roles?.[role]?.tools === "none") {
      warnings.push(
        `roles.${role}.tools is "none", but the ${role} is told to read the seed with its ` +
        `tools; it will have to work from the attached file alone`,
      );
    }
  }
  // Conversely the judge must stay tool-less (D5: "no tools, sees no identities").
  if (c.roles?.synthesizer?.tools && c.roles.synthesizer.tools !== "none") {
    warnings.push(
      `roles.synthesizer.tools grants tools to the judge; D5 requires the Synthesizer ` +
      `have none so it judges only from the ledger and excerpts`,
    );
  }
}

/** Resolve the effective model for a role: config override wins over persona frontmatter. */
export function resolveRoleModel(
  c: DebateConfig,
  role: Role,
  personaFrontmatterModel: string | null,
): RoleModel {
  // roles.<role>.model takes precedence over the legacy flat models.<role>.
  const ref = c.roles?.[role]?.model ?? c.models[role] ?? personaFrontmatterModel;
  if (!ref) {
    throw new Error(
      `no model for role "${role}": config roles.${role}.model and models.${role} are both ` +
      `null and the persona has no "model:" frontmatter`,
    );
  }
  return splitModelRef(ref);
}

/** Everything the orchestrator and runner need to know about one role, fully resolved. */
export interface ResolvedRole {
  role: Role;
  provider: string | null;
  model: string;
  /** "<provider>/<model>" as written, for manifests and free-list matching. */
  ref: string;
  family: string;
  thinking: ThinkingLevel;
  tools: string[] | "none";
  /** Cumulative caps for this role across the run; Infinity when unset. */
  budgetUsd: number;
  budgetTokens: number;
  /** Mid-turn kill ceilings for this role's turns. */
  perTurnUsd: number;
  perTurnTokens: number;
  turnMs: number;
  /** True when this model is declared free, so cost.total = 0 is expected. */
  free: boolean;
}

/** Default tool sets per role (§4). The Skeptic's bash is gated by skeptic.allowBash. */
export function defaultToolsFor(c: DebateConfig, role: Role): string[] | "none" {
  if (role === "synthesizer") return "none";
  if (role === "skeptic" && c.skeptic.allowBash) {
    return ["read", "grep", "find", "ls", "bash"];
  }
  return ["read", "grep", "find", "ls"];
}

/**
 * Resolve one role's complete effective configuration (§13.28).
 *
 * Precedence, narrow to wide: roles.<role>.<field> -> run-level default -> persona.
 * Role budgets are clamped to the run budget so a role override can only ever be
 * more restrictive, never a way to spend past `budget.usd`.
 */
export function resolveRole(
  c: DebateConfig,
  role: Role,
  personaFrontmatterModel: string | null = null,
): ResolvedRole {
  const rc: RoleConfig = c.roles?.[role] ?? {};
  const { provider, model } = resolveRoleModel(c, role, personaFrontmatterModel);
  const ref = provider ? `${provider}/${model}` : model;

  const free = rc.free ?? c.freeModels.includes(ref);

  const clampUsd = (v: number | undefined): number =>
    v === undefined ? Number.POSITIVE_INFINITY : Math.min(v, c.budget.usd);
  const clampTokens = (v: number | undefined): number =>
    v === undefined ? Number.POSITIVE_INFINITY : Math.min(v, c.budget.tokens);

  return {
    role, provider, model, ref,
    family: familyOf(provider, model),
    thinking: rc.thinking ?? c.thinking[role],
    tools: rc.tools ?? defaultToolsFor(c, role),
    budgetUsd: clampUsd(rc.budget?.usd),
    budgetTokens: clampTokens(rc.budget?.tokens),
    // Per-turn ceilings are also clamped to the run-level ones.
    perTurnUsd: Math.min(rc.budget?.perTurnUsd ?? c.budget.perTurnUsd, c.budget.perTurnUsd),
    perTurnTokens: Math.min(
      rc.budget?.perTurnTokens ?? c.budget.perTurnTokens, c.budget.perTurnTokens,
    ),
    turnMs: Math.min(rc.budget?.turnMs ?? c.timeouts.turnMs, c.timeouts.turnMs),
    free,
  };
}

export function resolveAllRoles(
  c: DebateConfig,
  personaModels: Partial<Record<Role, string | null>> = {},
): Record<Role, ResolvedRole> {
  const out = {} as Record<Role, ResolvedRole>;
  for (const role of ROLES) out[role] = resolveRole(c, role, personaModels[role] ?? null);
  return out;
}
