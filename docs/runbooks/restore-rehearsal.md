# Runbook: DR Restore Rehearsal Failure

**Alert:** Pushover notification from `restore-rehearsal.sh` with title "Open Brain: DR rehearsal fail"
**Schedule:** Sunday 05:30 (Unraid host cron — `30 5 * * 0`)
**Script:** `scripts/restore-rehearsal.sh`
**Log:** `/var/log/open-brain-restore-rehearsal.log` on homeserver
**Cron file:** `deploy/cron/unraid-restore-rehearsal.cron`

---

## What the rehearsal does

1. Locates the most recent daily backup via `${BACKUP_ROOT}/latest` symlink (default: `/mnt/user/backup/openbrain/latest`)
2. Reads `manifest.json` and **fails (exit 1) when `manifest.timestamp` or the dump's modification time is older than `REHEARSAL_MAX_AGE_HOURS` (default 36)**: a rehearsal of a stale dump proves nothing
3. Spins up an ephemeral `pgvector/pgvector:pg16` container (`open-brain-rehearsal-pg`) running the production `config/postgres/postgresql.conf` and Docker's default 64 MB `/dev/shm`
4. Restores through `restore_into` (`scripts/lib/restore-core.sh`, the same function a real recovery uses): TCP readiness (`pg_isready -h 127.0.0.1`), empty-database check, `pg_restore --exit-on-error` with `max_parallel_maintenance_workers=0`
5. Asserts, and fails on any miss:
   - row counts: each table within the larger of 1% or 20 rows of the manifest (`ROW_COUNT_TOLERANCE`, `ROW_COUNT_MIN_ABS`); tables with 0 rows are counted too; a failed count query is a failure
   - object counts (indexes, foreign keys, triggers, public functions) equal the manifest key `objects`, counted by `scripts/lib/db-objects.sh`; an older manifest without `objects` logs a warning and skips only these
   - `max(schema_migrations.version)` equals the manifest's `objects.ledger_max`
   - no row of `pg_index` has `indisvalid = false`
   - every name in `scripts/lib/dr-required-objects.txt` exists (the HNSW and tsvector indexes, `hybrid_search`, `spreading_activation`, `fts_only_search`, `vector_search`)
6. Tears down the ephemeral container
7. On PASS writes the time to `${BACKUP_ROOT}/.rehearsal-last-success` and logs `indexes N/N fk N/N triggers N/N functions N/N ledger <version>` (restored/manifest)
8. Sends Pushover notification: pass = priority 0 (normal), fail = priority 1 (high)

A pass notification every Sunday is the expected steady state. A fail notification requires immediate investigation — it means last Sunday's backup could not be restored cleanly.

---

## Alert conditions

| Exit code | Meaning | Pushover priority |
|-----------|---------|-------------------|
| 0 | Restore successful; every row-count, object, ledger, and required-object assertion held | 0 — normal |
| 1 | Stale backup (older than 36 h), `pg_restore` error, or a failed assertion (rows, objects, ledger, invalid index, required object) | 1 — high |
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
=== REHEARSAL RESULT: FAIL (exit 1) ===   # stale backup, restore error, or a failed assertion
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

#### Exit 1 — stale backup

The log says `STALE BACKUP`. `backup.sh` did not produce a new dump in the last 36 hours (check its cron line in `/boot/config/plugins/dynamix/custom.cron` and `tail -100 /tmp/open-brain-backup.log`). Fix the backup first; rerunning the rehearsal does not help.

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

#### Exit 1 — object, ledger, or required-object failure

The lines `FAIL  indexes|fk|triggers|functions|ledger|required object …` name the assertion. A restored count lower than the manifest, or a missing required object, means the restore dropped objects: run the restore by hand (below) and read the `pg_restore` output. A ledger mismatch means the dump and the manifest were taken at different times or the ledger table did not restore.

#### Exit 1 — Row count mismatch

```bash
grep -E "FAIL  |PASS  " /var/log/open-brain-restore-rehearsal.log | tail -30
```

- **All tables show `actual=0` when `manifest > 0`**: blank restore. `pg_restore` silently completed without writing data. Likely cause: `--exit-on-error` was bypassed or schema errors caused the data section to be skipped. Re-run the restore by hand into a debug container; `scripts/restore.sh` prints the first lines of any `pg_restore` error:
  ```bash
  # Debug container; scripts/restore.sh restores through restore_into (scripts/lib/restore-core.sh)
  docker run --rm -d --name ob-rehearsal-debug \
    -e POSTGRES_PASSWORD=rehearsal \
    -e POSTGRES_USER=openbrain \
    -e POSTGRES_DB=openbrain \
    pgvector/pgvector:pg16

  bash scripts/restore.sh --backup-dir /mnt/user/backup/openbrain/latest --target ob-rehearsal-debug
  docker stop ob-rehearsal-debug
  ```

