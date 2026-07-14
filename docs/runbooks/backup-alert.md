# Runbook: Backup Dead-Man's Switch Alert

**Alert:** `BackupStale` (critical)
**Metric:** `openbrain_backup_age_seconds` (pushed to Pushgateway by `pipeline-health` skill every 6h)
**Rule file:** `config/prometheus/alerts/backup.yml`
**Independent Pushover path:** `packages/workers/src/skills/pipeline-health.ts` (`sendBackupStaleAlert`) — fires directly from the app layer, not via Prometheus/Alertmanager (PLT-H2: shared-stack delivery is unproven)

---

## Alert condition

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `BackupStale` | Latest backup manifest older than 26h (93600s), sustained 10+ minutes | critical |

**Why this exists:** all pre-7.4 backup alerting was push-on-failure from `scripts/backup.sh` / `scripts/offsite-backup.sh` / `scripts/restore-rehearsal.sh` themselves. A dead cron, an unreadable `.env.secrets` in cron context (bare cron env — see CLAUDE.md Unraid cron notes), or a wedged host produces **zero signal** in that model (PLT-H4). This is a dead-man's switch instead: it watches for the *absence* of a fresh backup rather than waiting for a script to report failure, so it also catches the case where the cron itself never ran.

**Two independent delivery paths, by design:**
1. Prometheus rule (`config/prometheus/alerts/backup.yml`) — visible in the Prometheus Alerts tab / Grafana, no automatic notification (no Alertmanager configured).
2. `pipeline-health` skill (runs every 6h) stats the manifest itself and fires a **Pushover** alert directly when stale — independent of whether the shared observability stack's alert delivery is working (PLT-H2 flagged this as unverified).

If you only ever see the Prometheus alert and never a Pushover notification for the same staleness, path 2 itself may be broken — check workers logs, not just the backup scripts.

---

## Diagnosis

### 1. Check the backup manifest age directly (homeserver)

```bash
ls -la /mnt/user/backup/openbrain/latest/manifest.json
stat /mnt/user/backup/openbrain/latest/manifest.json
cat /mnt/user/backup/openbrain/latest/manifest.json | python3 -m json.tool
```

If the file is missing entirely, no backup has ever succeeded at that path, or `BACKUP_ROOT` was overridden.

### 2. Check the backup cron log

```bash
tail -100 /var/log/open-brain-backup.log
```

Look for the most recent `=== Open Brain Backup: <timestamp> ===` header and whether it reached the final summary (backup.sh sets `BACKUP_STATUS=success` right before printing it; the EXIT trap fires a priority-1 Pushover **"Open Brain: backup FAILED"** if that line was never reached).

### 3. Check the cron is actually installed and firing

Unraid host crons persist via `/boot/config/plugins/dynamix/custom.cron`, not `crontab -l` (see CLAUDE.md). Verify as root:

```bash
ssh root@homeserver.k4jda.net
cat /etc/cron.d/root | grep backup
```

Cron's environment is bare — if `backup.sh` (or its Pushover notifications) depend on `.env.secrets`, confirm the crontab line sources it (`bash -c 'set -a; . ./.env.secrets; set +a; ...'`). A cron line missing this wrapper can run silently with Pushover alerting itself disabled, which is exactly the blind spot this dead-man's switch exists to catch.

### 4. Check `.env.secrets` is readable in cron context

```bash
ls -la /mnt/user/appdata/open-brain/.env.secrets
# Confirm the file is present, mode 0600, owned by the user cron runs as
```

If `.env.secrets` was regenerated (`scripts/load-secrets.sh`) with different ownership/permissions than the cron user expects, sourcing it can fail silently under `set -e` contexts depending on script structure.

### 5. Check the offsite copy and restore rehearsal (secondary signals)

```bash
tail -50 /var/log/open-brain-offsite-backup.log 2>/dev/null
# restore-rehearsal runs Sunday 05:30 — check its Pushover history / log for the
# most recent pass/fail if you suspect a broader backup-pipeline issue, not just
# a stale 'latest' pointer.
```

### 6. Check the pushed metric directly

```bash
# On homeserver — Prometheus is loopback-bound (ADR-0002), SSH in first
curl -s "http://localhost:9090/api/v1/query?query=openbrain_backup_age_seconds" | python3 -m json.tool

# Or query pushgateway directly for the raw exposition
curl -s http://localhost:9091/metrics | grep openbrain_backup_age_seconds
```

If the metric is **absent entirely** (not just stale), the workers container never successfully stat'd the manifest — most likely the `docker-compose.yml` ro-mount (`/mnt/user/backup/openbrain/latest:/backup-latest:ro`) has not been deployed yet (7.4's compose change is deferred to the batched OA-9 window) or the workers container hasn't been recreated since. Check `docker inspect open-brain-workers --format '{{json .Mounts}}'` for the `/backup-latest` mount.

---

## Mitigation

### Cron is dead or missing

Reinstall per the Unraid persistence pattern in CLAUDE.md (`/boot/config/plugins/dynamix/custom.cron` → `/usr/local/sbin/update_cron`), as root — `claude`'s passwordless sudo does not cover this.

### `.env.secrets` unreadable / stale in cron context

```bash
export BWS_ACCESS_TOKEN=...
bash scripts/load-secrets.sh --target-dir /mnt/user/appdata/open-brain
bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain
```

### backup.sh is failing partway through

Re-run manually to see the failure interactively:

```bash
cd /mnt/user/appdata/open-brain && bash scripts/backup.sh
```

Common causes: Postgres container unhealthy/renamed, disk full on `/mnt/user/backup`, Gitea wiki repo unreachable. The EXIT trap's failure Pushover (if it fires) usually names the exit code — cross-reference against the script's numbered steps in the log.

### Immediate recovery once the underlying cause is fixed

Trigger a manual backup run (command above) — `latest` re-points and `openbrain_backup_age_seconds` resets to ~0 on the next `pipeline-health` run (within 6h, or trigger the skill manually via the dashboard).

### False positive — mount not yet deployed (dev/CI or pre-OA-9 homeserver)

If `openbrain_backup_age_seconds` is simply **absent** (not stale) because the `/backup-latest` ro-mount from 7.4 hasn't been deployed yet, this is expected — `pipeline-health` gracefully skips the check (logs at debug, no throw). No action needed until the compose window (OA-9) is deployed. This is NOT the same as `BackupStale` firing, which requires the metric to exist and exceed the threshold.

---

## Related

- `docs/runbooks/offsite-backup.md` — encrypted offsite copy, rclone crypt remote
- `scripts/backup.sh`, `scripts/offsite-backup.sh`, `scripts/restore-rehearsal.sh`
- `packages/workers/src/skills/pipeline-health.ts` — `checkBackupAge()` / `sendBackupStaleAlert()`
- `docs/runbooks/pipeline-alert.md` — sibling dead-man's-switch-adjacent alert for queue health
