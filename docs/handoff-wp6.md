# Handoff — Multi-Agent Debate pi extension, continuing at WP6

Written: 2026-09-07
Next session focus: **WP6 — UI + session integration**

---

## Read these first, in this order

1. **`/Users/tetsuo/Desktop/mac-migration/debate-swarm-design.md`** — the work order.
   Read it end to end before writing code. §11 lists WP0–WP8. **§13 has grown to 40 rows**
   and is where every reality-vs-document discrepancy is recorded.
2. **`~/.pi/agent/extensions/debate/CONFIG.md`** — the config surface as built (tiers,
   per-role budgets, free models).
3. **`/Users/tetsuo/Desktop/mac-migration/.debate/eval/reprobe-20260907.md`** — why the
   protocol is now believed to work, and the open cost question.

Do not re-derive §7 or §8; they are verified contracts. §13 is the **only** section of the
design doc you may edit.

---

## Working agreement with this user (important)

The user is technically sharp and checks claims. Behaviours that worked:

- **Verify before asserting.** They challenged an unexplained reference (`multica-ctl`) and
  were right to; I had to prove it came from their own seed. Show the evidence.
- **Report negative results plainly.** WP5's first probe showed the debate *losing* to a
  single-model baseline. Saying so directly was the correct move.
- **Flag your own mistakes.** Two of my fixes were wrong (§13.35 demotion, and a
  malformed-edit false start). Recording the false starts in §13 was explicitly valued.
- **Stop at gates.** They asked for stops after WP0/WP4/WP5 and expected them honoured.
- Don't pad with praise. They corrected verbosity indirectly by asking short questions.

---

## State: WP0–WP5 complete, all acceptance tests passing

| WP | Status | Notes |
|---|---|---|
| WP0 | done | Model roster **swapped** — see §13.14/13.15/13.16 |
| WP1 | done | Skeleton, config, command parsing |
| WP2 | done | `ledger.ts`, `excerpts.ts` |
| WP3 | done | Orchestrator, all 10 scenarios (a)–(j) |
| WP4 | done | `runner/direct.ts` + personas; $0.22 real tokens |
| WP5 | done | **Value gate fired negative, then passed after tuning** |
| **WP6** | **next** | UI + session integration |
| WP7 | optional | Harness adapter + publisher (`runner/harness.ts`, `publish.ts` — neither exists) |
| WP8 | pending | Full 51.8KB evaluation |

**Test suite: 437 checks, all green.**
```
~/.pi/agent/extensions/debate/test/run-all.sh     # no tokens spent
npx tsx test/runner-direct.test.ts                # real tokens, ~$0.22
```
Typecheck runs inside `run-all.sh` using a throwaway tsc at `/tmp/tscheck` — **if `/tmp`
was cleared, recreate it**: `cd /tmp && mkdir tscheck && cd tscheck && npm init -y &&
npm i typescript@5 @types/node`.

---

## Environment facts you will otherwise waste time rediscovering

- **Load via auto-discovery, never `-e`.** The extension lives in the global discovery dir,
  so `pi -e ~/.pi/agent/extensions/debate` double-registers and aborts with a tool
  conflict. §11's WP1 command is wrong about this (§13.20). Just run `pi`.
- **`index.ts` cannot be imported by tests** — it needs `typebox` and
  `@earendil-works/pi-coding-agent`, which only pi's jiti loader provides. Pure logic lives
  in `command.ts` for that reason (§13.21). Keep new testable logic out of `index.ts`.
- **Only two working credentials**: `openai-codex` (in `auth.json`) and `OPENROUTER_KEY`
  (env var). `ibm-services-essentials` works for inference but reports `cost.total = 0` for
  all 19 models. `opencode` has no balance — all `opencode/*` are dead (§13.15).
- **OpenRouter ids must be hyphenated**: `anthropic/claude-opus-4-8` works;
  the dotted `anthropic/claude-opus-4.8` from `models-store.json` 404s. A scary-looking
  "not found, using custom model id" stderr warning is expected and harmless (§13.16).
- **Free tier exists and works**: `tier: "free"` → $0.00 runs on IBM free models. Verified
  end to end. Violates D8 (two families only) and is slow (~13 min). `gpt-5.6-luna` is
  advertised free but 403s (§13.29/13.30).
- Use `dryRun: true` on `debate_run` to plan cost without spending.

---

## WP6 scope — what §11 asks for and what already exists

> **WP6 — UI + session integration.** `ui.ts`, real subcommands including `resume`,
> injection per config, stale-run sweep at `session_start`.
> *Acceptance*: TUI check with the fake runner — widget updates per turn and shows live
> cost; abort kills and marks aborted; after completion the next prompt demonstrably has
> the verdict in context.

