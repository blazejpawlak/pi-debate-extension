/**
 * WP7 acceptance — the publisher half (§11). No network, no tokens.
 *
 * §11's WP7 acceptance for the publisher: "one digest per merged ledger
 * (`send #debate "R2 · 3 open high · A1,B4,B7"`) with PI_AGENT_NAME=debate-orchestrator",
 * and "a down harness produce[s] readable errors and no partial state; the extension
 * never calls --start/--stop".
 *
 * The last clause is the one with teeth, and it is not hypothetical. Verified against the
 * installed 0.25.32 CLI on 2026-09-07:
 *   - `pi-messenger-swarm send` **auto-spawns a detached daemon** when the server is down
 *     (`spawnChild(..., {detached: true})` then polls 10s). Shelling out to it would start
 *     a harness the extension did not start — a direct D11 violation.
 *   - That failure path **exits 0**. A publisher trusting the exit code would report
 *     success while posting nothing.
 * Hence the publisher speaks HTTP and gates on GET /health. These tests assert that
 * contract, because a future "simplification" to `execFile("pi-messenger-swarm")` would
 * silently reintroduce both bugs.
 *
 * Scenarios:
 *  (a) digest shape matches §11's example
 *  (b) channel normalization: `dev`, `#dev`, `  #dev ` all target `#dev`
 *  (c) disabled config never touches the transport
 *  (d) harness down -> no post attempted, readable reason, no throw
 *  (e) healthy harness -> POST /action with the right body and x-agent-name
 *  (f) HTTP 500 and {ok:false} are both treated as failure, not success
 *  (g) transport throw / timeout is caught and reported
 *  (h) orchestrator emits `published` per merged ledger when enabled
 *  (i) orchestrator emits `publish_skipped` (not an error) when the harness is down
 *  (j) a wedged harness cannot fail or stall a run
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDigest, channelTarget, harnessIsUp, publishDigest,
  PUBLISHER_AGENT_NAME, HARNESS_BASE_URL,
} from "../publish.ts";
import { Orchestrator } from "../orchestrator.ts";
import { DEFAULTS, type DebateConfig } from "../config.ts";
import { FakeRunner, fakeTurnText } from "../runner/fake.ts";
import { readEvents } from "../manifest.ts";
import { runPaths } from "../paths.ts";
import { emptyLedger, mergeTurn, type Ledger } from "../ledger.ts";

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

const PERSONA_DIR = join(import.meta.dirname, "..", "personas");
const SEED = "# Plan\n\n## Implementation Phase 5\nQuiesce Docker Desktop and snapshot.\n";

function cfg(over: Partial<DebateConfig> = {}): DebateConfig {
  const base = JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig;
  return { ...base, ...over } as DebateConfig;
}

/** A ledger with `n` open high-severity claims, built through the real merge path. */
function ledgerWithOpenHigh(): Ledger {
  const merged = mergeTurn({
    ledger: emptyLedger("test-run", "review"),
    incoming: [
      { id: "C1", text: "Snapshot may be inconsistent", severity: "high", test: "tmutil", status: "open" },
      { id: "C2", text: "Casks unpinned", severity: "medium", test: "brew" },
      { id: "C3", text: "No rollback path", severity: "high", test: "read" },
    ] as never,
    round: 1, author: "B", role: "skeptic",
    freeAgreements: 1, minFlaws: 3, requireEvidenceForHigh: true,
  });
  return merged.ledger;
}

/** Records every request so tests can assert the exact wire contract. */
function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: string }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const { status, body = "" } = handler(String(url), init as RequestInit);
    return {
      status,
      text: async () => body,
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch: f, calls };
}

// ===========================================================================
console.log("\n-- (a) digest shape (§11's example) --");
{
  const l = ledgerWithOpenHigh();
  const d = buildDigest(2, l, "high");
  check("starts with the round label", d.startsWith("R2 · "), d);
  check("names the open high count", d.includes("2 open high"), d);
  check("lists claim ids", /B1|B3/.test(d), d);
  eq("verdict round is labelled `verdict`",
     buildDigest("verdict", emptyLedger("test-run", "review"), "high"), "verdict · 0 open high");
  // A long ledger must not produce an unreadable line.
  const big = emptyLedger("test-run", "review");
  big.claims = Array.from({ length: 20 }, (_, i) => ({
    id: `B${i + 1}`, text: "x", severity: "high", status: "open", author: "B",
    type: "CLAIM", confidence: 0.5, history: [],
  })) as never;
  const bigDigest = buildDigest(3, big, "high");
  check("caps the id list with a +N overflow marker", bigDigest.includes("+12"), bigDigest);
  check("digest stays short", bigDigest.length < 120, `len=${bigDigest.length}`);
}

