/**
 * publish.ts — optional swarm-channel digests (§11 WP7, second half).
 *
 * One short digest per merged ledger, so a debate run is visible in a
 * `pi-messenger-swarm` channel alongside other agents:
 *
 *     R2 · 3 open high · A1,B4,B7
 *
 * WHY THIS TALKS HTTP AND NOT THE CLI — this is the whole safety argument, do not
 * "simplify" it back to spawning the binary:
 *
 *   The `pi-messenger-swarm` CLI **auto-starts a detached daemon** when the server is
 *   down (`dist/harness/cli.js` spawns with `detached: true`, then polls for 10s). D11
 *   forbids starting a harness the extension did not start, so calling `send` blindly
 *   would violate it on any machine where the daemon happens to be down. Verified
 *   2026-09-07: with the server down, `pi-messenger-swarm send '#debate' probe` tried to
 *   spawn a server and printed "server failed to start".
 *
 *   Worse, that failure **exits 0**. A publisher that shelled out and trusted the exit
 *   code would silently report success while posting nothing.
 *
 * So: probe `GET /health` first, refuse if it is not up, and post to `/action` ourselves.
 * We never spawn anything. §6.4's rule — "preconditions checked, never fixed by the
 * extension" — applies to the publisher exactly as it does to the harness runner.
 *
 * D10/D9 note: publishing is strictly observational. It must never fail a run, never
 * throw into the orchestrator, and never consume the run's model budget.
 */

import type { Ledger } from "./ledger.ts";
import { openAtOrAbove } from "./ledger.ts";
import type { Round } from "./runner/types.ts";

/** Default harness endpoint. The daemon is a fixed-port singleton on :9877. */
export const HARNESS_BASE_URL = "http://127.0.0.1:9877";

/** §11: the publisher identifies itself as this agent, not as the user's session. */
export const PUBLISHER_AGENT_NAME = "debate-orchestrator";

export interface PublishConfig {
  enabled: boolean;
  /** Channel name, with or without a leading `#`. */
  channel: string;
}

export type PublishOutcome =
  | { published: true; message: string }
  | { published: false; reason: string; message?: string };

export interface PublishDeps {
  /** Injected so tests never touch the network. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  /** Per-request timeout. Kept short: a debate must not stall on a wedged daemon. */
  timeoutMs?: number;
  agentName?: string;
}

/**
 * Normalize a channel to the `#name` form the harness expects as a `send` target.
 *
 * `send` treats its first argument as an address, and a bare `dev` is a *direct message
 * to an agent named dev*, not the channel. Getting this wrong would silently unicast
 * digests into the void, so normalize rather than trusting config.
 */
export function channelTarget(channel: string): string {
  const trimmed = channel.trim().replace(/^#+/, "");
  return `#${trimmed}`;
}

/**
 * The digest line for a merged ledger, per §11's example shape.
 *
 * Deliberately terse: the harness prunes channel history (`feedRetention`), so a digest
 * competes for a small window with every other agent's traffic. Detail lives in the run
 * directory; this is a pointer, not a report.
 */
export function buildDigest(
  round: Round,
  ledger: Ledger,
  gateSeverity: "low" | "medium" | "high" | "critical" = "high",
  role?: string,
): string {
  const label = round === "verdict" ? "verdict" : `R${round}`;
  const open = openAtOrAbove(ledger, gateSeverity);
  // Name the author whose merge triggered this digest. Without it, consecutive digests
  // for the same round look contradictory: the ideator's merge legitimately reports 0
  // open high before the skeptic's claims land in the same round.
  const parts = [role ? `${label} ${role}` : label, `${open.length} open ${gateSeverity}`];
  if (open.length > 0) {
    // Cap the id list: a 20-claim ledger would otherwise produce an unreadable line.
    const ids = open.map((c) => c.id);
    const shown = ids.slice(0, 8);
    parts.push(shown.join(",") + (ids.length > shown.length ? `,+${ids.length - shown.length}` : ""));
  }
  return parts.join(" · ");
}

/** GET /health — the D11 gate. `false` for any non-200, timeout, or transport error. */
export async function harnessIsUp(deps: PublishDeps = {}): Promise<boolean> {
  const f = deps.fetch ?? globalThis.fetch;
  const base = deps.baseUrl ?? HARNESS_BASE_URL;
  const timeoutMs = deps.timeoutMs ?? 1500;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await f(`${base}/health`, { signal: ctl.signal });
      return res.status === 200;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Down, unreachable, or too slow. All three mean "do not publish", never "start it".
    return false;
  }
}

