/**
 * WP3 acceptance (§11) — orchestrator against the fake runner. No model calls.
 *
 * Scenarios, verbatim from the work order:
 *  (a) gate closes after R2 -> 5 turns
 *  (b) unresolved high -> R3 -> 7 turns
 *  (c) R2 timeout -> repair -> fail -> status partial
 *  (d) both R1 turns fail -> status failed, no verdict
 *  (e) cost cap tripped after R2 -> partial verdict
 *  (f) explore mode -> 4 turns, Ideator-only R1, Skeptic speaks first in R2
 *  (g) kill after R2 then resume -> only remaining turns run
 *  (h) crash between a completed turn and its merge (merged:false) -> resume re-merges
 *      from turns/ without a model call
 *  (i) per-turn cost ceiling breached -> turn costcap, one repair, then continue
 *  (j) repair cap exhausted -> invalid turns skipped, run still reaches a verdict
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Orchestrator, roundPlan } from "../orchestrator.ts";
import { DEFAULTS, type DebateConfig } from "../config.ts";
import { FakeRunner, fakeTurnText, usageWith, type FakeFixture } from "../runner/fake.ts";
import { readManifest, readEvents } from "../manifest.ts";
import { runPaths } from "../paths.ts";
import type { Ledger } from "../ledger.ts";

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
const SEED = [
  "# Migration Plan",
  "",
  "## Implementation Phase 5",
  "Quiesce Docker Desktop and snapshot.",
  "",
  "## Implementation Phase 6",
  "Verify checksums.",
].join("\n");

function cfg(over: Partial<DebateConfig> = {}): DebateConfig {
  const base = JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig;
  // Existing protocol scenarios test debate mechanics. Artifact generation has its own
  // scenario below, so it cannot add an unrelated eighth turn to every legacy fixture.
  base.artifact.enabled = false;
  return { ...base, ...over } as DebateConfig;
}

/** Claims that keep a high-severity item OPEN, so the gate wants R3. */
const openHighClaims = [
  { id: "C1", text: "Snapshot may be inconsistent while Rancher runs", severity: "high",
    test: "tmutil compare", sourceRef: "§Implementation Phase 5", status: "open" },
  { id: "C2", text: "Cask versions are not pinned anywhere", severity: "medium", test: "brew bundle" },
  { id: "C3", text: "No rollback path is documented for phase 5", severity: "high", test: "read plan" },
];

let ws = "";
function fresh(): string {
  ws = mkdtempSync(join(tmpdir(), "debate-wp3-"));
  return ws;
}
function cleanup(): void { if (ws) rmSync(ws, { recursive: true, force: true }); }

// ===========================================================================
console.log("\n-- roundPlan: ordering rules (§5, D7) --");
eq("review R1 is parallel ideator+skeptic", roundPlan("review", 1), { roles: ["ideator", "skeptic"], parallel: true });
eq("review R2 is ideator-first, sequential", roundPlan("review", 2), { roles: ["ideator", "skeptic"], parallel: false });
eq("explore R1 is ideator only", roundPlan("explore", 1), { roles: ["ideator"], parallel: false });
eq("explore R2 puts the SKEPTIC first", roundPlan("explore", 2), { roles: ["skeptic", "ideator"], parallel: false });
eq("explore R3 keeps skeptic-first", roundPlan("explore", 3), { roles: ["skeptic", "ideator"], parallel: false });

