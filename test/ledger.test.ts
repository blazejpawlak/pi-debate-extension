/**
 * WP2 acceptance (§11): ledger.ts + excerpts.ts.
 *
 * Required coverage, verbatim from the work order:
 *   missing block · two blocks · invalid JSON · R1 parallel id collision (both emit C1,
 *   become A1/B1) · flip without refutedPremise (reverted) · second free agreement
 *   (reverted) · duplicate text lint · gate true/false · sourceRef by heading and by
 *   line range.
 *
 * No model calls.
 */

import {
  extractLedgerBlock, normalizeTurnPayload, mergeTurn, emptyLedger,
  gateWantsAnotherRound, anonymizeForJudge, anonymizeForDebater,
  similarity, statusCounts, openAtOrAbove,
  type Ledger, type IncomingClaim,
} from "../ledger.ts";
import { resolveSourceRef, mergeSpans, resolveAll, buildExcerpts } from "../excerpts.ts";
import { buildMission } from "../prompts.ts";
import { DEFAULTS as DEFAULTS_FOR_TEST } from "../config.ts";

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

const fence = "```";
const block = (json: string) => `${fence}ledger\n${json}\n${fence}`;

function merge(
  ledger: Ledger,
  incoming: IncomingClaim[],
  role: "ideator" | "skeptic",
  author: "A" | "B",
  round: number,
  opts: { freeAgreements?: number; minFlaws?: number } = {},
) {
  return mergeTurn({
    ledger, incoming, round, author, role,
    freeAgreements: opts.freeAgreements ?? 1,
    minFlaws: opts.minFlaws ?? 3,
  });
}

console.log("\n-- block extraction (§8.1) --");
{
  const r = extractLedgerBlock("prose only, no block here");
  check("missing block", !r.ok && r.code === "missing_block", JSON.stringify(r));
}
{
  const text = `intro\n${block('{"claims":[]}')}\nmiddle\n${block('{"claims":[]}')}\n`;
  const r = extractLedgerBlock(text);
  check("two blocks rejected", !r.ok && r.code === "multiple_blocks", JSON.stringify(r));
}
{
  const r = extractLedgerBlock(block("{not valid json,,}"));
  check("invalid JSON rejected", !r.ok && r.code === "invalid_json", JSON.stringify(r));
}
{
  const r = extractLedgerBlock(`Some prose.\n\n${block('{"claims":[{"id":"C1","text":"x"}]}')}\n\ntrailing prose`);
  check("valid block with surrounding prose", r.ok);
  if (r.ok) eq("payload parsed", normalizeTurnPayload(r.json).claims.length, 1);
}
{
  // Real models indent fences and emit CRLF. Both must still parse.
  const r = extractLedgerBlock(`text\r\n  ${fence}ledger  \r\n{"claims":[]}\r\n  ${fence}  \r\n`);
  check("indented + CRLF fence parses", r.ok, JSON.stringify(r));
}
{
  const r = extractLedgerBlock(block('[{"id":"C1","text":"bare array"}]'));
  check("bare array tolerated but flagged",
    r.ok && normalizeTurnPayload(r.json).problems.length === 1);
}

console.log("\n-- R1 parallel id collision: both emit C1 -> A1 / B1 (§8.1) --");
let led = emptyLedger("run1", "review");
{
  const ideator = merge(led, [
    { id: "C1", text: "Migration can be done in one weekend", type: "INFERENCE", confidence: 0.7 },
    { id: "C2", text: "Rancher Desktop replaces Docker Desktop cleanly", type: "FACT" },
  ], "ideator", "A", 1);
  led = ideator.ledger;
  eq("ideator C1 -> A1", ideator.idMap["C1"], "A1");
  eq("ideator C2 -> A2", ideator.idMap["C2"], "A2");

  const skeptic = merge(led, [
    { id: "C1", text: "Time Machine snapshot is inconsistent while Rancher runs", severity: "high", test: "tmutil compare" },
    { id: "C2", text: "Homebrew bundle omits cask versions", severity: "medium" },
    { id: "C3", text: "No rollback path documented for Phase 5", severity: "critical" },
  ], "skeptic", "B", 1);
  led = skeptic.ledger;
  eq("skeptic C1 -> B1 (no collision with A1)", skeptic.idMap["C1"], "B1");
  eq("skeptic C3 -> B3", skeptic.idMap["C3"], "B3");
  eq("5 distinct claims after R1", led.claims.length, 5);
  eq("ids are unique", new Set(led.claims.map((c) => c.id)).size, 5);
  eq("A1 still points at the ideator's claim",
    led.claims.find((c) => c.id === "A1")!.text.slice(0, 9), "Migration");
}

