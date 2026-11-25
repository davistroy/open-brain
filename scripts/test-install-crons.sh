#!/usr/bin/env bash
# test-install-crons.sh — harness for scripts/install-crons.sh (item 7.3).
#
# Runs the real installer against a fixture custom.cron in a temp dir. The reload command is
# a stub that copies custom.cron to the "merged" table, the way Unraid's update_cron builds
# /etc/cron.d/root. Nothing on the host is touched.
#
# Cases:
#   A  --dry-run (the default) prints a diff and writes nothing (no change, no backup file)
#   B  --apply: exactly one scripts/backup.sh line, inside the managed block; the unmanaged
#      backup + ingest lines are gone (no duplicates); the foreign job and all comments are
#      unchanged; custom.cron is backed up beside itself; every template line is installed
#   C  a second --apply changes nothing (byte-compare, no new backup file)
#   D  --dry-run after --apply reports no difference
#   E  verify failure: a reload that does not merge the lines makes --apply exit 1
#   F  an absent custom.cron is created; a failed reload exits 1
#   G  --apply as a non-root user without the test override exits 2 (skipped when run as root)
#   H  verify fails when a managed line appears TWICE in the merged table
#   I  /mnt/user/appdata/open-brain-config-backup lines are kept; dropped lines with no
#      identical template line are listed under "REMOVED, NOT REPLACED" (dry run + apply)
#   J  malformed markers (begin only, end only, end before begin, two pairs) are refused
#   K  non-root dry run on a read-only dir works; an unreadable table exits 2 with a message
#
# Usage: bash scripts/test-install-crons.sh      Exit 0 = all pass, 1 = failure.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALLER="${SCRIPT_DIR}/install-crons.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAILN=0
ok()    { PASS=$((PASS + 1)); echo "  ok   - $1"; }
bad()   { FAILN=$((FAILN + 1)); echo "  FAIL - $1"; }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }

FOREIGN='15 4 * * * /usr/local/bin/some-other-job --flag >> /var/log/other.log 2>&1'
write_fixture() { # write_fixture <custom.cron>
  cat > "$1" <<FIX
# Unraid host cron table (fixture)
${FOREIGN}

# old hand-installed Open Brain lines
0 3 * * * cd /mnt/user/appdata/open-brain && bash scripts/backup.sh >> /var/log/open-brain-backup.log 2>&1
0 6 * * * /usr/bin/docker exec open-brain-financial-ingest python /app/financial-pipeline.py --process-inbox >> /var/log/financial-ingest.log 2>&1
0 0 * * 6 /usr/local/bin/weekly-thing
FIX
}

# stub reload: merge custom.cron into the verify file, like update_cron
cat > "${WORK}/update-cron-ok" <<'SH'
#!/bin/sh
echo x >> "$STUB_CALLS"
cp "$CUSTOM_CRON" "$CRON_VERIFY_FILE"
SH
cat > "${WORK}/update-cron-noop" <<'SH'
#!/bin/sh
echo x >> "$STUB_CALLS"
: > "$CRON_VERIFY_FILE"
SH
cat > "${WORK}/update-cron-fail" <<'SH'
#!/bin/sh
exit 3
SH
chmod +x "${WORK}"/update-cron-*

new_case() { # new_case <name>
  CASE="$1"; D="${WORK}/${CASE}"; rm -rf "$D"; mkdir -p "$D"
  export CUSTOM_CRON="${D}/custom.cron" CRON_VERIFY_FILE="${D}/merged" STUB_CALLS="${D}/calls"
  : > "$STUB_CALLS"; : > "$CRON_VERIFY_FILE"
  export UPDATE_CRON_CMD="${WORK}/update-cron-ok" INSTALL_CRONS_ALLOW_NONROOT=1
  unset CRON_TEMPLATE_DIR
}
inst() { bash "$INSTALLER" "$@" > "${D}/out.log" 2> "${D}/err.log"; RC=$?; }
nbak() { find "$D" -maxdepth 1 -name 'custom.cron.bak-*' | wc -l; }
count() { grep -c -- "$1" "$2" || true; }

# Expected: every cron line of every template, once.
TEMPLATE_LINES="$(cat "${REPO_DIR}"/deploy/cron/*.cron | grep -vE '^[[:space:]]*(#|$)' | awk '!seen[$0]++')"
EXPECT_N=$(printf '%s\n' "$TEMPLATE_LINES" | wc -l)

echo "=== test-install-crons (item 7.3) ==="
echo "templates hold ${EXPECT_N} cron lines"

# ---------------- A ----------------
echo "[A] dry run writes nothing"
new_case A; write_fixture "$CUSTOM_CRON"; cp "$CUSTOM_CRON" "${D}/orig"
inst
check "A: default mode exits 0" test "$RC" -eq 0
check "A: custom.cron byte-identical" cmp -s "$CUSTOM_CRON" "${D}/orig"
check "A: no backup file written" test "$(nbak)" -eq 0
check "A: reload not run" test ! -s "$STUB_CALLS"
check "A: prints a diff naming the backup line" grep -q '^-0 3 \* \* \* cd /mnt/user/appdata/open-brain' "${D}/out.log"
inst --dry-run
check "A: explicit --dry-run behaves the same" cmp -s "$CUSTOM_CRON" "${D}/orig"

