#!/usr/bin/env bash
# scripts/sync-docs.sh — Version-sync validation script (P15a)
#
# Reads version strings from four authoritative surfaces:
#   1. Root package.json    (machine truth — node -p)
#   2. docs/PRD.md          ("**Version**: X.Y.Z" header line)
#   3. README.md            (Status section "v1.X.Y" pattern)
#   4. CHANGELOG.md         (first "## [X.Y.Z]" released entry)
#
# Exits 0 when all four agree; exits 1 with a mismatch table otherwise.
#
# Usage:
#   bash scripts/sync-docs.sh           # run from repo root
#
# CI: add a doc-sync job that calls this script; use continue-on-error: true
# until the job is promoted to required (same pattern as integration-test).
#
# Notes:
# - Does NOT check TDD version (doc-internal string, not the software semver)
# - Does NOT check sub-package package.json files (all 0.1.0 by design)
# - Does NOT cross-check CLAUDE.md (operational notes, not a semver surface)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ── 1. Root package.json ──────────────────────────────────────────────────────
# Use process.cwd() to avoid path-with-spaces issues on Windows dev boxes.
# CI runs from repo root where this is always correct.
PACKAGE_VERSION=$(node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null || true)

# ── 2. PRD doc-status note: "The current system (vX.Y.Z)" ──
# The PRD **Version** header is a doc version ("0.6"), not the software semver.
# The P15a doc-status note embeds: "The current system (v1.5.0)".
# Anchor on "current system" to avoid matching older version references like "v1.2.0".
PRD_VERSION=$(grep -o 'current system (v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*)' \
  "${REPO_ROOT}/docs/PRD.md" \
  | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1 | tr -d 'v' || true)

# ── 3. README Status section: "**vN.N.N**" bold version at start of Status paragraph ──
# README Status block starts with "**v1.5.0** — Implementation complete…"
README_VERSION=$(grep -oE '\*\*v[0-9]+\.[0-9]+\.[0-9]+\*\*' "${REPO_ROOT}/README.md" \
  | head -1 | tr -d '*v' || true)

# ── 4. CHANGELOG: first released entry "## [X.Y.Z]" (skip [Unreleased]) ──────
CHANGELOG_VERSION=$(grep -m1 '^## \[[0-9]' "${REPO_ROOT}/CHANGELOG.md" \
  | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)

# ── Compare ───────────────────────────────────────────────────────────────────
FAIL=0

check() {
  local surface="$1" version="$2"
  if [[ -z "$version" ]]; then
    printf '  %-22s  %-10s  (could not parse)\n' "$surface" "—"
    FAIL=1
  elif [[ "$version" != "$PACKAGE_VERSION" ]]; then
    printf '  %-22s  %-10s  MISMATCH (expected %s)\n' "$surface" "$version" "$PACKAGE_VERSION"
    FAIL=1
  else
    printf '  %-22s  %-10s  ok\n' "$surface" "$version"
  fi
}

echo ""
echo "Open Brain — doc version sync check"
echo "──────────────────────────────────────────────────"
printf '  %-22s  %-10s\n' "Surface" "Version"
printf '  %-22s  %-10s\n' "──────────────────────" "──────────"
printf '  %-22s  %-10s  (authoritative)\n' "package.json" "${PACKAGE_VERSION:-—}"
check "docs/PRD.md"     "$PRD_VERSION"
check "README.md"       "$README_VERSION"
check "CHANGELOG.md"    "$CHANGELOG_VERSION"
echo "──────────────────────────────────────────────────"

if [[ $FAIL -ne 0 ]]; then
  echo ""
  echo "FAIL: One or more version surfaces diverge from package.json (${PACKAGE_VERSION})."
  echo "      Fix the mismatched files so all surfaces agree."
  exit 1
fi

echo ""
echo "PASS: All version surfaces agree on ${PACKAGE_VERSION}."
exit 0