// ===========================================================================
console.log("\n-- (a) gate closes after R2 -> 5 turns --");
{
  const w = fresh();
  // R2 skeptic resolves both high claims with refutedPremise so the gate closes.
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "Plan is sound overall", type: "INFERENCE", sourceRef: "§Implementation Phase 5" }]) },
      "1-skeptic": { text: fakeTurnText(openHighClaims) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "mitigation proposal" }]) },
      // §13.34 + §13.39: only the claim's own author can retire it with evidence.
      "2-skeptic": { text: fakeTurnText([
        { id: "B1", status: "resolved", refutedPremise: "Phase 5 does quiesce Rancher",
          evidence: "ran: grep -n rancher plan.md -> quiesced at line 191" },
        { id: "B3", status: "resolved", refutedPremise: "Rollback is in appendix",
          evidence: "ran: grep -n rollback plan.md -> appendix B documents it" },
        { id: "C1", text: "Minor doc gap in phase 6", severity: "low" },
      ]) },
      "verdict-synthesizer": { text: "## 1. Unresolved items\n\nNone.\n\n## 2. Decision\n\nproceed-with-changes\n" },
    },
  });
  const o = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260906-100000-aaaa", { seedText: SEED, seedSource: "test", mode: "review" });

  eq("status complete", out.status, "complete");
  eq("5 model turns (2+2+verdict)", runner.calls.length, 5);
  eq("turn sequence", runner.sequence(), ["1-ideator", "1-skeptic", "2-ideator", "2-skeptic", "verdict-synthesizer"]);
  eq("rounds recorded as 2", out.manifest.rounds, 2);
  check("gate_closed event present",
    readEvents(runPaths(w, out.runId).events).some((e) => e.code === "gate_closed"));
  check("verdict written at workspace root", existsSync(join(w, "debate_verdict.md")));
  check("verdict contains the judge body",
    readFileSync(join(w, "debate_verdict.md"), "utf8").includes("proceed-with-changes"));
  check("verdict has the orchestrator cost section",
    readFileSync(join(w, "debate_verdict.md"), "utf8").includes("## 7. Cost and provenance"));
  check("all turns merged",
    out.manifest.turns.filter((t) => t.round !== "verdict").every((t) => t.merged));
  check("lessons.md written for high-severity claims", existsSync(join(w, ".debate", "lessons.md")));
  cleanup();
}

// ===========================================================================
console.log("\n-- (b) unresolved high -> R3 -> 7 turns --");
{
  const w = fresh();
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "Plan is sound" }]) },
      "1-skeptic": { text: fakeTurnText(openHighClaims) },
      // Nobody resolves the high claims, so the gate stays open.
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "Additional mitigation idea" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "Still unverified after round 2", severity: "high" }]) },
      "3-ideator": { text: fakeTurnText([{ id: "C1", text: "Final response" }]) },
      "3-skeptic": { text: fakeTurnText([{ id: "C1", text: "Remaining risk", severity: "high" }]) },
      "verdict-synthesizer": { text: "## 1. Unresolved items\n\nB1, B3 open.\n\n## 2. Decision\n\ndo-not-proceed\n" },
    },
  });
  const o = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260906-100001-bbbb", { seedText: SEED, seedSource: "test", mode: "review" });

  eq("7 model turns (2+2+2+verdict)", runner.calls.length, 7);
  eq("turn sequence includes R3", runner.sequence(),
     ["1-ideator", "1-skeptic", "2-ideator", "2-skeptic", "3-ideator", "3-skeptic", "verdict-synthesizer"]);
  eq("rounds recorded as 3", out.manifest.rounds, 3);
  check("gate_open event present",
    readEvents(runPaths(w, out.runId).events).some((e) => e.code === "gate_open"));
  check("open high severity reported", out.openHighSeverity > 0);
  eq("status complete", out.status, "complete");
  cleanup();
}