# ---------------- B ----------------
echo "[B] --apply"
new_case B; write_fixture "$CUSTOM_CRON"; cp "$CUSTOM_CRON" "${D}/orig"
inst --apply
check "B: exits 0" test "$RC" -eq 0
check "B: exactly one scripts/backup.sh line" test "$(count 'scripts/backup.sh' "$CUSTOM_CRON")" -eq 1
BLOCK="$(awk '/^# >>> open-brain managed/{f=1} f{print} /^# <<< open-brain managed/{f=0}' "$CUSTOM_CRON")"
check "B: the backup line sits inside the managed block" bash -c "printf '%s\n' \"\$1\" | grep -q 'scripts/backup.sh'" _ "$BLOCK"
check "B: block markers appear once each" test "$(count '^# >>> open-brain managed' "$CUSTOM_CRON")$(count '^# <<< open-brain managed' "$CUSTOM_CRON")" = 11
check "B: unmanaged ingest line absorbed (one financial-pipeline line)" test "$(count 'financial-pipeline.py' "$CUSTOM_CRON")" -eq 1
check "B: foreign job unchanged and present once" test "$(grep -cxF -- "$FOREIGN" "$CUSTOM_CRON")" -eq 1
check "B: second foreign job kept" grep -qxF '0 0 * * 6 /usr/local/bin/weekly-thing' "$CUSTOM_CRON"
check "B: comments kept" grep -qxF '# old hand-installed Open Brain lines' "$CUSTOM_CRON"
check "B: foreign job is outside the block" bash -c "! printf '%s\n' \"\$1\" | grep -qF some-other-job" _ "$BLOCK"
check "B: every template line installed exactly once" bash -c '
  while IFS= read -r l; do [ "$(grep -cxF -- "$l" "$1")" -eq 1 ] || exit 1; done <<< "$2"' _ "$CUSTOM_CRON" "$TEMPLATE_LINES"
check "B: managed block holds the template line count" test "$(printf '%s\n' "$BLOCK" | grep -vcE '^#')" -eq "$EXPECT_N"
check "B: one backup file, equal to the original" bash -c 'b=$(ls "$1"/custom.cron.bak-*); [ "$(echo "$b" | wc -l)" -eq 1 ] && cmp -s "$b" "$2"' _ "$D" "${D}/orig"
check "B: reload ran once" test "$(wc -l < "$STUB_CALLS")" -eq 1
check "B: verified against the merged table" grep -q '^verified:' "${D}/out.log"
cp "$CUSTOM_CRON" "${D}/after1"; B1=$(nbak)

# ---------------- C ----------------
echo "[C] second --apply changes nothing"
inst --apply
check "C: exits 0" test "$RC" -eq 0
check "C: custom.cron byte-identical" cmp -s "$CUSTOM_CRON" "${D}/after1"
check "C: no new backup file" test "$(nbak)" -eq "$B1"

# ---------------- D ----------------
echo "[D] dry run after apply"
inst
check "D: reports no difference" grep -q 'no difference' "${D}/out.log"
check "D: still byte-identical" cmp -s "$CUSTOM_CRON" "${D}/after1"

# ---------------- E ----------------
echo "[E] verify failure"
new_case E; write_fixture "$CUSTOM_CRON"
UPDATE_CRON_CMD="${WORK}/update-cron-noop" inst --apply
check "E: exits 1 when the lines never reach the merged table" test "$RC" -eq 1
check "E: names the verify failure" grep -q 'missing from' "${D}/err.log"

# ---------------- F ----------------
echo "[F] absent custom.cron; failed reload"
new_case F
inst --apply
check "F: exits 0 and creates custom.cron" test "$RC" -eq 0 -a -s "$CUSTOM_CRON"
check "F: block holds every template line" test "$(grep -cvE '^#' "$CUSTOM_CRON")" -eq "$EXPECT_N"
new_case F2; write_fixture "$CUSTOM_CRON"
UPDATE_CRON_CMD="${WORK}/update-cron-fail" inst --apply
check "F: failed reload exits 1" test "$RC" -eq 1

# ---------------- G ----------------
echo "[G] root check"
if [[ "$(id -u)" -eq 0 ]]; then
  echo "  skip - running as root"
else
  new_case G; write_fixture "$CUSTOM_CRON"; cp "$CUSTOM_CRON" "${D}/orig"
  env -u INSTALL_CRONS_ALLOW_NONROOT bash "$INSTALLER" --apply >/dev/null 2>&1; RC=$?
  check "G: non-root --apply exits 2" test "$RC" -eq 2
  check "G: nothing written" cmp -s "$CUSTOM_CRON" "${D}/orig"
fi

