#!/usr/bin/env bash
# pgdump-normalize.sh — filter: stdin = raw `pg_dump --schema-only`, stdout = normalized DDL.
#
# Strips the only two nondeterministic / psql-only artifacts in pg_dump output so that
#   (1) scripts/init-schema.sql is byte-stable across regenerations (no spurious git diffs), and
#   (2) the two-DB schema parity diff (scripts/validate-init-schema.sh) never false-positives.
#
# This is the SINGLE normalizer shared by scripts/regenerate-init-schema.sh and
# scripts/validate-init-schema.sh. Keeping one copy is load-bearing: if the regenerator and
# the parity check normalized differently, CI could stay green while init-schema silently drifted.
#
# Stripped lines:
#   \restrict <token> / \unrestrict <token>
#       - the token is randomized per dump invocation (would diff every regeneration), and
#       - these are psql backslash meta-commands that node-postgres CANNOT execute
#         (integration setup.ts applies init-schema.sql via pool.query(), not psql).
#   -- Dumped from database version ... / -- Dumped by pg_dump version ...
#       - PostgreSQL build-version comments (change with the container image).
#   SELECT pg_catalog.set_config('search_path', '', false);
#       - pg_dump emits this so its qualified DDL is unambiguous, but it mutates the
#         APPLYING session's search_path to empty for the rest of the connection.
#         init-schema's DDL is fully schema-qualified, so the line is unnecessary, and
#         dropping it keeps the committed file from surprising any consumer that reuses
#         the load connection (default search_path already includes public).
set -euo pipefail

sed -E \
  -e '/^\\(un)?restrict /d' \
  -e '/^-- Dumped (from|by) /d' \
  -e "/^SELECT pg_catalog\.set_config\('search_path', '', false\);$/d"
