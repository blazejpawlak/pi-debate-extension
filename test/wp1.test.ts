/**
 * WP1 acceptance — config merge + command parsing, no model calls.
 * Run: npx tsx test/wp1.test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseCommand, selectMode, estimateRun } from "../command.ts";
import {
  DEFAULTS, loadConfig, splitModelRef, familyOf, resolveRoleModel,
  parseDuration, formatDuration, DurationError,
  type DebateConfig,
} from "../config.ts";
import { newRunId, runPaths, turnFileName, listRuns } from "../paths.ts";

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

console.log("\n-- splitModelRef: first slash only (§4) --");
eq("openrouter 3-part", splitModelRef("openrouter/google/gemini-3.1-pro-preview"),
   { provider: "openrouter", model: "google/gemini-3.1-pro-preview" });
eq("simple 2-part", splitModelRef("openai-codex/gpt-6-astra"),
   { provider: "openai-codex", model: "gpt-6-astra" });
eq("no slash -> default provider", splitModelRef("gpt-6-astra"),
   { provider: null, model: "gpt-6-astra" });
eq("leading slash is not a provider", splitModelRef("/weird"),
   { provider: null, model: "/weird" });

console.log("\n-- familyOf / D8 --");
eq("anthropic", familyOf("openrouter", "anthropic/claude-opus-4-8"), "anthropic");
eq("openai", familyOf("openai-codex", "gpt-6-astra"), "openai");
eq("google", familyOf("openrouter", "google/gemini-3.1-pro-preview"), "google");
check("shipped roster spans 3 families",
  new Set([
    familyOf(...Object.values(splitModelRef(DEFAULTS.models.ideator!)) as [string, string]),
    familyOf(...Object.values(splitModelRef(DEFAULTS.models.skeptic!)) as [string, string]),
    familyOf(...Object.values(splitModelRef(DEFAULTS.models.synthesizer!)) as [string, string]),
  ]).size === 3);

console.log("\n-- parseCommand (§9.1) --");
eq("bare -> help", parseCommand("").kind, "help");
eq("status", parseCommand("status").kind, "status");
eq("abort", parseCommand("abort").kind, "abort");
eq("runs", parseCommand("runs").kind, "runs");
eq("setup", parseCommand("setup").kind, "setup");
eq("last", parseCommand("last").kind, "last");
eq("resume with id", parseCommand("resume 20260906-181200-3f9a"),
   { kind: "resume", runId: "20260906-181200-3f9a" });
eq("resume without id", parseCommand("resume"), { kind: "resume", runId: null });
eq("inline text", parseCommand("should we migrate to bun"),
   { kind: "run", seed: "should we migrate to bun", seedFile: null, mode: null });
eq("@file", parseCommand("@plan.md"),
   { kind: "run", seed: "", seedFile: "plan.md", mode: null });
eq("--mode explore", parseCommand("--mode explore try bun"),
   { kind: "run", seed: "try bun", seedFile: null, mode: "explore" });
eq("--mode=review inline form", parseCommand("--mode=review @plan.md"),
   { kind: "run", seed: "", seedFile: "plan.md", mode: "review" });
eq("bad --mode is an error", parseCommand("--mode sideways x").kind, "error");
eq("--mode with nothing else is an error", parseCommand("--mode review").kind, "error");

// §6.2: a mission must never begin with '@'. Seeds that are plain text must not be
// mistaken for attachments, and a text seed starting with @ would be ambiguous.
const atFile = parseCommand("@notes.md");
eq("text starting with @ is treated as a file, not text",
   atFile.kind === "run" ? atFile.seedFile : null, "notes.md");

console.log("\n-- selectMode (§2) --");
const c = DEFAULTS;
eq("short text -> explore", selectMode(c, { seed: "x".repeat(50), seedFile: null, override: null }), "explore");
eq("long text -> review", selectMode(c, { seed: "x".repeat(2000), seedFile: null, override: null }), "review");
eq("just under threshold -> explore", selectMode(c, { seed: "x".repeat(1999), seedFile: null, override: null }), "explore");
eq("file -> review", selectMode(c, { seed: "tiny", seedFile: "p.md", override: null }), "review");
eq("override beats file", selectMode(c, { seed: "tiny", seedFile: "p.md", override: "explore" }), "explore");
eq("override beats length", selectMode(c, { seed: "x".repeat(9999), seedFile: null, override: "explore" }), "explore");

console.log("\n-- human duration parsing (§13.55) --");
eq("seconds", parseDuration("90s"), 90_000);
eq("minutes", parseDuration("15m"), 900_000);
eq("hours", parseDuration("1h"), 3_600_000);
eq("decimal hours", parseDuration("1.5h"), 5_400_000);
eq("compound", parseDuration("1h30m"), 5_400_000);
eq("whitespace and case", parseDuration("1H 30M"), 5_400_000);
eq("legacy bare number is milliseconds", parseDuration(420_000), 420_000);
eq("format readable hours", formatDuration(5_400_000), "90m");
for (const bad of ["", "5x", "one hour", "-3m", {}, null]) {
  let thrown = false;
  try { parseDuration(bad, "test.duration"); } catch (e) { thrown = e instanceof DurationError; }
  check(`invalid duration hard-errors: ${JSON.stringify(bad)}`, thrown);
}

console.log("\n-- config: two-level merge (§9.5) --");
const ws = mkdtempSync(join(tmpdir(), "debate-wp1-"));
try {
  const base = loadConfig(ws, true);
  eq("defaults: runner", base.config.runner, "direct");
  eq("defaults: perTurnUsd", base.config.budget.perTurnUsd, 2);
  eq("defaults: costReporting is warn", base.config.budget.costReporting, "warn");
  check("defaults produce no warnings", base.warnings.length === 0, base.warnings.join("; "));

  mkdirSync(join(ws, ".pi"), { recursive: true });
  writeFileSync(
    join(ws, ".pi", "debate.json"),
    JSON.stringify({ budget: { usd: 1 }, skeptic: { allowBash: false }, rounds: { max: 2 } }),
  );
  const over = loadConfig(ws, true);
  eq("project override applies", over.config.budget.usd, 1);
  eq("sibling keys survive partial override", over.config.budget.perTurnUsd, 2);
  eq("nested override applies", over.config.skeptic.allowBash, false);
  eq("untouched nested key survives", over.config.skeptic.minFlaws, 3);
  eq("rounds override", over.config.rounds.max, 2);
  check("perTurnUsd>usd is warned about",
    over.warnings.some((w) => w.includes("perTurnUsd")), over.warnings.join("; "));

  // §13.55: friendly canonical keys (`turn`/`total`/`verdictGrace`) normalize to
  // internal milliseconds, while legacy *Ms keys keep working.
  writeFileSync(join(ws, ".pi", "debate.json"), JSON.stringify({
    timeouts: { turn: "1.5h", total: "2h", verdictGrace: "90s" },
    roles: { skeptic: { budget: { turn: "1h30m" } } },
  }));
  const friendly = loadConfig(ws, true);
  eq("friendly timeouts.turn", friendly.config.timeouts.turnMs, 5_400_000);
  eq("friendly timeouts.total", friendly.config.timeouts.totalMs, 7_200_000);
  eq("friendly timeouts.verdictGrace", friendly.config.timeouts.verdictGraceMs, 90_000);
  eq("friendly role budget.turn", friendly.config.roles.skeptic.budget?.turnMs, 5_400_000);
  check("aliases do not leak into resolved config",
    !("turn" in (friendly.config.timeouts as unknown as Record<string, unknown>)));
  writeFileSync(join(ws, ".pi", "debate.json"), JSON.stringify({ timeouts: { turn: "five bananas" } }));
  let invalidDurationThrew = false;
  try { loadConfig(ws, true); } catch (e) { invalidDurationThrew = e instanceof DurationError; }
  check("invalid configured duration hard-errors", invalidDurationThrew);
  writeFileSync(join(ws, ".pi", "debate.json"), JSON.stringify({ timeouts: { turn: "0" } }));
  let zeroTurnThrew = false;
  try { loadConfig(ws, true); } catch (e) { zeroTurnThrew = e instanceof DurationError; }
  check("zero turn duration hard-errors", zeroTurnThrew);

  // Untrusted project config must be ignored: it can redirect model spend.
  const untrusted = loadConfig(ws, false);
  eq("untrusted project config ignored", untrusted.config.budget.usd, 5);
  check("untrusted is warned about",
    untrusted.warnings.some((w) => w.includes("not trusted")), untrusted.warnings.join("; "));

  // Malformed JSON must not throw.
  writeFileSync(join(ws, ".pi", "debate.json"), "{ this is not json");
  const bad = loadConfig(ws, true);
  eq("malformed config falls back to defaults", bad.config.budget.usd, 5);
  check("malformed config is warned about",
    bad.warnings.some((w) => w.includes("malformed")), bad.warnings.join("; "));

  // D8 violation detection + WP0 provider warnings.
  writeFileSync(
    join(ws, ".pi", "debate.json"),
    JSON.stringify({
      models: {
        ideator: "openrouter/anthropic/claude-opus-4-8",
        skeptic: "openrouter/anthropic/claude-opus-4-8",
        synthesizer: "openrouter/google/gemini-3.1-pro-preview",
      },
    }),
  );
  const same = loadConfig(ws, true);
  check("same-family judge/debater is flagged (D8)",
    same.warnings.some((w) => w.includes("D8 violation")), same.warnings.join("; "));

  writeFileSync(
    join(ws, ".pi", "debate.json"),
    JSON.stringify({ models: { ideator: "ibm-services-essentials/claude-opus-5" } }),
  );
  const ibm = loadConfig(ws, true);
  check("zero-cost provider is flagged (§13.14)",
    ibm.warnings.some((w) => w.includes("cost.total=0")), ibm.warnings.join("; "));

  writeFileSync(
    join(ws, ".pi", "debate.json"),
    JSON.stringify({ models: { synthesizer: "opencode/gemini-3.1-pro" } }),
  );
  const oc = loadConfig(ws, true);
  check("unfunded provider is flagged (§13.15)",
    oc.warnings.some((w) => w.includes("CreditsError")), oc.warnings.join("; "));

  console.log("\n-- resolveRoleModel: config beats frontmatter --");
  eq("config wins",
    resolveRoleModel(DEFAULTS, "skeptic", "persona/model-from-frontmatter"),
    { provider: "openrouter", model: "openai/gpt-5.6-sol" });
  const nulled = JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig;
  nulled.models.skeptic = null;
  eq("null config falls back to frontmatter",
    resolveRoleModel(nulled, "skeptic", "openai-codex/gpt-6-astra"),
    { provider: "openai-codex", model: "gpt-6-astra" });
  let threw = false;
  try { resolveRoleModel(nulled, "skeptic", null); } catch { threw = true; }
  check("no model anywhere throws a readable error", threw);

  console.log("\n-- paths (§3) --");
  const rid = newRunId(new Date(2026, 8, 6, 18, 12, 0));
  check("run-id shape YYYYMMDD-HHMMSS-xxxx", /^20260906-181200-[0-9a-f]{4}$/.test(rid), rid);
  const p = runPaths(ws, rid);
  check("run dir under .debate/runs", p.runDir === join(ws, ".debate", "runs", rid));
  check("root verdict at workspace root", p.rootVerdict === join(ws, "debate_verdict.md"));
  check("lessons is per-workspace not per-run", p.lessons === join(ws, ".debate", "lessons.md"));
  eq("turn file r1", turnFileName(1, "ideator"), "r1-ideator.md");
  eq("turn file verdict", turnFileName("verdict", "synthesizer"), "verdict.md");
  eq("listRuns on empty workspace", listRuns(ws).length, 0);
} finally {
  rmSync(ws, { recursive: true, force: true });
}

// ===========================================================================
// §13.51: the dryRun estimate. Had NO test, which is how "$3.50-$14.00 for a 211-char
// seed" shipped -- the logic sat in index.ts, which tests cannot import (§13.21).
console.log("\n-- estimateRun: measured anchors, and $0 when nothing can be billed --");
{
  const paid = [{ provider: "openrouter" }, { provider: "openrouter" }, { provider: "openrouter" }];
  const ibm = [
    { provider: "ibm-services-essentials" },
    { provider: "ibm-services-essentials" },
    { provider: "ibm-services-essentials" },
  ];

  eq("review turns = 2r+1", estimateRun({ mode: "review", rounds: 3, seedChars: 6100, roles: paid }).turns, 7);
  eq("explore turns = 2r", estimateRun({ mode: "explore", rounds: 3, seedChars: 6100, roles: paid }).turns, 6);

  // A no-price-table roster must never quote dollars (§13.14/§13.19).
  const free = estimateRun({ mode: "review", rounds: 3, seedChars: 51839, roles: ibm });
  check("ibm roster bills nothing", free.billsNothing);
  eq("free estimate is exactly 0", [free.estLow, free.estHigh], [0, 0]);

  // A role explicitly declared free counts too, whatever its provider.
  const declared = estimateRun({ mode: "review", rounds: 3, seedChars: 6100,
    roles: [{ provider: "x", free: true }, { provider: "y", free: true }, { provider: "z", free: true }] });
  check("explicitly-free roles bill nothing", declared.billsNothing);

  // Mixed roster: one billable role means the cost is real.
  const mixed = estimateRun({ mode: "review", rounds: 3, seedChars: 6100,
    roles: [{ provider: "ibm-services-essentials" }, { provider: "openrouter" },
            { provider: "ibm-services-essentials" }] });
  check("a single paid role makes it billable", !mixed.billsNothing);
  check("mixed roster quotes a non-zero range", mixed.estHigh > 0);

  // The WP5 anchor: 6.1KB / 3 rounds measured $2.11, so the range must straddle it.
  const anchor = estimateRun({ mode: "review", rounds: 3, seedChars: 6100, roles: paid });
  check("range straddles the measured $2.11",
    anchor.estLow < 2.11 && anchor.estHigh > 2.11, JSON.stringify(anchor));

  // The bug this test exists to prevent: a tiny seed must not be quoted in double digits.
  const tiny = estimateRun({ mode: "review", rounds: 3, seedChars: 211, roles: paid });
  check("a 211-char seed is under $1, not $14 (§13.51)", tiny.estHigh < 1, JSON.stringify(tiny));
  check("but not free either, on paid models", tiny.estHigh > 0);

  // Bigger seed and more rounds cost more; fewer rounds cost less.
  const big = estimateRun({ mode: "review", rounds: 3, seedChars: 51839, roles: paid });
  check("51.8KB estimates above 6.1KB", big.estHigh > anchor.estHigh);
  const two = estimateRun({ mode: "review", rounds: 2, seedChars: 6100, roles: paid });
  check("2 rounds estimates below 3", two.estHigh < anchor.estHigh);
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
