/**
 * verdict.ts — verdict assembly (§8.4), root copy, lessons append (§8.5).
 *
 * §5 VERDICT/FINAL: the Synthesizer returns verdict TEXT and writes nothing. The
 * orchestrator writes the file, prepends the header, and appends the cost/provenance
 * section, which is why §8.4 section 7 is "appended by the orchestrator, not the model".
 */

import { appendFileSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  statusCounts, openAtOrAbove, isUnverifiedHigh, SEVERITY_RANK, type Ledger,
} from "./ledger.ts";
import type { Manifest } from "./manifest.ts";

export interface VerdictBuildInput {
  runId: string;
  mode: string;
  status: string;
  rounds: number;
  ledger: Ledger;
  /** Raw text returned by the Synthesizer, or null if that turn never succeeded. */
  body: string | null;
  manifest: Manifest;
  /** Reasons the run ended early, surfaced in the header (§5.1 early-abort note). */
  notes?: string[];
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** §8.4 section 7, built from manifest.json — never from the model. */
export function costSection(m: Manifest): string {
  const lines: string[] = ["## 7. Cost and provenance", ""];
  lines.push("| round | role | model | status | ms | msgs | tokens | cost |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const t of m.turns) {
    const tok = t.usage?.totalTokens ?? 0;
    const cost = t.usage?.cost.total ?? 0;
    // §13.29: a free model's $0.0000 is correct, not a missing price table. Label it so
    // the two cases are distinguishable at a glance.
    const costCell = t.free ? "free" : t.costUnreported ? `${fmtUsd(cost)} (?)` : fmtUsd(cost);
    lines.push(
      `| ${t.round} | ${t.role} | ${t.model} | ${t.status} | ${t.durationMs} | ` +
      `${t.messageCount} | ${tok} | ${costCell} |`,
    );
  }
  lines.push("");
  const cacheRatio =
    m.totals.tokens > 0 ? (m.totals.cacheReadTokens / m.totals.tokens) * 100 : 0;
  lines.push(`- Run total: **${fmtUsd(m.totals.costUsd)}** over ${m.totals.tokens} tokens, ` +
             `${m.totals.messageCount} provider requests, ${(m.totals.durationMs / 1000).toFixed(1)}s`);
  lines.push(`- Cache read: ${m.totals.cacheReadTokens} tokens (${cacheRatio.toFixed(1)}% of total)`);
  lines.push(`- Runner: ${m.runner} · repairs used: ${m.repairsUsed}`);
  const freeTurns = m.turns.filter((t) => t.free).length;
  if (freeTurns > 0) {
    const freeTokens = m.turns
      .filter((t) => t.free)
      .reduce((n, t) => n + (t.usage?.totalTokens ?? 0), 0);
    lines.push(
      `- ${freeTurns} of ${m.turns.length} turns ran on models declared free ` +
      `(${freeTokens} tokens at no credit cost)`,
    );
  }
  if (m.costTrusted === false) {
    lines.push(
      `- **Cost figures are understated.** At least one turn reported tokens with ` +
      `cost.total = 0 (provider has no price table), so the dollar total above is a ` +
      `lower bound and the USD budget cap could not bind on those turns.`,
    );
  }
  const codes = new Map<string, number>();
  for (const l of m.lint ?? []) codes.set(l.code, (codes.get(l.code) ?? 0) + 1);
  if (codes.size > 0) {
    lines.push(`- Lint: ${[...codes].map(([c, n]) => `${c}×${n}`).join(", ")}`);
  }
  // §13.37: a run whose findings are unevidenced should say so where the cost is stated,
  // not only inside the ledger. WP5 produced 3 high-severity claims with evidence: null
  // and a verdict claiming confidence 0.9.
  const bash = m.turns.reduce(
    (n, t) => n + (t.toolCalls?.find((c) => c.name === "bash")?.count ?? 0), 0);
  lines.push(`- Verification effort: ${bash} bash invocation(s) across all turns`);
  return lines.join("\n");
}

/** Header + body + cost section. */
export function buildVerdict(input: VerdictBuildInput): string {
  const c = statusCounts(input.ledger);
  const n = input.ledger.claims.length;
  // §13.34: "unresolved" now means unsettled, which includes claims parked as disputed
  // without ever acquiring evidence. Report that count in the header so the summary and
  // the gate agree on what is outstanding.
  const unsettledHigh = openAtOrAbove(input.ledger, "high").length;
  // §13.35: high/critical claims that were asserted but never verified. Surfaced in the
  // header because WP5 shipped three of them under a "confidence 0.9" verdict.
  const unverifiedHigh = input.ledger.claims.filter(isUnverifiedHigh);
  const head: string[] = [
    `# Debate verdict — ${input.runId}`,
    `Mode: ${input.mode}   Status: ${input.status}   Rounds: ${input.rounds}`,
    `Claims: ${n} (open ${c.open} · disputed ${c.disputed} · resolved ${c.resolved} · withdrawn ${c.withdrawn})`,
    `Unsettled at high+ severity: ${unsettledHigh}` +
      (unverifiedHigh.length > 0
        ? `   (${unverifiedHigh.length} asserted without evidence: ${unverifiedHigh.map((c) => c.id).join(", ")})`
        : ""),
  ];
  // §13.53: a claim set with no author-B entries means the Skeptic never contributed,
  // so nothing was independently verified. Say so in the HEADER, not just the notes:
  // the numbers above look reassuring precisely because the Ideator cannot set `high`.
  const authors = new Set(input.ledger.claims.map((c) => c.author));
  if (input.ledger.claims.length > 0 && !authors.has("B")) {
    head.push(
      "",
      "> **NO ADVERSARIAL REVIEW HAPPENED.** Every claim below is the proposer's own; the",
      "> Skeptic contributed nothing, so nothing was independently verified and no claim",
      "> could be raised above medium severity. The high-severity count above is therefore",
      "> meaningless. Re-run before relying on this verdict.",
    );
  }
  if (input.notes && input.notes.length > 0) {
    head.push("");
    for (const note of input.notes) head.push(`> ${note}`);
  }
  head.push("");

  let body = input.body?.trim() ?? "";
  if (!body) {
    // No judge output: emit a mechanical stand-in rather than an empty file, so a
    // partial/failed run is still actionable.
    const open = openAtOrAbove(input.ledger, "low")
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
    const lines = [
      "## 1. Unresolved items (severity desc)",
      "",
      ...(open.length === 0
        ? ["_No open claims._"]
        : open.map((x) => `- **${x.id}** (${x.severity}) ${x.text}${x.test ? ` — test: ${x.test}` : ""}`)),
      "",
      "## 2. Decision",
      "",
      "_No judge turn completed; no decision was produced._",
      "",
      "## 3. Confidence and why",
      "",
      "_Not assessed._",
    ];
    body = lines.join("\n");
  }

  return [head.join("\n"), body, "", costSection(input.manifest), ""].join("\n");
}

/** Write the verdict and copy it to the workspace root (§3, D10). */
export function writeVerdict(
  turnPath: string,
  rootPath: string,
  content: string,
): void {
  writeFileSync(turnPath, content);
  copyFileSync(turnPath, rootPath);
}

/**
 * §8.5: append high/critical non-withdrawn claims to lessons.md, capped at maxLines
 * (oldest dropped).
 */
export function appendLessons(
  lessonsPath: string,
  runId: string,
  ledger: Ledger,
  maxLines: number,
): number {
  const keep = ledger.claims.filter(
    (c) => (c.severity === "high" || c.severity === "critical") && c.status !== "withdrawn",
  );
  if (keep.length === 0) return 0;

  const newLines = keep.map(
    (c) => `- [${runId}] ${c.text}${c.test ? ` — test: ${c.test}` : ""}`,
  );
  const existing = existsSync(lessonsPath)
    ? readFileSync(lessonsPath, "utf8").split("\n").filter((l) => l.trim() !== "")
    : [];
  const all = [...existing, ...newLines];
  const trimmed = all.slice(Math.max(0, all.length - maxLines));
  writeFileSync(lessonsPath, trimmed.join("\n") + "\n");
  return newLines.length;
}

/** ≤40-line summary injected into the pi session (§2, §9.3). */
export function buildSummary(input: {
  runId: string;
  mode: string;
  status: string;
  rounds: number;
  ledger: Ledger;
  verdictPath: string;
  costUsd: number;
  body: string | null;
  costTrusted?: boolean;
}): string {
  const c = statusCounts(input.ledger);
  const openHigh = openAtOrAbove(input.ledger, "high")
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  const lines: string[] = [
    `Debate ${input.runId} — ${input.mode}, ${input.status}, ${input.rounds} round(s)`,
    `Claims: ${input.ledger.claims.length} (open ${c.open} · disputed ${c.disputed} · resolved ${c.resolved} · withdrawn ${c.withdrawn})`,
    `Cost: $${input.costUsd.toFixed(4)}${input.costTrusted === false ? " (understated; a provider reported no cost)" : ""}`,
    `Verdict: ${input.verdictPath}`,
  ];

  if (openHigh.length > 0) {
    lines.push("", `Unresolved high-severity (${openHigh.length}):`);
    for (const x of openHigh.slice(0, 10)) {
      lines.push(`- ${x.id} (${x.severity}) ${x.text.slice(0, 140)}`);
    }
  } else {
    lines.push("", "No unresolved high-severity claims.");
  }

  // Pull the Decision section out of the judge's body if present.
  if (input.body) {
    const m = input.body.match(/##\s*2\.\s*Decision\s*\n+([\s\S]{0,400}?)(?=\n##|$)/);
    if (m) {
      const decision = m[1]!.trim().split("\n").slice(0, 4).join(" ").trim();
      if (decision) lines.push("", `Decision: ${decision.slice(0, 300)}`);
    }
  }

  return lines.slice(0, 40).join("\n");
}
