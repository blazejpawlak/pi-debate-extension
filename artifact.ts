/**
 * Corrected-draft artifact generation.
 *
 * Debate is a review mechanism, not the deliverable. This module turns an eligible
 * review's source + evidence-backed ledger + verdict into a *human-review-only* draft.
 * It deliberately has no source-writing function: callers receive a string and must
 * choose a new output path.
 */

import { createHash } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import type { Claim, Ledger } from "./ledger.ts";

export interface ArtifactInput {
  runId: string;
  sourcePath: string;
  sourceText: string;
  verdict: string;
  ledger: Ledger;
  generatedAt: string;
}

export interface ArtifactProvenance {
  runId: string;
  sourcePath: string;
  sourceSha256: string;
  generatedAt: string;
  appliedClaimIds: string[];
  unresolvedClaimIds: string[];
  warning: string;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Sibling path; never the source path, even for extensionless files. */
export function correctedDraftPath(sourcePath: string, workspace: string): string {
  if (!sourcePath || !isAbsolute(sourcePath) || sourcePath === "inline" || sourcePath === "setup editor") {
    return join(workspace, "debate-corrected-draft.md");
  }
  const ext = extname(sourcePath);
  const stem = ext ? basename(sourcePath, ext) : basename(sourcePath);
  return join(dirname(sourcePath), `${stem}.debate-draft${ext || ".md"}`);
}

function claimLine(c: Claim): string {
  const evidence = c.evidence ? ` Evidence: ${c.evidence.slice(0, 700)}` : "";
  return `- ${c.id} [${c.severity}/${c.status}] ${c.text}${evidence}`;
}

/** Strict, document-only revision mission. Source itself is attached by the runner. */
export function buildArtifactMission(input: ArtifactInput): string {
  const claims = input.ledger.claims;
  const unresolved = claims.filter((c) => c.status !== "resolved" && c.status !== "withdrawn");
  const applied = claims.filter((c) => c.status === "resolved" || c.status === "disputed");
  return [
    "You are a careful technical document editor. Produce a corrected DRAFT of the attached source document.",
    "This is not an approval and must never claim that operational work was performed.",
    "",
    "OUTPUT CONTRACT (strict):",
    "- Output ONLY the complete revised document in Markdown. No analysis, no code fence, no preface.",
    "- Preserve all unaffected text, headings, ordering, commands, and details from the source.",
    "- Apply only corrections justified by the review evidence below. Do not invent paths, command output, facts, or completed work.",
    "- For an unresolved high/critical finding that cannot be safely corrected from evidence, keep the relevant source text and add a nearby",
    "  `> **DEBATE BLOCKER (claim ID):** ...` note stating the exact precondition needed. Do not make up a resolution.",
    "- Where you change content for a claim, add a concise HTML comment `<!-- debate: CLAIM-ID -->` next to that change.",
    "- The source is attached as a file. Read and revise it; do not summarize it.",
    "",
    `Review run: ${input.runId}`,
    `Source SHA-256: ${sha256(input.sourceText)}`,
    "",
    "VERDICT:",
    input.verdict.slice(0, 24_000),
    "",
    "CLAIMS (use their IDs exactly):",
    ...(claims.length ? claims.map(claimLine) : ["- No claims were recorded."]),
    "",
    `Resolved/disputed claim IDs: ${applied.map((c) => c.id).join(", ") || "none"}`,
    `Unresolved claim IDs: ${unresolved.map((c) => c.id).join(", ") || "none"}`,
  ].join("\n");
}

/** Reject obvious model chatter: a draft must be document content, not an answer about it. */
export function validateDraft(text: string, sourceText: string): string | null {
  const draft = text.trim();
  if (draft.length < 80) return "draft is too short to be a usable corrected document";
  if (draft.startsWith("```")) return "draft was wrapped in a code fence";
  if (/^(here(?:'s| is)|i (?:have|would)|the revised)/i.test(draft)) {
    return "draft starts with conversational model preface";
  }
  if (draft.length < sourceText.length * 0.25) {
    return "draft is implausibly short relative to the source; refusing a likely summary";
  }
  return null;
}

export function provenance(input: ArtifactInput): ArtifactProvenance {
  const unresolved = input.ledger.claims
    .filter((c) => c.status !== "resolved" && c.status !== "withdrawn")
    .map((c) => c.id);
  return {
    runId: input.runId,
    sourcePath: input.sourcePath,
    sourceSha256: sha256(input.sourceText),
    generatedAt: input.generatedAt,
    appliedClaimIds: input.ledger.claims
      .filter((c) => c.status === "resolved" || c.status === "disputed")
      .map((c) => c.id),
    unresolvedClaimIds: unresolved,
    warning: unresolved.length > 0
      ? "Draft contains unresolved review items. Human review is required before use."
      : "Human review is required before use.",
  };
}

export function draftHeader(p: ArtifactProvenance): string {
  return [
    "<!--",
    "  GENERATED DEBATE REVISION DRAFT — HUMAN REVIEW REQUIRED",
    `  Review run: ${p.runId}`,
    `  Source: ${p.sourcePath}`,
    `  Source SHA-256: ${p.sourceSha256}`,
    `  Applied/reviewed claim IDs: ${p.appliedClaimIds.join(", ") || "none"}`,
    `  Still unresolved: ${p.unresolvedClaimIds.join(", ") || "none"}`,
    "  This file never replaces the source automatically.",
    "-->",
    "",
  ].join("\n");
}
