/**
 * Multi-agent debate — pi extension (D1).
 *
 * Registration and wiring only. The protocol lives in orchestrator.ts, the data
 * contract in ledger.ts, the child process handling in runner/.
 *
 * WP4 state: `/debate` and `debate_run` execute real runs through the direct runner.
 * Full UI polish (live widget, injection modes, stale-run sweep) is WP6.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig, type DebateConfig, type Mode } from "./config.ts";
import { listRuns, newRunId, runPaths } from "./paths.ts";
import { parseCommand, selectMode, readSeedFile, HELP_TEXT } from "./command.ts";
import { Orchestrator, type Progress, type RunOutcome } from "./orchestrator.ts";
import { DirectRunner } from "./runner/direct.ts";
import { FakeRunner } from "./runner/fake.ts";
import type { TurnRunner } from "./runner/types.ts";
import { readManifest, writeManifest } from "./manifest.ts";
import { openAtOrAbove } from "./ledger.ts";

const PERSONA_DIR = join(import.meta.dirname, "personas");

function makeRunner(cfg: DebateConfig, onProgress?: (p: unknown) => void): TurnRunner {
  switch (cfg.runner) {
    case "fake":
      // Only reachable if someone sets runner:"fake" in config; keeps tests honest.
      return new FakeRunner({ fixtures: {} });
    case "harness":
      throw new Error(
        'runner "harness" is not implemented yet (WP7). Use "direct" or "fake".',
      );
    default:
      return new DirectRunner({ onEvent: onProgress ? () => onProgress(undefined) : undefined });
  }
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function (pi: ExtensionAPI) {
  /** §9.2: one run at a time. */
  let active: {
    runId: string;
    orch: Orchestrator;
    runner: TurnRunner;
    progress: Progress | null;
  } | null = null;

  const say = (
    ctx: { hasUI: boolean; ui: { notify: (m: string, l: "info" | "warn" | "error") => void } },
    text: string,
    level: "info" | "warn" | "error" = "info",
  ): void => {
    // §9.3: guard every UI call; the extension must still work in --mode json and -p.
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else process.stdout.write(text + "\n");
  };

  /** Live status line + widget (§9.3). Cleared at the end of a run. */
  function renderProgress(ctx: ExtensionCommandContext, p: Progress): void {
    if (!ctx.hasUI) return;
    const cost = p.costTrusted ? `$${p.costUsd.toFixed(2)}` : `$${p.costUsd.toFixed(2)}?`;
    ctx.ui.setStatus("debate", `${p.phase} · ${fmtDuration(p.elapsedMs)} · ${cost}`);
    const lines = [`debate ${p.runId} · ${p.phase} · ${cost} · ${p.tokens} tok`];
    if (p.openHigh > 0) lines.push(`open high-severity: ${p.openHigh}`);
    if (p.lintCount > 0) lines.push(`lint warnings: ${p.lintCount}`);
    if (!p.costTrusted) lines.push("cost understated: a provider reports no price");
    ctx.ui.setWidget("debate", lines);
  }

  function clearProgress(ctx: ExtensionCommandContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("debate", undefined as unknown as string);
    ctx.ui.setWidget("debate", undefined as unknown as string[]);
  }

  /** Shared by the command and the tool. */
  async function execute(
    ctx: ExtensionCommandContext,
    cfg: DebateConfig,
    opts: { seedText: string; seedSource: string; mode: Mode; rounds?: number },
  ): Promise<RunOutcome> {
    const runId = newRunId();
    const runner = makeRunner(cfg);
    const orch = new Orchestrator({
      workspace: ctx.cwd, cfg, runner, personaDir: PERSONA_DIR,
      onProgress: (p) => {
        if (active) active.progress = p;
        renderProgress(ctx, p);
      },
    });
    active = { runId, orch, runner, progress: null };
    try {
      return await orch.start(runId, opts);
    } finally {
      await runner.killAll();
      clearProgress(ctx);
      active = null;
    }
  }

  /** §9.3: put the verdict in front of the user and, per config, into the next prompt. */
  function deliver(ctx: ExtensionCommandContext, out: RunOutcome, cfg: DebateConfig): void {
    say(ctx as never, out.summary, out.status === "complete" ? "info" : "warn");

    pi.appendEntry("debate-verdict", {
      runId: out.runId,
      path: out.verdictPath,
      summary: out.summary,
      costUsd: out.costUsd,
      status: out.status,
    });

    if (cfg.inject !== "none" && out.verdictPath) {
      pi.sendMessage(
        { customType: "debate", content: out.summary },
        { deliverAs: cfg.inject === "followUp" ? "followUp" : "nextTurn" },
      );
    }
  }

  pi.registerCommand("debate", {
    description: "Multi-model debate: red-team a plan, spec, or idea",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "status", label: "status", description: "Round, elapsed, tokens, cost, open high-severity" },
        { value: "abort", label: "abort", description: "Kill children and mark the run aborted" },
        { value: "resume", label: "resume", description: "Continue a crashed run: resume <run-id>" },
        { value: "last", label: "last", description: "Print the last verdict summary" },
        { value: "runs", label: "runs", description: "List runs with status and cost" },
        { value: "--mode review", label: "--mode review", description: "Force review mode (document/plan)" },
        { value: "--mode explore", label: "--mode explore", description: "Force explore mode (short idea)" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const { config, warnings } = loadConfig(ctx.cwd, ctx.isProjectTrusted?.() ?? true);
      for (const w of warnings) say(ctx as never, `debate config: ${w}`, "warn");

      const cmd = parseCommand(args);

      switch (cmd.kind) {
        case "help":
          say(ctx as never, HELP_TEXT);
          return;

        case "error":
          say(ctx as never, `debate: ${cmd.message}`, "error");
          return;

        case "status": {
          if (!active) { say(ctx as never, "debate: no active run"); return; }
          const p = active.progress;
          say(ctx as never, p
            ? `debate ${p.runId} · ${p.phase} · ${fmtDuration(p.elapsedMs)} · ` +
              `$${p.costUsd.toFixed(4)} · ${p.tokens} tok · open high ${p.openHigh}` +
              (p.costTrusted ? "" : " · cost understated")
            : `debate ${active.runId} · starting`);
          return;
        }

        case "abort": {
          if (!active) { say(ctx as never, "debate: no active run to abort"); return; }
          const id = active.runId;
          active.orch.abort();
          await active.runner.killAll();
          say(ctx as never, `debate: aborted ${id}`, "warn");
          return;
        }

        case "runs": {
          const runs = listRuns(ctx.cwd);
          if (runs.length === 0) { say(ctx as never, "debate: no runs yet"); return; }
          const lines = runs.map((r) => {
            const cost = typeof r.costUsd === "number" ? `$${r.costUsd.toFixed(4)}` : "$-";
            return `${r.runId}  ${String(r.status).padEnd(9)} ${String(r.mode ?? "-").padEnd(7)} ${cost}`;
          });
          say(ctx as never, ["run-id                status    mode    cost", ...lines].join("\n"));
          return;
        }

        case "last": {
          const runs = listRuns(ctx.cwd);
          const done = runs.find((r) => r.status !== "unreadable");
          if (!done) { say(ctx as never, "debate: no runs yet"); return; }
          const vp = join(ctx.cwd, "debate_verdict.md");
          if (existsSync(vp)) {
            const text = readFileSync(vp, "utf8");
            say(ctx as never, text.split("\n").slice(0, 40).join("\n"));
          } else {
            say(ctx as never, `debate: last run ${done.runId} (${done.status}); no verdict file`);
          }
          return;
        }

        case "resume": {
          if (!cmd.runId) {
            say(ctx as never, "debate: resume needs a run-id (see /debate runs)", "error");
            return;
          }
          if (active) {
            say(ctx as never, `debate: already running (${active.runId})`, "error");
            return;
          }
          const p = runPaths(ctx.cwd, cmd.runId);
          if (!existsSync(p.manifest)) {
            say(ctx as never, `debate: no such run: ${cmd.runId}`, "error");
            return;
          }
          const runner = makeRunner(config);
          const orch = new Orchestrator({
            workspace: ctx.cwd, cfg: config, runner, personaDir: PERSONA_DIR,
            onProgress: (pr) => { if (active) active.progress = pr; renderProgress(ctx, pr); },
          });
          active = { runId: cmd.runId, orch, runner, progress: null };
          try {
            const out = await orch.resume(cmd.runId);
            deliver(ctx, out, config);
          } catch (e) {
            say(ctx as never, `debate: resume failed: ${(e as Error).message}`, "error");
          } finally {
            await runner.killAll();
            clearProgress(ctx);
            active = null;
          }
          return;
        }

        case "run": {
          if (active) {
            say(ctx as never, `debate: already running (${active.runId})`, "error");
            return;
          }
          let seedText = cmd.seed;
          let seedSource = "inline";
          if (cmd.seedFile) {
            try {
              const f = readSeedFile(ctx.cwd, cmd.seedFile);
              seedText = f.text;
              seedSource = f.path;
            } catch (e) {
              say(ctx as never, `debate: ${(e as Error).message}`, "error");
              return;
            }
          }
          const mode = selectMode(config, {
            seed: seedText, seedFile: cmd.seedFile, override: cmd.mode,
          });
          say(ctx as never,
            `debate: starting ${mode} run · seed ${seedText.length} chars · ` +
            `cap $${config.budget.usd}/run $${config.budget.perTurnUsd}/turn`);
          try {
            const out = await execute(ctx, config, { seedText, seedSource, mode });
            deliver(ctx, out, config);
          } catch (e) {
            say(ctx as never, `debate: run failed: ${(e as Error).message}`, "error");
          }
          return;
        }
      }
    },
  });

  pi.registerTool({
    name: "debate_run",
    label: "Debate",
    description:
      "Run a structured multi-model debate (Ideator vs Skeptic, independent Synthesizer) " +
      "over a plan, spec, or idea and return a verdict with a claim ledger.",
    promptSnippet: "Run a multi-model debate/red-team over a plan or idea",
    promptGuidelines: [
      "Use debate_run when the user asks for a multi-model review, red-team, or debate of a plan, spec, or idea.",
    ],
    parameters: Type.Object({
      seed: Type.Optional(Type.String({ description: "Inline text to debate" })),
      seedFile: Type.Optional(Type.String({ description: "Path to a file to debate" })),
      mode: Type.Optional(StringEnum(["review", "explore"] as const)),
      rounds: Type.Optional(Type.Number({ description: "Max rounds, 2 or 3" })),
      dryRun: Type.Optional(
        Type.Boolean({ description: "Plan the run and estimate cost without invoking any model" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { config } = loadConfig(ctx.cwd, ctx.isProjectTrusted?.() ?? true);

      if (!params.seed && !params.seedFile) {
        return {
          content: [{ type: "text", text: "debate_run requires either `seed` or `seedFile`." }],
          isError: true,
          details: { error: "missing_seed" },
        };
      }
      if (active) {
        return {
          content: [{ type: "text", text: `A debate is already running (${active.runId}).` }],
          details: { status: "busy", runId: active.runId },
        };
      }

      let seedText = params.seed ?? "";
      let seedSource = "inline";
      if (params.seedFile) {
        try {
          const f = readSeedFile(ctx.cwd, params.seedFile);
          seedText = f.text;
          seedSource = f.path;
        } catch (e) {
          return {
            content: [{ type: "text", text: (e as Error).message }],
            isError: true,
            details: { error: "seed_not_found" },
          };
        }
      }
      const mode = selectMode(config, {
        seed: seedText,
        seedFile: params.seedFile ?? null,
        override: (params.mode as Mode | undefined) ?? null,
      });

      // §9.2 dryRun: resolve the plan and estimate cost WITHOUT invoking any model.
      if (params.dryRun) {
        const rounds = params.rounds ?? config.rounds.max;
        const turns = mode === "review" ? 2 * rounds + 1 : 2 * rounds;
        // §4.1 order-of-magnitude figures, refined by WP4 measurements.
        const estLow = turns * 0.5, estHigh = turns * 2;
        const plan = [
          `mode: ${mode}`,
          `seed: ${seedSource} (${seedText.length} chars)`,
          `models: ideator=${config.models.ideator}`,
          `        skeptic=${config.models.skeptic}`,
          `        synthesizer=${config.models.synthesizer}`,
          `max model turns: ${turns} (+ up to ${config.repairs.max} repairs)`,
          `estimated cost: $${estLow.toFixed(2)}-$${estHigh.toFixed(2)} against a $${config.budget.usd} cap`,
          `per-turn ceiling: $${config.budget.perTurnUsd} / ${config.budget.perTurnTokens} tokens`,
        ].join("\n");
        return {
          content: [{ type: "text", text: plan }],
          details: { status: "dryRun", mode, turns, estLow, estHigh, seedChars: seedText.length },
        };
      }

      const out = await execute(ctx as never, config, {
        seedText, seedSource, mode, rounds: params.rounds,
      });
      return {
        content: [{ type: "text", text: out.summary }],
        details: {
          runId: out.runId,
          status: out.status,
          verdictPath: out.verdictPath,
          summary: out.summary,
          openHighSeverity: out.openHighSeverity,
          costUsd: out.costUsd,
        },
      };
    },
  });

  // §9.4: kill children and mark the active run aborted.
  pi.on("session_shutdown", async () => {
    if (!active) return;
    active.orch.abort();
    await active.runner.killAll();
    active = null;
  });

  // §9.4: sweep runs left `running` by a crashed session; mark them aborted (resumable).
  pi.on("session_start", async (_event, ctx) => {
    try {
      for (const r of listRuns(ctx.cwd)) {
        if (r.status !== "running") continue;
        const m = readManifest(r.manifestPath);
        m.status = "aborted";
        (m.notes ??= []).push("Marked aborted by session_start sweep: the owning session died.");
        writeManifest(r.manifestPath, m);
      }
    } catch { /* never block startup on a sweep */ }
  });
}
