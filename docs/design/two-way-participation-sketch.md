# Design sketch — two-way agent participation in a debate

**Status: proposal. Nothing here is built. Not a work order until you rule on §6.**

Written after §13.47. The question: today the debate broadcasts digests one way. You want
agents to *talk* — exchange ideas and opinions. What would it take, and what breaks?

---

## 1. What already exists vs. what's missing

| | Today | Needed for two-way |
|---|---|---|
| Debate → channel | ✅ digests per merge + verdict (§13.46/47) | — |
| Channel → debate | ❌ nothing reads `feed` | a reader + an injection path |
| Identity | one publisher: `debate-orchestrator` | outside agents need ledger identity |
| Write permissions | two authors, `A`/`B`, hard-coded | a third class, or a mapping |

The transport is solved. **The hard part is the ledger, not the plumbing.**

---

## 2. The core tension

`§8.1` field permissions and `§13.39` cross-author protection assume a **closed world of
exactly two authors**:

```ts
export type Author = "A" | "B";
const AUTHOR_OF = { ideator: "A", skeptic: "B" };
const allowed = role === "ideator" ? IDEATOR_FIELDS : SKEPTIC_FIELDS;
```

`§13.39` is the most valuable invariant in the codebase — it was the worst bug found
(one author silently erasing the other's verified findings while the ledger reported 100%
evidence coverage). Any third participant must be added *without* weakening it.

Three ways this could go wrong, all of which the current design would permit if we were
careless:

1. **Erasure by a stranger.** An outside agent updates `B4.evidence` and deletes the
   Skeptic's command output. `§13.39` blocks cross-author writes *between A and B* — a
   third author would be blocked too, but only if it has a distinct author id. Give it
   `"B"` for convenience and the protection evaporates.
2. **Severity injection to force R3.** Only the Skeptic may set `severity`, deliberately,
   because severity drives the R3 gate (§5.1). An outside agent that can set `severity:
   "critical"` can force extra rounds — i.e. **make the debate spend money**, or on the
   `ibm` tier, burn quota. That is a denial-of-wallet vector from outside the process.
3. **Judge contamination.** `anonymizeForJudge` strips `author` and `history[].by` so the
   Synthesizer cannot cluster claims by voice (D4/§5.1). An injected claim carrying
   `"from: @NiceTiger"` in its `text` re-identifies a participant in prose and defeats
   anonymization without touching the `author` field at all.

---

## 3. Proposal: a distinct, weaker third author class

Add **`author: "X"`** — external. Not `A`, not `B`.

```ts
export type Author = "A" | "B" | "X";
```

**`X` may only ever *add* claims and *comment*. It may never update anyone else's claim.**

| capability | A (ideator) | B (skeptic) | **X (external)** |
|---|---|---|---|
| add new claim | ✅ | ✅ | ✅ (capped, see §4) |
| set `severity` | ❌ | ✅ | ❌ **never** — clamped to `medium` |
| set `status` on own claim | ✅ | ✅ | ✅ |
| touch **another** author's claim | ❌ (§13.39) | ❌ (§13.39) | ❌ **all fields, not just OWN_CLAIM_ONLY** |
| force the R3 gate | ❌ | ✅ | ❌ (follows from severity clamp) |
| appear to the judge | anonymized | anonymized | anonymized **+ provenance stripped** |

Rationale for each restriction:

- **Severity clamp.** Closes the denial-of-wallet vector in §2.2. An outside agent can
  raise a concern; only the Skeptic — which must supply executed evidence (§13.36) — can
  make it gate-forcing. If an external claim deserves high severity, the Skeptic can
  *adopt* it: it adds its own claim citing the same `sourceRef`, with verification. That
  is the existing corroboration mechanism, unchanged.
- **No updates at all, not even `status`.** Stricter than A/B, deliberately. An external
  agent cannot mark a real finding `resolved` and make it disappear from the gate.
  Disagreement is expressed by *adding* a claim, which is visible and auditable.
- **Provenance stripped for the judge.** `anonymizeForJudge` must also scrub agent names
  from `text` (or refuse claims containing `@name` patterns), or §2.3 defeats D4.

---

## 4. Ingestion: how a channel message becomes a claim

Not automatically. **Three gates.**

```
channel feed → (1) opt-in → (2) shape → (3) budget → merge as author X
```

1. **Opt-in, off by default.**
   ```json
   { "participate": { "enabled": false, "channel": "debate",
                      "maxExternalClaims": 5, "trust": "claims" } }
   ```
   `trust: "comments"` (default if enabled) = messages are archived and shown to debaters
   as context, but **never enter the ledger**. `trust: "claims"` = they may become `X`
   claims. Two levels because "let agents comment" and "let agents write to the
   authoritative artifact" are very different risks.

