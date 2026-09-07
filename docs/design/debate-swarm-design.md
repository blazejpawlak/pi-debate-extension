# Multi-Agent Debate — Design & Build Order (v4, Option C: pi extension)

> Status: **APPROVED FOR IMPLEMENTATION.** This document is the work order for `pi` to build the feature.
> History: v1 = bash + long-lived swarm agents (superseded and deleted; what was wrong with it is documented in `debate-swarm-design-review.md` §1). v2 = Option C, first draft. v3 = unknowns resolved from pi source + product decisions. v4 = adversarial pass: cost-accounting defect fixed, argv contract hardened, explore-mode ordering fixed, cost model added. Rationale for v1→v2: `debate-swarm-design-review.md`.
> Target: `pi` v0.85.1 (`@earendil-works/pi-coding-agent`) · optional integration with `pi-messenger-swarm` v0.25.32
> Workspace: `/Users/tetsuo/Desktop/mac-migration`
> Date: 2026-09-06

Instructions to the implementing agent: work through §11 in order. Each work package has a deliverable and an acceptance test; do not start one before the previous test passes. §11 WP0 is the only remaining probe and it is small. Everything in §7 is a verified contract taken from pi's own source and docs — build against it directly, do not re-derive it. Where this document and reality disagree, reality wins: record the discrepancy in §13 and adjust.

---

## 1. Decisions (ADR summary)

| ID | Decision | Why |
|----|----------|-----|
| D1 | The debate is a **pi extension** at `~/.pi/agent/extensions/debate/` (global, all projects), exposing `/debate` and a `debate_run` tool. | pi's extension API is the supported way to add a command; it gives structured state, live UI, and cleanup hooks. No bash orchestrator, no prompt-template shim. |
| D2 | **Orchestrator-driven, one bounded LLM run per turn.** No long-lived agents, no "wait until called" prompts, no channel polling. | Spawned swarm agents are one-shot runs whose injected protocol forbids idling; every community tool that works does one call per turn. |
| D3 | **Turn runner spawns `pi` directly** (`direct`, default). `pi-messenger-swarm` is an optional adapter + channel publisher. | The harness discards child stdout, cannot pass `--tools`/`--thinking`/`--no-extensions`, caps concurrency at 3, prunes channel logs to 50 events, and is a shared daemon. See §1.1. |
| D4 | **Structured claim ledger** is the only thing passed between turns. Prose is archived, never forwarded. | Forward summaries not transcripts; anonymize authorship; judge on claims + evidence. |
| D5 | **Skeptic verifies, not argues**: real `bash` access, mandatory falsification tests, agreement budget. Synthesizer has **no tools** and sees **no identities**. | Debate without a correctness signal is a martingale (Choi et al. 2025); same-family judge bias; sycophancy. Bash confirmed by the user as wanted. |
| D6 | Rounds: R1 → R2 → R3 **conditional** on unresolved high-severity claims → verdict. ≤7 model turns, plus at most `repairs.max` (2) retries. | Gains flatten after 3 rounds; adaptive stopping. |
| D7 | **Two seed modes**: `review` (document/plan — blind parallel R1) and `explore` (short idea — Ideator-only R1, Skeptic from R2). Auto-selected, overridable. | A blind Skeptic has nothing to verify when the seed is one paragraph; a Skeptic that sees the Ideator's prose first is exactly the anchoring the design avoids in `review`. |
| D8 | Heterogeneous models per role, **three distinct families**: Anthropic (Ideator) · OpenAI (Skeptic) · Google (Synthesizer). Resolved from `pi --list-models`, §4. | Homogeneous debate is the weakest configuration; judges are biased toward their own family. A fully independent judge removes the residual bias v2 had to accept. |
| D9 | **Two-level cost enforcement**: a run cap (default $5) checked at turn boundaries, and a **per-turn ceiling** (default $2) enforced *mid-turn* by summing streamed usage and killing the child. | pi reports cost per message, but has no `--max-turns`: a single tool-looping turn can otherwise run to the timeout and spend without limit. See §4.1. |
| D10 | Per-run directory `.debate/runs/<run-id>/`; `debate_verdict.md` at workspace root is a copy of the latest verdict. Runs are resumable. | Removes cross-run contamination, the exit-signal race, and makes a crashed run recoverable without re-spending. |
| D11 | Never start or stop a `pi-messenger-swarm` harness the extension did not start. Never call `--stop`. | Shared daemon on :9877 that an interactive pi session may be using. |

### 1.1 Note on D3 vs. the agreed "drive the harness API"

Option C as agreed said the extension would drive the harness HTTP API. Written against the 0.25.32 source, the harness gives the extension strictly *less* than spawning `pi` directly: it discards the child's stdout (so turn text must round-trip through files), cannot pass `--tools` / `--thinking` / `--no-extensions`, enforces `maxConcurrentSpawns: 3`, and requires the daemon. The `direct` runner is therefore the default; the `harness` runner is a thin adapter kept for (a) making debate turns visible in a swarm channel alongside other agents, and (b) fallback if `pi` children misbehave. Both implement the same interface (§6). Flip `runner` in config to switch.

---

## 2. Behavioral contract

- **Input**: `/debate <text>`, `/debate @path/to/file.md`, or the `debate_run` tool with `{seed | seedFile}`.
- **Mode selection**: `@file` or inline text ≥ `mode.reviewThresholdChars` (default 2000) → `review`; otherwise `explore`. Override with `/debate --mode review|explore` or the tool's `mode` parameter.
- **Output**: `.debate/runs/<run-id>/verdict.md`, copied to `<workspace>/debate_verdict.md`; a ≤40-line summary injected into the pi session; a live status widget during the run.
- **Bounds** (all configurable, all enforced by the orchestrator): ≤7 model turns (+ at most 2 repair retries) · per-turn timeout 240 s · total wall clock 900 s · tokens 1.5 M · **run cost $5** · **per-turn cost $2**. The run cap and time/token caps bind at the next turn boundary and jump to the verdict with `status: partial`; the per-turn ceiling kills the running child immediately (§4.1).
- **Termination**: verdict written; or budget exhausted → partial verdict; or `/debate abort` → children killed, run marked `aborted`; or both R1 turns fail → run marked `failed`, no verdict (§5.1).
- **Cleanup**: every child is tracked and killed on `session_shutdown`, abort, or timeout. No detached processes survive.
- **Resume**: `/debate resume <run-id>` replays from the first turn that is absent or unmerged (§8.6); a turn that completed but crashed before its merge is re-merged from disk, never re-paid for.

---

## 3. Architecture

```
~/.pi/agent/extensions/debate/
  index.ts              register command + tool + hooks; wire config
  config.ts             defaults ← settings.json "debate" ← <workspace>/.pi/debate.json
  orchestrator.ts       state machine (§5), budgets, stop rules, resume
  ledger.ts             schema, parse/merge/validate, id namespacing, anonymize, lint, gate
  excerpts.ts           sourceRef → seed excerpt extraction for the judge
  runner/types.ts       TurnRunner interface
  runner/direct.ts      spawn `pi`, parse JSON event stream (§7.1), capture text + usage + cost
  runner/harness.ts     optional: POST /action spawn via pi-messenger-swarm
  runner/fake.ts        fixtures, for tests
  prompts.ts            per-turn mission assembly (cache-friendly ordering, §6.3)
  verdict.ts            verdict template, root copy, lessons append
  publish.ts            optional swarm-channel digests
  ui.ts                 widget, status line, entry renderer
  personas/{ideator,skeptic,synthesizer}.md
  test/
```

Run directory:

```
<workspace>/.debate/
  lessons.md                       cross-run Skeptic lessons (append-only, capped)
  runs/<run-id>/
    manifest.json                  seed source, mode, models, config snapshot, timings, tokens, cost, status
    seed.md                        the debated text
    ledger.json                    canonical merged ledger (authoritative, versioned)
    judge/excerpts.md              seed spans cited by claims (built before the verdict turn)
    judge/ledger.json              anonymized ledger handed to the Synthesizer
    turns/r1-ideator.md            raw turn text (archive only, never forwarded)
    turns/...
    turns/verdict.md
    events.jsonl                   orchestrator log: turn start/end, usage, lint, stop reasons
    transcript.jsonl               (harness runner only)
  <workspace>/debate_verdict.md    copy of the latest verdict
```

`run-id` = `YYYYMMDD-HHMMSS-<4 hex>`. Recommend adding `.debate/runs/` to `.gitignore` and keeping `.debate/lessons.md` tracked.

---

## 4. Roles and models

Resolved against the actual roster on this machine (`pi --list-models`, 2026-09-06). Three distinct model families, so the judge is independent of both debaters.

| Role | Model | Family | Ctx | `--tools` | Thinking | Sees |
|------|-------|--------|-----|-----------|----------|------|
| Ideator | `ibm-services-essentials/claude-opus-5` | Anthropic | 1M | `read,grep,find,ls` | `high` | seed; from R2 the anonymized ledger |
| Skeptic | `openai-codex/gpt-6-astra` | OpenAI | 272K | `read,grep,find,ls,bash` | `high` | seed + `lessons.md`; from R2 the anonymized ledger; runs verification commands |
| Synthesizer | `opencode/gemini-3.1-pro` | Google | 1M | `--no-tools` | `high` | anonymized ledger + seed excerpts only |

Alternates, for config overrides:

| Need | Swap to |
|------|---------|
| Synthesizer via OpenRouter instead of opencode | `openrouter/google/gemini-3.1-pro-preview` |
| Seed larger than ~200K tokens (Skeptic ctx is the binding limit) | `opencode/gpt-6-astra` or `openrouter/openai/gpt-6-astra` (1.1M) |
| Cheap tier (see §9.5 `budget.usd`) | `ibm-services-essentials/claude-sonnet-5` · `openai-codex/gpt-5.4-mini` · `opencode/gemini-3.5-flash` |
| Fourth family, if you ever want a second judge or a tiebreak | `openrouter/x-ai/grok-4.3` (xAI, 1M) or `opencode/deepseek-v4-pro` |

**Provider/model parsing.** Persona frontmatter carries `model: <provider>/<model>`; the runner splits on the **first** slash only — `--provider <before> --model <after>`. This matters for OpenRouter, whose model ids themselves contain slashes: `openrouter/google/gemini-3.1-pro-preview` → `--provider openrouter --model google/gemini-3.1-pro-preview`. A model id with no slash is passed as `--model` alone with pi's default provider.

Because all three families now differ, the v2 same-family judge warning should never fire; keep the check anyway — it fires if someone overrides the models in config.

### 4.1 Cost model — read this before trusting the $5 cap

A "turn" is not one API call. With tools enabled, pi runs an agentic loop: assistant message → tool call → tool result → assistant message → … Each assistant message is a separate provider request that **re-sends the whole conversation so far**. So a Skeptic turn that makes 6 bash calls costs roughly 7 requests with a growing prefix, not one.

Order-of-magnitude for the 52 KB migration plan (~13K tokens of seed):

| | per request | requests/turn | per turn |
|---|---|---|---|
| Ideator (opus-class, tools) | ~15–25K in, ~3–5K out | 3–6 | **~$1–2** |
| Skeptic (gpt-6-astra, bash) | ~15–30K in, ~3–5K out | 4–8 | **~$1–2** |
| Synthesizer (gemini-pro, no tools) | ~20K in, ~4K out | 1 | **~$0.10–0.30** |

