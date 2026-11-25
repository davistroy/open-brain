#!/usr/bin/env bash
# offsite-backup.sh — Daily encrypted offsite copy of the Open Brain backup tree.
#
# Implements the TDD §16 offsite design (arch-review v3 RC-1): rclone copy of
# /mnt/user/backup/openbrain to an rclone crypt remote on Google Drive with a
# 30-day cloud retention window. Runs on the Unraid host via cron at 03:45
# (after backup.sh at 03:00). Install: deploy/cron/unraid-offsite-backup.cron.
#
# The crypt remote [open-brain-offsite] lives in the rclone config at
# RCLONE_CONF_DIR (NOT in this repo — it contains obscured credentials).
# Crypt password + salt: BWS secrets `open-brain-rclone-crypt-password` /
# `open-brain-rclone-crypt-salt` (ai-work project). To recreate the remote
# after a rebuild — and for the restore procedure — see
# docs/runbooks/offsite-backup.md.
#
# Env overrides (test-harness friendly — same pattern as backup.sh):
#   BACKUP_ROOT       default: /mnt/user/backup/openbrain
#   RCLONE_CONF_DIR   default: /mnt/user/appdata/rclone-onedrive/config
#   OFFSITE_REMOTE    default: open-brain-offsite:
#   OFFSITE_MAX_AGE   default: 2d   ("off" = full seed copy of the whole tree)
#   OFFSITE_RETAIN_DAILY   default: 30d   (remote daily/ files older than this are pruned)
#   OFFSITE_RETAIN_WEEKLY  default: 35d
#   OFFSITE_RETAIN_MONTHLY default: 100d
#   OFFSITE_SOURCE_MAX_AGE_HOURS default: 48 (newest local daily dump older than
#                     this = stale source: prune skipped, exit 1; the same window
#                     is the remote-freshness check after the copy)
#   RCLONE_CMD        default: unset (production = pinned rclone image via docker).
#                     Test hook: a command that stands in for rclone.
#   RCLONE_IMAGE      default: rclone/rclone:1.76.0
#   PUSHOVER_API_URL  see scripts/lib/pushover-notify.sh (mock-able)
#
# Exit codes:
#   0 — copy + prune succeeded; ${BACKUP_ROOT}/.offsite-last-success written
#   1 — rclone copy failed, local source stale (prune skipped), or no fresh dump
#       on the remote after the copy (Pushover priority-1 alert sent)
#   2 — precondition failure (backup root or rclone config missing)

set -uo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/mnt/user/backup/openbrain}"
RCLONE_CONF_DIR="${RCLONE_CONF_DIR:-/mnt/user/appdata/rclone-onedrive/config}"
OFFSITE_REMOTE="${OFFSITE_REMOTE:-open-brain-offsite:}"
OFFSITE_MAX_AGE="${OFFSITE_MAX_AGE:-2d}"
OFFSITE_RETAIN_DAILY="${OFFSITE_RETAIN_DAILY:-30d}"
OFFSITE_RETAIN_WEEKLY="${OFFSITE_RETAIN_WEEKLY:-35d}"
OFFSITE_RETAIN_MONTHLY="${OFFSITE_RETAIN_MONTHLY:-100d}"
OFFSITE_SOURCE_MAX_AGE_HOURS="${OFFSITE_SOURCE_MAX_AGE_HOURS:-48}"
RCLONE_CMD="${RCLONE_CMD:-}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:1.76.0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/pushover-notify.sh
source "${SCRIPT_DIR}/lib/pushover-notify.sh"

TIMESTAMP=$(date +%Y-%m-%dT%H:%M:%S%z)
echo "=== Open Brain offsite backup: ${TIMESTAMP} ==="

fail() {
  local code="$1"
  local msg="$2"
  echo "ERROR: ${msg}" >&2
  PUSHOVER_TITLE="Open Brain: offsite backup FAILED" \
    notify_pushover_mismatch "${msg} (${TIMESTAMP})" || true
  exit "$code"
}

# --- Preconditions ---
[ -d "$BACKUP_ROOT" ] || fail 2 "backup root ${BACKUP_ROOT} not found"
[ -f "${RCLONE_CONF_DIR}/rclone.conf" ] || fail 2 "rclone config not found in ${RCLONE_CONF_DIR}"

