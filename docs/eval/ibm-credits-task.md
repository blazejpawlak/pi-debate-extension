# Task: fix IBM Services Essentials credit reporting in the pi status line

You are a focused sub-agent. Do this one task, verify it, and write a report. Do not
touch anything under `~/.pi/agent/extensions/debate/` — another agent owns that.

## The bug

`~/.pi/agent/extensions/enhanced-status-line.ts` renders an IBM credits indicator that
disagrees with the IBM dashboard in **both** numerator and denominator.

| | value |
|---|---|
| Dashboard (https://servicesessentials.ibm.com/settings/usage) | **0 of 1,000 used**, 0%, "Resets in 7d (Sep 14, 02:00 AM)" |
| Local cache `~/.pi/agent/status-line-ibm-credits.json` | `spendCredits: 562.8`, `maxCredits: 500` |
| Status line therefore renders | `credits: ~0/500` (clamped by `Math.max(0, ...)`) — i.e. "you are out of credits" |

The user has full credit available but the status line implies exhaustion.

## Verified facts — start from these, do not re-derive

I already probed this. Confirmed on 2026-09-06:

1. **The authoritative endpoint is broken.** `queryIbmCredits()` GETs
   `https://servicesessentials.ibm.com/services/integrations/team/<teamId>/budget`
   with `Authorization: Bearer <key from ~/.pi/agent/bin/ibm-services-essentials-api-key>`.
   It returns **HTTP 401 `Unauthorized`** (body is the literal string, not JSON).
   The API key helper works and returns a 25-char key. So `queryIbmCredits` always
   returns false, silently, and `source: "budget"` is never reached.

2. **The fallback header is the wrong quantity.** `captureIbmCredits()` reads
   `x-litellm-key-spend`. A live call to `ibm-services-essentials/claude-haiku-4-5`
   returned `x-litellm-key-spend: 570.68237392`. That number only ever grows and is
   already above the 500 default — it is a **cumulative lifetime spend counter**, not
   the resetting weekly Advantage Credits balance the dashboard reports as 0/1000.
   Full header set observed (there is no remaining/limit/reset header among them):
   `x-litellm-attempted-fallbacks, x-litellm-attempted-retries, x-litellm-cache-key,
   x-litellm-call-id, x-litellm-callback-duration-ms, x-litellm-key-spend,
   x-litellm-model-group, x-litellm-model-id, x-litellm-model-name,
   x-litellm-overhead-duration-ms, x-litellm-response-cost-discount-amount,
   x-litellm-response-cost-margin-amount, x-litellm-response-cost-margin-percent,
   x-litellm-response-cost-original, x-litellm-response-duration-ms, x-litellm-version`

3. **`maxCredits` default is wrong.** `IBM_DEFAULT_MAX_CREDITS` is hardcoded to `500`
   (overridable via `IBM_SERVICES_ESSENTIALS_MAX_CREDITS`). The dashboard says the
   quota is **1000**, and it is per-7-day-window with two separate meters:
   "your usage across teams" and "this team's usage across all members".

4. **Free models exist and are not accounted for.** The dashboard lists models that
   "don't use your credits": Gemma 4 26B Preview, Claude Haiku 4.5,
   Llama 4 Maverick 17b Instruct, Granite 4H Small, OpenAI GPT-5.6 Luna.
   The Haiku 4.5 call above returned `x-litellm-response-cost-original: 0.0`.

## What to do

1. **Find the real endpoint.** The dashboard renders these numbers, so a working API
   exists. Inspect what the dashboard itself calls. Try the obvious candidates under
   `https://servicesessentials.ibm.com/services/integrations/...` and any
   `/advantage-credits`, `/usage`, `/settings/usage` style paths. Determine whether the
   401 is due to the wrong auth scheme (maybe it needs a session cookie or a different
   header, not `Bearer <litellm key>`), the wrong URL, or a genuinely unavailable API.
   Use `curl -v` and record exact status codes and bodies.

2. **Fix the status line to never lie.** Ranked by preference:
   - If you find a working authoritative endpoint: use it, and set both spend and max
     from the response.
   - If you cannot: **stop presenting `x-litellm-key-spend` as a credit balance.** A
     cumulative counter divided by a guessed maximum is worse than showing nothing.
     Either relabel it honestly (e.g. `spend: $570.68` with no fraction and no
     implied limit) or show `credits: n/a` when there is no trustworthy source.
     Also fix the 500 default to 1000 if you keep a default at all.
   - Whatever you choose, the indicator must never render a red "exhausted" state
     from data it cannot actually verify.

3. **Do not regress the Codex/OpenAI quota path** in the same file. It is unrelated
   and appears to work.

4. **Verify.** Show the status line rendering before and after. Confirm a real IBM
   call still works and the extension loads with no errors:
   `cd /Users/tetsuo/Desktop/mac-migration && pi --mode json --no-session -p 'reply ok'`
   must exit 0 with no `Failed to load extension` output.

## Constraints

- Back up `enhanced-status-line.ts` before editing.
- Never print the API key itself into any file or report. Refer to it by length only.
- Do not `npm install` anything. Do not modify `settings.json`.
- Do not start or stop any `pi-messenger-swarm` harness.

## Deliverable

Write `/Users/tetsuo/Desktop/mac-migration/.debate/eval/ibm-credits-fix.md` containing:
- what the real endpoint is, or evidence that none is reachable (with status codes)
- the semantics of `x-litellm-key-spend` as best you can establish
- what you changed and why, plus the before/after rendering
- whether free models are distinguishable from paid ones in any response field
- anything you could not resolve