**Already implemented in `index.ts`** (verify, don't rebuild):
- `ctx.ui.setStatus` / `setWidget` with live cost, open-high count, lint count, and a
  "cost understated" line — all guarded by `ctx.hasUI`
- `pi.appendEntry("debate-verdict", …)` and `pi.sendMessage({customType:"debate"}, …)`
  honouring `inject: nextTurn | followUp | none`
- `session_shutdown` → abort + `killAll()`
- `session_start` sweep marking crashed `running` runs as `aborted`
- All subcommands including a working `resume`

**Genuine gaps I verified before handing over:**

1. **`abort` does not persist `status: "aborted"`.** `Orchestrator.abort()`
   (`orchestrator.ts:150`) only sets `this.aborted` and fires the AbortController. The
   manifest is written as `aborted` at `orchestrator.ts:262`, which is inside `drive()` —
   so it depends on the loop unwinding normally. **WP6's acceptance explicitly requires
   "abort kills and marks aborted"**, so make `abort()` persist immediately and
   idempotently. Add a fake-runner test asserting `manifest.status === "aborted"` on disk
   after an abort mid-run.
2. **No `ui.ts`.** §3's file list has one; the UI code currently sits inline in
   `index.ts`. Extracting it is optional but makes it testable — your call, note it in §13
   if you deviate.
3. **No `registerEntryRenderer`.** §9.3 asks for an entry renderer for the
   `debate-verdict` entry (TUI-only, not LLM context). Currently `appendEntry` is called
   with no renderer, so it renders with the default.
4. **Injection is unproven end to end.** WP6 wants the *next prompt* demonstrably carrying
   the verdict. Test with `--mode json` where `hasUI` is false, and in a real TUI.

Use the **fake runner** for all of WP6 (`runner: "fake"` in config, or construct
`FakeRunner` directly). WP6 must spend no tokens.

---

## Architecture orientation

`~/.pi/agent/extensions/debate/` — `index.ts` (registration/glue only) · `command.ts`
(pure arg/mode logic) · `config.ts` (layered config, tiers, per-role resolution) ·
`orchestrator.ts` (§5 state machine, budgets, repair, resume) · `ledger.ts` (§8.1 contract
+ all §5.1 enforcement) · `excerpts.ts` (§8.3 sourceRef → seed spans) · `prompts.ts` (§6.3
mission assembly) · `verdict.ts` (§8.4) · `manifest.ts` (§8.6 + events) · `paths.ts` ·
`runner/{types,direct,fake}.ts` · `personas/*.md`

Invariants that took real debugging to establish — **do not regress these**:

- **Usage is summed over assistant `message_end` events only** (§7.1). `message_end` also
  fires for `user` and `toolResult` messages, which carry no usage (§13.17). Last-message-
  only undercounts 2.3–5.7× and silently disables the cost cap.
- **Every turn attempt is charged**, including ones discarded by a repair (§13.23). A
  killed turn's spend vanishing was a measured defect.
- **`appendEvent` reserves `code`/`ts`** — a data key named `code` once silently renamed a
  whole event type into invisibility (§13.24).
- **Cross-author writes to `text`/`evidence`/`type`/`confidence` are refused** (§13.39).
  This was the worst bug found: the Ideator was erasing the Skeptic's verified findings
  while the ledger still showed 100% evidence coverage.
- **`disputed` does not settle an unevidenced claim** (§13.34), or the Skeptic can end the
  debate by parking its own findings.
- **Fake-runner tests assert on files, not on what the model receives.** Two live-only
  defects (§13.31 judge never got the ledger; §13.32 all 21 sourceRefs failed to resolve)
  passed every fake test. Do at least one live run per package.

---

## Open decision the user has not settled

The re-probe showed the debate working but costing **$2.11 vs the baseline's $0.13 (16.6×)**
for one marginal finding on a 6KB seed. My stated read: it earns its cost when being wrong
is expensive, not for routine review — which argues for keeping it an explicit `/debate`
invocation. **The user has not yet ruled on keep/tune/drop.** WP8 on the full 51.8KB
document is the intended tiebreaker. Don't treat the idea as settled-good.

Also unresolved and explicitly parked by the user: the IBM Advantage Credits dashboard has
**no reachable API** (401 on the dashboard host, 404 on the inference host). The status
line was changed to report honest cumulative spend instead of a false "0/500 exhausted".
User said "leave it at your change, no API usage for now."
See `.debate/eval/ibm-credits-fix.md`. Backup at
`~/.pi/agent/extensions/enhanced-status-line.ts.bak-20260907-082358`.

---

## Suggested skills

Call the Skill tool for these:

- **`pi-extension-development`** if present — WP6 is entirely pi extension API work
  (`registerEntryRenderer`, widgets, `sendMessage` delivery modes, `hasUI` guards).
  Otherwise read the pi docs directly: `docs/extensions.md` §Custom UI / §Widgets, Status,
  and Footer / §Mode Behavior, and `docs/tui.md`. Resolve under
  `/Users/tetsuo/.nvm/versions/node/v24.15.0/lib/node_modules/@earendil-works/pi-coding-agent/`.
- **`webapp-testing`** or **`ui-screenshots`** — only if you want visual confirmation of
  the TUI widget for the WP6 acceptance evidence. A scripted TUI check is usually enough.
- **`git-commit`** — nothing is under version control yet (`git status` shows the workspace
  is not a repo). Worth raising with the user; ~3,500 lines of extension code and a heavily
  annotated design doc currently have no history.

Skills to **avoid**: the `react*`, `java*`, and `agentic-eval` families are unrelated. Do
not invoke `pi-messenger-swarm` — D11 forbids the extension touching that shared daemon,
and WP7 (the only place it appears) is optional and not started.

---

## Suggested first moves

1. Read the design doc end to end, §13 included.
2. `cd ~/.pi/agent/extensions/debate && ./test/run-all.sh` — confirm 437 green before
   changing anything. Recreate `/tmp/tscheck` if the typecheck line is missing.
3. Read `index.ts` fully; much of WP6 is already there.
4. Fix the `abort` persistence gap first — it is the one item WP6's acceptance names that
   currently does not hold.
5. Add fake-runner tests for the WP6 acceptance criteria, then do one TUI pass by hand.
6. Record any design deviation in §13. Tell the user rather than working around it.
