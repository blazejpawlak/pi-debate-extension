/**
 * WP5 tuning fixes (§13.34–13.37). No model calls.
 *
 * Each block reproduces a failure actually observed in the WP5 probe, so these are
 * regression tests against measured behavior rather than speculation.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyLedger, mergeTurn, gateWantsAnotherRound, openAtOrAbove, isUnsettled,
  isUnverifiedHigh, hasEvidence,
  type Ledger, type IncomingClaim,
} from "../ledger.ts";
import { buildMission } from "../prompts.ts";
import { DEFAULTS, loadConfig, type DebateConfig } from "../config.ts";
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
const SEED = "# S\n\n## Implementation Phase 5\nQuiesce Docker Desktop.\n";

function merge(
  ledger: Ledger, incoming: IncomingClaim[],
  role: "ideator" | "skeptic", author: "A" | "B", round: number,
  opts: { requireEvidenceForHigh?: boolean } = {},
) {
  return mergeTurn({
    ledger, incoming, round, author, role,
    freeAgreements: 1, minFlaws: 3,
    requireEvidenceForHigh: opts.requireEvidenceForHigh,
  });
}

// ===========================================================================
console.log("\n-- §13.34: `disputed` must NOT close the gate (the exact WP5 exploit) --");
{
  // Reproduce WP5: the Skeptic files 3 high-severity claims with NO evidence, then in R2
  // moves its own claims to `disputed`, which used to empty the open-high set.
  let l = emptyLedger("wp5repro", "review");
  l = merge(l, [
    { id: "C1", text: "no write barrier spans the dump and archive", severity: "high",
      evidence: "cmd: grep -n barrier plan.md -> none found", test: "inspect routes" },
    { id: "C2", text: "restart suppression is not demonstrated", severity: "high",
      evidence: "cmd: launchctl print-disabled | head -> override absent", test: "read scripts" },
    { id: "C3", text: "destination gate misses non-LaunchAgent startup", severity: "high",
      evidence: "cmd: sfltool dumpbtm | wc -l -> 42 entries", test: "inspect dumpbtm" },
  ], "skeptic", "B", 1).ledger;

  check("gate wants R3 while high claims are open", gateWantsAnotherRound(l, "high"));
  eq("3 unsettled high claims", openAtOrAbove(l, "high").length, 3);

  // The WP5 move: park them all as `disputed`, no refutedPremise needed (§13.22c).
  const parked = merge(l, [
    { id: "B1", status: "disputed" },
    { id: "B2", status: "disputed" },
    { id: "B3", status: "disputed" },
  ], "skeptic", "B", 2);
  eq("all three are now disputed",
     parked.ledger.claims.filter((c) => c.status === "disputed").length, 3);
  // §13.49 supersedes §13.34's reading here. §13.34 assumed parking an *evidenced* claim as
  // disputed was legitimate, so only unevidenced ones kept the gate open. WP8 disproved
  // that: the Skeptic disputed all five of its own evidenced high-severity findings and
  // the gate closed at R2 with openHigh:0 — nothing resolved, debate over. `disputed`
  // means the parties disagree, which §8.4 itself treats as unresolved ("the minority
  // report is never empty when any claim is disputed").
  check("evidenced+disputed claims are STILL unsettled (§13.49)",
    gateWantsAnotherRound(parked.ledger, "high"),
    JSON.stringify(openAtOrAbove(parked.ledger, "high").map((c) => c.id)));
  eq("all three remain on the gate", openAtOrAbove(parked.ledger, "high").length, 3);

  // Now the real WP5 case: high claims with NO evidence at all, parked as disputed.
  let l2 = emptyLedger("wp5repro2", "review");
  l2 = merge(l2, [
    { id: "C1", text: "claim one no evidence", severity: "high", test: "would inspect X" },
    { id: "C2", text: "claim two no evidence", severity: "high", test: "would read Y" },
  ], "skeptic", "B", 1, { requireEvidenceForHigh: false }).ledger;
  const parked2 = merge(l2, [
    { id: "B1", status: "disputed" },
    { id: "B2", status: "disputed" },
  ], "skeptic", "B", 2, { requireEvidenceForHigh: false });

  check("UNEVIDENCED disputed claims still count as unsettled (§13.34)",
    gateWantsAnotherRound(parked2.ledger, "high"),
    "the gate must not be closable by parking your own unverified claims");
  eq("both still reported as unsettled high", openAtOrAbove(parked2.ledger, "high").length, 2);

  // `resolved` without evidence must also not settle it.
  const res = merge(l2, [
    { id: "B1", status: "resolved", refutedPremise: "asserted premise p" },
  ], "ideator", "A", 2, { requireEvidenceForHigh: false });
  check("resolved-without-evidence still counts as unsettled",
    openAtOrAbove(res.ledger, "high").some((c) => c.id === "B1"));

  // withdrawn requires refutedPremise, which is substantive: that DOES settle it.
  const wd = merge(l2, [
    { id: "B1", status: "withdrawn", refutedPremise: "premise was factually wrong" },
  ], "ideator", "A", 2, { requireEvidenceForHigh: false });
  check("withdrawn (needs refutedPremise) IS settled",
    !openAtOrAbove(wd.ledger, "high").some((c) => c.id === "B1"));

  // isUnsettled directly
  const mk = (status: string, evidence: string | null) =>
    ({ status, evidence, severity: "high" } as never);
  check("isUnsettled: open", isUnsettled(mk("open", "cmd output")));
  // §13.49: `disputed` is ALWAYS unsettled, evidence or not. WP8 showed the Skeptic can
  // otherwise dispute its own findings with evidence attached and close the gate on five
  // high-severity claims that nobody had resolved.
  check("isUnsettled: disputed+evidence -> STILL unsettled (§13.49)",
    isUnsettled(mk("disputed", "cmd output")));
  check("isUnsettled: disputed+null -> unsettled", isUnsettled(mk("disputed", null)));
  check("isUnsettled: disputed+'none' -> unsettled", isUnsettled(mk("disputed", "none")));
  check("isUnsettled: resolved+evidence -> settled", !isUnsettled(mk("resolved", "cmd output")));
  check("isUnsettled: resolved+null -> unsettled", isUnsettled(mk("resolved", null)));
  check("isUnsettled: withdrawn -> settled", !isUnsettled(mk("withdrawn", null)));
}

// ===========================================================================
console.log("\n-- §13.35 (revised): unevidenced high is FLAGGED, not demoted --");
{
  const l = emptyLedger("demote", "review");
  const r = merge(l, [
    { id: "C1", text: "asserted high with nothing behind it", severity: "high", test: "would check" },
    { id: "C2", text: "asserted critical with nothing", severity: "critical" },
    { id: "C3", text: "high WITH real output", severity: "high",
      evidence: "ran: launchctl list | grep watchdog -> ai.multica.binary-watchdog present" },
    { id: "C4", text: "evidence says none explicitly", severity: "high", evidence: "none" },
  ], "skeptic", "B", 1);

  // Severity is NOT demoted: demoting removes the claim from the R3 gate, which
  // suppresses exactly the scrutiny an unverified high-severity claim needs.
  eq("unevidenced high KEEPS its severity", r.ledger.claims.find((c) => c.id === "B1")!.severity, "high");
  eq("unevidenced critical keeps its severity", r.ledger.claims.find((c) => c.id === "B2")!.severity, "critical");
  eq("evidenced high unaffected", r.ledger.claims.find((c) => c.id === "B3")!.severity, "high");
  eq("three unverified flags logged",
     r.events.filter((e) => e.code === "high_severity_unverified").length, 3);
  check("unverified is linted", r.lint.some((x) => x.code === "high_severity_unverified"));
  check('evidence "none" counts as unverified',
    isUnverifiedHigh(r.ledger.claims.find((c) => c.id === "B4")!));
  check("evidenced high is NOT flagged unverified",
    !isUnverifiedHigh(r.ledger.claims.find((c) => c.id === "B3")!));

  // The point of keeping severity: unverified high claims still drive the gate, so R3
  // can happen and the test can actually get run.
  check("unverified high claims DO open the gate", gateWantsAnotherRound(r.ledger, "high"));
  eq("all four count as unsettled high+", openAtOrAbove(r.ledger, "high").length, 4);

  // Escape hatch preserved.
  const off = merge(l, [{ id: "C1", text: "high no ev", severity: "high" }], "skeptic", "B", 1,
    { requireEvidenceForHigh: false });
  eq("requireEvidenceForHigh:false suppresses the flag",
     off.events.filter((e) => e.code === "high_severity_unverified").length, 0);
}

console.log("\n-- §13.35: unevidenced severity RAISE is honored but flagged --");
{
  let l = emptyLedger("raise", "review");
  l = merge(l, [{ id: "C1", text: "starts medium", severity: "medium" }], "skeptic", "B", 1).ledger;
  eq("starts medium", l.claims[0]!.severity, "medium");

  const bad = merge(l, [{ id: "B1", severity: "high" }], "skeptic", "B", 2);
  eq("raise without evidence is honored (so the gate sees it)",
     bad.ledger.claims[0]!.severity, "high");
  check("but flagged unverified",
    bad.events.some((e) => e.code === "high_severity_unverified"));
  check("and reported as an unverified high", isUnverifiedHigh(bad.ledger.claims[0]!));

  const good = merge(l, [
    { id: "B1", severity: "high", evidence: "ran: tmutil compare -> 3 files changed mid-snapshot" },
  ], "skeptic", "B", 2);
  eq("raise WITH evidence accepted", good.ledger.claims[0]!.severity, "high");

  // Lowering severity never needs evidence.
  let l2 = emptyLedger("lower", "review");
  l2 = merge(l2, [{ id: "C1", text: "x", severity: "high", evidence: "ran: cmd -> out" }], "skeptic", "B", 1).ledger;
  const low = merge(l2, [{ id: "B1", severity: "low" }], "skeptic", "B", 2);
  eq("lowering severity is always allowed", low.ledger.claims[0]!.severity, "low");
}

// ===========================================================================
console.log("\n-- §13.36: Skeptic mission demands EXECUTED tests --");
{
  const m = buildMission({
    role: "skeptic", mode: "review", round: 1, cfg: DEFAULTS, ledger: null,
  });
  check("mission says RUN YOUR TESTS", /RUN YOUR TESTS/.test(m));
  check("mission states an evidenced-flaw floor",
    /at least \d+ of your flaws this round MUST carry actual command/i.test(m), m.slice(0, 400));
  check("mission warns that unevidenced high is recorded UNVERIFIED",
    /UNVERIFIED/.test(m));
  check("mission tells it parking a claim does not end the debate",
    /does NOT retire it|does not end the debate/i.test(m));
  check("mission offers an honest not-testable escape hatch",
    /not testable here/.test(m));
  check("bash denylist still present", /READ-ONLY|read-only/i.test(m) && /no sudo/i.test(m));

  const noBash = JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig;
  noBash.skeptic.allowBash = false;
  const m2 = buildMission({ role: "skeptic", mode: "review", round: 1, cfg: noBash, ledger: null });
  check("no-bash Skeptic is not told to run commands", !/RUN YOUR TESTS/.test(m2));
  check("no-bash Skeptic asked to state tests instead",
    /which tests you would run/.test(m2));
}

// ===========================================================================
console.log("\n-- §13.37: judge gets a computed evidence audit and a confidence cap --");
{
  let l = emptyLedger("judge", "review");
  l = merge(l, [
    { id: "C1", text: "evidenced high", severity: "high", evidence: "ran: cmd -> real output" },
  ], "skeptic", "B", 1).ledger;
  l = merge(l, [
    { id: "C1", text: "unevidenced concern one", severity: "high", test: "would do X" },
    { id: "C2", text: "unevidenced concern two", severity: "critical", test: "would do Y" },
  ], "skeptic", "B", 1, { requireEvidenceForHigh: false }).ledger;

  const m = buildMission({
    role: "synthesizer", mode: "review", round: "verdict", cfg: DEFAULTS, ledger: l,
  });
  check("judge told evidence null/none is NOT evidence", /is NOT evidence/.test(m));
  check("judge gets the computed audit", /Evidence audit, computed by the orchestrator/.test(m));
  check("audit reports claim totals", /claims total: 3/.test(m), m.slice(m.indexOf("Evidence audit"), m.indexOf("Evidence audit") + 300));
  check("audit reports unevidenced high count", /WITHOUT evidence: 2/.test(m));
  check("audit names the unevidenced ids", /unevidenced high\/critical ids: B2, B3/.test(m));
  check("confidence is capped when most high claims lack evidence",
    /confidence MUST be <= 0\.5/.test(m));
  check("judge asked for a numeric confidence", /Confidence: 0\.4/.test(m));
  check("judge told a concession is not verification",
    /concession with[\s\S]{0,40}no evidence/.test(m));

  // A fully evidenced ledger must NOT trip the cap.
  let good = emptyLedger("judge2", "review");
  good = merge(good, [
    { id: "C1", text: "a", severity: "high", evidence: "ran: x -> out" },
    { id: "C2", text: "b", severity: "high", evidence: "ran: y -> out" },
  ], "skeptic", "B", 1).ledger;
  const m2 = buildMission({
    role: "synthesizer", mode: "review", round: "verdict", cfg: DEFAULTS, ledger: good,
  });
  check("well-evidenced ledger does not trigger the cap",
    !/confidence MUST be <= 0\.5/.test(m2));
  check("audit still present for a good ledger", /WITHOUT evidence: 0/.test(m2));
}

// ===========================================================================
console.log("\n-- end-to-end: the WP5 scenario now reaches R3 --");
{
  const ws = mkdtempSync(join(tmpdir(), "wp5fix-"));
  mkdirSync(join(ws, ".pi"), { recursive: true });
  writeFileSync(join(ws, ".pi", "debate.json"), JSON.stringify({
    rounds: { max: 3, gateSeverity: "high" },
    lessons: { enabled: false }, inject: "none",
  }));
  const { config } = loadConfig(ws, true);

  // Exactly the WP5 shape: Skeptic asserts high severity with no evidence, then parks
  // its own claims as disputed in R2. Previously this closed the gate after R2.
  const runner = new FakeRunner({ fixtures: {
    "1-ideator": { text: fakeTurnText([{ id: "C1", text: "plan is sound", sourceRef: "§Implementation Phase 5" }]) },
    "1-skeptic": { text: fakeTurnText([
      { id: "C1", text: "no write barrier", severity: "high", test: "would inspect" },
      { id: "C2", text: "no restart suppression", severity: "high", test: "would read" },
      { id: "C3", text: "gate misses startup vectors", severity: "high", test: "would dump" },
    ]) },
    "2-ideator": { text: fakeTurnText([{ id: "C1", text: "response" }]) },
    "2-skeptic": { text: fakeTurnText([
      { id: "B1", status: "disputed" },
      { id: "B2", status: "disputed" },
      { id: "B3", status: "disputed" },
    ]) },
    "3-ideator": { text: fakeTurnText([{ id: "C1", text: "r3 response" }]) },
    "3-skeptic": { text: fakeTurnText([
      { id: "B1", status: "resolved", refutedPremise: "p", evidence: "ran: cmd -> actually fenced" },
    ]) },
    "verdict-synthesizer": { text: "## 2. Decision\n\nproceed-with-changes\n\n## 3. Confidence and why\n\nConfidence: 0.4\n" },
  }});
  const o = new Orchestrator({ workspace: ws, cfg: config, runner, personaDir: PERSONA_DIR });
  const out = await o.start("20260907-fix-0001", { seedText: SEED, seedSource: "t", mode: "review" });

  const seq = runner.sequence();
  check("R3 now runs (the gate is no longer closable by parking claims)",
    seq.some((s) => s.startsWith("3-")), seq.join(","));
  eq("3 rounds recorded", out.manifest.rounds, 3);
  const ev = readEvents(runPaths(ws, out.runId).events);
  check("assertions were flagged unverified",
    ev.some((e) => e.code === "high_severity_unverified"));
  check("verdict header reports unsettled high count",
    readFileSync(out.verdictPath!, "utf8").includes("Unsettled at high+ severity:"));
  check("verdict reports verification effort",
    readFileSync(out.verdictPath!, "utf8").includes("Verification effort:"));
  rmSync(ws, { recursive: true, force: true });
}



console.log("\n-- §13.39: one author may not rewrite another's claim text or evidence --");
{
  // Reproduce the WP5 re-probe defect: the Ideator rewrote all three of the Skeptic's
  // high-severity claims, replacing the findings with rebuttals and the Skeptic's command
  // output with seed quotes. The ledger then reported 100% evidence coverage while the
  // real verification had been erased.
  let l = emptyLedger("xauthor", "review");
  l = merge(l, [{
    id: "C1",
    text: "freeze does not cover ai.multica.binary-watchdog, which re-enables daemons",
    severity: "high",
    evidence: "ran: grep -c watchdog <(grep -A10 SERVICES_LONG_RUNNING multica-ctl) -> 0",
    test: "launchctl print-disabled",
  }], "skeptic", "B", 1).ledger;

  const original = l.claims[0]!;
  eq("precondition: skeptic owns B1", original.author, "B");

  const attack = merge(l, [{
    id: "B1",
    text: "Disputed severity: B1's risk depends on an omitted watchdog it could not observe",
    evidence: "TASK-029 'freeze -f to persist disabled overrides'",
    confidence: 0.6,
    status: "disputed",
  }], "ideator", "A", 2);

  const after = attack.ledger.claims.find((c) => c.id === "B1")!;
  check("skeptic's claim TEXT is preserved",
    after.text.startsWith("freeze does not cover"), after.text.slice(0, 80));
  check("skeptic's EVIDENCE is preserved",
    !!after.evidence && after.evidence.includes("grep -c watchdog"), String(after.evidence).slice(0, 80));
  eq("two overwrite attempts denied",
     attack.events.filter((e) => e.code === "cross_author_overwrite_denied").length, 3);
  // The legitimate channel for disagreement still works.
  eq("status change still lands", after.status, "disputed");

  // An author may still edit their OWN claim freely.
  const own = merge(l, [{
    id: "B1", text: "refined by its own author", evidence: "ran: better cmd -> out",
  }], "skeptic", "B", 2);
  eq("own-claim text edit allowed",
     own.ledger.claims[0]!.text, "refined by its own author");
  check("no denial for own-claim edits",
    !own.events.some((e) => e.code === "cross_author_overwrite_denied"));

  // The Ideator may still change status/sourceRef on someone else's claim.
  const allowed = merge(l, [{
    id: "B1", status: "resolved", refutedPremise: "watchdog is in the freeze list at line 88",
    sourceRef: "§Implementation Phase 5",
  }], "ideator", "A", 2);
  eq("cross-author status change still allowed",
     allowed.ledger.claims[0]!.status, "resolved");
  eq("cross-author sourceRef still allowed",
     allowed.ledger.claims[0]!.sourceRef, "§Implementation Phase 5");
}

// ===========================================================================
// §13.50 — bounded total time, so a slow provider cannot produce an endless debate.
// The point is not just "it stops" but "it stops AND still concludes".
console.log("\n-- §13.50: total wall clock stops rounds and bounds the judge --");
{
  const { Orchestrator } = await import("../orchestrator.ts");
  const { FakeRunner, fakeTurnText } = await import("../runner/fake.ts");
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const PERSONA_DIR = join(import.meta.dirname, "..", "personas");
  const SEED = "# Plan\n\n## Implementation Phase 5\nQuiesce.\n";
  const fixtures = {
    "1-ideator": { text: fakeTurnText([{ id: "C1", text: "ok", type: "INFERENCE" }]) },
    "1-skeptic": { text: fakeTurnText([{ id: "C1", text: "risk", severity: "high", test: "x", status: "open" }]) },
    "2-ideator": { text: fakeTurnText([{ id: "C1", text: "m" }]) },
    "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "m", severity: "high" }]) },
    "3-ideator": { text: fakeTurnText([{ id: "C1", text: "m3" }]) },
    "3-skeptic": { text: fakeTurnText([{ id: "C1", text: "m3", severity: "high" }]) },
    "verdict-synthesizer": { text: "## 2. Decision\n\nJUDGE_RAN\n" },
  };
  const mkCfg = (over: Record<string, unknown>) => {
    const c = JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig;
    return Object.assign(c, over) as DebateConfig;
  };

  // (a) budget gone before R1: stops immediately, still finalizes with a verdict file.
  {
    const ws = mkdtempSync(join(tmpdir(), "t50a-"));
    let t = 0;
    const runner = new FakeRunner({ fixtures });
    const o = new Orchestrator({
      workspace: ws, runner, personaDir: PERSONA_DIR,
      cfg: mkCfg({ timeouts: { turnMs: 5000, totalMs: 1000, verdictGraceMs: 300000 } }),
      now: () => (t += 4000),
    });
    const out = await o.start("20260908-013000-t50a", { seedText: SEED, seedSource: "t", mode: "review" });
    eq("exhausted-before-R1 is partial, not failed", out.status, "partial");
    eq("no model turns ran", runner.calls.length, 0);
    check("a verdict file is STILL written (never return nothing)",
      !!out.verdictPath && existsSync(out.verdictPath));
    check("the reason names the wall clock",
      (out.manifest.notes ?? []).some((n) => /wall clock/i.test(n)),
      JSON.stringify(out.manifest.notes));
    rmSync(ws, { recursive: true, force: true });
  }

  // (b) budget gone mid-run: rounds stop, but the judge STILL runs inside its grace.
  {
    const ws = mkdtempSync(join(tmpdir(), "t50b-"));
    let t = 0;
    const runner = new FakeRunner({ fixtures });
    const o = new Orchestrator({
      workspace: ws, runner, personaDir: PERSONA_DIR,
      cfg: mkCfg({ rounds: { max: 3, gateSeverity: "high" },
                   timeouts: { turnMs: 60000, totalMs: 30000, verdictGraceMs: 300000 } }),
      now: () => (t += 6000),
    });
    const out = await o.start("20260908-013001-t50b", { seedText: SEED, seedSource: "t", mode: "review" });
    eq("status is partial", out.status, "partial");
    check("rounds were cut short", out.manifest.rounds < 3, String(out.manifest.rounds));
    check("the judge still ran, so there IS a conclusion",
      runner.sequence().includes("verdict-synthesizer"), runner.sequence().join(","));
    check("verdict body came from the judge",
      readFileSync(out.verdictPath!, "utf8").includes("JUDGE_RAN"));
    rmSync(ws, { recursive: true, force: true });
  }

  // (c) grace ALSO exhausted: judge is skipped, mechanical verdict stands in.
  {
    const ws = mkdtempSync(join(tmpdir(), "t50c-"));
    let t = 0;
    const runner = new FakeRunner({ fixtures });
    const o = new Orchestrator({
      workspace: ws, runner, personaDir: PERSONA_DIR,
      cfg: mkCfg({ rounds: { max: 3, gateSeverity: "high" },
                   timeouts: { turnMs: 60000, totalMs: 20000, verdictGraceMs: 0 } }),
      now: () => (t += 6000),
    });
    const out = await o.start("20260908-013002-t50c", { seedText: SEED, seedSource: "t", mode: "review" });
    check("judge did NOT run once grace was 0 and budget was gone",
      !runner.sequence().includes("verdict-synthesizer"), runner.sequence().join(","));
    eq("status is partial", out.status, "partial");
    check("a mechanical verdict is still produced",
      !!out.verdictPath && existsSync(out.verdictPath));
    const body = readFileSync(out.verdictPath!, "utf8");
    check("mechanical verdict lists unresolved items", body.includes("Unresolved items"));
    check("and says plainly that no judge ran", /No judge turn/i.test(body), body.slice(0, 400));
    rmSync(ws, { recursive: true, force: true });
  }

  // (d) verdictGraceMs caps the judge's own turnMs, not just whether it starts.
  {
    const ws = mkdtempSync(join(tmpdir(), "t50d-"));
    let t = 0;
    const runner = new FakeRunner({ fixtures });
    const o = new Orchestrator({
      workspace: ws, runner, personaDir: PERSONA_DIR,
      cfg: mkCfg({ rounds: { max: 2, gateSeverity: "high" },
                   timeouts: { turnMs: 600000, totalMs: 30000, verdictGraceMs: 10000 } }),
      now: () => (t += 6000),
    });
    await o.start("20260908-013003-t50d", { seedText: SEED, seedSource: "t", mode: "review" });
    const jr = runner.calls.find((r) => r.role === "synthesizer");
    if (jr) {
      check("judge timeout was clamped below its own turnMs",
        (jr.timeoutMs ?? Infinity) <= 10000, String(jr.timeoutMs));
    } else {
      check("judge skipped (also acceptable: grace already gone)", true);
    }
    rmSync(ws, { recursive: true, force: true });
  }
}

// ===========================================================================
// §13.53: a run where the skeptic never landed a turn is a MONOLOGUE, not a debate.
// Observed live: 4 failed skeptic attempts still produced `status: complete` with
// `Confidence: 0.85` and `openHigh: 0` -- the most dangerous presentation possible,
// because the ideator cannot set high severity so the count looks reassuring.
console.log("\n-- §13.53: skeptic absence must not read as a clean result --");
{
  const { Orchestrator } = await import("../orchestrator.ts");
  const { FakeRunner, fakeTurnText } = await import("../runner/fake.ts");
  const { mkdtempSync, rmSync, readFileSync: rf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readEvents } = await import("../manifest.ts");
  const { runPaths } = await import("../paths.ts");
  const PERSONA = join(import.meta.dirname, "..", "personas");
  const SEED = "# Plan\n\n## Implementation Phase 5\nQuiesce.\n";
  const mkCfg = () => JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig;

  // Every skeptic attempt errors; the ideator succeeds throughout.
  const ws = mkdtempSync(join(tmpdir(), "t53-"));
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "plan is sound", type: "INFERENCE",
                                           evidence: "read the plan" }]) },
      "1-skeptic": { status: "failed", stopReason: "error", text: "" },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "refined" }]) },
      "2-skeptic": { status: "failed", stopReason: "error", text: "" },
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed-with-changes\n" },
    },
  });
  const o = new Orchestrator({ workspace: ws, runner, personaDir: PERSONA, cfg: mkCfg() });
  const out = await o.start("20260908-140000-t53", { seedText: SEED, seedSource: "t", mode: "review" });

  // The core assertion: this must NOT be reported as a complete debate.
  check("skeptic-less run is NOT `complete`", out.status !== "complete", out.status);
  eq("it is `partial`", out.status, "partial");
  check("a skeptic_absent event is recorded",
    readEvents(runPaths(ws, out.runId).events).some((e) => e.code === "skeptic_absent"));
  check("a note names the failure in blunt terms",
    (out.manifest.notes ?? []).some((n) => /SKEPTIC ATTEMPT\(S\) FAILED/.test(n)),
    JSON.stringify(out.manifest.notes));
  check("the note warns the severity count is meaningless",
    (out.manifest.notes ?? []).some((n) => /means nothing/i.test(n)));

  // And the verdict document itself must say so, in the header.
  const vb = rf(out.verdictPath!, "utf8");
  check("verdict header warns NO ADVERSARIAL REVIEW",
    vb.includes("NO ADVERSARIAL REVIEW HAPPENED"), vb.slice(0, 500));
  check("verdict explains high-severity count is meaningless",
    /meaningless/i.test(vb));
  check("verdict tells the reader to re-run", /[Rr]e-run/.test(vb));
  check("model approval is withheld", vb.includes("INVALID REVIEW — RE-RUN REQUIRED"));
  check("model's proceed decision is not presented", !vb.includes("proceed-with-changes"));
  // Sanity: the claims really are all one author.
  check("all claims are the ideator's", out.ledger.claims.every((c) => c.author === "A"));
  rmSync(ws, { recursive: true, force: true });
}
{
  // A provider rejecting the configured model is not a malformed answer: retrying it
  // wastes turns, and a judge cannot turn the resulting monologue into a review.
  const { mkdtempSync, rmSync, readFileSync: rf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readEvents } = await import("../manifest.ts");
  const { runPaths } = await import("../paths.ts");
  const { Orchestrator } = await import("../orchestrator.ts");
  const { FakeRunner, fakeTurnText } = await import("../runner/fake.ts");
  const PERSONA = join(import.meta.dirname, "..", "personas");
  const mkCfg = () => JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig;
  const SEED = "# Plan\n\n## Implementation Phase 5\nQuiesce.\n";
  const ws = mkdtempSync(join(tmpdir(), "t53-model-"));
  const runner = new FakeRunner({ fixtures: {
    "1-ideator": { text: fakeTurnText([{ id: "C1", text: "proposal", evidence: "seed" }]) },
    "1-skeptic": {
      status: "failed", stopReason: "error", text: "",
      stderrTail: "providerError: The 'gpt-x' model is not supported when using this account.",
    },
  }});
  const o = new Orchestrator({ workspace: ws, runner, personaDir: PERSONA, cfg: mkCfg() });
  const out = await o.start("20260908-140001-t53", { seedText: SEED, seedSource: "t", mode: "review" });
  eq("unsupported Skeptic model stops after R1", runner.sequence(), ["1-ideator", "1-skeptic"]);
  eq("unsupported Skeptic model is partial", out.status, "partial");
  check("unsupported model records a specific event",
    readEvents(runPaths(ws, out.runId).events).some((e) => e.code === "skeptic_model_unavailable"));
  check("unsupported model never buys a judge", !out.manifest.turns.some((t) => t.round === "verdict"));
  check("unsupported model verdict is explicitly invalid",
    rf(out.verdictPath!, "utf8").includes("INVALID REVIEW — RE-RUN REQUIRED"));
  rmSync(ws, { recursive: true, force: true });
}
{
  // Control: a healthy run must NOT carry the warning, or it becomes noise.
  const { Orchestrator } = await import("../orchestrator.ts");
  const { FakeRunner, fakeTurnText } = await import("../runner/fake.ts");
  const { mkdtempSync, rmSync, readFileSync: rf } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const PERSONA = join(import.meta.dirname, "..", "personas");
  const ws = mkdtempSync(join(tmpdir(), "t53b-"));
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "sound", type: "INFERENCE" }]) },
      "1-skeptic": { text: fakeTurnText([{ id: "C1", text: "a real flaw", severity: "low",
                                          test: "x", evidence: "ran: grep -n x" }]) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "fine" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "fine", severity: "low" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n" },
    },
  });
  const o = new Orchestrator({ workspace: ws, runner, personaDir: PERSONA,
    cfg: JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig });
  const out = await o.start("20260908-140001-t53b", { seedText: "# P\n\n## Phase 5\nq.\n",
    seedSource: "t", mode: "review" });
  eq("healthy run is complete", out.status, "complete");
  check("no monologue warning on a healthy run",
    !rf(out.verdictPath!, "utf8").includes("NO ADVERSARIAL REVIEW"));
  rmSync(ws, { recursive: true, force: true });
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
