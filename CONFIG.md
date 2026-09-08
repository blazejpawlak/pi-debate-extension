# debate — configuration reference

Config is layered: **defaults → `~/.pi/agent/settings.json` `"debate"` → `<cwd>/.pi/debate.json`**.

Use **`/debate setup`** for the guided path: it recommends a roster, shows whether each
provider has credentials configured, optionally lets you choose provider/model per role,
sets the relevant guardrail, offers a project file picker / path field / topic editor, shows a final summary, then writes
only the choices you made. A local file overwrites the prior local debate config; global setup
replaces only `settings.json`'s `debate` block (never the rest of your pi settings).

The project file is read only when pi trusts the exact directory it was launched from, because
it can redirect model spend. It is **not inherited by subdirectories**. The wizard asks to
trust an untrusted project before writing its local config.

Technical implementation notes live in `docs/design/`; this reference covers supported user configuration.

---

## Quickest thing you probably want

```json
// <workspace>/.pi/debate.json
{ "tier": "free" }
```

Zero credit cost. See the tier table below for the trade-off.

---

## Tiers

One word sets all three role models. Applied after config merge; any explicit
`roles.<role>.model` still wins.

| tier | ideator | skeptic | synthesizer | cost | caveats |
|---|---|---|---|---|---|
| `free` | `ibm-services-essentials/claude-haiku-4-5` | same | `ibm-services-essentials/gemma-4-26b-a4b-it` | **$0** | Entry-level option. The judge has no thinking support and uses a different model family. Use a generous time limit. |
| `cheap` | `ibm-services-essentials/claude-sonnet-5` | `openai-codex/gpt-5.4-mini` | `openrouter/google/gemini-3.1-pro-preview` | lower than default | Three distinct perspectives. Requires an active Codex subscription for the Skeptic. |
| `default` | `openrouter/anthropic/claude-opus-4-8` | `openrouter/openai/gpt-5.6-sol` | `openrouter/google/gemini-3.1-pro-preview` | paid | Balanced three-model roster. Uses `OPENROUTER_KEY`. |
| `ibm` | `ibm-services-essentials/claude-opus-4-8` | `ibm-services-essentials/gpt-5.6-sol` | `ibm-services-essentials/gemini-3.7-flash` | **$0** | Recommended free roster with three distinct perspectives. Dollar caps do not apply; use time and token limits. |
| `strong` | `openrouter/anthropic/claude-opus-4-8` | `openai-codex/gpt-6-astra` | `openrouter/google/gemini-3.1-pro-preview` | paid | Maximum scrutiny. Requires an active Codex subscription for the Skeptic. |

`tier` unset = the `default` roster (it is baked into `models.*`).

**All three `default` roles route through `OPENROUTER_KEY`.** If it is missing from the
environment, every role fails rather than one degrading. Remaining balance:
`curl -s https://openrouter.ai/api/v1/credits -H "Authorization: Bearer $OPENROUTER_KEY"`.

---

## Per-role configuration

```json
{
  "roles": {
    "ideator":     { "model": "openrouter/anthropic/claude-opus-4-8", "thinking": "high" },
    "skeptic":     {
      "model": "openrouter/openai/gpt-5.6-sol",
      "thinking": "max",
      "tools": ["read", "grep", "find", "ls", "bash"],
      "budget": { "usd": 3, "tokens": 500000, "perTurnUsd": 1.5, "turn": "5m" }
    },
    "synthesizer": { "model": "openrouter/google/gemini-3.1-pro-preview", "free": false }
  }
}
```

**The shipped default already sets one of these:** `roles.skeptic.budget.usd = 1.2`, because
the Skeptic usually accounts for most run cost. Overriding `roles.skeptic.budget`
replaces that cap — set it higher only if you want a third verification round to run.

| field | meaning |
|---|---|
| `model` | `"<provider>/<model>"`, split on the **first** slash only, so OpenRouter ids keep their own slashes. `null` = fall back to persona frontmatter. |
| `thinking` | `off\|minimal\|low\|medium\|high\|xhigh\|max` |
| `tools` | Explicit allowlist, or `"none"`. Omit for the role default. |
| `free` | Declare the model as billing nothing. Suppresses the "cost unreported" warning. **Token caps still apply.** |
| `budget.usd` | Cumulative USD this role may spend across the whole run. |
| `budget.tokens` | Cumulative tokens for this role. |
| `budget.perTurnUsd` | Mid-turn kill ceiling for this role's turns. |
| `budget.perTurnTokens` | Mid-turn token ceiling. |
| `budget.turn` | Per-turn wall clock for this role. Accepts the same duration syntax. |

