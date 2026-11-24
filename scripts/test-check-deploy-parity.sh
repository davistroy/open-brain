#!/usr/bin/env bash
# test-check-deploy-parity.sh — harness for scripts/check-deploy-parity.sh (four layers)
# and scripts/check-deploy-parity-cron.sh (notify-on-change state). Phase 4 / item 4.1.
#
# Everything runs against a throwaway git fixture (bare origin + clone) and a stub
# `docker` on PATH — no network, no real host, no Pushover. The stub's plain
# `compose config` prints a canary secret so the harness can prove the script never
# prints (or even requests) a rendered config.
# shellcheck disable=SC2015
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PARITY="${SCRIPT_DIR}/check-deploy-parity.sh"
CRON="${SCRIPT_DIR}/check-deploy-parity-cron.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT

PASS=0 FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
check() { # check <name> <expected rc> <actual rc>
  if [ "$2" = "$3" ]; then ok "$1 (rc=$3)"; else bad "$1 (expected rc=$2, got rc=$3)"; fi
}
has()   { if printf '%s' "$OUT" | grep -qE -- "$2"; then ok "$1"; else bad "$1 (no match for: $2)"; printf '%s\n' "$OUT" | sed 's/^/      | /'; fi; }
hasnt() { if printf '%s' "$OUT" | grep -qE -- "$2"; then bad "$1 (unexpected match: $2)"; else ok "$1"; fi; }

# ── fixture ───────────────────────────────────────────────────────────────────
ORIGIN="$T/origin.git"; WORK="$T/work"
git init -q --bare -b main "$ORIGIN"
git init -q -b main "$WORK"
git -C "$WORK" config user.email t@t; git -C "$WORK" config user.name t
mkdir -p "$WORK/config/prometheus/alerts" "$WORK/scripts" "$WORK/deploy" "$WORK/packages/shared/drizzle"
printf 'services:\n  a:\n    image: x\n  b:\n    image: y\n' > "$WORK/docker-compose.yml"
printf 'groups:\n  - name: g\n    rules:\n      - alert: A\n        expr: up == 0\n' > "$WORK/config/prometheus/alerts/a.yml"
printf '# host-only\ndocker-compose.override.yml\n.env\n.env.secrets\nconfig/payee-rules.yaml\nDEPLOYED.json\n' > "$WORK/deploy/host-only-allowlist.txt"
echo 'echo hi' > "$WORK/scripts/x.sh"
git -C "$WORK" add -A; git -C "$WORK" commit -qm init
git -C "$WORK" remote add origin "$ORIGIN"; git -C "$WORK" push -q origin main
# GIT_TEST_ASSUME_DIFFERENT_OWNER also taints the local-path "remote" (real hosts fetch
# over https); drop it for the upload-pack child so only the WORK tree stays untrusted.
git -C "$WORK" config remote.origin.uploadpack 'env -u GIT_TEST_ASSUME_DIFFERENT_OWNER git-upload-pack'
git -C "$WORK" fetch -q origin

ALERTS="$T/alerts"; mkdir -p "$ALERTS"; cp "$WORK/config/prometheus/alerts/a.yml" "$ALERTS/"
DEPLOYED="$T/docker-compose.yml"; cp "$WORK/docker-compose.yml" "$DEPLOYED"

# stub docker: per-service hash/label/image files under $T/stub
STUB="$T/stub"; mkdir -p "$STUB/bin" "$STUB/hash" "$STUB/label" "$STUB/image"
cat > "$STUB/bin/docker" <<'STUBEOF'
#!/usr/bin/env bash
S="${STUB_DIR:?}"
echo "$*" >> "$S/calls.log"
case "$*" in
  *"config --services"*) printf 'a\nb\n'; exit 0 ;;
  *"config --hash "*) svc="${@: -1}"; [ -r "$S/hash/$svc" ] || exit 1; echo "$svc $(cat "$S/hash/$svc")"; exit 0 ;;
  inspect*)
    name="${@: -1}"; svc="${name#open-brain-}"
    case "$*" in
      *config-hash*) [ -r "$S/label/$svc" ] && cat "$S/label/$svc"; exit 0 ;;
      *".Image"*)    [ -r "$S/image/$svc" ] && cat "$S/image/$svc"; exit 0 ;;
    esac ;;
  *"compose"*"config"*) echo "CANARY_SECRET_VALUE=hunter2"; exit 0 ;;
