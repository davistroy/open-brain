# Runbook: DR Restore Rehearsal Failure

**Alert:** Pushover notification from `restore-rehearsal.sh` with title "Open Brain: DR rehearsal fail"
**Schedule:** Sunday 05:30 (Unraid host cron — `30 5 * * 0`)
**Script:** `scripts/restore-rehearsal.sh`
**Log:** `/var/log/open-brain-restore-rehearsal.log` on homeserver
**Cron file:** `deploy/cron/unraid-restore-rehearsal.cron`

---

## What the rehearsal does

1. Locates the most recent daily backup via `${BACKUP_ROOT}/latest` symlink (default: `/mnt/user/backup/openbrain/latest`)
2. Reads expected row counts from `manifest.json` in the backup directory
3. Spins up an ephemeral `pgvector/pgvector:pg16` container (`open-brain-rehearsal-pg`)
4. Copies the dump file into the container and runs `pg_restore --exit-on-error`
5. Validates actual row counts vs. manifest values (±10% tolerance; 0-row manifest entries skipped)
6. Tears down the ephemeral container (`--rm` flag — no persistent state)
7. Sends Pushover notification: pass = priority 0 (normal), fail = priority 1 (high)

A pass notification every Sunday is the expected steady state. A fail notification requires immediate investigation — it means last Sunday's backup could not be restored cleanly.

---

## Alert conditions

| Exit code | Meaning | Pushover priority |
|-----------|---------|-------------------|
| 0 | Restore successful, all row counts within ±10% | 0 — normal |
| 1 | Restore failed — `pg_restore` error OR row count mismatch | 1 — high |
| 2 | Precondition failure — no backup found, manifest missing, container failed to start | 1 — high |

---

## Diagnosis

### 1. Check the log

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
tail -100 /var/log/open-brain-restore-rehearsal.log
```

The log output is structured — look for the `REHEARSAL RESULT: FAIL` line and the lines preceding it for the root cause.

### 2. Identify the exit code

```
=== REHEARSAL RESULT: FAIL (exit 1) ===   # pg_restore error or row count mismatch
=== REHEARSAL RESULT: FAIL (exit 2) ===   # precondition failure
```

### 3. Diagnose by exit code

#### Exit 2 — Precondition failure

**No backup file (`manifest.json` or `openbrain.pgdump` missing):**

```bash
ls -la /mnt/user/backup/openbrain/latest/
```

If the directory is empty or the symlink is broken, `backup.sh` did not complete successfully on the prior run. Check:

```bash
tail -100 /tmp/open-brain-backup.log
```

Common causes: Postgres container was down during backup window (03:00 Sunday), disk full, Docker daemon restart mid-backup.

**Container start failure:**

```bash
docker ps -a | grep rehearsal
docker logs open-brain-rehearsal-pg 2>/dev/null || true
```

Docker daemon may have been busy or the `pgvector/pgvector:pg16` image is not pulled:

```bash
docker pull pgvector/pgvector:pg16
```

#### Exit 1 — pg_restore error

```bash
grep -A 20 "pg_restore output" /var/log/open-brain-restore-rehearsal.log
```

Common causes:
- **Schema drift**: a new migration was applied after the backup was taken. The dump may not include the new table/column. This is expected if a migration landed between 03:00 (backup) and 05:30 (rehearsal). Verify by checking recent migrations:
  ```bash
  cd /mnt/user/appdata/open-brain && git log --oneline -10
  ```
- **Corrupted dump**: disk failure during backup. Verify dump integrity:
  ```bash
  file /mnt/user/backup/openbrain/latest/openbrain.pgdump
  # Should output: PostgreSQL custom database dump
  ```
- **Permission errors**: `pg_restore` exited non-zero on `--no-owner --no-privileges` mismatch. Re-run with verbose to diagnose:
  ```bash
  REHEARSAL_DRY_RUN=false bash scripts/restore-rehearsal.sh  # then inspect log
  ```

#### Exit 1 — Row count mismatch

```bash
grep -E "FAIL  |PASS  " /var/log/open-brain-restore-rehearsal.log | tail -30
```

- **All tables show `actual=0` when `manifest > 0`**: blank restore. `pg_restore` silently completed without writing data. Likely cause: `--exit-on-error` was bypassed or schema errors caused the data section to be skipped. Re-run manually with `-v` (verbose):
  ```bash
  # Spin up container manually for investigation
  docker run --rm -d --name ob-rehearsal-debug \
    -e POSTGRES_PASSWORD=rehearsal \
    -e POSTGRES_USER=openbrain \
    -e POSTGRES_DB=openbrain \
    pgvector/pgvector:pg16

  docker exec ob-rehearsal-debug psql -U openbrain -d openbrain -c "CREATE EXTENSION IF NOT EXISTS vector;"
  docker cp /mnt/user/backup/openbrain/latest/openbrain.pgdump ob-rehearsal-debug:/tmp/restore.pgdump
  docker exec ob-rehearsal-debug pg_restore -U openbrain -d openbrain \
    --no-owner --no-privileges --exit-on-error -v /tmp/restore.pgdump 2>&1 | tail -50
  docker stop ob-rehearsal-debug
  ```

- **Single table out of tolerance**: normal churn (captures, skills_log, ai_audit_log grow between 03:00 backup and 05:30 check). If the actual count significantly exceeds manifest — this is the expected direction (new data written after backup). If actual is dramatically *lower*, the restore may have partially failed. Check pg_restore output for errors on that table.

---

## Manual restore (actual DR)

Use this procedure only in a real disaster recovery scenario — not for rehearsal diagnostics.

### Prerequisites

1. Fresh homeserver or repaired Postgres volume
2. Latest backup directory: `/mnt/user/backup/openbrain/latest/`
3. Bitwarden Secrets Manager accessible (`BWS_ACCESS_TOKEN` env var set)

### Steps

```bash
# 1. SSH to homeserver
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net

