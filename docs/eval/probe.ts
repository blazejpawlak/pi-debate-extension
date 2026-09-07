/**
 * WP0 — Model smoke test (design §11 WP0).
 *
 * Probes, per design:
 *   (a) three §4 models: stopReason "stop" and cost.total > 0
 *   (b) tool probe: tool_execution_start with toolName "bash"
 *   (c) tool probe: >1 assistant message_end, summed cost > last cost alone
 *   (d) @file argument visibly reaches the model
 *
 * Spends real tokens. Writes .debate/probe.txt and raw streams to .debate/probe-raw/.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WS = "/Users/tetsuo/Desktop/mac-migration";
const RAW = join(WS, ".debate", "probe-raw");
mkdirSync(RAW, { recursive: true });

interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  reasoning?: number; totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

interface Probe {
  label: string;
  provider: string;
  model: string;
  exitCode: number | null;
  wallMs: number;
  sawSession: boolean;
  sawAgentEnd: boolean;
  /** assistant message_end events only */
  assistantMessages: { stopReason: string | null; usage: Usage | null; contentTypes: string[] }[];
  /** message_end events with a non-assistant role — proves the role filter is needed */
  nonAssistantMessageEnds: string[];
  toolCalls: string[];
  finalText: string;
  summedCost: number;
  lastCost: number;
  summedTokens: number;
  cacheRead: number;
  stderrTail: string;
  parseFailures: number;
}

function runProbe(label: string, argv: string[]): Promise<Probe> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn("pi", argv, {
      cwd: WS,
      env: { ...process.env, DEBATE_READONLY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const p: Probe = {
      label,
      provider: argv[argv.indexOf("--provider") + 1] ?? "(default)",
      model: argv[argv.indexOf("--model") + 1] ?? "(default)",
      exitCode: null, wallMs: 0,
      sawSession: false, sawAgentEnd: false,
      assistantMessages: [], nonAssistantMessageEnds: [],
      toolCalls: [], finalText: "",
      summedCost: 0, lastCost: 0, summedTokens: 0, cacheRead: 0,
      stderrTail: "", parseFailures: 0,
    };

    let stdoutBuf = "";
    let stderrBuf = "";
    let pending = "";

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: any;
      try { ev = JSON.parse(trimmed); } catch { p.parseFailures++; return; }

      switch (ev.type) {
        case "session":
          p.sawSession = true;
          break;
        case "agent_end":
          p.sawAgentEnd = true;
          break;
        case "tool_execution_start":
          p.toolCalls.push(ev.toolName);
          break;
        case "message_end": {
          const m = ev.message;
          if (!m) return;
          // CRITICAL: message_end fires for user messages too. Filter by role.
          if (m.role !== "assistant") {
            p.nonAssistantMessageEnds.push(String(m.role));
            return;
          }
          const usage: Usage | null = m.usage ?? null;
          p.assistantMessages.push({
            stopReason: m.stopReason ?? null,
            usage,
            contentTypes: (m.content ?? []).map((c: any) => c.type),
          });
          if (usage) {
            p.summedCost += usage.cost?.total ?? 0;
            p.lastCost = usage.cost?.total ?? 0;
            p.summedTokens += usage.totalTokens ?? 0;
            p.cacheRead += usage.cacheRead ?? 0;
          }
          // text = final assistant message, text blocks only (skip thinking/toolCall)
          const text = (m.content ?? [])
            .filter((c: any) => c.type === "text")
            .map((c: any) => c.text ?? "")
            .join("");
          if (text) p.finalText = text;
          break;
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      stdoutBuf += s;
      pending += s;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const l of lines) handleLine(l);
    });

    child.stderr.on("data", (c) => { stderrBuf += c.toString(); });

    child.on("close", (code) => {
      if (pending.trim()) handleLine(pending);
      p.exitCode = code;
      p.wallMs = Date.now() - t0;
      p.stderrTail = stderrBuf.slice(-2048);
      writeFileSync(join(RAW, `${label}.jsonl`), stdoutBuf);
      if (stderrBuf) writeFileSync(join(RAW, `${label}.err`), stderrBuf);
      resolve(p);
    });
  });
}

const BASE = [
  "--mode", "json", "--no-session", "--no-extensions",
  "--no-skills", "--no-prompt-templates", "--no-context-files",
];