run_rclone() {
  if [ -n "$RCLONE_CMD" ]; then
    # Test hook: stub rclone, no docker.
    # shellcheck disable=SC2086
    $RCLONE_CMD "$@" --config "${RCLONE_CONF_DIR}/rclone.conf"
    return
  fi
  docker run --rm \
    -v "${RCLONE_CONF_DIR}:/config/rclone" \
    -v "${BACKUP_ROOT}:/backup:ro" \
    "$RCLONE_IMAGE" "$@" --config /config/rclone/rclone.conf
}

# Source path as the rclone process sees it (container mount vs. host path).
if [ -n "$RCLONE_CMD" ]; then SRC="$BACKUP_ROOT"; else SRC=/backup; fi

# --- 1. Copy new backup files to the crypt remote ---
echo "[1/4] Copying ${BACKUP_ROOT} -> ${OFFSITE_REMOTE} (max-age ${OFFSITE_MAX_AGE})..."
if ! run_rclone copy "$SRC" "$OFFSITE_REMOTE" --max-age "$OFFSITE_MAX_AGE" --transfers 2 --stats-one-line --stats 30s; then
  fail 1 "rclone copy to ${OFFSITE_REMOTE} failed — see /var/log/open-brain-offsite-backup.log"
fi

# --- 2. Guards: never prune on a stale source; the remote must hold a fresh dump ---
# A prune is age-based, so when the local backup stops, pruning would drain the
# remote to empty while every run still "succeeded" (2026-09 incident).
newest_epoch=0
for f in "${BACKUP_ROOT}"/daily/*/openbrain.pgdump; do
  [ -f "$f" ] || continue
  m=$(stat -c %Y "$f" 2>/dev/null || echo 0)
  [ "$m" -gt "$newest_epoch" ] && newest_epoch="$m"
done
now_epoch=$(date +%s)
max_age_s=$(( OFFSITE_SOURCE_MAX_AGE_HOURS * 3600 ))
if [ "$newest_epoch" -eq 0 ]; then
  fail 1 "no local daily/*/openbrain.pgdump under ${BACKUP_ROOT} — prune skipped"
elif [ $(( now_epoch - newest_epoch )) -gt "$max_age_s" ]; then
  fail 1 "newest local dump is $(( (now_epoch - newest_epoch) / 3600 ))h old (> ${OFFSITE_SOURCE_MAX_AGE_HOURS}h) — prune skipped"
fi

# --files-only is load-bearing: filters and --max-age apply to files only, so
# without it lsf -R lists every dated directory and the listing is never empty.
fresh_listing=$(run_rclone lsf -R --files-only --max-age "${OFFSITE_SOURCE_MAX_AGE_HOURS}h" --include '*/openbrain.pgdump' "${OFFSITE_REMOTE}daily") \
  || fail 1 "could not list ${OFFSITE_REMOTE}daily after the copy — prune skipped"
[ -n "$fresh_listing" ] || fail 1 "no openbrain.pgdump newer than ${OFFSITE_SOURCE_MAX_AGE_HOURS}h on ${OFFSITE_REMOTE}daily after the copy — prune skipped"

# --- 3. Prune per tier (canary/** is never pruned) ---
prune_tier() {
  local tier="$1" retain="$2"
  echo "[2/4] Pruning ${OFFSITE_REMOTE}${tier} files older than ${retain}..."
  if ! run_rclone delete "${OFFSITE_REMOTE}${tier}" --min-age "$retain" --exclude 'canary/**'; then
    # Prune failure is non-fatal (next run retries) but worth a warning line.
    echo "WARN: ${tier} prune failed — retention window will catch up on the next run" >&2
  fi
  run_rclone rmdirs "${OFFSITE_REMOTE}${tier}" --leave-root || true
}
prune_tier daily   "$OFFSITE_RETAIN_DAILY"
prune_tier weekly  "$OFFSITE_RETAIN_WEEKLY"
prune_tier monthly "$OFFSITE_RETAIN_MONTHLY"

# --- 4. Report ---
echo "[4/4] Remote usage:"
run_rclone size "$OFFSITE_REMOTE" || true

date +%Y-%m-%dT%H:%M:%S%z > "${BACKUP_ROOT}/.offsite-last-success" \
  || echo "WARN: could not write ${BACKUP_ROOT}/.offsite-last-success" >&2

echo "=== Offsite backup complete: $(date +%Y-%m-%dT%H:%M:%S%z) ==="
