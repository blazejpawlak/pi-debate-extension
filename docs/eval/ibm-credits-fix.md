# IBM Advantage Credits — status line fix

Date: 2026-09-07
File changed: `~/.pi/agent/extensions/enhanced-status-line.ts`
Backup: `~/.pi/agent/extensions/enhanced-status-line.ts.bak-20260907-082358`

## The bug

| source | value |
|---|---|
| Dashboard (`/settings/usage`) | **0 of 1,000 used**, 0%, resets Sep 14 02:00 |
| Local cache `status-line-ibm-credits.json` | `spendCredits: 562.8` (later 686.4), `maxCredits: 500` |
| Status line rendered | `credits: ~0/500` in **error red** — "you are out of credits" |

Both the numerator and the denominator were wrong, and the result was a permanent
false exhaustion warning on an account with its entire quota available.

## Is there a real endpoint? No.

Probed exhaustively. Two different hosts are involved and neither serves the balance:

**`servicesessentials.ibm.com`** — the browser dashboard, and what `queryIbmCredits()`
already calls:

| path | result |
|---|---|
| `/services/integrations/team/<id>/budget` | **401** `Unauthorized` (body is that literal string, not JSON) |
| `/services/integrations/team/<id>/usage` | 401 |
| `/services/integrations/team/<id>/credits` | 401 |
| `/services/integrations/team/<id>/advantage-credits` | 401 |

Auth styles tried on `/budget`, all 401: `Authorization: Bearer <key>`, `x-api-key`,
`apikey`, `X-IBM-Client-Id`. This host appears to be session-cookie authenticated for
the logged-in browser; the LiteLLM API key is not a credential for it.

**`api.servicesessentials.ibm.com`** — the inference host the provider extension
actually uses (`ibm-services-essentials.ts` line 8). The key *is* valid here:

| path | result |
|---|---|
| `/v1/models` | **200**, full model list |
| `/v1/key/info` · `/v1/user/info` · `/v1/customer/info` | 404 `{"detail":"Not Found"}` |
| `/v1/budget` · `/v1/credits` · `/v1/usage` · `/v1/spend` | 404 |
| `/v1/global/spend/report` · `/v1/team/<id>/budget` · `/v1/advantage-credits` | 404 |

So: the host that knows the balance rejects the key, and the host that accepts the key
does not expose the balance. **`queryIbmCredits()` has been silently failing since it
was written**, which is why `source` was always `"response-header"`.

## What `x-litellm-key-spend` actually is

A **cumulative lifetime spend counter**, not the resetting weekly Advantage Credits
balance. Evidence:

- Observed 562.8 → 570.7 → 686.4 across this session's calls; it only ever grows.
- It is already far above the 500 default, and above the dashboard's 1000 quota, while
  the dashboard simultaneously reports **0 used**.
- It is denominated in the LiteLLM key's own spend units, unrelated to the credit
  window that resets weekly.

Full header set from a live `claude-haiku-4-5` call (no remaining/limit/reset header
exists among them):

```
x-litellm-attempted-fallbacks, x-litellm-attempted-retries, x-litellm-cache-key,
x-litellm-call-id, x-litellm-callback-duration-ms, x-litellm-key-spend,
x-litellm-model-group, x-litellm-model-id, x-litellm-model-name,
x-litellm-overhead-duration-ms, x-litellm-response-cost-discount-amount,
x-litellm-response-cost-margin-amount, x-litellm-response-cost-margin-percent,
x-litellm-response-cost-original, x-litellm-response-duration-ms, x-litellm-version
```

## The fix

Since no trustworthy denominator exists, **stop rendering a fraction from data that
cannot support one.** A number that is true beats a ratio that is false.

- When `source !== "budget"` (i.e. always, today) the indicator now renders
  `spend: 686.36 total` — relabelled from `credits:`, no denominator, no percentage,
  and **uncoloured**, so it can never imply an exhausted quota.
- The `credits: available/max` fraction with threshold colouring is retained but now
  only reachable when a genuine budget source succeeds. If IBM ever fixes the endpoint
  the good path lights up with no further change.
- `IBM_DEFAULT_MAX_CREDITS` corrected 500 → 1000 to match the dashboard (still
  overridable via `IBM_SERVICES_ESSENTIALS_MAX_CREDITS`).

Rendering, verified against the real cache file:

```
BEFORE: credits:<error>0/500          <- false exhaustion warning
AFTER:  spend:<muted>686.36 total     <- true, and makes no claim about remaining quota

if a budget source ever works:
        credits:<success>1,000/1,000 (resets 09-14T08:12)
```

The Codex/OpenAI quota path in the same file was not touched. Extension loads clean:
`pi --mode json --no-session -p 'reply ok'` → 0 error lines.

## Free models

The dashboard lists five models that "don't use your credits". Verified individually:

| model | works | note |
|---|---|---|
| `claude-haiku-4-5` | yes | thinking + tools; `x-litellm-response-cost-original: 0.0` |
| `gemma-4-26b-a4b-it` | yes | no thinking |
| `ibm/granite-4-h-small` | yes | 20.5K context |
| `meta-llama/llama-4-maverick-17b-128e-instruct-fp8` | yes | no thinking |
| `gpt-5.6-luna` | **NO** | `403 team not allowed to access model` despite being advertised free |

**Free models are not distinguishable from paid ones by any response field.** Both
report `cost.total: 0` — free because it genuinely is, paid-on-this-plan because IBM
ships a zero cost table for all 19 models (see design §13.14). Any consumer that needs
the distinction must carry an explicit allowlist; the debate extension now does
(`config.freeModels`, design §13.29).

## Unresolved

- The real dashboard API. Finding it requires capturing the authenticated browser
  session (devtools network tab while logged in), which I did not do since it needs
  interactive login. If you can grab one request from that page, the fix is a one-line
  URL/auth change in `queryIbmCredits()`.
- Whether the two dashboard meters ("your usage across teams" vs "this team's usage
  across all members") are separate quotas or two views of one. Only matters once an
  endpoint exists.
