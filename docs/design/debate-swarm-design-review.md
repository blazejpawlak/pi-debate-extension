# Debate Swarm Design — Review & Proposed Adjustments

> Reviewed: `debate-swarm-design.md` (status: design only)
> Date: 2026-09-06
> Basis: (a) fact-check of `pi-messenger-swarm` 0.25.32 source tarball and `pi` 0.85.1 docs; (b) multi-agent-debate (MAD) literature 2018–2026 and community implementations; (c) my own judgment. Everything below is either sourced or marked as opinion.

---

## 0. Executive summary

The document is well-researched and gets the hard parts right: turn discipline, a watchdog outside the prompt, stale-verdict rotation, tailing the JSONL rather than `feed`, and picking a second model family for the Skeptic. It is more careful than most community designs.

There are, however, four things that will break at implementation time and one architectural assumption the literature says will quietly waste money:

| # | Issue | Severity | Section |
|---|---|---|---|
| 1 | `spawn --model` does not exist in 0.25.32; model is frontmatter-only | Blocker | 1.1 |
| 2 | Spawned agents are one-shot `pi --mode json` runs told to exit when done; "wait until the moderator calls your name" requires them to poll the feed in a bash loop — fragile and token-burning | Design flaw | 1.2 |
| 3 | `maxConcurrentSpawns` defaults to 3; `feedRetention` prunes channel files to 50 events on every `join` | Trap | 1.3 |
| 4 | `--stop` kills a shared harness daemon that your interactive pi session may also be using | Trap | 1.4 |
| 5 | Ideator and Synthesizer share a model family; no verification step; agreement-rate not controlled; verdict aggregates rhetoric, not claims → the failure mode the 2024–2026 MAD literature keeps finding (sycophantic convergence, correct→wrong flips, "cheap talk") | Quality | 2 |

Recommended direction: keep the personas, the watchdog, and the verdict-file contract, but move turn-taking out of the LLMs and into the orchestrator (spawn-per-turn), add a structured claim ledger, make the Skeptic verify rather than argue, and make round 3 conditional. Details and options in §3.

---

## 1. Corrections to the technical findings (verified against 0.25.32 source)

### 1.1 `spawn --model` does not exist — Blocker

`harness/cli.ts` has no `--model` flag and `SpawnRequest` has no `model` field. The only way to set a model is the `model:` key in the agent-file frontmatter (`swarm/spawn.ts` splits `provider/model` into `--provider`/`--model` for the child `pi`). The SKILL.md line "default model, overridable at spawn time" is inaccurate for this version.

Consequence: §1.2 row 2 of the design ("`spawn --role <r> --model <m>`") is wrong, and open item #2 ("confirm `--agent-file` honors `model:`") is not a nice-to-have — it is the only path. Also note the frontmatter parser is a naive `key: value` scanner: no nested or multiline YAML. Keep persona frontmatter flat.

### 1.2 Spawned agents don't idle — the "moderator cues turns" model is fragile

A spawn is `pi --mode json --no-session --append-system-prompt <tmpfile> "<mission>"` with the swarm protocol always appended to the system prompt, even with `--agent-file`. Rule 10 of that protocol (`swarm/spawn.ts`, verified) reads: *"Exit immediately after marking task done … Do not stay alive after your mission is complete. **Do not monitor the feed, wait for messages, or idle.**"* Messaging is pull-based: no push delivery, no ack, no threading; `send` only appends a feed event.

The design's Ideator/Skeptic missions ("only post when the moderator calls your name") therefore ask the agents to do precisely what their own system prompt forbids. One of the two instructions loses; which one is a coin flip per model per run.

So an Ideator told to "only post when the moderator calls your name" has to sit in a `while true; do pi-messenger-swarm feed; sleep N; done` loop inside its own bash tool, fighting a system prompt that tells it to exit. Three agents doing that for up to 10 minutes is a lot of tool calls for zero content, and any one of them deciding it is "done" collapses the round. The design's §3.1 correctly identifies turn-taking as the single biggest reliability fix; it just puts the fix in the least reliable place (the prompts).

Fix: make the **orchestrator** the conductor and spawn one agent per turn (§3, Option B). Each turn becomes a bounded, single-prompt pi run with the ledger-so-far as input. No polling, no idle agents, natural completion detection (process exit / `.pi/messenger/agents/<session>.jsonl` `completed` event). The Synthesizer LLM runs once, at the end, instead of babysitting.