A full 3-round review is therefore plausibly **$6–12**, not $5. Consequences, stated plainly rather than hidden in a config default:

- The $5 run cap **will** bind on a full-size seed with three rounds. That is by design — it produces a `partial` verdict rather than a surprise bill — but do not be surprised by it, and do not read `partial` as a protocol failure.
- `cacheRead` is billed at a fraction of fresh input. §6.3's stable-prefix ordering is what makes repeated turns affordable; if WP4 shows `cacheRead` staying at zero, the realistic cap is roughly double.
- **pi has no `--max-turns`**, so nothing but the timeout stops a runaway tool loop. That is why D9 adds the per-turn ceiling: the runner sums streamed usage and kills the child the moment a turn crosses `budget.perTurnUsd`. Without it, "cost cap" is a comforting label on an unenforced limit.
- WP5 and WP8 calibrate these numbers against reality; update this table with measured figures rather than leaving the estimates in place.

**Skeptic bash policy** (user-approved). Persona forbids mutation, and the mission repeats a denylist: no writes/creates/deletes, no `git` state changes, no package installs, no network mutation, no `sudo`. The orchestrator additionally sets `DEBATE_READONLY=1` in the child env for scripts to honor. This is a prompt-level guarantee, not a sandbox — accepted deliberately, because a Skeptic that can actually run `tmutil compare` is the difference between a verified claim and a rhetorical one. `skeptic.allowBash: false` downgrades to read-only tools.

All children run with `--no-context-files` (the seed is the subject; AGENTS.md/CLAUDE.md would bias the debate) — config `children.contextFiles: false`.

---

## 5. Protocol

```
INIT      create run dir; write seed.md, manifest.json, empty ledger.json; snapshot lessons.md
          select mode: review | explore

R1  review  PARALLEL (2 children):
              Ideator(seed)                    → proposal + claims                (author A)
              Skeptic(seed, lessons)           → ≥3 flaws + severity + test       (author B)
    explore SINGLE:
              Ideator(seed)                    → proposal + claims                (author A)
          merge → ledger v1 ; assign global ids ; lint

R2  review  SEQUENTIAL — Ideator first (it is responding to R1 criticism):
              Ideator(seed, anon(ledger))      → per-claim responses; flips need refutedPremise
              merge → v2a
              Skeptic(seed, anon(v2a), lessons)→ re-verify, run tests, update severity/status/evidence
    explore SEQUENTIAL — Skeptic first (it has not spoken yet; running the Ideator
            twice in a row would waste a turn on nothing new):
              Skeptic(seed, anon(ledger), lessons) → first critique of the R1 proposal
              merge → v2a
              Ideator(seed, anon(v2a))         → respond per claim
          merge → ledger v2 ; lint

GATE      no claim with status=open AND severity ∈ {high, critical}  → VERDICT
          any budget exhausted (time | tokens | cost)                 → VERDICT (partial)
          rounds exhausted                                            → VERDICT
          else                                                        → R3

R3        same shape as R2

VERDICT   build judge/excerpts.md from claim sourceRefs
          Synthesizer(anon ledger + excerpts) → returns verdict TEXT
          (the Synthesizer has no tools and writes nothing; the orchestrator
           writes turns/verdict.md from the returned text)
FINAL     append orchestrator header + cost section; copy to workspace root;
          append Skeptic lessons; write manifest; inject summary into session
```

### 5.1 Orchestrator-enforced rules (never left to prompts)

- **Authorship**: claims carry `author: A|B` internally; debaters see `A`/`B` only; the Synthesizer sees neither — its ledger copy has the field stripped entirely.
- **Flip discipline**: a status change from `open` → `resolved`/`withdrawn` is accepted only when the turn's ledger block supplies `refutedPremise` for that claim. Otherwise the change is reverted, the claim stays `open`, and `flip_rejected` is written to `events.jsonl`.
- **Agreement budget**: the Skeptic may make at most `skeptic.freeAgreements` (default 1) `open → resolved` transitions per round without new `evidence`. Excess reverts to `open` with `note: "agreement without evidence"`.
- **Lint on every merge** (recorded and shown in the widget): duplicate claim text (normalized similarity > 0.9), `confidence ≥ 0.8` with `evidence: none`, Skeptic producing fewer than `skeptic.minFlaws` new claims in a round, missing or invalid ledger block.
- **Repair once**: a turn whose ledger block is missing or invalid is re-run once with the parse error appended to the mission. If the assistant message's `stopReason` was `"length"`, the repair mission also instructs "emit the ledger block first, prose second". Second failure → turn `failed`, protocol continues. Repairs are **full model turns**: they count against every budget and against a per-run cap of `repairs.max` (default 2). Past that cap, invalid turns are recorded and skipped without retry.
- **Early abort**: in `review` mode, if both R1 turns fail the run is marked `failed` and no verdict is written — a verdict over an empty ledger is worse than no verdict. If one fails, continue and record it in the manifest and the verdict header.
- **Severity default**: a claim with no explicit `severity` is treated as `medium`. Only the Skeptic assigns `high`/`critical`, so the Skeptic alone decides whether R3 happens — deliberate, and the reason `skeptic.minFlaws` is linted.
- **Budget check** at every turn boundary uses the **summed** run cost (§7.2). Independently, the runner enforces `budget.perTurnUsd` *during* a turn by accumulating streamed usage and killing the child on breach; the turn is recorded `status: 'costcap'` and treated like a failed turn (repairable once, subject to the repair cap).

---

## 6. Runner

### 6.1 Interface

```ts
export interface TurnRequest {
  runId: string; round: 1|2|3|'verdict'; role: 'ideator'|'skeptic'|'synthesizer';
  personaPath: string; mission: string; cwd: string;
  tools: string[] | 'none';
  thinking: 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max';
  timeoutMs: number; signal: AbortSignal;
}
export interface TurnResult {
  text: string;                       // text blocks of the FINAL assistant message only
  usage: Usage | null;                // SUM over every assistant message in the turn (§7.2)
  messageCount: number;               // assistant messages = provider requests in this turn
  toolCalls: { name: string; count: number }[];   // audit + cost diagnosis
  stopReason: string | null;          // of the final message: stop | length | error | aborted | …
  status: 'ok'|'timeout'|'failed'|'aborted'|'costcap';
  durationMs: number; exitCode: number | null; stderrTail: string;
}
export interface TurnRunner { run(req: TurnRequest): Promise<TurnResult>; killAll(): Promise<void>; }
```

### 6.2 `direct` runner (default)

Spawn with `child_process.spawn` (argv array, never a shell string):

```
pi --mode json --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files \
   --provider <prov> --model <model> --thinking <level> \
   [--tools read,grep,find,ls[,bash] | --no-tools] \
   --append-system-prompt <persona-body.tmp> \
   -- @<seed-or-excerpts-path> <mission>
```

**The `--` and the `@` are both load-bearing** (`src/cli/args.ts`):
- `--` ends option parsing; everything after becomes message/file arguments. Without it, a mission that happens to begin with `-` or `--` is swallowed into pi's `unknownFlags` map — and an unknown `--flag` even consumes the *next* argument. Always emit `--`.
- A positional argument starting with `@` is treated as a **file attachment** (`result.fileArgs.push(arg.slice(1))`), not as text. So the seed is attached by path rather than pasted into argv. This kills three problems at once: no `ARG_MAX` risk on large seeds, no seed text in `ps` output, and the attachment is byte-identical every turn, which is exactly what the prompt cache wants (§6.3).
- Debaters get `@<run>/seed.md`; the Synthesizer, which has no tools, gets `@<run>/judge/excerpts.md` — that is how a tool-less judge sees source text at all.
- A mission must therefore never itself begin with `@`. `prompts.ts` prefixes every mission with a role line, so this holds by construction; assert it anyway.

- **`-p` is not needed**: `--mode json` alone selects non-interactive JSON mode (verified in `resolveAppMode`, `src/main.ts`). Passing both is harmless but redundant.
- `--append-system-prompt` takes a path to the persona **body** (frontmatter stripped by the runner; flat `key: value` parsing only, to stay compatible with the harness adapter). The flag accepts text or a file path and is repeatable. Temp files are named `<tmpdir>/debate-<runId>-<round>-<role>-<pid>.md` so the two parallel R1 children never collide, and are deleted in a `finally`.
- `--no-extensions` is deliberate: children must not load `pi-messenger-swarm` (no swarm protocol injected into their system prompt, no wrapper install).
- `cwd` = workspace. Env inherits plus `DEBATE_RUN_ID`, `DEBATE_ROLE`, `DEBATE_ROUND`, and `DEBATE_READONLY=1`.
- Stdout parsed per §7.1, **accumulating** usage as it streams (needed for the per-turn cost ceiling and the live widget). Stderr: keep the last 2 KB.
- Timeout or abort → `SIGTERM`, 5 s grace, `SIGKILL`. `killAll()` is idempotent and is what `session_shutdown` calls.

### 6.3 Mission assembly and prompt caching

pi reports `cacheRead`/`cacheWrite` per turn, so cache behavior is observable. Order every mission **stable prefix first, volatile last** so providers can reuse the prefix across turns of the same run:

1. persona body (via `--append-system-prompt`, identical for all turns of a role)
2. run-invariant block: mode, seed path, output contract
3. seed text or path (invariant)
4. **volatile**: round number, anonymized ledger, diff since last round, repair notes

Track `cacheRead > 0` from R2 onward in `events.jsonl`; if it stays zero, caching is not engaging and the design's cost estimate needs revisiting (record in §13).

### 6.4 `harness` runner (optional)

- Preconditions checked, never fixed by the extension: `~/.pi/agent/bin/pi-messenger-swarm` exists; `GET http://127.0.0.1:9877/health` → 200; `.pi/pi-messenger.json` has `maxConcurrentSpawns ≥ 2` and `feedRetention ≥ 200`. Missing → refuse with a readable error.
- Spawn: `POST /action` with `{action:'spawn', agentFile, message, name, force:true}` and headers `x-agent-name: debate-orchestrator`, `x-session-id`, `x-caller-cwd`. Response `{ok, result:{text, details:{mode:'spawn', agent:{id,…}}}}`; errors surface as `details.error ∈ concurrency_limit | missing_task_id | spawn_failed | message_file_read_error`.
- The harness discards child stdout, so personas used on this path must end with "write your full response to `<turnFilePath>` before exiting"; the runner polls `.pi/messenger/agents/<session>.jsonl` for `completed|failed|stopped` and then reads that file. **No tool restrictions, no thinking level, no usage/cost** on this path — budget enforcement degrades to time only. Model comes solely from persona frontmatter (`spawn` has no `--model` in 0.25.32).

---

## 7. Verified contracts (from pi source — build against these)

### 7.1 JSON event stream (`docs/json.md`, `src/core/agent-session.ts`)

