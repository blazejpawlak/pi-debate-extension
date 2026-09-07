# debate — configuration reference

Config is layered: **defaults → `~/.pi/agent/settings.json` `"debate"` → `<workspace>/.pi/debate.json`**.
The project file is only honored for a *trusted* project, because it can redirect model spend.

Design doc: `debate-swarm-design.md`. Deviations from it are recorded in that file's §13.

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
| `free` | `ibm-services-essentials/claude-haiku-4-5` | same | `ibm-services-essentials/gemma-4-26b-a4b-it` | **$0** | Violates D8 (only 2 families, judge not fully independent). Gemma has no thinking support. Slow: ~13 min for a 6KB seed. Raise `timeouts.turnMs` to ≥240000. |
| `cheap` | `ibm-services-essentials/claude-sonnet-5` | `openai-codex/gpt-5.4-mini` | `openrouter/google/gemini-3.1-pro-preview` | ~10× under default | 3 real families. **Skeptic needs the codex subscription**, which is currently exhausted (§13.41). |
| `default` | `openrouter/anthropic/claude-opus-4-8` | `openrouter/openai/gpt-5.6-sol` | `openrouter/google/gemini-3.1-pro-preview` | ~$0.81 projected on a 6KB seed | 3 families. Skeptic capped at $1.20/run by a default role budget (§13.41). |
| `ibm` | `ibm-services-essentials/claude-opus-4-8` | `ibm-services-essentials/gpt-5.6-sol` | `ibm-services-essentials/gemini-3.7-flash` | **$0** (fixed-credit plan) | **3 distinct families, so D8 holds** — the only zero-dollar roster that keeps an independent judge. Worst case is quota exhaustion, not a bill. **Every USD cap is inert**, so the tier ships token caps instead; the verdict marks all costs `$0.0000 (?)`. Verified end to end: 2 rounds, 14 claims, 5 high-severity findings, 17 bash calls, $0.00 (§13.45). |
| `strong` | `openrouter/anthropic/claude-opus-4-8` | `openai-codex/gpt-6-astra` | `openrouter/google/gemini-3.1-pro-preview` | $2.11 measured on a 6KB seed | The WP5 re-probe roster, kept for reproducibility. **Requires a working `openai-codex` subscription** — otherwise the skeptic turn fails with a usage-limit error. Via OpenRouter instead, gpt-6-astra costs ~$3.54/run. |

`tier` unset = the `default` roster (it is baked into `models.*`).

**All three `default` roles route through `OPENROUTER_KEY`.** If it is missing from the
environment, every role fails rather than one degrading (§13.42). Remaining balance:
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
      "budget": { "usd": 3, "tokens": 500000, "perTurnUsd": 1.5, "turnMs": 300000 }
    },
    "synthesizer": { "model": "openrouter/google/gemini-3.1-pro-preview", "free": false }
  }
}
```

**The shipped default already sets one of these:** `roles.skeptic.budget.usd = 1.2`, because
the Skeptic is empirically ~95% of run cost (§13.41). Overriding `roles.skeptic.budget`
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
| `budget.turnMs` | Per-turn wall clock for this role. |

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
price table — some providers report `cost.total = 0` for everything (see §13.14), which
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
  "timeouts": { "turnMs": 240000, "totalMs": 900000 },
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

- `runner`: `direct` (default) · `fake` (tests) · `harness` (not implemented, WP7)
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
because `pi-messenger-swarm send` **auto-spawns a detached daemon** and that failure path
**exits 0** (§13.46).

If the harness is down the publisher declines and records `publish_skipped`; it does not
start it. D11 has been retired (§13.47) — the extension may start the harness — but it must
**never `--stop` or `--restart`** it, since that is the only irreversible action that can
break a session it does not own.

Digests are observational: a down, wedged, or refusing harness never fails, stalls, or
alters a run.

**Prerequisite on this machine:** `pi-messenger-swarm` ships without declaring its
`@earendil-works/pi-coding-agent` dependency, so the daemon cannot start until it is
linked (§13.47):

```bash
ln -s "$(npm root -g)/@earendil-works/pi-coding-agent" \
  ~/.pi/agent/npm/node_modules/@earendil-works/pi-coding-agent
pi-messenger-swarm --start
```

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