// ===========================================================================
console.log("\n-- (c) R2 timeout -> repair -> fail -> status partial --");
{
  const w = fresh();
  // 2-ideator times out on both the original attempt and its repair.
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "Plan is sound" }]) },
      "1-skeptic": { text: fakeTurnText(openHighClaims) },
      "2-ideator": [
        { status: "timeout", text: "", stopReason: "aborted", usage: null },
        { status: "timeout", text: "", stopReason: "aborted", usage: null },
      ],
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "carry on", severity: "low" }]) },
      "verdict-synthesizer": { text: "## 1. Unresolved items\n\nopen\n\n## 2. Decision\n\ndo-not-proceed\n" },
    },
  });
  const o = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260906-100002-cccc", { seedText: SEED, seedSource: "test", mode: "review" });

  const seq = runner.sequence();
  eq("2-ideator was attempted twice (original + repair)",
     seq.filter((s) => s === "2-ideator").length, 2);
  const ev = readEvents(runPaths(w, out.runId).events);
  check("repair_start logged", ev.some((e) => e.code === "repair_start"));
  check("repair_failed logged", ev.some((e) => e.code === "repair_failed"));
  eq("repairsUsed is 1", out.manifest.repairsUsed, 1);
  check("failed turn recorded unmerged",
    out.manifest.turns.some((t) => t.round === 2 && t.role === "ideator" && !t.merged));
  check("protocol continued past the failed turn", seq.includes("2-skeptic"));
  check("verdict still produced", out.verdictPath !== null);
  cleanup();
}

// ===========================================================================
console.log("\n-- (d) both R1 turns fail -> status failed, NO verdict --");
{
  const w = fresh();
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { status: "failed", text: "", stopReason: "error", usage: null },
      "1-skeptic": { status: "failed", text: "", stopReason: "error", usage: null },
    },
    fallback: { status: "failed", text: "", usage: null },
  });
  const o = new Orchestrator({
    workspace: w, cfg: cfg({ repairs: { max: 0 } } as Partial<DebateConfig>),
    runner, personaDir: PERSONA_DIR,
  });
  const out = await o.start("20260906-100003-dddd", { seedText: SEED, seedSource: "test", mode: "review" });

  eq("status failed", out.status, "failed");
  eq("no verdict path", out.verdictPath, null);
  check("no verdict file at workspace root", !existsSync(join(w, "debate_verdict.md")));
  check("early_abort event logged",
    readEvents(runPaths(w, out.runId).events).some((e) => e.code === "early_abort"));
  check("no synthesizer turn was attempted", !runner.sequence().includes("verdict-synthesizer"));
  check("manifest persisted despite failure", existsSync(runPaths(w, out.runId).manifest));
  cleanup();
}

// ===========================================================================
console.log("\n-- (e) cost cap tripped after R2 -> partial verdict --");
{
  const w = fresh();
  // Each turn costs $2.00; a $5 run cap must bind at a turn boundary before R3.
  const pricey = (claims: unknown[]): FakeFixture => ({
    text: fakeTurnText(claims), usage: usageWith({ input: 10000, output: 2000, costTotal: 2.0 }),
  });
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": pricey([{ id: "C1", text: "Plan is sound" }]),
      "1-skeptic": pricey(openHighClaims),
      "2-ideator": pricey([{ id: "C1", text: "response" }]),
      "2-skeptic": pricey([{ id: "C1", text: "still open", severity: "high" }]),
      "3-ideator": pricey([{ id: "C1", text: "should never run" }]),
      "verdict-synthesizer": { text: "## 2. Decision\n\ndo-not-proceed\n", usage: usageWith({ costTotal: 0.1 }) },
    },
  });
  const o = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260906-100004-eeee", { seedText: SEED, seedSource: "test", mode: "review" });

  eq("status partial", out.status, "partial");
  check("R3 never ran", !runner.sequence().some((s) => s.startsWith("3-")), runner.sequence().join(","));
  check("budget_stop logged with a cost reason",
    readEvents(runPaths(w, out.runId).events).some(
      (e) => e.code === "budget_stop" && String(e.reason).includes("cost")));
  check("verdict still written (partial, not nothing)", out.verdictPath !== null);
  check("verdict header says partial",
    readFileSync(join(w, "debate_verdict.md"), "utf8").includes("Status: partial"));
  check("run cost is the SUM across turns, not the last turn",
    out.costUsd >= 6, `costUsd=${out.costUsd}`);
  // The cap binds at a turn BOUNDARY, so it overshoots by at most one turn: three
  // $2 turns ($6) trip the $5 cap before the 4th starts, plus the $0.10 verdict.
  check("cap overshoots by at most one turn, not unboundedly",
    out.costUsd < 9, `costUsd=${out.costUsd}`);
  cleanup();
}

