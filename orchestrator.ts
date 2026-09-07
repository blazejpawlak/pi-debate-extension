/**
 * orchestrator.ts — the protocol state machine (§5), budgets (§4.1/D9), stop rules,
 * repair, early abort, and resume (§8.6).
 *
 * Everything in §5.1 is enforced here or in ledger.ts, never left to a prompt.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  type DebateConfig, type Mode, resolveRoleModel, resolveRole, splitModelRef,
  type ResolvedRole,
} from "./config.ts";
import {
  emptyLedger, extractLedgerBlock, normalizeTurnPayload, mergeTurn,
  gateWantsAnotherRound, anonymizeForJudge, openAtOrAbove,
  type Ledger, type Author,
} from "./ledger.ts";
import { buildExcerpts } from "./excerpts.ts";
import { buildMission, assertMissionSafe } from "./prompts.ts";
import {
  newManifest, writeManifest, readManifest, recomputeTotals, appendEvent,
  type Manifest, type RunStatus, type TurnRecord,
} from "./manifest.ts";
import { ensureRunDirs, runPaths, turnFileName, type RunPaths } from "./paths.ts";
import { buildVerdict, writeVerdict, appendLessons, buildSummary } from "./verdict.ts";
import type { Role, Round, TurnRequest, TurnResult, TurnRunner } from "./runner/types.ts";

export interface OrchestratorOptions {
  workspace: string;
  cfg: DebateConfig;
  runner: TurnRunner;
  personaDir: string;
  /** Injected for tests. */
  now?: () => number;
  onProgress?: (p: Progress) => void;
  signal?: AbortSignal;
}

export interface Progress {
  runId: string;
  phase: string;
  round: Round | null;
  role: Role | null;
  elapsedMs: number;
  costUsd: number;
  tokens: number;
  openHigh: number;
  lintCount: number;
  costTrusted: boolean;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  verdictPath: string | null;
  summary: string;
  openHighSeverity: number;
  costUsd: number;
  ledger: Ledger;
  manifest: Manifest;
}

export interface StartOptions {
  seedText: string;
  seedSource: string;
  mode: Mode;
  /** Overrides cfg.rounds.max when provided. */
  rounds?: number;
}

const AUTHOR_OF: Record<"ideator" | "skeptic", Author> = { ideator: "A", skeptic: "B" };

/** Which roles speak, in order, for a given round and mode (§5). */
export function roundPlan(mode: Mode, round: 1 | 2 | 3): {
  roles: ("ideator" | "skeptic")[];
  parallel: boolean;
} {
  if (round === 1) {
    // review: blind parallel R1 (D7). explore: Ideator only.
    return mode === "review"
      ? { roles: ["ideator", "skeptic"], parallel: true }
      : { roles: ["ideator"], parallel: false };
  }
  // §5: review R2+ is Ideator-first (responding to R1 criticism); explore R2+ is
  // Skeptic-first, because the Skeptic has not spoken yet and running the Ideator
  // twice in a row would waste a turn on nothing new.
  return mode === "review"
    ? { roles: ["ideator", "skeptic"], parallel: false }
    : { roles: ["skeptic", "ideator"], parallel: false };
}

export class Orchestrator {
  private cfg: DebateConfig;
  private runner: TurnRunner;
  private workspace: string;
  private personaDir: string;
  private now: () => number;
  private onProgress?: (p: Progress) => void;
  private externalSignal?: AbortSignal;

  private paths!: RunPaths;
  private manifest!: Manifest;
  private ledger!: Ledger;
  private seedText = "";
  private startedAtMs = 0;
  private abortController = new AbortController();
  private aborted = false;
  /** Verdict body from the Synthesizer, kept for the summary. */
  private verdictBody: string | null = null;
  /** Resolved per-role config, computed once (§13.28). */
  private roles = new Map<Role, ResolvedRole>();