# 2. Navigate to app directory
cd /mnt/user/appdata/open-brain

# 3. Bring up only Postgres (do not start the full stack yet)
docker compose up -d postgres
# Wait for healthy:
docker ps | grep postgres

# 4. Apply schema from the backup (init-schema + all Drizzle migrations)
#    The pg_restore will create tables, but you need the schema first if starting fresh.
#    The backup includes schema.sql for reference:
#    cat /mnt/user/backup/openbrain/latest/schema.sql | head -20
#
#    Apply the canonical migration sequence (not schema.sql — it's for reference only):
docker exec -i open-brain-postgres psql -U openbrain -d openbrain < scripts/init-schema.sql
for f in packages/shared/drizzle/0*.sql; do
  echo "Applying $f..."
  docker exec -i open-brain-postgres psql -U openbrain -d openbrain < "$f"
done

# 5. Restore from pg_dump
docker cp /mnt/user/backup/openbrain/latest/openbrain.pgdump open-brain-postgres:/tmp/restore.pgdump
docker exec open-brain-postgres pg_restore \
  -U openbrain -d openbrain \
  --no-owner --no-privileges \
  --exit-on-error \
  /tmp/restore.pgdump

# 6. Verify row counts
docker exec open-brain-postgres psql -U openbrain -d openbrain -c \
  "SELECT relname, n_live_tup FROM pg_stat_user_tables ORDER BY relname;"

# 7. Restore secrets from Bitwarden
export BWS_ACCESS_TOKEN="<your-token>"
bash scripts/load-secrets.sh --force

# 8. Verify secrets loaded
bash scripts/verify-secrets.sh

# 9. Bring up the full stack
docker compose up -d

# 10. Verify health
curl -s http://localhost:3002/api/v1/captures?limit=1
```

### After restore

- Run `bash scripts/verify-secrets.sh` to confirm all required secrets are present.
- Check `docker compose ps` — all containers should be healthy within 60s.
- Send a test capture via voice or Slack to verify end-to-end pipeline is functional.
- Update `LAB_NOTEBOOK.md` with the restore event and any issues encountered.

---

## Testing the failure path manually (AC-4)

To verify the alert fires correctly without waiting for a real failure:

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# Corrupt a copy of the dump (never corrupt the real backup)
cp /mnt/user/backup/openbrain/latest/openbrain.pgdump /tmp/corrupt-test.pgdump
truncate -s 1k /tmp/corrupt-test.pgdump

# Create a temp backup dir pointing to the corrupted dump
mkdir -p /tmp/ob-rehearsal-test
cp /mnt/user/backup/openbrain/latest/manifest.json /tmp/ob-rehearsal-test/
cp /tmp/corrupt-test.pgdump /tmp/ob-rehearsal-test/openbrain.pgdump
ln -sfn /tmp/ob-rehearsal-test /tmp/ob-rehearsal-latest

# Run rehearsal against the corrupted backup
BACKUP_ROOT=/tmp REHEARSAL_CONTAINER=ob-rehearsal-fail-test \
  bash scripts/restore-rehearsal.sh

# Expected: exit 1, Pushover "fail" notification received
# Clean up
rm -rf /tmp/ob-rehearsal-test /tmp/ob-rehearsal-latest /tmp/corrupt-test.pgdump
```

---

## Related

- `scripts/backup.sh` — creates the backup this rehearsal validates
- `scripts/load-secrets.sh` — restores secrets from Bitwarden after a real DR event
- `scripts/verify-secrets.sh` — audits secrets after load-secrets.sh runs
- `docs/runbooks/pipeline-alert.md` — if restore succeeds but pipeline is stuck post-DR
- `LAB_NOTEBOOK.md` Entry 114 — P16 design decisions and architecture notes
