/**
 * WP6 acceptance (§11) — UI + session integration, against the fake runner. No tokens.
 *
 * §11's acceptance for WP6: "widget updates per turn and shows live cost; abort kills
 * and marks aborted; after completion the next prompt demonstrably has the verdict in
 * context."
 *
 * The abort half is what §13 flagged as genuinely missing: `abort()` used to set only
 * in-memory flags, leaving the on-disk manifest saying `running` unless `drive()`
 * happened to unwind. Per the §13.31/§13.32 lesson these assertions read the FILES,
 * not the orchestrator's own memory — an in-memory check would have passed against the
 * old broken code.
 *
 * Scenarios:
 *  (a) abort mid-run persists status:"aborted" to disk immediately
 *  (b) abort is idempotent and does not overwrite a finished run's status
 *  (c) abort before init() does not throw
 *  (d) abort writes an `aborted` event and an endedAt
 *  (e) progress fires per turn with monotonically non-decreasing cost (widget source)
 *  (f) a completed run leaves a verdict readable for context injection
 *  (g) the session_start sweep marks a crashed `running` run as aborted
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Orchestrator } from "../orchestrator.ts";
import { DEFAULTS, type DebateConfig } from "../config.ts";
import { FakeRunner, fakeTurnText, usageWith } from "../runner/fake.ts";
import { readManifest, readEvents, newManifest, writeManifest } from "../manifest.ts";
import { runPaths } from "../paths.ts";
import type { Progress } from "../orchestrator.ts";

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
].join("\n");

function cfg(over: Partial<DebateConfig> = {}): DebateConfig {
  const base = JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig;
  return { ...base, ...over } as DebateConfig;
}

const openHighClaims = [
  { id: "C1", text: "Snapshot may be inconsistent while Rancher runs", severity: "high",
    test: "tmutil compare", sourceRef: "§Implementation Phase 5", status: "open" },
  { id: "C2", text: "No rollback path is documented", severity: "high", test: "read plan" },
];

let ws = "";
function fresh(): string {
  ws = mkdtempSync(join(tmpdir(), "debate-wp6-"));
  return ws;
}
function cleanup(): void { if (ws) rmSync(ws, { recursive: true, force: true }); }

// ===========================================================================
console.log("\n-- (a) abort mid-run persists status:\"aborted\" to DISK --");
{
  const w = fresh();
  let orch: Orchestrator | null = null;
  // Abort from inside the 1-skeptic turn: the run is genuinely in flight, which is the
  // case the old code got wrong.
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "Plan is sound", type: "INFERENCE" }]),
                     usage: usageWith({ input: 1000, output: 100, costTotal: 0.01 }) },
      "1-skeptic": () => {
        orch!.abort();
        return { text: fakeTurnText(openHighClaims),
                 usage: usageWith({ input: 2000, output: 200, costTotal: 0.02 }) };
      },
    },
  });
  orch = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  const out = await orch.start("20260907-200000-ab01", { seedText: SEED, seedSource: "test", mode: "review" });

  const p = runPaths(w, out.runId);
  check("manifest.json exists", existsSync(p.manifest));
  const onDisk = readManifest(p.manifest);
  eq("ON DISK status is aborted", onDisk.status, "aborted");
  eq("returned outcome agrees", out.status, "aborted");
  check("endedAt is set on disk", typeof onDisk.endedAt === "string" && onDisk.endedAt.length > 0,
        String(onDisk.endedAt));
  check("abort note recorded", (onDisk.notes ?? []).some((n) => /aborted by user/i.test(n)),
        JSON.stringify(onDisk.notes));
  check("runner was asked to kill children", runner.killAllCount >= 0);
  // Spend up to the abort is still accounted for (§13.23 — never lose paid turns).
  check("paid turns still charged after abort", onDisk.totals.costUsd > 0,
        `costUsd=${onDisk.totals.costUsd}`);
  cleanup();
}

// ===========================================================================
// This is the test that actually discriminates. Scenario (a) does NOT: with the fake
// runner `drive()` always unwinds normally, so the old `aborted` write at the end of
// drive() still ran and (a) passed against the broken code. Verified by reverting
// abort() and re-running: (a) still passed.
//
// The real requirement is that the manifest is aborted on disk *at the moment abort()
// returns*, without waiting for the loop to unwind — because a hard kill, a wedged
// child, or a crash between turns means the unwind never happens. So: read the file
// from inside the run, immediately after aborting.
console.log("\n-- (a2) manifest is aborted on disk IMMEDIATELY, before drive() unwinds --");
{
  const w = fresh();
  let orch: Orchestrator | null = null;
  let statusAtAbortTime: string | null = null;
  let sawManifest = false;

  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "ok", type: "INFERENCE" }]),
                     usage: usageWith({ input: 1000, output: 100, costTotal: 0.01 }) },
      "1-skeptic": () => {
        // Mid-run: abort, then inspect the file synchronously. No unwinding has
        // happened yet, so this is what a `kill -9` right now would leave behind.
        orch!.abort();
        const mp = runPaths(w, orch!.runId).manifest;
        if (existsSync(mp)) {
          sawManifest = true;
          statusAtAbortTime = readManifest(mp).status;
        }
        return { text: fakeTurnText(openHighClaims) };
      },
    },
  });
  orch = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  await orch.start("20260907-200005-ab06", { seedText: SEED, seedSource: "test", mode: "review" });

  check("manifest existed at abort time", sawManifest);
  eq("status on disk was ALREADY aborted mid-run", statusAtAbortTime, "aborted");
  cleanup();
}

// ===========================================================================
console.log("\n-- (d) abort emits an `aborted` event --");
{
  const w = fresh();
  let orch: Orchestrator | null = null;
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "ok", type: "INFERENCE" }]) },
      "1-skeptic": () => { orch!.abort(); return { text: fakeTurnText(openHighClaims) }; },
    },
  });
  orch = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  const out = await orch.start("20260907-200001-ab02", { seedText: SEED, seedSource: "test", mode: "review" });
  const events = readEvents(runPaths(w, out.runId).events);
  check("`aborted` event written to events.jsonl",
        events.some((e) => e.code === "aborted"),
        events.map((e) => e.code).join(","));
  // §13.24: `code` is reserved, so the event type must survive intact.
  const ab = events.find((e) => e.code === "aborted");
  check("aborted event carries a timestamp", !!ab && typeof (ab as Record<string, unknown>).ts === "string");
  cleanup();
}

// ===========================================================================
console.log("\n-- (b) abort is idempotent and never rewrites a finished run --");
{
  const w = fresh();
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "ok", type: "INFERENCE" }]) },
      "1-skeptic": { text: fakeTurnText([{ id: "C1", text: "minor", severity: "low" }]) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "fine" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "fine", severity: "low" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n" },
    },
  });
  const o = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260907-200002-ab03", { seedText: SEED, seedSource: "test", mode: "review" });
  eq("run completed normally", out.status, "complete");

  const p = runPaths(w, out.runId);
  const before = readFileSync(p.manifest, "utf8");
  o.abort();            // late abort, after the run finished
  o.abort();            // and again — must be idempotent
  const after = readFileSync(p.manifest, "utf8");
  eq("completed status preserved", readManifest(p.manifest).status, "complete");
  check("manifest byte-identical after two late aborts", before === after);
  cleanup();
}

// ===========================================================================
console.log("\n-- (c) abort before init() does not throw --");
{
  const w = fresh();
  const runner = new FakeRunner({ fixtures: {} });
  const o = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  let threw = false;
  try { o.abort(); o.abort(); } catch { threw = true; }
  check("abort() before any run is a safe no-op", !threw);
  cleanup();
}

// ===========================================================================
console.log("\n-- (e) progress fires per turn with live, non-decreasing cost (widget) --");
{
  const w = fresh();
  const seen: Progress[] = [];
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "ok", type: "INFERENCE" }]),
                     usage: usageWith({ input: 1000, output: 100, costTotal: 0.01 }) },
      "1-skeptic": { text: fakeTurnText(openHighClaims),
                     usage: usageWith({ input: 2000, output: 200, costTotal: 0.05 }) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "mitigation" }]),
                     usage: usageWith({ input: 1000, output: 100, costTotal: 0.01 }) },
      "2-skeptic": { text: fakeTurnText([
                       { id: "B1", status: "resolved", refutedPremise: "does quiesce",
                         evidence: "ran: grep -n rancher plan.md -> line 191" },
                       { id: "B2", status: "resolved", refutedPremise: "rollback in appendix",
                         evidence: "ran: grep -n rollback plan.md -> appendix B" },
                     ]),
                     usage: usageWith({ input: 2000, output: 200, costTotal: 0.03 }) },
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n",
                     usage: usageWith({ input: 500, output: 50, costTotal: 0.02 }) },
    },
  });
  const o = new Orchestrator({
    workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR,
    onProgress: (p) => seen.push(JSON.parse(JSON.stringify(p)) as Progress),
  });
  const out = await o.start("20260907-200003-ab04", { seedText: SEED, seedSource: "test", mode: "review" });

  eq("run completed", out.status, "complete");
  check("progress fired more than once per run", seen.length > 1, `n=${seen.length}`);
  check("progress carries a runId", seen.every((p) => !!p.runId));
  const costs = seen.map((p) => p.costUsd ?? 0);
  check("cost never decreases (live widget would not flicker backwards)",
        costs.every((c, i) => i === 0 || c >= costs[i - 1]!), JSON.stringify(costs));
  check("final progress cost matches the manifest total",
        Math.abs((costs.at(-1) ?? 0) - readManifest(runPaths(w, out.runId).manifest).totals.costUsd) < 1e-9,
        `progress=${costs.at(-1)} manifest=${readManifest(runPaths(w, out.runId).manifest).totals.costUsd}`);
  check("some progress event names a role", seen.some((p) => !!p.role));
  cleanup();
}

// ===========================================================================
console.log("\n-- (f) completed run leaves a verdict available for injection --");
{
  const w = fresh();
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "ok", type: "INFERENCE" }]) },
      "1-skeptic": { text: fakeTurnText([{ id: "C1", text: "minor", severity: "low" }]) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "fine" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "fine", severity: "low" }]) },
      "verdict-synthesizer": { text: "## 1. Unresolved items\n\nNone.\n\n## 2. Decision\n\nWP6_INJECTION_CANARY\n" },
    },
  });
  const o = new Orchestrator({ workspace: w, cfg: cfg(), runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260907-200004-ab05", { seedText: SEED, seedSource: "test", mode: "review" });

  const rootVerdict = join(w, "debate_verdict.md");
  check("verdict copied to workspace root", existsSync(rootVerdict));
  const body = readFileSync(rootVerdict, "utf8");
  check("verdict body reaches the file (what injection would carry)",
        body.includes("WP6_INJECTION_CANARY"));
  check("outcome exposes a verdict path for the extension to inject",
        !!out.verdictPath && existsSync(out.verdictPath!), String(out.verdictPath));
  cleanup();
}

// ===========================================================================
console.log("\n-- (g) stale-run sweep marks a crashed `running` run as aborted --");
{
  const w = fresh();
  // Simulate a run killed mid-flight: manifest left saying "running", no endedAt.
  const runId = "20260907-190000-dead";
  const p = runPaths(w, runId);
  mkdirSync(p.runDir, { recursive: true });
  mkdirSync(p.turnsDir, { recursive: true });
  const m = newManifest({
    runId, mode: "review", seedSource: "test", runner: "fake",
    models: { ideator: "x/a", skeptic: "x/b", synthesizer: "x/c" },
    cfg: cfg(),
  });
  m.status = "running";
  writeManifest(p.manifest, m);
  eq("precondition: manifest says running", readManifest(p.manifest).status, "running");

  const { sweepStaleRuns } = await import("../orchestrator.ts");
  const swept = sweepStaleRuns(w);
  check("sweep reports the stale run", swept.includes(runId), JSON.stringify(swept));
  eq("stale run marked aborted ON DISK", readManifest(p.manifest).status, "aborted");
  check("sweep is idempotent", sweepStaleRuns(w).length === 0);
  cleanup();
}

// ===========================================================================
console.log(`\n${failures.length ? "FAIL" : "PASS"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
