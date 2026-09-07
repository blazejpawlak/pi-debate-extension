/**
 * runner/fake.ts — scripted runner for tests (§3, §11: "use the fake runner everywhere
 * except WP0, WP4, WP5 and WP8").
 *
 * A fixture is looked up by `<round>-<role>` (e.g. "1-ideator", "verdict-synthesizer").
 * Fixtures may be a static TurnResult, a function of the request, or a queue consumed in
 * order for the same key (so a repair can differ from the original turn).
 */

import type { TurnRequest, TurnResult, TurnRunner, Usage } from "./types.ts";
import { emptyUsage } from "./types.ts";

export type FakeFixture =
  | Partial<TurnResult>
  | ((req: TurnRequest, callIndex: number) => Partial<TurnResult>);

export interface FakeRunnerOptions {
  fixtures: Record<string, FakeFixture | FakeFixture[]>;
  /** Fallback when no key matches. Default: a minimal valid ok turn with an empty ledger. */
  fallback?: FakeFixture;
  /** Simulated per-turn latency, so timeout logic is exercisable. */
  latencyMs?: number;
  onRun?: (req: TurnRequest) => void;
}

export function usageWith(over: Partial<Usage> & { costTotal?: number }): Usage {
  const u = emptyUsage();
  Object.assign(u, over);
  if (over.costTotal !== undefined) u.cost.total = over.costTotal;
  if (!u.totalTokens) u.totalTokens = u.input + u.output;
  return u;
}

/** A syntactically valid turn body: prose + exactly one ledger block. */
export function fakeTurnText(claims: unknown[], prose = "Analysis."): string {
  const fence = "```";
  return `${prose}\n\n${fence}ledger\n${JSON.stringify({ claims })}\n${fence}\n`;
}

export function key(round: TurnRequest["round"], role: TurnRequest["role"]): string {
  return `${round}-${role}`;
}

export class FakeRunner implements TurnRunner {
  /** Every request seen, in order — the primary assertion surface for WP3. */
  readonly calls: TurnRequest[] = [];
  killAllCount = 0;
  private counts = new Map<string, number>();

  constructor(private opts: FakeRunnerOptions) {}

  async run(req: TurnRequest): Promise<TurnResult> {
    this.calls.push(req);
    this.opts.onRun?.(req);

    const k = key(req.round, req.role);
    const n = this.counts.get(k) ?? 0;
    this.counts.set(k, n + 1);

    let fixture = this.opts.fixtures[k] ?? this.opts.fallback;
    if (Array.isArray(fixture)) {
      // Queue semantics: nth call to this key gets the nth entry; last entry repeats.
      fixture = fixture[Math.min(n, fixture.length - 1)];
    }

    const latency = this.opts.latencyMs ?? 0;
    if (latency > 0) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, latency);
        const onAbort = () => { clearTimeout(t); reject(new Error("aborted")); };
        if (req.signal.aborted) { onAbort(); return; }
        req.signal.addEventListener("abort", onAbort, { once: true });
      }).catch(() => {});
    }

    const partial: Partial<TurnResult> =
      typeof fixture === "function" ? fixture(req, n) : (fixture ?? {});

    const usage = partial.usage === undefined
      ? usageWith({ input: 1000, output: 200, costTotal: 0.01 })
      : partial.usage;

    const text = partial.text ?? fakeTurnText([]);
    const status = partial.status ?? "ok";

    return {
      text,
      usage,
      messageCount: partial.messageCount ?? 1,
      toolCalls: partial.toolCalls ?? [],
      stopReason: partial.stopReason ?? (status === "ok" ? "stop" : status),
      status,
      durationMs: partial.durationMs ?? latency,
      exitCode: partial.exitCode ?? (status === "ok" ? 0 : 1),
      stderrTail: partial.stderrTail ?? "",
      costUnreported: partial.costUnreported,
    };
  }

  async killAll(): Promise<void> {
    this.killAllCount++;
  }

  /** Turn keys in call order, e.g. ["1-ideator","1-skeptic","2-ideator",...]. */
  sequence(): string[] {
    return this.calls.map((c) => key(c.round, c.role));
  }
}