// ===========================================================================
console.log("\n-- (b) channel normalization --");
{
  eq("bare name gets a #", channelTarget("debate"), "#debate");
  eq("already-# is unchanged", channelTarget("#debate"), "#debate");
  eq("whitespace trimmed", channelTarget("  #debate  "), "#debate");
  eq("double ## collapses", channelTarget("##debate"), "#debate");
}

// ===========================================================================
console.log("\n-- (c) disabled config never touches the transport --");
{
  const { fetch: f, calls } = stubFetch(() => ({ status: 200, body: '{"ok":true}' }));
  const out = await publishDigest({ enabled: false, channel: "debate" }, 1, emptyLedger("test-run", "review"), { fetch: f });
  check("not published", !out.published);
  eq("no requests made", calls.length, 0);
}

// ===========================================================================
console.log("\n-- (d) harness down: no post, readable reason, no throw (D11) --");
{
  // Health check fails exactly as a down daemon does.
  const { fetch: f, calls } = stubFetch((url) => {
    if (url.endsWith("/health")) throw new Error("ECONNREFUSED");
    return { status: 200, body: '{"ok":true}' };
  });
  const out = await publishDigest({ enabled: true, channel: "debate" }, 2, ledgerWithOpenHigh(), { fetch: f });
  check("not published", !out.published);
  check("reason mentions the harness is not running",
        !out.published && /not running/i.test(out.reason), JSON.stringify(out));
  check("reason cites D11 so nobody 'fixes' it by autostarting",
        !out.published && out.reason.includes("D11"), JSON.stringify(out));
  // The critical assertion: exactly one request, and it was the health probe.
  eq("only the health probe was attempted", calls.length, 1);
  check("that request was GET /health", calls[0]!.url.endsWith("/health"));
  check("no /action was posted", !calls.some((c) => c.url.endsWith("/action")));
  // The digest is still computed, so the caller can log what it would have sent.
  check("digest still returned for logging", !!out.message);
}
{
  const { fetch: f } = stubFetch(() => ({ status: 503 }));
  eq("non-200 health means down", await harnessIsUp({ fetch: f }), false);
}
{
  const { fetch: f } = stubFetch(() => ({ status: 200 }));
  eq("200 health means up", await harnessIsUp({ fetch: f }), true);
}

// ===========================================================================
console.log("\n-- (e) healthy harness: exact wire contract --");
{
  const { fetch: f, calls } = stubFetch((url) =>
    url.endsWith("/health") ? { status: 200 } : { status: 200, body: '{"ok":true,"result":{"text":"sent"}}' });
  const out = await publishDigest({ enabled: true, channel: "debate" }, 2, ledgerWithOpenHigh(), { fetch: f });
  check("published", out.published, JSON.stringify(out));
  eq("two requests: health then action", calls.length, 2);
  const post = calls[1]!;
  check("posts to /action", post.url.endsWith("/action"), post.url);
  eq("method is POST", post.init?.method, "POST");
  const headers = post.init?.headers as Record<string, string>;
  eq("identifies as the orchestrator (§11)", headers["x-agent-name"], PUBLISHER_AGENT_NAME);
  eq("agent name is the documented literal", PUBLISHER_AGENT_NAME, "debate-orchestrator");
  const body = JSON.parse(String(post.init?.body)) as { action: string; to: string; message: string };
  eq("action is send", body.action, "send");
  eq("target is the # channel, not a bare agent name", body.to, "#debate");
  check("message is the digest", body.message === out.message, `${body.message} vs ${out.message}`);
  eq("default base url is the harness singleton port", HARNESS_BASE_URL, "http://127.0.0.1:9877");
}

