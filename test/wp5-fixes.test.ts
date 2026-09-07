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
  // Evidence WAS supplied on these claims, so parking them is legitimate.
  check("evidenced+disputed claims are genuinely settled",
    !gateWantsAnotherRound(parked.ledger, "high"),
    JSON.stringify(openAtOrAbove(parked.ledger, "high").map((c) => c.id)));

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
  check("isUnsettled: disputed+evidence -> settled", !isUnsettled(mk("disputed", "cmd output")));
  check("isUnsettled: disputed+null -> unsettled", isUnsettled(mk("disputed", null)));
  check("isUnsettled: disputed+'none' -> unsettled", isUnsettled(mk("disputed", "none")));
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

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
