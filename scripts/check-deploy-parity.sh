#!/usr/bin/env bash
# check-deploy-parity.sh — does production run THIS repo's compose? (#302)
#
# Enforces the invariant:  deployed docker-compose.yml  ≡  origin/main's, modulo a
# short, EXPLICIT allowlist of host deviations.
#
# ── Why this exists ────────────────────────────────────────────────────────────
# `docker compose pull` + `up -d --force-recreate` ships IMAGE changes, because every
# service pins `:latest`. It does NOT ship compose changes — `up` reads the compose
# file sitting on the host, which only moves when a human remembers to run
#   git checkout origin/main -- docker-compose.yml
# Nothing does that on a schedule, and until now nothing compared the two copies.
#
# The cost, measured 2026-07-15 (Entry 211): the deployed compose was ~1 month stale,
# so PR #244's `/backup-latest` mount was never deployed — which is the real reason the
# backup dead-man's switch (#294) is inert. The workers container HAD been recreated;
# a recreate simply cannot help when the file itself is old. Both the issue and the
# remediation plan asserted "just recreate workers", and both were wrong.
#
# This is the 7th instance in one week of the same class — #278, #290, #292, #294,
# #299, Entry 201, #302 — and every one of them drifted for the same reason: nothing
# compared the two copies. The one mechanism in this repo with a proven track record,
# `validate-init-schema.sh`, works precisely because it COMPARES. This is that shape,
# applied to deployment.
#
# ── Why source-diff, not `docker compose config` ───────────────────────────────
# Rendering requires `.env` on both sides, and `.env` on the host is root:0600 (so a
# non-root check cannot read it) — while `.env`'s absence is itself part of #281. A
# source diff needs no secrets, no root, and no interpolation, and it answers the
# actual question: "is production running this file?"
#
# `docker compose config` still has a job — the BEFORE/AFTER gate around a deploy
# (Entry 179 / ADR-0004). That is a different check: it proves a change did only what
# you intended. This one proves the file is current in the first place.
#
# ── Exit codes ─────────────────────────────────────────────────────────────────
#   0  in parity (only allowlisted deviations)
#   1  DRIFT — production is not running this repo's compose
#   2  could not perform the check (never silently "pass"; see #303's lesson —
#      a check that cannot run must not look like a check that passed)
set -uo pipefail

HOST="${PARITY_HOST:-homeserver.k4jda.net}"
USER_="${PARITY_USER:-claude}"
APP_DIR="${PARITY_APP_DIR:-/mnt/user/appdata/open-brain}"
SSH_KEY="${PARITY_SSH_KEY:-$HOME/.ssh/id_claude_code}"
REF="${PARITY_REF:-origin/main}"

die() { echo "ERROR: $*" >&2; exit 2; }

# ── The allowlist: deviations that are DELIBERATE and DOCUMENTED ───────────────
# Keep this list SHORT and justified. Every entry is a place production knowingly
# differs from main. An unjustified entry here silently re-creates the very drift this
# script exists to catch — if you find yourself adding one, that is the smell.
#
#  D131 — core-api port binding. main declares a dual bind
#           "127.0.0.1:3002:3000" + "${TAILSCALE_IP:-...}:3002:3000"
#         while the host runs a single "3002:3000", re-applied by `sed` after every
#         `git checkout origin/main -- docker-compose.yml` (Entry 179).
#
# NOTE: postgres/redis raw-bind volumes are NOT a deviation of this file — they live in
# the host's gitignored docker-compose.override.yml (ADR-0004), which this check does
# not read. That is correct: the override is host-specific by design.
ALLOW_RE='^[<>][[:space:]]*-[[:space:]]*"(127\.0\.0\.1:3002:3000|\$\{TAILSCALE_IP:-[0-9.]+\}:3002:3000|3002:3000)"'

command -v git >/dev/null || die "git not found"
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repo"

if [ -n "${PARITY_LOCAL_COMPOSE:-}" ]; then
  echo "== deploy parity: ${PARITY_LOCAL_COMPOSE} (local)  vs  ${REF} =="
