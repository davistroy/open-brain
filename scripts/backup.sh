#!/bin/bash
# Open Brain Daily Backup
# Backs up Postgres database + config files + wiki repo + Redis RDB snapshot
# + sidecar state (SQLite snapshots, actual-ingest state, voice spool) + host files
# (custom.cron, host-tree.txt, DEPLOYED.json) to /mnt/user/backup/openbrain/
# Retention: 14 daily + 4 weekly (Sundays) + 3 monthly (1st of month)
#
# Usage: bash /mnt/user/appdata/open-brain/scripts/backup.sh
# Cron:  0 3 * * * cd /mnt/user/appdata/open-brain && bash scripts/backup.sh >> /var/log/open-brain-backup.log 2>&1
# Log:   /var/log/open-brain-backup.log
# Notifications: Pushover on success (priority 0) and failure (priority 1)

set -euo pipefail

# --- Configuration ---
BACKUP_ROOT="${BACKUP_ROOT:-/mnt/user/backup/openbrain}"
APP_DIR="${APP_DIR:-/mnt/user/appdata/open-brain}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pushover-notify.sh
source "${SCRIPT_DIR}/lib/pushover-notify.sh"
# shellcheck source=lib/db-objects.sh
source "${SCRIPT_DIR}/lib/db-objects.sh"
DB_CONTAINER="open-brain-postgres"
REDIS_CONTAINER="open-brain-redis"
DB_USER="openbrain"
DB_NAME="openbrain"
CUSTOM_CRON_SRC="${CUSTOM_CRON_SRC:-/boot/config/plugins/dynamix/custom.cron}"
WIKI_REPO_URL="${WIKI_REPO_URL:-http://Gitea:3000/davistroy/open-brain-wiki.git}"
DAILY_RETENTION=14
WEEKLY_RETENTION=4    # Sundays
MONTHLY_RETENTION=3   # 1st of month

# --- Setup ---
DATE=$(date +%Y-%m-%d)
TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)
DAY_OF_WEEK=$(date +%u)  # 1=Mon, 7=Sun
DAY_OF_MONTH=$(date +%d)

DAILY_DIR="${BACKUP_ROOT}/daily"
WEEKLY_DIR="${BACKUP_ROOT}/weekly"
MONTHLY_DIR="${BACKUP_ROOT}/monthly"
LATEST_LINK="${BACKUP_ROOT}/latest"

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR" "$MONTHLY_DIR"

BACKUP_FILE="${DAILY_DIR}/${DATE}"
mkdir -p "$BACKUP_FILE"

# --- Notification trap (PLT-M5) ---
# BACKUP_STATUS starts "failed"; set to "success" just before the summary.
# On any exit (including set -e early exits), the trap fires; if status is
# still "failed" it sends a priority-1 Pushover alert.
BACKUP_STATUS="failed"
# shellcheck disable=SC2154  # _exit is assigned inside the trap string itself
trap '_exit=$?; if [[ "$BACKUP_STATUS" != "success" ]]; then
  PUSHOVER_TITLE="Open Brain: backup FAILED" \
    notify_pushover_mismatch "Daily backup failed at $(date +%H:%M) (exit ${_exit}) — check /var/log/open-brain-backup.log" || true
fi' EXIT

echo "=== Open Brain Backup: ${TIMESTAMP} ==="

# --- 1. Postgres dump (custom format for selective restore) ---
echo "[1/6] Dumping Postgres database..."
DB_DUMP="${BACKUP_FILE}/openbrain.pgdump"

# Try the expected container name first, fall back to discovery
CONTAINER="${DB_CONTAINER}"
if ! docker inspect "$CONTAINER" &>/dev/null; then
    CONTAINER=$(docker ps --filter "name=open-brain" --filter "name=postgres" --format '{{.Names}}' | head -1)
    if [ -z "$CONTAINER" ]; then
        echo "ERROR: Cannot find Postgres container" >&2
        exit 1
    fi
    echo "  (discovered container: ${CONTAINER})"
fi

docker exec "$CONTAINER" pg_dump \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --format=custom \
    --compress=6 \
    --no-owner \
    --no-privileges \
    > "$DB_DUMP"

DB_SIZE=$(du -h "$DB_DUMP" | cut -f1)
echo "  Database dump: ${DB_SIZE}"

# --- 2. Config files ---
echo "[2/6] Backing up config files..."
CONFIG_DIR="${BACKUP_FILE}/config"
mkdir -p "$CONFIG_DIR"

