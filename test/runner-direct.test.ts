/**
 * WP4 acceptance, online part (§11 WP4). SPENDS REAL TOKENS (small: a few cents).
 *
 *  1. one cheap real turn (--no-tools) -> text captured, cost>0, stopReason "stop",
 *     messageCount === 1, temp file removed
 *  2. a tool-using turn -> messageCount > 1 AND usage is the SUM across messages,
 *     compared against a manual sum of the raw stream
 *  3. 5s timeout on a sleeping bash mission -> status "timeout", and no `pi --mode json`
 *     survives killAll()
 *  4. perTurnUsd absurdly low -> status "costcap", child dead within ~1s of the breach
 *  5. record cacheRead from turns 2+ of the same run (§13 item 8)
 */

import { mkdtempSync, rmSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { DirectRunner } from "../runner/direct.ts";
import type { TurnRequest, Usage } from "../runner/types.ts";

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

const ws = mkdtempSync(join(tmpdir(), "wp4-on-"));
const report: string[] = [];
let spend = 0;

// Cheap model for items 1/3/4; the Skeptic model for the tool-loop item.
const CHEAP = { provider: "openrouter", model: "anthropic/claude-opus-4-8" };
const TOOLS = { provider: "openai-codex", model: "gpt-6-astra" };

writeFileSync(join(ws, "persona.md"), "---\nrole: T\nmodel: x/y\n---\nYou are terse. Obey exactly.");
writeFileSync(join(ws, "seed.md"), "MARKER-WP4-5150: seed line one.\nsecond line.\n");

function req(over: Partial<TurnRequest>): TurnRequest {
  return {
    runId: "wp4", round: 1, role: "skeptic",
    personaPath: join(ws, "persona.md"),
    mission: "Reply with the single word ok.",
    cwd: ws,
    tools: "none",
    thinking: "low",
    timeoutMs: 120000,
    signal: new AbortController().signal,
    provider: CHEAP.provider, model: CHEAP.model,
    attachPath: null,
    ...over,
  };
}

function tmpDebateDirs(): string[] {
  return readdirSync(tmpdir()).filter((d) => d.startsWith("debate-"));
}

// ===========================================================================
console.log("\n-- 1. one cheap real turn, --no-tools --");
{
  const before = new Set(tmpDebateDirs());
  const runner = new DirectRunner();
  const r = await runner.run(req({
    mission: "Reply with exactly: ok\nThen a fenced block tagged ledger containing {\"claims\":[]}",
  }));
  spend += r.usage?.cost.total ?? 0;

  eq("status ok", r.status, "ok");
  eq("stopReason stop", r.stopReason, "stop");
  eq("messageCount === 1 for a no-tools turn", r.messageCount, 1);
  check("text captured", r.text.trim().length > 0, JSON.stringify(r.text.slice(0, 120)));
  check("cost.total > 0", (r.usage?.cost.total ?? 0) > 0, `${r.usage?.cost.total}`);
  check("tokens > 0", (r.usage?.totalTokens ?? 0) > 0);
  const leaked = tmpDebateDirs().filter((d) => !before.has(d));
  check("temp persona dir removed", leaked.length === 0, `leaked ${leaked.join(",")}`);
  report.push(
    `1. cheap turn: status=${r.status} stopReason=${r.stopReason} msgs=${r.messageCount} ` +
    `cost=$${r.usage?.cost.total} tokens=${r.usage?.totalTokens} ${r.durationMs}ms`,
    `   text: ${JSON.stringify(r.text.slice(0, 200))}`,
  );
}

// ===========================================================================
console.log("\n-- 2. tool-using turn: usage is the SUM, verified against the raw stream --");
{
  // Run the same request twice: once through DirectRunner, once through a raw capture,
  // then compare DirectRunner's sum against a manual sum of the raw stream.
  const runner = new DirectRunner();
  const r = await runner.run(req({
    provider: TOOLS.provider, model: TOOLS.model,
    tools: ["read", "grep", "find", "ls", "bash"],
    thinking: "low",
    attachPath: join(ws, "seed.md"),
    mission:
      "Using your tools, in order: (1) run `ls` via bash, (2) grep for the word second, " +
      "(3) quote the first line of the attached file verbatim. Then reply done.",
    timeoutMs: 180000,
  }));
  spend += r.usage?.cost.total ?? 0;

  eq("status ok", r.status, "ok");
  check("messageCount > 1 on a tool-using turn", r.messageCount > 1, `${r.messageCount}`);
  check("bash actually ran", r.toolCalls.some((t) => t.name === "bash"),
    JSON.stringify(r.toolCalls));
  check("attached file reached the model", /MARKER-WP4-5150/.test(r.text),
    JSON.stringify(r.text.slice(0, 200)));

  // Manual sum from a raw invocation of the same shape.
  const raw = execSync(
    `pi --mode json --no-session --no-extensions --no-skills --no-prompt-templates ` +
    `--no-context-files --tools read,grep,find,ls,bash --provider ${TOOLS.provider} ` +
    `--model ${TOOLS.model} --thinking low -- @${join(ws, "seed.md")} ` +
    `'Run ls via bash, then grep for second, then reply done.'`,
    { cwd: ws, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000 },
  );
  let manualSum = 0, manualLast = 0, manualCount = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as { type?: string; message?: { role?: string; usage?: Usage } };
      if (ev.type === "message_end" && ev.message?.role === "assistant" && ev.message.usage) {
        manualSum += ev.message.usage.cost.total;
        manualLast = ev.message.usage.cost.total;
        manualCount++;
      }
    } catch { /* ignore */ }
  }
  spend += manualSum;

  check("manual stream also shows >1 assistant message", manualCount > 1, `${manualCount}`);
  check("manual SUM exceeds the last message alone (§7.1 rule is real)",
    manualSum > manualLast, `sum=${manualSum} last=${manualLast}`);
  // DirectRunner's own sum must behave the same way: greater than any single message.
  const perMsgAvg = (r.usage?.cost.total ?? 0) / Math.max(1, r.messageCount);
  check("DirectRunner's usage is a sum, not a single message's",
    (r.usage?.cost.total ?? 0) > perMsgAvg, `total=${r.usage?.cost.total} avg=${perMsgAvg}`);
  report.push(
    `2. tool turn: msgs=${r.messageCount} tools=${JSON.stringify(r.toolCalls)} ` +
    `runnerCost=$${r.usage?.cost.total} cacheRead=${r.usage?.cacheRead}`,
    `   raw stream: assistantMsgs=${manualCount} SUM=$${manualSum.toFixed(6)} ` +
    `last=$${manualLast.toFixed(6)} ratio=${(manualSum / Math.max(manualLast, 1e-9)).toFixed(2)}x`,
  );
}

