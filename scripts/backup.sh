#!/bin/bash
# Open Brain Daily Backup
# Backs up Postgres database + config files + wiki repo + Redis RDB snapshot
# to /mnt/user/backup/openbrain/
# Retention: 14 daily + 4 weekly (Sundays) + 3 monthly (1st of month)
#
# Usage: bash /mnt/user/appdata/open-brain/scripts/backup.sh
# Cron:  0 3 * * * cd /mnt/user/appdata/open-brain && bash scripts/backup.sh >> /tmp/open-brain-backup.log 2>&1

set -euo pipefail

# --- Configuration ---
BACKUP_ROOT="${BACKUP_ROOT:-/mnt/user/backup/openbrain}"
APP_DIR="${APP_DIR:-/mnt/user/appdata/open-brain}"
DB_CONTAINER="open-brain-postgres"
REDIS_CONTAINER="open-brain-redis"
DB_USER="openbrain"
DB_NAME="openbrain"
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

# Config YAML files
cp -a "${APP_DIR}/config/"*.yaml "$CONFIG_DIR/" 2>/dev/null || true
cp -a "${APP_DIR}/config/"*.yml "$CONFIG_DIR/" 2>/dev/null || true

# Environment files — non-sensitive only. .env.secrets is EXCLUDED.
# Post-restore: run scripts/load-secrets.sh (or bws secret get per
# deploy/.env.secrets.template) to rebuild .env.secrets from Bitwarden.
cp "${APP_DIR}/.env" "$CONFIG_DIR/dot-env" 2>/dev/null || true
cp "${APP_DIR}/.env.example" "$CONFIG_DIR/dot-env-example" 2>/dev/null || true

# Docker compose
cp "${APP_DIR}/docker-compose.yml" "$CONFIG_DIR/" 2>/dev/null || true
cp "${APP_DIR}/docker-compose.override.yml" "$CONFIG_DIR/" 2>/dev/null || true

echo "  Config files: $(ls "$CONFIG_DIR" | wc -l) files"

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

REDIS_C="${REDIS_CONTAINER}"
if ! docker inspect "$REDIS_C" &>/dev/null; then
    REDIS_C=$(docker ps --filter "name=open-brain" --filter "name=redis" --format '{{.Names}}' | head -1)
fi

if [ -n "$REDIS_C" ]; then
    # BGSAVE is async — wait for completion by polling LASTSAVE. Pre-BGSAVE
    # LASTSAVE value gives us the baseline; new value means snapshot finished.
    PRE_SAVE=$(docker exec "$REDIS_C" redis-cli LASTSAVE)
    docker exec "$REDIS_C" redis-cli BGSAVE >/dev/null
    WAIT=0
    while [ "$WAIT" -lt 60 ]; do
        sleep 1
        WAIT=$((WAIT + 1))
        POST_SAVE=$(docker exec "$REDIS_C" redis-cli LASTSAVE)
        if [ "$POST_SAVE" != "$PRE_SAVE" ]; then
            break
        fi
    done

    if [ "$POST_SAVE" = "$PRE_SAVE" ]; then
        echo "  WARNING: Redis BGSAVE did not complete within 60s — skipping RDB copy"
    else
        docker cp "${REDIS_C}:/data/dump.rdb" "$REDIS_RDB" 2>/dev/null || true
        if [ -f "$REDIS_RDB" ]; then
            REDIS_SIZE=$(du -h "$REDIS_RDB" | cut -f1)
            echo "  Redis snapshot: ${REDIS_SIZE} (waited ${WAIT}s)"
        fi
    fi
else
    echo "  WARNING: no Redis container found — skipping Redis snapshot"
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
    ORDER BY relname
")

cat > "${BACKUP_FILE}/manifest.json" << MANIFEST
{
    "timestamp": "${TIMESTAMP}",
    "date": "${DATE}",
    "version": "$(cd "$APP_DIR" && git describe --tags --always 2>/dev/null || echo 'unknown')",
    "git_sha": "$(cd "$APP_DIR" && git rev-parse --short HEAD 2>/dev/null || echo 'unknown')",
    "db_size_bytes": $(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -t -A -c "SELECT pg_database_size('${DB_NAME}')"),
    "dump_format": "pg_dump custom (compressed)",
    "tables": {
$(echo "$TABLE_COUNTS" | while IFS=: read -r table count; do
    [ -n "$table" ] && echo "        \"${table}\": ${count},"
done | sed '$ s/,$//')
    },
    "files": [
$(ls "$BACKUP_FILE" | while read -r f; do
    echo "        \"${f}\","
done | sed '$ s/,$//')
    ]
}
MANIFEST

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
    local count=$(ls -d "${dir}"/20* 2>/dev/null | wc -l)
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
echo "  Redis RDB: ${REDIS_SIZE}"
echo "  Total backup storage: ${TOTAL_SIZE}"
echo "  Timestamp: ${TIMESTAMP}"