# >>> config-copy-block  (extracted + run standalone by test-backup-secrets-redaction.sh;
#     edit WITHIN the markers, never the marker lines — the test greps for them)
# Config YAML — RECURSIVE (#299/A143). The old non-recursive glob (config/*.yaml)
# silently omitted every config/ SUBDIR — prometheus/, financial/, utility/,
# cloudflare/, grafana/ — AND the host-only config/payee-rules.yaml from every
# backup, local and offsite, while still logging "Backing up config files". The
# subdir structure is mirrored under CONFIG_DIR, and a real copy failure now
# ABORTS the backup (set -e + the EXIT trap fires a FAILED Pushover) instead of
# being swallowed by `|| true`. Only *.yaml/*.yml are copied — config/himalaya's
# .toml (SMTP creds) and other non-YAML are intentionally NOT swept in.
config_count=0
if [ -d "${APP_DIR}/config" ]; then
  while IFS= read -r -d '' _src; do
    _rel="${_src#"${APP_DIR}"/config/}"
    _dest="${CONFIG_DIR}/${_rel}"
    mkdir -p "$(dirname "$_dest")"
    cp -a "$_src" "$_dest"
    config_count=$((config_count + 1))
  done < <(find "${APP_DIR}/config" -type f \( -name '*.yaml' -o -name '*.yml' \) -print0)
fi

# Environment files — non-sensitive only. .env.secrets is EXCLUDED (never copied).
# NOTE: .env still holds REDIS_PASSWORD until #281/D145 lands; the offsite leg is
# an encrypted rclone crypt remote. Post-restore: scripts/load-secrets.sh rebuilds
# .env.secrets from Bitwarden (deploy/.env.secrets.template).
if [ -f "${APP_DIR}/.env" ];                        then cp -a "${APP_DIR}/.env"                        "$CONFIG_DIR/dot-env";         fi
if [ -f "${APP_DIR}/.env.example" ];                then cp -a "${APP_DIR}/.env.example"                "$CONFIG_DIR/dot-env-example"; fi
if [ -f "${APP_DIR}/docker-compose.yml" ];          then cp -a "${APP_DIR}/docker-compose.yml"          "$CONFIG_DIR/"; fi
if [ -f "${APP_DIR}/docker-compose.override.yml" ]; then cp -a "${APP_DIR}/docker-compose.override.yml" "$CONFIG_DIR/"; fi
# <<< config-copy-block

echo "  Config files: ${config_count} YAML (recursive) + env/compose"

# --- 3. Schema reference (for disaster recovery) ---
echo "[3/6] Backing up schema reference..."
docker exec "$CONTAINER" pg_dump \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --schema-only \
    --no-owner \
    --no-privileges \
    > "${BACKUP_FILE}/schema.sql"

echo "  Schema: $(wc -l < "${BACKUP_FILE}/schema.sql") lines"

# --- 4. Wiki repository (git bundle) ---
echo "[4/6] Backing up wiki repository..."
WIKI_BUNDLE="${BACKUP_FILE}/wiki.bundle"

# Use core-api container's git (has GITEA_TOKEN wired via compose) to bundle
# the wiki repo. core-api clones on startup; if the clone is absent, fall
# back to a one-shot clone into a tmp dir.
WIKI_SIZE="0"
if docker exec open-brain-core-api test -d /tmp/open-brain-wiki/.git 2>/dev/null; then
    docker exec open-brain-core-api git -C /tmp/open-brain-wiki bundle create /tmp/wiki.bundle --all 2>&1 \
        | sed 's/^/  /'
    docker cp open-brain-core-api:/tmp/wiki.bundle "$WIKI_BUNDLE"
    docker exec open-brain-core-api rm -f /tmp/wiki.bundle
elif docker exec open-brain-workers test -d /tmp/open-brain-wiki/.git 2>/dev/null; then
    docker exec open-brain-workers git -C /tmp/open-brain-wiki bundle create /tmp/wiki.bundle --all 2>&1 \
        | sed 's/^/  /'
    docker cp open-brain-workers:/tmp/wiki.bundle "$WIKI_BUNDLE"
    docker exec open-brain-workers rm -f /tmp/wiki.bundle
else
    echo "  WARNING: no container has a wiki clone to bundle — skipping wiki backup"
fi

if [ -f "$WIKI_BUNDLE" ]; then
    WIKI_SIZE=$(du -h "$WIKI_BUNDLE" | cut -f1)
    echo "  Wiki bundle: ${WIKI_SIZE}"
fi

