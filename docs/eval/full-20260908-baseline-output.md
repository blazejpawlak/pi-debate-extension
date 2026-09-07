# Review result: **do not execute as written**

I verified the source Mac on **2026-09-08**. The most serious defects are below, ordered by risk.

## 1. TASK-014 reloads all 13 Multica services before factory triggers are disabled

**Severity: Critical**

### Why it matters

TASK-014 instructs:

```sh
~/.multica/bin/multica-plist-gen --apply
```

With no service name, that implementation rewrites, unloads, and bootstraps **every service**, not just `pg-backup`. Nine services have `RunAtLoad=true`.

This happens in Phase 3, while factory shutdown does not occur until TASK-027. It can restart daemons, the server, factory watchdogs, and quota services while backups and inventories are being prepared. That violates the intended quiescence boundary and can mutate PostgreSQL after an allegedly final inventory.

It is also unnecessary: the live specification and generated plist already contain the repaired environment, and the job has recently succeeded.

### Proof

Command:

```sh
nl -ba ~/.multica/bin/multica-plist-gen | awk 'NR>=160&&NR<=179 {print}'
```

Output:

```text
160 def apply(spec, only_names):
...
164     for label in sorted(rendered):
165         name = label[len(PREFIX):]
166         if only_names and name not in only_names:
167             continue
...
174         subprocess.run(["launchctl", "bootout", f"gui/{uid}/{label}"],
...
176         res = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", dst],
```

The current service specification shows the services that would start:

```text
services= 13
binary-watchdog run_at_load=True
caddy run_at_load=True
daemon run_at_load=True
daemon-blazej run_at_load=True
daemon-claude-02 run_at_load=True
escalation-notifier run_at_load=True
factory-watchdog run_at_load=True
quota-supervisor run_at_load=True
server run_at_load=True
stale-session-reaper run_at_load=True
```

The supposedly missing repair is already installed:

```text
"name": "pg-backup",
...
"env": true
```

Generated plist:

```text
"EnvironmentVariables" => {
  "HOME" => "/Users/tetsuo"
  "PATH" => "/opt/homebrew/bin:...:/Users/tetsuo/.rd/bin:..."
}
```

Current job state:

```text
runs = 4
last exit code = 0
```

Fresh dumps also exist:

```text
-rw-r--r-- ... 113M Sep  5 02:30:12 2026 multica-20260905T003004Z.dump
-rw-r--r-- ... 120M Sep  6 02:30:19 2026 multica-20260906T003006Z.dump
-rw-r--r-- ... 133M Sep  7 02:30:11 2026 multica-20260907T003000Z.dump
```

### Falsification test

Before making any changes:

```sh
python3 ~/.multica/bin/multica-plist-gen --diff
launchctl print "gui/$(id -u)/ai.multica.pg-backup"
```

If a repair remains necessary, render/reload **only** the backup service:

```sh
python3 ~/.multica/bin/multica-plist-gen --apply pg-backup
```

Capture PIDs and factory-trigger state before and after. This finding is falsified only if the tool is changed so unqualified `--apply` cannot reload unrelated services, or TASK-014 explicitly names `pg-backup`.

---

## 2. The plan promises new mkcert material but will reuse migrated keys and certificates

**Severity: High — security/control violation**

### Why it matters

SEC-006 says to recreate mkcert trust and certificates rather than trust copied CA private material. But:

1. Migration Assistant transfers the complete user Library, including mkcert's CA.
2. TASK-021 copies all of `~/.multica`, including the existing TLS private key.
3. The bootstrap script treats existing CA/certificate files as valid and does **not** regenerate them.

Therefore TASK-051's claim that bootstrap will “regenerate mkcert trust/certificates” is false. It will normally retain migrated private keys and potentially trust the migrated CA.

### Proof

Current CA:

```text
/Users/tetsuo/Library/Application Support/mkcert
-r-------- ... rootCA-key.pem
-rw-r--r-- ... rootCA.pem
```

Private server key inside the directory TASK-021 copies:

```text
-rw------- 1704 /Users/tetsuo/.multica/certs/localhost+1-key.pem
-rw-r--r-- 1614 /Users/tetsuo/.multica/certs/localhost+1.pem
```

Bootstrap logic:

```text
96  CAROOT="$(mkcert -CAROOT 2>/dev/null || true)"
97  if [ -n "$CAROOT" ] && [ -f "$CAROOT/rootCA.pem" ]; then
98    step_ok "mkcert CA present ($CAROOT)"
...
104 if [ -f "$CERT_DIR/localhost+1.pem" ] && [ -f "$CERT_DIR/localhost+1-key.pem" ]; then
105   step_ok "backend cert present ($CERT_DIR/localhost+1.pem)"
106 else
107   step_do "regen backend cert: mkcert localhost 127.0.0.1"
```