console.log("\n-- field permissions (§8.1) --");
{
  const r = merge(led, [{ id: "C9", text: "Ideator tries to set severity", severity: "critical" }], "ideator", "A", 1);
  const gid = r.idMap["C9"]!;
  eq("ideator-set severity defaults to medium", r.ledger.claims.find((c) => c.id === gid)!.severity, "medium");
  check("permission denial logged", r.events.some((e) => e.code === "field_permission_denied"));
}
{
  const r = merge(led, [{ id: "B1", test: "changed", severity: "low" }], "ideator", "A", 2);
  check("ideator cannot change severity of existing claim",
    r.ledger.claims.find((c) => c.id === "B1")!.severity === "high");
  check("ideator cannot set test",
    r.ledger.claims.find((c) => c.id === "B1")!.test === "tmutil compare");
  check("both denials logged",
    r.events.filter((e) => e.code === "field_permission_denied").length === 2);
}

console.log("\n-- flip discipline (§5.1) --");
{
  const bad = merge(led, [{ id: "B1", status: "resolved" }], "ideator", "A", 2);
  eq("flip without refutedPremise stays open",
    bad.ledger.claims.find((c) => c.id === "B1")!.status, "open");
  check("flip_rejected event emitted", bad.events.some((e) => e.code === "flip_rejected"));
  check("rejection recorded in history",
    bad.ledger.claims.find((c) => c.id === "B1")!.history.some((h) => h.change.includes("REJECTED")));

  const good = merge(led, [
    { id: "B1", status: "resolved", refutedPremise: "Phase 5 does quiesce Rancher; see line 212" },
  ], "ideator", "A", 2);
  eq("flip with refutedPremise is accepted",
    good.ledger.claims.find((c) => c.id === "B1")!.status, "resolved");
  check("no flip_rejected on the good path", !good.events.some((e) => e.code === "flip_rejected"));
  eq("refutedPremise stored in history",
    good.ledger.claims.find((c) => c.id === "B1")!.history.at(-1)!.refutedPremise,
    "Phase 5 does quiesce Rancher; see line 212");

  // open -> disputed is not a "flip" and needs no refutedPremise.
  const disp = merge(led, [{ id: "B1", status: "disputed" }], "ideator", "A", 2);
  eq("open->disputed allowed without refutedPremise",
    disp.ledger.claims.find((c) => c.id === "B1")!.status, "disputed");
}

console.log("\n-- agreement budget: second free agreement reverts (§5.1) --");
{
  // NOTE on rule ordering: §5.1's two rules compose in sequence. Flip discipline is the
  // hard gate - open->resolved is "accepted only when" refutedPremise is supplied, for
  // either author. The agreement budget then applies to flips that already passed it and
  // carry no new evidence. So a bare {status:"resolved"} is rejected by flip discipline
  // and never reaches the budget; to exercise the budget the concession must supply
  // refutedPremise but no evidence. (Recorded in §13 item 22.)
  const r = merge(led, [
    { id: "A1", status: "resolved", refutedPremise: "premise p1 refuted" },
    { id: "A2", status: "resolved", refutedPremise: "premise p2 refuted" },
    { id: "B2", status: "resolved", refutedPremise: "premise p3 refuted" },
  ], "skeptic", "B", 2, { freeAgreements: 1 });
  const resolved = ["A1", "A2", "B2"].filter(
    (id) => r.ledger.claims.find((c) => c.id === id)!.status === "resolved",
  );
  eq("only 1 free agreement is honored", resolved.length, 1);
  eq("first one wins", resolved[0], "A1");
  check("budget breach logged twice",
    r.events.filter((e) => e.code === "agreement_budget_exceeded").length === 2,
    JSON.stringify(r.events.map((e) => e.code)));
  check("reverted claims note the reason",
    r.ledger.claims.find((c) => c.id === "A2")!.history.at(-1)!.note === "agreement without evidence");

  // With evidence, a concession does not consume the budget.
  const withEv = merge(led, [
    { id: "A1", status: "resolved", refutedPremise: "p1", evidence: "ran tmutil compare; no drift" },
    { id: "A2", status: "resolved", refutedPremise: "p2", evidence: "brew bundle --describe shows versions" },
  ], "skeptic", "B", 2, { freeAgreements: 1 });
  eq("evidence-backed concessions both land",
    ["A1", "A2"].filter((id) => withEv.ledger.claims.find((c) => c.id === id)!.status === "resolved").length,
    2);
  check("no budget events when evidence is supplied",
    !withEv.events.some((e) => e.code === "agreement_budget_exceeded"));

  // Flip discipline still precedes the budget: no refutedPremise means rejection,
  // and the rejection must NOT be miscounted as an agreement.
  const bare = merge(led, [{ id: "A1", status: "resolved" }], "skeptic", "B", 2, { freeAgreements: 1 });
  eq("bare concession is rejected by flip discipline, not the budget",
    bare.events.map((e) => e.code), ["flip_rejected"]);
  eq("and the claim stays open",
    bare.ledger.claims.find((c) => c.id === "A1")!.status, "open");

  // The Ideator is not subject to the agreement budget - only the Skeptic is (§5.1).
  const ideatorMany = merge(led, [
    { id: "A1", status: "resolved", refutedPremise: "p1" },
    { id: "A2", status: "resolved", refutedPremise: "p2" },
  ], "ideator", "A", 2, { freeAgreements: 1 });
  eq("ideator concessions are not budget-limited",
    ["A1", "A2"].filter((id) => ideatorMany.ledger.claims.find((c) => c.id === id)!.status === "resolved").length,
    2);
}

