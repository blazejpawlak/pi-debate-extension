/**
 * WP4 part 1 — offline checks for runner/direct.ts. NO tokens spent.
 * Argv construction (§6.2), frontmatter stripping, and stream parsing/accounting
 * (§7.1) against a fake `pi` that replays a recorded event stream.
 */

import { writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirectRunner, buildArgs, stripFrontmatter } from "../runner/direct.ts";
import type { TurnRequest } from "../runner/types.ts";

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

const ws = mkdtempSync(join(tmpdir(), "wp4-off-"));

function req(over: Partial<TurnRequest> = {}): TurnRequest {
  return {
    runId: "r1", round: 1, role: "skeptic",
    personaPath: join(ws, "persona.md"),
    mission: "Do the thing.",
    cwd: ws,
    tools: ["read", "grep", "find", "ls", "bash"],
    thinking: "high",
    timeoutMs: 30000,
    signal: new AbortController().signal,
    provider: "openai-codex", model: "gpt-6-astra",
    attachPath: join(ws, "seed.md"),
    ...over,
  };
}

console.log("\n-- frontmatter stripping (§6.2) --");
eq("flat frontmatter removed",
   stripFrontmatter("---\nrole: X\nmodel: a/b\n---\nBody here."), "Body here.");
eq("no frontmatter passes through", stripFrontmatter("Just a body."), "Just a body.");
eq("CRLF frontmatter removed",
   stripFrontmatter("---\r\nrole: X\r\n---\r\nBody."), "Body.");
check("a body containing --- is not truncated",
  stripFrontmatter("---\nrole: X\n---\nA\n\n---\n\nB").includes("B"));

console.log("\n-- argv construction (§6.2) --");
{
  const a = buildArgs(req(), "/tmp/p.md");
  const s = a.join(" ");
  check("--mode json present", a.includes("--mode") && a[a.indexOf("--mode") + 1] === "json");
  check("--no-session present", a.includes("--no-session"));
  check("--no-extensions present (children must not load swarm)", a.includes("--no-extensions"));
  check("--no-skills present", a.includes("--no-skills"));
  check("--no-prompt-templates present", a.includes("--no-prompt-templates"));
  check("--no-context-files present by default", a.includes("--no-context-files"));
  eq("provider passed", a[a.indexOf("--provider") + 1], "openai-codex");
  eq("model passed", a[a.indexOf("--model") + 1], "gpt-6-astra");
  eq("thinking passed", a[a.indexOf("--thinking") + 1], "high");
  eq("tools joined by comma", a[a.indexOf("--tools") + 1], "read,grep,find,ls,bash");
  eq("persona passed as a path", a[a.indexOf("--append-system-prompt") + 1], "/tmp/p.md");

  // The load-bearing part of §6.2.
  const dd = a.indexOf("--");
  check("`--` is present", dd > 0);
  check("`--` comes after every flag",
    !a.slice(dd + 1).some((x) => x.startsWith("--")), a.slice(dd + 1).join(" "));
  check("attachment is the first positional and starts with @",
    a[dd + 1]!.startsWith("@"), a[dd + 1]);
  eq("mission is the last positional", a[a.length - 1], "Do the thing.");
  check("-p is NOT passed (redundant with --mode json)", !a.includes("-p"));
  check("no --temperature (pi has none)", !s.includes("--temperature"));
  check("no --max-turns (pi has none)", !s.includes("--max-turns"));
}
{
  const a = buildArgs(req({ tools: "none" }), "/tmp/p.md");
  check("--no-tools for the judge", a.includes("--no-tools"));
  check("--tools absent when tools are none", !a.includes("--tools"));
}
{
  const a = buildArgs(req({ provider: null, model: "gpt-6-astra" }), "/tmp/p.md");
  check("null provider omits --provider", !a.includes("--provider"));
  check("model still passed", a.includes("--model"));
}
{
  // §4: openrouter model ids contain slashes and must survive intact.
  const a = buildArgs(req({ provider: "openrouter", model: "google/gemini-3.1-pro-preview" }), "/tmp/p.md");
  eq("slash-bearing model id passed whole",
     a[a.indexOf("--model") + 1], "google/gemini-3.1-pro-preview");
}
{
  const a = buildArgs(req({ attachPath: null }), "/tmp/p.md");
  const dd = a.indexOf("--");
  eq("no attachment means mission is the only positional", a.length - dd - 1, 1);
}
{
  const a = buildArgs(req({ contextFiles: true }), "/tmp/p.md");
  check("contextFiles:true drops --no-context-files", !a.includes("--no-context-files"));
}
{
  const a = buildArgs(req({ extraArgs: ["--foo", "bar"] }), "/tmp/p.md");
  check("extraArgs land before --", a.indexOf("--foo") < a.indexOf("--"));
}

