#!/usr/bin/env bash
# test-backup.sh — full-run test of scripts/backup.sh (item 6.4) against a FAKE `docker`.
#
# No real container, path, or secret is touched: a fake `docker` on PATH serves canned
# Postgres/Redis answers and a per-container fake filesystem (real SQLite files, so the
# backup-API snapshot and PRAGMA integrity_check are exercised for real). A fake `curl`
# swallows any Pushover send. BACKUP_ROOT / APP_DIR / CUSTOM_CRON_SRC point at a temp dir.
#
# Cases:
#   A  happy path: redis.rdb + redis_rdb=present, sidecars/ (integrity ok), custom.cron,
#      host-tree.txt, DEPLOYED.json, manifest objects/images/git_sha, mtimes inside the run,
#      no password on any docker command line, no secret variable names in the new copies
#   B  Redis NOAUTH: redis_rdb=failed, no redis.rdb, backup still completes and moves latest
#   C  absent DB files + unreadable custom.cron: warnings, backup completes, latest moves
#   D  positive control: a secret name planted in sidecars/ IS caught by the scan
#   E  object query returns 3 of 4 counts: manifest objects = null, manifest still valid JSON
#
# Usage: bash scripts/test-backup.sh      Exit 0 = all pass, 1 = failure.
# Secrets policy: prints variable NAMES and file names only.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${KEEP_WORK:-$(mktemp -d)}"; mkdir -p "$WORK"
[ -n "${KEEP_WORK:-}" ] || trap 'rm -rf "$WORK"' EXIT

PASS=0; FAILN=0
ok()   { PASS=$((PASS + 1)); echo "  ok   - $1"; }
bad()  { FAILN=$((FAILN + 1)); echo "  FAIL - $1"; }
check() { local desc="$1"; shift; if "$@"; then ok "$desc"; else bad "$desc"; fi; }

SECRET_PATTERN='BWS_ACCESS_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|SLACK_USER_TOKEN|PUSHOVER_TOKEN|PUSHOVER_APP_TOKEN|PUSHOVER_USER_KEY|POSTGRES_PASSWORD|REDIS_PASSWORD|MCP_API_KEY|ADMIN_API_KEY|GITEA_TOKEN|TUNNEL_TOKEN|DEEPGRAM_API_KEY|SMTP_PASS|VOICE_CAPTURE_SECRET|INGEST_TRIGGER_SECRET'
FAKE_PW="fake-redis-pw-0123456789"

# --- fake bin ---------------------------------------------------------------
BIN="${WORK}/bin"; mkdir -p "$BIN"
cat > "${BIN}/curl" <<'SH'
#!/bin/sh
echo "curl $*" >> "${FAKE_DIR}/curl.log"; exit 0
SH
cat > "${BIN}/docker" <<'SH'
#!/usr/bin/env bash
# Fake docker. FAKE_DIR/c/<container>/ is each container's filesystem root.
printf '%s\n' "$*" >> "${FAKE_DIR}/docker-calls.log"
root() { echo "${FAKE_DIR}/c/$1"; }
case "${1:-}" in
  inspect)
    name="${*: -1}"
    [[ "$name" == open-brain-* ]] || exit 1
    if [[ "$*" == *'{{.Image}}'* ]]; then echo "sha256:fakeimage-${name}"; fi
    exit 0 ;;
  ps)
    printf '%s\n' open-brain-postgres open-brain-redis open-brain-core-api open-brain-utility-ingest
    exit 0 ;;
  cp)
    src="$2"; dst="$3"
    if [[ "$src" == open-brain-*:* ]]; then
      c="${src%%:*}"; p="${src#*:}"
      [[ -e "$(root "$c")$p" ]] || exit 1
      cp -a "$(root "$c")$p" "$dst"          # cp -a keeps OLD mtimes, like docker cp
    else exit 1; fi
    exit 0 ;;
  exec)
    shift
    while [[ "${1:-}" == -* ]]; do case "$1" in -e) shift 2 ;; *) shift ;; esac; done
    c="$1"; shift
    r="$(root "$c")"
    case "$1" in
      pg_dump) if [[ "$*" == *--format=custom* ]]; then echo FAKEDUMP; else echo "-- schema"; fi; exit 0 ;;
      psql)
        q="${*: -1}"
        case "$q" in
          *pg_indexes*) if [[ "${FAKE_OBJECTS_SHORT:-}" == 1 ]]; then echo "5 2 1"; else echo "5 2 1 3"; fi ;;
          *to_regclass*) echo t ;;
          *"max(version)"*) echo "0042_fake.sql" ;;
          *pg_database_size*) echo 12345 ;;
          *query_to_xml*) printf 'captures:3\nentities:1\n'
                          # a table of another schema, unless the query keeps schema public only
                          [[ "$q" == *"schemaname = 'public'"* ]] || printf 'other_schema_tbl:9\n' ;;
          *) exit 1 ;;
        esac; exit 0 ;;
      test) shift; flag="$1"; p="$2"; [[ -e "$r$p" ]] && exit 0; exit 1 ;;
      rm) shift; shift; rm -f "$r$1"; exit 0 ;;
      git) exit 1 ;;
      python)
        shift; [[ "$1" == -c ]] && { code="$2"; src="$3"; dst="$4"; }
        mkdir -p "$(dirname "$r$dst")"
        python3 -c "$code" "$r$src" "$r$dst"; exit $? ;;
      sh)
        last="${*: -1}"
        if [[ "${FAKE_REDIS_FAIL:-}" == 1 ]]; then echo "NOAUTH Authentication required."; exit 0; fi
        case "$last" in
          LASTSAVE) if [[ -f "${FAKE_DIR}/bgsaved" ]]; then echo 101; else echo 100; fi ;;
          SCHEDULE) touch "${FAKE_DIR}/bgsaved"; echo "Background saving scheduled" ;;
          *) exit 1 ;;
        esac; exit 0 ;;
      *) exit 1 ;;
    esac ;;