  /** Resolved config for a role, including its own budget and tool set. */
  private role(role: Role): ResolvedRole {
    let r = this.roles.get(role);
    if (!r) {
      r = resolveRole(this.cfg, role, this.personaModel(role));
      this.roles.set(role, r);
    }
    return r;
  }

  /** Cumulative USD + tokens this role has spent so far in this run (§13.28). */
  private roleSpend(role: Role): { usd: number; tokens: number } {
    let usd = 0, tokens = 0;
    for (const t of this.manifest.turns) {
      if (t.role !== role || !t.usage) continue;
      usd += t.usage.cost.total;
      tokens += t.usage.totalTokens;
    }
    return { usd, tokens };
  }

  constructor(opts: OrchestratorOptions) {
    this.cfg = opts.cfg;
    this.runner = opts.runner;
    this.workspace = opts.workspace;
    this.personaDir = opts.personaDir;
    this.now = opts.now ?? (() => Date.now());
    this.onProgress = opts.onProgress;
    this.externalSignal = opts.signal;
  }

  get runId(): string { return this.manifest?.runId; }
  get currentLedger(): Ledger { return this.ledger; }
  get currentManifest(): Manifest { return this.manifest; }

  abort(): void {
    this.aborted = true;
    this.abortController.abort();
  }

  // ------------------------------------------------------------------
  // Entry points
  // ------------------------------------------------------------------

  /** INIT + full protocol (§5). */
  async start(runId: string, opts: StartOptions): Promise<RunOutcome> {
    this.paths = runPaths(this.workspace, runId);
    ensureRunDirs(this.paths);
    this.seedText = opts.seedText;
    this.startedAtMs = this.now();

    const models: Record<string, string> = {};
    for (const role of ["ideator", "skeptic", "synthesizer"] as const) {
      models[role] = this.role(role).ref;
    }

    this.manifest = newManifest({
      runId, mode: opts.mode, seedSource: opts.seedSource, models,
      runner: this.cfg.runner, cfg: this.cfg,
    });
    if (opts.rounds) this.manifest.budgets = { ...this.manifest.budgets };

    writeFileSync(this.paths.seed, opts.seedText);
    this.ledger = emptyLedger(runId, opts.mode);
    writeFileSync(this.paths.ledger, JSON.stringify(this.ledger, null, 2));
    writeManifest(this.paths.manifest, this.manifest);
    appendEvent(this.paths.events, "run_start", {
      runId, mode: opts.mode, seedSource: opts.seedSource,
      seedChars: opts.seedText.length, models, runner: this.cfg.runner,
    });

    return this.drive(opts.mode, opts.rounds ?? this.cfg.rounds.max);
  }

  /** §8.6 resume: replay from the first turn that is absent or unmerged. */
  async resume(runId: string): Promise<RunOutcome> {
    this.paths = runPaths(this.workspace, runId);
    if (!existsSync(this.paths.manifest)) throw new Error(`no such run: ${runId}`);
    this.manifest = readManifest(this.paths.manifest);
    this.seedText = existsSync(this.paths.seed) ? readFileSync(this.paths.seed, "utf8") : "";
    this.ledger = existsSync(this.paths.ledger)
      ? (JSON.parse(readFileSync(this.paths.ledger, "utf8")) as Ledger)
      : emptyLedger(runId, this.manifest.mode);
    this.startedAtMs = this.now() - this.manifest.totals.durationMs;
    this.manifest.status = "running";
    this.manifest.resumedFrom = runId;

    appendEvent(this.paths.events, "run_resume", {
      runId,
      turnsOnDisk: this.manifest.turns.length,
      unmerged: this.manifest.turns.filter((t) => !t.merged).map((t) => `${t.round}-${t.role}`),
    });

    // Re-merge any completed-but-unmerged turn from disk, without a model call (§8.6).
    for (const rec of this.manifest.turns) {
      if (rec.merged || rec.round === "verdict" || rec.status !== "ok") continue;
      const file = join(this.paths.turnsDir, turnFileName(rec.round, rec.role));
      if (!existsSync(file)) continue;
      const text = readFileSync(file, "utf8");
      appendEvent(this.paths.events, "remerge_from_disk", { round: rec.round, role: rec.role });
      if (this.mergeTurnText(text, rec.round as 1 | 2 | 3, rec.role as "ideator" | "skeptic")) {
        rec.merged = true;
        this.commitLedger();
      }
    }
    writeManifest(this.paths.manifest, this.manifest);

    return this.drive(this.manifest.mode as Mode, this.cfg.rounds.max);
  }

