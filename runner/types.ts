/**
 * runner/types.ts — the TurnRunner contract (§6.1), verbatim from the design plus the
 * WP0-driven additions noted below.
 */

import type { ThinkingLevel } from "../config.ts";

/** §7.2 Usage, as reported per assistant message by pi. */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export function emptyUsage(): Usage {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

export type Round = 1 | 2 | 3 | "verdict" | "artifact";
export type Role = "ideator" | "skeptic" | "synthesizer";

export interface TurnRequest {
  runId: string;
  round: Round;
  role: Role;
  personaPath: string;
  mission: string;
  cwd: string;
  tools: string[] | "none";
  thinking: ThinkingLevel;
  timeoutMs: number;
  signal: AbortSignal;
  /** Provider/model resolved by config.resolveRoleModel. */
  provider: string | null;
  model: string;
  /** File attached as `@path` (§6.2): seed for debaters, excerpts for the judge. */
  attachPath: string | null;
  /** Mid-turn kill thresholds (D9 + §13.19). 0/undefined disables. */
  perTurnUsd?: number;
  perTurnTokens?: number;
  /** Extra argv appended before `--` (config children.extraArgs). */
  extraArgs?: string[];
  contextFiles?: boolean;
}

export type TurnStatus = "ok" | "timeout" | "failed" | "aborted" | "costcap";

export interface TurnResult {
  /** Text blocks of the FINAL assistant message only (§7.1). */
  text: string;
  /** SUM over every ASSISTANT message in the turn (§7.1, §13.17). */
  usage: Usage | null;
  /** Assistant messages = provider requests in this turn. Excludes user/toolResult. */
  messageCount: number;
  toolCalls: { name: string; count: number }[];
  stopReason: string | null;
  status: TurnStatus;
  durationMs: number;
  exitCode: number | null;
  stderrTail: string;
  /**
   * WP0 addition (§13.14/§13.19): true when the turn reported tokens but zero cost,
   * meaning the provider has no price table and the USD cap cannot bind on it.
   */
  costUnreported?: boolean;
}

export interface TurnRunner {
  run(req: TurnRequest): Promise<TurnResult>;
  killAll(): Promise<void>;
}