esac
exit 1
SH
chmod +x "${BIN}/docker" "${BIN}/curl"

# --- fixture builder ---------------------------------------------------------
make_sqlite() { # make_sqlite <path> : a WAL-mode DB with rows (and a live -wal file left open)
  mkdir -p "$(dirname "$1")"
  python3 - "$1" <<'PY'
import sqlite3, sys
c = sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL")
c.execute("create table t(id integer primary key, v text)")
c.executemany("insert into t(v) values (?)", [("row%d" % i,) for i in range(50)])
c.commit(); c.close()
PY
}

new_case() { # new_case <name> : sets FAKE_DIR, APP, BKP
  CASE="$1"
  export FAKE_DIR="${WORK}/${CASE}-fake"; APP="${WORK}/${CASE}-app"; BKP="${WORK}/${CASE}-backup"
  rm -rf "$FAKE_DIR" "$APP" "$BKP"; mkdir -p "$FAKE_DIR/c" "$APP/config" "$BKP"
  : > "$FAKE_DIR/docker-calls.log"
  echo 'log_level: info' > "$APP/config/app.yaml"
  printf 'NODE_ENV=production\n' > "$APP/.env"
  printf 'REDIS_PASSWORD=%s\nOPENAI_API_KEY=fake\n' "$FAKE_PW" > "$APP/.env.secrets"
  echo 'version: "3"' > "$APP/docker-compose.yml"
  echo '{"sha":"fake"}' > "$APP/DEPLOYED.json"
  ( cd "$APP" && git init -q && git add config docker-compose.yml \
    && git -c user.name=t -c user.email=t@example.invalid commit -q -m init ) >/dev/null 2>&1
  echo 'untracked' > "$APP/stray.txt"
  # container filesystems (old mtimes so the touch step is observable)
  make_sqlite "$FAKE_DIR/c/open-brain-financial-ingest/data/financial.db"
  make_sqlite "$FAKE_DIR/c/open-brain-utility-ingest/data/utility.db"
  mkdir -p "$FAKE_DIR/c/open-brain-actual-ingest/data" "$FAKE_DIR/c/open-brain-voice-capture/data/voice-spool" "$FAKE_DIR/c/open-brain-redis/data"
  echo '{"balances":{}}' > "$FAKE_DIR/c/open-brain-actual-ingest/data/state.json"
  echo '{"spooled":1}' > "$FAKE_DIR/c/open-brain-voice-capture/data/voice-spool/a.json"
  echo FAKERDB > "$FAKE_DIR/c/open-brain-redis/data/dump.rdb"
  find "$FAKE_DIR/c" -type f -exec touch -d '2020-01-01 00:00:00' {} +
  # host cron table: lines source .env.secrets at run time but hold no variable names
  printf '0 3 * * * cd /app && bash -c '"'"'set -a; . ./.env.secrets; set +a; bash scripts/backup.sh'"'"'\n' > "$WORK/custom.cron"
  touch -d '2020-01-01 00:00:00' "$WORK/custom.cron"
}