Stdout is JSONL. Line 1 is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"…","cwd":"/path"}
```

Then events. The ones the runner needs:

| Event | Use |
|---|---|
| `{"type":"message_end","message":{…}}` | Fires for **every** assistant message. Text = the *last* one; usage = the **sum of all** of them (see below). |
| `{"type":"agent_end","messages":[…]}` | Clean completion marker. Absent ⇒ the child died mid-stream. |
| `{"type":"message_update","usage":{…},"assistantMessageEvent":{…}}` | Delta-only; top-level `usage` is the latest cumulative figure. Use for the **live widget**, not for accounting. |
| `{"type":"tool_execution_start","toolName","args"}` / `…_end` | Widget: "skeptic · running bash". Also the audit trail for what the Skeptic executed. |

`message_update` records omit the cumulative `message` and `assistantMessageEvent.partial`. Text extraction: from the final `message_end`, concatenate `content[]` entries with `type === "text"` — **skip `thinking` and `toolCall` blocks**.

> **Accounting rule — do not get this wrong.** `AssistantMessage.usage` is the usage of *that one provider request*, not of the turn. A tool-using turn emits one `message_end` per assistant message, so run cost is
> `Σ message_end.message.usage.cost.total` over every assistant message, across every turn.
> Taking only the final `message_end` undercounts a 6-tool-call turn by roughly 5–10×, which would silently disable the cost cap in §4.1. `pi-messenger-swarm` corroborates the rule — `swarm/progress.ts` does `progress.tokens += usage.input + usage.output` on each `message_end`, accumulating rather than replacing.

### 7.2 `AssistantMessage` / `Usage` (`packages/ai/src/types.ts`)

```ts
AssistantMessage { role, content[], api, provider, model, usage: Usage,
                   stopReason: StopReason, errorMessage?, timestamp, … }
Usage { input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens,
        cost: { input, output, cacheRead, cacheWrite, total } }
StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred"
```

Consequences the design relies on:
- **Cost is reported per message, so it must be summed per turn and per run** (§7.1). Done correctly, D9's caps are enforceable and the verdict's cost section is real money; done naively, both are decorative.
- `stopReason: "error"` + `errorMessage` ⇒ `status: 'failed'` (more reliable than exit code).
- `stopReason: "length"` ⇒ truncated turn; ledger block is probably cut off — feed that fact into the repair mission (§5.1).
- `cacheRead` makes §6.3 verifiable.

### 7.3 CLI facts

- Valid `--tools` names include `read, bash, edit, write, grep, find, ls` (default tool set is `read, bash, edit, write`).
- `--thinking`: `off|minimal|low|medium|high|xhigh|max`.
- **There is no `--temperature`.** The literature's low-temperature-lock-in finding is addressed only through model heterogeneity (D8).
- Relevant isolation flags: `--no-session`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-context-files`, `--exclude-tools`.
- **There is no `--max-turns` / tool-call limit.** A runaway agentic loop is bounded only by the per-turn timeout and by the mid-turn cost ceiling this design adds (§4.1).
- `--` ends option parsing; a positional `@path` is a file attachment, anything else is message text (§6.2).
- `--tools` is parsed as a bare comma-split with no validation at parse time, so a misspelled tool name will not raise an error — it just silently isn't there. WP0 verifies `bash` actually reaches the Skeptic.

---

## 8. Data contracts

### 8.1 Ledger (`ledger.json`)

```json
{
  "runId": "20260906-181200-3f9a",
  "mode": "review",
  "version": 3,
  "claims": [
    {
      "id": "B4",
      "author": "B",
      "round": 1,
      "type": "ASSUMPTION",
      "text": "Time Machine snapshot is consistent while Rancher is running",
      "sourceRef": "§Implementation Phase 5",
      "evidence": "none; Phase 5 quiesces only Docker Desktop",
      "confidence": 0.4,
      "severity": "high",
      "status": "open",
      "test": "stop rancher-desktop; tmutil compare before/after",
      "history": [
        {"round": 2, "by": "A", "change": "status open→disputed", "refutedPremise": null, "note": "…"}
      ]
    }
  ],
  "lint": [{"round": 2, "code": "conf_no_evidence", "claimId": "A7"}]
}
```

`type ∈ FACT | INFERENCE | ASSUMPTION | UNKNOWN` · `severity ∈ low | medium | high | critical` · `status ∈ open | resolved | withdrawn | disputed` · `confidence ∈ [0,1]`.

**ID namespacing (fixes the v2 R1 collision).** Agents emit *local* ids (`C1`, `C2`, …) in their own numbering. At merge the orchestrator rewrites them to `<author><n>` — `A1…An`, `B1…Bn` — and keeps a per-turn local→global map. From R2 on, agents are shown and must reference the **global** ids; an unknown id in R2+ is treated as a new claim and logged as `unknown_id_as_new`.

**Field permissions on merge.** Ideator may set/change `text`, `type`, `evidence`, `confidence`, `sourceRef`, and `status` (with `refutedPremise`). Skeptic may set/change `severity`, `status`, `evidence`, `test`, `sourceRef`, and add claims. Everything else is ignored and logged.

Each turn ends with exactly one fenced block (surrounding prose tolerated, a second block is an error):

    ```ledger
    {"claims":[ … new or updated claims … ]}
    ```

### 8.2 Mission (built by `prompts.ts`)