esac
exit 1
STUBEOF
chmod +x "$STUB/bin/docker"
export STUB_DIR="$STUB" PATH="$STUB/bin:$PATH"
setsvc() { echo "$2" > "$STUB/hash/$1"; echo "$3" > "$STUB/label/$1"; }
setsvc a h1 h1; setsvc b h2 h2
echo sha256:same > "$STUB/image/financial-ingest"; echo sha256:same > "$STUB/image/utility-ingest"

run() { # run <env assignments...> ; sets OUT and RC
  OUT="$(env PARITY_REPO_DIR="$WORK" PARITY_LOCAL_COMPOSE="$DEPLOYED" PARITY_ALERTS_DIR="$ALERTS" "$@" bash "$PARITY" 2>&1)"; RC=$?
}

echo "== different owner =="
if GIT_TEST_ASSUME_DIFFERENT_OWNER=1 git -C "$WORK" rev-parse --git-dir >/dev/null 2>&1; then
  bad "precondition: plain git should refuse a different-owner tree"
else ok "precondition: plain git refuses a different-owner tree (dubious ownership)"; fi
run GIT_TEST_ASSUME_DIFFERENT_OWNER=1 PARITY_LAYERS=file
check "different owner, file layer, in parity" 0 "$RC"
hasnt "no 'not inside a git repo' report" "not inside a git repo"

echo "== fetch failure =="
git -C "$WORK" remote set-url origin "$T/nonexistent.git"
run PARITY_LAYERS=file
check "failed fetch exits 2" 2 "$RC"
has "git's own error is printed" "git fetch failed"
has "git's error text included" "(fatal|does not appear|not a git repository)"
git -C "$WORK" remote set-url origin "$ORIGIN"

echo "== layer 1: file =="
printf '  c:\n    image: z\n' >> "$DEPLOYED"
run PARITY_LAYERS=file
check "file drift" 1 "$RC"; has "FILE line printed" '^FILE > '
cp "$WORK/docker-compose.yml" "$DEPLOYED"
run PARITY_LAYERS=bogus
check "unknown layer is exit 2" 2 "$RC"

echo "== layer 2: hash =="
run PARITY_LAYERS=hash
check "hashes equal" 0 "$RC"
setsvc b h2 OLD
run PARITY_LAYERS=hash
check "label differs" 1 "$RC"; has "STALE b printed" '^STALE b$'; hasnt "a is not stale" '^STALE a$'
hasnt "no rendered config in output" "CANARY_SECRET"
if grep -qE 'config( |$)' "$STUB/calls.log" && grep -E 'compose.* config' "$STUB/calls.log" | grep -vqE -- '--(services|hash)'; then
  bad "script requested an unflagged 'compose config' render"; else ok "only 'config --services/--hash' were invoked"; fi
setsvc b h2 h2
rm "$STUB/label/b"
run PARITY_LAYERS=hash
check "container not running" 1 "$RC"; has "NOTRUNNING b" '^NOTRUNNING b$'
setsvc b h2 h2
echo sha256:old > "$STUB/image/utility-ingest"
run PARITY_LAYERS=hash
check "ingest sidecars on different images" 1 "$RC"; has "IMAGE line" '^IMAGE '
echo sha256:same > "$STUB/image/utility-ingest"

echo "== layer 3: tree =="
run PARITY_LAYERS=tree
check "clean tree" 0 "$RC"
touch "$WORK/.env" "$WORK/.env.secrets" "$WORK/docker-compose.override.yml" "$WORK/DEPLOYED.json"
run PARITY_LAYERS=tree
check "allowlisted host-only files are ignored" 0 "$RC"
echo '# edited' >> "$WORK/scripts/x.sh"
touch "$WORK/config/stray.yaml"
run PARITY_LAYERS=tree
check "modified script + stray config" 1 "$RC"
has "TREE scripts/x.sh" '^TREE scripts/x.sh$'; has "TREE config/stray.yaml" '^TREE config/stray.yaml$'
hasnt "allowlisted .env not listed" '^TREE \.env'
git -C "$WORK" checkout -q -- scripts/x.sh; rm "$WORK/config/stray.yaml"

echo "== layer 4: alerts =="
run PARITY_LAYERS=alerts
check "alert rules match" 0 "$RC"
echo '      - alert: B' >> "$ALERTS/a.yml"
run PARITY_LAYERS=alerts
check "alert body drifted" 1 "$RC"; has "ALERT DRIFTED a.yml" '^ALERT DRIFTED a.yml$'
rm "$ALERTS/a.yml"
run PARITY_LAYERS=alerts
check "alert file missing" 1 "$RC"; has "ALERT MISSING a.yml" '^ALERT MISSING a.yml$'
cp "$WORK/config/prometheus/alerts/a.yml" "$ALERTS/"

