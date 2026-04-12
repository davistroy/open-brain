#!/usr/bin/env bash
# setup-rclone.sh — Configure rclone/rsync sync from local OneDrive mirror
# to Open Brain staging directory on homeserver.
#
# The homeserver already runs a OneDrive Docker app that syncs OneDrive files
# to a local mirror directory. This script sets up a 15-minute cron job that
# rsyncs from that mirror into the Open Brain staging area for processing.
#
# Usage:
#   ssh root@homeserver.k4jda.net
#   bash /path/to/setup-rclone.sh
#
# Prerequisites:
#   - OneDrive Docker app already running and syncing to ONEDRIVE_MIRROR_DIR
#   - rsync installed (standard on Unraid)

set -euo pipefail

# --- Configuration ---
# OneDrive Docker app mirror directory (where OneDrive files land on homeserver)
ONEDRIVE_MIRROR_DIR="${ONEDRIVE_MIRROR_DIR:-/mnt/user/OneDrive}"

# Open Brain staging directory (where file-ingestion reads from)
STAGING_DIR="${STAGING_DIR:-/mnt/user/openbrain/staging}"

# Cron interval (every 15 minutes)
CRON_SCHEDULE="*/15 * * * *"

# Log file
LOG_FILE="/var/log/openbrain-sync.log"

# --- Validation ---
if [[ ! -d "$ONEDRIVE_MIRROR_DIR" ]]; then
    echo "ERROR: OneDrive mirror directory not found: $ONEDRIVE_MIRROR_DIR"
    echo "Set ONEDRIVE_MIRROR_DIR to the correct path and re-run."
    exit 1
fi

# --- Create staging directory ---
echo "Creating staging directory: $STAGING_DIR"
mkdir -p "$STAGING_DIR"
chmod 755 "$STAGING_DIR"

# --- Create sync script ---
SYNC_SCRIPT="/usr/local/bin/openbrain-sync.sh"
echo "Creating sync script: $SYNC_SCRIPT"
cat > "$SYNC_SCRIPT" << 'SYNCEOF'
#!/usr/bin/env bash
# openbrain-sync.sh — rsync from OneDrive mirror to Open Brain staging
set -euo pipefail

ONEDRIVE_MIRROR_DIR="${ONEDRIVE_MIRROR_DIR:-/mnt/user/OneDrive}"
STAGING_DIR="${STAGING_DIR:-/mnt/user/openbrain/staging}"
LOG_FILE="/var/log/openbrain-sync.log"
LOCK_FILE="/tmp/openbrain-sync.lock"

# Prevent concurrent runs
if [[ -f "$LOCK_FILE" ]]; then
    pid=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        echo "$(date -Iseconds) SKIP: Previous sync still running (PID $pid)" >> "$LOG_FILE"
        exit 0
    fi
    # Stale lock — remove it
    rm -f "$LOCK_FILE"
fi

echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# rsync with:
#   -a: archive mode (preserves timestamps, permissions)
#   --delete: remove files from staging that were deleted from mirror
#   --exclude: skip temp/cache files
#   --info=stats2: summary statistics only (not per-file)
echo "$(date -Iseconds) START: Syncing $ONEDRIVE_MIRROR_DIR -> $STAGING_DIR" >> "$LOG_FILE"

rsync -a \
    --delete \
    --exclude='*.tmp' \
    --exclude='~$*' \
    --exclude='.~lock.*' \
    --exclude='Thumbs.db' \
    --exclude='.DS_Store' \
    --exclude='*.crdownload' \
    --info=stats2 \
    "$ONEDRIVE_MIRROR_DIR/" \
    "$STAGING_DIR/" \
    >> "$LOG_FILE" 2>&1

echo "$(date -Iseconds) DONE: Sync complete" >> "$LOG_FILE"
SYNCEOF

chmod +x "$SYNC_SCRIPT"

# --- Install cron job ---
echo "Installing cron job (every 15 minutes)"
CRON_LINE="$CRON_SCHEDULE $SYNC_SCRIPT"

# Remove existing openbrain-sync entry if present, then add fresh
crontab -l 2>/dev/null | grep -v 'openbrain-sync' | { cat; echo "$CRON_LINE"; } | crontab -

# --- Run initial sync ---
echo "Running initial sync..."
"$SYNC_SCRIPT"

# --- Summary ---
echo ""
echo "Setup complete:"
echo "  Source:    $ONEDRIVE_MIRROR_DIR"
echo "  Staging:   $STAGING_DIR"
echo "  Cron:      $CRON_SCHEDULE"
echo "  Script:    $SYNC_SCRIPT"
echo "  Log:       $LOG_FILE"
echo ""
echo "To check sync status:  tail -20 $LOG_FILE"
echo "To run manually:       $SYNC_SCRIPT"
echo "To verify cron:        crontab -l | grep openbrain"