run_backup() { # run_backup <extra env...> ; returns backup.sh exit code, log in $WORK/<case>.log
  RUN_START=$(date +%s)
  env -u PUSHOVER_APP_TOKEN -u PUSHOVER_USER_KEY -u PUSHOVER_TOKEN -u PUSHOVER_USER \
    PATH="${BIN}:${PATH}" APP_DIR="$APP" BACKUP_ROOT="$BKP" CUSTOM_CRON_SRC="${CUSTOM_CRON_SRC:-$WORK/custom.cron}" \
    REDIS_PASSWORD="$FAKE_PW" REDIS_WAIT_SECS=5 "$@" \
    bash "${SCRIPT_DIR}/backup.sh" > "${WORK}/${CASE}.log" 2>&1
  RUN_RC=$?
  RUN_END=$(date +%s)
  DAY="${BKP}/daily/$(date +%Y-%m-%d)"
}

scan_new_copies() { # scan_new_copies <day-dir> -> prints offending files; the new host/sidecar copies
  local d="$1" t=()
  for p in custom.cron host-tree.txt sidecars; do [[ -e "$d/$p" ]] && t+=("$d/$p"); done
  [[ ${#t[@]} -gt 0 ]] || return 0
  grep -rl -a -E "$SECRET_PATTERN" "${t[@]}" 2>/dev/null || true
}

mtimes_in_window() { # every file mtime in [RUN_START, RUN_END+1]
  local f m
  while IFS= read -r -d '' f; do
    m=$(stat -c %Y "$f")
    if (( m < RUN_START || m > RUN_END + 1 )); then echo "  mtime outside run: ${f#"$DAY"/}" >&2; return 1; fi
  done < <(find "$DAY" -type f -print0)
  return 0
}

echo "=== test-backup (item 6.4) ==="

# ---------------- Case A: happy path ----------------
echo "[A] happy path"
new_case A
run_backup
M="$DAY/manifest.json"
check "A: backup.sh exits 0" test "$RUN_RC" -eq 0
check "A: latest points at today's directory" test "$(readlink "$BKP/latest")" = "$DAY"
check "A: redis.rdb written" test -s "$DAY/redis.rdb"
check "A: manifest redis_rdb=present" test "$(jq -r .redis_rdb "$M")" = present
check "A: manifest objects carries db_objects_json output" test "$(jq -c '.objects' "$M")" = '{"indexes":5,"foreign_keys":2,"triggers":1,"functions":3,"ledger_max":"0042_fake.sql"}'
check "A: manifest images names the app containers" test "$(jq -r '.images["open-brain-redis"]' "$M")" = "sha256:fakeimage-open-brain-redis"
sha="$(jq -r .git_sha "$M")"
check "A: manifest git_sha is not 'unknown' (was ${sha})" test -n "$sha" -a "$sha" != unknown
check "A: sidecars/financial.db + utility.db exist" test -s "$DAY/sidecars/financial.db" -a -s "$DAY/sidecars/utility.db"
integ_ok=1
for db in financial utility; do
  r=$(python3 -c 'import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute("pragma integrity_check").fetchone()[0])' "$DAY/sidecars/$db.db" 2>&1)
  [[ "$r" == ok ]] || integ_ok=0
  n=$(python3 -c 'import sqlite3,sys;print(sqlite3.connect(sys.argv[1]).execute("select count(*) from t").fetchone()[0])' "$DAY/sidecars/$db.db" 2>&1)
  [[ "$n" == 50 ]] || integ_ok=0
done
check "A: SQLite snapshots pass integrity_check and hold the rows" test "$integ_ok" -eq 1
check "A: actual-state.tar + voice-spool.tar exist" test -s "$DAY/sidecars/actual-state.tar" -a -s "$DAY/sidecars/voice-spool.tar"
check "A: voice-spool.tar holds the spooled file" bash -c "tar -tf '$DAY/sidecars/voice-spool.tar' | grep -q 'a.json'"
# Members keep the container basenames, so `tar -xf <x>.tar -C /data` (or `docker cp - <c>:/data`)
# lands them at the paths the sidecars read.
check "A: actual-state.tar member list is exactly state.json" \
  test "$(tar -tf "$DAY/sidecars/actual-state.tar" | sort | tr '\n' ' ')" = "state.json "
check "A: voice-spool.tar member list is voice-spool/ + voice-spool/a.json" \
  test "$(tar -tf "$DAY/sidecars/voice-spool.tar" | sort | tr '\n' ' ')" = "voice-spool/ voice-spool/a.json "
check "A: manifest tables hold schema public only" test "$(jq -r '.tables | keys | join(",")' "$M")" = "captures,entities"
check "A: custom.cron copied" test -s "$DAY/custom.cron"
check "A: DEPLOYED.json copied" test -s "$DAY/DEPLOYED.json"
check "A: host-tree.txt has HEAD and the untracked file" bash -c "grep -q '^HEAD: [0-9a-f]\{40\}' '$DAY/host-tree.txt' && grep -q 'stray.txt' '$DAY/host-tree.txt'"
check "A: .env.secrets was NOT copied" bash -c "! find '$DAY' -name '.env.secrets' -o -name 'dot-env-secrets' | grep -q ."
check "A: every file mtime inside the run window" mtimes_in_window
check "A: password never on a docker command line" bash -c "! grep -q -- '$FAKE_PW' '$FAKE_DIR/docker-calls.log'"
check "A: password passed by name (-e REDISCLI_AUTH)" bash -c "grep -q -- '-e REDISCLI_AUTH ' '$FAKE_DIR/docker-calls.log'"
check "A: no Pushover send" test ! -s "$FAKE_DIR/curl.log"
check "A: no secret variable names in custom.cron / host-tree.txt / sidecars" test -z "$(scan_new_copies "$DAY")"

# ---------------- Case B: Redis failure ----------------
echo "[B] Redis NOAUTH"
new_case B
run_backup FAKE_REDIS_FAIL=1
M="$DAY/manifest.json"
check "B: backup.sh still exits 0" test "$RUN_RC" -eq 0
check "B: manifest redis_rdb=failed" test "$(jq -r .redis_rdb "$M")" = failed
check "B: no redis.rdb left behind" test ! -e "$DAY/redis.rdb"
check "B: latest moved" test "$(readlink "$BKP/latest")" = "$DAY"
check "B: the new sidecar steps still ran" test -s "$DAY/sidecars/utility.db"
check "B: manifest still has objects" test "$(jq -r .objects.indexes "$M")" = 5

# ---------------- Case C: absent files ----------------
echo "[C] absent DB files, unreadable custom.cron"
new_case C
rm -f "$FAKE_DIR/c/open-brain-financial-ingest/data/financial.db"*
rm -rf "$FAKE_DIR/c/open-brain-voice-capture"
CUSTOM_CRON_SRC="$WORK/does-not-exist" run_backup
check "C: backup.sh exits 0" test "$RUN_RC" -eq 0
check "C: latest moved" test "$(readlink "$BKP/latest")" = "$DAY"
check "C: warns about the missing database" grep -q 'financial.db not found' "${WORK}/C.log"
check "C: warns about custom.cron" grep -q 'custom.cron not backed up' "${WORK}/C.log"
check "C: surviving utility.db still snapshotted" test -s "$DAY/sidecars/utility.db"
check "C: no custom.cron in the backup" test ! -e "$DAY/custom.cron"
check "C: manifest is valid JSON" bash -c "jq -e . '$DAY/manifest.json' >/dev/null 2>&1"

# ---------------- Case D: positive control ----------------
echo "[D] scan catches a planted secret name"
new_case D
run_backup
echo 'REDIS_PASSWORD=planted' > "$DAY/sidecars/planted.txt"
check "D: scan flags a secret name planted in sidecars/" test -n "$(scan_new_copies "$DAY")"
rm -f "$DAY/sidecars/planted.txt"
echo 'REDIS_PASSWORD=planted' > "$DAY/custom.cron"
check "D: scan flags a secret name planted in custom.cron" test -n "$(scan_new_copies "$DAY")"

# ---------------- Case E: object query returns a short row ----------------
echo "[E] db_objects_json gets 3 of 4 counts"
new_case E
run_backup FAKE_OBJECTS_SHORT=1
check "E: backup.sh exits 0" test "$RUN_RC" -eq 0
check "E: manifest is valid JSON" bash -c "jq -e . '$DAY/manifest.json' >/dev/null 2>&1"
check "E: manifest objects is null" test "$(jq -c '.objects' "$DAY/manifest.json" 2>/dev/null)" = null
check "E: warns that object counts are unavailable" grep -q 'object counts unavailable' "${WORK}/E.log"

echo ""
echo "=== test-backup: ${PASS} passed, ${FAILN} failed ==="
[[ "$FAILN" -eq 0 ]]
