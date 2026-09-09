/**
 * Multi-agent debate — pi extension (D1).
 *
 * Registration and wiring only. The protocol lives in orchestrator.ts, the data
 * contract in ledger.ts, the child process handling in runner/.
 *
 * WP4 state: `/debate` and `debate_run` execute real runs through the direct runner.
 * Full UI polish (live widget, injection modes, stale-run sweep) is WP6.
 */

import type {
  ExtensionAPI, ExtensionCommandContext, ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULTS, loadConfig, resolveAllRoles, type DebateConfig, type Mode } from "./config.ts";
import { runSetupWizard } from "./setup.ts";
import { listRuns, newRunId, runPaths } from "./paths.ts";
import { parseCommand, selectMode, readSeedFile, estimateRun, HELP_TEXT } from "./command.ts";
import { Orchestrator, sweepStaleRuns, type Progress, type RunOutcome } from "./orchestrator.ts";
import { DirectRunner, type DirectStreamEvent } from "./runner/direct.ts";
import { FakeRunner } from "./runner/fake.ts";
import type { TurnRunner } from "./runner/types.ts";
import { readManifest, writeManifest } from "./manifest.ts";
import { openAtOrAbove } from "./ledger.ts";

const PERSONA_DIR = join(import.meta.dirname, "personas");

