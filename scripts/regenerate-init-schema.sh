#!/usr/bin/env bash
# regenerate-init-schema.sh — regenerate scripts/init-schema.sql from the canonical schema.
#
# DA-H1 / SA-2: init-schema.sql is the bootstrap snapshot AND the integration-test
# source-of-truth, but it was hand-maintained and drifted from the migration chain
# (it was missing app_settings, spreading_activation(), lab_results, briefs).
#
# The canonical schema for this repo is "scripts/init-schema.sql + ALL drizzle 0*.sql
# applied in order" — drizzle/0000 is an empty stub, so base DDL lives only in
# init-schema and the migrations are additive deltas layered on top at deploy time.
# This script materializes that canonical schema into a fresh ephemeral Postgres,
# dumps it, and rewrites scripts/init-schema.sql to BE that dump. After regeneration,
# init-schema fully absorbs the migrations, which is exactly the invariant that
# scripts/validate-init-schema.sh enforces in CI.
#
# It is SELF-VERIFYING: the regenerated file is round-trip-applied to a second fresh DB
# with ON_ERROR_STOP=1 before it is allowed to replace the committed file. On any failure
# the existing init-schema.sql is left untouched.
#
# Usage:   bash scripts/regenerate-init-schema.sh
# Requires: Docker running; ports 5499 + 5498 free.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INIT_SQL="${REPO_ROOT}/scripts/init-schema.sql"
DRIZZLE_DIR="${REPO_ROOT}/packages/shared/drizzle"
NORMALIZE="${REPO_ROOT}/scripts/lib/pgdump-normalize.sh"
IMAGE="pgvector/pgvector:pg16"

BUILD_CONTAINER="ob-regen-build"
VERIFY_CONTAINER="ob-regen-verify"
BUILD_PORT=5499
VERIFY_PORT=5498
DB_USER="regen"
DB_NAME="regen"
DB_PASS="regen"

TMP_OUT="$(mktemp)"
cleanup() {
  docker rm -f "${BUILD_CONTAINER}" "${VERIFY_CONTAINER}" >/dev/null 2>&1 || true
  rm -f "${TMP_OUT}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# wait_ready <container> — block until the DB actually answers SELECT 1 (the postgres
# image's init phase makes pg_isready flap, so we probe a real query).
wait_ready() {
  local c="$1"
  for _ in $(seq 1 40); do
    if docker exec "$c" psql -U "${DB_USER}" -d "${DB_NAME}" -tAc 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "[regen] ERROR: ${c} did not become ready" >&2
  return 1
}

start_pg() {
  local name="$1" port="$2"
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" \
    -e POSTGRES_DB="${DB_NAME}" -e POSTGRES_USER="${DB_USER}" -e POSTGRES_PASSWORD="${DB_PASS}" \
    -p "${port}:5432" "${IMAGE}" >/dev/null
  wait_ready "$name"
}

echo "[regen] Building canonical schema (init-schema + all migrations)..."
start_pg "${BUILD_CONTAINER}" "${BUILD_PORT}"

# init-schema must apply perfectly clean.
docker exec -i "${BUILD_CONTAINER}" psql -v ON_ERROR_STOP=1 -U "${DB_USER}" -d "${DB_NAME}" < "${INIT_SQL}" >/dev/null

# Migrations are additive deltas re-applied on top; a handful re-create objects
# init-schema already has (triggers/constraints) — those are benign no-ops, so we
# deliberately tolerate errors here (ON_ERROR_STOP off).
for f in $(ls -1 "${DRIZZLE_DIR}"/0*.sql | sort); do
  docker exec -i "${BUILD_CONTAINER}" psql -v ON_ERROR_STOP=0 -U "${DB_USER}" -d "${DB_NAME}" < "$f" >/dev/null 2>&1 || true
done

echo "[regen] Dumping + normalizing schema..."
{
  echo "-- =============================================================================="
  echo "-- scripts/init-schema.sql — GENERATED FILE. DO NOT EDIT BY HAND."
  echo "--"
  echo "-- Regenerate with:  bash scripts/regenerate-init-schema.sh"
  echo "-- Source of truth:  this file + packages/shared/drizzle/0*.sql, applied in order."
  echo "-- CI guard:         scripts/validate-init-schema.sh (two-DB pg_dump parity diff)."
  echo "--"
  echo "-- This is a 'pg_dump --schema-only' snapshot of init-schema + ALL migrations,"
  echo "-- normalized (no \\restrict token, no version comments) so it is byte-stable and"
  echo "-- executable by node-postgres (integration setup.ts applies it via pool.query)."
  echo "-- =============================================================================="
  docker exec "${BUILD_CONTAINER}" pg_dump --schema-only --no-owner --no-privileges \
    -U "${DB_USER}" -d "${DB_NAME}" | bash "${NORMALIZE}"
} > "${TMP_OUT}"

echo "[regen] Self-verify: round-trip the regenerated file on a clean DB (ON_ERROR_STOP=1)..."
start_pg "${VERIFY_CONTAINER}" "${VERIFY_PORT}"
if ! docker exec -i "${VERIFY_CONTAINER}" psql -v ON_ERROR_STOP=1 -U "${DB_USER}" -d "${DB_NAME}" < "${TMP_OUT}" >/dev/null 2>verify.err; then
  echo "[regen] ERROR: regenerated schema failed to apply cleanly — init-schema.sql left UNCHANGED." >&2
  sed 's/^/  /' verify.err >&2 || true
  rm -f verify.err
  exit 1
fi
rm -f verify.err

mv "${TMP_OUT}" "${INIT_SQL}"
echo "[regen] PASSED — scripts/init-schema.sql regenerated ($(wc -l < "${INIT_SQL}") lines)."
