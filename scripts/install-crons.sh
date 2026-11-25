#!/usr/bin/env bash
# install-crons.sh — the ONE way Open Brain host cron lines are installed (item 7.3).
#
# Builds a managed block from the cron lines (non-blank, non-comment) of every
# deploy/cron/*.cron template and writes it to the Unraid persistent cron table
# (/boot/config/plugins/dynamix/custom.cron), then reloads cron and checks that every line
# reached /etc/cron.d/root.
#
#   bash scripts/install-crons.sh            dry run (default): print a diff, write nothing
#   bash scripts/install-crons.sh --apply    write (as root)
#
# What --apply does, in order:
#   1. copies custom.cron to custom.cron.bak-<UTC timestamp> beside it (only when it changes);
#   2. drops every UNMANAGED line that names /mnt/user/appdata/open-brain or an `open-brain-`
#      container/log (the old hand-installed Open Brain lines, e.g. the backup line);
#      lines that do not name Open Brain, and all comments, are left exactly as they are;
#   3. rewrites the block between "# >>> open-brain managed" and "# <<< open-brain managed"
#      (last thing in the file). Idempotent: a second run changes nothing;
#   4. runs update_cron and checks each installed line against /etc/cron.d/root.
#
# NEVER install an Open Brain job with `crontab -e`: Unraid keeps user crontabs in RAM and a
# reboot erases them (Entry 253: no backup ran for 76 days). Nothing secret goes into the
# block; each line sources .env.secrets at run time.
#
# ROLLBACK: cp custom.cron.bak-<timestamp> custom.cron && /usr/local/sbin/update_cron
#
# Test/override variables (all optional):
#   CUSTOM_CRON       cron table to edit            (default /boot/config/plugins/dynamix/custom.cron)
#   CRON_VERIFY_FILE  merged table to check         (default /etc/cron.d/root)
#   UPDATE_CRON_CMD   reload command                (default /usr/local/sbin/update_cron)
#   CRON_TEMPLATE_DIR template directory            (default <repo>/deploy/cron)
#   INSTALL_CRONS_ALLOW_NONROOT=1   skip the root check on --apply (tests only)
#
# Exit: 0 ok; 1 verify failed or a step failed; 2 usage / not root / no templates.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
CUSTOM_CRON="${CUSTOM_CRON:-/boot/config/plugins/dynamix/custom.cron}"
CRON_VERIFY_FILE="${CRON_VERIFY_FILE:-/etc/cron.d/root}"
UPDATE_CRON_CMD="${UPDATE_CRON_CMD:-/usr/local/sbin/update_cron}"
CRON_TEMPLATE_DIR="${CRON_TEMPLATE_DIR:-${REPO_DIR}/deploy/cron}"
BEGIN_MARK='# >>> open-brain managed'
END_MARK='# <<< open-brain managed'

MODE=dry-run
case "${1:-}" in
  ''|--dry-run) MODE=dry-run ;;
  --apply) MODE=apply ;;
  *) echo "usage: install-crons.sh [--dry-run|--apply]" >&2; exit 2 ;;
esac

if [[ "$MODE" == apply && "${INSTALL_CRONS_ALLOW_NONROOT:-}" != 1 && "$(id -u)" -ne 0 ]]; then
  echo "install-crons.sh --apply must run as root (/boot/config is root-only)" >&2
  exit 2
fi