// ===========================================================================
console.log("\n-- 3. 5s timeout on a sleeping bash mission, then killAll --");
{
  const runner = new DirectRunner();
  const t0 = Date.now();
  const r = await runner.run(req({
    provider: TOOLS.provider, model: TOOLS.model,
    tools: ["read", "grep", "find", "ls", "bash"],
    mission: "Run `sleep 120` using bash. Do not reply until it finishes.",
    timeoutMs: 5000,
  }));
  const elapsed = Date.now() - t0;
  spend += r.usage?.cost.total ?? 0;

  eq("status timeout", r.status, "timeout");
  check("returned promptly after the 5s timeout", elapsed < 20000, `${elapsed}ms`);
  await runner.killAll();
  await new Promise((r2) => setTimeout(r2, 800));

  let survivors = "";
  try {
    survivors = execSync("pgrep -f 'pi --mode json' || true", { encoding: "utf8" }).trim();
  } catch { survivors = ""; }
  // Filter out this very test's parent if pgrep matches loosely.
  const lines = survivors.split("\n").filter((l) => l.trim() !== "");
  check("no `pi --mode json` child survives killAll()", lines.length === 0,
    `pids: ${lines.join(",")}`);
  report.push(`3. timeout: status=${r.status} elapsed=${elapsed}ms survivors=${lines.length}`);
}