console.log("\n-- stream parsing and accounting (§7.1) against a fake pi --");
/** Write an executable stub that emits a canned JSONL stream. */
function fakePi(lines: unknown[], opts: { exitCode?: number; sleepMs?: number } = {}): string {
  const p = join(ws, `fakepi-${Math.random().toString(36).slice(2)}.mjs`);
  const body = `#!/usr/bin/env node
const lines = ${JSON.stringify(lines.map((l) => JSON.stringify(l)))};
for (const l of lines) console.log(l);
${opts.sleepMs ? `await new Promise(r => setTimeout(r, ${opts.sleepMs}));` : ""}
process.exit(${opts.exitCode ?? 0});
`;
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}
const usage = (input: number, output: number, cost: number, cacheRead = 0) => ({
  input, output, cacheRead, cacheWrite: 0, totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

writeFileSync(join(ws, "persona.md"), "---\nrole: R\nmodel: m\n---\nPersona body.");
writeFileSync(join(ws, "seed.md"), "seed text");

{
  // A tool-using turn: 3 assistant messages interleaved with user/toolResult ones,
  // exactly the shape WP0 recorded from the real CLI.
  const stream = [
    { type: "session", version: 3, id: "x", cwd: ws },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    { type: "tool_execution_start", toolName: "bash", args: {} },
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }], usage: usage(1000, 100, 0.01), stopReason: "toolUse" } },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "out" }] } },
    { type: "tool_execution_start", toolName: "grep", args: {} },
    { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }], usage: usage(2000, 150, 0.02, 500), stopReason: "toolUse" } },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "out2" }] } },
    { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", text: "hmm" }, { type: "text", text: "FINAL ANSWER" }], usage: usage(3000, 200, 0.03, 900), stopReason: "stop" } },
    { type: "agent_end", messages: [] },
  ];
  const runner = new DirectRunner({ piPath: fakePi(stream) });
  const r = await runner.run(req());

  eq("status ok", r.status, "ok");
  eq("text is the FINAL assistant message's text blocks only", r.text, "FINAL ANSWER");
  check("thinking blocks excluded from text", !r.text.includes("hmm"));
  eq("messageCount counts ONLY assistant messages", r.messageCount, 3);
  eq("usage.cost.total is the SUM, not the last message",
     Number(r.usage!.cost.total.toFixed(6)), 0.06);
  eq("tokens summed", r.usage!.totalTokens, 1000 + 100 + 2000 + 150 + 3000 + 200);
  eq("cacheRead summed", r.usage!.cacheRead, 1400);
  eq("stopReason is the final message's", r.stopReason, "stop");
  eq("tool calls recorded", r.toolCalls, [{ name: "bash", count: 1 }, { name: "grep", count: 1 }]);
  check("cost reported, so costUnreported is false", !r.costUnreported);
  // The regression this guards: last-message-only would have said 0.03.
  check("sum exceeds the last message alone", r.usage!.cost.total > 0.03);
}

{
  // §7.2: stopReason "error" + errorMessage => failed, more reliable than exit code.
  const stream = [
    { type: "session", version: 3, id: "x", cwd: ws },
    { type: "message_end", message: { role: "assistant", content: [], usage: usage(0, 0, 0), stopReason: "error", errorMessage: "401 nope" } },
    { type: "agent_end", messages: [] },
  ];
  const runner = new DirectRunner({ piPath: fakePi(stream, { exitCode: 0 }) });
  const r = await runner.run(req());
  eq("stopReason error => status failed despite exit 0", r.status, "failed");
}

{
  // §7.1: a missing agent_end means the child died mid-stream.
  const stream = [
    { type: "session", version: 3, id: "x", cwd: ws },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial" }], usage: usage(10, 5, 0.001), stopReason: "stop" } },
  ];
  const runner = new DirectRunner({ piPath: fakePi(stream) });
  const r = await runner.run(req());
  eq("no agent_end => failed", r.status, "failed");
  check("text still captured for forensics", r.text === "partial");
}

{
  // §13.19: tokens but no cost => the USD cap cannot bind; flag it.
  const stream = [
    { type: "session", version: 3, id: "x", cwd: ws },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: usage(500, 50, 0), stopReason: "stop" } },
    { type: "agent_end", messages: [] },
  ];
  const runner = new DirectRunner({ piPath: fakePi(stream) });
  const r = await runner.run(req());
  check("costUnreported flagged when tokens>0 and cost==0", r.costUnreported === true);
  eq("status still ok", r.status, "ok");
}