# --- 5. Redis RDB snapshot ---
echo "[5/6] Triggering Redis snapshot..."
REDIS_RDB="${BACKUP_FILE}/redis.rdb"
REDIS_SIZE="0"
REDIS_STATUS="failed"

REDIS_C="${REDIS_CONTAINER}"
if ! docker inspect "$REDIS_C" &>/dev/null; then
    REDIS_C=$(docker ps --filter "name=open-brain" --filter "name=redis" --format '{{.Names}}' | head -1 || true)
fi

# redis_cli <args...> — the password reaches the container by NAME only (-e NAME), so it
# never appears in a process list or a log. The in-container fallback to REDIS_PASSWORD
# covers the container before and after item 8.3 (env_file vs. host-supplied).
redis_cli() {
    REDISCLI_AUTH="${REDIS_PASSWORD:-}" docker exec -e REDISCLI_AUTH "$REDIS_C" \
        sh -c 'REDISCLI_AUTH="${REDISCLI_AUTH:-$REDIS_PASSWORD}" redis-cli "$@"' sh "$@"
}

# snapshot_redis — returns 0 only when the RDB was written and copied. Every failure
# path returns 1 (explicit: this runs inside an `if`, where set -e is suspended).
snapshot_redis() {
    local pre post wait=0
    # BGSAVE is async — poll LASTSAVE; a changed value means the snapshot finished.
    pre=$(redis_cli LASTSAVE 2>/dev/null) || { echo "  WARNING: Redis LASTSAVE failed"; return 1; }
    pre="${pre//[$'\r\n ']/}"
    [[ "$pre" =~ ^[0-9]+$ ]] || { echo "  WARNING: Redis LASTSAVE returned a non-numeric reply (auth failure?)"; return 1; }
    redis_cli BGSAVE SCHEDULE >/dev/null 2>&1 || { echo "  WARNING: Redis BGSAVE failed"; return 1; }
    post="$pre"
    while [ "$wait" -lt "${REDIS_WAIT_SECS:-60}" ]; do
        sleep 1
        wait=$((wait + 1))
        post=$(redis_cli LASTSAVE 2>/dev/null) || post="$pre"
        post="${post//[$'\r\n ']/}"
        [[ "$post" =~ ^[0-9]+$ ]] || { echo "  WARNING: Redis LASTSAVE returned a non-numeric reply"; return 1; }
        [ "$post" != "$pre" ] && break
    done
    if [ "$post" = "$pre" ]; then
        echo "  WARNING: Redis BGSAVE did not complete within ${REDIS_WAIT_SECS:-60}s — skipping RDB copy"
        return 1
    fi
    if ! docker cp "${REDIS_C}:/data/dump.rdb" "$REDIS_RDB" >/dev/null 2>&1 || [ ! -s "$REDIS_RDB" ]; then
        rm -f "$REDIS_RDB"
        echo "  WARNING: could not copy dump.rdb out of ${REDIS_C}"
        return 1
    fi
    REDIS_SIZE=$(du -h "$REDIS_RDB" | cut -f1)
    echo "  Redis snapshot: ${REDIS_SIZE} (waited ${wait}s)"
    return 0
}

if [ -n "$REDIS_C" ]; then
    if snapshot_redis; then REDIS_STATUS="present"; fi
else
    echo "  WARNING: no Redis container found — skipping Redis snapshot"
fi
[ "$REDIS_STATUS" = "present" ] || echo "  WARNING: redis_rdb: failed — the backup continues without a Redis snapshot"

# --- 5b. Sidecar state + host files (item 6.4) ---
# Every step here warns and continues; none may abort the backup or block the `latest` move.
echo "[5b/6] Backing up sidecar state and host files..."
SIDECAR_DIR="${BACKUP_FILE}/sidecars"
mkdir -p "$SIDECAR_DIR" || true

# sqlite_snapshot <container> <db-path-in-container> <out-name>
# A plain copy of a WAL-mode SQLite file is corrupt; the backup API gives a consistent copy.
sqlite_snapshot() {
    local c="$1" db="$2" out="$3" tmp="/tmp/${3}.snapshot"
    if ! docker exec "$c" test -f "$db" >/dev/null 2>&1; then
        echo "  WARNING: ${c}:${db} not found — skipping"
        return 1
    fi
    docker exec "$c" python -c '
import sqlite3, sys
src = sqlite3.connect(sys.argv[1])
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()' "$db" "$tmp" >/dev/null 2>&1 || { echo "  WARNING: sqlite backup of ${c}:${db} failed"; return 1; }
    docker cp "${c}:${tmp}" "${SIDECAR_DIR}/${out}" >/dev/null 2>&1 \
        || { echo "  WARNING: docker cp of ${c}:${tmp} failed"; docker exec "$c" rm -f "$tmp" >/dev/null 2>&1 || true; return 1; }
    docker exec "$c" rm -f "$tmp" >/dev/null 2>&1 || true
    echo "  ${out}: $(du -h "${SIDECAR_DIR}/${out}" | cut -f1)"
}