  // ------------------------------------------------------------------
  // Protocol driver
  // ------------------------------------------------------------------

  private async drive(mode: Mode, maxRounds: number): Promise<RunOutcome> {
    try {
      for (const round of [1, 2, 3] as const) {
        if (round > maxRounds) break;

        // GATE before R3 (§5): only R3 is conditional.
        if (round === 3) {
          if (!gateWantsAnotherRound(this.ledger, this.cfg.rounds.gateSeverity)) {
            appendEvent(this.paths.events, "gate_closed", { round });
            this.note(`Gate closed after round 2: no open ${this.cfg.rounds.gateSeverity}+ claim.`);
            break;
          }
          appendEvent(this.paths.events, "gate_open", {
            round,
            openHigh: openAtOrAbove(this.ledger, this.cfg.rounds.gateSeverity).map((c) => c.id),
          });
        }

        const stop = this.budgetStop();
        if (stop) {
          appendEvent(this.paths.events, "budget_stop", { round, reason: stop });
          this.note(`Stopped before round ${round}: ${stop}.`);
          this.manifest.status = "partial";
          break;
        }

        const done = await this.runRound(mode, round);
        this.manifest.rounds = round;
        if (!done) break; // early abort or hard failure
        if (this.aborted) break;
      }

      if (this.aborted) {
        this.manifest.status = "aborted";
        this.note("Run aborted by user.");
      }

      // §5.1 early abort: in review mode, if BOTH R1 turns failed there is nothing to
      // judge, and a verdict over an empty ledger is worse than no verdict.
      if (this.manifest.status === "failed") {
        return this.finalize(null);
      }
      if (this.aborted) {
        return this.finalize(null);
      }

      return this.finalize(await this.runVerdict(mode));
    } catch (e) {
      appendEvent(this.paths.events, "run_error", { error: (e as Error).message });
      this.manifest.status = this.manifest.status === "running" ? "failed" : this.manifest.status;
      this.note(`Orchestrator error: ${(e as Error).message}`);
      return this.finalize(null);
    }
  }