### Bounding total time (avoiding an endless debate)

```json
{ "timeouts": { "turn": "4m", "total": "15m", "verdictGrace": "5m" } }
```

| key | bounds | on breach |
|---|---|---|
| `turn` | one turn | child killed; one repair attempt |
| `total` | the whole run, checked at turn boundaries | rounds stop, status `partial`, **the verdict still runs** |
| `verdictGrace` | extra time the judge may use *after* `total` | judge skipped, mechanical verdict written |

`totalMs` deliberately does not kill the verdict: a run that spends its budget and returns
nothing is worse than one that returns a `partial` conclusion. But the judge is the largest
single turn — the whole seed can be inlined for it — so it is separately bounded by
`verdictGraceMs`, which caps both *whether* it starts and *how long* its own turn may take.
Set `verdictGrace: 0` to forbid a judge turn once the budget is gone.

Durations accept `"90s"`, `"15m"`, `"1h"`, decimal `"1.5h"`, and compound `"1h30m"`.
A bare number remains milliseconds for compatibility. The old `turnMs`, `totalMs`, and
`verdictGraceMs` spellings still work but new configs should use the readable names above.
Malformed durations are a hard error — a typo must not silently replace a safety limit.

**This matters most on free tiers.** Zero-dollar providers make every USD cap inert, so time
and tokens are the only real limits — and IBM is measurably slower per turn than OpenRouter.

**A role budget can only narrow, never widen.** Every value is clamped to the
corresponding run-level cap, so adding role budgets can never increase total spend.
Exceeding a run cap is warned about and clamped.

**A role that exhausts its own budget is skipped, not fatal** — the round continues so
the other debater and the judge still get their turns.

Role budgets are checked at **turn boundaries**, so like `budget.usd` they can overshoot
by at most one turn. Set `perTurnUsd` meaningfully below the role's `usd` cap.

Precedence: `roles.<role>.model` → legacy `models.<role>` → persona frontmatter.
Setting both of the first two warns and uses `roles`.

---

## Corrected draft artifact

For eligible `review` runs, a separate editor pass produces `<source>.debate-draft.md`.
It never overwrites the source and begins with a provenance header: source SHA-256, review run,
claim IDs, and unresolved blockers. The editor uses the Synthesizer model without tools, has its
own time limit, and is included in normal run cost/provenance. It is skipped for failed reviews,
reviews without a merged Skeptic turn, or when the normal run budget is already exhausted.

```json
{ "artifact": { "enabled": true, "turn": "10m" } }
```

Set `enabled` to `false` to produce only a verdict. Use `/debate artifact <run-id>` to generate
a draft for a completed review without repeating the reviewer turns.

## Run-level budget

```json
{
  "budget": {
    "tokens": 1500000,
    "usd": 5,
    "perTurnUsd": 2,
    "perTurnTokens": 400000,
    "costReporting": "warn"
  }
}
```

`tokens` is the **always-on backstop**. A USD cap is only as real as the provider's
price table — some providers report `cost.total = 0` for everything, which
would silently disable a dollar-only cap.

| `costReporting` | behavior when a turn reports tokens but `cost.total == 0` |
|---|---|
| `warn` (default) | Log `cost_unreported`, keep going on the token cap, and mark the verdict's cost figure as **understated** so the `$` number is never silently fake. |
| `require` | Stop the run rather than spend unmetered. |
| `ignore` | Old behavior; the cost cap does nothing for that provider. |

A role declared `free` is exempt from all three, because zero is the correct answer
for it.

---

## Everything else

```json
{
  "runner": "direct",
  "mode": { "reviewThresholdChars": 2000 },
  "rounds": { "max": 3, "gateSeverity": "high" },
  "timeouts": { "turn": "4m", "total": "15m" },
  "repairs": { "max": 2 },
  "skeptic": { "allowBash": true, "freeAgreements": 1, "minFlaws": 3 },
  "synthesizer": { "inlineFullSeedUnderChars": 40000 },
  "children": { "contextFiles": false, "extraArgs": [] },
  "lessons": { "enabled": true, "maxLines": 200 },
  "inject": "nextTurn",
  "freeModels": ["ibm-services-essentials/claude-haiku-4-5", "..."],
  "publish": { "enabled": false, "channel": "debate" }
}
```