# tar_from_container <container> <path> <archive-name>
# The archive is <archive-name>.tar; its member keeps the BASENAME of <path> (state.json,
# voice-spool/...), so extracting it into the parent directory in the container
# (`docker cp - <c>:/data < x.tar`, or `tar -xf x.tar -C /data`) restores the original path.
tar_from_container() {
    local c="$1" path="$2" name="$3" stage member
    member="$(basename "$path")"
    stage=$(mktemp -d) || return 1
    if docker cp "${c}:${path}" "${stage}/${member}" >/dev/null 2>&1 \
        && tar -C "$stage" -cf "${SIDECAR_DIR}/${name}.tar" "$member"; then
        echo "  ${name}.tar: $(du -h "${SIDECAR_DIR}/${name}.tar" | cut -f1)"
        rm -rf "$stage"
    else
        echo "  WARNING: could not archive ${c}:${path} — skipping"
        rm -rf "$stage"; rm -f "${SIDECAR_DIR}/${name}.tar"
        return 1
    fi
}

# DB paths: FINANCIAL_PIPE_DIR / UTILITY_PIPE_DIR = /data in compose (volumes
# financial_ingest_data / utility_ingest_data); DB_PATH = PIPE_DIR/<name>.db.
sqlite_snapshot open-brain-financial-ingest /data/financial.db financial.db || true
sqlite_snapshot open-brain-utility-ingest   /data/utility.db   utility.db   || true
# actual-ingest: ACTUAL_STATE_PATH=/data/state.json. voice-capture: VOICE_SPOOL_DIR=/data/voice-spool.
tar_from_container open-brain-actual-ingest /data/state.json actual-state || true
tar_from_container open-brain-voice-capture /data/voice-spool voice-spool || true

# Host files: cron table (no secrets — each line sources .env.secrets at run time),
# working-tree state, and the deployed-commit record.
if [ -r "$CUSTOM_CRON_SRC" ]; then
    cp -a "$CUSTOM_CRON_SRC" "${BACKUP_FILE}/custom.cron" || echo "  WARNING: could not copy ${CUSTOM_CRON_SRC}"
else
    echo "  WARNING: ${CUSTOM_CRON_SRC} not readable — custom.cron not backed up"
fi
{
    echo "HEAD: $(git -c safe.directory="$APP_DIR" -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "--- status --porcelain ---"
    git -c safe.directory="$APP_DIR" -C "$APP_DIR" status --porcelain 2>/dev/null || echo "(git status failed)"
} > "${BACKUP_FILE}/host-tree.txt" 2>/dev/null || echo "  WARNING: could not write host-tree.txt"
if [ -f "${APP_DIR}/DEPLOYED.json" ]; then
    cp -a "${APP_DIR}/DEPLOYED.json" "${BACKUP_FILE}/DEPLOYED.json" || echo "  WARNING: could not copy DEPLOYED.json"
fi

# --- 6. Manifest ---
echo "[6/6] Writing manifest..."

# Get EXACT row counts per table. n_live_tup is a stats-collector estimate
# that goes stale on small low-churn tables (below autovacuum thresholds) —
# restore-rehearsal.sh compares these counts against the restored dump at
# ±10%, and stale estimates produce false FAILs (2026-06-11 rehearsal:
# sessions 14 actual vs 12 estimated, session_messages 52 vs 18).
TABLE_COUNTS=$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "
    SELECT relname || ':' || (xpath('/row/c/text()',
        query_to_xml(format('SELECT count(*) AS c FROM %I.%I', schemaname, relname), false, true, '')
    ))[1]::text
    FROM pg_stat_user_tables
    WHERE schemaname = 'public'
    ORDER BY relname
")

# Object counts come from the SAME function the restore rehearsal uses (scripts/lib/db-objects.sh).
OBJECTS_JSON=$(db_objects_json "$CONTAINER" "$DB_USER" "$DB_NAME" 2>/dev/null) || OBJECTS_JSON=""
if [ -z "$OBJECTS_JSON" ]; then
    echo "  WARNING: object counts unavailable — manifest records objects: null"
    OBJECTS_JSON="null"