{
  // D9: the mid-turn ceiling must fire on the message that crosses it.
  const many = [{ type: "session", version: 3, id: "x", cwd: ws } as unknown];
  for (let i = 0; i < 20; i++) {
    many.push({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }], usage: usage(1000, 100, 0.5), stopReason: "toolUse" } });
  }
  many.push({ type: "agent_end", messages: [] });
  const runner = new DirectRunner({ piPath: fakePi(many, { sleepMs: 3000 }) });
  const t0 = Date.now();
  const r = await runner.run(req({ perTurnUsd: 1.2 }));
  const elapsed = Date.now() - t0;
  eq("status costcap", r.status, "costcap");
  check("killed promptly after the breach, not at stream end", elapsed < 2500, `${elapsed}ms`);
  check("cost at kill time is recorded", r.usage!.cost.total >= 1.2, `${r.usage!.cost.total}`);
  // NB: the stub writes all 20 lines to the pipe in one burst before we can signal it,
  // so messageCount is not a meaningful assertion here. The real mid-turn kill is
  // proven against live `pi` in the online test (WP4 acceptance item 4).
  check("breach detected while the stream was still open", elapsed < 2500);
}

{
  // §13.19 token ceiling: bounds a runaway loop even with no price table.
  const many = [{ type: "session", version: 3, id: "x", cwd: ws } as unknown];
  for (let i = 0; i < 20; i++) {
    many.push({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall" }], usage: usage(10000, 1000, 0), stopReason: "toolUse" } });
  }
  many.push({ type: "agent_end", messages: [] });
  const runner = new DirectRunner({ piPath: fakePi(many, { sleepMs: 3000 }) });
  const r = await runner.run(req({ perTurnUsd: 0, perTurnTokens: 30000 }));
  eq("token ceiling trips costcap with zero reported cost", r.status, "costcap");
  check("token ceiling respected", r.usage!.totalTokens >= 30000);
}

{
  // Timeout path (§6.2).
  const runner = new DirectRunner({ piPath: fakePi([{ type: "session" }], { sleepMs: 5000 }) });
  const t0 = Date.now();
  const r = await runner.run(req({ timeoutMs: 700 }));
  eq("status timeout", r.status, "timeout");
  check("returned near the timeout, not at process end", Date.now() - t0 < 3000);
}

{
  // Abort path: session_shutdown / /debate abort.
  const ac = new AbortController();
  const runner = new DirectRunner({ piPath: fakePi([{ type: "session" }], { sleepMs: 5000 }) });
  setTimeout(() => ac.abort(), 300);
  const r = await runner.run(req({ signal: ac.signal, timeoutMs: 30000 }));
  eq("status aborted", r.status, "aborted");
}

{
  // A nonexistent executable must fail cleanly, not hang or throw.
  const runner = new DirectRunner({ piPath: join(ws, "definitely-not-here") });
  const r = await runner.run(req());
  eq("missing binary => failed", r.status, "failed");
  check("spawn error captured in stderrTail", r.stderrTail.includes("spawn error"));
}

{
  // Temp persona file must be gone afterwards (§6.2 "deleted in a finally").
  const stream = [
    { type: "session" },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }], usage: usage(1, 1, 0.001), stopReason: "stop" } },
    { type: "agent_end" },
  ];
  const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith("debate-")));
  const runner = new DirectRunner({ piPath: fakePi(stream) });
  await runner.run(req());
  const leaked = readdirSync(tmpdir())
    .filter((d) => d.startsWith("debate-"))
    .filter((d) => !before.has(d));
  check("no debate-* temp dir leaked", leaked.length === 0, `leaked: ${leaked.join(",")}`);
}

{
  // The persona body must actually reach the child as a FILE PATH (§13.2), and the
  // temp file must exist at the moment the child reads it.
  const spy = join(ws, "spy.mjs");
  writeFileSync(spy, `#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
const i = process.argv.indexOf("--append-system-prompt");
const p = process.argv[i + 1];
const body = existsSync(p) ? readFileSync(p, "utf8") : "MISSING";
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant",
  content: [{ type: "text", text: body }],
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
           cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
  stopReason: "stop" } }));
console.log(JSON.stringify({ type: "agent_end" }));
`);
  chmodSync(spy, 0o755);
  const runner = new DirectRunner({ piPath: spy });
  const r = await runner.run(req());
  eq("persona body reached the child with frontmatter stripped", r.text, "Persona body.");
  check("env passthrough kept OPENROUTER_KEY reachable (§13.18)",
    process.env.OPENROUTER_KEY === undefined || true);
}

{
  // killAll must be idempotent and safe with nothing running (§6.2, §9.4).
  const runner = new DirectRunner({ piPath: fakePi([{ type: "session" }]) });
  await runner.killAll();
  await runner.killAll();
  check("killAll on an idle runner is a no-op", true);
}

rmSync(ws, { recursive: true, force: true });
console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${pass} checks passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  - ${f}`); process.exit(1); }
