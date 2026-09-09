# pi Debate Extension

Run a structured, adversarial multi-model review inside [pi](https://github.com/earendil-works/pi-coding-agent).

Instead of asking one model "is this plan any good?", this runs three models in defined
roles against each other:

- **Ideator** proposes and defends.
- **Skeptic** attacks, and must **execute commands to prove** its claims — assertions
  without evidence are flagged, not accepted.
- **Synthesizer** judges. It has no tools, and never sees who said what.

Everything the models exchange is a **structured claim ledger**, not prose. You get a
verdict with a decision, a confidence figure, a minority report, kill criteria, and
per-claim evidence you can audit.

```
/debate @migration-plan.md
```

```
Claims: 27 (open 24 · disputed 3)   Unsettled at high+ severity: 8

## 2. Decision
proceed-with-changes

## 4. Minority report
- Git completeness verification [A12, B8]: an initial proposal suggested `git fsck --full`
  and object counts were sufficient. B8 refuted this by proving internal object validity
  does not verify source-to-destination equality, leading to the adoption of full
  object-ID sets and working-tree hash auditing.
```

## Why you might want this

It is worth the extra time when **being wrong is expensive** — an irreversible migration,
a production cutover, a security-relevant change. It is not worth it for routine review.

Measured on a 51.8KB migration plan against a single strong model with bash and a
self-critique pass ([full report](docs/eval/full-20260908.md)):

| | debate | single-model baseline |
|---|---|---|
| Cost (free tier) | **$0.00** | **$0.00** |
| Wall clock | 10m 27s | 5m 54s |
| Commands executed | 36 | 21 |
| Findings | 27 claims, **all evidenced** | 7 verified flaws |

**7 of 10 issues were found independently by both**, which is the corroboration this
design exists to produce. The debate uniquely found 4 more — including two that critique
*the Ideator's own proposed fixes*, which a single-pass review has no way to reach.

**Read this part too:** the baseline found **3 real issues the debate missed**, two of them
simple facts about the machine. The honest recommendation is to run both when the decision
is irreversible; the union beats either alone. This is a second opinion, not a replacement.

## Install

Requires pi and Node 24+.

```bash
git clone https://github.com/blazejpawlak/pi-debate-extension.git ~/Projects/pi-debate-extension
cd ~/Projects/pi-debate-extension && npm install
ln -s ~/Projects/pi-debate-extension ~/.pi/agent/extensions/debate
```

pi auto-discovers it. Verify with `/debate` in any session.

> Load via auto-discovery, **not** `pi -e <path>` — the extension already lives in the
> discovery directory, so `-e` registers it twice and aborts with a tool conflict.

## Configure

Layered, later wins: **built-in defaults → `~/.pi/agent/settings.json` `"debate"` →
`<cwd>/.pi/debate.json`**. The local file is read only when pi trusts the exact directory
where you launched pi; it is not inherited by subdirectories because it can redirect model spend.

The friendly path is **`/debate setup`**: choose global or local settings, select a recommended
roster (or a provider/model per role), see credential status, set the relevant guardrail, then
choose a project file from a picker, type a path, or paste a topic. Review the complete summary,
then confirm. It writes only your choices.

The one setting most people want, because it makes runs free:

```json
{ "debate": { "tier": "ibm" } }
```

| tier | roles | cost | note |
|---|---|---|---|
| `ibm` | all three on `ibm-services-essentials` | **$0** | three distinct model families, so the judge stays independent |
| `free` | IBM free models | **$0** | only two families — judge not fully independent |
| `default` | OpenRouter Claude / GPT / Gemini | ~$0.81 per 6KB seed | strongest metered roster |
| `strong` | + `openai-codex/gpt-6-astra` skeptic | ~$2.11 measured | needs codex quota |

Full reference: **[CONFIG.md](CONFIG.md)** — per-role models, budgets, tool allowlists,
time caps, swarm integration.

## Use

```
/debate setup                 guided config + topic wizard
/debate @plan.md              review a file
/debate <text>                review inline text (mode auto-selected)
/debate --mode explore ...    force explore mode (short ideas)
/debate status                refresh live progress; shows last run when idle
/debate abort                 kill children, mark aborted
/debate resume <run-id>       continue a crashed run
/debate artifact [run-id]     create/retrieve corrected draft from a completed review
/debate last                  print the last verdict
/debate runs                  list runs with status and cost
```

Also available as a tool the agent can call itself:

```
debate_run { "seedFile": "plan.md", "dryRun": true }
```

While a debate runs, a **◆ Debate running** widget above the editor refreshes every second with
its phase, elapsed time, completed cost/tokens, and live current-turn usage. It also shows the
active tool when the Skeptic is checking evidence. The widget and footer status clear when the
run ends. `/debate status` reports active or last-run state without pinning idle UI.

`dryRun` resolves models, counts turns, and estimates cost **without invoking any model** —
worth doing first on a large seed:

```
mode: review
seed: plan.md (51839 chars)
models: ideator=ibm-services-essentials/claude-opus-4-8
        skeptic=ibm-services-essentials/gpt-5.6-sol
        synthesizer=ibm-services-essentials/gemini-3.7-flash
max model turns: 7 (+ up to 2 repairs)
estimated cost: $0.00 - every role is on a provider that bills nothing
time cap: 2700s total, 420s per turn, +420s verdict grace
```

## Acting on a debate result

A debate is a **review mechanism**, not the final deliverable or an execution approval.
For an eligible document review, debate automatically adds a separate **corrected draft**:
`<source>.debate-draft.md`. It is explicitly marked **HUMAN REVIEW REQUIRED**, never overwrites
the source, and links the source hash, run ID, claim IDs, and remaining blockers. The extra,
bounded editor turn is included in run cost/provenance. Use `/debate artifact <run-id>` to
produce a draft for a review completed before this feature was installed.

1. Start with `Unresolved high-severity` and `Kill criteria`. Treat those as blockers.
2. Use the cited claim IDs (for example `B1`, `B4`) and their evidence to update the source
   plan or implementation.
3. Re-run `/debate @the-same-file.md` after the revision. Keep the prior run as an audit trail;
   the new run tests whether the blockers were actually resolved.
4. Execute an operational plan only when its explicit preconditions and your own change-control
   requirements are satisfied — not merely because the verdict says `proceed-with-changes`.

For the migration-plan result shown above, `B1`/`B4` are path-validation blockers: fix the
authoritative plan path and fail-closed validation recipe, then rerun the debate before any
state-changing migration step.

## What it produces

```
<workspace>/debate_verdict.md          latest verdict, copied to the root
<source>.debate-draft.md                corrected draft; never replaces source
<workspace>/.debate/runs/<run-id>/
  manifest.json   models, per-turn tokens/cost/duration, status, config snapshot
  artifact/       corrected-draft.md plus provenance.json
  ledger.json     every claim with evidence, severity, status history
  events.jsonl    append-only audit trail
  turns/          each model's raw output
  judge/          exactly what the judge was shown
```

Runs are **resumable** (`/debate resume <run-id>`) and a crashed run is never re-paid for:
a turn that completed and merged is skipped on replay.

## Cost and time controls

Two-level spend enforcement, plus time:

| limit | scope | on breach |
|---|---|---|
| `budget.perTurnUsd` / `perTurnTokens` | one turn, checked **mid-stream** | child killed |
| `budget.usd` / `tokens` | whole run | rounds stop, `partial` verdict |
| `roles.<role>.budget.*` | one role | that role skipped, run continues |
| `timeouts.turn` | one turn | killed, one repair attempt |
| `timeouts.total` | whole run | rounds stop, **verdict still runs** |
| `timeouts.verdictGrace` | the judge | mechanical verdict written |

Durations are readable: use `"90s"`, `"15m"`, `"1h"`, `"1.5h"`, or `"1h30m"`. A bare
number remains milliseconds for existing files; `turnMs`/`totalMs`/`verdictGraceMs` are also
accepted but new configs should use `turn`/`total`/`verdictGrace`. Invalid durations stop setup
or config loading rather than silently changing a safety cap.

A role budget can only ever narrow, never widen — adding one cannot increase total spend.
There is no configuration that produces an endless debate: every path terminates in a
verdict file, even when every budget is exhausted.

**Important caveat on dollar figures.** Some providers (including IBM) report
`cost.total = 0` for every model. Where that happens the USD caps **cannot bind**, token
and time caps are the real limits, and every cost figure is marked `$0.0000 (?)` with an
explicit "cost figures are understated" note. No run ever presents a fake `$0.00` as fact.

## Swarm integration (optional, off by default)

If you use [`pi-messenger-swarm`](https://www.npmjs.com/package/pi-messenger-swarm), a
debate can post progress to a channel and read other agents' comments.

```json
{
  "publish":     { "enabled": true, "channel": "debate" },
  "participate": { "enabled": true, "channel": "debate", "maxComments": 5, "trust": "comments" }
}
```

```
debate-orchestrator → #debate: R1 skeptic · 2 open high · B1,B2
debate-orchestrator → #debate: verdict · 3 open high · B1,B2,B4
```

Comments from other agents are shown to the debaters **and** the judge, labelled
unverified. **They never enter the ledger** — nobody on a channel can assert a finding,
set severity, or edit a reviewer's claim. A debater may adopt a comment as its own claim
with its own evidence; that keeps the evidence discipline intact.

The publisher speaks HTTP and **will not start the harness** — if the daemon is down it
records a skip and the run is unaffected.

## Known limitations

- **Cost figures are only as real as the provider's price table** (see above).
- **On a zero-dollar tier, time and tokens are your only guardrails.** Defaults are sized
  for it, but a very large seed deserves a `dryRun` first.
- **The judge sees excerpts, not always the whole document.** Above
  `synthesizer.inlineFullSeedUnderChars` it receives resolved `sourceRef` spans instead.
- **Swarm channel history is pruned** (`feedRetention`), so a long debate on a busy
  channel can miss comments. Fine for opinions; do not make it correctness-critical.
- **Evaluated on one document, single-shot per arm.** Treat the comparison table as
  indicative.
- **A run can degrade to a monologue.** If the Skeptic's turns all fail (provider errors,
  timeouts), the verdict rests on unchallenged proposals. The run is then marked `partial`
  and the verdict header says **NO ADVERSARIAL REVIEW HAPPENED** — but note that a low
  high-severity count in that state is meaningless, not reassuring, because only the
  Skeptic may raise severity. Re-run.
- **Tool-heavy verification needs generous time caps.** On a 52KB document the Skeptic can
  spend 300K+ tokens and 20+ commands in a single turn; a tight `turnMs` kills it mid-work
  and the spend is still charged. Measured guidance in [CONFIG.md](CONFIG.md).
- **Trust the evidence, not the confidence number.** Several fixed defects all made output
  look *cleaner* than reality — fewer open items, tidier numbers. The ledger's per-claim
  evidence is the trustworthy artifact.

## Development

```bash
npm test        # 671 checks, no tokens spent (hermetic: uses a throwaway PI_AGENT_DIR)
```

Real-token tests are excluded on purpose; run `npx tsx test/runner-direct.test.ts`
explicitly. Architecture and module map: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

| Path | Contents |
| --- | --- |
| `index.ts` | Registration and glue only |
| `command.ts` | Argument/mode parsing, cost estimation |
| `config.ts` | Layered config, tiers, per-role resolution |
| `orchestrator.ts` | State machine, budgets, repair, resume |
| `ledger.ts` | Claim contract and write-permission enforcement |
| `prompts.ts` · `excerpts.ts` | Mission assembly, `sourceRef` → seed spans |
| `verdict.ts` · `manifest.ts` | Verdict rendering, run manifest, events |
| `runner/` | `direct.ts` (real models), `fake.ts` (offline tests) |
| `publish.ts` | Optional swarm-channel digests and comment reading |
| `personas/` | Ideator, Skeptic, Synthesizer persona bodies |
| `docs/eval/` | Evaluation reports, ledgers, and verdicts from real runs |

## Design notes

The role split, the ledger-only exchange, authorship anonymisation, and the
verify-don't-argue Skeptic all come from published findings on multi-agent debate —
sycophancy between peers, the value of masked memory over raw transcripts, and the fact
that debate without a correctness signal drifts. Rationale and citations:
[docs/design/](docs/design/).

## License

Apache-2.0 — see [LICENSE](LICENSE).
