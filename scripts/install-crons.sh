#!/usr/bin/env bash
# install-crons.sh — the ONE way Open Brain host cron lines are installed (item 7.3).
#
# Builds a managed block from the cron lines (non-blank, non-comment) of every
# deploy/cron/*.cron template and writes it to the Unraid persistent cron table
# (/boot/config/plugins/dynamix/custom.cron), then reloads cron and checks that every line
# reached /etc/cron.d/root.
#
#   bash scripts/install-crons.sh            dry run (default): print a diff, write nothing
#                                            (no backup, no reload). Needs READ access to
#                                            custom.cron only — on Unraid that is still root.
#   bash scripts/install-crons.sh --apply    write (as root)
#
# Refuses (exit 2, nothing written) when custom.cron holds anything but no managed block or
# exactly one begin marker followed by one end marker.
#
# What --apply does, in order:
#   1. copies custom.cron to custom.cron.bak-<UTC timestamp> beside it (only when it changes);
#   2. drops every UNMANAGED line that names the app dir /mnt/user/appdata/open-brain (followed
#      by /, whitespace, a quote or end of line — open-brain-config-backup is NOT a match) or an
#      `open-brain-` container/log (the old hand-installed Open Brain lines, e.g. the backup
#      line); lines that do not name Open Brain, and all comments, are left exactly as they are.
#      Each dropped line with no byte-identical template line is printed under
#      "REMOVED, NOT REPLACED" (dry run and apply) — read that list before applying;
#   3. rewrites the block between "# >>> open-brain managed" and "# <<< open-brain managed"
#      (last thing in the file). Idempotent: a second run changes nothing;
#   4. runs update_cron and checks each installed line appears EXACTLY once in /etc/cron.d/root.
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

# --- current table (absent = empty). Read-only: a dry run writes nothing outside $WORK ---
CURRENT="${WORK}/current"
if [[ -e "$CUSTOM_CRON" ]]; then
  if [[ ! -r "$CUSTOM_CRON" ]]; then
    echo "cannot read ${CUSTOM_CRON} — /boot/config is root-only; run as root (even for a dry run)" >&2
    exit 2
  fi
  cat "$CUSTOM_CRON" > "$CURRENT"
else
  : > "$CURRENT"
fi

# --- markers: refuse anything but no block, or exactly one begin followed by one end ---
# (a lone begin marker would otherwise swallow every line after it)
NB=$(grep -cxF -- "$BEGIN_MARK" "$CURRENT" || true)
NE=$(grep -cxF -- "$END_MARK" "$CURRENT" || true)
if ! { [[ "$NB" -eq 0 && "$NE" -eq 0 ]] || [[ "$NB" -eq 1 && "$NE" -eq 1 ]]; }; then
  echo "refusing: ${CUSTOM_CRON} holds ${NB} begin and ${NE} end marker(s); expected none or one pair — fix it by hand, nothing written" >&2
  exit 2
fi
if [[ "$NB" -eq 1 ]]; then
  LB=$(grep -nxF -- "$BEGIN_MARK" "$CURRENT" | cut -d: -f1)
  LE=$(grep -nxF -- "$END_MARK" "$CURRENT" | cut -d: -f1)
  if [[ "$LB" -ge "$LE" ]]; then
    echo "refusing: end marker (line ${LE}) comes before begin marker (line ${LB}) in ${CUSTOM_CRON} — fix it by hand, nothing written" >&2
    exit 2
  fi
fi

# --- remainder: drop the old managed block and unmanaged Open Brain lines ---
# An Open Brain line names the app dir /mnt/user/appdata/open-brain (followed by /, space,
# quote or end of line — NOT open-brain-config-backup and the like) or an `open-brain-`
# container/log name outside /mnt/user/appdata/. Dropped lines go to rest.dropped.
awk -v b="$BEGIN_MARK" -v e="$END_MARK" -v dropf="${WORK}/rest.dropped" '
  $0 == b { skip = 1; next }
  $0 == e { skip = 0; next }
  skip    { next }
  /^[[:space:]]*#/ { print; next }
  {
    s = $0
    if (s ~ /\/mnt\/user\/appdata\/open-brain([\/[:space:]"'\'']|$)/) { print $0 > dropf; next }
    gsub(/\/mnt\/user\/appdata\/open-brain-[^[:space:]"'\'']*/, "", s)
    if (index(s, "open-brain-")) { print $0 > dropf; next }
    print
  }
' "$CURRENT" > "${WORK}/rest.raw"
touch "${WORK}/rest.dropped"
# dropped lines with no byte-identical template line: they vanish without a replacement
grep -vxF -f "${WORK}/lines.u" "${WORK}/rest.dropped" > "${WORK}/rest.lost" || true
report_dropped() {
  local n
  n=$(wc -l < "${WORK}/rest.dropped")
  [[ "$n" -gt 0 ]] && echo "dropped ${n} unmanaged Open Brain line(s) (replaced by the managed block where a template line is identical)" >&2
  if [[ -s "${WORK}/rest.lost" ]]; then
    echo "REMOVED, NOT REPLACED ($(wc -l < "${WORK}/rest.lost") line(s) with no identical template line — check each is intended):"
    sed 's/^/  /' "${WORK}/rest.lost"
  fi
  return 0
}

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
    report_dropped
  fi
  exit 0
fi

# --- apply ---
if [[ "$CHANGED" -eq 1 ]]; then
  report_dropped
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

# each managed line must appear EXACTLY once: 0 = not installed, >1 = the job runs twice
MISSING=0; DUPS=0
while IFS= read -r line; do
  c=$(grep -cxF -- "$line" "$CRON_VERIFY_FILE" 2>/dev/null || true)
  c=${c:-0}
  if [[ "$c" -eq 0 ]]; then
    echo "FAIL: not in ${CRON_VERIFY_FILE}: ${line:0:90}" >&2
    MISSING=$((MISSING + 1))
  elif [[ "$c" -gt 1 ]]; then
    echo "FAIL: ${c} copies in ${CRON_VERIFY_FILE} (the job would run ${c} times): ${line:0:90}" >&2
    DUPS=$((DUPS + 1))
  fi
done < "${WORK}/lines.u"
if [[ "$MISSING" -gt 0 ]]; then
  echo "FAIL: ${MISSING} cron line(s) missing from ${CRON_VERIFY_FILE}" >&2
fi
if [[ "$DUPS" -gt 0 ]]; then
  echo "FAIL: ${DUPS} cron line(s) appear more than once in ${CRON_VERIFY_FILE} — remove the extra copies" >&2
fi
[[ "$MISSING" -eq 0 && "$DUPS" -eq 0 ]] || exit 1
echo "verified: ${LINE_COUNT} line(s) present exactly once in ${CRON_VERIFY_FILE}"
