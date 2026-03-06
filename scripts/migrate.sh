#!/usr/bin/env bash
# migrate.sh — Run Drizzle migrations against the configured Postgres instance
# Usage: ./scripts/migrate.sh
# Requires: POSTGRES_URL env var (or uses dev default)

set -euo pipefail

POSTGRES_URL="${POSTGRES_URL:-postgresql://openbrain:openbrain_dev@localhost:5432/openbrain}"

echo "Running Drizzle migrations..."
echo "Target: ${POSTGRES_URL%%@*}@*** (credentials hidden)"

POSTGRES_URL="${POSTGRES_URL}" pnpm drizzle-kit migrate

echo "Applying custom extensions and indexes..."
PGPASSWORD=$(echo "${POSTGRES_URL}" | sed 's|.*://[^:]*:\([^@]*\)@.*|\1|') \
  psql "${POSTGRES_URL}" -f packages/shared/drizzle/0001_custom_extensions.sql

echo "Migrations complete."