console.log("\n-- lint (§5.1) --");
{
  const base = emptyLedger("r", "review");
  const first = merge(base, [{ id: "C1", text: "The Homebrew bundle omits cask version pins" }], "ideator", "A", 1);
  const dup = merge(first.ledger, [
    { id: "C1", text: "the homebrew bundle omits cask version pins!!" },
  ], "skeptic", "B", 1);
  check("duplicate text lint fires",
    dup.lint.some((l) => l.code === "duplicate_text"), JSON.stringify(dup.lint));

  const distinct = merge(first.ledger, [
    { id: "C1", text: "Completely unrelated concern about DNS resolution" },
  ], "skeptic", "B", 1);
  check("distinct text does not trip duplicate lint",
    !distinct.lint.some((l) => l.code === "duplicate_text"));

  check("similarity is order-insensitive", similarity("a b c d", "d c b a") === 1);
  check("similarity separates unrelated text", similarity("alpha beta", "gamma delta") === 0);

  const conf = merge(emptyLedger("r", "review"),
    [{ id: "C1", text: "High confidence, zero evidence", confidence: 0.95, evidence: "none" }],
    "ideator", "A", 1);
  check("conf_no_evidence lint fires", conf.lint.some((l) => l.code === "conf_no_evidence"));

  const lazy = merge(emptyLedger("r", "review"),
    [{ id: "C1", text: "only one flaw", severity: "high" }], "skeptic", "B", 1, { minFlaws: 3 });
  check("skeptic_under_min_flaws lint fires",
    lazy.lint.some((l) => l.code === "skeptic_under_min_flaws"));
  check("lint is persisted onto the ledger", lazy.ledger.lint.length > 0);
}

console.log("\n-- gate true/false (§5) --");
{
  const g = emptyLedger("g", "review");
  const r1 = merge(g, [
    { id: "C1", text: "critical unresolved thing", severity: "critical" },
    { id: "C2", text: "a medium thing", severity: "medium" },
    { id: "C3", text: "another concern entirely", severity: "high" },
  ], "skeptic", "B", 1);
  check("gate wants R3 while a high/critical claim is open",
    gateWantsAnotherRound(r1.ledger, "high"));
  eq("openAtOrAbove(high) counts 2", openAtOrAbove(r1.ledger, "high").length, 2);

  // Resolve both high+ claims with refutedPremise so the flips are accepted.
  // §13.34: `resolved` must ALSO carry evidence to count as settled - a resolution with
  // no evidence leaves the risk exactly where it was. `withdrawn` needs only the
  // refutedPremise, which is itself a substantive act.
  // §13.39: the Ideator may not write `evidence` onto the Skeptic's claim. The party that
  // can retire its own finding with evidence is the Skeptic, so the flip is authored by B.
  const r2 = merge(r1.ledger, [
    { id: "B1", status: "resolved", refutedPremise: "premise X refuted",
      evidence: "ran: grep -n barrier plan.md -> line 212 fences the write" },
    { id: "B3", status: "withdrawn", refutedPremise: "premise Y refuted" },
  ], "skeptic", "B", 2);
  check("gate closes once no high/critical claim is open",
    !gateWantsAnotherRound(r2.ledger, "high"));
  check("a still-open medium claim does not reopen the gate",
    r2.ledger.claims.find((c) => c.id === "B2")!.status === "open");
  eq("status counts", statusCounts(r2.ledger),
     { open: 1, resolved: 1, withdrawn: 1, disputed: 0 });

  // gateSeverity: critical should ignore an open high claim.
  const onlyHigh = merge(emptyLedger("x", "review"),
    [{ id: "C1", text: "high but not critical", severity: "high" }], "skeptic", "B", 1);
  check("gateSeverity=critical ignores an open high claim",
    !gateWantsAnotherRound(onlyHigh.ledger, "critical"));
  check("gateSeverity=high catches it", gateWantsAnotherRound(onlyHigh.ledger, "high"));
}

