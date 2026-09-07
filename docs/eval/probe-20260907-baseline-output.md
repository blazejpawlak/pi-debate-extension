I've verified enough against the machine. Here is my analysis.

## Highest-severity flaws

### 1. `freeze` does not disable the watchdogs, and a watchdog will silently un-freeze the whole Multica stack (TASK-029)
This is the most serious flaw. TASK-029 relies on `multica-ctl freeze -f` to durably stop long-running Multica services so they "do NOT return on login… Survives reboot." But:
- `freeze` only touches `SERVICES_LONG_RUNNING` (7 labels: server, caddy, daemon, daemon-blazej, daemon-claude-02, quota-supervisor, escalation-notifier).
- `ai.multica.binary-watchdog` is **not** in that list, keeps running every 600s, and on any watched-binary change runs `FORCE=1 multica-ctl restart`.
- `restart` → `cmd_stop` + `cmd_start`; `cmd_start`→`load_one` uses `launchctl load -w`, which **clears the disabled override** that `freeze` set.

So between the final dump (TASK-028) and Migration Assistant, a Homebrew autoupdate (`com.github.domt4.homebrew-autoupdate`, every 43200s) or a Google/OpenAI updater can change a binary target, the watchdog fires, and the frozen daemons come back up — writing to Postgres and uploads after your "final" quiesced snapshot. The maintenance marker does not gate the watchdog.

Falsification test:
```bash
# 1. watchdog not covered by freeze:
grep -A10 'SERVICES_LONG_RUNNING=' ~/.local/bin/multica-ctl | grep -c watchdog   # -> 0
# 2. watchdog re-animates via load -w:
grep -n 'multica-ctl.*restart' ~/.multica/bin/services/multica-binary-watchdog.sh
grep -n -A2 'launchctl load -w' ~/.local/bin/multica-ctl   # load_one uses load -w
# 3. live proof (safe, reversible):
multica-ctl freeze --dry-run          # lists only the 7; watchdogs absent
FORCE=1 ~/.multica/bin/services/multica-binary-watchdog.sh   # after a real freeze, check status
multica-ctl status                    # if daemons show LOADED again, flaw confirmed
```
Verified: watchdog is absent from the freeze list; the restart→load -w path is present in the script.

### 2. TASK-029's "three Compose containers are down" is factually wrong about the topology (TASK-028/029)
TASK-028 says "with containers still running, create a final dump," then TASK-029 says verify "the three Compose containers are down." But the plan never issues a command to bring them down within Phase 5 — `stop --server` runs `docker compose down` on the **multica** project only. On this machine the multica project has exactly three containers (backend, frontend, postgres), so that part is coincidentally right — but there are **many other running Compose projects** (`sms-go-tunnel-accept`, `sms-eval-289`, a loose `golang:1.27-alpine`, k8s pods). The plan treats "containers" as if Multica were the only stack. Nothing quiesces or even inventories the SMS/eval stacks or the paused `sms-eval-289-sms-target-1`, and `stop --server` won't touch them.

Falsification test:
```bash
docker ps --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Status}}'
# Verified: multica project = 3 containers, but sms-go-tunnel-accept, sms-eval-289,
# and hardcore_swartz are running and untouched by the plan.
```

### 3. TASK-030 unloads only `dev.herdr.collie` but there are two Herdr agents (TASK-030)
TASK-030 says "Unload `dev.herdr.collie`" and verify listeners 8787/8788 absent. But there are **two** Herdr LaunchAgents: `dev.herdr.collie` and `dev.herdr.collie-vpn-hosts` (a bun script on a 30s `StartInterval`). The second is not unloaded, so it will keep re-executing every 30s (and, being a copied LaunchAgent, will run on the destination too). Also, `herdr server stop` stops the server, but the vpn-hosts agent is independent of the server socket.

Falsification test:
```bash
ls ~/Library/LaunchAgents | grep -i collie     # two plists
grep -A2 StartInterval ~/Library/LaunchAgents/dev.herdr.collie-vpn-hosts.plist  # 30s
# Verified: two agents exist; TASK-030 names only one.
```

