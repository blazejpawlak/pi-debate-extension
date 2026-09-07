/**
 * Per-role config (§13.28/13.29/13.30): tiers, role budgets, free models.
 * No model calls.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULTS, TIERS, KNOWN_FREE_MODELS, loadConfig, resolveRole, resolveAllRoles,
  defaultToolsFor, type DebateConfig,
} from "../config.ts";
import { Orchestrator } from "../orchestrator.ts";
import { FakeRunner, fakeTurnText, usageWith } from "../runner/fake.ts";
import { readEvents } from "../manifest.ts";
import { runPaths } from "../paths.ts";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name} ${detail}`); }
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(name, a === e, a === e ? "" : `got ${a}, want ${e}`);
}

const PERSONA_DIR = join(import.meta.dirname, "..", "personas");
const SEED = "# S\n\n## Implementation Phase 5\nQuiesce Docker.\n";

function write(ws: string, cfg: unknown): void {
  mkdirSync(join(ws, ".pi"), { recursive: true });
  writeFileSync(join(ws, ".pi", "debate.json"), JSON.stringify(cfg));
}

console.log("\n-- backward compatibility: no roles block behaves exactly as before --");
{
  const ws = mkdtempSync(join(tmpdir(), "roles-a-"));
  const { config, warnings } = loadConfig(ws, true);
  const r = resolveAllRoles(config);
  eq("ideator model unchanged", r.ideator.ref, "openrouter/anthropic/claude-opus-4-8");
  eq("skeptic model unchanged", r.skeptic.ref, "openrouter/openai/gpt-5.6-sol");
  eq("synthesizer model unchanged", r.synthesizer.ref, "openrouter/google/gemini-3.1-pro-preview");
  eq("thinking inherited", r.ideator.thinking, "high");
  eq("skeptic gets bash by default", r.skeptic.tools, ["read", "grep", "find", "ls", "bash"]);
  eq("judge is tool-less", r.synthesizer.tools, "none");
  eq("per-turn ceiling inherited", r.ideator.perTurnUsd, 2);
  check("no role budget by default", r.ideator.budgetUsd === Number.POSITIVE_INFINITY);
  check("nothing free by default in the paid roster", !r.ideator.free && !r.skeptic.free);
  check("defaults still warning-free", warnings.length === 0, warnings.join("; "));
  rmSync(ws, { recursive: true, force: true });
}

console.log("\n-- per-role model / thinking / tools override --");
{
  const ws = mkdtempSync(join(tmpdir(), "roles-b-"));
  write(ws, {
    roles: {
      skeptic: { model: "ibm-services-essentials/claude-haiku-4-5", thinking: "low",
                 tools: ["read", "grep"] },
    },
  });
  const { config } = loadConfig(ws, true);
  const r = resolveAllRoles(config);
  eq("skeptic model overridden", r.skeptic.ref, "ibm-services-essentials/claude-haiku-4-5");
  eq("skeptic thinking overridden", r.skeptic.thinking, "low");
  eq("skeptic tools overridden", r.skeptic.tools, ["read", "grep"]);
  eq("ideator untouched", r.ideator.ref, "openrouter/anthropic/claude-opus-4-8");
  eq("ideator thinking untouched", r.ideator.thinking, "high");
  check("haiku recognized as free from the known list", r.skeptic.free);
  rmSync(ws, { recursive: true, force: true });
}

console.log("\n-- roles.<role>.model beats legacy models.<role>, with a warning --");
{
  const ws = mkdtempSync(join(tmpdir(), "roles-c-"));
  write(ws, {
    models: { ideator: "openai-codex/gpt-6-astra" },
    roles: { ideator: { model: "ibm-services-essentials/claude-sonnet-5" } },
  });
  const { config, warnings } = loadConfig(ws, true);
  eq("roles wins", resolveRole(config, "ideator").ref, "ibm-services-essentials/claude-sonnet-5");
  check("conflict is warned about",
    warnings.some((w) => w.includes("roles.ideator.model") && w.includes("wins")),
    warnings.join("; "));
  rmSync(ws, { recursive: true, force: true });
}

console.log("\n-- role budgets clamp to the run budget, never widen it --");
{
  const ws = mkdtempSync(join(tmpdir(), "roles-d-"));
  write(ws, {
    budget: { usd: 5, tokens: 100000 },
    roles: {
      ideator: { budget: { usd: 1.5, tokens: 20000, perTurnUsd: 0.5 } },
      skeptic: { budget: { usd: 999, tokens: 9999999 } },
    },
  });
  const { config, warnings } = loadConfig(ws, true);
  const r = resolveAllRoles(config);
  eq("ideator role cap honored", r.ideator.budgetUsd, 1.5);
  eq("ideator role token cap honored", r.ideator.budgetTokens, 20000);
  eq("ideator per-turn ceiling narrowed", r.ideator.perTurnUsd, 0.5);
  eq("skeptic cap clamped to the run cap", r.skeptic.budgetUsd, 5);
  eq("skeptic token cap clamped", r.skeptic.budgetTokens, 100000);
  check("over-cap role budget is warned about",
    warnings.some((w) => w.includes("roles.skeptic.budget.usd") && w.includes("clamped")),
    warnings.join("; "));
  rmSync(ws, { recursive: true, force: true });
}

console.log("\n-- tiers (§13.30) --");
{
  const ws = mkdtempSync(join(tmpdir(), "roles-e-"));
  write(ws, { tier: "free" });
  const { config, warnings } = loadConfig(ws, true);
  const r = resolveAllRoles(config);
  eq("free tier ideator", r.ideator.ref, "ibm-services-essentials/claude-haiku-4-5");
  eq("free tier skeptic", r.skeptic.ref, "ibm-services-essentials/claude-haiku-4-5");
  eq("free tier synthesizer", r.synthesizer.ref, "ibm-services-essentials/gemma-4-26b-a4b-it");
  check("all free tier roles marked free", r.ideator.free && r.skeptic.free && r.synthesizer.free);
  // The free tier cannot satisfy D8; that must be surfaced, not hidden.
  check("free tier still triggers the D8 warning",
    warnings.some((w) => w.includes("D8 violation")), warnings.join("; "));
  check("free tier does NOT trigger the zero-cost provider warning",
    !warnings.some((w) => w.includes("cost.total=0")), warnings.join("; "));
  rmSync(ws, { recursive: true, force: true });
}
{
  const ws = mkdtempSync(join(tmpdir(), "roles-f-"));
  write(ws, { tier: "cheap" });
  const { config, warnings } = loadConfig(ws, true);
  const r = resolveAllRoles(config);
  eq("cheap tier spans 3 families",
     new Set([r.ideator.family, r.skeptic.family, r.synthesizer.family]).size, 3);
  check("cheap tier has no D8 violation",
    !warnings.some((w) => w.includes("D8 violation")), warnings.join("; "));
  rmSync(ws, { recursive: true, force: true });
}
{
  const ws = mkdtempSync(join(tmpdir(), "roles-g-"));
  write(ws, { tier: "free", roles: { synthesizer: { model: "openrouter/google/gemini-3.1-pro-preview" } } });
  const { config } = loadConfig(ws, true);
  const r = resolveAllRoles(config);
  eq("explicit role model beats the tier", r.synthesizer.ref, "openrouter/google/gemini-3.1-pro-preview");
  eq("other roles still take the tier", r.ideator.ref, "ibm-services-essentials/claude-haiku-4-5");
  check("a paid judge over free debaters is not marked free", !r.synthesizer.free);
  rmSync(ws, { recursive: true, force: true });
}
{
  const ws = mkdtempSync(join(tmpdir(), "roles-h-"));
  write(ws, { tier: "nonsense" });
  const { warnings } = loadConfig(ws, true);
  check("unknown tier is warned about, not fatal",
    warnings.some((w) => w.includes('unknown tier "nonsense"')), warnings.join("; "));
  rmSync(ws, { recursive: true, force: true });
}

console.log("\n-- guardrails on nonsensical role config --");
{
  const ws = mkdtempSync(join(tmpdir(), "roles-i-"));
  write(ws, { roles: { synthesizer: { tools: ["read", "bash"] } } });
  const { warnings } = loadConfig(ws, true);
  check("granting the judge tools is warned about (D5)",
    warnings.some((w) => w.includes("roles.synthesizer.tools")), warnings.join("; "));
  rmSync(ws, { recursive: true, force: true });
}
{
  const ws = mkdtempSync(join(tmpdir(), "roles-j-"));
  write(ws, { roles: { skeptic: { tools: "none" } } });
  const { warnings } = loadConfig(ws, true);
  check("a tool-less debater is warned about",
    warnings.some((w) => w.includes("roles.skeptic.tools is \"none\"")), warnings.join("; "));
  rmSync(ws, { recursive: true, force: true });
}

console.log("\n-- free models suppress the cost_unreported warning (§13.29) --");
{
  const ws = mkdtempSync(join(tmpdir(), "roles-k-"));
  write(ws, { tier: "free", rounds: { max: 2, gateSeverity: "high" } });
  const { config } = loadConfig(ws, true);
  // Free models legitimately report tokens with cost 0.
  const zero = (claims: unknown[]) => ({
    text: fakeTurnText(claims), usage: usageWith({ input: 5000, output: 500, costTotal: 0 }),
  });
  const runner = new FakeRunner({ fixtures: {
    "1-ideator": zero([{ id: "C1", text: "sound", sourceRef: "§Implementation Phase 5" }]),
    "1-skeptic": zero([
      { id: "C1", text: "risk one", severity: "high", test: "t" },
      { id: "C2", text: "risk two", severity: "medium" },
      { id: "C3", text: "risk three", severity: "low" },
    ]),
    "2-ideator": zero([{ id: "C1", text: "resp" }]),
    "2-skeptic": zero([{ id: "C1", text: "residual", severity: "low" }]),
    "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n", usage: usageWith({ costTotal: 0 }) },
  }});
  const o = new Orchestrator({ workspace: ws, cfg: config, runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260907-000001-free", { seedText: SEED, seedSource: "t", mode: "review" });

  const ev = readEvents(runPaths(ws, out.runId).events);
  check("no cost_unreported for declared-free models",
    !ev.some((e) => e.code === "cost_unreported"), JSON.stringify(ev.filter((e) => e.code === "cost_unreported")));
  check("costTrusted stays true", out.manifest.costTrusted !== false);
  check("turns marked free in the manifest", out.manifest.turns.every((t) => t.free === true));
  eq("run cost is zero", out.costUsd, 0);
  check("verdict labels free turns",
    out.verdictPath !== null &&
    readFileSync(out.verdictPath, "utf8").includes("declared free"));
  rmSync(ws, { recursive: true, force: true });
}

console.log("\n-- per-role cumulative budget skips only that role (§13.28) --");
{
  const ws = mkdtempSync(join(tmpdir(), "roles-l-"));
  write(ws, {
    budget: { usd: 100, tokens: 10000000, perTurnUsd: 50, perTurnTokens: 5000000 },
    rounds: { max: 3, gateSeverity: "high" },
    // The ideator may spend $1 total; each of its turns costs $0.80, so its second
    // turn must be skipped while the skeptic keeps going.
    roles: { ideator: { budget: { usd: 1.0 } } },
  });
  const { config } = loadConfig(ws, true);
  const pricey = (claims: unknown[], cost: number) => ({
    text: fakeTurnText(claims), usage: usageWith({ input: 1000, output: 100, costTotal: cost }),
  });
  const runner = new FakeRunner({ fixtures: {
    "1-ideator": pricey([{ id: "C1", text: "sound" }], 0.8),
    "1-skeptic": pricey([
      { id: "C1", text: "open high risk", severity: "high", test: "t" },
      { id: "C2", text: "second risk", severity: "high" },
      { id: "C3", text: "third risk", severity: "medium" },
    ], 0.1),
    "2-ideator": pricey([{ id: "C1", text: "should be skipped" }], 0.8),
    "2-skeptic": pricey([{ id: "C1", text: "still open", severity: "high" }], 0.1),
    "3-ideator": pricey([{ id: "C1", text: "also skipped" }], 0.8),
    "3-skeptic": pricey([{ id: "C1", text: "r3", severity: "high" }], 0.1),
    "verdict-synthesizer": { text: "## 2. Decision\n\ndo-not-proceed\n", usage: usageWith({ costTotal: 0.05 }) },
  }});
  const o = new Orchestrator({ workspace: ws, cfg: config, runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260907-000002-rb", { seedText: SEED, seedSource: "t", mode: "review" });

  const seq = runner.sequence();
  // The role cap is checked at a turn BOUNDARY, exactly like the run cap: after one
  // $0.80 turn the ideator is still under its $1.00 cap, so a second turn is allowed
  // and the cap binds before the third. Overshoot by at most one turn is by design
  // (§4.1 accepts the same for budget.usd); the guarantee is that it stops, not that
  // it stops before ever exceeding.
  eq("ideator ran twice, then was stopped by its own cap",
     seq.filter((s) => s.endsWith("-ideator")).length, 2);
  check("ideator did NOT get a third turn",
    !seq.includes("3-ideator"), seq.join(","));
  check("skeptic kept going after the ideator was spent out",
    seq.filter((s) => s.endsWith("-skeptic")).length >= 3, seq.join(","));
  check("role_budget_stop logged",
    readEvents(runPaths(ws, out.runId).events).some((e) => e.code === "role_budget_stop"));
  check("run still reached a verdict", out.verdictPath !== null);
  check("run did NOT end merely because one role was spent",
    out.status !== "partial" || out.manifest.rounds >= 2, `${out.status}`);
  rmSync(ws, { recursive: true, force: true });
}

console.log("\n-- per-role per-turn ceiling reaches the runner --");
{
  const ws = mkdtempSync(join(tmpdir(), "roles-m-"));
  write(ws, {
    budget: { perTurnUsd: 2, perTurnTokens: 400000 },
    roles: {
      skeptic: { budget: { perTurnUsd: 0.25, perTurnTokens: 1000, turnMs: 30000 } },
      ideator: { thinking: "max" },
    },
  });
  const { config } = loadConfig(ws, true);
  const seen: Record<string, { usd?: number; tokens?: number; ms: number; thinking: string }> = {};
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "x" }]) },
      "1-skeptic": { text: fakeTurnText([{ id: "C1", text: "y", severity: "low" }]) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "z" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "w", severity: "low" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n" },
    },
    onRun: (r) => {
      seen[r.role] = { usd: r.perTurnUsd, tokens: r.perTurnTokens, ms: r.timeoutMs,
                       thinking: r.thinking };
    },
  });
  const o = new Orchestrator({
    workspace: ws, cfg: { ...config, rounds: { max: 2, gateSeverity: "high" } },
    runner, personaDir: PERSONA_DIR,
  });
  await o.start("20260907-000003-pt", { seedText: SEED, seedSource: "t", mode: "review" });

  eq("skeptic per-turn USD ceiling passed through", seen.skeptic!.usd, 0.25);
  eq("skeptic per-turn token ceiling passed through", seen.skeptic!.tokens, 1000);
  eq("skeptic turn timeout passed through", seen.skeptic!.ms, 30000);
  eq("ideator keeps the run-level ceiling", seen.ideator!.usd, 2);
  eq("ideator thinking override passed through", seen.ideator!.thinking, "max");
  eq("judge inherits run-level ceiling", seen.synthesizer!.usd, 2);
  rmSync(ws, { recursive: true, force: true });
}

console.log("\n-- known-free list sanity --");
{
  check("haiku-4-5 is in the free list",
    KNOWN_FREE_MODELS.includes("ibm-services-essentials/claude-haiku-4-5" as never));
  check("gpt-5.6-luna is NOT in the free list (team is 403 denied)",
    !KNOWN_FREE_MODELS.some((m) => m.includes("luna")));
  check("every tier names all three roles",
    Object.values(TIERS).every((t) => t.models.ideator && t.models.skeptic && t.models.synthesizer));
  eq("defaultToolsFor judge", defaultToolsFor(DEFAULTS, "synthesizer"), "none");
  const noBash = JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig;
  noBash.skeptic.allowBash = false;
  eq("allowBash:false removes bash", defaultToolsFor(noBash, "skeptic"),
     ["read", "grep", "find", "ls"]);
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
