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
#   OFFSITE_RETAIN    default: 30d  (remote files older than this are pruned)
#   RCLONE_IMAGE      default: rclone/rclone:latest
#   PUSHOVER_API_URL  see scripts/lib/pushover-notify.sh (mock-able)
#
# Exit codes:
#   0 — copy + prune succeeded
#   1 — rclone copy failed (Pushover priority-1 alert sent)
#   2 — precondition failure (backup root or rclone config missing)

set -uo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/mnt/user/backup/openbrain}"
RCLONE_CONF_DIR="${RCLONE_CONF_DIR:-/mnt/user/appdata/rclone-onedrive/config}"
OFFSITE_REMOTE="${OFFSITE_REMOTE:-open-brain-offsite:}"
OFFSITE_MAX_AGE="${OFFSITE_MAX_AGE:-2d}"
OFFSITE_RETAIN="${OFFSITE_RETAIN:-30d}"
RCLONE_IMAGE="${RCLONE_IMAGE:-rclone/rclone:latest}"

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
  docker run --rm \
    -v "${RCLONE_CONF_DIR}:/config/rclone" \
    -v "${BACKUP_ROOT}:/backup:ro" \
    "$RCLONE_IMAGE" "$@" --config /config/rclone/rclone.conf
}

# --- 1. Copy new backup files to the crypt remote ---
echo "[1/3] Copying ${BACKUP_ROOT} -> ${OFFSITE_REMOTE} (max-age ${OFFSITE_MAX_AGE})..."
if ! run_rclone copy /backup "$OFFSITE_REMOTE" --max-age "$OFFSITE_MAX_AGE" --transfers 2 --stats-one-line --stats 30s; then
  fail 1 "rclone copy to ${OFFSITE_REMOTE} failed — see /var/log/open-brain-offsite-backup.log"
fi

# --- 2. Prune remote files outside the retention window ---
echo "[2/3] Pruning ${OFFSITE_REMOTE} files older than ${OFFSITE_RETAIN}..."
if ! run_rclone delete "$OFFSITE_REMOTE" --min-age "$OFFSITE_RETAIN"; then
  # Prune failure is non-fatal (next run retries) but worth a warning line.
  echo "WARN: remote prune failed — retention window will catch up on the next run" >&2
fi
run_rclone rmdirs "$OFFSITE_REMOTE" --leave-root || true

# --- 3. Report ---
echo "[3/3] Remote usage:"
run_rclone size "$OFFSITE_REMOTE" || true

echo "=== Offsite backup complete: $(date +%Y-%m-%dT%H:%M:%S%z) ==="
