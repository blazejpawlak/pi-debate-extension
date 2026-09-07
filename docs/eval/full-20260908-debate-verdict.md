# Debate verdict — 20260908-000500-wp8b
Mode: review   Status: complete   Rounds: 3
Claims: 27 (open 24 · disputed 3 · resolved 0 · withdrawn 0)
Unsettled at high+ severity: 8

## 1. Unresolved items (severity desc)

- **[CRITICAL] Global quiescence failure during source shutdown [B2]**: TASK-027 specifies `multica-ctl factory stop`, which disables triggers only in the default workspace. Live evidence proves active event-driven entities exist without scheduled triggers (e.g., `secure-m-systems` capacity utilization autopilot) and remain active across workspaces unless paused with `--all-workspaces`.
- **[HIGH] Contradictory prerequisite and kit destination requirements [B1, A9]**: TASK-003 and DEP-003 permit either a network Time Machine destination *or* an external APFS disk. However, Phase 4 (TASK-018–TASK-023) unconditionally mandates an encrypted external APFS volume. When only network Time Machine is attached, Phase 4 is blocked.
- **[HIGH] Bootstrap mkcert certificate regeneration bypass [B3, A11]**: SEC-006 mandates generating fresh local mkcert CA and certificate trust on the destination. However, TASK-021 copies `~/.multica` certs, and Migration Assistant copies CA roots. Because bootstrap guards only check file existence, TASK-051 accepts migrated certificates without generating new cryptographic material.
- **[HIGH] LaunchAgent generator drift and redundant apply in TASK-014 [B6, A14]**: TASK-014 instructs editing `services.json` to add `"env": true` and running `multica-plist-gen --apply`. Inspected source state shows `env: true` is already present, while running `--apply` with an active generator diff risks unreviewed modifications across unrelated LaunchAgents.
- **[HIGH] Working-tree and unstaged file omission in Git validation [B4, B8, B9, A15]**: TASK-023 and TEST-004 rely on sampling and summary counts, which do not prove repository byte parity. Even full object-ID set comparisons (`git cat-file --batch-all-objects`) miss unstaged modifications and untracked files (e.g., in `~/Projects/personal/openusage`) because untracked files do not exist in the Git object database.
- **[HIGH] Omission of mandatory pre-migration database restore drill [B11]**: TASK-015 and TASK-028 verify dumps solely via `pg_restore --list`. The authoritative guide (FILE-013) explicitly requires executing an isolated restore drill before machine migration to validate schema and data integrity.
- **[MEDIUM] Missing FileVault Secure Token and preboot unlock verification [B10]**: The plan checks FileVault enablement and recovery key custody but lacks a verification step (via `sysadminctl -secureTokenStatus tetsuo`) to prove that the migrated user account possesses a Secure Token capable of unlocking the destination Mac at preboot.
- **[MEDIUM] Background Task Management (BTM) autostart bypass [B7, A16]**: TASK-039 quarantines LaunchAgents but ignores macOS Background Task Management / SMAppService registrations. While deselecting `/Applications` neutralizes system apps, login helpers rooted inside `/Users/tetsuo` can execute on first login before software reconstruction.
- **[MEDIUM] Unverified File Provider placeholder hydration prior to retirement [A6]**: CON-003 and TASK-031 correctly prevent recursive hydration during migration, but TEST-014 and TASK-066 lack an explicit assertion confirming that cloud files (Dropbox, Box, Google Drive, iCloud) are fully synchronized or locally backed up before the source Mac is authorized for erasure.
- **[MEDIUM] Coarse Migration Assistant UI deselection granularity [A7]**: REQ-003 assumes independent deselection of Applications, Privacy & Security, System & Network, and Other Files. Apple's Migration Assistant interface varies by macOS version and may combine these categories, requiring a defined fallback remediation procedure.
- **[MEDIUM] Hardcoded baseline literals conflicting with drift refresh [A8]**: Hardcoded version strings in TASK-046 (Node 24.14.1/24.15.0) and TASK-054 (Herdr 0.8.2) contradict the requirement (GUD-002) to refresh drifting baseline values during Phase 2 discovery.
- **[MEDIUM] Undefined task-level state schema for resumption [B5, A13]**: While PAT-001 prechecks mitigate mid-phase rerun damage, `state.json` (FILE-002) lacks a formal task-level completion schema to guarantee unambiguous resumption from arbitrary task interruptions.

## 2. Decision

proceed-with-changes

## 3. Confidence and why

Confidence: 0.92

The evidence ledger is backed by direct inspection commands, filesystem metadata, configuration file diffs, and dry-run execution results. The core migration strategy (Migration Assistant account copy, pre-login LaunchAgent quarantine, logical Multica restoration, clean application installation, and multi-tier rollback) is sound and well-structured. However, concrete gaps in factory quiescence, prerequisite storage routing, certificate regeneration, LaunchAgent generator drift, and Git verification require explicit plan adjustments before execution.

## 4. Minority report

