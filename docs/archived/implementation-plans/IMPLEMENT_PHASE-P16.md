# IMPLEMENT_PHASE-P16 — Backup Restore Rehearsal

**Phase:** P16  
**Source card:** PHASED_PLAN.md § P16  
**Effort estimate:** ~1 day  
**Dependencies:** P04b ✅ (secrets redacted from backup payload), P08 ✅ (load-secrets.sh BWS reconciler complete)  
**Status:** Ready — all dependencies merged; P08 unblocks the automation (no live secrets in backup tree).

---

## Scope Diff (Card vs. Current Reality)

| Card assumption | Actual state | Action |
|-----------------|--------------|--------|
| "P04 (.env.secrets redacted)" | P04b ✅ — `scripts/test-backup-secrets-redaction.sh` guards it; backup.sh explicitly skips `.env.secrets` | No change needed |
| "P08 delivered BWS reconciler" | P08 ✅ — `scripts/load-secrets.sh` fully implemented with `--dry-run`, `--verify-hash`, Pushover notify | Reference in runbook |
| Card says "weekly cron entry on homeserver (Sunday 05:00, after memory-consolidation at 04:00)" | Cron slot audit: `0 5 * * 0` is **available** (wiki-lint is `0 5 * * 0` per CLAUDE.md scheduler table). **CONFLICT.** Must stagger — use `30 5 * * 0` (30 min after wiki-lint) | Shift cron to `30 5 * * 0` |
| Card says "pulls latest backup from `/mnt/user/backup/openbrain/`" | `backup.sh` creates `${BACKUP_ROOT}/latest` symlink pointing to most recent daily — use that | Use `${BACKUP_ROOT}/latest` symlink |
| No existing `scripts/restore-rehearsal.sh` | Correct — file does not exist | Create it |
| Runbook directory | `docs/runbooks/` exists with 5 existing runbooks | Create `docs/runbooks/restore-rehearsal.md` following existing format |
| Cron install pattern | `deploy/cron/unraid-ingest.cron` is the established pattern for host cron entries | Create `deploy/cron/unraid-restore-rehearsal.cron` |

**Scope drift severity: LOW.** One cron slot conflict (shift 30 min). No structural change to deliverables.

---

## Work Items

### WI-1: `scripts/restore-rehearsal.sh`

**File:** `scripts/restore-rehearsal.sh` (new)

Script must:
1. Locate the backup: `${BACKUP_ROOT:-/mnt/user/backup/openbrain}/latest` symlink → resolve to an absolute daily dir
2. Verify the dump file exists: `${BACKUP_DIR}/openbrain.pgdump`
3. Read expected row counts from `manifest.json` (`tables` object) — this becomes the validation baseline
4. Spin up an ephemeral Postgres container:
   ```bash
   docker run --rm -d \
     --name open-brain-rehearsal-pg \
     -e POSTGRES_PASSWORD=rehearsal \
     -e POSTGRES_USER=openbrain \
     -e POSTGRES_DB=openbrain \
     pgvector/pgvector:pg16
   ```
   Use `pgvector/pgvector:pg16` to match production — pgvector extension must be present or `pg_restore` will fail on vector columns.
5. Wait for Postgres to be ready (`pg_isready` poll, max 30s)
6. Install pgvector extension: `docker exec ... psql -U openbrain -d openbrain -c "CREATE EXTENSION IF NOT EXISTS vector"`
7. Run `pg_restore` via docker exec into the rehearsal container (copy dump in via `docker cp` then restore inside — avoids needing pg_restore on the Unraid host directly):
   ```bash
   docker cp "${BACKUP_DIR}/openbrain.pgdump" open-brain-rehearsal-pg:/tmp/restore.pgdump
   docker exec open-brain-rehearsal-pg pg_restore \
     -U openbrain -d openbrain \
     --no-owner --no-privileges \
     --exit-on-error \
     /tmp/restore.pgdump
   ```