// ===========================================================================
console.log("\n-- (f) HTTP 500 and {ok:false} are both failures --");
{
  const { fetch: f } = stubFetch((url) =>
    url.endsWith("/health") ? { status: 200 } : { status: 500 });
  const out = await publishDigest({ enabled: true, channel: "debate" }, 1, emptyLedger("test-run", "review"), { fetch: f });
  check("HTTP 500 is not success", !out.published);
  check("reason names the status", !out.published && out.reason.includes("500"), JSON.stringify(out));
}
{
  // The harness answers 200 with {ok:false} for dispatch-level refusals.
  const { fetch: f } = stubFetch((url) =>
    url.endsWith("/health") ? { status: 200 } : { status: 200, body: '{"ok":false,"error":"not joined"}' });
  const out = await publishDigest({ enabled: true, channel: "debate" }, 1, emptyLedger("test-run", "review"), { fetch: f });
  check("200 with ok:false is NOT treated as published", !out.published, JSON.stringify(out));
  check("reason surfaces the harness error",
        !out.published && out.reason.includes("not joined"), JSON.stringify(out));
}
{
  // §13.47 — THE REAL SHAPE, and the one that fooled the first implementation.
  // Application failures come back as ok:TRUE with result.details.error. Observed live:
  // an unregistered publisher got this and the digest was silently dropped, while the
  // publisher reported published:true.
  const { fetch: f } = stubFetch((url) =>
    url.endsWith("/health") ? { status: 200 } : {
      status: 200,
      body: JSON.stringify({
        ok: true,
        result: {
          text: "Not registered. Use `pi-messenger-swarm join` to join the agent mesh first.",
          details: { mode: "error", error: "not_registered" },
        },
      }),
    });
  const out = await publishDigest({ enabled: true, channel: "debate" }, 1, emptyLedger("test-run", "review"), { fetch: f });
  check("ok:true + details.error is NOT published (§13.47)", !out.published, JSON.stringify(out));
  check("reason names not_registered",
        !out.published && out.reason.includes("not_registered"), JSON.stringify(out));
}
{
  // Same trap, different code: concurrency_limit / unknown_channel travel the same way.
  const { fetch: f } = stubFetch((url) =>
    url.endsWith("/health") ? { status: 200 } : {
      status: 200,
      body: JSON.stringify({ ok: true, result: { details: { mode: "error", error: "concurrency_limit" } } }),
    });
  const out = await publishDigest({ enabled: true, channel: "debate" }, 1, emptyLedger("test-run", "review"), { fetch: f });
  check("any details.error is a failure", !out.published, JSON.stringify(out));
}
{
  // And the happy path must still be recognized as success.
  const { fetch: f } = stubFetch((url) =>
    url.endsWith("/health") ? { status: 200 } : {
      status: 200,
      body: JSON.stringify({ ok: true, result: { text: "sent", details: { mode: "send" } } }),
    });
  const out = await publishDigest({ enabled: true, channel: "debate" }, 1, emptyLedger("test-run", "review"), { fetch: f });
  check("a real success is still published", out.published, JSON.stringify(out));
}

// ===========================================================================
console.log("\n-- (g) transport throw is caught --");
{
  const { fetch: f } = stubFetch((url) => {
    if (url.endsWith("/health")) return { status: 200 };
    throw new Error("socket hang up");
  });
  const out = await publishDigest({ enabled: true, channel: "debate" }, 1, emptyLedger("test-run", "review"), { fetch: f });
  check("not published", !out.published);
  check("reason names the transport error",
        !out.published && out.reason.includes("socket hang up"), JSON.stringify(out));
}

// ===========================================================================
console.log("\n-- (h) orchestrator publishes one digest per merged ledger --");
{
  const ws = mkdtempSync(join(tmpdir(), "debate-wp7-"));
  const posted: string[] = [];
  const { fetch: f } = stubFetch((url, init) => {
    if (url.endsWith("/health")) return { status: 200 };
    posted.push((JSON.parse(String(init?.body)) as { message: string }).message);
    return { status: 200, body: '{"ok":true}' };
  });
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "sound", type: "INFERENCE" }]) },
      "1-skeptic": { text: fakeTurnText([{ id: "C1", text: "risk", severity: "low", test: "x" }]) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "fine" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "fine", severity: "low" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n" },
    },
  });
  const o = new Orchestrator({
    workspace: ws, runner, personaDir: PERSONA_DIR,
    cfg: cfg({ publish: { enabled: true, channel: "debate" } }),
    publishDeps: { fetch: f },
  });
  const out = await o.start("20260907-220000-pub1", { seedText: SEED, seedSource: "test", mode: "review" });
  eq("run completed", out.status, "complete");

  const events = readEvents(runPaths(ws, out.runId).events);
  const published = events.filter((e) => e.code === "published");
  const merges = events.filter((e) => e.code === "merge");
  check("at least one digest published", published.length > 0,
        events.map((e) => e.code).join(","));
  // §11: "one digest per merged ledger", plus one for the verdict.
  eq("one digest per merge, plus the verdict", published.length, merges.length + 1);
  check("a verdict digest was posted", posted.some((m) => m.startsWith("verdict · ")), posted.join(" | "));
  check("round digests are labelled R1/R2", posted.some((m) => /^R[12] /.test(m)), posted.join(" | "));
  // Each round produces two merges; without the author they read as contradictory.
  check("digests name the author whose merge triggered them",
        posted.some((m) => /^R\d (ideator|skeptic) /.test(m)), posted.join(" | "));
  check("no publish_skipped when healthy", !events.some((e) => e.code === "publish_skipped"));
  rmSync(ws, { recursive: true, force: true });
}