fi

# Image IDs of every running open-brain container (name -> image ID).
IMAGES_JSON=$(
    {
        docker ps --format '{{.Names}}' 2>/dev/null | grep '^open-brain' || true
    } | while IFS= read -r _name; do
        _img=$(docker inspect --format '{{.Image}}' "$_name" 2>/dev/null || true)
        [ -n "$_img" ] && echo "        \"${_name}\": \"${_img}\","
    done | sed '$ s/,$//'
) || IMAGES_JSON=""

GIT_VERSION=$(git -c safe.directory="$APP_DIR" -C "$APP_DIR" describe --tags --always 2>/dev/null || echo 'unknown')
GIT_SHA=$(git -c safe.directory="$APP_DIR" -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo 'unknown')

cat > "${BACKUP_FILE}/manifest.json" << MANIFEST
{
    "timestamp": "${TIMESTAMP}",
    "date": "${DATE}",
    "version": "${GIT_VERSION}",
    "git_sha": "${GIT_SHA}",
    "db_size_bytes": $(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "SELECT pg_database_size('${DB_NAME}')"),
    "dump_format": "pg_dump custom (compressed)",
    "redis_rdb": "${REDIS_STATUS}",
    "objects": ${OBJECTS_JSON},
    "images": {
${IMAGES_JSON}
    },
    "tables": {
$(echo "$TABLE_COUNTS" | while IFS=: read -r table count; do
    [ -n "$table" ] && echo "        \"${table}\": ${count},"
done | sed '$ s/,$//')
    },
    "files": [
$(cd "$BACKUP_FILE" && find . -type f ! -name manifest.json | sed 's|^\./||' | sort | while read -r f; do
    echo "        \"${f}\","
done | sed '$ s/,$//')
    ]
}
MANIFEST

# Every file in today's directory gets the backup time as its mtime: `cp -a` and
# `docker cp` keep OLD mtimes, and the offsite copy (item 7.1) filters on file age.
find "$BACKUP_FILE" -type f -exec touch -c {} + || echo "  WARNING: could not normalize file mtimes"

# --- Retention: promote to weekly/monthly ---
if [ "$DAY_OF_WEEK" -eq 7 ]; then
    echo "  Promoting to weekly backup (Sunday)"
    cp -a "$BACKUP_FILE" "${WEEKLY_DIR}/${DATE}"
fi

if [ "$DAY_OF_MONTH" -eq "01" ]; then
    echo "  Promoting to monthly backup (1st of month)"
    cp -a "$BACKUP_FILE" "${MONTHLY_DIR}/${DATE}"
fi

# Update latest symlink
ln -sfn "$BACKUP_FILE" "$LATEST_LINK"

# --- Retention: prune old backups ---
echo "--- Pruning old backups ---"

prune_dir() {
    local dir="$1"
    local keep="$2"
    local label="$3"
    local count
    count=$(ls -d "${dir}"/20* 2>/dev/null | wc -l || true)
    if [ "$count" -gt "$keep" ]; then
        local remove=$((count - keep))
        echo "  ${label}: removing ${remove} old backup(s) (keeping ${keep})"
        ls -d "${dir}"/20* | head -n "$remove" | xargs rm -rf
    else
        echo "  ${label}: ${count}/${keep} slots used"
    fi
}

prune_dir "$DAILY_DIR" "$DAILY_RETENTION" "Daily"
prune_dir "$WEEKLY_DIR" "$WEEKLY_RETENTION" "Weekly"
prune_dir "$MONTHLY_DIR" "$MONTHLY_RETENTION" "Monthly"

# --- Summary ---
TOTAL_SIZE=$(du -sh "$BACKUP_ROOT" | cut -f1)
echo ""
echo "=== Backup complete ==="
echo "  Location: ${BACKUP_FILE}"
echo "  DB dump:  ${DB_SIZE}"
echo "  Wiki bundle: ${WIKI_SIZE}"
echo "  Redis RDB: ${REDIS_STATUS} (${REDIS_SIZE})"
echo "  Total backup storage: ${TOTAL_SIZE}"
echo "  Timestamp: ${TIMESTAMP}"

# --- Completion (item 2.5) ---
# Mark success so the EXIT trap skips the failure alert. No success push: the
# daily ops digest reports backup age. The failure trap still pushes.
BACKUP_STATUS="success"
