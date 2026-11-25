#!/usr/bin/env bash
# test-offsite-backup.sh — harness for scripts/offsite-backup.sh (item 7.1).
# Stubs rclone via RCLONE_CMD (logs argv) and curl via PATH (logs Pushover
# calls). Touches no network, no docker, no real remote.
# shellcheck disable=SC2016
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${REPO}/scripts/offsite-backup.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAILN=0
ok()   { PASS=$((PASS+1)); echo "  ok   - $1"; }
bad()  { FAILN=$((FAILN+1)); echo "  FAIL - $1"; }
check() { # check <desc> <cmd...>
  local d="$1"; shift
  if "$@"; then ok "$d"; else bad "$d"; fi
}

# --- stubs ---
mkdir -p "$WORK/bin"
cat > "$WORK/stub-rclone.sh" <<'STUB'
#!/usr/bin/env bash
echo "$*" >> "$RCLONE_LOG"
if [ "$1" = "lsf" ]; then
  # Real rclone (1.76.0, verified on a local tree): filters and --max-age apply to
  # files only, so `lsf -R` without --files-only lists every dated directory even
  # when no file matches. Mirror that, so a check missing --files-only goes RED.
  case " $* " in
    *" --files-only "*) ;;
    *) printf '2026-11-10/\n2026-11-24/\n' ;;
  esac
  [ -f "$STUB_LSF_OUT" ] && cat "$STUB_LSF_OUT"
fi
exit 0
STUB
cat > "$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >> "$CURL_LOG"
exit 0
STUB
chmod +x "$WORK/stub-rclone.sh" "$WORK/bin/curl"

# run_case <name> <dump-age-hours|none> <lsf-output-or-empty>
# Sets: RC, CASE_DIR, RCLONE_LOG, CURL_LOG, BACKUP_ROOT_T, OUT
run_case() {
  local name="$1" age="$2" lsf="$3"
  CASE_DIR="$WORK/$name"
  BACKUP_ROOT_T="$CASE_DIR/backup"
  mkdir -p "$BACKUP_ROOT_T/daily/2026-11-25" "$CASE_DIR/conf"
  : > "$CASE_DIR/conf/rclone.conf"
  if [ "$age" != "none" ]; then
    echo dump > "$BACKUP_ROOT_T/daily/2026-11-25/openbrain.pgdump"
    touch -d "${age} hours ago" "$BACKUP_ROOT_T/daily/2026-11-25/openbrain.pgdump"
  fi
  RCLONE_LOG="$CASE_DIR/rclone.log"; CURL_LOG="$CASE_DIR/curl.log"
  : > "$RCLONE_LOG"; : > "$CURL_LOG"
  printf '%s' "$lsf" > "$CASE_DIR/lsf.out"
  OUT="$(env -i PATH="$WORK/bin:$PATH" HOME="$CASE_DIR" \
    BACKUP_ROOT="$BACKUP_ROOT_T" RCLONE_CONF_DIR="$CASE_DIR/conf" \
    RCLONE_CMD="$WORK/stub-rclone.sh" RCLONE_LOG="$RCLONE_LOG" \
    STUB_LSF_OUT="$CASE_DIR/lsf.out" CURL_LOG="$CURL_LOG" \
    PUSHOVER_APP_TOKEN=t PUSHOVER_USER_KEY=u PUSHOVER_API_URL=http://127.0.0.1:9/x \
    bash "$SCRIPT" 2>&1)"
  RC=$?
  echo "$OUT" > "$CASE_DIR/out.log"
}

has_prune() { grep -Eq '^(delete|deletefile|purge|rmdirs) ' "$RCLONE_LOG"; }

echo "case 1: stale local source (60h) -> no prune, exit 1, notification"
run_case stale 60 "daily/2026-11-25/openbrain.pgdump"$'\n'
check "exit code is 1" test "$RC" -eq 1
# shellcheck disable=SC2016
check "no prune call (delete/rmdirs)" bash -c '! grep -Eq "^(delete|deletefile|purge|rmdirs) " "$1"' _ "$RCLONE_LOG"
check "failure notification sent" grep -q 'curl' "$CURL_LOG"
check "no success marker" test ! -e "$BACKUP_ROOT_T/.offsite-last-success"

echo "case 1b: no local dump at all -> no prune, exit 1"
run_case nodump none "daily/x/openbrain.pgdump"$'\n'
check "exit code is 1" test "$RC" -eq 1
check "no prune call" bash -c '! grep -Eq "^(delete|deletefile|purge|rmdirs) " "$1"' _ "$RCLONE_LOG"

echo "case 2: empty remote listing -> exit 1"
run_case emptyremote 1 ""
check "exit code is 1" test "$RC" -eq 1
check "lsf was called with the freshness filter" grep -Eq "^lsf -R .*--max-age 48h --include \*/openbrain.pgdump .*daily" "$RCLONE_LOG"
check "lsf lists files only (dirs would make the check always pass)" grep -Eq "^lsf .*--files-only" "$RCLONE_LOG"
check "no prune on an empty remote" bash -c '! grep -Eq "^(delete|deletefile|purge|rmdirs) " "$1"' _ "$RCLONE_LOG"
check "no success marker" test ! -e "$BACKUP_ROOT_T/.offsite-last-success"
check "failure notification sent" grep -q 'curl' "$CURL_LOG"

echo "case 3: fresh source + fresh remote -> copy, per-tier prune, marker"
run_case fresh 1 "daily/2026-11-25/openbrain.pgdump"$'\n'
check "exit code is 0" test "$RC" -eq 0
check "copy called with --max-age 2d" grep -Eq '^copy .* --max-age 2d' "$RCLONE_LOG"
check "daily pruned at 30d" grep -Eq '^delete .*daily.* --min-age 30d' "$RCLONE_LOG"
check "weekly pruned at 35d" grep -Eq '^delete .*weekly.* --min-age 35d' "$RCLONE_LOG"
check "monthly pruned at 100d" grep -Eq '^delete .*monthly.* --min-age 100d' "$RCLONE_LOG"
check "every delete excludes canary/**" bash -c 'n=$(grep -Ec "^delete " "$1"); m=$(grep -E "^delete " "$1" | grep -Fc -- "--exclude canary/**"); [ "$n" -eq 3 ] && [ "$m" -eq 3 ]' _ "$RCLONE_LOG"
check "no whole-remote delete (root prune)" bash -c '! grep -Eq "^delete [^ ]*: " "$1"' _ "$RCLONE_LOG"
check "never uses rclone sync" bash -c '! grep -Eq "^sync " "$1"' _ "$RCLONE_LOG"
check "marker written" test -s "$BACKUP_ROOT_T/.offsite-last-success"

echo
echo "passed=${PASS} failed=${FAILN}"
[ "$FAILN" -eq 0 ]