// ===========================================================================
console.log("\n-- (f) explore mode -> 4 turns, ideator-only R1, SKEPTIC FIRST in R2 --");
{
  const w = fresh();
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "Bun could replace node here", type: "INFERENCE" }]) },
      "2-skeptic": { text: fakeTurnText([
        { id: "C1", text: "Bun lacks a needed native module", severity: "high", test: "bun install" },
        { id: "C2", text: "CI images would need rebuilding", severity: "medium" },
        { id: "C3", text: "No perf baseline exists", severity: "medium" },
      ]) },
      "2-ideator": { text: fakeTurnText([{ id: "B1", status: "disputed" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\npursue-narrowed\n" },
    },
  });
  const o = new Orchestrator({
    workspace: w, cfg: cfg({ rounds: { max: 2, gateSeverity: "high" } } as Partial<DebateConfig>),
    runner, personaDir: PERSONA_DIR,
  });
  const out = await o.start("20260906-100005-ffff", { seedText: "Try bun instead of node.", seedSource: "inline", mode: "explore" });

  eq("4 model turns", runner.calls.length, 4);
  eq("R1 is ideator only, R2 is skeptic-then-ideator", runner.sequence(),
     ["1-ideator", "2-skeptic", "2-ideator", "verdict-synthesizer"]);
  check("no skeptic turn in R1", !runner.sequence().includes("1-skeptic"));
  eq("status complete", out.status, "complete");
  eq("mode recorded as explore", out.manifest.mode, "explore");
  cleanup();
}

// ===========================================================================
console.log("\n-- (g) kill after R2 then resume -> only remaining turns run --");
{
  const w = fresh();
  const runId = "20260906-100006-9999";
  const mk = (extra: Record<string, FakeFixture> = {}) => new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "Plan is sound" }]) },
      "1-skeptic": { text: fakeTurnText(openHighClaims) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "resp" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "still open", severity: "high" }]) },
      "3-ideator": { text: fakeTurnText([{ id: "C1", text: "r3 resp" }]) },
      "3-skeptic": { text: fakeTurnText([{ id: "C1", text: "r3 flaw", severity: "high" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\ndo-not-proceed\n" },
      ...extra,
    },
  });

  // First pass: abort as soon as R2's skeptic turn has been requested.
  const r1 = mk();
  const o1 = new Orchestrator({
    workspace: w, cfg: cfg(), runner: r1, personaDir: PERSONA_DIR,
    onProgress: (p) => { if (p.round === 2 && p.role === "skeptic") o1.abort(); },
  });
  const first = await o1.start(runId, { seedText: SEED, seedSource: "test", mode: "review" });
  eq("first pass aborted", first.status, "aborted");
  const turnsBefore = r1.calls.length;
  check("first pass stopped before R3", !r1.sequence().some((s) => s.startsWith("3-")), r1.sequence().join(","));
  // §8.4 lists `aborted` among the valid verdict Status values, so an aborted run DOES
  // get a verdict file - just a mechanical one, with no judge turn attempted.
  check("aborted run writes a verdict with Status: aborted",
    first.verdictPath !== null &&
    readFileSync(join(w, "debate_verdict.md"), "utf8").includes("Status: aborted"));
  check("no judge turn was attempted on abort",
    !r1.sequence().includes("verdict-synthesizer"), r1.sequence().join(","));

  // Resume: must run only what is missing.
  const r2 = mk();
  const o2 = new Orchestrator({ workspace: w, cfg: cfg(), runner: r2, personaDir: PERSONA_DIR });
  const second = await o2.resume(runId);
  const resumedSeq = r2.sequence();
  check("resume did not re-run round 1", !resumedSeq.some((s) => s.startsWith("1-")), resumedSeq.join(","));
  check("resume reached the verdict", resumedSeq.includes("verdict-synthesizer"));
  check("resume is cheaper than a fresh run", r2.calls.length < turnsBefore + 7);
  check("resumedFrom recorded", second.manifest.resumedFrom === runId);
  check("verdict now exists", existsSync(join(w, "debate_verdict.md")));
  cleanup();
}