shopt -s nullglob
TEMPLATES=("${CRON_TEMPLATE_DIR}"/*.cron)
shopt -u nullglob
if [[ ${#TEMPLATES[@]} -eq 0 ]]; then
  echo "no templates in ${CRON_TEMPLATE_DIR}" >&2
  exit 2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- cron lines from the templates (sorted by file name, duplicates dropped) ---
: > "${WORK}/lines"
for t in "${TEMPLATES[@]}"; do
  n=$(grep -cvE '^[[:space:]]*(#|$)' "$t" || true)
  echo "template $(basename "$t"): ${n} cron line(s)" >&2
  grep -vE '^[[:space:]]*(#|$)' "$t" >> "${WORK}/lines" || true
done
awk '!seen[$0]++' "${WORK}/lines" > "${WORK}/lines.u"
LINE_COUNT=$(wc -l < "${WORK}/lines.u")
if [[ "$LINE_COUNT" -eq 0 ]]; then
  echo "templates hold no cron lines" >&2
  exit 2
fi
echo "managed block: ${LINE_COUNT} cron line(s)" >&2

# --- current table (absent = empty) ---
CURRENT="${WORK}/current"
if [[ -f "$CUSTOM_CRON" ]]; then cp "$CUSTOM_CRON" "$CURRENT"; else : > "$CURRENT"; fi

# --- remainder: drop the old managed block and unmanaged Open Brain lines ---
awk -v b="$BEGIN_MARK" -v e="$END_MARK" '
  $0 == b { skip = 1; next }
  $0 == e { skip = 0; next }
  skip    { next }
  /^[[:space:]]*#/ { print; next }
  index($0, "/mnt/user/appdata/open-brain") || index($0, "open-brain-") { dropped++; print "dropped unmanaged line: " substr($0, 1, 100) > "/dev/stderr"; next }
  { print }
' "$CURRENT" > "${WORK}/rest.raw"

# trim trailing blank lines so the block always lands after exactly one blank line
awk '{ a[NR] = $0 } END { n = NR; while (n > 0 && a[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print a[i] }' \
  "${WORK}/rest.raw" > "${WORK}/rest"

NEW="${WORK}/new"
{
  if [[ -s "${WORK}/rest" ]]; then cat "${WORK}/rest"; echo; fi
  echo "$BEGIN_MARK"
  echo "# Written by scripts/install-crons.sh from deploy/cron/*.cron. Do not edit by hand."
  cat "${WORK}/lines.u"
  echo "$END_MARK"
} > "$NEW"

CHANGED=1
if cmp -s "$CURRENT" "$NEW" && [[ -f "$CUSTOM_CRON" ]]; then CHANGED=0; fi

if [[ "$MODE" == dry-run ]]; then
  if [[ "$CHANGED" -eq 0 ]]; then
    echo "dry run: no difference — ${CUSTOM_CRON} is up to date"
  else
    echo "dry run: --apply would change ${CUSTOM_CRON}:"
    diff -u "$CURRENT" "$NEW" | sed -e "1s|.*|--- ${CUSTOM_CRON} (current)|" -e "2s|.*|+++ ${CUSTOM_CRON} (new)|" || true
  fi
  exit 0
fi

# --- apply ---
if [[ "$CHANGED" -eq 1 ]]; then
  if [[ -f "$CUSTOM_CRON" ]]; then
    BAK="${CUSTOM_CRON}.bak-$(date -u +%Y%m%dT%H%M%SZ)"
    cp -p "$CUSTOM_CRON" "$BAK"
    echo "backed up ${CUSTOM_CRON} -> ${BAK}"
  fi
  TMP="${CUSTOM_CRON}.new.$$"
  cat "$NEW" > "$TMP"
  chmod --reference="$CUSTOM_CRON" "$TMP" 2>/dev/null || chmod 0644 "$TMP" 2>/dev/null || true
  mv -f "$TMP" "$CUSTOM_CRON"
  echo "wrote ${CUSTOM_CRON}"
else
  echo "no change to ${CUSTOM_CRON}"
fi

if ! $UPDATE_CRON_CMD; then
  echo "FAIL: ${UPDATE_CRON_CMD} failed" >&2
  exit 1
fi

MISSING=0
while IFS= read -r line; do
  if ! grep -qxF -- "$line" "$CRON_VERIFY_FILE" 2>/dev/null; then
    echo "FAIL: not in ${CRON_VERIFY_FILE}: ${line:0:90}" >&2
    MISSING=$((MISSING + 1))
  fi
done < "${WORK}/lines.u"
if [[ "$MISSING" -gt 0 ]]; then
  echo "FAIL: ${MISSING} cron line(s) missing from ${CRON_VERIFY_FILE}" >&2
  exit 1
fi
echo "verified: ${LINE_COUNT} line(s) present in ${CRON_VERIFY_FILE}"
