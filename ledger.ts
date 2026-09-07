/**
 * ledger.ts — the claim ledger (§8.1): parse, validate, namespace ids, merge with
 * field permissions, enforce flip discipline and the agreement budget, lint, gate.
 *
 * This module is the enforcement point for §5.1: "orchestrator-enforced rules (never
 * left to prompts)". Every rule here is applied to model output that may be wrong,
 * truncated, adversarial, or simply lazy. It must never throw on bad input - it
 * reports problems as structured results the orchestrator can log and act on.
 */

import type { Severity } from "./config.ts";

export type ClaimType = "FACT" | "INFERENCE" | "ASSUMPTION" | "UNKNOWN";
export type ClaimStatus = "open" | "resolved" | "withdrawn" | "disputed";
export type Author = "A" | "B";

export const CLAIM_TYPES: ClaimType[] = ["FACT", "INFERENCE", "ASSUMPTION", "UNKNOWN"];
export const SEVERITIES: Severity[] = ["low", "medium", "high", "critical"];
export const STATUSES: ClaimStatus[] = ["open", "resolved", "withdrawn", "disputed"];

/** Severity ordering for the gate and for verdict sorting. */
export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0, medium: 1, high: 2, critical: 3,
};

export interface HistoryEntry {
  round: number;
  by: Author | null;
  change: string;
  refutedPremise?: string | null;
  note?: string | null;
}

export interface Claim {
  id: string;
  author: Author;
  round: number;
  type: ClaimType;
  text: string;
  sourceRef?: string | null;
  evidence?: string | null;
  confidence?: number | null;
  severity: Severity;
  status: ClaimStatus;
  test?: string | null;
  history: HistoryEntry[];
}

export interface LintEntry {
  round: number;
  code: string;
  claimId?: string;
  detail?: string;
}

export interface Ledger {
  runId: string;
  mode: string;
  /** Bumped on every successful merge. v1 after R1, v2 after R2, ... */
  version: number;
  claims: Claim[];
  lint: LintEntry[];
}

export function emptyLedger(runId: string, mode: string): Ledger {
  return { runId, mode, version: 0, claims: [], lint: [] };
}

// ---------------------------------------------------------------------------
// Block extraction (§8.1: "exactly one fenced ```ledger block")
// ---------------------------------------------------------------------------

export type BlockResult =
  | { ok: true; json: unknown; raw: string }
  | { ok: false; code: "missing_block" | "multiple_blocks" | "invalid_json"; detail: string };

/**
 * Extract the single ```ledger fenced block from turn text.
 *
 * Surrounding prose is tolerated; a second block is an error (§8.1) because we cannot
 * know which one the model meant and silently picking one would let a model smuggle
 * claims past the field-permission checks.
 */