- **Task-level resumption schema vs. PAT-001 prechecks [B5, A13]**: B5 argued that the absence of a structured task-level checkpoint schema in `state.json` leaves mid-phase interruptions vulnerable to uncoordinated reruns. The counter-argument (A13) established that PAT-001's strict `precheck -> evidence -> change -> verification` model provides operational idempotency that bounds the risk of duplicate state changes. A formal task-level schema in `state.json` remains a necessary refinement.
- **Background Task Management autostart risk [B7, A16]**: B7 asserted that unquarantined BTM registrations pose an uncontrolled autostart risk. The counter-argument (A16) noted that deselecting `/Applications` during Migration Assistant eliminates vendor application helpers whose binaries reside in `/Applications`. The remaining exposure is limited to home-directory-rooted binaries, which must be audited via `sfltool dumpbtm` before first login.
- **Git completeness verification [A12, B8]**: An initial proposal (A12) suggested `git fsck --full` and pack/object counts were sufficient for REQ-002 verification. B8 refuted this by proving that internal object validity does not verify source-to-destination equality, leading to the adoption of full object-ID sets and working-tree path/hash auditing.

## 5. Kill criteria

- **Backup Verification Failure [A1, RISK-001]**: Time Machine backup fails to complete or fails Apple network verification in TASK-013 or TASK-033.
- **Missing Kit Media [B1]**: No writable, encrypted external APFS storage device of at least 2 TB is mounted and available to store the independent migration kit during Phase 4.
- **Quiescence Failure [B2, A10]**: `multica-ctl factory status --all-workspaces` reports any active trigger, event-driven autopilot, or running container after TASK-027 and TASK-029 execution.
- **Database Restore Drill Failure [B11, TEST-008]**: Isolated pre-migration restore drill of the logical PostgreSQL dump fails to restore cleanly (non-zero errors, missing tables, or row-count discrepancy).
- **Git Parity Failure [B4, B8, B9, A15]**: Mismatch between source, external kit, or destination in object-ID sets, reflogs, hooks, worktree metadata, or untracked/unstaged working-tree file hashes.
- **FileVault Token Failure [B10]**: `sysadminctl -secureTokenStatus tetsuo` returns disabled or preboot unlock observation fails on the destination Mac prior to cutover.
- **Migration Assistant Category Lock [A7]**: Migration Assistant fails to permit account-only transfer or forces inclusion of system/application bundles without an approved quarantine script.

## 6. Next steps (<=7, each citing a claim id)

1. **[B1, A9]** Update DEP-003, TASK-003, and TASK-018 to mandate an encrypted external APFS physical drive for the Phase 4 migration kit alongside the Time Machine backup.
2. **[B2, A10]** Update TASK-027 and REQ-008 to execute `multica-ctl factory stop --all-workspaces` and verify that all entities (both scheduled triggers and event-driven autopilots) across all workspaces report paused/disabled.
3. **[B6, A14, B11]** Modify Phase 3 to run a precheck of the PostgreSQL backup service before applying `services.json` changes (skipping regeneration if already healthy) and insert a mandatory isolated PostgreSQL restore drill per FILE-013 prior to transfer.
4. **[B3, A11]** Add a task in Phase 9 prior to bootstrap to quarantine/purge migrated mkcert CA keys and server certificates, ensuring TASK-051 generates fresh local certificates matching SEC-006.
5. **[B4, B8, B9, A15]** Replace sampling in TASK-023, TASK-024, and TEST-004 with complete object-ID set validation (`git cat-file --batch-all-objects`), Git administrative metadata hashing, and NUL-safe path/hash comparison of all untracked and unstaged working-tree files.
6. **[B7, A16, B10]** Update Phase 7 and TEST-005/TEST-006 to audit destination `sfltool dumpbtm` for home-rooted login helpers before first user login and add a verification step for `sysadminctl -secureTokenStatus tetsuo`.
7. **[A6, A7, A8, B5]** Update Phase 2 and Phase 8 to dynamically bind tool versions from refreshed discovery, define a formal task status schema in `state.json`, and add an explicit cloud storage sync/hydration audit prior to TASK-066 source retirement.

## 7. Cost and provenance

| round | role | model | status | ms | msgs | tokens | cost |
|---|---|---|---|---|---|---|---|
| 1 | ideator | ibm-services-essentials/claude-opus-4-8 | ok | 52730 | 1 | 27219 | $0.0000 (?) |
| 1 | skeptic | ibm-services-essentials/gpt-5.6-sol | ok | 131966 | 7 | 254155 | $0.0000 (?) |
| 2 | ideator | ibm-services-essentials/claude-opus-4-8 | ok | 91113 | 1 | 34964 | $0.0000 (?) |
| 2 | skeptic | ibm-services-essentials/gpt-5.6-sol | ok | 141186 | 5 | 119830 | $0.0000 (?) |
| 3 | ideator | ibm-services-essentials/claude-opus-4-8 | ok | 43163 | 1 | 33862 | $0.0000 (?) |
| 3 | skeptic | ibm-services-essentials/gpt-5.6-sol | ok | 193953 | 6 | 170607 | $0.0000 (?) |
| verdict | synthesizer | ibm-services-essentials/gemini-3.7-flash | ok | 25140 | 1 | 30534 | $0.0000 (?) |

- Run total: **$0.0000** over 671171 tokens, 22 provider requests, 626.6s
- Cache read: 417461 tokens (62.2% of total)
- Runner: direct · repairs used: 0
- **Cost figures are understated.** At least one turn reported tokens with cost.total = 0 (provider has no price table), so the dollar total above is a lower bound and the USD budget cap could not bind on those turns.
- Lint: skeptic_under_min_flaws×1
- Verification effort: 36 bash invocation(s) across all turns