echo "== all four layers, default =="
run GIT_TEST_ASSUME_DIFFERENT_OWNER=1
check "default layers, in parity" 0 "$RC"; has "all layers named" 'layers: file,hash,tree,alerts'

echo "== cron wrapper: notify on change =="
cat > "$T/notify-stub.sh" <<'NEOF'
notify_pushover_mismatch() { echo "$PUSHOVER_TITLE | $1" >> "$NOTIFY_LOG"; return 0; }
NEOF
cat > "$T/check-stub.sh" <<'CEOF'
#!/usr/bin/env bash
cat "$STUB_OUT"; exit "$(cat "$STUB_RC")"
CEOF
export NOTIFY_LOG="$T/notify.log" STUB_OUT="$T/out.txt" STUB_RC="$T/rc.txt"
export PARITY_NOTIFY_LIB="$T/notify-stub.sh" PARITY_CHECK_SCRIPT="$T/check-stub.sh" PARITY_STATE_FILE="$T/parity.state"
: > "$NOTIFY_LOG"
wrap() { # wrap <now> <rc> <finding lines...>
  local now="$1" rc="$2"; shift 2
  printf '%s\n' "chatter $now" "$@" > "$STUB_OUT"; echo "$rc" > "$STUB_RC"
  OUT="$(PARITY_NOW="$now" bash "$CRON" 2>&1)"; RC=$?
}
sent() { wc -l < "$NOTIFY_LOG" | tr -d ' '; }
D=86400; T0=1000000
wrap "$T0" 1 "STALE a" "TREE x"
check "wrapper passes the exit code through" 1 "$RC"; [ "$(sent)" = 1 ] && ok "first drift notifies" || bad "first drift notifies (sent=$(sent))"
wrap $((T0 + D)) 1 "TREE x" "STALE a" "chatter differs"
[ "$(sent)" = 1 ] && ok "same findings (different order and chatter), <7d: silent" || bad "same fingerprint re-notified (sent=$(sent))"
wrap $((T0 + 3 * D)) 1 "STALE a"
[ "$(sent)" = 2 ] && ok "changed findings notify again" || bad "changed findings (sent=$(sent))"
wrap $((T0 + 3 * D + 100)) 1 "STALE a"
[ "$(sent)" = 2 ] && ok "unchanged again: silent" || bad "unchanged again (sent=$(sent))"
wrap $((T0 + 10 * D + 200)) 1 "STALE a"
[ "$(sent)" = 3 ] && ok "7 days after the last notification: notifies again" || bad "weekly re-notify (sent=$(sent))"
wrap $((T0 + 10 * D + 300)) 2 "ERROR: git fetch failed"
check "exit 2 passes through" 2 "$RC"; [ "$(sent)" = 4 ] && ok "exit 2 notifies (fingerprint changed)" || bad "exit 2 notify (sent=$(sent))"
wrap $((T0 + 10 * D + 400)) 2 "ERROR: git fetch failed"
[ "$(sent)" = 4 ] && ok "exit 2 unchanged <7d: silent" || bad "exit 2 repeat (sent=$(sent))"
wrap $((T0 + 18 * D)) 2 "ERROR: git fetch failed"
[ "$(sent)" = 5 ] && ok "exit 2 re-notifies after 7d" || bad "exit 2 weekly (sent=$(sent))"
wrap $((T0 + 18 * D + 10)) 0
[ "$(sent)" = 6 ] && ok "return to parity sends one recovery notice" || bad "recovery notice (sent=$(sent))"
wrap $((T0 + 40 * D)) 0
[ "$(sent)" = 6 ] && ok "steady parity is silent, even after 7d" || bad "steady parity (sent=$(sent))"
rm -f "$PARITY_STATE_FILE"; wrap $((T0 + 41 * D)) 0
[ "$(sent)" = 6 ] && ok "no state + parity: silent" || bad "first-run parity (sent=$(sent))"
rm -f "$PARITY_STATE_FILE"; wrap $((T0 + 42 * D)) 1 "STALE a"
[ "$(sent)" = 7 ] && ok "lost state file (reboot): notifies once" || bad "lost state (sent=$(sent))"

echo
echo "check-deploy-parity harness: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
