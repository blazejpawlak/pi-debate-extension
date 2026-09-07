/**
 * manifest.ts — manifest.json (§8.6) and events.jsonl.
 *
 * `turns[].merged` is what makes resume safe (§8.6): the orchestrator appends a turn
 * record with merged:false BEFORE merging into the ledger, then flips it to true after
 * ledger.json is committed. A crash between the two leaves a completed turn on disk
 * that resume re-merges rather than re-paying for.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { DebateConfig } from "./config.ts";
import type { LintEntry } from "./ledger.ts";
import type { Round, Role, TurnStatus, Usage } from "./runner/types.ts";

export type RunStatus =
  | "running" | "complete" | "partial" | "aborted" | "failed";

export interface TurnRecord {
  round: Round;
  role: Role;
  status: TurnStatus;
  model: string;
  durationMs: number;
  usage: Usage | null;
  messageCount: number;
  toolCalls: { name: string; count: number }[];
  stopReason: string | null;
  /** §8.6: false until the turn's claims are committed to ledger.json. */
  merged: boolean;
  /** True when this role runs a model declared free (§13.29). */
  free?: boolean;
  /**
   * §13.38: last 2KB of the child's stderr, kept ONLY for failed/timeout/costcap turns.
   * The WP5 re-probe lost 5 turns to transient `stopReason: "error"` and the cause was
   * unrecoverable afterwards because this was discarded. Cheap to keep, and the only
   * way to tell a provider outage from a prompt defect once the run is over.
   */
  stderrTail?: string;
  /** Provider error text from the final assistant message, when present. */
  errorMessage?: string;
  /** Set when this turn was a repair of a previous invalid turn (§5.1). */
  repairOf?: string;
  /** True when the turn reported tokens but no cost (§13.14/§13.19). */
  costUnreported?: boolean;
}

export interface Manifest {
  runId: string;
  mode: string;
  startedAt: string;
  endedAt: string | null;
  status: RunStatus;
  seedSource: string;
  models: Record<string, string>;
  runner: string;
  rounds: number;
  turns: TurnRecord[];
  totals: {
    durationMs: number;
    tokens: number;
    costUsd: number;
    cacheReadTokens: number;
    messageCount: number;
  };
  budgets: DebateConfig["budget"];
  repairsUsed: number;
  configSnapshot: DebateConfig;
  resumedFrom?: string;
  /** False once any turn reports tokens with zero cost (§13.19). */
  costTrusted?: boolean;
  /** Aggregated lint, for the verdict's provenance section. */
  lint?: LintEntry[];
  /** Human-readable reasons the run stopped where it did. */
  notes?: string[];
}

export function newManifest(opts: {
  runId: string;
  mode: string;
  seedSource: string;
  models: Record<string, string>;
  runner: string;
  cfg: DebateConfig;
  resumedFrom?: string;
}): Manifest {
  return {
    runId: opts.runId,
    mode: opts.mode,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: "running",
    seedSource: opts.seedSource,
    models: opts.models,
    runner: opts.runner,
    rounds: 0,
    turns: [],
    totals: { durationMs: 0, tokens: 0, costUsd: 0, cacheReadTokens: 0, messageCount: 0 },
    budgets: opts.cfg.budget,
    repairsUsed: 0,
    configSnapshot: opts.cfg,
    ...(opts.resumedFrom ? { resumedFrom: opts.resumedFrom } : {}),
    costTrusted: true,
    lint: [],
    notes: [],
  };
}

/** Atomic write: a crash mid-write must not leave an unparseable manifest. */
export function writeManifest(path: string, m: Manifest): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(m, null, 2));
  renameSync(tmp, path);
}

export function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export function recomputeTotals(m: Manifest): void {
  let tokens = 0, cost = 0, cacheRead = 0, msgs = 0, ms = 0;
  for (const t of m.turns) {
    ms += t.durationMs;
    msgs += t.messageCount;
    if (t.usage) {
      tokens += t.usage.totalTokens;
      cost += t.usage.cost.total;
      cacheRead += t.usage.cacheRead;
    }
  }
  m.totals = {
    durationMs: ms, tokens, costUsd: cost, cacheReadTokens: cacheRead, messageCount: msgs,
  };
}

export interface DebateEvent {
  ts: string;
  code: string;
  [k: string]: unknown;
}

/**
 * Append one event. The `code` and `ts` fields are authoritative: a data key of the
 * same name is preserved under `data_code` / `data_ts` rather than overwriting the
 * event's identity. (A `code` collision here once made a whole event type invisible.)
 */
export function appendEvent(path: string, code: string, data: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    safe[k === "code" || k === "ts" ? `data_${k}` : k] = v;
  }
  const ev: DebateEvent = { ts: new Date().toISOString(), code, ...safe };
  appendFileSync(path, JSON.stringify(ev) + "\n");
}

export function readEvents(path: string): DebateEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => { try { return JSON.parse(l) as DebateEvent; } catch { return { ts: "", code: "unparseable" }; } });
}
