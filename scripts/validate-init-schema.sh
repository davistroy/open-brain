#!/usr/bin/env bash
# validate-init-schema.sh
# Validates scripts/init-schema.sql + all Drizzle migrations against a fresh
# ephemeral pgvector/pgvector:pg16 container on port 5499.
#
# Usage:
#   bash scripts/validate-init-schema.sh
#
# Exit 0 on success ("validate-init-schema: PASSED")
# Exit 1 on any missing table or missing CHECK constraint
#
# Requirements: Docker must be running; port 5499 must be free.

set -euo pipefail

CONTAINER_NAME="ob-schema-validate"
DB_PORT=5499
DB_NAME="validate"
DB_USER="validate"
DB_PASS="validate"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INIT_SQL="${REPO_ROOT}/scripts/init-schema.sql"
DRIZZLE_DIR="${REPO_ROOT}/packages/shared/drizzle"

# Cleanup function — always remove the container on exit
cleanup() {
  docker rm -f "${CONTAINER_NAME}" > /dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[validate-init-schema] Starting ephemeral Postgres container..."
docker run -d \
  --name "${CONTAINER_NAME}" \
  -e POSTGRES_DB="${DB_NAME}" \
  -e POSTGRES_USER="${DB_USER}" \
  -e POSTGRES_PASSWORD="${DB_PASS}" \
  -p "${DB_PORT}:5432" \
  pgvector/pgvector:pg16 > /dev/null

# Wait for Postgres to be ready (up to 30 seconds)
echo "[validate-init-schema] Waiting for Postgres to be ready..."
READY=0
for i in $(seq 1 30); do
  if docker exec "${CONTAINER_NAME}" pg_isready -U "${DB_USER}" -d "${DB_NAME}" > /dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [ "${READY}" -ne 1 ]; then
  echo "[validate-init-schema] ERROR: Postgres did not become ready within 30 seconds." >&2
  exit 1
fi

echo "[validate-init-schema] Postgres ready. Applying init-schema.sql..."
docker exec -i "${CONTAINER_NAME}" psql -U "${DB_USER}" -d "${DB_NAME}" < "${INIT_SQL}"

echo "[validate-init-schema] Applying individual Drizzle migrations (idempotency check)..."
for SQL_FILE in $(ls -1 "${DRIZZLE_DIR}"/0*.sql 2>/dev/null | sort); do
  echo "  -> ${SQL_FILE##*/}"
  docker exec -i "${CONTAINER_NAME}" psql -U "${DB_USER}" -d "${DB_NAME}" < "${SQL_FILE}"
done

echo "[validate-init-schema] Verifying expected tables..."

# All 23 expected tables
EXPECTED_TABLES=(
  captures
  pipeline_events
  ai_audit_log
  entities
  entity_links
  entity_relationships
  sessions
  session_messages
  bets
  skills_log
  triggers
  capture_associations
  activity_feed
  app_settings
  mcp_activity
  backup_log
  email_drafts
  container_health
  voice_sessions
  file_uploads
  email_classifications
  email_corrections
  email_daily_summaries
)

MISSING_TABLES=()
for TABLE in "${EXPECTED_TABLES[@]}"; do
  EXISTS=$(docker exec "${CONTAINER_NAME}" psql -U "${DB_USER}" -d "${DB_NAME}" -tAc \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '${TABLE}';")
  if [ "${EXISTS}" -ne 1 ]; then
    MISSING_TABLES+=("${TABLE}")
  fi
done

if [ ${#MISSING_TABLES[@]} -gt 0 ]; then
  echo "[validate-init-schema] ERROR: Missing tables: ${MISSING_TABLES[*]}" >&2
  exit 1
fi

echo "[validate-init-schema] All 23 tables present. Verifying captures_source_check constraint..."

CONSTRAINT_EXISTS=$(docker exec "${CONTAINER_NAME}" psql -U "${DB_USER}" -d "${DB_NAME}" -tAc \
  "SELECT COUNT(*) FROM information_schema.table_constraints
   WHERE constraint_name = 'captures_source_check'
   AND table_name = 'captures'
   AND constraint_type = 'CHECK';")

if [ "${CONSTRAINT_EXISTS}" -ne 1 ]; then
  echo "[validate-init-schema] ERROR: captures_source_check CHECK constraint not found." >&2
  exit 1
fi

echo "[validate-init-schema] PASSED"