Order per §6.3. Contains: role line · mode · seed (path for tool-enabled roles, inline for the judge) · anonymized ledger + diff since last round · the output contract (prose ≤600 words, then exactly one ```ledger block) · for the Skeptic, `lessons.md` and the bash denylist. **Never contains previous turns' prose.**

### 8.3 Judge input

Before the verdict turn the orchestrator builds `judge/excerpts.md` by resolving each claim's `sourceRef` (a heading like `§Implementation Phase 5` or a line range `L189-205`) against `seed.md`, deduplicating and merging overlapping spans. The judge receives: anonymized ledger (no `author`, no `history.by`) + excerpts. If total excerpts < `synthesizer.inlineFullSeedUnderChars` (default 40 000) the full seed is inlined as well. This replaces v2's blunt truncation and makes every verdict line traceable to a seed location.

### 8.4 Verdict (`turns/verdict.md`)

```
# Debate verdict — <run-id>
Mode: review|explore   Status: complete|partial|aborted   Rounds: 2|3
Claims: N (open n · disputed n · resolved n · withdrawn n)

## 1. Unresolved items (severity desc)     ← always first
## 2. Decision                             ← review:  proceed | proceed-with-changes | do-not-proceed
                                              explore: pursue | pursue-narrowed | park | drop
## 3. Confidence and why
## 4. Minority report                      ← never empty when any claim is `disputed`
## 5. Kill criteria
## 6. Next steps (≤7, each citing a claim id)
## 7. Cost and provenance                  ← appended by the orchestrator, not the model
```

Section 7 comes from `manifest.json`: per-turn model, duration, tokens, `cost.total`, run total in USD, cache-hit ratio, and any lint codes raised.

### 8.5 `lessons.md`

After each run, claims with `severity ∈ {high, critical}` and `status ≠ withdrawn` are appended as `- [<run-id>] <text> — test: <test>`, capped at `lessons.maxLines` (200, oldest dropped). Included in the Skeptic's R1 mission. Config `lessons.enabled` (default true).

### 8.6 `manifest.json`

`{runId, mode, startedAt, endedAt, status, seedSource, models{}, runner, rounds, turns:[{round, role, status, model, durationMs, usage, messageCount, toolCalls, stopReason, merged}], totals:{durationMs, tokens, costUsd, cacheReadTokens, messageCount}, budgets, repairsUsed, configSnapshot, resumedFrom?}`

`turns[].merged` is what makes resume safe: the orchestrator writes `turns/<r>-<role>.md` and appends the turn record with `merged: false` **before** merging into the ledger, then flips it to `true` after `ledger.json` is committed. A crash between the two leaves a completed turn on disk that resume re-merges rather than re-paying for. Resume replays from the first turn that is absent or unmerged.

---

## 9. Extension surface

### 9.1 Command `/debate`

| Invocation | Behavior |
|---|---|
| `/debate <text>` | Run; mode auto-selected |
| `/debate @<path>` | Run with file contents as seed (`review` mode) |
| `/debate --mode explore <text>` | Force mode |
| `/debate status` | Round, turn, elapsed, tokens, **cost so far**, open high-severity count |
| `/debate abort` | Kill children, mark aborted |
| `/debate resume <run-id>` | Continue a crashed/aborted run from its last ledger version |
| `/debate last` | Print the last verdict summary |
| `/debate runs` | List runs with status and cost |

Argument completions: `status`, `abort`, `resume`, `last`, `runs`, `--mode`, `@`.

### 9.2 Tool `debate_run`

`{ seed?, seedFile?, mode?: 'review'|'explore', rounds?: 2|3, dryRun?: boolean }` → `{ runId, status, verdictPath, summary, openHighSeverity, costUsd }`.
`dryRun: true` creates the run directory, selects the mode and models, builds the R1 missions, and returns the resolved plan plus a token/cost estimate from §4.1 — **without invoking any model**. Use it to sanity-check a large seed before spending.
`promptGuidelines`: *"Use debate_run when the user asks for a multi-model review, red-team, or debate of a plan, spec, or idea."*
One run at a time; a second call returns `busy` with the active `runId`.

### 9.3 UI and session integration

- `ctx.ui.setStatus('debate', 'R2 · skeptic · bash · 01:42 · $1.80')`, cleared at end.
- `ctx.ui.setWidget('debate', […])`: one line per `severity ≥ high` claim, plus lint warnings and live cost.
- On completion: `pi.appendEntry('debate-verdict', {runId, path, summary, costUsd})` with an entry renderer (TUI-only, not LLM context), and `pi.sendMessage({customType:'debate', content:<summary>}, {deliverAs:'nextTurn'})` so the next prompt has the verdict in context. Config `inject: 'nextTurn' | 'followUp' | 'none'`.
- Guard every UI call with `ctx.hasUI`; the extension must still work in `--mode json` and `-p`, returning the summary through the tool result.

### 9.4 Hooks

- `session_shutdown` → `runner.killAll()`; mark the active run `aborted`.
- `session_start` → sweep `.debate/runs/*/manifest.json` for `status: running` left by a crashed session; mark them `aborted` (resumable).

### 9.5 Config

`settings.json` → `"debate": {…}`, overridden by `<workspace>/.pi/debate.json`:

```json
{
  "runner": "direct",
  "mode": { "reviewThresholdChars": 2000 },
  "rounds": { "max": 3, "gateSeverity": "high" },
  "timeouts": { "turnMs": 240000, "totalMs": 900000 },
  "budget": { "tokens": 1500000, "usd": 5, "perTurnUsd": 2 },
  "repairs": { "max": 2 },
  "models": { "ideator": null, "skeptic": null, "synthesizer": null },
  "_models_note": "null = use persona frontmatter (§4). Cheap tier: ibm-services-essentials/claude-sonnet-5, openai-codex/gpt-5.4-mini, opencode/gemini-3.5-flash",
  "skeptic": { "allowBash": true, "freeAgreements": 1, "minFlaws": 3 },
  "synthesizer": { "inlineFullSeedUnderChars": 40000 },
  "children": { "contextFiles": false, "extraArgs": [] },
  "lessons": { "enabled": true, "maxLines": 200 },
  "inject": "nextTurn",
  "publish": { "enabled": false, "channel": "debate" }
}
```

`models.*: null` = use persona frontmatter.

---

## 10. Personas (ship these, refine in WP4)

Frontmatter stays flat `key: value`.

### `ideator.md`

```
---
role: Ideator
model: ibm-services-essentials/claude-opus-5
---
You are the Ideator in a structured, evidence-driven review. Make the strongest constructive case
for the seed and improve it. You are not here to defend it at any cost.

Rules
- Work only from the seed and the claim ledger you are given. Read the seed with your tools.
- Every substantive point appears in the ledger as a claim with type (FACT/INFERENCE/ASSUMPTION/
  UNKNOWN), evidence, a calibrated confidence 0..1, and a sourceRef pointing into the seed.
- Change a claim's status only by naming the premise that was refuted (refutedPremise). Changing
  position because the other party sounded confident is forbidden.
- Never repeat a claim already in the ledger; reference it by its id exactly as shown.
- Prose under 600 words, then exactly one ```ledger fenced JSON block.
- Do not modify any file in the workspace.
```

### `skeptic.md`

```
---
role: Skeptic
model: openai-codex/gpt-6-astra
---
You are the Skeptic: a verifier, not an adversary. Reduce uncertainty about the seed by finding
what would make it wrong and, wherever possible, checking it.

Rules
- Each round: at least 3 concrete flaws, each with severity (low/medium/high/critical) and a
  falsification test — a command, check, or observation that would settle it.
- Run the tests you can. READ-ONLY DISCIPLINE, absolute: no create/modify/delete, no git state
  changes, no installs, no sudo, no network mutation. Record command output as evidence.
- Agree with at most one contested claim per round without producing evidence. Prefer marking a
  claim `disputed` with a test over marking it `resolved`.
- Read .debate/lessons.md first and say which past lessons apply.
- Prose under 600 words, then exactly one ```ledger fenced JSON block.
```

### `synthesizer.md`

```
---
role: Synthesizer
model: opencode/gemini-3.1-pro
---
You are the Synthesizer. You receive a claim ledger from two anonymous reviewers (A and B) plus
excerpts of the source. You have no tools; judge only from the ledger and its evidence.

Rules
- Do not speculate about who A or B is or which model wrote what. Weigh evidence, not confidence
  or rhetoric.
- Agreement between A and B is not evidence. A claim resolved without evidence remains a risk.
- Use the exact section order in the mission. Lead with unresolved high-severity items. State the
  losing position fairly in the minority report.
- Every next step cites a claim id.
```

---

## 11. Work packages

Use the `fake` runner everywhere except WP0, WP4, WP5 and WP8, which spend real tokens.

**WP0 — Model smoke test** (was: model resolution probe — the roster question is now answered in §4)
For each of the three models in §4, run one minimal call and confirm it authenticates, streams, and reports cost:
`pi --mode json --no-session --no-extensions --no-tools --provider <p> --model <m> 'reply with the word ok'`
Record to `.debate/probe.txt`: exit code, `stopReason`, `usage.cost.total`, and wall time per model.
Then one **tool-loop probe** against the Skeptic model, which validates three separate assumptions at once:
`pi --mode json --no-session --no-extensions --no-context-files --tools read,grep,find,ls,bash --provider openai-codex --model gpt-6-astra -- @<some file> 'run ls, then grep for the word the, then reply done'`
*Acceptance*: (a) all three models return `stopReason: "stop"` with `cost.total > 0`; (b) the tool probe emits `tool_execution_start` with `toolName: "bash"` — proving the `--tools` allowlist actually grants it and did not silently drop a name; (c) the probe emits **more than one** `message_end`, and their summed `usage.cost.total` exceeds the last one alone — confirming the accounting rule in §7.1 empirically; (d) the `@file` argument visibly reaches the model (ask it to quote the file's first line). Any model that fails auth or billing is swapped for its §4 alternate **before** WP1 and the swap recorded in §13.

**WP1 — Skeleton**
`index.ts` registering `/debate` (subcommands stubbed) and `debate_run` (returns `not implemented`); `config.ts` with defaults + two-level merge; `session_shutdown` no-op hook.
*Acceptance*: `pi -e ~/.pi/agent/extensions/debate` starts; `/debate status` prints "no active run"; `pi --mode json --no-session '/debate runs'` does not crash.

**WP2 — Ledger**
`ledger.ts` + `excerpts.ts`: block parsing, schema validation, id namespacing, field permissions, anonymization, lint, gate, sourceRef resolution.
*Acceptance*: `npx tsx test/ledger.test.ts` covers — missing block · two blocks · invalid JSON · R1 parallel id collision (both emit `C1`, become `A1`/`B1`) · flip without `refutedPremise` (reverted) · second free agreement (reverted) · duplicate text lint · gate true/false · sourceRef by heading and by line range.

**WP3 — Orchestrator (fake runner)**
State machine, both modes, budgets (time/tokens/cost), repair-once, early abort, resume, manifest, `events.jsonl`, verdict assembly, root copy, lessons append.
*Acceptance*: `npx tsx test/e2e-fake.ts` runs — (a) gate closes after R2 → 5 turns; (b) unresolved high → R3 → 7 turns; (c) R2 timeout → repair → fail → `status: partial`; (d) both R1 turns fail → `status: failed`, no verdict; (e) cost cap tripped after R2 → partial verdict; (f) `explore` mode → 4 turns, Ideator-only R1, **Skeptic speaks first in R2**; (g) kill after R2 then `resume` → only the remaining turns run; (h) crash *between* a completed turn and its merge (`merged: false`) → resume re-merges from `turns/` without a model call; (i) per-turn cost ceiling breached → turn `costcap`, one repair, then continue; (j) repair cap exhausted → invalid turns skipped, run still reaches a verdict.

**WP4 — Direct runner + personas**
`runner/direct.ts` per §6.2 and §7.1; persona files; temp-file lifecycle; kill semantics; usage/cost capture.
*Acceptance*: `test/runner-direct.test.ts` —
1. one cheap real turn (sonnet-class, `--no-tools`, "reply `ok` and an empty ledger block") asserts text captured, `usage.cost.total > 0`, `stopReason === "stop"`, `messageCount === 1`, temp file removed;
2. a tool-using turn asserts `messageCount > 1` and that `usage` is the **sum** across messages, not the last message's (compare against a manual sum of the raw stream);
3. a 5 s timeout on a sleeping bash mission → `status: 'timeout'`, and `pgrep -f 'pi --mode json'` empty after `killAll()`;
4. a turn run with `perTurnUsd` set absurdly low (e.g. $0.001) → `status: 'costcap'` and the child is dead within ~1 s of the breach, proving the mid-turn kill actually works;
5. record `cacheRead` from turns 2+ of the same run into §13 item 8.

**WP5 — Value probe (gate before more building)**
Run the real protocol on a **small** seed (~5 KB — one phase of the migration plan) with the default models. In parallel, run the baseline: one `claude-opus-5` call with the same seed and "list the highest-severity flaws with falsification tests, then critique your own list once". Write `.debate/eval/probe-<date>.md`: true high-severity issues found (your judgement), cost, wall time.
*Acceptance*: the comparison exists and states a conclusion. **If the debate does not beat the baseline here, stop and tune (models, tools, rounds, prompts) before WP6** — this is the cheapest possible place to discover the whole idea underperforms, and a negative result is a valid outcome to record.

**WP6 — UI + session integration**
`ui.ts`, real subcommands including `resume`, injection per config, stale-run sweep at `session_start`.
*Acceptance*: TUI check with the fake runner — widget updates per turn and shows live cost; abort kills and marks aborted; after completion the next prompt demonstrably has the verdict in context.

**WP7 — Harness adapter + publisher** (optional; only if you want swarm-channel visibility)
`runner/harness.ts` per §6.4; `publish.ts` posting one digest per merged ledger (`send #debate "R2 · 3 open high · A1,B4,B7"`) with `PI_AGENT_NAME=debate-orchestrator`.
*Acceptance*: one turn spawns via `/action`, its `completed` event is detected, the turn file is read; `concurrency_limit` and a down harness produce readable errors and no partial state; the extension never calls `--start`/`--stop`.

**WP8 — Full evaluation**
`/debate @process-mac-migration-m5-v1.md` at full size, against the same baseline at comparable cost. Write `.debate/eval/full-<date>.md` with the same three measures plus cache-hit ratio.
*Acceptance*: the eval file exists and records a keep/tune/drop decision.

---

## 12. Not to build

- No bash orchestrator, no `~/.pi/agent/bin/debate`, no `~/.pi/agent/prompts/debate.md`.
- No long-lived agents, no "wait for your name" prompts, no channel polling loops.
- No `pi-messenger-swarm --start/--stop/--restart` from the extension.
- No `~/.pi/config.yaml`, no `pi run`, no `spawn --model` (none exist).
- No verdict-file rotation (per-run directories replace it); no deletion of anything under `.debate/`.
- No `--temperature` (pi has none).

---

## 13. Open items

| # | Item | Status |
|---|------|--------|
| 1 | JSON event names and shapes for text and usage | **Resolved** — §7.1/§7.2, from `docs/json.md` and `packages/ai/src/types.ts` |
| 2 | `--append-system-prompt` accepts a file path | **Resolved** — documented as "text or file contents", repeatable; `pi-messenger-swarm` relies on it |
| 3 | `-p` needed alongside `--mode json` | **Resolved** — no; `resolveAppMode` returns `json` from `--mode json` alone |
| 4 | Failure detection | **Resolved** — `stopReason: "error"` + `errorMessage`; `"length"` = truncation, feeds the repair path |
| 5 | Cost accounting | **Resolved** — `Usage.cost.{input,output,cacheRead,cacheWrite,total}` per message; enables the $5 cap |
| 6 | AGENTS.md / CLAUDE.md in children | **Decided** — always `--no-context-files`; config to re-enable |
| 7 | Third model family for the Synthesizer | **Resolved** — `opencode/gemini-3.1-pro` (Google). Roster confirmed by `pi --list-models`; Anthropic/OpenAI/Google are all independently available. WP0 now only smoke-tests auth and billing. |
| 8 | Whether prompt caching engages across turns | **RESOLVED by WP4 — it engages.** Measured on `openai-codex/gpt-6-astra`, three turns of one run sharing an identical persona + `@seed` prefix and varying only the volatile tail: `cacheRead` by turn = `[0, 0, 6272]`, with `input` collapsing 6510 → 6510 → 238 and cost 7× lower on the cached turn ($0.0654 → $0.0089). Caching also engages *intra-turn* (2176 `cacheRead` inside a single tool-using turn, since the agentic loop re-sends the prefix). Two caveats for the §4.1 cost model: (a) engagement was not immediate — turn 2 still read 0, so the first repeat of a prefix may pay full price and only turn 3 benefited; (b) `cacheWrite` stayed 0 throughout, so this provider does not bill a separate cache-write premium. §6.3's stable-prefix ordering is therefore worth keeping, and the "realistic cap is roughly double" fallback in §4.1 does **not** need to be assumed. |
| 10 | Per-message vs per-turn usage | **Resolved (was a defect in v3)** — `AssistantMessage.usage` is per provider request; run cost is the sum over all assistant `message_end` events. Corroborated by `swarm/progress.ts`. |
| 11 | Mission passed as argv | **Resolved** — emit `--` before positionals; attach the seed as `@path` (`src/cli/args.ts`). Avoids flag misparse, `ARG_MAX`, and `ps` exposure. |
| 12 | Bounding a runaway tool loop | **Resolved by design** — pi has no `--max-turns`; the mid-turn cost ceiling (§4.1) plus the per-turn timeout are the only guards. |
| 13 | Realistic cost of a full-size run | **Measured (WP5), §4.1's estimate was high.** On a 6.1KB seed, a complete 2-round `review` cost **$0.6165** over 16 provider requests (144K tokens, 60.3% cache read) in 4m18s — against §4.1's projection of ~$1–2 *per turn*. Actual per-turn: ideator $0.014, skeptic $0.155 then $0.382, judge $0.051. §4.1 over-estimated the Ideator by ~100× (it makes one tool-free request, not 3–6) and was roughly right about the Skeptic. Extrapolating the 51.8KB full plan at ~8.5× the seed with 3 rounds: **plausibly $4–8**, so the $5 default cap will bind but not absurdly. Caching is the reason: 60.3% cache read on a run this short. Replace §4.1's table only after WP8 measures the full-size case. |
| 33 | **WP5 value gate: the debate LOST to the baseline — stop-and-tune fired** | **§11 WP5's negative outcome, recorded as the work order requires.** Same 6.1KB seed, both arms with tools+bash. Debate: **$0.6165**, 3 high-severity claims, **all with `evidence: null`**, 3 bash calls. Baseline (one `claude-opus-4-8` call + self-critique): **$0.1268**, 4 *verified* high-severity findings plus 4 self-downgraded ones, **28 bash calls**. So the baseline found more, proved them, and cost **4.9× less**. Full analysis in `.debate/eval/probe-20260907.md`. Four causes: (a) **the Skeptic wrote tests instead of running them** — D5's whole premise is that a Skeptic with real bash beats a rhetorical one, and it had bash; (b) **a protocol defect — `disputed` closes the gate** (see item 34); (c) the Ideator produced 11 medium claims with zero tool calls; (d) **the judge returned confidence 0.9 over a ledger with no evidence in it**, despite being told "a claim resolved without evidence remains a risk". The lint saw everything — `conf_no_evidence`×6 and `skeptic_under_min_flaws`×1 — but is advisory only. What *did* work: protocol mechanics, 0 repairs, cost accounting, anonymization, all 7 §8.4 verdict sections, and 60.3% cache read. **Not proceeding to WP6 without tuning.** |
| 34 | **`disputed` closes the severity gate — protocol defect found in WP5** | **Design defect, not an implementation bug.** §5's gate is "no claim with `status=open` AND `severity ∈ {high, critical}`". §13.22c deliberately allows `open → disputed` with no `refutedPremise` so that §8.4's minority report stays reachable. Combining the two: in R2 the Skeptic moved **its own three high-severity claims** to `disputed`, which emptied the open-high set and **closed the gate before R3**. The mechanism designed to force extra scrutiny of unresolved high-severity items was switched off by the party those items belonged to, via a transition requiring no evidence whatsoever. The run then reported "No unresolved high-severity claims" while holding three unverified high-severity claims — actively misleading. Proposed fix (not yet applied): for gate purposes, treat a high/critical claim whose status changed away from `open` **without new `evidence`** as still open. Also worth enforcing rather than merely linting: a `high`/`critical` claim with `evidence: null` should be auto-demoted to `medium` or trigger a repair asking the Skeptic to run its own stated test. |
| 35 | **Unevidenced high severity: flagged, not demoted (WP5 fix, revised mid-implementation)** | **First attempt was wrong; recording both.** To stop the Skeptic asserting high severity without checking, I first *demoted* unevidenced high/critical claims to `medium`. The e2e test caught the flaw: demotion removes the claim from the R3 gate, so the one mechanism that could produce the missing verification never fires. The asymmetry matters — inflating severity only costs money (bounded by `rounds.max` and the cost caps), whereas parking claims to end the debate early hides risk. Final behaviour: the asserted severity **stands and drives the gate**, and the claim is flagged `high_severity_unverified` in events, lint, the judge's audit and the verdict header. Config `requireEvidenceForHigh` (default true). Also fixed a related asymmetry: `text` was absent from `SKEPTIC_FIELDS`, so the Skeptic could never correct its own wording while the Ideator could rewrite it freely — see item 39. |
| 36 | **Skeptic mission now demands *executed* tests (WP5 fix)** | §10's persona said "Run the tests you can", and WP5 measured the result: **3 bash calls per run** against a single-call baseline's 28, with every high-severity claim carrying `evidence: null`. Asking for tests as a *field* produced test *strings*. The mission now states an explicit floor (`skeptic.minEvidencedFlaws`, default 2) requiring actual command output in `evidence`, warns that unevidenced high severity is recorded UNVERIFIED, states that parking a claim as `disputed` does not retire it, and offers an honest `"not testable here: <reason>"` escape hatch so the floor does not induce fabrication. Measured effect: evidence coverage ~0 → **16/16 claims**, tool calls 9 → 48, bash 3 → 11. |
| 37 | **Judge gets an orchestrator-computed evidence audit (WP5 fix)** | WP5's judge returned **confidence 0.9 over a ledger in which every high-severity claim had `evidence: null`**, despite being told "a claim resolved without evidence remains a risk". Relying on the judge to audit the ledger itself did not work. `prompts.ts` now computes the evidence position and hands it over as fact: claim totals, how many high/critical claims lack evidence, **the specific ids**, and any lint codes raised — plus a hard rule that confidence must be ≤ 0.5 when most high-severity claims are unevidenced, and an instruction that one reviewer conceding to another is not verification. Re-probe result: **0.8, justified by cited command output**. |
| 38 | **Failed turns were undiagnosable — `stderrTail` was discarded** | **Found the hard way.** A re-probe attempt lost 5 turns to transient `stopReason: "error"` (4 assistant messages, 0 tokens — retry-then-fail), including the judge, producing a mechanical verdict. The cause was unrecoverable afterwards: `TurnResult.stderrTail` existed but was never persisted, and `errorMessage` from §7.2 was never captured. All three providers tested healthy minutes later, so it was a provider blip — but establishing that required re-running the whole probe. Now: `runner/direct.ts` folds the final assistant message's `errorMessage` into `stderrTail`, and the orchestrator persists it on failed/timeout/costcap turns in both `manifest.json` and `events.jsonl`. Cheap, and the only way to distinguish a provider outage from a prompt defect once a run is over. |
| 39 | **One author could silently erase the other's findings — most dangerous bug found so far** | **WP5 re-probe defect.** §8.1 grants the Ideator `text` and `evidence`, which is correct for its own claims and destructive on the Skeptic's. Observed live: the Ideator rewrote **all three** of the Skeptic's high-severity claims, replacing each finding with its own rebuttal ("Disputed severity: B1's operational risk depends on…") and replacing the Skeptic's command output with seed quotes. The ledger then reported **100% evidence coverage while the actual verification had been deleted**; the original finding survived only in the archived turn file. This is worse than a crash because it makes the output look *better* — a reviewer reading the ledger would see fully-evidenced claims and never know the adversarial record had been overwritten. Fix: `text`, `evidence`, `type`, `confidence` are **own-claim-only**; a cross-author attempt is refused and logged as `cross_author_overwrite_denied`. Disagreement goes through `status` + `refutedPremise` + `history`, which is what flip discipline exists for. `status` and `sourceRef` remain cross-author editable. |
| 40 | **WP5 re-probe: the protocol now works; the value question is cost, not capability** | **Gate re-run after items 34–39.** Same seed and baseline. The debate reached **R3**, produced **16/16 evidenced claims** (was ~0), **2/2 evidenced high-severity** (was 0/3), and **independently reproduced the baseline's strongest finding** — the `binary-watchdog` un-freeze — via a different model family with real command output. It also found one thing the baseline explicitly listed under "What I missed": `factory-watchdog` can `issue rerun` after triggers are disabled. Cost **$2.1101 vs the baseline's $0.1268 — 16.6×**, 8m44s, 74.2% cache read, 0 failed turns. Full write-up in `.debate/eval/reprobe-20260907.md`. Assessment: the debate earns its cost when being wrong is expensive (irreversible migration, production cutover) and does not when a quick review suffices — which argues for keeping it an explicit `/debate` invocation rather than anything automatic. §4.1's table should still not be rewritten until WP8 measures the full 51.8KB document; every finding here is against a 6KB excerpt and both arms noted they were critiquing a truncated plan. |
| 9 | (harness only) agents JSONL `completed` event shape | **Open** — WP7 only |
| 41 | **Cost ruling: `tune`. Skeptic swapped off the exhausted codex subscription and given a role budget** | **User ruling on §13.40's open question, plus a forced provider change.** The user ruled **tune** (not keep-as-is, not drop) and reported the OpenAI subscription exhausted; `openai-codex` turns now fail with `stopReason: "error"`, `"Codex error: The usage limit has been reached"`. These are one decision, because the re-probe's §7 table shows the **Skeptic is 95.3% of run cost — $2.0101 of $2.1101** across three near-constant-cost turns ($0.8062 / $0.6341 / $0.5698), while the Ideator totals $0.0429 and the judge $0.0572. Tuning anything other than the Skeptic would be theatre. **Swap:** skeptic → `openrouter/openai/gpt-5.6-sol`. Chosen because it keeps the OpenAI family (D8's three-family property verified still holding: anthropic/openai/google), is described as the 5.6-series flagship for "command-line and multi-step coding" — the Skeptic's actual job — carries 1.05M context, and prices at in=$2/M out=$10/M against gpt-6-astra's in=$10/M out=$50/M, i.e. **~5× cheaper on the dominant role**. Validated live before adoption, WP0-style: `stopReason: "stop"`, real non-zero `cost.total` (so the §13.14 zero-price-table hazard does **not** apply and the USD cap can bind), `--tools bash` genuinely granted (2 bash calls), and a tool loop emitting **3 assistant `message_end` events summing 3.0× the last one alone** — independently re-confirming §7.1's summing rule and §13.17's assistant-only filter on a new provider. **Tune:** `roles.skeptic.budget.usd = 1.2`, the first non-empty default role budget. Rationale: the three Skeptic turns cost nearly the same because R3 largely re-verifies claims it already evidenced in R1/R2, so the third turn is where marginal value is thinnest; $1.20 funds two full tool-heavy turns and stops a third from repeating itself. Per §13.28's ordering a role budget can only ever stop a role *sooner* than the run cap, never authorize more, so this cannot increase spend. **Projected effect:** ~$0.71 for the Skeptic at the re-probe's 578,862-token volume, run total ~$0.81 vs $2.11 — about **6.4× the baseline instead of 16.6×**. Gate logic deliberately unchanged: `gateWantsAnotherRound`/`isUnsettled` are what make an unevidenced high-severity claim keep the debate alive (§13.34), and narrowing that to save money would re-open the §13.35 mistake of hiding risk to cut cost. **New `strong` tier** preserves the old roster so the re-probe stays reproducible and the subscription roster is one word away if restored — with the caveat that gpt-6-astra billed through OpenRouter costs real money (~$3.54/run) where the subscription billed $2.01. **Unverified:** these are projections from measured token volumes, not a new live run. The next real run must be checked against them, and WP8 remains the tiebreaker on the full 51.8KB document. **Constraint worth flagging:** OpenRouter now carries the whole roster and shows **$13.14 remaining of $65** — at ~$0.81/run that is ~16 runs, and WP8 on a 51.8KB seed will cost several of them. |
| 42 | **OpenRouter is now a single point of failure for all three roles** | **Consequence of §13.41, noted not fixed.** Before the swap the roster spanned three credentials (`openai-codex` subscription, `OPENROUTER_KEY`, and IBM for the free tier); now all three paid roles route through `OPENROUTER_KEY`. If that key is absent from the extension child's env the entire debate fails rather than one role degrading — sharpening §13.18's warning from "two of three roles break" to "all three". Two mitigations exist and neither is wired up: `tier: "free"` (IBM, but violates D8) and `tier: "strong"` (needs the codex subscription back). WP6 should surface a readable precondition error when `OPENROUTER_KEY` is missing rather than producing three 404 turns and an empty verdict. Also unresolved: the $13.14 balance is visible via `GET https://openrouter.ai/api/v1/credits`, which *is* a reachable API — unlike the IBM credits dashboard in §13.33 — so a real remaining-balance readout is now feasible if the status line should show one. |
| 43 | **WP6: `abort()` now persists `aborted` immediately — and my first test for it was worthless** | **WP6 implementation, plus a negative result worth recording.** The gap was real: `abort()` set `this.aborted` and fired the AbortController but wrote nothing, so the manifest only became `aborted` when `drive()`'s loop unwound and reached its own write. A hard kill, a wedged child, or a crash between turns left `status: "running"` on disk forever, which then depended on the §9.4 sweep to clean up — and §11 names "abort kills and marks aborted" as acceptance. Fixed: `abort()` writes `status`, `endedAt`, a note and an `aborted` event synchronously, guarded to be idempotent, to no-op before `init()` (the paths and manifest do not exist yet), and to never overwrite a run that already finished. `drive()`'s later write is now conditional on `status === "running"` so it cannot duplicate the note. **The negative result:** my first test asserted the manifest was `aborted` after `start()` returned, and it *passed against the unfixed code* — because with the fake runner `drive()` always unwinds normally, so the old write still happened. Reverting `abort()` broke only 2 of 26 checks, and neither was the one I wrote for this. This is §13.31/§13.32 again in a new costume: the test asserted on a file, which was supposed to be the safeguard, but at the wrong *moment*. The discriminating test (a2) reads `manifest.json` from **inside** the skeptic turn, immediately after calling `abort()`, before any unwinding — i.e. what `kill -9` at that instant would leave. Against the old code it now reports `got "running", want "aborted"`. Lesson to carry into WP7/WP8: for persistence requirements, assert at the moment the guarantee is claimed, not after the happy path has had a chance to paper over it. |
| 44 | **WP6: sweep extracted, entry renderer added, injection now carries the verdict not just the summary; `ui.ts` deliberately not created** | **WP6 completion notes, three deviations recorded rather than silently taken.** (1) **`sweepStaleRuns` moved out of `index.ts`** into `orchestrator.ts`. It was inline in the `session_start` hook, and §13.21 says `index.ts` cannot be imported by tests — so the one WP6 criterion that is purely about on-disk state had no way to be tested. It now also re-reads the manifest before writing (so a run that finished concurrently is left alone), survives one corrupt manifest without abandoning the rest, and returns the ids it changed. (2) **`registerEntryRenderer("debate-verdict", …)` added**, which §9.3 asked for and did not exist; `appendEntry` was rendering with the default. Collapsed it shows status, cost and open-high count; expanded adds the summary and path; it carries the `?` cost-understated marker from §13.19 so a fake dollar figure is never shown as fact. Verified by loading through pi's own `discoverAndLoadExtensions` (`entryRenderers: Map(1) [debate-verdict]`, zero load errors) and by invoking the renderer against a theme stub in both states plus empty data. Note the loader exposes these as **`Map`s, not objects** — an `Object.keys()` check on them silently reports nothing and looks like a failure. (3) **Injection now sends the verdict document**, not just the summary line: §11 requires the next prompt to "demonstrably have the verdict in context", and the summary alone omits the decision, unresolved items and minority report. Falls back to the summary if the file is unreadable, and is sent `display: false` since the renderer already shows it. (4) **`ui.ts` was NOT created**, deviating from §3's file list. The UI code is ~20 lines across `renderProgress`/`clearProgress`/`say`, all of which are thin `ctx.hasUI` wrappers with no logic worth isolating; moving them would add a file and an import cycle risk to test three string concatenations. The widget's real behaviour is already covered by asserting on the `Progress` stream that feeds it (per-turn firing, monotonic cost, agreement with the manifest total). Revisit if WP7's publisher needs to share rendering. |
| 45 | **New `ibm` tier: zero dollars with D8 intact — and a correction to my own WP7 claim** | **User direction, plus a mistake of mine worth recording.** (1) **The `ibm` tier.** The user's framing: IBM models are free from their perspective, and the worst case is running out of quota for a while — a recoverable failure, unlike a surprise bill. That reframes §13.14 from a blocker into an accepted trade. `ibm` places all three roles on `ibm-services-essentials` but, unlike the pre-existing `free` tier, keeps **three distinct families** (`claude-opus-4-8` / `gpt-5.6-sol` / `gemini-3.7-flash`), because IBM fronts all three vendors — so it is the only zero-dollar roster that does **not** violate D8, and the judge stays independent. All three verified live: `stopReason: "stop"`, and the skeptic model genuinely gets `bash` (2 real calls in a probe). **The trade, stated rather than hidden:** every USD cap is inert here, including the $1.20 skeptic cap from §13.41, so the tier ships explicit **token** budgets instead — `applyTier` was extended to carry per-role budgets, filling only fields the user left unset. Sized against a measured **16.3K tokens for a 2-bash-call turn on IBM versus ~420 for the same task on OpenRouter**: there is no cache-read discount to earn when the price table is all zeros, so token budgets here must be far larger than USD-equivalent intuition suggests. The models are deliberately **not** declared `free`, because `free: true` would suppress the `cost_unreported` warning (§13.29) and here that warning is true. **Live end-to-end run** on a 279-byte cutover seed: `status: complete`, 2 rounds, 14 claims, 5 high-severity findings, real minority report, 93.6K tokens, **$0.00**, `costTrusted: false` propagated to the widget and the verdict, every row marked `$0.0000 (?)`, and **17 bash invocations — more verification than the $2.11 OpenRouter re-probe's 11**. So this is not a degraded mode; on this seed it was strictly better value. Caveat: one `skeptic_under_min_flaws` lint, and a small seed proves less than WP8 will. (2) **Correction: I was wrong that D11 forbids WP7.** D11 forbids *starting or stopping* a harness the extension did not start, and §12 forbids `--start/--stop/--restart`; neither forbids **using** the harness, and WP7's own acceptance criterion is "the extension never calls `--start`/`--stop`". I conflated "do not manage its lifecycle" with "do not touch it" and told the user WP7 was ruled out on those grounds. It is not. What *does* argue against the `harness` **runner** is §1.1 and §6.4 on their own terms: the harness discards child stdout, cannot pass `--tools`/`--thinking`, caps concurrency at 3, and — decisively — gives **no usage/cost, so budget enforcement degrades to time only**. On that path the skeptic's tool restrictions and every cost bound stop existing, which is the §13.14/§13.23 failure mode by choice. The **publisher** half (`publish.ts`) has no such defect: it is one digest per merged ledger, `publish: {enabled, channel}` already exists in config with **nothing reading it**, and it would give the swarm-channel visibility the user actually asked about. Recommendation: build `publish.ts`, leave `runner/harness.ts` unbuilt unless `pi` children misbehave (§1.1's stated fallback reason). |
| 46 | **WP7 publisher built; it must speak HTTP, because the CLI would violate D11 and lies about failure** | **WP7's second half implemented (`publish.ts`); `runner/harness.ts` still deliberately unbuilt.** The obvious implementation — shell out to `pi-messenger-swarm send '#debate' "…"` as §11 literally writes — is **unsafe on two counts, both verified against the installed 0.25.32 CLI on 2026-09-07**. (1) **It would violate D11.** `dist/harness/cli.js` auto-starts the daemon when it is down: `spawnChild(cmd, args, {detached: true, stdio: ['ignore','ignore','ignore']})` followed by a 10s readiness poll. With the server down, `pi-messenger-swarm send '#debate' probe` tried to spawn one and printed "server failed to start on http://127.0.0.1:9877". D11 forbids starting a harness the extension did not start, so a shell-out publisher violates it on any machine where the daemon happens to be down — i.e. this one, right now. (2) **That failure exits 0.** A publisher trusting the exit code would report success while posting nothing, silently. Therefore `publish.ts` probes `GET /health`, refuses if it is not 200, and otherwise posts `{action:'send', to, message}` to `/action` with an `x-agent-name: debate-orchestrator` header — the contract read off `cli.js` (`case 'send'` → `postAction(buildAction({action:'send',to,message}))`, plus `agentHeaders()`), not guessed. §6.4's rule — preconditions checked, never fixed by the extension — is thus applied to the publisher as well as the runner. Three further traps handled: a bare `channel: "debate"` is **normalized to `#debate`**, because `send` treats a bare name as a direct message to an *agent* of that name and digests would silently unicast into the void; **HTTP 200 is not success** (the harness answers 200 with `{ok:false,error}` for app-level refusals such as not-joined), so the body is inspected; and the id list is capped at 8 with a `+N` marker since `feedRetention` prunes channel history and a 20-claim ledger would produce an unreadable line. Wiring: fire-and-forget from `mergeTurnText` so publishing cannot make the merge path async (that would ripple through the state machine), with in-flight promises tracked in a `Set` and awaited via `settlePublishes()` before `finalize()` so `events.jsonl` is complete; every outcome becomes a `published` or `publish_skipped` event and **never** a run failure. Verified: 51 new checks; removing the health gate makes the suite fail with "no /action was posted", so the tests genuinely discriminate rather than merely passing; and against the real down daemon the publisher declined with a readable reason and **left it down, with no stray harness process** — which the CLI path would not have done. Test j proves a wedged harness (a fetch that never resolves) can neither stall nor fail a run. |
| 47 | **D11 retired; harness was unstartable due to a packaging bug; and my publisher was reporting false success** | **User ruling plus three findings, one of which was a live defect in my own code.** (1) **D11 retired, as the user judged.** Its rationale was concurrency safety for a shared daemon, but it is unenforceable by abstinence: `pi-messenger-swarm send` **auto-starts the daemon itself**, so any use violates it as a side effect. Replaced with the narrower rule that actually protects other sessions: **the extension may start the harness, but must never `--stop` or `--restart` it** — stopping is the only irreversible action that can break a session it does not own. (2) **The harness could not start at all — a packaging bug, not a design limit.** `dist/harness/server.js` does `import { getAgentDir } from '@earendil-works/pi-coding-agent'`, but `pi-messenger-swarm` declares **no dependencies at all** and that package was absent from `~/.pi/agent/npm/node_modules`, so every start died with `ERR_MODULE_NOT_FOUND` before it could even write its log — which is why `--start` printed "server failed to start" and `/tmp/pi-messenger-swarm.log` did not exist. Fixed locally by symlinking the globally-installed pi 0.85.1 into that tree; the daemon then started and `/health` returned 200. **This is upstream's bug and the symlink is a local workaround** — worth reporting, and it will break again on a clean reinstall. (3) **Correction to §1.1, which was wrong in the harness's favour:** it claims the harness "discards the child's stdout". False — `spawn.js` uses `stdio:['ignore','pipe','pipe']` and parses the JSONL stream, summing `message_end` usage. **But §6.4's conclusion still holds for a better reason:** those token counts live in `liveWorkers`, an **in-memory Map inside the daemon process** (`live-progress.js`), and the persisted `completed` event carries only `{status, endedAt, exitCode, error}` — no usage. Cost is **never computed at all**; `progress.js` sums `input + output` tokens only, never `cost.total`. And agent-file frontmatter supports only `role`/`persona`/`model`/`objective` — no `tools`, no `thinking` — so the Skeptic's allowlist cannot be restored on that path. Routing turns through `spawn` would therefore still delete tool restriction and all cost/token enforcement. This also settles §13.9: the `completed` shape is `{id, type, timestamp, agent:{status, endedAt, exitCode, error}}`. (4) **My publisher was reporting false success — found only by reading the channel as a third party.** The harness signals application failures as `{ok:TRUE, result:{details:{mode:'error', error:'not_registered'}}}`. My §13.46 code checked only top-level `ok`, so `publishDigest` returned `published:true` while the message was **silently dropped**. Confirmed by joining the channel and finding the digest absent. This is the third instance of the §13.31/§13.32/§13.43 pattern: the test I wrote to prevent exactly this ("200 with ok:false is not success") asserted the *wrong shape*, so it passed. Fixed with a shared `harnessRefusal()` checking both shapes, plus **auto-join**: `send` requires registration, so a `not_registered` refusal now triggers one `join --create` and exactly one retry (not a loop). **Verified by reader, not by return value** — `feed --channel debate` shows `debate-orchestrator → #debate: R2 · 2 open high · B1,B2`, and a full run streams five labelled digests. Digests now name the author (`R1 skeptic · …`) because consecutive same-round merges otherwise read as contradictory: the ideator's merge legitimately reports 0 open high before the skeptic's claims land. **Lesson:** for any send-and-forget integration, success must be confirmed from the receiving side; the sender's own status is not evidence. |
| 48 | **Two-way participation at `trust: "comments"` — outside agents can speak into a debate, but never into the ledger** | **User ruling after the sketch (`docs/design/two-way-participation-sketch.md`): comments, not claims.** Also clarifies the authorship question the user raised: **the final proposal is the Synthesizer's**, not the orchestrator's. `buildVerdict` wraps the judge's prose (§1–§6) in orchestrator-computed facts — header tallies, unsettled/unverified counts, cost §7 — and the orchestrator's real power is as **gatekeeper**: it decides what the judge may see and constrains it (§13.37 caps confidence at ≤0.5 when most high-severity claims lack evidence). So outside input can influence the outcome only by persuading a model, never by asserting into the record. **Implementation:** `participate: {enabled:false, channel:"", maxComments:5, trust:"comments"}`, off by default. `readComments()` reads the channel at **turn boundaries only** — one bounded read, not a poll, because §12 forbids channel polling loops and a `while(!done) sleep()` would be exactly that. Comments are inlined into every mission **including the judge's**, since the judge has no tools and cannot see a file (§8.3, learned the hard way in §13.31). They are framed as unverified, outside the debate, and not ledger claims; debaters are told they may adopt one as their OWN claim with their own evidence, and are told not to cite an agent's name in claim text because authorship is stripped downstream and a name would defeat §5.1 anonymization. The judge is told its decision must rest on the ledger. **Loop safety:** messages from `PUBLISHER_AGENT_NAME` are excluded, so the debate never reacts to its own digests; `sinceTs` suppresses re-reads; `maxComments` bounds the total. **Truncation added after a live run showed the flaw:** `preview` is not length-capped by the harness, and 224 chars of my own test junk went straight into the judge's prompt — comments are now clipped at 400 chars, because judge context is billed and an unbounded message could crowd out the ledger itself. **Verified live end to end:** an outside agent (`@PeerReviewer`) posted to `#debate`, a real run read it, and the judge's mission contained it under the unverified heading while `ledger.json` stayed strictly `A`/`B` with no mention of the agent. The load-bearing tests are negative — "outside comment is NOT a ledger claim", "no claim is authored by an outside agent" — because the whole risk of this feature is §8.1/§13.39 being bypassed by anyone with channel access. **Not built:** author `X` claims (sketch §3), and the reverse direction (debate asking the channel and waiting), which is close to the "wait for your name" pattern §12 forbids. |
| 14 | **`ibm-services-essentials` reports `cost.total == 0` for every model** | **WP0 discrepancy — models swapped.** The Ideator's §4 model `ibm-services-essentials/claude-opus-5` authenticates and returns `stopReason: "stop"`, but all 19 models in `~/.pi/agent/ibm-services-essentials-models.json` carry a zero cost table. It is a fixed-credit plan (475.41/500 credits spent), so pi has no per-token price to multiply. **This silently disables D9**: both the $5 run cap and the $2 per-turn ceiling sum to 0 and can never trip. Swapped Ideator to `openrouter/anthropic/claude-opus-4-8` (Anthropic family preserved, so D8's three-distinct-families property holds; verified genuinely Claude by direct question, stable and billing across 3 runs). **Design consequence beyond the swap:** the cost cap is only as real as the provider's price table, so the orchestrator must treat "a turn completed with `cost.total == 0`" as a *warning condition*, not as a free turn — otherwise re-adding an IBM model in config silently removes all cost enforcement. To be implemented in WP3/WP4. |
| 15 | **`opencode` provider has no credit balance** | **WP0 discrepancy — models swapped.** `opencode/gemini-3.1-pro` (the §4 Synthesizer) returns `stopReason: "error"` with `401 CreditsError: Insufficient balance`. Its pricing table is fine; the workspace is simply unfunded, so *all* `opencode/*` models are unusable — including the §4 cheap-tier entry `opencode/gemini-3.5-flash` and the ctx-overflow alternate `opencode/gpt-6-astra`. Swapped Synthesizer to `openrouter/google/gemini-3.1-pro-preview`, which is the exact alternate §4 already lists. Google family preserved. **The §4 alternates table needs revising** — its cheap tier and large-context fallbacks both name dead `opencode` models; substitutes should come from `openrouter`. Not editing §4 per instructions; flagging here. |
| 16 | **OpenRouter model ids: hyphenated works, dotted 404s** | **WP0 discrepancy — do not "fix" this.** `--model anthropic/claude-opus-4-8` (hyphenated) works and bills correctly, while the ids exactly as listed in `models-store.json` — `anthropic/claude-opus-4.8`, `anthropic/claude-opus-5` (dotted) — both return 404 through this gateway. The hyphenated form logs `Warning: Model "…" not found for provider "openrouter". Using custom model id.` to stderr but is passed through verbatim and served correctly; `message.model` echoes back what was sent, so there is **no silent substitution**. Persona frontmatter must use the hyphenated form. §4's "split on the first slash only" rule is unaffected and correct. Also: `openrouter/anthropic/claude-sonnet-5` 404s, so the cheap tier needs a verified alternate before WP5. |
| 17 | **`message_end` fires for non-assistant messages** | **WP0 discrepancy — affects `runner/direct.ts`.** §7.1 says `message_end` "fires for every assistant message", which is true but incomplete: it also fires for `user` and `toolResult` messages. The tool probe emitted roles `["user","toolResult","toolResult"]` interleaved with 3 assistant messages. These carry `usage: undefined`. The runner **must** filter `message.role === "assistant"` before summing usage and before computing `messageCount`, or `messageCount` overstates provider requests and the usage loop touches undefined. No design change needed — §7.1's accounting rule itself is confirmed correct (summed 0.029696 vs last-only 0.012622 = **2.35× undercount** on just 2 tool calls; 5.69× on an earlier identical probe). |
| 18 | Only one provider in `auth.json` | **Noted.** `auth.json` contains `openai-codex` only; OpenRouter is reached via the `OPENROUTER_KEY` env var and IBM via its own model file. The post-WP0 roster therefore depends on exactly two working credentials (`openai-codex`, `OPENROUTER_KEY`). If `OPENROUTER_KEY` is absent from the extension child's env, two of three roles break — so the runner must not scrub env vars, and WP1's config should surface a readable precondition error rather than a 404 mid-debate. |
| 19 | **A USD cap is unenforceable on providers with no price table — `budget` extended** | **Addition beyond §9.5, agreed with the user after WP0.** §9.5's `budget` block assumes `cost.total` is always real; §13.14 shows it is not. `config.ts` therefore adds two keys: `budget.perTurnTokens` (default 400000), a token-denominated mirror of `perTurnUsd` that bounds a runaway tool loop even when cost is reported as 0; and `budget.costReporting: "warn" \| "require" \| "ignore"` (default `warn`), which decides what happens when a turn reports `tokens > 0` but `cost.total == 0`. On `warn` the orchestrator logs `cost_unreported`, keeps enforcing the token cap, and must mark the run's cost figure as understated so the verdict's §7 never presents a fake dollar total; on `require` the run stops rather than spending unmetered. `budget.tokens` is thus the always-on backstop and the USD cap is best-effort. To be honored by the orchestrator in WP3 and the runner in WP4. |
| 20 | **Extension must be loaded by auto-discovery, not `-e`, once installed globally** | **WP1 discrepancy — affects §11's acceptance commands.** §11 WP1 specifies `pi -e ~/.pi/agent/extensions/debate`. Because D1 puts the extension in the auto-discovered global directory, `-e` loads it a *second* time and pi aborts with `Tool "debate_run" conflicts with …`, exit 1. The correct invocation is plain `pi` (auto-discovery); `-e` is only for extensions outside the discovery roots, as `docs/extensions.md` states. WP1 acceptance was therefore run without `-e` and passes: `/debate status` prints "no active run", `pi --mode json --no-session '/debate runs'` exits 0, and a TUI session boots with all six installed extensions and no conflict. Later WPs should not use `-e` for this extension. |
| 21 | **`typebox` / `@earendil-works/*` are not resolvable outside pi's loader** | **WP1 discrepancy — shaped the file layout.** §3's layout implies command/mode logic lives in `index.ts`, but `index.ts` must import `typebox` and `@earendil-works/pi-coding-agent`, which only pi's jiti loader provides; a bare `npx tsx test/…` importing `index.ts` dies with `Cannot find module 'typebox'`. Pure logic was therefore split into `command.ts` (no pi imports), leaving `index.ts` as registration-only glue. This keeps WP2/WP3 unit-testable without booting a session, which §11 requires for the fake-runner packages. No design intent changed; recording because the file list in §3 now has one extra module. |
| 22 | **§5.1 flip discipline and the agreement budget compose in sequence — order matters** | **WP2 clarification, no design change.** §5.1 states the two rules independently and does not say which applies first, which permits two incompatible readings. Implemented ordering: **flip discipline is the outer gate** — `open -> resolved|withdrawn` is rejected for *either* author unless `refutedPremise` is supplied — and **the agreement budget is the inner check**, applying only to Skeptic flips that already passed flip discipline and carry no new `evidence`. Consequences worth stating because they are counter-intuitive: (a) a bare `{"status":"resolved"}` from the Skeptic is recorded as `flip_rejected`, **not** `agreement_budget_exceeded`, and does **not** consume an agreement; (b) exercising the budget at all requires `refutedPremise` present *and* `evidence` absent; (c) `open -> disputed` is not a flip and needs no `refutedPremise`, which is what makes §8.4's "minority report is never empty when any claim is disputed" reachable; (d) the budget binds the Skeptic only, per §5.1's wording. The alternative ordering (budget first) would let an evidence-free concession consume the budget and then be rejected anyway, double-penalizing one turn. |
| 23 | **Discarded turn attempts must still be charged — defect found and fixed in WP3** | **WP3 implementation defect, caught by test (i).** The first orchestrator drafted recorded only the *surviving* attempt of a turn, so a turn killed by the per-turn ceiling or a timeout was replaced by its repair and its spend disappeared from `manifest.totals`. Measured: a run whose Skeptic turn was killed at $2.05 reported a run total of $1.05. This is precisely the failure §4.1 warns about — "cost cap" as "a comforting label on an unenforced limit" — and it defeats D9 from the inside, because the mid-turn ceiling fires correctly and then the evidence of it is discarded. Fixed: **every attempt is recorded with `merged:false` immediately after it returns**, before the repair decision, so `costcap`/`timeout`/`failed` attempts are charged against `budget.usd`, `budget.tokens` and the verdict's §7 table. Repair attempts are tagged `repairOf`. §8.6's `merged` flag is now also the resume key: a turn is only skipped when `status === "ok" && merged`, so an attempt that was paid for but yielded no usable ledger block is correctly re-run rather than skipped. |
| 24 | **`events.jsonl` key collision silently erased an event type** | **WP3 implementation defect, fixed.** `appendEvent(path, code, data)` built its record as `{ts, code, ...data}`, so a caller passing `code` inside `data` overwrote the event's own name. A `ledger_block_unusable` event carrying `code: block.code` was therefore written as `code: "missing_block"` and became invisible to every consumer looking for it — the failure mode is silent and would have corrupted audit trails, budget forensics, and the widget's lint counts. Fixed twice over: the caller now passes `blockCode`, and `appendEvent` itself reserves `code`/`ts`, relocating any colliding data key to `data_code`/`data_ts`. Worth noting for WP6/WP7, which add more event emitters. |
| 25 | **An aborted run does get a verdict file** | **WP3 clarification.** §2 ("Termination") reads as though `abort` produces no verdict, while §8.4 lists `aborted` among the valid values of the verdict's `Status:` field. The latter is implemented: an aborted run writes `turns/verdict.md` and the root copy with `Status: aborted`, containing the mechanical unresolved-items listing built from the ledger, and **no judge turn is attempted** (so abort never spends another model call). Only `status: failed` — which §5.1 defines narrowly as "both R1 turns failed" — writes no verdict at all, on the stated grounds that a verdict over an empty ledger is worse than none. |
| 26 | **§7.1's accounting rule confirmed against live `pi` a second time** | **WP4 measurement.** The raw stream of a 2-tool-call turn on `openai-codex/gpt-6-astra`: 3 assistant `message_end` events, summed `cost.total` $0.029664 vs last-message-only $0.012890 = **2.30×**. WP0 measured 2.35× and 5.69× on the same probe shape. The undercount scales with tool-call count, so a 6-call Skeptic turn would be far worse. `runner/direct.ts` sums over `message.role === "assistant"` only, and `test/runner-direct.test.ts` item 2 compares the runner's figure against an independent manual sum of a raw invocation so this cannot silently regress. |
| 27 | **Mid-turn cost ceiling verified against live `pi`** | **WP4 measurement, D9 is real.** With `perTurnUsd: 0.001` against a mission designed to make 8 sequential bash calls, the child was killed after **1 assistant message, 3.4s**, at $0.01259 — versus a 180s timeout that would otherwise have been the only bound. Separately, a `sleep 120` bash mission with `timeoutMs: 5000` returned `status: timeout` at 5011ms and `pgrep -f 'pi --mode json'` was empty after `killAll()`. Both guards from §4.1 ("the only guards" against a runaway loop, since pi has no `--max-turns`) are therefore working. Note the ceiling fires *at a message boundary*, so it can overshoot by one message's cost — acceptable, and the reason `perTurnUsd` should stay meaningfully below `budget.usd`. |
| 28 | **Per-role cost/model/tool configuration — addition beyond §9.5** | **User-requested; §9.5 had no way to express it.** §9.5 offers one global `budget` block and `models.*` as bare strings, so there was no way to say "the Skeptic may spend more than the Ideator", give one role a different thinking level, or cap a single role. Added a `roles` block: `roles.<role>.{model, thinking, tools, free, budget{usd, tokens, perTurnUsd, perTurnTokens, turnMs}}`. Semantics chosen so the feature cannot increase spend: **a role budget can only narrow, never widen** — every role figure is clamped to the corresponding run-level cap, and exceeding it is warned about and clamped rather than honored. A role that exhausts its own cumulative budget is **skipped, not fatal**: the round continues so the other debater and the judge still run, since one expensive debater starving the judge would be worse than an incomplete round. Precedence is `roles.<role>.model` > legacy `models.<role>` > persona frontmatter, with a warning when the first two disagree. Backward compatible: `roles` defaults to `{}` per role and every field falls back to the previous run-level behavior. Guardrails added for configs that defeat the design: granting the Synthesizer tools (violates D5) and removing a debater's tools both warn. Role budgets are checked at turn boundaries, so like `budget.usd` they can overshoot by at most one turn. |
| 29 | **Free models: `cost.total == 0` is legitimate for them, and must not be conflated with §13.14** | **New, from the IBM Advantage Credits dashboard.** The dashboard lists models that "don't use your credits". Verified individually 2026-09-07: `claude-haiku-4-5` ✓, `gemma-4-26b-a4b-it` ✓, `ibm/granite-4-h-small` ✓, `meta-llama/llama-4-maverick-17b-128e-instruct-fp8` ✓ — but **`gpt-5.6-luna` is advertised free and returns `403 team not allowed to access model`**, so it is deliberately excluded from `KNOWN_FREE_MODELS`. This creates an ambiguity: §13.14 treats "tokens but zero cost" as a broken price table that disables the USD cap, while for a free model zero is the correct answer. Resolved with a `free` flag (per-role, or inferred from `config.freeModels`): a free role does **not** raise `cost_unreported`, does not flip `costTrusted`, and is exempt from `costReporting: "require"` — but **token caps still apply, because free is not unlimited**. The verdict's §7 table prints `free` rather than `$0.0000` for those turns and adds a line stating how many turns and tokens were free, so a genuinely-free run and a run with broken pricing are distinguishable at a glance. |
| 30 | **Model tiers (`tier: "free" \| "cheap" \| "default"`)** | **Addition; replaces §4's dead alternates table.** §4's cheap tier named three `opencode` models, all unusable (§13.15), so "switch to something cheaper" had no working answer. `tier` sets all three role models in one word, applied after config merge, and any explicit `roles.<role>.model` still wins. **`free` deliberately violates D8** and says so: the only capable free model is `claude-haiku-4-5` (Anthropic, thinking + tools + reliable ledger compliance), so Ideator and Skeptic share it and only the judge differs (`gemma-4-26b-a4b-it`, Google, but no thinking support and 128K context). The D8 warning still fires; that is the honest trade and the reason `free` is not the default. Measured live on a 6.1KB seed: a complete 2-round `review` run, 7 turns, 283K tokens, **$0.00**, producing 11 claims and a `proceed-with-changes` verdict with one critical finding. Caveats worth knowing: haiku needed the 180s turn timeout raised (it hit it twice and consumed both repairs), and `cacheRead` was 0 throughout, so the free tier is slow (≈13 min) rather than cheap-and-fast. |
| 31 | **The judge was never given the ledger — defect found by the first live run** | **Serious defect, fixed.** §8.3 says the judge receives "anonymized ledger (no `author`, no `history.by`) + excerpts", and the orchestrator dutifully wrote `judge/ledger.json` to disk — but `buildMission` excluded the ledger for `role === "synthesizer"`, and the Synthesizer has **no tools** (D5), so a file on disk is invisible to it. The first live free-tier run therefore produced a verdict reading: *"The claim ledger … was not provided in the prompt. As the Synthesizer, I cannot evaluate … Please provide the claim ledger to proceed."* — a completely useless verdict after 7 successful turns and 283K tokens. Every fake-runner test had passed because they assert on the *files*, not on what reaches the model. Fixed by inlining `anonymizeForJudge(ledger)` into the judge's mission, with an explicit "the ledger is empty" note for the empty case so an empty ledger can never be mistaken for a missing one. Tests now assert the mission carries `"claims"` while containing no `"author"`, no bare `"A"`/`"B"`, and no `"by"`. **Lesson: fake-runner tests cannot verify what the model actually receives; at least one live run per package is necessary.** |
| 32 | **`sourceRef` parsing was far too strict for what models emit** | **Defect found by the same live run, fixed.** §8.3 specifies refs "like `§Implementation Phase 5` or a line range `L189-205`", and the parser required exactly those, anchored. Real output from both debaters: `L27–28 (TASK-025 description)` (en-dash plus annotation), `TASK-032 (L43-44)` (range in parentheses, label first), `L61 (TASK-038 description), L54 (TASK-035 description)` (two refs in one string), `§Implementation Phase 5, L174-176 (TASK-026)` (heading *and* range). **All 21 refs in the first run failed to resolve**, so `judge/excerpts.md` contained nothing but a list of errors — destroying the traceability §8.3 exists to provide. Fixed: the line range is now matched anywhere in the string, en/em dashes are accepted, a trailing parenthetical or range is stripped before heading matching, text before the first comma is tried as a heading, and **an out-of-range line falls back to the heading** rather than failing outright — which matters because models cite line numbers from the *original* document while the seed is often an extracted excerpt. Genuinely bogus refs still error. After the fix the same seed resolved 4 heading spans and the judge produced all 7 §8.4 sections. |

---

## 14. Sources

- pi: `docs/json.md` (event stream, `message_end`/`agent_end`/`message_update` semantics), `docs/extensions.md` (`registerCommand`, `registerTool`, `sendMessage`, `appendEntry`, `exec`, `session_shutdown`, mode behavior), `src/main.ts` (`resolveAppMode`), `src/cli/args.ts` (flags; no `--temperature`), `src/core/system-prompt.ts` (default tool set), `packages/ai/src/types.ts` (`AssistantMessage`, `Usage`, `StopReason`).
- pi-messenger-swarm 0.25.32 tarball: `harness/cli.ts` (spawn flags — no `--model`), `harness/server.ts` (`/health`, `/action`, `/quit`; headers), `swarm/spawn.ts` (child args; protocol rule 10 "do not monitor the feed, wait for messages, or idle"; stdout consumed for progress only), `swarm/handlers/spawn.ts` (`concurrency_limit`, `missing_task_id`), `config.ts` (`feedRetention: 50`, `maxConcurrentSpawns: 3`), `handlers/coordination/join.ts` (`pruneFeed` on join).
- Model roster: `pi --list-models` on this machine, 2026-09-06 (providers: `ibm-services-essentials`, `openai-codex`, `opencode`, `opencode-go`, `openrouter`, `minimax`, `minimax-coding-plan`).
- Research basis and citations: `debate-swarm-design-review.md` §2 and §5.