// ===========================================================================
console.log("\n-- (i) harness down: run unaffected, skips recorded not errors --");
{
  const ws = mkdtempSync(join(tmpdir(), "debate-wp7b-"));
  const { fetch: f, calls } = stubFetch(() => { throw new Error("ECONNREFUSED"); });
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "sound", type: "INFERENCE" }]) },
      "1-skeptic": { text: fakeTurnText([{ id: "C1", text: "risk", severity: "low", test: "x" }]) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "fine" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "fine", severity: "low" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n" },
    },
  });
  const o = new Orchestrator({
    workspace: ws, runner, personaDir: PERSONA_DIR,
    cfg: cfg({ publish: { enabled: true, channel: "debate" } }),
    publishDeps: { fetch: f },
  });
  const out = await o.start("20260907-220001-pub2", { seedText: SEED, seedSource: "test", mode: "review" });

  eq("run still completes with a down harness", out.status, "complete");
  check("verdict still written", !!out.verdictPath);
  const events = readEvents(runPaths(ws, out.runId).events);
  check("skips recorded", events.some((e) => e.code === "publish_skipped"));
  check("no run_error from publishing", !events.some((e) => e.code === "run_error"),
        events.filter((e) => e.code === "run_error").map((e) => JSON.stringify(e)).join(";"));
  check("nothing was ever POSTed", !calls.some((c) => c.url.endsWith("/action")));
  rmSync(ws, { recursive: true, force: true });
}

// ===========================================================================
console.log("\n-- (j) a wedged harness cannot stall or fail a run --");
{
  const ws = mkdtempSync(join(tmpdir(), "debate-wp7c-"));
  // Health never resolves before the timeout: the publisher must give up, not hang.
  const f = (async (url: unknown, init?: unknown) => {
    const signal = (init as RequestInit | undefined)?.signal;
    return await new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      // Never resolves on its own.
    });
  }) as unknown as typeof globalThis.fetch;
  const runner = new FakeRunner({
    fixtures: {
      "1-ideator": { text: fakeTurnText([{ id: "C1", text: "sound", type: "INFERENCE" }]) },
      "1-skeptic": { text: fakeTurnText([{ id: "C1", text: "risk", severity: "low", test: "x" }]) },
      "2-ideator": { text: fakeTurnText([{ id: "C1", text: "fine" }]) },
      "2-skeptic": { text: fakeTurnText([{ id: "C1", text: "fine", severity: "low" }]) },
      "verdict-synthesizer": { text: "## 2. Decision\n\nproceed\n" },
    },
  });
  const t0 = Date.now();
  const o = new Orchestrator({
    workspace: ws, runner, personaDir: PERSONA_DIR,
    cfg: cfg({ publish: { enabled: true, channel: "debate" } }),
    publishDeps: { fetch: f, timeoutMs: 200 },
  });
  const out = await o.start("20260907-220002-pub3", { seedText: SEED, seedSource: "test", mode: "review" });
  const elapsed = Date.now() - t0;
  eq("run completes despite a wedged harness", out.status, "complete");
  check("run was not stalled for long", elapsed < 15000, `elapsed=${elapsed}ms`);
  const events = readEvents(runPaths(ws, out.runId).events);
  check("wedged harness recorded as skipped", events.some((e) => e.code === "publish_skipped"));
  rmSync(ws, { recursive: true, force: true });
}

// ===========================================================================
console.log(`\n${failures.length ? "FAIL" : "PASS"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