console.log("\n-- anonymization (§5.1) --");
{
  const a = emptyLedger("anon", "review");
  const m1 = merge(a, [{ id: "C1", text: "ideator claim" }], "ideator", "A", 1);
  const m2 = merge(m1.ledger, [{ id: "B9", text: "skeptic claim", severity: "high" }], "skeptic", "B", 1);
  const m3 = merge(m2.ledger, [{ id: "B1", status: "disputed" }], "ideator", "A", 2);

  const judge = JSON.stringify(anonymizeForJudge(m3.ledger));
  check("judge ledger has no author field", !judge.includes('"author"'), judge.slice(0, 200));
  check("judge ledger has no history.by", !judge.includes('"by"'));
  check("judge ledger keeps claim ids", judge.includes('"B1"'));
  check("judge ledger keeps evidence/severity", judge.includes('"severity"'));

  const deb = JSON.stringify(anonymizeForDebater(m3.ledger));
  check("debater ledger keeps A/B author", deb.includes('"author":"A"'));
  check("debater ledger keeps history.by", deb.includes('"by"'));
}

console.log("\n-- sourceRef by heading and by line range (§8.3) --");
const seed = [
  "# Migration Plan",            // 1
  "",                            // 2
  "Intro text.",                 // 3
  "",                            // 4
  "## Implementation Phase 5",   // 5
  "",                            // 6
  "Quiesce Docker Desktop.",     // 7
  "Take a Time Machine snapshot.",// 8
  "",                            // 9
  "## Implementation Phase 6",   // 10
  "",                            // 11
  "Verify checksums.",           // 12
].join("\n");
const seedLines = seed.split("\n");
{
  const r = resolveSourceRef("§Implementation Phase 5", seedLines);
  check("heading with § resolves", "span" in r, JSON.stringify(r));
  if ("span" in r) {
    eq("heading span starts at the heading line", r.span.start, 5);
    eq("heading span ends before the next same-level heading", r.span.end, 9);
  }
}
{
  const r = resolveSourceRef("Implementation Phase 6", seedLines);
  check("bare heading text resolves", "span" in r);
  if ("span" in r) eq("last section runs to EOF", r.span.end, 12);
}
{
  const r = resolveSourceRef("## implementation phase 5", seedLines);
  check("heading match is case- and hash-insensitive", "span" in r);
}
{
  const r = resolveSourceRef("L7-8", seedLines);
  check("line range resolves", "span" in r);
  if ("span" in r) { eq("range start", r.span.start, 7); eq("range end", r.span.end, 8); }
}
{
  const r = resolveSourceRef("L12", seedLines);
  check("single line resolves", "span" in r);
  if ("span" in r) eq("single line start==end", `${r.span.start}-${r.span.end}`, "12-12");
}
{
  const r = resolveSourceRef("L999-1000", seedLines);
  check("out-of-range line reports an error", "error" in r, JSON.stringify(r));
}
{
  const r = resolveSourceRef("§Nonexistent Section", seedLines);
  check("unmatched heading reports an error", "error" in r);
}
{
  const r = resolveSourceRef("lines 7-8", seedLines);
  check('"lines 7-8" form resolves', "span" in r);
}