  /** Returns false when the protocol must stop (early abort). */
  private async runRound(mode: Mode, round: 1 | 2 | 3): Promise<boolean> {
    const plan = roundPlan(mode, round);
    const results: { role: "ideator" | "skeptic"; result: TurnResult }[] = [];

    // §8.6 resume: a turn already completed AND merged is never re-run or re-paid for.
    const remaining = plan.roles.filter((role) => !this.isTurnDone(round, role));
    if (remaining.length === 0) {
      appendEvent(this.paths.events, "round_skipped", { round, reason: "all turns already merged" });
      return true;
    }
    if (remaining.length < plan.roles.length) {
      appendEvent(this.paths.events, "round_partial_replay", { round, remaining });
    }

    if (plan.parallel && remaining.length > 1) {
      // R1 review: blind and parallel — neither debater sees the other's output (D7).
      // A role already over its own budget is dropped from the parallel batch.
      const affordable = remaining.filter((role) => {
        const rs = this.roleBudgetStop(role);
        if (rs) {
          appendEvent(this.paths.events, "role_budget_stop", { round, role, reason: rs });
          this.note(`Skipped ${round}-${role}: ${rs}.`);
        }
        return !rs;
      });
      const settled = await Promise.all(
        affordable.map(async (role) => ({ role, ...(await this.doTurn(round, role)) })),
      );
      // Merge in a deterministic order so ids are stable regardless of which child
      // finished first. Ideator is always author A.
      settled.sort((a, b) => (a.role === "ideator" ? 0 : 1) - (b.role === "ideator" ? 0 : 1));
      for (const s of settled) {
        results.push({ role: s.role, result: s.result });
        this.absorb(round, s.role, s.result, s.record);
      }
    } else {
      for (const role of remaining) {
        if (this.aborted) break;
        const stop = this.budgetStop();
        if (stop) {
          appendEvent(this.paths.events, "budget_stop", { round, role, reason: stop });
          this.note(`Stopped mid-round ${round}: ${stop}.`);
          this.manifest.status = "partial";
          return false;
        }
        // §13.28: a spent-out role is skipped, but the round continues so the other
        // debater and the judge still get their turns.
        const roleStop = this.roleBudgetStop(role);
        if (roleStop) {
          appendEvent(this.paths.events, "role_budget_stop", { round, role, reason: roleStop });
          this.note(`Skipped ${round}-${role}: ${roleStop}.`);
          continue;
        }
        const { result, record } = await this.doTurn(round, role);
        results.push({ role, result });
        this.absorb(round, role, result, record);
      }
    }

    if (round === 1 && mode === "review" && remaining.length === 2) {
      const bothFailed = results.length === 2 && results.every((r) => r.result.status !== "ok");
      if (bothFailed) {
        appendEvent(this.paths.events, "early_abort", { reason: "both R1 turns failed" });
        this.note("Both round-1 turns failed; no verdict written (§5.1 early abort).");
        this.manifest.status = "failed";
        return false;
      }
      const oneFailed = results.find((r) => r.result.status !== "ok");
      if (oneFailed) {
        this.note(`Round-1 ${oneFailed.role} turn failed (${oneFailed.result.status}); continued with one debater.`);
      }
    }
    return true;
  }

  /** §8.6: has this turn already completed and been merged in a previous attempt? */
  private isTurnDone(round: Round, role: Role): boolean {
    return this.manifest.turns.some(
      (t) => t.round === round && t.role === role && t.status === "ok" && t.merged,
    );
  }

  /**
   * Run one turn, with the §5.1 repair-once path.
   * A turn is "unusable" when its ledger block is missing or invalid, or when the turn
   * itself failed/timed out/hit the cost ceiling.
   *
   * Every ATTEMPT is recorded in the manifest before we decide whether to repair,
   * because an attempt that was killed mid-flight has still been paid for (§7.1: run
   * cost is the sum over all assistant messages, including those of a turn we discard).
   * Recording only the surviving attempt silently under-charges the run and would
   * disable the very cap D9 exists to enforce.
   */
  private async doTurn(
    round: 1 | 2 | 3,
    role: "ideator" | "skeptic",
    repairNote?: string,
    truncated?: boolean,
  ): Promise<{ result: TurnResult; record: TurnRecord }> {
    const result = await this.invoke(round, role, repairNote, truncated);

    // Persist the raw turn text before anything else, so a crash cannot lose a paid turn.
    if (result.text) {
      writeFileSync(join(this.paths.turnsDir, turnFileName(round, role)), result.text);
    }

    // Charge the attempt now, merged:false (§8.6).
    const record = this.recordTurn(round, role, result, repairNote !== undefined);
    this.saveManifest();

    const block = extractLedgerBlock(result.text);
    const needsRepair = result.status !== "ok" || !block.ok;
    if (!needsRepair) return { result, record };

    if (!block.ok) {
      // NB: the data key is `blockCode`, not `code` — appendEvent spreads data after the
      // event code, so a `code` key here would silently overwrite the event name.
      appendEvent(this.paths.events, "ledger_block_unusable", {
        round, role, blockCode: block.code, detail: block.detail,
        repair: repairNote !== undefined,
      });
    }

    // Repairs are full model turns and are capped per run (§5.1).
    const alreadyRepairing = repairNote !== undefined;
    if (alreadyRepairing) {
      appendEvent(this.paths.events, "repair_failed", { round, role, status: result.status });
      return { result, record };
    }
    if (this.manifest.repairsUsed >= this.cfg.repairs.max) {
      appendEvent(this.paths.events, "repair_cap_reached", {
        round, role, cap: this.cfg.repairs.max,
      });
      this.note(`Repair cap (${this.cfg.repairs.max}) reached; ${round}-${role} skipped without retry.`);
      return { result, record };
    }
    const stop = this.budgetStop();
    if (stop) {
      appendEvent(this.paths.events, "repair_skipped_budget", { round, role, reason: stop });
      return { result, record };
    }

    const why = result.status !== "ok"
      ? `the turn ended with status ${result.status} (${result.stopReason ?? "no stopReason"})`
      : !block.ok ? block.detail : "unknown";

    this.manifest.repairsUsed++;
    appendEvent(this.paths.events, "repair_start", { round, role, reason: why });
    return this.doTurn(round, role, why, result.stopReason === "length");
  }