export function extractLedgerBlock(text: string): BlockResult {
  // Match ```ledger ... ``` allowing a language tag with trailing spaces and CRLF.
  const re = /^[ \t]*```[ \t]*ledger[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1] ?? "");

  if (blocks.length === 0) {
    return {
      ok: false,
      code: "missing_block",
      detail: 'no fenced ```ledger block found; the turn must end with exactly one',
    };
  }
  if (blocks.length > 1) {
    return {
      ok: false,
      code: "multiple_blocks",
      detail: `found ${blocks.length} ledger blocks; emit exactly one`,
    };
  }
  const raw = blocks[0]!;
  try {
    return { ok: true, json: JSON.parse(raw), raw };
  } catch (e) {
    return { ok: false, code: "invalid_json", detail: `ledger block is not valid JSON: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Incoming claim normalization
// ---------------------------------------------------------------------------

/** A claim as emitted by a model: local id, arbitrary/missing fields. */
export interface IncomingClaim {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  sourceRef?: unknown;
  evidence?: unknown;
  confidence?: unknown;
  severity?: unknown;
  status?: unknown;
  test?: unknown;
  refutedPremise?: unknown;
  note?: unknown;
  [k: string]: unknown;
}

export interface ParsedTurn {
  claims: IncomingClaim[];
  /** Problems that did not prevent parsing. */
  problems: string[];
}

/** Pull `claims` out of a parsed ledger block, tolerating a bare array. */
export function normalizeTurnPayload(json: unknown): ParsedTurn {
  const problems: string[] = [];
  let arr: unknown;
  if (Array.isArray(json)) {
    arr = json;
    problems.push("ledger block was a bare array; expected {\"claims\":[...]}");
  } else if (json && typeof json === "object" && "claims" in (json as object)) {
    arr = (json as { claims: unknown }).claims;
  } else {
    return { claims: [], problems: ['ledger block has no "claims" key'] };
  }
  if (!Array.isArray(arr)) return { claims: [], problems: ['"claims" is not an array'] };

  const claims: IncomingClaim[] = [];
  for (const [i, c] of arr.entries()) {
    if (c && typeof c === "object" && !Array.isArray(c)) claims.push(c as IncomingClaim);
    else problems.push(`claims[${i}] is not an object; ignored`);
  }
  return { claims, problems };
}

function asStr(v: unknown): string | null {
  if (typeof v === "string") { const t = v.trim(); return t === "" ? null : t; }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function asType(v: unknown): ClaimType | null {
  const s = asStr(v)?.toUpperCase();
  return s && (CLAIM_TYPES as string[]).includes(s) ? (s as ClaimType) : null;
}

function asSeverity(v: unknown): Severity | null {
  const s = asStr(v)?.toLowerCase();
  return s && (SEVERITIES as string[]).includes(s) ? (s as Severity) : null;
}

function asStatus(v: unknown): ClaimStatus | null {
  const s = asStr(v)?.toLowerCase();
  return s && (STATUSES as string[]).includes(s) ? (s as ClaimStatus) : null;
}

function asConfidence(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * §8.1 field permissions. Ideator may not invent severity (only the Skeptic sets
 * high/critical, and therefore only the Skeptic can force R3 - §5.1).
 */
const IDEATOR_FIELDS = new Set(["text", "type", "evidence", "confidence", "sourceRef", "status"]);
// `text` and `type` added beyond §8.1's list so the Skeptic can refine its OWN claims
// (§13.39 then blocks it from touching anyone else's). Without `text` here the Skeptic
// could never correct its own wording, while the Ideator could rewrite it freely - the
// exact asymmetry that let the WP5 re-probe erase the Skeptic's findings.
const SKEPTIC_FIELDS = new Set([
  "severity", "status", "evidence", "test", "sourceRef", "text", "type", "confidence",
]);

/**
 * §13.39: fields nobody may overwrite on ANOTHER author's claim.
 *
 * §8.1 grants the Ideator `text` and `evidence` so it can improve its own claims. Applied
 * to the Skeptic's claims it is destructive: in the WP5 re-probe the Ideator rewrote all
 * three of the Skeptic's high-severity claims, replacing the findings with its own
 * rebuttals ("Disputed severity: B1's operational risk depends on...") and replacing the
 * Skeptic's command output with seed quotes. The ledger then showed 100% evidence
 * coverage while the actual verification had been erased, and the original finding
 * survived only in the archived turn file.
 *
 * A rebuttal belongs in `status` + `refutedPremise` + `history`, which is exactly what
 * the flip-discipline machinery is for. So: you may change these on your own claims, and
 * on someone else's you may not.
 */
const OWN_CLAIM_ONLY_FIELDS = new Set(["text", "evidence", "type", "confidence"]);

export interface MergeInput {
  ledger: Ledger;
  incoming: IncomingClaim[];
  round: number;
  author: Author;
  role: "ideator" | "skeptic";
  /** §5.1 agreement budget. */
  freeAgreements: number;
  /** §5.1 lint: Skeptic must produce this many new claims per round. */
  minFlaws: number;
  /** Duplicate-text similarity threshold (§5.1). */
  duplicateThreshold?: number;
  /**
   * §13.35 (WP5 fix): demote a NEW high/critical claim that carries no evidence to
   * `medium`, and record `severity_demoted_no_evidence`. Stops a Skeptic from driving the
   * R3 gate with assertions it never checked, which is what WP5 measured it doing.
   * The claim survives - only its severity is reduced until evidence arrives.
   */
  requireEvidenceForHigh?: boolean;
}

export interface MergeResult {
  ledger: Ledger;
  /** local id -> global id, for this turn (§8.1). */
  idMap: Record<string, string>;
  added: string[];
  updated: string[];
  /** Events for events.jsonl; codes match §5.1 / §8.1 vocabulary. */
  events: { code: string; claimId?: string; detail?: string }[];
  lint: LintEntry[];
}

/** Normalized text for duplicate detection. */
function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Token-level Jaccard similarity. §5.1 asks for "normalized similarity > 0.9";
 * Jaccard on word sets is order-insensitive, which is the right notion here because
 * a model restating a claim with reordered clauses is still a duplicate.
 */
export function similarity(a: string, b: string): number {
  const A = new Set(normText(a).split(" ").filter(Boolean));
  const B = new Set(normText(b).split(" ").filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Next free global id for an author, e.g. A1, A2, ... */
function nextId(ledger: Ledger, author: Author): string {
  let max = 0;
  for (const c of ledger.claims) {
    if (c.author !== author) continue;
    const n = Number(c.id.slice(1));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${author}${max + 1}`;
}

/**
 * Merge one turn's ledger block into the canonical ledger.
 *
 * Rules enforced here, all from §5.1/§8.1:
 *  - local ids are rewritten to <author><n>, so parallel R1 turns cannot collide
 *  - in R2+, an id that matches nothing is treated as a NEW claim (`unknown_id_as_new`)
 *  - a status flip open -> resolved/withdrawn requires refutedPremise, else reverted
 *  - the Skeptic gets `freeAgreements` evidence-free open->resolved flips per round
 *  - fields outside the role's permission set are ignored and logged
 */
export function mergeTurn(input: MergeInput): MergeResult {
  const { round, author, role, minFlaws } = input;
  const dupThreshold = input.duplicateThreshold ?? 0.9;
  // Deep clone so a rejected merge never half-mutates the caller's ledger.
  const ledger: Ledger = JSON.parse(JSON.stringify(input.ledger));
  const idMap: Record<string, string> = {};
  const added: string[] = [];
  const updated: string[] = [];
  const events: { code: string; claimId?: string; detail?: string }[] = [];
  const lint: LintEntry[] = [];

  const allowed = role === "ideator" ? IDEATOR_FIELDS : SKEPTIC_FIELDS;
  let agreementsUsed = 0;
  let newClaims = 0;

  for (const inc of input.incoming) {
    const localId = asStr(inc.id);
    const text = asStr(inc.text);

    // Does this reference an existing claim? Only exact global-id matches count.
    const existing = localId ? ledger.claims.find((c) => c.id === localId) : undefined;

    if (existing) {
      // ---------------- update path ----------------
      const changes: string[] = [];
      const refuted = asStr(inc.refutedPremise);
      const note = asStr(inc.note);

      for (const key of Object.keys(inc)) {
        if (["id", "refutedPremise", "note"].includes(key)) continue;
        if (!allowed.has(key)) {
          // Silently dropping would let the Ideator set severity and drive R3.
          events.push({
            code: "field_permission_denied",
            claimId: existing.id,
            detail: `${role} may not set "${key}"`,
          });
          continue;
        }
        // §13.39: never let one author rewrite another's claim text or evidence.
        if (existing.author !== author && OWN_CLAIM_ONLY_FIELDS.has(key)) {
          events.push({
            code: "cross_author_overwrite_denied",
            claimId: existing.id,
            detail:
              `${author} may not change "${key}" on ${existing.author}'s claim; ` +
              `argue via status + refutedPremise instead`,
          });
          continue;
        }

        switch (key) {
          case "status": {
            const next = asStatus(inc.status);
            if (!next || next === existing.status) break;
            const isFlip =
              existing.status === "open" && (next === "resolved" || next === "withdrawn");

            if (isFlip && !refuted) {
              // §5.1 flip discipline.
              events.push({
                code: "flip_rejected",
                claimId: existing.id,
                detail: `status ${existing.status}->${next} without refutedPremise; kept open`,
              });
              existing.history.push({
                round, by: author,
                change: `status ${existing.status}->${next} REJECTED`,
                refutedPremise: null,
                note: "flip without refutedPremise",
              });
              break;
            }

            // §5.1 agreement budget: Skeptic conceding without new evidence.
            const bringsEvidence = asStr(inc.evidence) !== null;
            if (
              role === "skeptic" && next === "resolved" &&
              existing.status === "open" && !bringsEvidence
            ) {
              agreementsUsed++;
              if (agreementsUsed > input.freeAgreements) {
                events.push({
                  code: "agreement_budget_exceeded",
                  claimId: existing.id,
                  detail: `agreement ${agreementsUsed} of ${input.freeAgreements} allowed; reverted to open`,
                });
                existing.history.push({
                  round, by: author,
                  change: `status open->resolved REVERTED`,
                  refutedPremise: refuted,
                  note: "agreement without evidence",
                });
                break;
              }
            }

            changes.push(`status ${existing.status}->${next}`);
            existing.status = next;
            break;
          }
          case "severity": {
            const next = asSeverity(inc.severity);
            if (next && next !== existing.severity) {
              // §13.35: raising to high/critical also needs evidence - either supplied now
              // or already on the claim. Otherwise a medium claim could be promoted to
              // high on a later turn to force R3 without ever running a test.
              const raising =
                SEVERITY_RANK[next] > SEVERITY_RANK[existing.severity] &&
                (next === "high" || next === "critical");
              const evNow = asStr(inc.evidence);
              const evHave = existing.evidence;
              const hasEv =
                (!!evNow && !/^none\b/i.test(evNow)) ||
                (!!evHave && !/^none\b/i.test(evHave));
              // Same reasoning as the add path: the raise is honored so the gate can see
              // it, but it is recorded as unverified rather than silently accepted.
              if (raising && input.requireEvidenceForHigh !== false && !hasEv) {
                events.push({
                  code: "high_severity_unverified",
                  claimId: existing.id,
                  detail: `raise ${existing.severity}->${next} with no evidence; marked unverified`,
                });
                lint.push({ round, code: "high_severity_unverified", claimId: existing.id });
              }
              changes.push(`severity ${existing.severity}->${next}`);
              existing.severity = next;
            }
            break;
          }
          case "type": {
            const next = asType(inc.type);
            if (next && next !== existing.type) {
              changes.push(`type ${existing.type}->${next}`);
              existing.type = next;
            }
            break;
          }
          case "confidence": {
            const next = asConfidence(inc.confidence);
            if (next !== null && next !== existing.confidence) {
              changes.push(`confidence ${existing.confidence}->${next}`);
              existing.confidence = next;
            }
            break;
          }
          case "text": {
            const next = asStr(inc.text);
            if (next && next !== existing.text) { changes.push("text"); existing.text = next; }
            break;
          }
          case "evidence": {
            const next = asStr(inc.evidence);
            if (next && next !== existing.evidence) { changes.push("evidence"); existing.evidence = next; }
            break;
          }
          case "test": {
            const next = asStr(inc.test);
            if (next && next !== existing.test) { changes.push("test"); existing.test = next; }
            break;
          }
          case "sourceRef": {
            const next = asStr(inc.sourceRef);
            if (next && next !== existing.sourceRef) { changes.push("sourceRef"); existing.sourceRef = next; }
            break;
          }
        }
      }

      if (changes.length > 0) {
        existing.history.push({
          round, by: author,
          change: changes.join("; "),
          refutedPremise: refuted,
          note,
        });
        updated.push(existing.id);
        idMap[localId!] = existing.id;
      }
      continue;
    }

    // ---------------- add path ----------------
    if (!text) {
      events.push({ code: "claim_missing_text", detail: `local id ${localId ?? "(none)"} has no text; ignored` });
      continue;
    }

    // §8.1: in R2+ an id that resolves to nothing becomes a new claim, and we log it -
    // it usually means the model invented or mangled an id.
    if (round > 1 && localId && /^[AB]\d+$/.test(localId)) {
      events.push({
        code: "unknown_id_as_new",
        detail: `referenced ${localId} which does not exist; treated as a new claim`,
      });
    }

    const gid = nextId(ledger, author);
    if (localId) idMap[localId] = gid;

    const severity: Severity = (role === "skeptic" ? asSeverity(inc.severity) : null) ?? "medium";
    const incomingEvidence = asStr(inc.evidence);
    const hasEvidence = !!incomingEvidence && !/^none\b/i.test(incomingEvidence);

    // §13.35 (revised): do NOT demote an unevidenced high/critical claim.
    //
    // Demotion was the first attempt and it is wrong: it removes the claim from the R3
    // gate, so the one mechanism that could have produced the missing verification never
    // fires. R3 exists to reduce uncertainty, and an unevidenced high-severity assertion
    // IS uncertainty. Inflating severity to force another round merely costs money (and
    // is bounded by rounds.max and the cost caps); parking claims to end the debate early
    // hides risk, which is strictly worse. So the asserted severity stands and drives the
    // gate, while the claim is marked UNVERIFIED everywhere it is reported: §13.34 keeps
    // it unsettled, §13.37 hands the judge a computed audit and caps its confidence, and
    // the verdict labels it. The incentive to actually run the test is preserved without
    // suppressing the scrutiny the claim asks for.
    if (
      input.requireEvidenceForHigh !== false &&
      (severity === "high" || severity === "critical") &&
      !hasEvidence
    ) {
      events.push({
        code: "high_severity_unverified",
        claimId: gid,
        detail: `${severity} asserted with no evidence; kept at ${severity} but marked unverified`,
      });
      lint.push({ round, code: "high_severity_unverified", claimId: gid });
    }

    const claim: Claim = {
      id: gid,
      author,
      round,
      type: asType(inc.type) ?? "UNKNOWN",
      text,
      sourceRef: asStr(inc.sourceRef),
      evidence: incomingEvidence,
      confidence: asConfidence(inc.confidence),
      severity,
      status: asStatus(inc.status) ?? "open",
      test: asStr(inc.test),
      history: [],
    };
    if (role === "ideator" && asSeverity(inc.severity)) {
      events.push({
        code: "field_permission_denied",
        claimId: gid,
        detail: "ideator may not set severity; defaulted to medium",
      });
    }
    ledger.claims.push(claim);
    added.push(gid);
    newClaims++;
  }

  // ---------------- lint (§5.1) ----------------
  for (const gid of added) {
    const c = ledger.claims.find((x) => x.id === gid)!;
    for (const other of ledger.claims) {
      if (other.id === gid) continue;
      if (similarity(c.text, other.text) > dupThreshold) {
        lint.push({ round, code: "duplicate_text", claimId: gid, detail: `similar to ${other.id}` });
        break;
      }
    }
  }
  for (const gid of [...added, ...updated]) {
    const c = ledger.claims.find((x) => x.id === gid);
    if (!c) continue;
    const noEvidence = !c.evidence || /^none\b/i.test(c.evidence);
    if ((c.confidence ?? 0) >= 0.8 && noEvidence) {
      lint.push({ round, code: "conf_no_evidence", claimId: gid });
    }
  }
  if (role === "skeptic" && newClaims < minFlaws) {
    lint.push({
      round, code: "skeptic_under_min_flaws",
      detail: `${newClaims} new claims, minimum ${minFlaws}`,
    });
  }

  ledger.lint.push(...lint);
  ledger.version += 1;
  return { ledger, idMap, added, updated, events, lint };
}

// ---------------------------------------------------------------------------
// Gate, anonymization, rendering
// ---------------------------------------------------------------------------

/**
 * Is this claim still "unsettled" for gate and reporting purposes?
 *
 * §13.34 (WP5 defect): a bare `status` check is gameable. §13.22c deliberately allows
 * `open -> disputed` with no `refutedPremise`, so in WP5 the Skeptic moved its own three
 * high-severity claims to `disputed`, emptied the open-high set, and closed the gate
 * before R3 - switching off the one mechanism meant to force more scrutiny of exactly
 * those claims, using a transition that requires no evidence at all.
 *
 * Fix: a claim that moved off `open` WITHOUT ever acquiring evidence is still counted as
 * unsettled. `withdrawn` is exempt because withdrawal requires `refutedPremise` (§5.1),
 * which is a substantive act; `resolved` with real evidence is likewise genuinely settled.
 */
/** Does this claim carry usable evidence? "none"/null/empty do not count. */
export function hasEvidence(c: Claim): boolean {
  return !!c.evidence && !/^none\b/i.test(c.evidence);
}

/**
 * A high/critical claim asserted without any evidence (§13.35). Reported as an open
 * question rather than a finding, everywhere it surfaces.
 */
export function isUnverifiedHigh(c: Claim): boolean {
  return (c.severity === "high" || c.severity === "critical") && !hasEvidence(c);
}

/**
 * Is this claim genuinely settled?
 *
 * §13.34 closed one hole here (disputed-without-evidence was treated as settled, letting
 * the Skeptic end a debate by parking its own findings). WP8 exposed the **complement**:
 * marking a claim `disputed` and *attaching evidence* also made it settled, so all five
 * high-severity findings dropped out of the gate and the debate stopped at R2 with
 * `openHigh: 0` while nothing had actually been resolved (§13.49).
 *
 * `disputed` means "the participants do not agree". That is unresolved BY DEFINITION,
 * evidence or not — §8.4 says so too: the minority report is "never empty when any claim
 * is `disputed`". So `disputed` is now always unsettled, and only `resolved` (with
 * evidence) or `withdrawn` closes a claim.
 */
export function isUnsettled(c: Claim): boolean {
  if (c.status === "open") return true;
  if (c.status === "withdrawn") return false;
  // Disagreement is not resolution, however well evidenced each side is.
  if (c.status === "disputed") return true;
  const hasEvidence = !!c.evidence && !/^none\b/i.test(c.evidence);
  if (hasEvidence) return false;
  // resolved but never evidenced -> the concern was never actually addressed.
  return true;
}

/**
 * §5 GATE: proceed to R3 only if some claim is still unsettled at or above gateSeverity.
 * Returns true when the debate should CONTINUE.
 */
export function gateWantsAnotherRound(ledger: Ledger, gateSeverity: Severity): boolean {
  const floor = SEVERITY_RANK[gateSeverity];
  return ledger.claims.some(
    (c) => isUnsettled(c) && SEVERITY_RANK[c.severity] >= floor,
  );
}

/**
 * Claims at or above `sev` that are not genuinely settled (§13.34). Used for the gate,
 * the widget, and the verdict's "unresolved items" section, so all three agree.
 */
export function openAtOrAbove(ledger: Ledger, sev: Severity): Claim[] {
  const floor = SEVERITY_RANK[sev];
  return ledger.claims.filter(
    (c) => isUnsettled(c) && SEVERITY_RANK[c.severity] >= floor,
  );
}

export function statusCounts(ledger: Ledger): Record<ClaimStatus, number> {
  const out: Record<ClaimStatus, number> = { open: 0, resolved: 0, withdrawn: 0, disputed: 0 };
  for (const c of ledger.claims) out[c.status]++;
  return out;
}

/**
 * §5.1: the Synthesizer sees neither author nor who changed what. Strip `author`
 * entirely and null out `history[].by` - do not merely rename, since "A"/"B" would
 * still let the judge cluster claims by voice.
 */
export function anonymizeForJudge(ledger: Ledger): unknown {
  return {
    runId: ledger.runId,
    mode: ledger.mode,
    version: ledger.version,
    claims: ledger.claims.map((c) => ({
      id: c.id,
      round: c.round,
      type: c.type,
      text: c.text,
      sourceRef: c.sourceRef ?? null,
      evidence: c.evidence ?? null,
      confidence: c.confidence ?? null,
      severity: c.severity,
      status: c.status,
      test: c.test ?? null,
      history: c.history.map((h) => ({
        round: h.round,
        change: h.change,
        refutedPremise: h.refutedPremise ?? null,
        note: h.note ?? null,
      })),
    })),
    lint: ledger.lint,
  };
}

/**
 * Ledger as shown to a debater in R2+ (§8.2): global ids, authors reduced to A/B,
 * and no prose from previous turns.
 */
export function anonymizeForDebater(ledger: Ledger): unknown {
  return {
    version: ledger.version,
    claims: ledger.claims.map((c) => ({
      id: c.id,
      author: c.author,
      round: c.round,
      type: c.type,
      text: c.text,
      sourceRef: c.sourceRef ?? null,
      evidence: c.evidence ?? null,
      confidence: c.confidence ?? null,
      severity: c.severity,
      status: c.status,
      test: c.test ?? null,
      history: c.history.map((h) => ({
        round: h.round, by: h.by, change: h.change,
        refutedPremise: h.refutedPremise ?? null,
      })),
    })),
  };
}

/** Claims changed or added since a given version, for the "diff since last round" block. */
export function claimsSinceRound(ledger: Ledger, round: number): Claim[] {
  return ledger.claims.filter(
    (c) => c.round >= round || c.history.some((h) => h.round >= round),
  );
}
