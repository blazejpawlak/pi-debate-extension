/**
 * runner/direct.ts — spawn `pi` per §6.2, parse the JSON event stream per §7.1.
 *
 * The three things this file must get right, because everything downstream trusts them:
 *  1. Usage is the SUM over every ASSISTANT message_end (§7.1). Taking the last one
 *     undercounts a tool-using turn by 2-6x (measured in WP0) and would silently
 *     disable D9's cost caps.
 *  2. `message_end` also fires for `user` and `toolResult` messages (§13.17). Those carry
 *     no usage. Filter on role === "assistant" before summing or counting.
 *  3. Mid-turn cost/token ceilings must actually kill the child (D9), because pi has no
 *     --max-turns and nothing else bounds a runaway tool loop.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addUsage, emptyUsage, type TurnRequest, type TurnResult, type TurnRunner, type Usage,
} from "./types.ts";

const STDERR_KEEP = 2048;
/** Grace period between SIGTERM and SIGKILL (§6.2). */
const KILL_GRACE_MS = 5000;

export interface DirectRunnerOptions {
  /** Executable to spawn. Override in tests. */
  piPath?: string;
  /** Called with each parsed event, for the live widget. */
  onEvent?: (ev: DirectStreamEvent) => void;
}

export interface DirectStreamEvent {
  type: string;
  runId: string;
  role: string;
  /** Running total across assistant messages so far in this turn. */
  usageSoFar: Usage;
  toolName?: string;
  messageCount: number;
}

/** Strip flat `key: value` frontmatter, returning the persona body (§6.2). */
export function stripFrontmatter(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length).trimStart() : text;
}