  /** Build the request and hand it to the runner. */
  private async invoke(
    round: Round,
    role: Role,
    repairNote?: string,
    truncated?: boolean,
  ): Promise<TurnResult> {
    const t0 = this.now();
    const isJudge = role === "synthesizer";
    const rr = this.role(role);

    const mission = buildMission({
      role, mode: this.manifest.mode as Mode, round, cfg: this.cfg,
      ledger: round === 1 ? null : this.ledger,
      lessons: role === "skeptic" ? this.readLessons() : null,
      repairNote: repairNote ?? null,
      truncated,
    });
    assertMissionSafe(mission);

    this.emitProgress(`${round} · ${role}`, round, role);

    const req: TurnRequest = {
      runId: this.manifest.runId,
      round, role,
      personaPath: join(this.personaDir, `${role}.md`),
      mission,
      cwd: this.workspace,
      // §13.28: tools/thinking/ceilings all come from the resolved role, so a per-role
      // override in config is honored without the orchestrator knowing the details.
      tools: rr.tools,
      thinking: rr.thinking,
      timeoutMs: rr.turnMs,
      signal: this.combinedSignal(),
      provider: rr.provider,
      model: rr.model,
      attachPath: isJudge ? this.paths.judgeExcerpts : this.paths.seed,
      perTurnUsd: rr.perTurnUsd,
      perTurnTokens: rr.perTurnTokens,
      extraArgs: this.cfg.children.extraArgs,
      contextFiles: this.cfg.children.contextFiles,
    };

    let result: TurnResult;
    try {
      result = await this.runner.run(req);
    } catch (e) {
      result = {
        text: "", usage: null, messageCount: 0, toolCalls: [],
        stopReason: "error", status: "failed",
        durationMs: this.now() - t0, exitCode: null,
        stderrTail: (e as Error).message,
      };
    }

    appendEvent(this.paths.events, "turn_end", {
      round, role, status: result.status, stopReason: result.stopReason,
      // §13.38: without this a transient provider failure is indistinguishable from a
      // prompt defect once the run has finished.
      ...(result.status !== "ok" && result.stderrTail
        ? { stderrTail: result.stderrTail.slice(-600) }
        : {}),
      durationMs: result.durationMs, messageCount: result.messageCount,
      tokens: result.usage?.totalTokens ?? 0,
      costUsd: result.usage?.cost.total ?? 0,
      cacheRead: result.usage?.cacheRead ?? 0,
      toolCalls: result.toolCalls,
      repair: repairNote !== undefined,
    });
    return result;
  }