# ---------------- H ----------------
echo "[H] verify demands each line exactly once"
cat > "${WORK}/update-cron-dup" <<'SH'
#!/bin/sh
echo x >> "$STUB_CALLS"
cp "$CUSTOM_CRON" "$CRON_VERIFY_FILE"
grep 'scripts/backup.sh' "$CUSTOM_CRON" >> "$CRON_VERIFY_FILE"
SH
chmod +x "${WORK}/update-cron-dup"
new_case H; write_fixture "$CUSTOM_CRON"
UPDATE_CRON_CMD="${WORK}/update-cron-dup" inst --apply
check "H: a managed line present twice in the merged table exits non-zero" test "$RC" -ne 0
check "H: names the duplicate" grep -q 'more than once' "${D}/err.log"

# ---------------- I ----------------
echo "[I] path match is anchored; dropped lines without a template twin are listed"
CFGBAK='0 1 * * * tar czf /mnt/user/appdata/open-brain-config-backup/nightly.tgz /etc/hosts'
new_case I; write_fixture "$CUSTOM_CRON"; echo "$CFGBAK" >> "$CUSTOM_CRON"
inst
check "I: dry run exits 0" test "$RC" -eq 0
check "I: dry run lists the REMOVED, NOT REPLACED heading" grep -q 'REMOVED, NOT REPLACED' "${D}/out.log"
check "I: the old backup line (no identical template line) is listed under it" \
  bash -c "sed -n '/REMOVED, NOT REPLACED/,\$p' \"\$1\" | grep -qF 'cd /mnt/user/appdata/open-brain && bash scripts/backup.sh'" _ "${D}/out.log"
check "I: the financial-ingest line (identical template line) is not listed" \
  bash -c "! sed -n '/REMOVED, NOT REPLACED/,/^---/p' \"\$1\" | grep -qF 'financial-pipeline.py'" _ "${D}/out.log"
inst --apply
check "I: apply exits 0" test "$RC" -eq 0
check "I: open-brain-config-backup line kept" grep -qxF -- "$CFGBAK" "$CUSTOM_CRON"
check "I: apply output lists REMOVED, NOT REPLACED too" grep -q 'REMOVED, NOT REPLACED' "${D}/out.log"

# ---------------- J ----------------
echo "[J] malformed markers are refused"
for variant in begin-only end-only end-then-begin two-pairs; do
  new_case "J-${variant}"; write_fixture "$CUSTOM_CRON"
  case "$variant" in
    begin-only)     printf '# >>> open-brain managed\n0 9 * * * /keep/me\n' >> "$CUSTOM_CRON" ;;
    end-only)       printf '# <<< open-brain managed\n' >> "$CUSTOM_CRON" ;;
    end-then-begin) printf '# <<< open-brain managed\n# >>> open-brain managed\n' >> "$CUSTOM_CRON" ;;
    two-pairs)      printf '# >>> open-brain managed\n# <<< open-brain managed\n# >>> open-brain managed\n# <<< open-brain managed\n' >> "$CUSTOM_CRON" ;;
  esac
  cp "$CUSTOM_CRON" "${D}/orig"
  inst --apply
  check "J ${variant}: exits non-zero" test "$RC" -ne 0
  check "J ${variant}: nothing written" cmp -s "$CUSTOM_CRON" "${D}/orig"
  check "J ${variant}: no backup, no reload" test "$(nbak)" -eq 0 -a ! -s "$STUB_CALLS"
  check "J ${variant}: says why" grep -q 'marker' "${D}/err.log"
done

# ---------------- K ----------------
echo "[K] dry run needs no write access; unreadable table gives a clear message"
if [[ "$(id -u)" -eq 0 ]]; then
  echo "  skip - running as root"
else
  new_case K; write_fixture "$CUSTOM_CRON"; cp "$CUSTOM_CRON" "${D}/orig"
  chmod 0444 "$CUSTOM_CRON"; chmod 0555 "$D"
  env -u INSTALL_CRONS_ALLOW_NONROOT bash "$INSTALLER" > "${WORK}/K.out" 2> "${WORK}/K.err"; RC=$?
  check "K: non-root dry run on a read-only dir exits 0" test "$RC" -eq 0
  check "K: and prints the diff" grep -q '^+# >>> open-brain managed' "${WORK}/K.out"
  chmod 0755 "$D"; chmod 0000 "$CUSTOM_CRON"
  env -u INSTALL_CRONS_ALLOW_NONROOT bash "$INSTALLER" > "${WORK}/K.out" 2> "${WORK}/K.err"; RC=$?
  check "K: unreadable custom.cron exits 2" test "$RC" -eq 2
  check "K: clear message (cannot read, run as root)" grep -q 'cannot read .*root' "${WORK}/K.err"
  check "K: no raw cp error" bash -c '! grep -q "^cp:" "$1"' _ "${WORK}/K.err"
  chmod 0644 "$CUSTOM_CRON"
fi

echo ""
echo "=== test-install-crons: ${PASS} passed, ${FAILN} failed ==="
[[ "$FAILN" -eq 0 ]]