### 4. TASK-030's port claims are half-wrong: 8788 is Homebrew Caddy, and KSeF has no port (TASK-030)
- The plan says to "stop the Homebrew Caddy service" and verify listeners 8787 and 8788 absent. On this machine **8788 is served by the Homebrew Caddy** (`/opt/homebrew/opt/caddy/bin/caddy … /opt/homebrew/etc/Caddyfile`), while the *Multica* Caddy (a separate agent, stopped back in Phase 5 by `stop --server`) listens on 3443. So "stop Herdr server" is not what frees 8788 — stopping Homebrew Caddy is, and the causal attribution in the task is muddled.
- The task says verify "the KSeF service port/process are absent." **KSeF (`com.ksefctl`) has no listening port** — it's a `sync --watch` file watcher with `KeepAlive=true`. A check that waits for a port to disappear will either pass vacuously or hang forever. The KeepAlive also means a plain `kill` respawns it; you must `launchctl unload`.

Falsification test:
```bash
lsof -nP -iTCP:8788 -sTCP:LISTEN            # -> Homebrew caddy, not Multica
lsof -nP -p $(pgrep -f ksefctl/dist/cli.js) | grep LISTEN   # -> empty: no port
grep KeepAlive ~/Library/LaunchAgents/com.ksefctl.plist     # true -> kill respawns
# Verified all three.
```

### 5. `freeze` leaves `pg-backup` armed; its 02:30 job can run against a stopped stack or mutate the kit baseline (TASK-028/029)
`ai.multica.pg-backup` (StartCalendarInterval 02:30) is not in the freeze set. After TASK-029 stops Postgres, if the migration window spans 02:30 the backup job fires against a down database — at best a spurious error, at worst it overwrites the good pre-quiescence backup artifact with a failed/empty one, corrupting the "final dump" the kit depends on. Same class applies to `stale-session-reaper` (300s), `log-rotate`, `quota-policy-audit` — all still armed after freeze, all can mutate state after your "consistent" snapshot.

Falsification test:
```bash
for s in pg-backup stale-session-reaper log-rotate quota-policy-audit; do
  grep -q "ai.multica.$s" <(grep -A10 'SERVICES_LONG_RUNNING=' ~/.local/bin/multica-ctl) \
    && echo "$s frozen" || echo "$s STILL ARMED"; done
# Verified: all four print "STILL ARMED".
```

### 6. TASK-034 enables FileVault + installs all macOS updates, then TASK-036 runs Migration Assistant — ordering/consistency hazard (TASK-034→036)
Enabling FileVault triggers **background full-volume encryption**; running Migration Assistant (a large write) concurrently massively slows the transfer and stresses the disk. More importantly, "install all available macOS updates, restart if required" on the destination can leave the two Macs on **different macOS builds** — Migration Assistant from an older source to a newer destination is supported, but the reverse and cross-major mismatches are risky. The plan sets source expectations nowhere. Source here is macOS 26.6.2 (build 25G83); the destination "M5" starting "as new" will likely be on a different build.

Falsification test:
```bash
sw_vers   # source: 26.6.2 / 25G83  (verified)
# On destination after TASK-034: sw_vers; compare. fdesetup status to see if
# encryption is still in progress when MA starts.
fdesetup status
```

### 7. TASK-037 says "Preserve the VMware folder" while deselecting "system-wide Other Files & Folders" — these conflict, and VM state is huge/opaque (TASK-037)
Migration Assistant's category granularity does not let you keep the VMware VMs (which live under `~/Virtual Machines` or `~/Documents`) while deselecting the "Other Files & Folders" bucket that contains them, unless they're inside the user home (they are, so they ride along with the account — making the "deselect Other Files & Folders" instruction either a no-op or a contradiction depending on where they sit). The task assumes a selection precision MA doesn't offer. Given `vmrun` exists here, VMs are real and large.

Falsification test:
```bash
ls -la "$HOME/Virtual Machines" 2>/dev/null; mdfind -name '.vmwarevm' 2>/dev/null | head
# Check whether VM bundles are inside /Users/tetsuo (ride with account) or elsewhere
# (fall under "Other Files & Folders"), which decides if the instruction is coherent.
```