  /**
   * Merge an already-recorded turn's ledger block and flip merged:true (§8.6).
   * The record was created (and charged) in doTurn.
   */
  private absorb(
    round: 1 | 2 | 3,
    role: "ideator" | "skeptic",
    result: TurnResult,
    rec: TurnRecord,
  ): void {
    if (result.status !== "ok") { this.saveManifest(); return; }
    const merged = this.mergeTurnText(result.text, round, role);
    // Only claim "merged" when the block was actually usable; otherwise resume would
    // skip a turn whose claims never reached the ledger.
    if (merged) {
      rec.merged = true;
      this.commitLedger();
    }
    this.saveManifest();
  }

  private recordTurn(
    round: Round,
    role: Role,
    result: TurnResult,
    isRepair = false,
  ): TurnRecord {
    const rr = this.role(role);
    // §13.19: tokens spent but no cost reported => the USD cap cannot bind here.
    // §13.29: unless the model is declared free, in which case zero is correct and
    // warning about it would train the user to ignore the warning that matters.
    const unreported =
      !rr.free &&
      (result.usage?.totalTokens ?? 0) > 0 &&
      (result.usage?.cost.total ?? 0) === 0;
    if (unreported) {
      this.manifest.costTrusted = false;
      appendEvent(this.paths.events, "cost_unreported", {
        round, role, model: rr.ref, tokens: result.usage?.totalTokens ?? 0,
      });
    }
    const rec: TurnRecord = {
      round, role,
      status: result.status,
      model: rr.ref,
      durationMs: result.durationMs,
      usage: result.usage,
      messageCount: result.messageCount,
      toolCalls: result.toolCalls,
      stopReason: result.stopReason,
      merged: false,
      // §13.38: retain diagnostics for turns that failed, so a post-mortem is possible.
      ...(result.status !== "ok" && result.stderrTail
        ? { stderrTail: result.stderrTail.slice(-2048) }
        : {}),
      ...(rr.free ? { free: true } : {}),
      ...(isRepair ? { repairOf: `${round}-${role}` } : {}),
      ...(unreported ? { costUnreported: true } : {}),
    };
    this.manifest.turns.push(rec);
    recomputeTotals(this.manifest);
    return rec;
  }

  /** Returns true when the turn's block was usable and its claims were merged. */
  private mergeTurnText(text: string, round: 1 | 2 | 3, role: "ideator" | "skeptic"): boolean {
    const block = extractLedgerBlock(text);
    if (!block.ok) {
      this.ledger.lint.push({ round, code: `block_${block.code}` });
      return false;
    }
    const payload = normalizeTurnPayload(block.json);
    for (const p of payload.problems) {
      appendEvent(this.paths.events, "ledger_payload_problem", { round, role, detail: p });
    }
    const merged = mergeTurn({
      ledger: this.ledger,
      incoming: payload.claims,
      round, author: AUTHOR_OF[role], role,
      freeAgreements: this.cfg.skeptic.freeAgreements,
      minFlaws: this.cfg.skeptic.minFlaws,
      requireEvidenceForHigh: this.cfg.requireEvidenceForHigh,
    });
    this.ledger = merged.ledger;
    for (const ev of merged.events) {
      appendEvent(this.paths.events, ev.code, { round, role, claimId: ev.claimId, detail: ev.detail });
    }
    if (merged.lint.length > 0) {
      appendEvent(this.paths.events, "lint", { round, role, codes: merged.lint.map((l) => l.code) });
    }
    appendEvent(this.paths.events, "merge", {
      round, role, added: merged.added, updated: merged.updated,
      version: merged.ledger.version, idMap: merged.idMap,
    });
    return true;
  }

  // ------------------------------------------------------------------
  // Verdict
  // ------------------------------------------------------------------