Plan contradiction:

```text
SEC-006: Recreate local mkcert trust and certificates...
TASK-021: Copy critical user roots ... ~/.multica ...
TASK-051: ... regenerate mkcert trust/certificates ...
```

### Falsification test

Record source hashes:

```sh
shasum -a 256 \
  "$HOME/Library/Application Support/mkcert/rootCA.pem" \
  "$HOME/Library/Application Support/mkcert/rootCA-key.pem" \
  "$HOME/.multica/certs/localhost+1.pem" \
  "$HOME/.multica/certs/localhost+1-key.pem"
```

On the destination, before bootstrap:

1. Quarantine the migrated mkcert CA and `~/.multica/certs`.
2. Run `mkcert -install`.
3. Generate the localhost certificate.
4. Compare hashes and public-key fingerprints.

The finding is falsified only if destination keys differ from source keys and the destination trust store references the newly generated CA.

---

## 3. The Multica restoration is not reproducible because mutable image tags are used and no digest is recorded

**Severity: High**

### Why it matters

The plan rebuilds Rancher and restores production data into newly pulled images, but the Compose files use:

- `pgvector/pgvector:pg17`
- `ghcr.io/multica-ai/multica-web:latest`

Neither image digest is captured by the plan. At migration time, those tags may resolve to versions different from the currently working source. This is especially dangerous for:

- database extension/version compatibility;
- schema migrations;
- frontend/backend API compatibility;
- rollback diagnosis.

The plan asks for “initial parity” while omitting the data needed to reproduce parity.

### Proof

Resolved Compose images:

```text
pgvector/pgvector:pg17
multica-backend
ghcr.io/multica-ai/multica-web:latest
```

Current running containers:

```text
multica-postgres-1
image=pgvector/pgvector:pg17
id=sha256:076f69e404b796ef2f60098ea996e56f247bfc5f80d5e8a7ae7cf982d9e0883d

multica-frontend-1
image=ghcr.io/multica-ai/multica-web:latest
id=sha256:6d702a0c0bdb4ce1167fe6f76c94a6a05e91f5e376c977607bce28191cc5bd19

multica-backend-1
image=multica-backend
id=sha256:6b154323e4fcb867ff2e2020c6918be2e736e1979f387ac9fc296fadb70e284e
```

Current PostgreSQL version and image digest:

```text
postgres (PostgreSQL) 17.9 (Debian 17.9-1.pgdg12+1)
pg_dump (PostgreSQL) 17.9 (Debian 17.9-1.pgdg12+1)
[pgvector/pgvector@sha256:494dff7e67e7bc2c826b94c331364978d145ebb86fd338154138b084223b7f67] arm64
```

The plan contains no image-digest requirement:

```sh
grep -niE 'digest|sha256.*image|pin.*image' plan.md
```

Output: no matches.

### Falsification test

Before migration, record:

```sh
docker inspect multica-postgres-1 multica-frontend-1 multica-backend-1 \
  --format '{{.Name}} image={{.Config.Image}} id={{.Image}}'

docker image inspect pgvector/pgvector:pg17 \
  --format '{{json .RepoDigests}}'
```

On the destination, compare the resolved image IDs before restoring data. This finding is falsified if the plan pins immutable digests or explicitly proves and approves a tested version change.

---

## 4. A TOC listing is incorrectly treated as sufficient database-backup verification

**Severity: High**

### Why it matters

TASK-015 and TASK-028 effectively validate the custom dump using `pg_restore --list`. That confirms that the archive header and table of contents can be read; it does not prove that all compressed table-data streams restore successfully.

The local authoritative restore guide explicitly says to rerun a scratch restore drill before machine migration. The plan delays a real restore until the destination, after the source has been quiesced and migration is underway.

For an irreversible migration, the fresh final dump should be restored into a scratch PostgreSQL instance and checked before Multica is stopped.

### Proof

The newest dump can be listed:

```text
newest=/Users/tetsuo/.multica/backups/pgdata/multica-20260907T003000Z.dump
mtime=2026-09-07 02:30:11 +0200 size=139720084

; Archive created at 2026-09-07 00:30:01 UTC
;     dbname: multica
;     TOC Entries: 781
;     Compression: gzip
```

But the local restore documentation requires more:

```text
Fresh machine / scratch verification:

docker run -d --name mrd -e POSTGRES_PASSWORD=x -e POSTGRES_USER=multica \
  -e POSTGRES_DB=multica pgvector/pgvector:pg17
# wait for pg_isready, then pg_restore as above into `mrd`
```

It also says:

```text
Re-run the drill after major schema migrations and before machine migration
```

The previous drill is stale relative to the current dump:

```text
2026-07-16 ... 77/77 tables; task_message 203,673 = 203,673 rows
```

Current dumps are from September and have grown from roughly 60 MB to 133 MB.

### Falsification test

Before TASK-029:

1. Start an isolated scratch container using the **captured source digest**.
2. Restore the final dump completely.
3. Require zero restore errors.
4. Compare schema inventory, extension versions, all critical table counts, and preferably aggregate counts for every user table.
5. Exercise at least one read-only application query against the restored database.

A successful full scratch restore of the exact final dump falsifies this finding.

---

## 5. The source has only 23 GiB free, not the plan's 95 GiB, and no minimum-free-space gate exists

**Severity: High operational risk**

### Why it matters

The source Data volume is now **98% full**. The plan only says to avoid large duplicate archives; it does not define a minimum free-space gate or a safe space-recovery procedure.

This can break or corrupt the operational sequence through:

- Time Machine local snapshot/staging pressure;
- PostgreSQL dump growth;
- logs and temporary files;
- cloud-client synchronization;
- VMware shutdown/snapshot consolidation;
- APFS copy-on-write overhead.

The plan correctly checks destination capacity but gives no equivalent source-space threshold.

### Proof

```text
/dev/disk3s5  926Gi  868Gi  23Gi  98%  /System/Volumes/Data
Container Free Space: 24.8 GB
```

The large user datasets remain substantial:

```text
34G  /Users/tetsuo/Library/Mail
56G  /Users/tetsuo/Downloads
25G  /Users/tetsuo/Pictures
5.0G /Users/tetsuo/Databases
```

Only one APFS snapshot exists, and it is not a Time Machine snapshot:

```text
Snapshot for disk3s1s1 (1 found)
Name: com.apple.os.update-...
Purgeable: No
```

### Falsification test

Before starting backup activity:

```sh
df -h /System/Volumes/Data
diskutil info / | grep 'Container Free Space'
tmutil listlocalsnapshots /
```

Run the final backup and dump while monitoring free space and require an explicit safety floor. This finding is falsified if a documented threshold is established and the source remains above it through a complete rehearsal. I would not proceed at 23 GiB without first placing backup artifacts directly on encrypted external storage or safely reclaiming verified disposable data.

---

## 6. The “independent critical-data copy” omits 115 GiB of prominent user data

**Severity: High, depending on the intended independence guarantee**

### Why it matters

TASK-021 calls the external kit an independent copy of critical state, but excludes:

- `~/Library/Mail` — 34 GiB
- `~/Downloads` — 56 GiB
- `~/Pictures` — 25 GiB

That is approximately **115 GiB** explicitly identified by the plan itself. These datasets therefore depend on Migration Assistant and Time Machine rather than the checksummed independent kit.

This weakens the claimed fallback hierarchy, especially because the configured Time Machine destinations are currently unreachable.

### Proof

Plan inclusion list:

```text
TASK-021 ... ~/.multica, ~/IBM, ~/Projects, ~/agent_workspaces,
~/multica_workspaces*, ~/.config, ~/.herdr, ~/.ssh, ~/.gnupg,
~/.gitconfig*, ~/.zsh*, ~/.local/bin, ~/Databases, and user-authored scripts.
```

Measured omitted data:

```text
34G  /Users/tetsuo/Library/Mail
56G  /Users/tetsuo/Downloads
25G  /Users/tetsuo/Pictures
```

They are included in Time Machine policy:

```text
[Included] /Users/tetsuo/Downloads
[Included] /Users/tetsuo/Pictures
[Included] /Users/tetsuo/Library/Mail
```

But both configured NAS endpoints are currently unreachable from this network:

```text
10.0.1.248
gateway: 172.20.10.1
interface: en0
nc: connectx to 10.0.1.248 port 445 (tcp) failed: Operation timed out

10.0.1.253
gateway: 172.20.10.1
interface: en0
nc: connectx to 10.0.1.253 port 445 (tcp) failed: Operation timed out
```

No external disk is presently attached:

```text
### external disks
```

### Falsification test

After Time Machine becomes reachable:

1. Complete a new backup.
2. Mount the resulting snapshot.
3. Verify representative files and inventories from Mail, Downloads, and Pictures.
4. Perform test restores to a scratch location.
5. Alternatively, include these roots in the encrypted independent kit and compare inventories/hashes.

This finding is weakened—but not fully falsified—by merely seeing a successful Time Machine completion timestamp.

---

## 7. The Time Machine “network verification” hard gate is underspecified and not CLI-executable as written

**Severity: Medium–High**

### Why it matters

TASK-013 and TEST-002 require “Apple's network-backup verification,” but do not define the exact operation or acceptance evidence.

On this Mac, `tmutil` has no `verifybackups` command. It has `verifychecksums path ...`, which requires explicit paths and is not equivalent to whole-backup-store verification. Apple's GUI network-backup verification is a separate interactive operation.

An AI-executable, resumable hard gate needs an exact command or an explicit GUI procedure and log criterion.

### Proof

Available `tmutil` operations include:

```text
Usage: tmutil verifychecksums path ...
```

The manual states:

```text
verifychecksums path ...
    Compute a checksum of data contained within a backup and verify the
    result(s) against checksum information computed at the time of backup.
```

There is no whole-store `verifybackups` verb in the local command list.

Current backup status also remains:

```text
Running = 0
```

And `tmutil latestbackup` did not complete within the 30-second verification command because the destinations were unreachable.

### Falsification test

Specify and execute one of:

- the exact Apple GUI “Verify Backups” workflow, with completion status and relevant unified-log evidence; or
- `tmutil verifychecksums` over a defined, representative, risk-based path set plus test restores; or
- a filesystem/store-specific vendor-supported verification procedure.

The finding is falsified once the plan names an executable procedure, exit/result criteria, timeout, and retry behavior.

---

# Immediate required plan corrections

At minimum:

1. Change TASK-014 to:
   ```sh
   multica-plist-gen --apply pg-backup
   ```
   and skip it entirely if `--diff`, the plist environment, fresh dump, and last exit status already pass.
2. Add a pre-bootstrap destination task that quarantines/removes:
   - `~/Library/Application Support/mkcert`
   - `~/.multica/certs`
   then creates a fresh CA and server certificate.
3. Capture and pin current container image digests.
4. Require a full scratch restore of the **final** PostgreSQL dump before stopping Multica.
5. Add a source free-space hard gate and recovery procedure.
6. Either expand the encrypted independent copy to Mail/Downloads/Pictures or explicitly downgrade its guarantee.
7. Define the exact Time Machine verification and test-restore procedure.

# Self-critique

## Weakest findings

- **Source free space:** This is partly an execution blocker rather than a logical contradiction. The plan does say to refresh storage and avoid large duplicates. However, 23 GiB on a 98%-full Data volume is materially different from the stated 95 GiB, and the absence of a threshold remains a real defect.
- **Independent-copy omissions:** The plan still has two other intended copies—fresh Time Machine and the retained old Mac. If Time Machine is successfully verified and the old Mac remains untouched, omission from the external kit is not immediate data loss. The flaw is primarily that the kit is less independent/comprehensive than its wording suggests.
- **Time Machine verification:** Apple may provide a usable GUI verification operation for the network destination. My finding is that the plan is not sufficiently executable, not that verification is impossible.

## What I could not verify and may have missed

- The M5 destination was not available to inspect, so I could not verify its capacity, OS, FileVault state, enrollment, existing users, or whether Migration Assistant exposes exactly the category controls assumed by TASK-037.
- No external APFS disk was attached, so encryption, capacity, filesystem, and metadata preservation could not be tested.
- Both NAS addresses were unreachable from the current `172.20.10.x` network, so I could not inspect the latest backup or test an actual restore.
- File Provider placeholder completeness was not established. There are active Box, Dropbox, Google Drive, ExpanDrive, and Synology roots, but proving cloud/local parity requires provider-specific status or GUI access.
- I did not perform a full scratch PostgreSQL restore because that would create new runtime state and was outside a read-only review.
- The repository baseline has already drifted materially: my read-only scan found:
  ```text
  repositories=209 dirty=38 untracked_status_entries=99
  ```
  versus the plan's 156/36. The plan does require a refresh, so this is not itself a defect, but it means none of the old repository-count acceptance values may be reused.
- I did not verify whether all unique non-Homebrew software under `/usr/local` is reconstructable. The machine contains IBM Cloud, GPG, Yubico, Jamf, SimplySign PKCS libraries, and other state there; the plan explicitly preserves only the Caddy helper from that hierarchy. This deserves a dedicated inventory/reconstruction gate before system-wide files are excluded.