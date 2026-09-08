/**
 * command.ts — pure argument/mode logic for `/debate` (§9.1, §2).
 *
 * Deliberately imports nothing from pi or typebox: those are supplied by pi's own
 * loader at runtime and are not resolvable under a bare `tsx` test run. Keeping this
 * logic host-free is what lets WP1..WP3 be tested without booting a session.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { DebateConfig, Mode } from "./config.ts";

export type ParsedCommand =
  | { kind: "run"; seed: string; seedFile: string | null; mode: Mode | null }
  | { kind: "status" }
  | { kind: "abort" }
  | { kind: "resume"; runId: string | null }
  | { kind: "last" }
  | { kind: "runs" }
  | { kind: "setup" }
  | { kind: "help" }
  | { kind: "error"; message: string };

const SUBCOMMANDS = ["status", "abort", "resume", "last", "runs", "setup", "help"] as const;

/**
 * Parse `/debate` arguments.
 *
 * Ordering rule: a token matching a subcommand counts as one only when it is FIRST.
 * `/debate status ...` is therefore always the status subcommand, never a seed
 * beginning with the word "status". Stated in the help text so it is not a surprise.
 */
export function parseCommand(argsRaw: string): ParsedCommand {
  const args = (argsRaw ?? "").trim();
  if (!args) return { kind: "help" };

  const tokens = args.split(/\s+/);
  const first = tokens[0]!.toLowerCase();

  if ((SUBCOMMANDS as readonly string[]).includes(first)) {
    switch (first) {
      case "status": return { kind: "status" };
      case "abort": return { kind: "abort" };
      case "last": return { kind: "last" };
      case "runs": return { kind: "runs" };
      case "setup": return { kind: "setup" };
      case "help": return { kind: "help" };
      case "resume": return { kind: "resume", runId: tokens[1] ?? null };
    }
  }

  let mode: Mode | null = null;
  const rest: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--mode") {
      const v = tokens[++i];
      if (v !== "review" && v !== "explore") {
        return {
          kind: "error",
          message: `--mode must be "review" or "explore" (got ${v ?? "nothing"})`,
        };
      }
      mode = v;
      continue;
    }
    const inline = t.match(/^--mode=(.+)$/);
    if (inline) {
      const v = inline[1];
      if (v !== "review" && v !== "explore") {
        return { kind: "error", message: `--mode must be "review" or "explore" (got ${v})` };
      }
      mode = v as Mode;
      continue;
    }
    rest.push(t);
  }

  if (rest.length === 0) {
    return { kind: "error", message: "nothing to debate: provide text or @path/to/file.md" };
  }
  if (rest[0]!.startsWith("@")) {
    return { kind: "run", seed: "", seedFile: rest[0]!.slice(1), mode };
  }
  return { kind: "run", seed: rest.join(" "), seedFile: null, mode };
}

/** §2: @file or inline text >= reviewThresholdChars -> review; else explore. Override wins. */
export function selectMode(
  cfg: DebateConfig,
  opts: { seed: string; seedFile: string | null; override: Mode | null },
): Mode {
  if (opts.override) return opts.override;
  if (opts.seedFile) return "review";
  return opts.seed.length >= cfg.mode.reviewThresholdChars ? "review" : "explore";
}

export function readSeedFile(cwd: string, p: string): { path: string; text: string } {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  if (!existsSync(abs)) throw new Error(`seed file not found: ${abs}`);
  return { path: abs, text: readFileSync(abs, "utf8") };
}

export const HELP_TEXT = [
  "/debate <text>              debate inline text (mode auto-selected)",
  "/debate @path/to/file.md    debate a file (review mode)",
  "/debate setup               guided setup: choose models, guardrails, and topic",
  "/debate --mode explore ...  force a mode",
  "/debate status              show progress of the active run",
  "/debate abort               kill children, mark aborted",
  "/debate resume <run-id>     continue a crashed run",
  "/debate last                print the last verdict summary",
  "/debate runs                list runs with status and cost",
  "",
  "Note: a first token matching a subcommand is always read as that subcommand.",
].join("\n");

/**
 * §13.51: dry-run plan + cost estimate. Lives here, not in index.ts, because index.ts
 * cannot be imported by tests (§13.21) — which is exactly why the original estimate
 * ("$3.50–$14.00" for a 211-char seed) shipped unnoticed.
 *
 * Estimates from MEASURED runs rather than §4.1's `turns × $0.50–2` guess:
 *   WP5 re-probe:  6.1KB seed, 3 rounds → $2.11 on paid models
 *   WP8:          51.8KB seed, 3 rounds → $0.00 on `tier: "ibm"`
 *
 * When every role sits on a provider with no price table, it reports $0.00 and says so,
 * instead of quoting dollars that cannot be charged and cannot be capped (§13.14/§13.19).
 */
export const NO_PRICE_TABLE_PROVIDERS = new Set(["ibm-services-essentials"]);

/** WP5 re-probe anchor: 6.1KB of seed, 3 rounds, $2.11 measured. */
const ANCHOR_USD = 2.11;
const ANCHOR_SEED_CHARS = 6100;
const ANCHOR_ROUNDS = 3;

export interface DryRunEstimate {
  turns: number;
  estLow: number;
  estHigh: number;
  /** True when no role can be billed, so a USD figure would be fiction. */
  billsNothing: boolean;
}

export function estimateRun(opts: {
  mode: Mode;
  rounds: number;
  seedChars: number;
  /** Resolved per-role provider ids, and whether each was declared free. */
  roles: { provider: string | null; free?: boolean }[];
}): DryRunEstimate {
  const turns = opts.mode === "review" ? 2 * opts.rounds + 1 : 2 * opts.rounds;
  const billsNothing =
    opts.roles.length > 0 &&
    opts.roles.every(
      (r) => r.free === true || NO_PRICE_TABLE_PROVIDERS.has(r.provider ?? ""),
    );
  if (billsNothing) return { turns, estLow: 0, estHigh: 0, billsNothing };
  // Floor the seed scale: a one-line idea still pays for 7 turns of overhead.
  const scale = Math.max(0.15, opts.seedChars / ANCHOR_SEED_CHARS);
  const mid = ANCHOR_USD * scale * (opts.rounds / ANCHOR_ROUNDS);
  return { turns, estLow: mid * 0.5, estHigh: mid * 2, billsNothing };
}