  private async runVerdict(mode: Mode): Promise<string | null> {
    // §8.3: build excerpts BEFORE the verdict turn; it is the judge's only source view.
    const refs = this.ledger.claims
      .map((c) => c.sourceRef)
      .filter((r): r is string => typeof r === "string" && r.trim() !== "");
    const ex = buildExcerpts({
      seed: this.seedText,
      refs,
      inlineFullSeedUnderChars: this.cfg.synthesizer.inlineFullSeedUnderChars,
    });
    mkdirSync(this.paths.judgeDir, { recursive: true });
    writeFileSync(this.paths.judgeExcerpts, ex.markdown);
    writeFileSync(this.paths.judgeLedger, JSON.stringify(anonymizeForJudge(this.ledger), null, 2));
    appendEvent(this.paths.events, "judge_input_built", {
      refs: refs.length, spans: ex.markdown.length,
      unresolved: ex.unresolved.length, inlinedFullSeed: ex.inlinedFullSeed,
    });

    if (this.ledger.claims.length === 0) {
      appendEvent(this.paths.events, "verdict_skipped", { reason: "empty ledger" });
      this.note("Ledger is empty; no judge turn attempted.");
      return null;
    }

    const result = await this.invoke("verdict", "synthesizer");
    const rec = this.recordTurn("verdict", "synthesizer", result);
    if (result.status === "ok" && result.text.trim()) {
      rec.merged = true;
      this.verdictBody = result.text.trim();
      return this.verdictBody;
    }
    appendEvent(this.paths.events, "verdict_turn_failed", { status: result.status });
    this.note(`Judge turn did not complete (${result.status}); verdict is mechanical.`);
    return null;
  }

  private finalize(body: string | null): RunOutcome {
    this.verdictBody = body ?? this.verdictBody;

    if (this.manifest.status === "running") {
      this.manifest.status = "complete";
    }
    this.manifest.endedAt = new Date().toISOString();
    this.manifest.totals.durationMs = this.now() - this.startedAtMs;
    this.manifest.lint = this.ledger.lint;
    recomputeTotals(this.manifest);
    this.manifest.totals.durationMs = this.now() - this.startedAtMs;

    let verdictPath: string | null = null;
    // §5.1: a failed run writes no verdict at all.
    if (this.manifest.status !== "failed") {
      const content = buildVerdict({
        runId: this.manifest.runId,
        mode: this.manifest.mode,
        status: this.manifest.status,
        rounds: this.manifest.rounds,
        ledger: this.ledger,
        body: this.verdictBody,
        manifest: this.manifest,
        notes: this.manifest.notes,
      });
      const turnPath = join(this.paths.turnsDir, "verdict.md");
      writeVerdict(turnPath, this.paths.rootVerdict, content);
      verdictPath = this.paths.rootVerdict;

      if (this.cfg.lessons.enabled) {
        const n = appendLessons(
          this.paths.lessons, this.manifest.runId, this.ledger, this.cfg.lessons.maxLines,
        );
        if (n > 0) appendEvent(this.paths.events, "lessons_appended", { count: n });
      }
    }

    this.commitLedger();
    this.saveManifest();
    appendEvent(this.paths.events, "run_end", {
      status: this.manifest.status,
      rounds: this.manifest.rounds,
      costUsd: this.manifest.totals.costUsd,
      tokens: this.manifest.totals.tokens,
      claims: this.ledger.claims.length,
      costTrusted: this.manifest.costTrusted,
    });

    const summary = buildSummary({
      runId: this.manifest.runId,
      mode: this.manifest.mode,
      status: this.manifest.status,
      rounds: this.manifest.rounds,
      ledger: this.ledger,
      verdictPath: verdictPath ?? "(none)",
      costUsd: this.manifest.totals.costUsd,
      body: this.verdictBody,
      costTrusted: this.manifest.costTrusted,
    });

    this.emitProgress("done", null, null);
    return {
      runId: this.manifest.runId,
      status: this.manifest.status,
      verdictPath,
      summary,
      openHighSeverity: openAtOrAbove(this.ledger, "high").length,
      costUsd: this.manifest.totals.costUsd,
      ledger: this.ledger,
      manifest: this.manifest,
    };
  }

  // ------------------------------------------------------------------
  // Budgets, helpers
  // ------------------------------------------------------------------