/** Extract text blocks of an assistant message, skipping thinking/toolCall (§7.1). */
function textOf(message: { content?: { type?: string; text?: string }[] }): string {
  return (message.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

/** Build the argv per §6.2. Exported so tests can assert it without spawning. */
export function buildArgs(req: TurnRequest, personaTmpPath: string): string[] {
  const args: string[] = [
    "--mode", "json",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
  ];
  // §4: children run with --no-context-files so AGENTS.md/CLAUDE.md cannot bias the debate.
  if (!req.contextFiles) args.push("--no-context-files");

  if (req.provider) args.push("--provider", req.provider);
  args.push("--model", req.model);
  args.push("--thinking", req.thinking);

  if (req.tools === "none") args.push("--no-tools");
  else args.push("--tools", req.tools.join(","));

  args.push("--append-system-prompt", personaTmpPath);
  if (req.extraArgs?.length) args.push(...req.extraArgs);

  // §6.2: `--` ends option parsing. Without it a mission beginning with `-` is swallowed
  // into unknownFlags, and an unknown flag even consumes the following argument.
  args.push("--");
  // A positional `@path` is a file ATTACHMENT, not text: keeps large seeds out of argv
  // (no ARG_MAX risk), out of `ps`, and byte-identical every turn for the prompt cache.
  if (req.attachPath) args.push(`@${req.attachPath}`);
  args.push(req.mission);
  return args;
}

export class DirectRunner implements TurnRunner {
  private children = new Set<ChildProcess>();
  private piPath: string;
  private onEvent?: (ev: DirectStreamEvent) => void;

  constructor(opts: DirectRunnerOptions = {}) {
    this.piPath = opts.piPath ?? "pi";
    this.onEvent = opts.onEvent;
  }

  async run(req: TurnRequest): Promise<TurnResult> {
    const t0 = Date.now();

    // Persona body goes to a temp file named per §6.2 so parallel R1 children cannot
    // collide, and is removed in a finally.
    const dir = mkdtempSync(join(tmpdir(), "debate-"));
    const personaTmp = join(
      dir,
      `debate-${req.runId}-${req.round}-${req.role}-${process.pid}.md`,
    );

    try {
      const personaBody = existsSync(req.personaPath)
        ? stripFrontmatter(readFileSync(req.personaPath, "utf8"))
        : "";
      writeFileSync(personaTmp, personaBody);

      const args = buildArgs(req, personaTmp);
      return await this.spawnAndParse(req, args, t0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private spawnAndParse(req: TurnRequest, args: string[], t0: number): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      const child = spawn(this.piPath, args, {
        cwd: req.cwd,
        env: {
          ...process.env,
          DEBATE_RUN_ID: req.runId,
          DEBATE_ROLE: req.role,
          DEBATE_ROUND: String(req.round),
          // §4: prompt-level read-only guarantee for anything the Skeptic invokes.
          DEBATE_READONLY: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.add(child);

      let usage: Usage = emptyUsage();
      let messageCount = 0;
      let finalText = "";
      let lastStopReason: string | null = null;
      let sawAgentEnd = false;
      let stderrBuf = "";
      let pending = "";
      const toolCounts = new Map<string, number>();

      let providerError: string | null = null;
      let status: TurnResult["status"] | null = null;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        clearTimeout(killTimer);
        req.signal.removeEventListener("abort", onAbort);
        this.children.delete(child);

        const effective: TurnResult["status"] =
          status ??
          (lastStopReason === "error" ? "failed"
            // §7.1: a missing agent_end means the child died mid-stream.
            : !sawAgentEnd ? "failed"
            : "ok");

        const tokens = usage.totalTokens;
        resolve({
          text: finalText,
          usage: messageCount > 0 ? usage : null,
          messageCount,
          toolCalls: [...toolCounts].map(([name, count]) => ({ name, count })),
          stopReason: lastStopReason,
          status: effective,
          durationMs: Date.now() - t0,
          exitCode: child.exitCode,
          stderrTail: [
            providerError ? `providerError: ${providerError}` : "",
            stderrBuf,
          ].filter(Boolean).join("\n").slice(-STDERR_KEEP),
          costUnreported: tokens > 0 && usage.cost.total === 0,
        });
      };

      /** SIGTERM, then SIGKILL after a grace period (§6.2). */
      const terminate = (reason: TurnResult["status"]): void => {
        if (status === null) status = reason;
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
        killTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }, KILL_GRACE_MS);
        killTimer.unref?.();
      };

      const timeoutTimer = setTimeout(() => terminate("timeout"), req.timeoutMs);
      const onAbort = () => terminate("aborted");
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener("abort", onAbort, { once: true });

      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(trimmed) as Record<string, unknown>; } catch { return; }

        switch (ev.type) {
          case "agent_end":
            sawAgentEnd = true;
            break;

          case "tool_execution_start": {
            const name = String(ev.toolName ?? "unknown");
            toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
            this.onEvent?.({
              type: "tool_execution_start", runId: req.runId, role: req.role,
              usageSoFar: usage, toolName: name, messageCount,
            });
            break;
          }

          case "message_end": {
            const message = ev.message as
              | { role?: string; usage?: Usage; stopReason?: string; content?: unknown[] }
              | undefined;
            if (!message) break;
            // §13.17: message_end fires for user and toolResult messages too; those have
            // no usage. Only assistant messages are provider requests.
            if (message.role !== "assistant") break;

            messageCount++;
            lastStopReason = message.stopReason ?? null;
            // §7.2 / §13.38: errorMessage is the only human-readable cause of a failed
            // turn. Surface it in stderrTail so the manifest keeps it.
            const em = (message as { errorMessage?: string }).errorMessage;
            if (em) providerError = String(em);
            if (message.usage) {
              // §7.1 accounting rule: SUM, never replace.
              usage = addUsage(usage, message.usage);
            }
            const t = textOf(message as { content?: { type?: string; text?: string }[] });
            if (t) finalText = t;

            this.onEvent?.({
              type: "message_end", runId: req.runId, role: req.role,
              usageSoFar: usage, messageCount,
            });

            // D9: enforce the ceilings mid-turn. This is the only bound on a runaway
            // tool loop besides the timeout, because pi has no --max-turns (§7.3).
            if (req.perTurnUsd && usage.cost.total >= req.perTurnUsd) {
              terminate("costcap");
            } else if (req.perTurnTokens && usage.totalTokens >= req.perTurnTokens) {
              terminate("costcap");
            }
            break;
          }

          case "message_update": {
            // Delta-only; top-level usage is the latest cumulative figure. Widget only,
            // never accounting (§7.1).
            this.onEvent?.({
              type: "message_update", runId: req.runId, role: req.role,
              usageSoFar: usage, messageCount,
            });
            break;
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        pending += chunk.toString();
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const l of lines) handleLine(l);
      });
      child.stderr.on("data", (c: Buffer) => {
        stderrBuf += c.toString();
        if (stderrBuf.length > STDERR_KEEP * 4) stderrBuf = stderrBuf.slice(-STDERR_KEEP * 2);
      });

      child.on("error", (e) => {
        stderrBuf += `\nspawn error: ${e.message}`;
        if (status === null) status = "failed";
        finish();
      });
      child.on("close", () => {
        if (pending.trim()) handleLine(pending);
        finish();
      });
    });
  }

  /** Idempotent; what session_shutdown calls (§6.2, §9.4). */
  async killAll(): Promise<void> {
    const kids = [...this.children];
    for (const c of kids) {
      try { c.kill("SIGTERM"); } catch { /* gone */ }
    }
    if (kids.length === 0) return;
    await new Promise((r) => setTimeout(r, 300));
    for (const c of kids) {
      if (c.exitCode === null && c.signalCode === null) {
        try { c.kill("SIGKILL"); } catch { /* gone */ }
      }
      this.children.delete(c);
    }
  }
}