- `runner`: `direct` (default) · `fake` (testing only) · `harness` (not available)
- `rounds.gateSeverity`: R3 only happens if a claim at or above this severity is still open
- `skeptic.allowBash: false` downgrades the Skeptic to read-only tools
- `inject`: `nextTurn` · `followUp` · `none` — how the verdict reaches your next prompt

---

## Swarm-channel digests (`publish`)

```json
{ "publish": { "enabled": true, "channel": "debate" } }
```

Off by default. When enabled, posts one short digest per merged ledger plus one for the
verdict, so a run is visible in a `pi-messenger-swarm` channel:

```
R2 · 3 open high · B1,B4,B7
verdict · 0 open high
```

`channel` may be written `debate` or `#debate`; it is normalized to `#debate`, because
`send` treats a bare name as a **direct message to an agent of that name**, not a channel.

It **joins the channel automatically** on first publish (`join --create`), because `send`
is refused for an unregistered agent. It speaks HTTP rather than shelling out to the CLI,
because `pi-messenger-swarm send` **auto-spawns a detached daemon** and may not report
startup failures reliably.

If the harness is down the publisher declines and records `publish_skipped`; it does not
start it. The extension may start the harness when configured, but it must **never `--stop`
or `--restart`** it, since that can break a session it does not own.

Digests are observational: a down, wedged, or refusing harness never fails, stalls, or
alters a run.

If your installed `pi-messenger-swarm` package cannot start because it lacks the
`@earendil-works/pi-coding-agent` dependency, link it once:

```bash
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" \
  ~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent
pi-messenger-swarm --start
```

---

## Letting other agents comment (`participate`)

```json
{ "participate": { "enabled": true, "channel": "debate",
                   "maxComments": 5, "trust": "comments" } }
```

Off by default. When enabled, other agents on the channel can talk **into** a debate:

```
@PeerReviewer: the backfill in Phase 2 has no idempotency guarantee
```

That text is inlined into every subsequent mission — debaters **and** the judge, since the
judge has no tools and cannot read a file — under a heading marking it unverified and
outside the debate.

**Comments never enter `ledger.json`.** `trust: "comments"` is the only level implemented,
so channel comments cannot assert a finding, set `severity` (which could force an extra
round and spend money), or edit a reviewer's claim. A debater may *adopt* a comment as its own claim with
its own evidence — that is the intended path, and it keeps the evidence discipline.

**The verdict is still the Synthesizer's.** Comments can only persuade a model; they cannot
enter the record. The judge is explicitly told its decision must rest on the ledger.

| detail | behaviour |
|---|---|
| when read | at turn boundaries only — one bounded read, never a polling loop |
| own digests | filtered out, so the debate never reacts to itself |
| duplicates | suppressed by timestamp |
| volume | capped by `maxComments`; each comment costs mission tokens in every later turn |
| length | clipped at 400 chars to keep external context bounded |
| channel down | `external_read_skipped` event; the run is unaffected |

Requires the harness running (see `publish` above). `channel` defaults to
`publish.channel` when empty.

---

## Known free models on this machine

Verified individually 2026-09-07 against the IBM Advantage Credits dashboard:

| model | works | notes |
|---|---|---|
| `ibm-services-essentials/claude-haiku-4-5` | yes | Thinking + tools + reliable ledger compliance. The only free model good enough to debate with. |
| `ibm-services-essentials/gemma-4-26b-a4b-it` | yes | No thinking, 128K ctx. Usable as judge. |
| `ibm-services-essentials/ibm/granite-4-h-small` | yes | 20.5K ctx — too small for most seeds. |
| `ibm-services-essentials/meta-llama/llama-4-maverick-17b-128e-instruct-fp8` | yes | No thinking. |
| `ibm-services-essentials/gpt-5.6-luna` | **no** | Advertised free but returns `403 team not allowed to access model`. Deliberately excluded. |

---

## Sanity-check before spending

```
debate_run { "seedFile": "plan.md", "dryRun": true }
```

Resolves the plan, counts turns, and estimates cost **without invoking any model**.

## Tests

```
npm test                            # 465 checks, no tokens spent
npx tsx test/runner-direct.test.ts  # real tokens, ~$0.22
```

Run from the repo root (`~/Projects/pi-debate-extension`), which is what
`~/.pi/agent/extensions/debate` symlinks to.