2. **Explicit shape, not free prose.** An agent must address the debate and use a fenced
   block, same discipline as a turn (§8.1):
   ```
   @debate-orchestrator
   ```claim
   {"text": "Phase 2 backfill has no idempotency guarantee",
    "sourceRef": "§Phase 2", "test": "grep -n upsert backfill.sh"}
   ```
   Anything unparseable is archived and logged `external_unparseable`, never guessed at.
   No `severity`, no `id`, no `status` accepted on input — those are assigned by us.

3. **Hard cap.** `maxExternalClaims` per run (default 5). Beyond that:
   `external_cap_exceeded`. Without a cap, a chatty or looping agent can inflate the
   ledger, and every claim costs judge context and therefore money.

Ids follow the existing scheme: `X1…Xn`, so they are visibly external in every artifact.

---

## 5. Where reading happens — and the loop risk

**Read at turn boundaries only**, in `drive()`, never mid-turn:

- Turn boundaries are where budgets are already checked (§13.28), so one more I/O call
  changes no timing invariant.
- Mid-turn reads would inject into a running child's context, which is unreachable.
- **It must not be a polling loop.** §12 forbids channel polling loops ("No long-lived
  agents, no 'wait for your name' prompts, no channel polling loops"). A bounded
  single read between turns is not a loop; a `while (!done) sleep(2)` is. This is the
  distinction that keeps §12 satisfied.

**Loop hazard, stated plainly:** we publish a digest, an agent reacts, we ingest it and
publish another digest, it reacts again. Two mitigations, both needed:
- ignore messages authored by `PUBLISHER_AGENT_NAME` (never react to ourselves);
- only consider messages with `timestamp > lastReadAt`, and `maxExternalClaims` bounds
  the total regardless.

`feedRetention: 50` is a real constraint: a slow debate with a busy channel **will** miss
messages. That is acceptable for opinions; it is why this cannot be a correctness-critical
channel.

---

## 6. Decisions I need from you

1. **Is `trust: "comments"` enough for what you want?** If agents commenting into the
   debaters' context satisfies "exchange ideas and opinions", we can ship that with *zero*
   changes to `ledger.ts` — no new author type, no permission surface, no §13.39 risk. It
   is dramatically cheaper and safer. `trust: "claims"` is the part that needs §3.
2. **Should external claims reach the judge at all?** Alternative: `X` claims are shown to
   the *debaters* only, and excluded from `anonymizeForJudge`. The verdict then rests
   solely on verified A/B work, and outside input influences the debate only by
   persuading a debater to adopt it. This is arguably the most honest option.
3. **Severity clamp — agree?** It is the difference between "outsiders can raise concerns"
   and "outsiders can make your debate spend money".
4. **Do you want the reverse direction too** — the debate *asking* the channel a question
   and waiting? This is a much bigger change: it needs a blocking wait with a timeout,
   which is close to the "wait for your name" pattern §12 forbids. I would keep it out of
   v1.

---

## 7. What I would build first, if you want the cheap version

`trust: "comments"`, ~80 lines, no ledger changes:

- `readExternal()` in `publish.ts` — `POST /action {action:'feed', channel, limit}`,
  filter out our own agent name, filter by timestamp.
- Between turns, append to a `external.md` in the run dir.
- `prompts.ts` includes it in the next mission under a clearly-labelled
  "outside comments (unverified, not part of the ledger)" heading.
- Events: `external_read`, `external_included`.
- Tests: stub feed, assert our own messages are filtered, assert the text reaches the
  mission, assert nothing enters `ledger.json`.

This gets agents genuinely talking into the debate, keeps every §13 invariant intact, and
leaves §3's author-`X` work as a separate, deliberate decision.

**Unverified assumption to check before building even this:** the harness `feed` action's
exact response shape. §13.47 is the cautionary tale — I assumed a refusal shape and was
wrong, and the failure was silent. I will read a real `feed` response first.

---

## 8. Transport facts — verified against the live daemon, not assumed

Checked before writing §4–§7, because §13.47 was caused by assuming a response shape.

**`POST /action {action:'feed', channel, limit}`** returns
`{ok:true, result:{text, details:{mode:'feed', channel, events:[…]}}}`. Parse
`details.events`, never `result.text` — the latter is a rendered human string.

Event shape, confirmed by reading real events:
```json
{"ts":"2026-09-07T20:25:34.249Z","type":"message","agent":"probe-sender",
 "target":"#debate","preview":"…","channel":"debate"}
```

1. **`preview` is NOT truncated.** I expected it to be, given the name. `sanitizePreview`
   only normalizes whitespace (`\r`→`\n`, tabs→spaces, collapse runs, trim). A 224-char
   canary returned intact including its trailing sentinel. So a full claim payload can
   travel through the feed — §4's fenced-block design is viable.
2. **Newlines survive, so fenced blocks survive.** Verified: a `\`\`\`claim` block with
   embedded JSON came back byte-identical and still regex-extractable. This is the single
   fact §4 depends on most, and it holds.
3. **But runs of spaces are collapsed.** Any format relying on indentation would corrupt
   silently — another reason for JSON-in-a-fence rather than YAML or aligned text.
4. **`type` distinguishes `message` from `join`.** Non-message events appear in the same
   array, so the reader must filter on `type === "message"` or it will try to parse joins.
5. **There is no message id and no full-text field beyond `preview`.** Deduplication must
   therefore key on `(ts, agent, preview)`; there is nothing more stable available.

Still unverified: behaviour when two agents post simultaneously, and whether `ts`
ordering is guaranteed monotonic under load. Neither blocks §7, but both matter if this
ever becomes correctness-critical — which §5 argues it should not.
