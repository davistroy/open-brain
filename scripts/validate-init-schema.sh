#!/usr/bin/env bash
# validate-init-schema.sh — two-DB schema parity diff (DA-H1).
#
# Enforces the invariant:  init-schema.sql ALONE  ≡  init-schema.sql + ALL migrations.
#
# Why this shape: drizzle/0000 is an empty stub, so base DDL lives only in
# scripts/init-schema.sql and the 0*.sql files are additive deltas layered on top at
# deploy time. The canonical schema is therefore "init-schema + migrations". If
# init-schema fully ABSORBS every migration (i.e. it is a faithful snapshot — see
# scripts/regenerate-init-schema.sh), the two builds are byte-identical. The moment a
# migration is added but NOT back-ported into init-schema (or init-schema is hand-edited
# to diverge), DB-B gains an object DB-A lacks and this diff fails — catching the exact
# drift class that previously slipped through (app_settings, spreading_activation(),
# lab_results, briefs were all missing before Phase 5).
#
# DB-A = init-schema only.   DB-B = init-schema + every drizzle 0*.sql (in order).
# Both are dumped with `pg_dump --schema-only` and normalized through the SAME
# scripts/lib/pgdump-normalize.sh used by the regenerator, then diffed.
#
# Usage:    bash scripts/validate-init-schema.sh
# Exit 0:   "validate-init-schema: PASSED"   (no drift)
# Exit 1:   prints the unified diff           (init-schema drifted from the migrations)
# Requires: Docker running; ports 5499 + 5498 free.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INIT_SQL="${REPO_ROOT}/scripts/init-schema.sql"
DRIZZLE_DIR="${REPO_ROOT}/packages/shared/drizzle"
NORMALIZE="${REPO_ROOT}/scripts/lib/pgdump-normalize.sh"
IMAGE="pgvector/pgvector:pg16"

A_CONTAINER="ob-parity-a"   # init-schema only
B_CONTAINER="ob-parity-b"   # init-schema + migrations
A_PORT=5499
B_PORT=5498
DB_USER="parity"
DB_NAME="parity"
DB_PASS="parity"

SCHEMA_A="$(mktemp)"
SCHEMA_B="$(mktemp)"
cleanup() {
  docker rm -f "${A_CONTAINER}" "${B_CONTAINER}" >/dev/null 2>&1 || true
  rm -f "${SCHEMA_A}" "${SCHEMA_B}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_ready() {
  local c="$1"
  for _ in $(seq 1 40); do
    if docker exec "$c" psql -U "${DB_USER}" -d "${DB_NAME}" -tAc 'SELECT 1' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "[validate-init-schema] ERROR: ${c} did not become ready" >&2
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

echo "[validate-init-schema] DB-A: applying init-schema.sql only..."
start_pg "${A_CONTAINER}" "${A_PORT}"
# init-schema MUST apply perfectly clean (this also validates the committed file loads).
docker exec -i "${A_CONTAINER}" psql -v ON_ERROR_STOP=1 -U "${DB_USER}" -d "${DB_NAME}" < "${INIT_SQL}" >/dev/null
docker exec "${A_CONTAINER}" pg_dump --schema-only --no-owner --no-privileges \
  -U "${DB_USER}" -d "${DB_NAME}" | bash "${NORMALIZE}" > "${SCHEMA_A}"

echo "[validate-init-schema] DB-B: applying init-schema.sql + all migrations..."
start_pg "${B_CONTAINER}" "${B_PORT}"
docker exec -i "${B_CONTAINER}" psql -v ON_ERROR_STOP=1 -U "${DB_USER}" -d "${DB_NAME}" < "${INIT_SQL}" >/dev/null
# Deltas re-applied on top; benign no-ops (objects already present) are tolerated.
for f in $(ls -1 "${DRIZZLE_DIR}"/0*.sql | sort); do
  docker exec -i "${B_CONTAINER}" psql -v ON_ERROR_STOP=0 -U "${DB_USER}" -d "${DB_NAME}" < "$f" >/dev/null 2>&1 || true
done
docker exec "${B_CONTAINER}" pg_dump --schema-only --no-owner --no-privileges \
  -U "${DB_USER}" -d "${DB_NAME}" | bash "${NORMALIZE}" > "${SCHEMA_B}"

echo "[validate-init-schema] Diffing (init-schema only) vs (init-schema + migrations)..."
if diff -u --label "init-schema-only" "${SCHEMA_A}" --label "init-schema+migrations" "${SCHEMA_B}"; then
  echo "[validate-init-schema] PASSED — init-schema.sql fully absorbs the migration chain (no drift)."
else
  echo "" >&2
  echo "[validate-init-schema] FAILED — init-schema.sql has DRIFTED from the migration chain." >&2
  echo "  The diff above is what the migrations produce that init-schema is missing (or vice-versa)." >&2
  echo "  Fix: bash scripts/regenerate-init-schema.sh   (then commit the regenerated scripts/init-schema.sql)." >&2
  exit 1
fi
