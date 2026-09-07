/**
 * excerpts.ts — resolve claim `sourceRef`s into seed excerpts for the judge (§8.3).
 *
 * The Synthesizer has no tools, so this file is the only way it sees source text.
 * Supported sourceRef forms:
 *   §Heading text        - a markdown heading, matched loosely
 *   L189-205 / L189      - 1-based line range or single line
 *   "Heading" / Heading  - bare heading text
 * Overlapping spans are merged so the judge never reads the same lines twice.
 */

export interface Span {
  /** 1-based inclusive line numbers. */
  start: number;
  end: number;
  label: string;
}

export interface ResolveResult {
  spans: Span[];
  unresolved: { sourceRef: string; reason: string }[];
}

/** Context lines kept either side of a matched heading's section. */
const HEADING_TAIL_LIMIT = 80;

function normalizeHeading(s: string): string {
  return s
    .replace(/^#+\s*/, "")
    .replace(/[^a-z0-9 ]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Resolve one sourceRef against the seed's lines.
 * Returns null when the ref cannot be located.
 *
 * Models do NOT emit clean refs. Observed live (§13.32): `L27–28 (TASK-025 description)`,
 * `TASK-032 (L43-44)`, `L61 (TASK-038 description), L54 (TASK-035 description)`. So the
 * line-range form is matched ANYWHERE in the string, en/em dashes are accepted, and
 * trailing prose is ignored rather than causing a total miss.
 */
export function resolveSourceRef(
  ref: string,
  lines: string[],
): { span: Span } | { error: string } {
  const raw = ref.trim();
  if (!raw) return { error: "empty sourceRef" };

  // ---- line range, found anywhere in the string ----
  // Matches: L189-205 · L189–205 · L189 · lines 12-20 · line 7 · (L43-44)
  const range = raw.match(/(?:\bL|\blines?\s*)(\d+)\s*(?:[-–—]\s*(\d+))?/i);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : start;
    if (start >= 1 && start <= lines.length) {
      return {
        span: {
          start: Math.max(1, start),
          end: Math.min(lines.length, Math.max(start, end)),
          label: raw,
        },
      };
    }
    // Out of range: fall through to heading matching, since the ref may also name one.
    // Observed live (§13.32): models cite line numbers from the ORIGINAL document while
    // the seed is an extracted excerpt, so ranges are routinely out of bounds but the
    // accompanying §Heading is still correct and usable.
  }

  // ---- heading: §Foo, "Foo", ## Foo, or bare text ----
  // Models often combine forms: "§Implementation Phase 5, L174-176 (TASK-026)". Take the
  // text before the first comma, strip a leading §/#/quote, and drop any trailing
  // parenthetical or line-range annotation.
  const headingPart = raw.split(",")[0] ?? raw;
  const wanted = normalizeHeading(
    headingPart
      .replace(/^§\s*/, "")
      .replace(/^["']|["']$/g, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/\s*(?:\bL|\blines?\s*)\d+(?:\s*[-–—]\s*\d+)?\s*$/i, ""),
  );
  if (!wanted) {
    return {
      error: range
        ? `line ${Number(range[1])} out of range (seed has ${lines.length} lines)`
        : "sourceRef normalized to nothing",
    };
  }

  const headings: { line: number; level: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#{1,6})\s+(.*)$/);
    if (m) headings.push({ line: i + 1, level: m[1]!.length, text: normalizeHeading(m[2]!) });
  }

  // Exact, then prefix, then substring - most specific match wins.
  const hit =
    headings.find((h) => h.text === wanted) ??
    headings.find((h) => h.text.startsWith(wanted)) ??
    headings.find((h) => h.text.includes(wanted) || wanted.includes(h.text));

  if (!hit) {
    if (range) {
      return { error: `line ${Number(range[1])} out of range (seed has ${lines.length} lines)` };
    }
    return { error: `no heading matching "${raw}"` };
  }

  // Section runs to the next heading of the same or shallower level.
  let end = lines.length;
  for (const h of headings) {
    if (h.line > hit.line && h.level <= hit.level) { end = h.line - 1; break; }
  }
  const cappedEnd = Math.min(end, hit.line + HEADING_TAIL_LIMIT);
  return { span: { start: hit.line, end: cappedEnd, label: raw } };
}

/** Merge overlapping/adjacent spans, keeping all labels (§8.3 dedup). */
export function mergeSpans(spans: Span[]): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    // Merge when overlapping or separated by at most one line.
    if (last && s.start <= last.end + 1) {
      last.end = Math.max(last.end, s.end);
      if (!last.label.includes(s.label)) last.label += `, ${s.label}`;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export function resolveAll(refs: string[], seed: string): ResolveResult {
  const lines = seed.split("\n");
  const spans: Span[] = [];
  const unresolved: { sourceRef: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    const r = resolveSourceRef(ref, lines);
    if ("span" in r) spans.push(r.span);
    else unresolved.push({ sourceRef: ref, reason: r.error });
  }
  return { spans: mergeSpans(spans), unresolved };
}

/**
 * Build `judge/excerpts.md`. If the excerpts are small enough, §8.3 says to inline the
 * whole seed as well - a judge that can see everything is better than one reading
 * keyholes, and only the big-seed case needs the keyholes.
 */
export function buildExcerpts(opts: {
  seed: string;
  refs: string[];
  inlineFullSeedUnderChars: number;
}): { markdown: string; unresolved: { sourceRef: string; reason: string }[]; inlinedFullSeed: boolean } {
  const lines = opts.seed.split("\n");
  const { spans, unresolved } = resolveAll(opts.refs, opts.seed);

  const parts: string[] = ["# Seed excerpts", ""];
  if (spans.length === 0) {
    parts.push("_No claim cited a resolvable source location._", "");
  }
  let excerptChars = 0;
  for (const s of spans) {
    const body = lines.slice(s.start - 1, s.end).join("\n");
    excerptChars += body.length;
    parts.push(`## ${s.label}  (lines ${s.start}-${s.end})`, "", "```", body, "```", "");
  }

  if (unresolved.length > 0) {
    parts.push("## Unresolved source references", "");
    for (const u of unresolved) parts.push(`- \`${u.sourceRef}\` — ${u.reason}`);
    parts.push("");
  }

  // §8.3: inline the full seed when the excerpt total is under the threshold.
  const inlineFull = excerptChars < opts.inlineFullSeedUnderChars;
  if (inlineFull) {
    parts.push("## Full seed", "", "```", opts.seed, "```", "");
  }

  return { markdown: parts.join("\n"), unresolved, inlinedFullSeed: inlineFull };
}