// ===========================================================================
console.log("\n-- (h) crash between a completed turn and its merge -> resume re-merges from disk --");
{
  const w = fresh();
  const runId = "20260906-100007-8888";
  const p = runPaths(w, runId);

  // Stage the aftermath of a crash: R1 both turns complete on disk, ideator merged,
  // skeptic written to turns/ but manifest says merged:false and the ledger lacks it.
  const runner0 = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "Plan is sound" }]) },
      "1-skeptic": { text: fakeTurnText(openHighClaims) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "resp" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "flaw", severity: "high" }]) },
      "3-ideator": { text: fakeTurnText([{ id: "C1", text: "r3" }]) },
      "3-skeptic": { text: fakeTurnText([{ id: "C1", text: "r3 flaw", severity: "high" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\ndo-not-proceed\n" },
    },
  });
  const o0 = new Orchestrator({
    workspace: w, cfg: cfg(), runner: runner0, personaDir: PERSONA_DIR,
    // Abort at the first R2 progress tick, so exactly R1 is on disk: A1 + B1,B2,B3.
    onProgress: (pr) => { if (pr.round === 2 && pr.role === "ideator") o0.abort(); },
  });
  await o0.start(runId, { seedText: SEED, seedSource: "test", mode: "review" });

  // Simulate the crash window: mark the skeptic turn unmerged and roll the ledger back
  // to only the ideator's claims, leaving turns/r1-skeptic.md on disk. Rebuild the
  // ledger from the ideator turn file rather than filtering, so the staged state is
  // exactly "ideator merged, skeptic not".
  const man = readManifest(p.manifest);
  const skepticRec = man.turns.find((t) => t.round === 1 && t.role === "skeptic")!;
  skepticRec.merged = false;
  // Drop every turn after R1 so resume replays from R2 with R1-skeptic unmerged.
  man.turns = man.turns.filter((t) => t.round === 1);
  writeFileSync(p.manifest, JSON.stringify(man, null, 2));

  const led = JSON.parse(readFileSync(p.ledger, "utf8")) as Ledger;
  const ideatorOnly = led.claims.filter((c) => c.author === "A" && c.round === 1);
  led.claims = ideatorOnly;
  led.version = 1;
  writeFileSync(p.ledger, JSON.stringify(led, null, 2));

  check("precondition: skeptic turn file is on disk",
    existsSync(join(p.turnsDir, "r1-skeptic.md")));
  check("precondition: ledger has no skeptic claims",
    led.claims.every((c) => c.author === "A") && led.claims.length > 0,
    JSON.stringify(led.claims.map((c) => c.id)));

  const runner1 = new FakeRunner({
    fixtures: {
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "resp" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "flaw", severity: "high" }]) },
      "3-ideator": { text: fakeTurnText([{ id: "C1", text: "r3" }]) },
      "3-skeptic": { text: fakeTurnText([{ id: "C1", text: "r3 flaw", severity: "high" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\ndo-not-proceed\n" },
    },
  });
  const o1 = new Orchestrator({ workspace: w, cfg: cfg(), runner: runner1, personaDir: PERSONA_DIR });
  const out = await o1.resume(runId);

  const ev = readEvents(p.events);
  check("remerge_from_disk logged", ev.some((e) => e.code === "remerge_from_disk"));
  check("NO model call was made for the re-merged turn",
    !runner1.sequence().includes("1-skeptic"), runner1.sequence().join(","));
  const finalLed = JSON.parse(readFileSync(p.ledger, "utf8")) as Ledger;
  check("skeptic claims are back in the ledger",
    finalLed.claims.some((c) => c.author === "B"), JSON.stringify(finalLed.claims.map((c) => c.id)));
  check("re-merged turn is now marked merged",
    out.manifest.turns.find((t) => t.round === 1 && t.role === "skeptic")!.merged);
  cleanup();
}

