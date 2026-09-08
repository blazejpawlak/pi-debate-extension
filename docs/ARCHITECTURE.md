# Architecture

~4,950 lines of TypeScript, 587 offline checks.

## Module map

```
                          ┌──────────────────────────────────────┐
                          │  pi  (host process)                  │
                          │  auto-discovers ~/.pi/agent/         │
                          │  extensions/debate -> this repo      │
                          └──────────────┬───────────────────────┘
                                         │ registers
                                         ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │ index.ts  (425)   REGISTRATION + GLUE ONLY, never business logic       │
  │   /debate command · debate_run tool · debate-verdict entry renderer    │
  │   status line + widget (ctx.hasUI guarded) · session_start/shutdown    │
  │   NOT unit-testable: needs typebox + pi's jiti loader (§13.21)         │
  └───────┬──────────────────────────────────────────────┬─────────────────┘
          │                                              │
          ▼                                              ▼
  ┌───────────────────┐                        ┌──────────────────────────┐
  │ command.ts (113)  │                        │ config.ts (727)          │
  │ pure arg/mode     │                        │ DEFAULTS → settings.json │
  │ parsing, testable │                        │   → .pi/debate.json      │
  └───────────────────┘                        │ tiers · per-role budgets │
                                               │ D8 family check          │
                                               └──────────────────────────┘
                                                            │ resolved cfg
                                                            ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │ orchestrator.ts  (1045)   THE STATE MACHINE — §5                       │
  │                                                                        │
  │   drive(): R1 → R2 → [gate] → R3 → verdict → finalize                 │
  │   budget enforcement · repair-once · resume · abort · manifest         │
  │   sweepStaleRuns() (exported so it is testable, §13.44)                │
  └──┬────────┬──────────┬───────────┬───────────┬──────────┬──────────────┘
     │        │          │           │           │          │
     ▼        ▼          ▼           ▼           ▼          ▼
 ┌────────┐┌────────┐┌─────────┐┌──────────┐┌────────┐┌──────────┐
 │prompts ││ledger  ││excerpts ││verdict   ││manifest││publish   │
 │(353)   ││(728)   ││(192)    ││(218)     ││(161)   ││(355)     │
 │mission ││§8.1    ││sourceRef││§8.4      ││§8.6 +  ││swarm     │
 │assembly││CONTRACT ││→ seed   ││rendering ││events  ││channel   │
 │        ││+ perms  ││spans    ││          ││.jsonl  ││HTTP only │
 └────────┘└────────┘└─────────┘└──────────┘└────────┘└──────────┘
                                                            │
     ┌──────────────────────────────────────────────────────┘
     ▼
 ┌──────────────────────────────────────────────┐
 │ runner/  types.ts (103)  = the seam          │
 │   direct.ts (311)  spawns `pi --mode json`   │  ← default; full cost+tools
 │   fake.ts   (108)  scripted, zero tokens     │  ← all offline tests    
 │   harness.ts       NOT BUILT (§13.47)        │  ← would lose cost+tool control
 └──────────────────────────────────────────────┘
```

## Run flow

```
  seed (file or inline)
        │
        ▼
  selectMode ──► review (≥2000 chars, blind parallel R1)
                 explore (short idea, Ideator-only R1)
        │
        ▼
  ┌─────────────────────────── R1 ───────────────────────────┐
  │  Ideator(seed)          →  proposal + claims   author A   │  parallel,
  │  Skeptic(seed, lessons) →  ≥3 flaws + tests    author B   │  blind (D7)
  └───────────────────────────┬──────────────────────────────┘
                              │ mergeTurn → ledger.json (versioned)
                              ▼
  ┌─────────────────────────── R2 ───────────────────────────┐
  │  Ideator(ledger, anonymized)  → respond per claim id      │  sequential
  │  Skeptic(ledger)              → verify with bash          │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
                    ╔═════════════════════╗
                    ║  GATE (§5, §13.49)  ║  any claim unsettled at ≥high?
                    ╚══════╤═══════╤══════╝  open OR disputed OR
                       yes │       │ no      (resolved w/o evidence)
                           ▼       │
                          R3       │
                           └───────┤
                                   ▼
                    Synthesizer (no tools, sees no authors)
                    input = anonymized ledger + judge/excerpts.md
                            + orchestrator-computed evidence audit
                                   │
                                   ▼
                    verdict: §1 unresolved · §2 decision · §3 confidence
                             §4 minority report · §5 kill criteria
                             §6 next steps · §7 cost (orchestrator)
```

## Where each limit binds

| limit | scope | enforced | on breach |
|---|---|---|---|
| `timeouts.turnMs` | one turn | child kill | turn `timeout`, repair once |
| `timeouts.totalMs` | whole run | turn boundary | rounds stop, `partial`, verdict still runs |
| `timeouts.verdictGraceMs` | judge only | before + during judge turn | mechanical verdict (§13.50) |
| `budget.perTurnUsd` / `perTurnTokens` | one turn | **mid-turn**, streamed usage | child killed, `costcap` |
| `budget.usd` / `tokens` | whole run | turn boundary | rounds stop, `partial` |
| `roles.<r>.budget.*` | one role | turn boundary | **that role skipped**, run continues |
| `rounds.max` | 2 or 3 | loop | verdict |
| `repairs.max` | per run | on unusable block | turn skipped unmerged |

Every attempt is charged, including discarded repairs (§13.23). USD caps are inert on
providers reporting `cost.total = 0`; token caps are the always-on backstop (§13.19).

## Trust boundaries

```
  ┌─ Ideator (A) ──── may write: text type evidence confidence sourceRef status
  │                   may NOT: severity  (only B can force the gate)
  ├─ Skeptic  (B) ──── may write: + severity test
  │                   own-claim-only: text evidence type confidence (§13.39)
  ├─ Synthesizer ───── NO tools, NO author field, NO history.by (D5/D4)
  └─ outside agents ── comments only; NEVER enter ledger.json (§13.48)
```

## On-disk layout

```
<workspace>/.debate/
  runs/<runId>/
    manifest.json     seed, models, per-turn usage/cost, status, config snapshot
    ledger.json       canonical merged claims (authoritative)
    events.jsonl      append-only audit; `code`/`ts` reserved (§13.24)
    seed.md
    turns/<round>-<role>[-repairN].md
    judge/excerpts.md, judge/ledger.json
  lessons.md          appended per run, fed to the Skeptic's R1
<workspace>/debate_verdict.md   copy of the latest verdict
```

## Deliberate omissions

- **`ui.ts`** — §3 lists it; the UI is ~20 lines of `hasUI`-guarded wrappers (§13.44).
- **`runner/harness.ts`** — would give no usage/cost and no `--tools`, degrading budget
  enforcement to time only (§13.47).
- **author `X` / external claims** — comments were ruled sufficient (§13.48).