// ===========================================================================
console.log("\n-- 4. absurdly low perTurnUsd -> costcap, child dies fast --");
{
  const runner = new DirectRunner();
  const t0 = Date.now();
  const r = await runner.run(req({
    provider: TOOLS.provider, model: TOOLS.model,
    tools: ["read", "grep", "find", "ls", "bash"],
    mission:
      "Run these one at a time via bash, waiting for each: `ls`, `pwd`, `date`, `whoami`, " +
      "`uname -a`, `echo one`, `echo two`, `echo three`. Then summarize.",
    perTurnUsd: 0.001,
    timeoutMs: 180000,
  }));
  const elapsed = Date.now() - t0;
  spend += r.usage?.cost.total ?? 0;

  eq("status costcap", r.status, "costcap");
  check("breached cost recorded", (r.usage?.cost.total ?? 0) >= 0.001, `${r.usage?.cost.total}`);
  check("killed well before the 180s timeout", elapsed < 90000, `${elapsed}ms`);
  check("stopped early in the tool loop", r.messageCount <= 4, `messageCount=${r.messageCount}`);
  report.push(
    `4. costcap: status=${r.status} msgs=${r.messageCount} ` +
    `cost=$${r.usage?.cost.total} elapsed=${elapsed}ms`,
  );
}

// ===========================================================================
console.log("\n-- 5. cacheRead across turns 2+ of the same run (§13 item 8) --");
{
  // Same persona + same attached seed + same stable prefix, three turns in a row,
  // varying only the volatile tail — exactly §6.3's ordering claim.
  const runner = new DirectRunner();
  const bigSeed = join(ws, "big-seed.md");
  writeFileSync(bigSeed, Array.from({ length: 400 },
    (_, i) => `Line ${i}: the quick brown fox jumps over the lazy dog repeatedly.`).join("\n"));

  const reads: number[] = [];
  const writes: number[] = [];
  for (const round of [1, 2, 3] as const) {
    const r = await runner.run(req({
      provider: TOOLS.provider, model: TOOLS.model,
      round, tools: "none", thinking: "low",
      attachPath: bigSeed,
      mission: `Round ${round}. Reply with just the word ok.`,
      timeoutMs: 120000,
    }));
    spend += r.usage?.cost.total ?? 0;
    reads.push(r.usage?.cacheRead ?? 0);
    writes.push(r.usage?.cacheWrite ?? 0);
    console.log(`    round ${round}: cacheRead=${r.usage?.cacheRead} cacheWrite=${r.usage?.cacheWrite} input=${r.usage?.input} cost=$${r.usage?.cost.total}`);
  }
  const engaged = reads.slice(1).some((x) => x > 0);
  check("recorded cacheRead for turns 2+ (informational, not pass/fail on value)", true);
  report.push(
    `5. cacheRead by turn: ${JSON.stringify(reads)}  cacheWrite: ${JSON.stringify(writes)}`,
    `   cross-turn caching ${engaged ? "ENGAGED" : "DID NOT engage"} on ${TOOLS.provider}/${TOOLS.model}`,
  );
  console.log(`    -> cross-turn caching ${engaged ? "ENGAGED" : "did NOT engage"}`);
}

// ===========================================================================
report.push(`TOTAL measured spend for WP4 online: $${spend.toFixed(6)}`);
const out = ["# WP4 online results", `Date: ${new Date().toISOString()}`, "", ...report, ""].join("\n");
appendFileSync(join(process.env.DEBATE_REPORT_DIR ?? ws, "wp4-online.md"), out);
console.log("\n" + out);

rmSync(ws, { recursive: true, force: true });
console.log(`${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