- **Single table out of tolerance** (more than max(1%, 20 rows) from the manifest): `backup.sh` counts rows after the dump snapshot, so a busy table can drift a little (captures, skills_log, ai_audit_log grow between 03:00 backup and 05:30 check). If the actual count significantly exceeds manifest — this is the expected direction (new data written after backup). If actual is dramatically *lower*, the restore may have partially failed. Check pg_restore output for errors on that table.

---

## Manual restore (actual DR)

Use this procedure only in a real disaster recovery, not for rehearsal diagnostics.

**Targets:** RPO 24 hours (the nightly 03:00 dump; anything written after it is lost).
RTO one working day, from a bare Unraid host with Docker to a serving stack.

**What you need:** a host with Docker and the Unraid `br0` network; the backup directory
(local `/mnt/user/backup/openbrain/latest/`, or pulled from the offsite remote with
`docs/runbooks/offsite-backup.md` "Restore procedure", steps 1–2); the Bitwarden access
token; the commit that was deployed (the backup's `DEPLOYED.json`; when the file is absent,
the `HEAD:` line of the backup's `host-tree.txt`). Never use the newest `main` instead:
it can carry migrations that were merged but never deployed.

**Model:** the dump is a complete snapshot, the `schema_migrations` ledger included. It
restores into an EMPTY database. Never apply a schema file or migrations before it:
`scripts/restore.sh` refuses a database that already holds a table. The restore runs with
`max_parallel_maintenance_workers=0`, so every index and constraint is rebuilt whatever the
`/dev/shm` size of the container.

Each step is one command. Run them in order, as root, from the app directory.

1. Open a root shell on the host: `ssh root@homeserver.k4jda.net`
2. Get the tree (skip when it exists): `git clone https://github.com/davistroy/open-brain.git /mnt/user/appdata/open-brain`
3. `cd /mnt/user/appdata/open-brain`
4. Name the backup for the following steps: `B=/mnt/user/backup/openbrain/latest`
5. Check out the deployed commit BEFORE anything else reads the tree (step 14 applies the
   migrations of this tree and refuses any other commit):
   `S=$(jq -r .commit "$B/DEPLOYED.json") && git -c safe.directory="$PWD" checkout --detach "$S"`.
   Without `DEPLOYED.json`: `S=$(sed -n 's/^HEAD: //p' "$B/host-tree.txt")`, check it out the
   same way, and pass `--allow-ref "$S"` to step 14. Steps 18–19 deploy the same `$S`.
6. Rebuild `.env.secrets` from Bitwarden (`bws` is installed on the host by item 7.4):
   `export BWS_ACCESS_TOKEN=<token>`, then
   `bash scripts/load-secrets.sh --target-dir /mnt/user/appdata/open-brain`, then
   `bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain --quiet`.
   The load writes the exported token into the new file as its one `BWS_ACCESS_TOKEN=` line
   (the sidecars need it); `--no-persist-bootstrap` leaves it out. The token never prints.
   If `bws` is missing on the host, run the same load on a machine that has `bws` with a
   scratch `--target-dir`, then copy the file over with
   `scp <dir>/.env.secrets root@homeserver.k4jda.net:/mnt/user/appdata/open-brain/`.
7. Restore `.env` (holds `TAILSCALE_IP`, which compose requires): `install -m 600 "$B/config/dot-env" .env`
8. Restore the gitignored payee rules: `cp -a "$B/config/payee-rules.yaml" config/`
9. Restore the gitignored utility config: `cp -a "$B/config/utility/utility-config.yaml" config/utility/`
10. Create EMPTY data directories (the binds use `create_host_path: false`; move a damaged
    old `pgdata` aside first): `mkdir pgdata redis-data`
11. Confirm the data stores render as binds (prints `true`; nothing is written to a file):
    `docker compose config --format json | jq -e '[.services.postgres.volumes[], .services.redis.volumes[]] | all(.type == "bind" and .bind.create_host_path == false) and any(.target == "/var/lib/postgresql/data" and .source == "/mnt/user/appdata/open-brain/pgdata")'`.
    Do not restore `docker-compose.override.yml` from the backup: the base compose binds
    the data directories itself, and an override entry with short syntax turns
    `create_host_path` back on (this check then prints `false`).
12. List missing prerequisites (Loki plugin, `observability`/`br0` networks, bind sources): `bash scripts/preflight.sh`.
    Fix every `MISSING` line and run it again until it exits 0.
13. Start Postgres alone, with no `-f` flag: `docker compose up -d postgres`
14. Restore the dump and apply any migration newer than it (refuses unless the tree is at
    `DEPLOYED.json`'s commit, or at `--allow-ref`; refuses a `POSTGRES_URL` whose host is not
    `postgres`/`open-brain-postgres`; waits for Postgres over TCP; refuses a non-empty
    database; prints table/index/constraint counts). Every refusal happens before the restore:
    `bash scripts/restore.sh --backup-dir "$B" --apply-pending`
15. Read the host files of the backup: `cp "$B/custom.cron" /tmp/custom.cron.backup` (compare
    with step 17; do not paste it over a newer table), `cat "$B/host-tree.txt"` (the commit and
    local changes to reproduce), `cat "$B/DEPLOYED.json"` (the commit of steps 5 and 18). The
    backup also holds `redis.rdb` and `sidecars/` (`financial.db`, `utility.db`,
    `actual-state.tar`, `voice-spool.tar`; restored in step 20). A file missing from
    `sidecars/` means that step warned in the backup log; that sidecar starts with empty state.
16. Start Redis: `docker compose up -d redis`
17. Install the host crons: `bash scripts/install-crons.sh` (item 7.3). Until then: append
    each line of `deploy/cron/*.cron` to `/boot/config/plugins/dynamix/custom.cron`, run
    `/usr/local/sbin/update_cron`, and check that `grep -c open-brain /etc/cron.d/root`
    equals the count in `CLAUDE.md`. Never use `crontab -e`.
18. Deploy the application services, dry run first: `bash scripts/deploy.sh "$S" --dry-run core-api workers slack-bot voice-capture web-next file-ingestion financial-ingest utility-ingest actual-ingest`
19. Deploy them: `bash scripts/deploy.sh "$S" core-api workers slack-bot voice-capture web-next file-ingestion financial-ingest utility-ingest actual-ingest`
20. Restore the sidecar state into the volumes the deploy just created, right away (before
    the next ingest cron run). `docker cp` writes into the compose-created volume of the
    running container, so no volume name is guessed; the sidecars are idle between cron runs.
    Each `.tar` holds the container's own basenames (`state.json`, `voice-spool/…`), so
    `docker cp -` extracts it into `/data` at the path the sidecar reads.
    - SQLite: `for n in financial utility; do docker exec open-brain-$n-ingest rm -f /data/$n.db-wal /data/$n.db-shm && docker cp "$B/sidecars/$n.db" open-brain-$n-ingest:/data/$n.db; done`
    - Check one snapshot inside its sidecar (the host has no `python3`; prints `('ok',)`):
      `docker exec open-brain-utility-ingest python -c "import sqlite3;print(sqlite3.connect('/data/utility.db').execute('pragma integrity_check').fetchone())"`
    - Actual state (lands at `/data/state.json`): `docker cp - open-brain-actual-ingest:/data < "$B/sidecars/actual-state.tar"`
    - Voice spool (lands in `/data/voice-spool/`; voice-capture runs as `node`, and copied files
      arrive owned by root): `docker cp - open-brain-voice-capture:/data < "$B/sidecars/voice-spool.tar" && docker exec -u 0 open-brain-voice-capture chown -R node:node /data/voice-spool`
21. Start the tunnel: `docker compose up -d cloudflared`
22. Start transcription: `docker compose up -d faster-whisper`
23. Check secrets against Bitwarden: `bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain` (needs `bws`; item 7.4)
24. Check the API answers through the tunnel: `curl -s https://brain.troy-davis.com/api/v1/captures?limit=1`

Never run a bare `up` with no service name, `--remove-orphans`, or `compose down`
(`docs/runbooks/deploy.md`, safety rules).

### After restore

- Compare the table/index/constraint counts that step 14 printed with the manifest (the
  manifest holds them under `objects`).
- `docker compose ps`: every container healthy within a few minutes.
- Send a test capture via voice or Slack to verify the pipeline end to end.
- Update `LAB_NOTEBOOK.md` with the restore event and any issue met.

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
- `scripts/restore.sh` + `scripts/lib/restore-core.sh` — the restore used by a real recovery (`restore_into`)
- `scripts/load-secrets.sh` — restores secrets from Bitwarden after a real DR event
- `scripts/verify-secrets.sh` — audits secrets after load-secrets.sh runs
- `docs/runbooks/pipeline-alert.md` — if restore succeeds but pipeline is stuck post-DR
- `LAB_NOTEBOOK.md` Entry 114 — P16 design decisions and architecture notes