### 8. TASK-039 quarantines `~/Library/LaunchAgents` on the destination but the machine-bound / duplicate-identity agents will already have run once at first login of `tetsuo` (TASK-038→039)
TASK-038 says "Do not log into `tetsuo` yet," and TASK-039 does the quarantine while logged in as `migration-admin` — good. But the quarantine is a **wholesale move of the entire LaunchAgents dir**, including agents that are perfectly safe and desirable (istatmenus, Synology, Box) as well as the dangerous ones. More critically, several of these agents are **device-identity-bound**: `ai.multica.daemon-blazej`/`daemon-claude-02` map to specific devices (m4-01/m4-02/m4-03 in `DAEMON_DEVICE`), and the copied `dev.herdr.collie` server would collide with the source if both run. Blanket quarantine defers the problem but the plan never addresses de-duplicating machine identity before re-enabling.

Falsification test:
```bash
grep -A6 'DAEMON_DEVICE=' ~/.local/bin/multica-ctl   # device-bound identities (verified: m4-01/02/03)
# On destination, re-enabling copied daemons without re-assigning device IDs
# means two hosts claim the same daemon identity.
```

---

## Self-critique: weakest findings and what I missed

**Weakest / most likely wrong:**
- **#6 (FileVault + updates ordering)** is the softest. Modern Migration Assistant and APFS handle concurrent encryption fine, and Apple explicitly supports migrating into a FileVault-enabled Mac. My "different builds" concern is real but mild — MA tolerates minor version skew. I asserted a hazard I did not falsify on real hardware (no M5 here). Downgrade to "verify, probably fine."
- **#7 (VMware/Other Files & Folders)** rests on my memory of Migration Assistant's category UI, which I could not exercise here. Whether the VM bundles fall under "Other Files & Folders" depends entirely on their path, which I didn't actually locate (I only confirmed `vmrun` exists). The contradiction may dissolve once the path is known. I should have run the `mdfind` I proposed.
- **#8** partly overlaps with the plan's own intent (TASK-039–041 do quarantine and TASK-042 validates). The device-identity collision is genuine, but I overstated "the plan never addresses it" — Phase 8+ (not shown) may. I'm critiquing a truncated document.

**Strongest (high confidence, verified on this machine):** #1 (watchdog un-freeze), #3 (two collie agents), #4 (8788 = Homebrew Caddy, KSeF portless + KeepAlive), #5 (pg-backup/reaper still armed). These are concrete file/state facts, not judgment calls.

**What I missed:**
- **The `factory-watchdog` alert path.** I focused on `binary-watchdog` re-animating daemons but didn't fully assess whether `factory-watchdog`'s escalation writes or `multica issue rerun` hints could trigger writes post-quiesce. It's alert-only per its header, so likely benign — but I didn't verify the escalation-notifier is actually inert.
- **TASK-027 vs TASK-025 scope gap.** `factory stop` operates on `$FACTORIES_CONFIG` by default; the `--all-workspaces` sweep is needed to catch unregistered workspaces. TASK-027 says "verify every registered trigger reports disabled" — that word "registered" means unregistered-but-live autopilots are silently out of scope. I noted the flag exists but didn't elevate this to a finding; it's arguably as severe as #1.
- **Time Machine over SMB network destinations (TASK-033).** Both TM destinations are network shares (`smb://…@10.0.1.248`, `.253`). A "final Time Machine backup" over SMB, right after killing VPN/cloud clients and while the Thunderbolt migration is being set up, may be slow or fail if the network path is down. I gathered the evidence (`tmutil destinationinfo`) but didn't turn it into a ranked flaw — the plan assumes a local/fast TM target that doesn't exist here.
- **`--kill-node` blast radius.** `stop --kill-node` does `pkill -9 -x node` system-wide — it would kill KSeF (a node process, PID 38523) and any editor/LSP node processes. If any task reaches for it, it's a footgun. I didn't check whether Phase 5 tasks invoke it.