console.log("\n-- span merging (§8.3) --");
{
  const merged = mergeSpans([
    { start: 1, end: 5, label: "a" },
    { start: 4, end: 8, label: "b" },
    { start: 20, end: 25, label: "c" },
  ]);
  eq("overlapping spans merge", merged.length, 2);
  eq("merged span covers the union", `${merged[0]!.start}-${merged[0]!.end}`, "1-8");
  check("merged labels are preserved", merged[0]!.label.includes("a") && merged[0]!.label.includes("b"));
  eq("adjacent-by-one spans merge", mergeSpans([
    { start: 1, end: 3, label: "x" }, { start: 4, end: 6, label: "y" },
  ]).length, 1);
  eq("distant spans stay separate", mergeSpans([
    { start: 1, end: 3, label: "x" }, { start: 10, end: 12, label: "y" },
  ]).length, 2);
}

console.log("\n-- buildExcerpts (§8.3) --");
{
  const b = buildExcerpts({
    seed,
    refs: ["§Implementation Phase 5", "L12", "§Ghost Section"],
    inlineFullSeedUnderChars: 40000,
  });
  check("excerpt markdown contains the cited section", b.markdown.includes("Quiesce Docker Desktop"));
  check("unresolved refs are reported to the judge", b.markdown.includes("Unresolved source references"));
  eq("one unresolved ref", b.unresolved.length, 1);
  check("small seed is inlined in full", b.inlinedFullSeed);
  check("full seed section present", b.markdown.includes("## Full seed"));

  const big = buildExcerpts({ seed, refs: ["§Implementation Phase 5"], inlineFullSeedUnderChars: 5 });
  check("large excerpts suppress the full-seed inline", !big.inlinedFullSeed);

  const none = buildExcerpts({ seed, refs: [], inlineFullSeedUnderChars: 40000 });
  check("no refs still produces usable judge input",
    none.markdown.includes("No claim cited a resolvable source location"));

  const dedup = resolveAll(["L7-8", "L7-8", "L8"], seed);
  eq("duplicate refs collapse to one span", dedup.spans.length, 1);
}

console.log("\n-- robustness: malformed model output must never throw --");
{
  const cases: unknown[] = [
    null, 42, "string", [], {}, { claims: null }, { claims: "no" },
    { claims: [null, 5, "x", {}] },
    { claims: [{ id: 1, text: 2, confidence: "high", severity: "SEVERE", status: "maybe" }] },
  ];
  let threw = false;
  for (const c of cases) {
    try {
      const p = normalizeTurnPayload(c);
      merge(emptyLedger("r", "review"), p.claims, "skeptic", "B", 1);
    } catch (e) { threw = true; console.log(`    threw on ${JSON.stringify(c)}: ${(e as Error).message}`); }
  }
  check("no malformed payload throws", !threw);

  // Out-of-vocabulary enum values must fall back, not corrupt the ledger.
  const weird = merge(emptyLedger("r", "review"), [
    { id: "C1", text: "weird enums", type: "GUESS", severity: "SEVERE", status: "maybe", confidence: 5 },
  ], "skeptic", "B", 1);
  const c = weird.ledger.claims[0]!;
  eq("bad type -> UNKNOWN", c.type, "UNKNOWN");
  eq("bad severity -> medium", c.severity, "medium");
  eq("bad status -> open", c.status, "open");
  eq("confidence clamped to [0,1]", c.confidence, 1);

  // A claim with no text cannot be stored - it would be unjudgeable.
  const noText = merge(emptyLedger("r", "review"), [{ id: "C1", severity: "high" }], "skeptic", "B", 1);
  eq("claim with no text is dropped", noText.ledger.claims.length, 0);
  check("drop is logged", noText.events.some((e) => e.code === "claim_missing_text"));

  // §8.1 unknown_id_as_new
  const unknown = merge(led, [{ id: "B99", text: "references a nonexistent id" }], "skeptic", "B", 2);
  check("unknown id in R2 becomes a new claim and is logged",
    unknown.events.some((e) => e.code === "unknown_id_as_new"));
}

console.log("\n-- merge purity: input ledger is never mutated --");
{
  const orig = emptyLedger("pure", "review");
  const m = merge(orig, [{ id: "C1", text: "added" }], "ideator", "A", 1);
  eq("original ledger untouched", orig.claims.length, 0);
  eq("original version untouched", orig.version, 0);
  eq("returned ledger has the claim", m.ledger.claims.length, 1);
  eq("version bumped on the copy", m.ledger.version, 1);
}