// ===========================================================================
console.log("\n-- (i) per-turn cost ceiling breached -> costcap, one repair, continue --");
{
  const w = fresh();
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "Plan is sound" }]) },
      // First attempt is killed mid-turn by the runner's ceiling; the repair succeeds.
      "1-skeptic": [
        { status: "costcap", text: "", stopReason: "aborted",
          usage: usageWith({ input: 50000, output: 5000, costTotal: 2.05 }) },
        { status: "ok", text: fakeTurnText(openHighClaims) },
      ],
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "resp" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "low risk left", severity: "low" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed-with-changes\n" },
    },
  });
  const o = new Orchestrator({
    workspace: w, cfg: cfg({ budget: { ...DEFAULTS.budget, usd: 100 } } as Partial<DebateConfig>),
    runner, personaDir: PERSONA_DIR,
  });
  const out = await o.start("20260906-100008-7777", { seedText: SEED, seedSource: "test", mode: "review" });

  eq("1-skeptic attempted twice", runner.sequence().filter((s) => s === "1-skeptic").length, 2);
  check("costcap turn recorded",
    out.manifest.turns.some((t) => t.status === "costcap"),
    JSON.stringify(out.manifest.turns.map((t) => t.status)));
  check("repair_start logged",
    readEvents(runPaths(w, out.runId).events).some((e) => e.code === "repair_start"));
  check("cost of the killed turn is still charged to the run", out.costUsd >= 2.05, `${out.costUsd}`);
  check("protocol continued to a verdict", out.verdictPath !== null);
  check("skeptic claims from the repair landed",
    out.ledger.claims.some((c) => c.author === "B"));
  cleanup();
}

// ===========================================================================
console.log("\n-- (j) repair cap exhausted -> invalid turns skipped, verdict still reached --");
{
  const w = fresh();
  // Every debater turn emits prose with NO ledger block -> always "unusable".
  const noBlock: FakeFixture = { status: "ok", text: "I have thoughts but no ledger block." };
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "Plan is sound", sourceRef: "§Implementation Phase 5" }]) },
      "1-skeptic": noBlock,
      "2-ideator": noBlock,
      "2-skeptic": noBlock,
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n" },
    },
  });
  const o = new Orchestrator({
    workspace: w, cfg: cfg({ repairs: { max: 2 }, rounds: { max: 2, gateSeverity: "high" } } as Partial<DebateConfig>),
    runner, personaDir: PERSONA_DIR,
  });
  const out = await o.start("20260906-100009-6666", { seedText: SEED, seedSource: "test", mode: "review" });

  eq("repairsUsed capped at 2", out.manifest.repairsUsed, 2);
  const ev = readEvents(runPaths(w, out.runId).events);
  check("repair_cap_reached logged", ev.some((e) => e.code === "repair_cap_reached"));
  check("ledger_block_unusable logged", ev.some((e) => e.code === "ledger_block_unusable"));
  check("run still reached a verdict", out.verdictPath !== null);
  check("verdict exists on disk", existsSync(join(w, "debate_verdict.md")));
  // 1-skeptic (2 attempts) + 2-ideator (2) + 2-skeptic (1, cap hit) + verdict
  check("repair attempts stopped once the cap was hit",
    runner.sequence().filter((s) => s === "2-skeptic").length === 1,
    runner.sequence().join(","));
  cleanup();
}