else
  echo "== deploy parity: ${USER_}@${HOST}:${APP_DIR}/docker-compose.yml  vs  ${REF} =="
fi

git fetch --quiet origin 2>/dev/null || echo "  warn: git fetch failed; comparing against a possibly stale ${REF}" >&2

REPO_TMP="$(mktemp)"; DEPLOY_TMP="$(mktemp)"
trap 'rm -f "$REPO_TMP" "$DEPLOY_TMP"' EXIT

git show "${REF}:docker-compose.yml" > "$REPO_TMP" 2>/dev/null \
  || die "cannot read docker-compose.yml from ${REF}"

# Read the DEPLOYED compose — read-only either way; this script must never mutate
# the host. PARITY_LOCAL_COMPOSE lets the check run ON the deploy host itself (the
# scheduled cron path) by reading the file locally, avoiding a self-SSH hop.
if [ -n "${PARITY_LOCAL_COMPOSE:-}" ]; then
  [ -r "$PARITY_LOCAL_COMPOSE" ] || die "PARITY_LOCAL_COMPOSE not readable: ${PARITY_LOCAL_COMPOSE}"
  cp "$PARITY_LOCAL_COMPOSE" "$DEPLOY_TMP" || die "cannot read the deployed compose at ${PARITY_LOCAL_COMPOSE}"
else
  if ! ssh -i "$SSH_KEY" -o ConnectTimeout=20 -o BatchMode=yes "${USER_}@${HOST}" \
        "cat ${APP_DIR}/docker-compose.yml" > "$DEPLOY_TMP" 2>/dev/null; then
    die "cannot read the deployed compose over ssh (host down? key? path?)"
  fi
fi
[ -s "$DEPLOY_TMP" ] || die "deployed compose came back EMPTY — refusing to report parity"

# Compare substance, not formatting: comments and blank lines are noise here.
strip() { grep -vE '^[[:space:]]*(#|$)' "$1"; }

RAW_DIFF="$(diff <(strip "$REPO_TMP") <(strip "$DEPLOY_TMP") || true)"

if [ -z "$RAW_DIFF" ]; then
  echo "  OK — deployed compose matches ${REF} exactly (not even the D131 deviation)."
  exit 0
fi

UNEXPECTED="$(printf '%s\n' "$RAW_DIFF" | grep -E '^[<>]' | grep -Ev "$ALLOW_RE" || true)"

if [ -z "$UNEXPECTED" ]; then
  echo "  OK — in parity. Only the allowlisted D131 core-api port deviation differs."
  exit 0
fi

echo
echo "  DRIFT — production is NOT running ${REF}'s compose."
echo "  '<' = in ${REF} but MISSING from production   '>' = on the host but not in ${REF}"
echo
printf '%s\n' "$UNEXPECTED" | sed 's/^/    /'
echo
echo "  Commits touching docker-compose.yml that production may be missing:"
git log --oneline "${REF}" -- docker-compose.yml 2>/dev/null | head -6 | sed 's/^/    /'
echo
echo "  Fix (Entry 179's compose-diverged procedure — as ROOT; claude's git fetch"
echo "  fails SILENTLY on the root-owned refs there):"
echo "    1. ssh root@${HOST}"
echo "    2. cd ${APP_DIR} && git fetch origin && git checkout origin/main -- docker-compose.yml"
echo "    3. re-apply the D131 core-api port deviation with sed (Unraid has NO python3)"
echo "    4. docker compose config --format json  BEFORE/AFTER  -> jq -S . | diff"
echo "       assert postgres/redis still render as BINDS, else STOP (nothing recreated yet)"
echo "    5. recreate ONLY the affected services, one wave at a time (D134/D147):"
echo "       up -d --force-recreate --no-deps <svc>   with  -f docker-compose.override.yml"
echo "       NEVER --remove-orphans, NEVER a bare 'up -d', NEVER 'compose down'"
exit 1