console.log("\n-- sourceRef forms models ACTUALLY emit (§13.32, observed live) --");
{
  // Use a seed long enough that the observed line numbers are in range; the point of
  // this block is FORM parsing, not range checking (covered separately below).
  const longSeed = [
    "# Plan", "",
    ...Array.from({ length: 70 }, (_, i) => `Line body ${i + 3}.`),
  ];
  longSeed[4] = "## Implementation Phase 5";
  longSeed[9] = "## Implementation Phase 6";

  const realRefs = [
    "L27–28 (TASK-025 description)",
    "TASK-032 (L43-44)",
    "L61 (TASK-038 description), L54 (TASK-035 description)",
    "L7–8",
    "line 12",
    "§Implementation Phase 5",
    '"Implementation Phase 6"',
    "Implementation Phase 5 (quiesce step)",
  ];
  let resolved = 0;
  for (const r of realRefs) {
    const out = resolveSourceRef(r, longSeed);
    if ("span" in out) resolved++;
    else console.log(`    unresolved: ${r} — ${out.error}`);
  }
  check("every realistic sourceRef form resolves", resolved === realRefs.length,
    `${resolved}/${realRefs.length}`);

  // en-dash range must give the same span as a hyphen range
  const dash = resolveSourceRef("L7–8", seedLines);
  const hyph = resolveSourceRef("L7-8", seedLines);
  check("en-dash and hyphen ranges agree",
    "span" in dash && "span" in hyph &&
    dash.span.start === hyph.span.start && dash.span.end === hyph.span.end);

  // A trailing annotation must not defeat heading matching.
  const annotated = resolveSourceRef("Implementation Phase 5 (quiesce step)", seedLines);
  check("heading with a trailing parenthetical resolves",
    "span" in annotated && annotated.span.start === 5,
    JSON.stringify(annotated));

  // Genuinely bogus refs must still be reported, not silently mapped somewhere.
  const bogus = resolveSourceRef("§Totally Absent Section", seedLines);
  check("a bogus heading still errors", "error" in bogus);
  const oor = resolveSourceRef("L9999", seedLines);
  check("an out-of-range line still errors", "error" in oor, JSON.stringify(oor));

  // The live failure mode: a ref that is BOTH a line range and names a section should
  // resolve via the range when in bounds, and fall back to the heading when not.
  const both = resolveSourceRef("Implementation Phase 5 (L9999)", seedLines);
  check("out-of-range line falls back to the heading",
    "span" in both && both.span.start === 5, JSON.stringify(both));

  // Observed live: models cite line numbers from the ORIGINAL document while the seed
  // is an extracted excerpt, so the range is out of bounds but the heading is correct.
  for (const combined of [
    "\u00a7Implementation Phase 5, L174-176 (TASK-026)",
    "\u00a7Implementation Phase 6, L212-214 (TASK-037)",
    "\u00a7Implementation Phase 5, L196-198 (TASK-033) and \u00a7Implementation Phase 7",
  ]) {
    const r = resolveSourceRef(combined, seedLines);
    check(`combined heading+out-of-range ref resolves via heading: ${combined.slice(0, 34)}`,
      "span" in r, JSON.stringify(r));
  }
  const nowhere = resolveSourceRef("\u00a7Nowhere At All, L999", seedLines);
  check("combined ref with a bogus heading AND bad line still errors", "error" in nowhere);
}

console.log("\n-- judge mission must inline the ledger (§13.31) --");
{
  const led = emptyLedger("jm", "review");
  const m1 = merge(led, [{ id: "C1", text: "ideator point", sourceRef: "§Implementation Phase 5" }], "ideator", "A", 1);
  const m2 = merge(m1.ledger, [{ id: "C1", text: "skeptic flaw", severity: "high", test: "t" }], "skeptic", "B", 1);
  const mission = buildMission({
    role: "synthesizer", mode: "review", round: "verdict",
    cfg: DEFAULTS_FOR_TEST, ledger: m2.ledger,
  });
  check("judge mission contains the claims", mission.includes("skeptic flaw"),
    mission.slice(0, 200));
  check("judge mission contains claim ids", mission.includes("B1"));
  check("judge mission does NOT reveal authorship", !mission.includes('"author"'));
  check("judge mission tells it the ledger is attached", /claim ledger/i.test(mission));

  const emptyMission = buildMission({
    role: "synthesizer", mode: "review", round: "verdict",
    cfg: DEFAULTS_FOR_TEST, ledger: emptyLedger("e", "review"),
  });
  check("empty ledger is stated explicitly rather than omitted",
    emptyMission.includes("ledger is empty"), emptyMission.slice(-300));
}

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