// ===========================================================================
console.log("\n-- extra: budget/token cap and cost_unreported (§13.19) --");
{
  const w = fresh();
  // Tokens reported, cost zero: the USD cap cannot bind, tokens must.
  const zeroCost: FakeFixture = {
    text: fakeTurnText([{ id: "C1", text: "claim", severity: "high" }]),
    usage: usageWith({ input: 400000, output: 100000, costTotal: 0 }),
  };
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": zeroCost, "1-skeptic": zeroCost,
      "2-ideator": zeroCost, "2-skeptic": zeroCost,
      "3-ideator": zeroCost, "3-skeptic": zeroCost,
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n", usage: usageWith({ costTotal: 0 }) },
    },
  });
  const o = new Orchestrator({
    workspace: w,
    cfg: cfg({ budget: { ...DEFAULTS.budget, tokens: 1_000_000 } } as Partial<DebateConfig>),
    runner, personaDir: PERSONA_DIR,
  });
  const out = await o.start("20260906-100010-5555", { seedText: SEED, seedSource: "test", mode: "review" });

  check("costTrusted flipped to false", out.manifest.costTrusted === false);
  check("cost_unreported event logged",
    readEvents(runPaths(w, out.runId).events).some((e) => e.code === "cost_unreported"));
  check("token cap stopped the run", out.status === "partial", out.status);
  check("verdict warns that cost is understated",
    readFileSync(join(w, "debate_verdict.md"), "utf8").includes("understated"));
  cleanup();
}

// ===========================================================================
console.log("\n-- extra: judge input is built and anonymized (§8.3, §5.1) --");
{
  const w = fresh();
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "Phase 5 is safe", sourceRef: "§Implementation Phase 5" }]) },
      "1-skeptic": { text: fakeTurnText([
        { id: "C1", text: "Phase 5 snapshot risk", severity: "high", sourceRef: "L3-4", test: "tmutil" },
        { id: "C2", text: "Checksum step is vague", severity: "medium", sourceRef: "§Implementation Phase 6" },
        { id: "C3", text: "No rollback", severity: "high", sourceRef: "§Ghost Section" },
      ]) },
      "2-ideator": { text: fakeTurnText([{ id: "B1", status: "disputed" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "residual", severity: "low" }]) },
      "3-ideator": { text: fakeTurnText([{ id: "C1", text: "r3" }]) },
      "3-skeptic": { text: fakeTurnText([{ id: "C1", text: "r3f", severity: "low" }]) },
      "verdict-synthesizer": (req) => {
        // The judge must receive the ledger inline (§13.31) but never authorship (§5.1).
        check("judge mission carries the ledger inline",
          req.mission.includes('"claims"'), req.mission.slice(0, 150));
        check("judge mission has no author field",
          !req.mission.includes('"author"'));
        check("judge mission has no bare A/B author labels",
          !/"(A|B)"/.test(req.mission));
        check("judge mission has no history.by",
          !req.mission.includes('"by"'));
        check("judge gets the excerpts file, not the seed",
          req.attachPath !== null && req.attachPath.includes("excerpts"));
        eq("judge has no tools", req.tools, "none");
        return { text: "## 2. Decision\n\ndo-not-proceed\n" };
      },
    },
  });
  const o = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260906-100011-4444", { seedText: SEED, seedSource: "test", mode: "review" });
  const p = runPaths(w, out.runId);

  check("judge/excerpts.md written", existsSync(p.judgeExcerpts));
  check("judge/ledger.json written", existsSync(p.judgeLedger));
  const jl = readFileSync(p.judgeLedger, "utf8");
  check("judge ledger has no author field", !jl.includes('"author"'));
  const exc = readFileSync(p.judgeExcerpts, "utf8");
  check("excerpts resolved the cited heading", exc.includes("Quiesce Docker Desktop"));
  check("excerpts report the unresolvable ref", exc.includes("Unresolved source references"));
  cleanup();
}