If you want to keep long-lived agents anyway, the `task` primitives with `--depends-on` and `task ready` are the supported ordering mechanism, not channel cues.

### 1.3 Two default limits that will bite

- `maxConcurrentSpawns = 3` (`config.ts`, enforced in `swarm/handlers/spawn.ts`). Three debaters fit exactly; a crashed-agent respawn or any fourth participant fails with `{error:'concurrency_limit'}`. Raise it in `.pi/pi-messenger.json` (or `~/.pi/agent/pi-messenger.json`, or `settings.json → messenger`), or use spawn-per-turn where concurrency is 1–2.
- `feedRetention = 50`: every `join` calls `pruneFeed`, truncating `channels/<name>.jsonl` to the last 50 events. "Durable channel" does not mean "unbounded log". A 52 KB seed plus 8 turns fits, but the file is not your transcript of record. Archive each run to `.debate/<run-id>/transcript.jsonl` yourself, and raise `feedRetention` for good measure.
- Spawn guardrail: if any task is `ready` and you spawn without `--task-id`, the spawn is refused unless `--force`. Either use tasks deliberately or pass `--force`.

### 1.4 "No daemon required" is marketing; the harness is a daemon

The CLI auto-starts `dist/harness/server.js` detached on `127.0.0.1:9877` (`PI_MESSENGER_PORT`); every CLI call goes through it. The design's watchdog runs `pi-messenger-swarm --stop` on EXIT. If you started the debate from a terminal while a pi TUI session is open in the same project, that kills the TUI's messenger too. Stop the spawns, leave the harness, unless the script started it (`--status` before, remember the answer).

Two related notes:
- Identity outside pi falls back to "most recently modified registration" (PID match fails) — fragile for a shell orchestrator. Set `PI_AGENT_NAME=debate-orchestrator` explicitly.
- The wrapper `~/.pi/agent/bin/pi-messenger-swarm` is installed on every `session_start` by `installShellAlias()`; the extension itself does not check trust. Installed globally it appears after any pi run, so open item #1 is easy to satisfy — but the script should still fail fast with a clear message if the wrapper is missing.

### 1.5 pi does have an extension API — the "no plugin API" claim is half wrong

Correct: there is no way to register a top-level `pi debate` subcommand. Incorrect: extensions can register TUI slash commands (`pi.registerCommand`), LLM tools (`pi.registerTool`), CLI flags (`pi.registerFlag`), and hooks (`turn_end`, `agent_end`, `agent_settled`, `session_shutdown`), plus `pi.exec` and `pi.sendMessage(..., {deliverAs: 'steer'|'followUp'})`. `pi-messenger-swarm` itself does `pi.registerCommand('messenger', …)`.

