# Debate verdict — 20260907-121757-3bbf
Mode: review   Status: complete   Rounds: 2
Claims: 14 (open 11 · disputed 3 · resolved 0 · withdrawn 0)

> Gate closed after round 2: no open high+ claim.

## 1. Unresolved items (severity desc)

- **High:** Incomplete write barrier during snapshot (B1, A9). While TASK-027 disables triggers, TASK-028 captures the Postgres dump and uploads archive while the containers are still running. This fences automated triggers but does not drain in-flight requests or block manual/API writes during the capture, risking an inconsistent snapshot.
- **High:** Incomplete destination quarantine (B3, A11). TASK-039 only quarantines `~/Library/LaunchAgents`. It ignores user-scoped Login Items, `SMAppService` registrations, and cron jobs. Because user directories are migrated (TASK-037), these opaque background jobs will bypass quarantine and auto-start at first login. 
- **High:** Incomplete persistent restart suppression on source (B2, A10). TASK-029 persists a freeze for Multica, but TASK-030 and TASK-031 merely stop Herdr and cloud clients without persisting their disabled state across potential reboots, violating GOAL-005.
- **Medium:** Undefined dependencies (A7). The plan references missing prerequisite tasks (TASK-012, TASK-024, TASK-002, and TASK-022), leaving their guarantees unverified.
- **Medium:** Cloud sync race condition (A4). Network connectivity remains active between the state flush (TASK-026) and the client quit (TASK-031), allowing cloud clients to initiate new syncs.
- **Medium:** Unsafe sequencing of space checks (A8). TASK-034 enables FileVault and installs macOS updates (which consume space and force reboots) before confirming sufficient free space.
- **Medium:** Brittle GUI automation (A5). TASK-036 assumes automated pairing/security-code UI interaction, which is highly sensitive and prone to failure.
- **Medium:** Untested backup (A6). TASK-033 creates a final Time Machine snapshot but only verifies the timestamp, failing to guarantee restorability.

## 2. Decision
proceed-with-changes

## 3. Confidence and why
High (0.9). The ledger accurately captures mechanical flaws in the runbook that violate the stated goals. While A9 attempts to defend the trigger-disable as a write barrier, it logically fails to account for API/manual writes or in-flight draining (B1). Reviewer A explicitly concedes B3 (via A11), acknowledging that unquarantined startup vectors like Login Items pose a critical risk to the destination environment. The minor sequencing and dependency issues (A4, A7, A8) are well-evidenced by direct text citations and are immediately actionable.

## 4. Minority report
One reviewer argues that TASK-027's trigger disablement constitutes a sufficient write barrier (A9) and that TASK-029's `freeze -f` command establishes adequate persistent restart suppression because the core Multica services are covered (A10). This position maintains that remaining unpersisted states (like Herdr plists) are low-risk since the source account won't be actively logged into during transfer. However, this relies on environmental assumptions (no reboots, no API traffic) rather than the strict structural guarantees required by GOAL-005 and GOAL-007.

## 5. Kill criteria
- If halting Multica containers entirely prior to the PostgreSQL dump (TASK-028) breaks the snapshot tooling, and no zero-downtime drain/fence mechanism can be implemented for API writes.
- If `migration-admin` lacks the privileges or tooling to programmatically enumerate and disable user-scoped `SMAppService` and Login Items inside the migrated `tetsuo` account prior to first login.

## 6. Next steps
1. Modify TASK-028/029 to fully stop the Multica server or implement a strict drain/fence for all write paths (API and manual, not just triggers) before capturing the dump (B1, A9).
2. Update TASK-039 and TASK-042 to enumerate, quarantine, and validate user Login Items, `SMAppService` registrations, and cron jobs, expanding beyond just `LaunchAgents` (B3, A11).
3. Update TASK-030 and TASK-031 to apply persistent disablement markers to Herdr and cloud clients to prevent restarts across unexpected reboots (B2, A10).
4. Reorder TASK-034 to confirm sufficient free space *before* enabling FileVault and installing macOS updates (A8).
5. Modify the sequence between TASK-026 and TASK-031 to either disable networking or quit cloud clients immediately after their flush to prevent sync race conditions (A4).
6. Revise the plan to include the missing definitions for preconditions TASK-012, TASK-024, TASK-002, and TASK-022 (A7).
7. Update TASK-036 to enforce manual, user-driven security-code confirmation rather than attempting GUI automation for pairing (A5).

## 7. Cost and provenance

| round | role | model | status | ms | msgs | tokens | cost |
|---|---|---|---|---|---|---|---|
| 1 | ideator | openrouter/anthropic/claude-opus-4-8 | ok | 50904 | 1 | 9069 | $0.0136 |
| 1 | skeptic | openai-codex/gpt-6-astra | ok | 63492 | 4 | 18689 | $0.1551 |
| 2 | ideator | openrouter/anthropic/claude-opus-4-8 | ok | 56291 | 1 | 12237 | $0.0152 |
| 2 | skeptic | openai-codex/gpt-6-astra | ok | 111338 | 9 | 94917 | $0.3820 |
| verdict | synthesizer | openrouter/google/gemini-3.1-pro-preview | ok | 24627 | 1 | 9602 | $0.0507 |

- Run total: **$0.6165** over 144514 tokens, 16 provider requests, 255.8s
- Cache read: 87138 tokens (60.3% of total)
- Runner: direct · repairs used: 0
- Lint: conf_no_evidence×6, skeptic_under_min_flaws×1