// ===========================================================================
console.log("\n-- extra: missions never carry previous prose (§8.2) --");
{
  const w = fresh();
  const SECRET = "ZZ-PROSE-MARKER-DO-NOT-FORWARD";
  const missions: string[] = [];
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: `${SECRET} in the prose.\n\n${fakeTurnText([{ id: "C1", text: "claim one" }])}` },
      "1-skeptic": { text: `${SECRET} again.\n\n${fakeTurnText(openHighClaims)}` },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "r2" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "r2f", severity: "low" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n" },
    },
    onRun: (req) => missions.push(req.mission),
  });
  const o = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  await o.start("20260906-100012-3333", { seedText: SEED, seedSource: "test", mode: "review" });

  check("no mission contains previous turn prose",
    missions.every((m) => !m.includes(SECRET)));
  check("R2 missions DO contain the ledger",
    missions.slice(2).some((m) => m.includes("claim ledger") || m.includes('"claims"')));
  check("no mission begins with @ or -",
    missions.every((m) => !m.startsWith("@") && !m.trimStart().startsWith("-")));
  cleanup();
}

// ===========================================================================
console.log("\n-- artifact: corrected draft is a separate, traceable human-review artifact --");
{
  const w = fresh();
  const source = join(w, "migration-plan.md");
  writeFileSync(source, SEED);
  const revised = `${SEED}\n\n> **DEBATE BLOCKER (B1):** Confirm the authoritative plan path.\n<!-- debate: B1 -->\n`;
  const runner = new FakeRunner({ fixtures: {
    "1-ideator": { text: fakeTurnText([{ id: "C1", text: "plan structure is sound", severity: "low" }]) },
    "1-skeptic": { text: fakeTurnText([{ id: "C1", text: "authoritative path is ambiguous", severity: "high", status: "open", evidence: "read source path" }]) },
    "2-ideator": { text: fakeTurnText([{ id: "C1", text: "add a path preflight", severity: "low" }]) },
    "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "still unresolved", severity: "high" }]) },
    "3-ideator": { text: fakeTurnText([{ id: "C1", text: "keep blocker", severity: "low" }]) },
    "3-skeptic": { text: fakeTurnText([{ id: "C1", text: "still unresolved", severity: "high" }]) },
    "verdict-synthesizer": { text: "## 2. Decision\n\nproceed-with-changes\n" },
    "artifact-synthesizer": { text: revised },
  }});
  const config = cfg({ artifact: { enabled: true, turnMs: 60_000 } });
  const o = new Orchestrator({ workspace: w, cfg: config, runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260909-100000-artifact", { seedText: SEED, seedSource: source, mode: "review" });
  const p = runPaths(w, out.runId);
  eq("artifact is the final bounded model turn", runner.sequence().at(-1), "artifact-synthesizer");
  check("source is untouched", readFileSync(source, "utf8") === SEED);
  eq("sibling draft path", out.artifactPath, join(w, "migration-plan.debate-draft.md"));
  check("workspace draft exists", !!out.artifactPath && existsSync(out.artifactPath));
  check("per-run artifact copy exists", existsSync(p.artifactDraft));
  check("provenance exists", existsSync(p.artifactProvenance));
  const draft = readFileSync(out.artifactPath!, "utf8");
  check("draft has an explicit human-review header", draft.includes("HUMAN REVIEW REQUIRED"));
  check("draft identifies unresolved claim", /Still unresolved: [A-Z][0-9]/.test(draft), draft.slice(0, 500));
  check("draft includes model's claim annotation", draft.includes("<!-- debate: B1 -->"));
  check("manifest records a written artifact", out.manifest.artifact?.status === "written");
  check("verdict links the draft", readFileSync(out.verdictPath!, "utf8").includes("## 8. Corrected draft"));
  cleanup();
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