This opens a third implementation option (§3, Option C): a small TypeScript extension that owns the whole debate loop, talks to the harness HTTP API directly (`POST /action` with `x-agent-name`/`x-session-id`/`x-caller-cwd` headers, returns structured JSON instead of the CLI's `result.text`), and exposes `/debate` properly instead of via a prompt template.

### 1.6 Smaller corrections

- `feed` previews are one line, but `preview` in the JSONL holds the full message (newlines preserved, space runs collapsed). Tailing the JSONL is right; skip line 1 (`_meta` header).
- Use `--message-file` for the seed. A 52 KB migration plan on the command line survives ARG_MAX on macOS but not shell quoting. Better still: write `debate_seed.md` into the workspace and post a pointer; spawned agents run with `cwd` = project and can read files. (They can also write files — `reserve`/`release` are advisory only — which is how the verdict gets written.)
- There is no `--wait`, `--timeout`, or `--max-turns` on spawn, and the `idleTimer` exists but is never armed in 0.25.32. The design is right that the watchdog must live in the script. Also cap per-turn: `timeout 180 …` around each spawn-per-turn.
- Token tracking exists per spawn (`progress.tokens`) but is not persisted. If you care about cost per debate, read it from the agents' JSONL before cleanup and write it into the verdict footer.
- Per-run channel names (`#debate-<run-id>`) instead of a shared `#universal-debate` remove cross-run contamination and make §3.3's stale-verdict rotation unnecessary: write the verdict to `.debate/<run-id>/verdict.md` and refresh a `debate_verdict.md` symlink/copy at the end.

---

## 2. What the research says about this shape of debate

The design assumes "three strong models arguing for three rounds produces a better answer". The literature since 2024 is unusually consistent that this is true only under specific conditions, all of which are controllable in the prompts and orchestration.

### 2.1 Findings that change the design

| Finding | Source | Implication for this design |
|---|---|---|
| Off-the-shelf MAD often does **not** beat self-consistency / single-model sampling at equal cost; tuning the explicit *agreement propensity* in the prompt moved one setup from worst to best (~+15 pts) | Smit et al., ICML 2024; Zhang et al. 2025 ("If MAD is the answer…") | State the Skeptic's disagreement target explicitly. Benchmark against a single-model "critique yourself twice" baseline before trusting the swarm. |
| Debate without an external correctness signal is a **martingale**: beliefs move but expected accuracy does not; most measured gains come from voting, not arguing | Choi, Zhu, Li, NeurIPS 2025 ("Debate or Vote") | Some round must inject verification — tests, commands, retrieved evidence. For a migration plan that means the Skeptic actually runs the plan's validation commands, not just reads them. |
| ~63% of answer flips in debate are correct→wrong; "reasoning-like" prose causes error adoption even with no valid logic | Hao et al. 2026 ("Not All Flips Are Conformity"); Kasprova et al. 2026; Bertalanič & Fortuna 2026 | A flip is only allowed if it names the specific premise that was refuted. Treat convergence as a warning sign, not a success metric. |
| Sycophancy toward peers dominates; **anonymizing authorship** cut the conformity gap from 0.61 to 0.02 | Choi, Zhu, Li 2025 (identity bias) | Later rounds and the judge see claims, not "Ideator said / Skeptic said". |
| Homogeneous same-model debate is the weakest configuration; heterogeneous families help; judges are biased toward their own family | Zhang et al. 2025 (Heter-MAD); ReConcile (Chen et al. 2023); Liang et al. 2024 | Opus-5 as both Ideator and Synthesizer is the exact configuration to avoid. Either a third family for the judge, or a cheaper model with anonymized input (Khan et al. 2024: weak judges do well when debaters argue with verifiable citations). |
| Competitive "win the argument" MAD degenerates into cheap talk (−15 pts); consensus-seeking filters out useful disagreement; **collaborative uncertainty-reduction** framing gains | Chen et al. 2025 ("When and Why Does MAD Fail") | Frame the Skeptic as "find what would make this wrong and how to check" rather than "attack". |
| Distinct personas beat identical prompts; one-at-a-time speaking beats simultaneous; 3–4 agents peak; more rounds gave no upward trend | ChatEval (Chan et al. 2023); Du et al. 2023 | Three roles, sequential turns, three rounds max — the design already has this. Good. |
| Round count should be adaptive: stop when judgments stabilize | Hu et al. 2025 (adaptive stability detection); Liang et al. 2024 | Round 3 only if the ledger still has unresolved high-severity items. |
| Pass forward summaries / masked memory, not raw transcripts; performance tracks the *number of wrong statements carried forward* | Du et al. 2023; Tian et al. 2026 (memory masking); S2-MAD, GroupDebate | Each turn receives the structured ledger, not the previous prose. Also cuts tokens 30–50%. |
| In 2:1 splits the minority is right ~25% of the time; LLM-as-judge picking sides was net negative | He et al. 2026 ("Minority Sentinel") | The verdict must carry a minority report; the Synthesizer must not auto-side with agreement. |
| Low temperature (<0.5) locks in biased consensus in 1–2 rounds | Okawa 2026 | Don't run debaters at T=0 (check whether pi exposes temperature per run; unverified). |
| Role×model fit matters more than "best model everywhere" | Zhang et al. 2026 (Meta-Debate) | The cost question in open item #4 is also a quality question — see model matrix in §3.4. |
| Persisting the critic's lessons across runs improved outcomes | RedDebate (Asad et al. 2025) | Keep `.debate/lessons.md`; the Skeptic reads it at start, appends at end. |

### 2.2 Patterns from community tools worth borrowing

- Karpathy's `llm-council` and `yogirk/agent-council`: **blind independent first pass → anonymized peer review → chairman synthesis**, with the full record persisted per project. The blind first pass is the key trick: the Skeptic's round-1 critique of the *seed* is more valuable than its critique of the Ideator's framing.
- `council-of-high-intelligence`: enforcement checks for premature agreement, repeated claims, missing dissent, unsupported confidence; verdict leads with unresolved items, kill criteria, next step. Cheap to add as a lint pass on the ledger.
- Zen MCP `consensus`: explicit for/against/neutral stance assignment per model, sequential consultation. Same idea as your personas, confirms the shape.

Notably, none of the popular tools run *long-lived agents polling a channel*. All of them are orchestrator-driven, one bounded call per turn. That matches §1.2.

---

## 3. Proposed adjusted design

### 3.1 Protocol (replaces §3 and §4 of the original)

```
R0  orchestrator: write .debate/<run>/seed.md, ledger.json (empty), lessons.md (carry-over)
R1  PARALLEL, BLIND
    Ideator  ← seed                      → proposal + claim ledger entries
    Skeptic  ← seed + lessons.md         → ≥3 flaws (severity, falsification test), runs tests it can
R2  SEQUENTIAL, ANONYMIZED
    Ideator  ← seed + ledger (no authorship) → responds per claim id; may flip only by naming refuted premise
    Skeptic  ← seed + ledger              → re-verifies, updates severities, marks resolved/unresolved
R3  CONDITIONAL
    only if ledger has unresolved items with severity ≥ high; same as R2
V   Synthesizer ← seed + ledger + evidence excerpts (no identities, no rhetoric)
    → debate_verdict.md ; orchestrator archives transcript, appends lessons, cleans up
```

Turn count: 4–6 LLM calls plus one verdict (vs. 6 + moderator overhead). Wall-clock bound: per-turn `timeout` (e.g. 180 s) × turns, still under the 600 s ceiling.

### 3.2 Claim ledger (new)

Each turn must end with a fenced JSON block the orchestrator extracts and merges:

```json
{"claims":[{"id":"C3","type":"ASSUMPTION","text":"Time Machine snapshot is consistent while Rancher is running",
 "evidence":"none; Phase 5 quiesces only Docker Desktop","confidence":0.4,"severity":"high",
 "status":"open","test":"stop rancher-desktop, compare `tmutil compare` before/after"}]}
```

Types: FACT / INFERENCE / ASSUMPTION / UNKNOWN. This is what the Synthesizer aggregates. It also gives the orchestrator a mechanical stop condition (no `open` + `high`) and a lint pass (agreement without evidence, repeated claims, missing dissent, confidence > 0.8 with `evidence: none`).

### 3.3 Persona changes

- **Ideator**: unchanged in spirit; add "you may change position only by citing the claim id and the premise that was refuted"; output ledger block.
- **Skeptic**: reframe from red-team to *verifier*. Required: ≥3 flaws per round with severity and a concrete falsification test; run anything runnable in the workspace (pi gives it bash/read tools); explicit agreement budget ("agree with at most one of the Ideator's contested claims per round unless you produced evidence"); read/append `lessons.md`.
- **Synthesizer**: no longer a conductor. Runs once. Input is the ledger and evidence, with role and model names stripped. Verdict template: unresolved items first → decision → confidence → **minority report** → kill criteria → next steps → cost footer (tokens per role, from agents' JSONL).

### 3.4 Model matrix (answers open item #4)

| Role | Original | Proposed | Why |
|---|---|---|---|
| Ideator | opus-5 | opus-5 | 1M context for the 52 KB seed; generative breadth |
| Skeptic | gpt-6-astra | gpt-6-astra | Different family; keep. Give it tools. |
| Synthesizer | opus-5 | **A third family if `pi --list-models` offers one** (e.g. Gemini-class); else **sonnet-5 with anonymized ledger**; opus-5 only if you also anonymize | Same-family judge + Ideator is the documented bias; weak judges do fine with verifiable claims (Khan et al.). Also cuts ~30% of spend. |

Optional: run R2 for both debaters on sonnet-class and keep opus-5 for R1 and the verdict — the literature's gains come from heterogeneity and verification, not from every seat being top-tier.

### 3.5 Implementation options

**Option A — patch the current design (least work).** Keep bash + three long-lived agents. Apply §1 fixes: model via frontmatter only; `feedRetention`/`maxConcurrentSpawns` raised; don't `--stop` the harness; per-run channel; `--message-file`; `PI_AGENT_NAME`; archive transcript. Accept that turn discipline depends on agents polling and on the swarm protocol's "exit when done" rule not winning. I'd expect ~70% clean runs.

**Option B — orchestrator-driven, spawn-per-turn (recommended).** Bash (or a 150-line Python) script implements §3.1. Each turn is one `pi-messenger-swarm spawn --agent-file <persona> --force "<mission pointing at seed + ledger>"` wrapped in `timeout`, completion detected from the agent JSONL `completed` event. The channel becomes an audit log, not a control plane. Deterministic ordering, natural cost bounding, trivially testable turn by turn. Keeps everything the design already got right (watchdog, cleanup trap, verdict-as-exit-signal, tail for live view).

**Option C — pi extension (most work, best UX).** TypeScript extension registering `/debate` and a `debate_status` tool, driving the harness HTTP API with structured JSON, using `agent_end`/`session_shutdown` hooks for cleanup, and rendering the live ledger in the TUI. Do this after B proves the protocol.

### 3.6 Evaluation gate before you trust it

Run the same seed through (1) a single opus-5 pass with a two-step self-critique at roughly equal tokens, and (2) the swarm. If (2) does not surface materially more true, high-severity issues on `process-mac-migration-m5-v1.md`, the swarm is a cost centre. Smit et al. and Zhang et al. found exactly that in most of their configurations; the fixes in §3.1–3.3 are what separated the setups that worked from the ones that didn't.

---

## 4. Revised open items for implementation

1. Confirm `spawn --agent-file` honors `model:` frontmatter end-to-end (now the *only* model path).
2. Confirm agent JSONL event shape (`spawned|progress|completed|failed|stopped`) for per-turn completion detection; confirm `feed` `join` event shape only if Option A.
3. Check whether pi exposes a temperature override per run (unverified; matters for Okawa's lock-in result).
4. Check `pi --list-models` for a third model family for the Synthesizer.
5. Decide `feedRetention` and `maxConcurrentSpawns` values in `.pi/pi-messenger.json`.
6. Decide where run artefacts live (`.debate/<run-id>/`) and whether `debate_verdict.md` is a copy or symlink.
7. Confirm the harness `--status` semantics so the script only stops a harness it started.

---

## 5. Sources

Package / pi (source read from the 0.25.32 tarball and pi docs):
https://registry.npmjs.org/pi-messenger-swarm · https://github.com/monotykamary/pi-messenger-swarm · https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md · https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/prompt-templates.md · https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/src/cli/args.ts

Research:
Irving et al. 2018 https://arxiv.org/abs/1805.00899 · Du et al. 2023 https://arxiv.org/abs/2305.14325 · Liang et al. 2024 https://arxiv.org/abs/2305.19118 · Chan et al. 2023 (ChatEval) https://arxiv.org/abs/2308.07201 · Chen et al. 2023 (ReConcile) https://arxiv.org/abs/2309.13007 · Khan et al. 2024 https://arxiv.org/abs/2402.06782 · Kenton et al. 2024 https://arxiv.org/abs/2407.04622 · Smit et al. 2024 https://arxiv.org/abs/2311.17371 · Zhang et al. 2025 https://arxiv.org/abs/2502.08788 · Choi, Zhu, Li 2025 (Debate or Vote) https://arxiv.org/abs/2508.17536 · Choi, Zhu, Li 2025 (identity bias) https://arxiv.org/abs/2510.07517 · Estornell & Liu 2024 https://proceedings.neurips.cc/paper_files/paper/2024/hash/32e07a110c6c6acf1afbf2bf82b614ad-Abstract-Conference.html · Chen et al. 2025 (When and Why MAD Fails) https://arxiv.org/abs/2510.20963 · Hu et al. 2025 https://arxiv.org/abs/2510.12697 · Li et al. 2024 (sparse topology) https://arxiv.org/abs/2406.11776 · Tian et al. 2026 (memory masking) https://arxiv.org/abs/2603.20215 · Hao et al. 2026 https://arxiv.org/abs/2606.00820 · Kasprova et al. 2026 https://arxiv.org/abs/2604.02668 · Bertalanič & Fortuna 2026 https://arxiv.org/abs/2605.00914 · Okawa 2026 https://arxiv.org/abs/2608.02827 · He et al. 2026 (Minority Sentinel) https://arxiv.org/abs/2606.29270 · Zhang et al. 2026 (Meta-Debate) https://arxiv.org/abs/2601.17152 · Asad et al. 2025 (RedDebate) https://arxiv.org/abs/2506.11083

Community:
https://github.com/karpathy/llm-council · https://github.com/yogirk/agent-council · https://github.com/0xnyk/council-of-high-intelligence · https://www.anthropic.com/engineering/multi-agent-research-system