/**
 * Join the mesh as the publisher agent, creating the channel if needed.
 *
 * Required before `send`: the harness refuses posts from an unregistered agent with
 * `{ok:true, result:{details:{error:'not_registered'}}}` — a *success-shaped* refusal
 * that silently drops the message (§13.47). Registration is keyed on the `x-agent-name`
 * header and persisted in the harness registry, so this is idempotent across runs and a
 * second join is harmless.
 *
 * `create: true` because a `#debate` channel will not exist on a fresh machine, and a
 * digest posted to a non-existent channel is another silent drop.
 */
export async function joinChannel(
  cfg: PublishConfig,
  deps: PublishDeps = {},
): Promise<PublishOutcome> {
  const f = deps.fetch ?? globalThis.fetch;
  const base = deps.baseUrl ?? HARNESS_BASE_URL;
  const timeoutMs = deps.timeoutMs ?? 3000;
  const channel = channelTarget(cfg.channel).replace(/^#/, "");
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await f(`${base}/action`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-name": deps.agentName ?? PUBLISHER_AGENT_NAME,
        },
        body: JSON.stringify({ action: "join", channel, create: true }),
        signal: ctl.signal,
      });
      if (res.status !== 200) {
        return { published: false, reason: `join returned HTTP ${res.status}` };
      }
      const refusal = harnessRefusal(await res.text());
      return refusal
        ? { published: false, reason: `join refused: ${refusal}` }
        : { published: true, message: `joined #${channel}` };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return { published: false, reason: `join transport error: ${(e as Error).message}` };
  }
}

/**
 * Extract an application-level refusal from a 200 response, or null if it succeeded.
 *
 * Shared because BOTH shapes must be checked and getting it wrong is silent (§13.47):
 *   {ok:false, error}                                        — dispatch level
 *   {ok:true, result:{details:{mode:'error', error:'…'}}}     — application level
 */
function harnessRefusal(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as {
      ok?: boolean;
      error?: string;
      result?: { details?: { mode?: string; error?: string } };
    };
    if (parsed.ok === false) return parsed.error ?? "unknown error";
    const d = parsed.result?.details;
    if (d?.error) return d.error;
    if (d?.mode === "error") return "harness reported mode:error";
    return null;
  } catch {
    // Non-JSON 200: treat as delivered rather than inventing a failure.
    return null;
  }
}

/**
 * Post one digest. Returns a structured outcome instead of throwing: the caller is the
 * orchestrator's merge path, and a channel being down must never break a debate.
 */
export async function publishDigest(
  cfg: PublishConfig,
  round: Round,
  ledger: Ledger,
  deps: PublishDeps = {},
  gateSeverity: "low" | "medium" | "high" | "critical" = "high",
  role?: string,
): Promise<PublishOutcome> {
  if (!cfg.enabled) return { published: false, reason: "publish.enabled is false" };

  const message = buildDigest(round, ledger, gateSeverity, role);

  if (!(await harnessIsUp(deps))) {
    // Deliberately not an error the user must act on: publishing is optional, and the
    // daemon being down is the normal case on a machine that does not use the swarm.
    return {
      published: false,
      reason: "harness is not running (not started by this extension, per D11)",
      message,
    };
  }

  const f = deps.fetch ?? globalThis.fetch;
  const base = deps.baseUrl ?? HARNESS_BASE_URL;
  const timeoutMs = deps.timeoutMs ?? 3000;
  const post = async (): Promise<{ status: number; text: string } | { error: string }> => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await f(`${base}/action`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            // §11: publish as the orchestrator, not as whoever's session is running.
            "x-agent-name": deps.agentName ?? PUBLISHER_AGENT_NAME,
          },
          body: JSON.stringify({
            action: "send",
            to: channelTarget(cfg.channel),
            message,
          }),
          signal: ctl.signal,
        });
        return { status: res.status, text: await res.text() };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { error: (e as Error).message };
    }
  };

  let sent = await post();
  if ("error" in sent) {
    return { published: false, reason: `transport error: ${sent.error}`, message };
  }
  if (sent.status !== 200) {
    return { published: false, reason: `harness returned HTTP ${sent.status}`, message };
  }
  let refusal = harnessRefusal(sent.text);

  // Self-heal the one refusal we can fix: an unregistered publisher. Join once, then
  // retry exactly once. Not a loop — a persistent refusal must surface, not spin.
  if (refusal === "not_registered") {
    const joined = await joinChannel(cfg, deps);
    if (!joined.published) {
      return { published: false, reason: `not registered and ${joined.reason}`, message };
    }
    sent = await post();
    if ("error" in sent) {
      return { published: false, reason: `transport error after join: ${sent.error}`, message };
    }
    if (sent.status !== 200) {
      return { published: false, reason: `harness returned HTTP ${sent.status} after join`, message };
    }
    refusal = harnessRefusal(sent.text);
  }

  return refusal === null
    ? { published: true, message }
    : { published: false, reason: `harness refused: ${refusal}`, message };
}