8. Validate row counts — for each table in `manifest.json`, query actual count and compare against manifest value with ±10% tolerance (to account for the backup being from yesterday). Hard-fail if any table is at 0 rows when manifest says > 0 (catastrophic blank restore).
9. Tear down: `docker stop open-brain-rehearsal-pg` (--rm handles cleanup)
10. Emit structured summary + exit code (0 = pass, 1 = fail)
11. Send Pushover notification either way (pass = priority 0 / normal, fail = priority 1 / high):
    - Source `scripts/lib/pushover-notify.sh` — already has `notify_pushover_mismatch`; add a second function `notify_pushover_rehearsal_result` or re-use with a message parameter
    - Credentials from env: `PUSHOVER_APP_TOKEN` + `PUSHOVER_USER_KEY` (same as backup.sh env context)

**Env overrides (test-harness friendly, same pattern as backup.sh):**
- `BACKUP_ROOT` — default `/mnt/user/backup/openbrain`
- `REHEARSAL_CONTAINER` — default `open-brain-rehearsal-pg`
- `PUSHOVER_API_URL` — default `https://api.pushover.net/1/messages.json` (mock-able for tests)
- `ROW_COUNT_TOLERANCE` — default `0.10` (10%)

**Exit codes:**
- `0` — restore successful, all row counts within tolerance
- `1` — restore failed (pg_restore error OR row count validation failed)
- `2` — precondition failure (no backup found, manifest missing, container couldn't start)

**Memory ceiling:** Script is pure bash + docker exec. No Node process. Compliant with 1.5 GB rule.

---

### WI-2: `scripts/lib/pushover-notify.sh` — add rehearsal notification function

**File:** `scripts/lib/pushover-notify.sh` (edit)

Add `notify_pushover_rehearsal` function below the existing `notify_pushover_mismatch`:

```bash
# notify_pushover_rehearsal <status> <summary_message>
#   status: "pass" (priority 0) or "fail" (priority 1)
#   Sends a Pushover notification for restore rehearsal results.
notify_pushover_rehearsal() {
  local status="$1"
  local message="${2:-Open Brain: restore rehearsal ${status}}"
  local title="Open Brain: DR rehearsal ${status}"
  local priority=0
  [[ "$status" == "fail" ]] && priority=1
  local url="${PUSHOVER_API_URL:-https://api.pushover.net/1/messages.json}"
  local token="${PUSHOVER_APP_TOKEN:-${PUSHOVER_TOKEN:-}}"
  local user="${PUSHOVER_USER_KEY:-${PUSHOVER_USER:-}}"
  if [[ -z "$token" || -z "$user" ]]; then
    echo "WARN: Pushover credentials missing — rehearsal alert skipped" >&2
    return 0
  fi
  curl -sf --max-time 10 -X POST "$url" \
    -d "token=${token}" \
    -d "user=${user}" \
    -d "title=${title}" \
    -d "message=${message}" \
    -d "priority=${priority}" >/dev/null 2>&1 || \
    echo "WARN: Pushover POST failed (curl exit $?)" >&2
  return 0
}
```

---

### WI-3: `deploy/cron/unraid-restore-rehearsal.cron`

**File:** `deploy/cron/unraid-restore-rehearsal.cron` (new)

Following the exact format of `deploy/cron/unraid-ingest.cron`:

```
# Open Brain — Restore rehearsal cron entry (Unraid host)
#
# INSTALL (post-merge, once):
#   1. SSH to homeserver as `claude` (has passwordless sudo for cron operations).
#   2. Append this line to the Unraid system crontab:
#        sudo tee -a /boot/config/plugins/dynamix/custom.cron \
#          < deploy/cron/unraid-restore-rehearsal.cron
#   3. Reload cron:
#        sudo /usr/local/sbin/update_cron
#   4. Verify:
#        crontab -l | grep restore-rehearsal
#
# SCHEDULE: Sunday 05:30 — after wiki-lint (0 5 * * 0) and before the
#   production week starts. Staggered per P16 cron-slot audit: 0 5 * * 0
#   is taken by wiki-lint; 30 5 * * 0 is the next available Sunday slot.
#
# ROLLBACK:
#   Remove this line from /boot/config/plugins/dynamix/custom.cron and
#   run update_cron again. Script can remain in repo — it makes no writes
#   unless explicitly invoked.
#
# LOGS: /var/log/open-brain-restore-rehearsal.log
#   Rotate manually with: sudo : > /var/log/open-brain-restore-rehearsal.log

30 5 * * 0 cd /mnt/user/appdata/open-brain && bash scripts/restore-rehearsal.sh >> /var/log/open-brain-restore-rehearsal.log 2>&1
```

---

### WI-4: `docs/runbooks/restore-rehearsal.md`

**File:** `docs/runbooks/restore-rehearsal.md` (new)

Content structure (following `docs/runbooks/capture-flow-alert.md` format):

```markdown
# Runbook: DR Restore Rehearsal Failure

**Alert:** Pushover notification from `restore-rehearsal.sh`
**Schedule:** Sunday 05:30 (Unraid host cron)
**Script:** `scripts/restore-rehearsal.sh`
**Log:** `/var/log/open-brain-restore-rehearsal.log` on homeserver

---

## What the rehearsal does

1. Locates the most recent daily backup (`/mnt/user/backup/openbrain/latest` symlink)
2. Reads expected row counts from `manifest.json`
3. Spins up an ephemeral `pgvector/pgvector:pg16` container
4. Runs `pg_restore` against the dump
5. Validates actual row counts vs. manifest values (±10% tolerance)
6. Tears down the ephemeral container
7. Sends Pushover notification (pass or fail)

---

## Alert conditions

| Exit code | Meaning |
|-----------|---------|
| 0 | Restore successful, row counts within tolerance |
| 1 | Restore failed — pg_restore error OR row count mismatch |
| 2 | Precondition failure — no backup found, manifest missing, container failed to start |

---

## Diagnosis

### Check the log first
[commands to read the rehearsal log, inspect manifest.json, etc.]

### Restore failure (exit 1)
- pg_restore error → check for schema drift (new migration not in dump; run from earlier dump)
- Row count zero when manifest says >N → blank restore; pg_restore may have silently exited 0 despite errors; re-run with `-v` flag

### Precondition failure (exit 2)
- No backup file → backup.sh cron may have failed; check `/tmp/open-brain-backup.log`
- Container start failure → Docker daemon issue on homeserver

---

## Manual restore (actual DR)

[Step-by-step commands for a real disaster recovery scenario using the backup + load-secrets.sh]

---

## Testing the failure path manually
[Instructions for corrupting a backup to verify the alert fires]
```

---

### WI-5: `scripts/test-restore-rehearsal.sh` — regression test

**File:** `scripts/test-restore-rehearsal.sh` (new)

Similar structure to `scripts/test-backup-secrets-redaction.sh`: uses env overrides to test without real Docker.

Test coverage:
1. **Happy path** (mock mode): supply a fake manifest.json + a path to a known-good dump; verify exit 0 and that the Pushover mock received a "pass" call
2. **Missing backup** (BACKUP_ROOT points to empty dir): verify exit 2
3. **Missing manifest.json**: verify exit 2
4. **Corrupted dump** (truncated file): verify exit 1 and Pushover mock received "fail"
5. **Row count tolerance check**: create manifest with table X = 100 rows; restore produces 95 (within 10%) → pass; 80 (outside) → fail

**Note:** Tests that actually spin Docker containers (WI-1 step 3-9) are exercised manually per the acceptance criteria. This test script covers the bash logic and Pushover notification path using `PUSHOVER_API_URL` mock override + a local `nc` listener or Python http.server.

---

## Acceptance Criteria (from card + cron slot drift fix)

| # | Criterion | How to verify |
|---|-----------|---------------|
| AC-1 | Rehearsal script passes manually against a real backup on homeserver | `bash scripts/restore-rehearsal.sh` exits 0; Pushover "pass" notification received |
| AC-2 | Cron job installed on homeserver (Sunday 05:30, not 05:00 — stagger fix) | `crontab -l \| grep restore-rehearsal` shows `30 5 * * 0` line |
| AC-3 | Pushover notification delivered on pass | AC-1 verification includes checking phone |
| AC-4 | Failure test: intentionally corrupt a backup, verify rehearsal exits 1 + Pushover "fail" fires | `truncate -s 1k /mnt/user/backup/openbrain/latest/openbrain.pgdump && bash scripts/restore-rehearsal.sh`; script exits 1, restore phone notification = "fail" |
| AC-5 | `scripts/test-restore-rehearsal.sh` passes locally | `bash scripts/test-restore-rehearsal.sh` exits 0 |
| AC-6 | Runbook exists and covers manual DR steps | `docs/runbooks/restore-rehearsal.md` present; operator reviews |
| AC-7 | No two cron jobs on same minute (P07 rule) | `grep '5 \* \* 0\|30 5 \* \* 0' deploy/cron/*.cron` — no collisions |

---

## Rollback Plan

Per card: remove cron entry from homeserver; script remains in repo.

```bash
# On homeserver
sudo sed -i '/restore-rehearsal/d' /boot/config/plugins/dynamix/custom.cron
sudo /usr/local/sbin/update_cron
# Verify
crontab -l | grep restore-rehearsal  # should return nothing
```

The ephemeral rehearsal container (`open-brain-rehearsal-pg`) is `--rm` — no persistent state to clean up.

---

## Dependencies on Prior Work

| Dependency | PR | Relevance |
|------------|-----|-----------|
| P04b — secrets redacted from backup | #129 | `backup.sh` excludes `.env.secrets`; rehearsal script can run against backup tree safely |
| P08 — load-secrets.sh BWS reconciler | #134 | Runbook references `load-secrets.sh` as the restore step for secrets; complete implementation means runbook instructions are accurate |
| `scripts/lib/pushover-notify.sh` | Phase 3/P03 era | Library already exists; WI-2 extends it |
| `deploy/cron/unraid-ingest.cron` | Phase 4 | Pattern reference for WI-3 |

---

## Files Touched

| File | Action |
|------|--------|
| `scripts/restore-rehearsal.sh` | **CREATE** |
| `scripts/lib/pushover-notify.sh` | **EDIT** — add `notify_pushover_rehearsal` function |
| `deploy/cron/unraid-restore-rehearsal.cron` | **CREATE** |
| `docs/runbooks/restore-rehearsal.md` | **CREATE** |
| `scripts/test-restore-rehearsal.sh` | **CREATE** |

No application code changes. No Drizzle migrations. No `package.json` changes. No CI changes (test script is bash, not vitest).

---

## Effort Breakdown

| Item | Estimate |
|------|----------|
| WI-1: restore-rehearsal.sh | 3–4 h |
| WI-2: pushover-notify.sh extension | 30 min |
| WI-3: cron file | 30 min |
| WI-4: runbook | 1 h |
| WI-5: test script | 1–1.5 h |
| Manual homeserver validation (AC-1 through AC-4) | 1 h |
| **Total** | **~7–8.5 h (~1 day)** |

Estimate matches card. No scope expansion.

---

## Notes for Implementer

- **`pgvector/pgvector:pg16` is mandatory** — using `postgres:16` will fail on vector column restore because the pgvector extension won't be present.
- **`pg_restore --exit-on-error`** is the right flag to surface silent schema errors. Without it, `pg_restore` can exit 0 even when it drops objects due to permission errors.
- **Row count tolerance** must be ±10%, not exact match. The backup was taken at 03:00; by 05:30 Sunday there can be new captures from voice/Slack. Exact match would produce false failures.
- **`docker cp` + `docker exec` pg_restore** is cleaner than mounting the host backup volume into the rehearsal container — it avoids bind-mount permission issues on Unraid.
- **Cron slot confirmed:** `30 5 * * 0` is clear in the P07 slot registry. The card's `0 5 * * 0` would collide with wiki-lint. Do NOT use `0 5 * * 0`.
- **Test script should NOT require actual Docker** — mock the container operations via `REHEARSAL_DRY_RUN=true` env var that short-circuits the docker run/exec/stop calls with a synthetic success result. This lets the bash logic + Pushover path be exercised in CI if desired.