  /**
   * §5.1: budget check at every turn boundary, using the SUMMED run cost (§7.1).
   * Returns a reason string when the run must jump to the verdict, else null.
   */
  private budgetStop(): string | null {
    const t = this.manifest.totals;
    const b = this.cfg.budget;
    const elapsed = this.now() - this.startedAtMs;

    if (elapsed >= this.cfg.timeouts.totalMs) {
      return `wall clock ${Math.round(elapsed / 1000)}s >= ${this.cfg.timeouts.totalMs / 1000}s`;
    }
    if (t.tokens >= b.tokens) return `tokens ${t.tokens} >= ${b.tokens}`;
    // The USD cap is only meaningful when cost is actually reported (§13.19).
    if (b.costReporting !== "ignore" && t.costUsd >= b.usd) {
      return `cost $${t.costUsd.toFixed(4)} >= $${b.usd}`;
    }
    if (b.costReporting === "require" && this.manifest.costTrusted === false) {
      return "a provider reported no cost while budget.costReporting is \"require\"";
    }
    return null;
  }

  /**
   * §13.28: per-role cumulative budget. Unlike budgetStop this does NOT end the run -
   * it only skips further turns by that role, so one expensive debater cannot starve
   * the other or the judge. Returns a reason string when this role is spent out.
   */
  private roleBudgetStop(role: Role): string | null {
    const rr = this.role(role);
    const spent = this.roleSpend(role);
    if (Number.isFinite(rr.budgetUsd) && spent.usd >= rr.budgetUsd) {
      return `role ${role} cost $${spent.usd.toFixed(4)} >= its cap $${rr.budgetUsd}`;
    }
    if (Number.isFinite(rr.budgetTokens) && spent.tokens >= rr.budgetTokens) {
      return `role ${role} tokens ${spent.tokens} >= its cap ${rr.budgetTokens}`;
    }
    return null;
  }

  private combinedSignal(): AbortSignal {
    if (!this.externalSignal) return this.abortController.signal;
    // Fold the session signal into ours so shutdown kills children too.
    if (this.externalSignal.aborted) this.abortController.abort();
    else this.externalSignal.addEventListener("abort", () => this.abortController.abort(), { once: true });
    return this.abortController.signal;
  }

  private personaModel(role: Role): string | null {
    const p = join(this.personaDir, `${role}.md`);
    if (!existsSync(p)) return null;
    const text = readFileSync(p, "utf8");
    // Flat `key: value` frontmatter only (§6.2), to stay harness-compatible.
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return null;
    for (const line of fm[1]!.split(/\r?\n/)) {
      const m = line.match(/^model:\s*(.+)$/);
      if (m) return m[1]!.trim();
    }
    return null;
  }

  private readLessons(): string | null {
    if (!this.cfg.lessons.enabled) return null;
    if (!existsSync(this.paths.lessons)) return null;
    return readFileSync(this.paths.lessons, "utf8");
  }

  private commitLedger(): void {
    writeFileSync(this.paths.ledger, JSON.stringify(this.ledger, null, 2));
  }

  private saveManifest(): void {
    recomputeTotals(this.manifest);
    this.manifest.totals.durationMs = this.now() - this.startedAtMs;
    writeManifest(this.paths.manifest, this.manifest);
  }

  private note(text: string): void {
    (this.manifest.notes ??= []).push(text);
  }

  private emitProgress(phase: string, round: Round | null, role: Role | null): void {
    this.onProgress?.({
      runId: this.manifest.runId,
      phase, round, role,
      elapsedMs: this.now() - this.startedAtMs,
      costUsd: this.manifest.totals.costUsd,
      tokens: this.manifest.totals.tokens,
      openHigh: openAtOrAbove(this.ledger, "high").length,
      lintCount: this.ledger.lint.length,
      costTrusted: this.manifest.costTrusted !== false,
    });
  }
}