async function main() {
  const results: Probe[] = [];

  // ---- (a) three §4 models, minimal no-tools call ----
  // Roster after WP0 swaps (see §13 items 14/15/16). Ideator and Synthesizer moved to
  // openrouter: ibm-services-essentials reports cost.total=0 for all 19 models (cap
  // unenforceable) and opencode has no credit balance. Families still Anthropic/OpenAI/Google.
  const models: [string, string, string][] = [
    ["ideator", "openrouter", "anthropic/claude-opus-4-8"],
    ["skeptic", "openai-codex", "gpt-6-astra"],
    ["synthesizer", "openrouter", "google/gemini-3.1-pro-preview"],
  ];

  for (const [role, provider, model] of models) {
    process.stderr.write(`\n=== probe ${role}: ${provider}/${model}\n`);
    const r = await runProbe(`a-${role}`, [
      ...BASE, "--no-tools",
      "--provider", provider, "--model", model,
      "--", "reply with the word ok",
    ]);
    results.push(r);
    process.stderr.write(
      `    exit=${r.exitCode} stop=${r.assistantMessages.at(-1)?.stopReason} ` +
      `cost=${r.summedCost} msgs=${r.assistantMessages.length} ${r.wallMs}ms\n`
    );
  }

  // ---- (b)(c)(d) tool-loop probe against the Skeptic model ----
  // A dedicated small seed file so (d) is unambiguous.
  const seedPath = join(RAW, "probe-seed.md");
  writeFileSync(seedPath, "MARKER-LINE-7f3a: the debate probe seed file.\nsecond line here.\n");

  process.stderr.write(`\n=== probe tool-loop: openai-codex/gpt-6-astra\n`);
  const tool = await runProbe("b-toolloop", [
    ...BASE,
    "--tools", "read,grep,find,ls,bash",
    "--provider", "openai-codex", "--model", "gpt-6-astra",
    "--thinking", "high",
    "--", `@${seedPath}`,
    "Do these in order, using your tools: (1) run ls via bash, (2) grep for the word the, " +
    "(3) quote the first line of the attached file verbatim, then reply done.",
  ]);
  results.push(tool);
  process.stderr.write(
    `    exit=${tool.exitCode} msgs=${tool.assistantMessages.length} ` +
    `tools=${tool.toolCalls.join(",")} summed=${tool.summedCost} last=${tool.lastCost}\n`
  );

  // ---------------- acceptance evaluation ----------------
  const modelProbes = results.slice(0, 3);
  const checks: { id: string; pass: boolean; detail: string }[] = [];

  for (const r of modelProbes) {
    const last = r.assistantMessages.at(-1);
    checks.push({
      id: `a.stop[${r.provider}/${r.model}]`,
      pass: last?.stopReason === "stop",
      detail: `stopReason=${JSON.stringify(last?.stopReason)} exit=${r.exitCode}`,
    });
    checks.push({
      id: `a.cost[${r.provider}/${r.model}]`,
      pass: r.summedCost > 0,
      detail: `summed cost.total=${r.summedCost} tokens=${r.summedTokens}`,
    });
  }

  checks.push({
    id: "b.bash_granted",
    pass: tool.toolCalls.includes("bash"),
    detail: `tool_execution_start toolNames=[${tool.toolCalls.join(", ")}]`,
  });
  checks.push({
    id: "c.multi_message",
    pass: tool.assistantMessages.length > 1,
    detail: `assistant message_end count=${tool.assistantMessages.length}`,
  });
  checks.push({
    id: "c.sum_exceeds_last",
    pass: tool.summedCost > tool.lastCost,
    detail: `summed=${tool.summedCost} last=${tool.lastCost} ` +
            `ratio=${tool.lastCost > 0 ? (tool.summedCost / tool.lastCost).toFixed(2) : "n/a"}x`,
  });
  checks.push({
    id: "d.file_reached",
    pass: /MARKER-LINE-7f3a/.test(tool.finalText),
    detail: `final text ${/MARKER-LINE-7f3a/.test(tool.finalText) ? "contains" : "MISSING"} marker`,
  });

  // ---------------- report ----------------
  const lines: string[] = [];
  lines.push("# WP0 — Model smoke test");
  lines.push(`Date: ${new Date().toISOString()}`);
  lines.push(`pi: 0.85.1   workspace: ${WS}`);
  lines.push("");
  lines.push("## Per-probe results");
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.label} — ${r.provider}/${r.model}`);
    lines.push(`- exitCode: ${r.exitCode}`);
    lines.push(`- wall time: ${r.wallMs} ms`);
    lines.push(`- session header: ${r.sawSession}   agent_end: ${r.sawAgentEnd}`);
    lines.push(`- assistant message_end count: ${r.assistantMessages.length}`);
    lines.push(`- stopReasons: ${JSON.stringify(r.assistantMessages.map((m) => m.stopReason))}`);
    lines.push(`- content block types: ${JSON.stringify(r.assistantMessages.map((m) => m.contentTypes))}`);
    lines.push(`- SUMMED usage.cost.total: ${r.summedCost}`);
    lines.push(`- LAST message cost.total: ${r.lastCost}`);
    lines.push(`- summed totalTokens: ${r.summedTokens}   cacheRead: ${r.cacheRead}`);
    lines.push(`- tool_execution_start: ${JSON.stringify(r.toolCalls)}`);
    lines.push(`- non-assistant message_end roles: ${JSON.stringify(r.nonAssistantMessageEnds)}`);
    lines.push(`- parse failures: ${r.parseFailures}`);
    lines.push(`- final text (first 300 chars): ${JSON.stringify(r.finalText.slice(0, 300))}`);
    if (r.stderrTail.trim()) lines.push(`- stderr tail: ${JSON.stringify(r.stderrTail.slice(-500))}`);
    lines.push("");
  }

  lines.push("## Acceptance checks");
  lines.push("");
  for (const c of checks) {
    lines.push(`- [${c.pass ? "PASS" : "FAIL"}] ${c.id} — ${c.detail}`);
  }
  lines.push("");
  const failed = checks.filter((c) => !c.pass);
  lines.push(`## Verdict: ${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILURE(S)`}`);
  if (failed.length) {
    lines.push("");
    for (const f of failed) lines.push(`- ${f.id}: ${f.detail}`);
  }

  const report = lines.join("\n") + "\n";
  writeFileSync(join(WS, ".debate", "probe.txt"), report);
  process.stdout.write("\n" + report);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