function makeRunner(cfg: DebateConfig, onEvent?: (ev: DirectStreamEvent) => void): TurnRunner {
  switch (cfg.runner) {
    case "fake":
      // Only reachable if someone sets runner:"fake" in config; keeps tests honest.
      return new FakeRunner({ fixtures: {} });
    case "harness":
      throw new Error(
        'runner "harness" is not implemented yet (WP7). Use "direct" or "fake".',
      );
    default:
      return new DirectRunner({ onEvent });
  }
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

interface ActiveRun {
  runId: string;
  orch: Orchestrator;
  runner: TurnRunner;
  progress: Progress | null;
  /** Ephemeral child-stream data; never used for accounting or persisted. */
  stream: DirectStreamEvent | null;
  startedAtMs: number;
  /** Limit stream-driven redraws; pi may emit many token updates per second. */
  lastRenderMs: number;
  ticker: ReturnType<typeof setInterval> | null;
}

export default function (pi: ExtensionAPI) {
  /** §9.2: one run at a time. */
  let active: ActiveRun | null = null;

  const say = (
    ctx: { hasUI: boolean; ui: { notify: (m: string, l: "info" | "warn" | "error") => void } },
    text: string,
    level: "info" | "warn" | "error" = "info",
  ): void => {
    // §9.3: guard every UI call; the extension must still work in --mode json and -p.
    if (ctx.hasUI) ctx.ui.notify(text, level);
    else process.stdout.write(text + "\n");
  };

  /** A concise human label for the phase stored in the manifest. */
  function displayPhase(p: Progress | null): string {
    if (!p) return "Starting";
    if (p.role && p.round) return `Round ${p.round} · ${p.role}`;
    return p.phase === "done" ? "Finishing verdict" : p.phase;
  }

  /**
   * Persistent, self-refreshing live view. The previous widget updated only at turn
   * boundaries, so a five-minute Skeptic turn looked frozen. `stream` is deliberately
   * labelled live/estimated: manifest totals remain the sole accounting source.
   */
  function renderLive(ctx: ExtensionCommandContext, force = false): void {
    if (!ctx.hasUI || !active) return;
    const a = active;
    const now = Date.now();
    // `message_update` can arrive for every streamed token. Four redraws per second is
    // visually live without making the TUI spend its time repainting itself.
    if (!force && now - a.lastRenderMs < 250) return;
    a.lastRenderMs = now;
    const p = a.progress;
    const elapsedMs = now - a.startedAtMs;
    const completedCost = p?.costUsd ?? 0;
    const completedTokens = p?.tokens ?? 0;
    const costTrusted = p?.costTrusted ?? true;
    const cost = `${costTrusted ? "$" : "$"}${completedCost.toFixed(2)}${costTrusted ? "" : "?"}`;
    const phase = displayPhase(p);
    ctx.ui.setStatus("debate", `RUNNING · ${phase} · ${fmtDuration(elapsedMs)} · ${cost}`);

    const lines = [
      "◆ Debate running",
      `  ${phase}  ·  elapsed ${fmtDuration(elapsedMs)}  ·  completed ${cost}`,
      `  ${completedTokens.toLocaleString()} completed tokens`,
    ];
    if (a.stream) {
      const streamCost = a.stream.usageSoFar.cost.total;
      const streamTokens = a.stream.usageSoFar.totalTokens;
      const activity = a.stream.type === "tool_execution_start" && a.stream.toolName
        ? ` · using ${a.stream.toolName}`
        : "";
      lines.push(
        `  Current turn (live): ${a.stream.messageCount} request(s) · ` +
        `${streamTokens.toLocaleString()} tokens · $${streamCost.toFixed(2)}${activity}`,
      );
    }
    if ((p?.openHigh ?? 0) > 0) lines.push(`  ${p!.openHigh} open high-severity finding(s)`);
    if ((p?.lintCount ?? 0) > 0) lines.push(`  ${p!.lintCount} lint warning(s)`);
    lines.push("  /debate abort to stop · /debate status to refresh this view");
    ctx.ui.setWidget("debate", lines);
  }

  function renderProgress(ctx: ExtensionCommandContext, p: Progress): void {
    if (active) active.progress = p;
    renderLive(ctx, true);
  }

  function startLiveTicker(ctx: ExtensionCommandContext): void {
    if (!active) return;
    renderLive(ctx, true);
    active.ticker = setInterval(() => renderLive(ctx, true), 1_000);
  }

  function clearProgress(
    ctx: ExtensionContext,
    running: ActiveRun | null = active,
  ): void {
    if (running?.ticker) {
      clearInterval(running.ticker);
      running.ticker = null;
    }
    // Detach first: a heartbeat callback already queued on the event loop must see no
    // active run and return instead of repainting immediately after this clear.
    if (active === running) active = null;
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("debate", undefined);
    ctx.ui.setWidget("debate", undefined);
  }

  /** Shared by the command and the tool. */
  async function execute(
    ctx: ExtensionCommandContext,
    cfg: DebateConfig,
    opts: { seedText: string; seedSource: string; mode: Mode; rounds?: number },
  ): Promise<RunOutcome> {
    const runId = newRunId();
    // The runner is constructed before the orchestrator, so route stream events through
    // this closure once `active` exists. Stream usage is UI-only; manifest totals update
    // only when a turn completes.
    const runner = makeRunner(cfg, (event) => {
      if (active?.runId !== runId) return;
      active.stream = event;
      renderLive(ctx);
    });
    const orch = new Orchestrator({
      workspace: ctx.cwd, cfg, runner, personaDir: PERSONA_DIR,
      onProgress: (p) => renderProgress(ctx, p),
    });
    active = {
      runId, orch, runner, progress: null, stream: null,
      startedAtMs: Date.now(), lastRenderMs: 0, ticker: null,
    };
    startLiveTicker(ctx);
    try {
      return await orch.start(runId, opts);
    } finally {
      await runner.killAll();
      clearProgress(ctx);
    }
  }

  /** Put the verdict in front of the user and, per config, into the next prompt. */
  function deliver(ctx: ExtensionCommandContext, out: RunOutcome, cfg: DebateConfig): void {
    say(ctx as never, out.summary, out.status === "complete" ? "info" : "warn");

    if (cfg.inject !== "none" && out.verdictPath) {
      // The summary alone is not the verdict. Inject the actual verdict document so the
      // next prompt carries the decision, unresolved items and minority report — WP6's
      // acceptance is that the next prompt "demonstrably has the verdict in context".
      let injected = out.summary;
      try {
        const body = readFileSync(out.verdictPath, "utf8");
        if (body.trim()) injected = `${out.summary}\n\n${body}`;
      } catch {
        // Fall back to the summary; a missing verdict file must not break the turn.
      }
      pi.sendMessage(
        { customType: "debate", content: injected, display: false },
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
        { value: "artifact", label: "artifact", description: "Create corrected draft: artifact [run-id]" },
        { value: "last", label: "last", description: "Print the last verdict summary" },
        { value: "runs", label: "runs", description: "List runs with status and cost" },
        { value: "setup", label: "setup", description: "Guided config + topic wizard (models, budgets, confirmation)" },
        { value: "help", label: "help", description: "Show command syntax and subcommands" },
        { value: "--mode review", label: "--mode review", description: "Force review mode (document/plan)" },
        { value: "--mode explore", label: "--mode explore", description: "Force explore mode (short idea)" },
      ];
      const filtered = items.filter((i) => i.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cmd = parseCommand(args);
      let config: DebateConfig;
      let warnings: string[];
      try {
        ({ config, warnings } = loadConfig(ctx.cwd, ctx.isProjectTrusted?.() ?? true));
      } catch (e) {
        // A hard config error must not lock the user out of `/debate setup`, the very
        // command that can repair it. Other commands fail closed rather than running
        // with a cap we could not parse.
        if (cmd.kind !== "setup") {
          say(ctx as never, `debate config: ${(e as Error).message}`, "error");
          return;
        }
        config = JSON.parse(JSON.stringify(DEFAULTS)) as DebateConfig;
        warnings = [`invalid config ignored for setup only: ${(e as Error).message}`];
      }
      for (const w of warnings) say(ctx as never, `debate config: ${w}`, "warn");

      switch (cmd.kind) {
        case "help":
          say(ctx as never, HELP_TEXT);
          return;

        case "error":
          say(ctx as never, `debate: ${cmd.message}`, "error");
          return;

        case "setup": {
          if (!ctx.hasUI) {
            say(ctx as never, "debate: setup needs interactive UI; use /debate <text>, /debate @file, or edit config manually.", "warn");
            return;
          }
          if (active) {
            say(ctx as never, `debate: already running (${active.runId})`, "error");
            return;
          }
          let setup;
          try {
            setup = await runSetupWizard(ctx, config, (projectTrusted) =>
              loadConfig(ctx.cwd, projectTrusted).config,
            );
          } catch (e) {
            say(ctx as never, `debate: setup failed: ${(e as Error).message}`, "error");
            return;
          }
          if (!setup) return;
          const mode = selectMode(setup.config, {
            seed: setup.seedText, seedFile: setup.seedSource === "setup editor" ? null : setup.seedSource,
            override: null,
          });
          say(ctx as never,
            `debate: starting ${mode} run from setup · seed ${setup.seedText.length} chars · ` +
            `cap $${setup.config.budget.usd}/run $${setup.config.budget.perTurnUsd}/turn`);
          try {
            const out = await execute(ctx, setup.config, {
              seedText: setup.seedText, seedSource: setup.seedSource, mode,
            });
            deliver(ctx, out, setup.config);
          } catch (e) {
            say(ctx as never, `debate: run failed: ${(e as Error).message}`, "error");
          }
          return;
        }

        case "status": {
          if (active) {
            renderLive(ctx, true);
            const p = active.progress;
            say(ctx as never, p
              ? `debate is running · ${displayPhase(p)} · ${fmtDuration(Date.now() - active.startedAtMs)} · ` +
                `$${p.costUsd.toFixed(4)} completed · ${p.tokens} completed tokens`
              : `debate is starting · ${active.runId}`);
            return;
          }
          // Status should still be useful after a run ends. Avoid dumping the entire
          // verdict (that is `/debate last`); give the one-line run state instead. It is
          // a query, not a persistent mode, so remove any stale live UI first.
          clearProgress(ctx, null);
          const last = listRuns(ctx.cwd).find((r) => r.status !== "unreadable");
          if (!last) { say(ctx as never, "debate: no runs yet"); return; }
          const cost = typeof last.costUsd === "number" ? `$${last.costUsd.toFixed(4)}` : "$-";
          const idle = `last ${last.runId} · ${last.status} · ${last.mode ?? "-"} · ${cost}`;
          let diagnosis: string | null = null;
          try {
            const manifest = readManifest(last.manifestPath);
            const failedSkeptic = [...manifest.turns].reverse().find(
              (turn) => turn.role === "skeptic" && turn.status !== "ok" && turn.stderrTail,
            );
            if (failedSkeptic?.stderrTail) {
              diagnosis = `Skeptic failed: ${failedSkeptic.stderrTail.slice(0, 220)}`;
            } else if (manifest.artifact?.reason) {
              diagnosis = `Corrected draft: not produced (${manifest.artifact.reason})`;
            }
          } catch { /* listRuns already reported an otherwise readable run */ }
          say(ctx as never,
            `debate: no run is active · ${idle}.` +
            (diagnosis ? ` ${diagnosis}` : " Use /debate last for its verdict."));
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

        case "artifact": {
          if (!ctx.hasUI) {
            say(ctx as never, "debate: artifact generation needs interactive confirmation because it invokes a model.", "warn");
            return;
          }
          if (active) {
            say(ctx as never, `debate: already running (${active.runId})`, "error");
            return;
          }
          const target = cmd.runId ?? listRuns(ctx.cwd).find((r) => r.status !== "unreadable")?.runId;
          if (!target) { say(ctx as never, "debate: no completed review to turn into a draft", "error"); return; }
          const p = runPaths(ctx.cwd, target);
          if (!existsSync(p.manifest)) { say(ctx as never, `debate: no such run: ${target}`, "error"); return; }
          if (!await ctx.ui.confirm(
            "Create corrected draft?",
            `This runs one bounded editor model turn for review ${target}. It writes a separate draft and never changes the source file.`,
          )) return;
          const runner = makeRunner(config, (event) => {
            if (active?.runId !== target) return;
            active.stream = event;
            renderLive(ctx);
          });
          const orch = new Orchestrator({
            workspace: ctx.cwd, cfg: config, runner, personaDir: PERSONA_DIR,
            onProgress: (pr) => renderProgress(ctx, pr),
          });
          active = {
            runId: target, orch, runner, progress: null, stream: null,
            startedAtMs: Date.now(), lastRenderMs: 0, ticker: null,
          };
          startLiveTicker(ctx);
          try {
            const out = await orch.artifact(target);
            say(ctx as never, out.artifactPath
              ? `debate: corrected draft (human review required): ${out.artifactPath}`
              : `debate: corrected draft was not produced${out.reason ? ` (${out.reason})` : ""}`, out.artifactPath ? "info" : "warn");
          } catch (e) {
            say(ctx as never, `debate: artifact generation failed: ${(e as Error).message}`, "error");
          } finally {
            await runner.killAll();
            clearProgress(ctx);
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
          const runner = makeRunner(config, (event) => {
            if (active?.runId !== cmd.runId) return;
            active.stream = event;
            renderLive(ctx);
          });
          const orch = new Orchestrator({
            workspace: ctx.cwd, cfg: config, runner, personaDir: PERSONA_DIR,
            onProgress: (pr) => renderProgress(ctx, pr),
          });
          active = {
            runId: cmd.runId, orch, runner, progress: null, stream: null,
            startedAtMs: Date.now(), lastRenderMs: 0, ticker: null,
          };
          startLiveTicker(ctx);
          try {
            const out = await orch.resume(cmd.runId);
            deliver(ctx, out, config);
          } catch (e) {
            say(ctx as never, `debate: resume failed: ${(e as Error).message}`, "error");
          } finally {
            await runner.killAll();
            clearProgress(ctx);
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
        const debateTurns = mode === "review" ? 2 * rounds + 1 : 2 * rounds;
        const artifactTurns = mode === "review" && config.artifact.enabled ? 1 : 0;
        const turns = debateTurns + artifactTurns;
        // Resolve per role: `config.models.*` is nulled out when a tier is active
        // (applyTier moves the model into roles.<r>.model), so printing it showed
        // "null" for every tiered roster.
        const roles = resolveAllRoles(config);

        const est = estimateRun({
          mode, rounds, seedChars: seedText.length,
          roles: [roles.ideator, roles.skeptic, roles.synthesizer],
        });
        const { estLow, estHigh, billsNothing: allFree } = est;

        const costLine = allFree
          ? "estimated cost: $0.00 - every role is on a provider that bills nothing " +
            "(USD caps cannot bind here; token and time caps are the real limits)"
          : `estimated cost: $${estLow.toFixed(2)}-$${estHigh.toFixed(2)} ` +
            `(scaled from measured runs) against a $${config.budget.usd} cap`;

        const plan = [
          `mode: ${mode}`,
          `seed: ${seedSource} (${seedText.length} chars)`,
          `models: ideator=${roles.ideator.ref}`,
          `        skeptic=${roles.skeptic.ref}`,
          `        synthesizer=${roles.synthesizer.ref}`,
          `max model turns: ${turns} (+ up to ${config.repairs.max} repairs)`,
          costLine + (artifactTurns ? " + one corrected-draft editor turn" : ""),
          `per-turn ceiling: $${config.budget.perTurnUsd} / ${config.budget.perTurnTokens} tokens`,
          `time cap: ${config.timeouts.totalMs / 1000}s total, ` +
            `${config.timeouts.turnMs / 1000}s per turn, ` +
            `+${config.timeouts.verdictGraceMs / 1000}s verdict grace`,
        ].join("\n");
        return {
          content: [{ type: "text", text: plan }],
          details: {
            status: "dryRun", mode, turns, artifactTurns, estLow, estHigh,
            seedChars: seedText.length, billsNothing: allFree,
          },
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
          artifactPath: out.artifactPath,
          summary: out.summary,
          openHighSeverity: out.openHighSeverity,
          costUsd: out.costUsd,
        },
      };
    },
  });

  // §9.4: kill children and mark the active run aborted.
  pi.on("session_shutdown", async (_event, ctx) => {
    const running = active;
    if (running) {
      running.orch.abort();
      await running.runner.killAll();
    }
    // Clear even when no run is active: this removes UI left by an older extension
    // version during /reload, session switches, or a previously missed cleanup.
    clearProgress(ctx, running);
  });

  // §9.4: sweep runs left `running` by a crashed session; mark them aborted (resumable).
  // Logic lives in orchestrator.ts so it is testable (§13.21).
  pi.on("session_start", async (_event, ctx) => {
    clearProgress(ctx, null);
    sweepStaleRuns(ctx.cwd);
  });
}
