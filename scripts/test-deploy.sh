#!/usr/bin/env bash
# test-deploy.sh — harness for scripts/deploy.sh and scripts/preflight.sh (item 5.2).
#
# Everything runs against a throwaway git fixture (bare origin + clone) and a stub
# `docker` on PATH that records every call (with the IMAGE_TAG it saw) and never
# touches a real daemon. The stub's `compose config` render carries a canary secret;
# the harness proves the scripts never print it.
# shellcheck disable=SC2015
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
# Isolate git from the caller's config. CI runners set `safe.directory = *` globally,
# which would let the scripts pass without their own `-c safe.directory`.
: > "$T/gitconfig"
export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1

PASS=0 FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
check() { if [ "$2" = "$3" ]; then ok "$1 (rc=$3)"; else bad "$1 (expected rc=$2, got rc=$3)"; printf '%s\n' "$OUT" | sed 's/^/      | /'; fi; }
has()   { if printf '%s' "$OUT" | grep -qE -- "$2"; then ok "$1"; else bad "$1 (no match for: $2)"; printf '%s\n' "$OUT" | sed 's/^/      | /'; fi; }
hasnt() { if printf '%s' "$OUT" | grep -qE -- "$2"; then bad "$1 (unexpected match: $2)"; else ok "$1"; fi; }
calls_has()   { if grep -qE -- "$2" "$STUB/calls.log" 2>/dev/null; then ok "$1"; else bad "$1 (no docker call matching: $2)"; sed 's/^/      | /' "$STUB/calls.log" 2>/dev/null; fi; }
calls_hasnt() { if grep -qE -- "$2" "$STUB/calls.log" 2>/dev/null; then bad "$1 (docker call matching: $2)"; grep -E -- "$2" "$STUB/calls.log" | sed 's/^/      | /'; else ok "$1"; fi; }
no_canary() { hasnt "$1: the rendered config (canary) is never printed" 'hunter2'; }

APP9="core-api workers slack-bot voice-capture web-next file-ingestion financial-ingest utility-ingest actual-ingest"

# ── fixture repo ───────────────────────────────────────────────────────────────
ORIGIN="$T/origin.git"; WORK="$T/work"; HOSTDIR="$T/host"; BACKUP="$T/backup"
mkdir -p "$HOSTDIR/pgdata" "$HOSTDIR/redis-data" "$BACKUP"
git init -q --bare -b main "$ORIGIN"
git init -q -b main "$WORK"
git -C "$WORK" config user.email t@t; git -C "$WORK" config user.name t
mkdir -p "$WORK/scripts" "$WORK/deploy" "$WORK/config/whisper"
printf 'services:\n  core-api:\n    image: x\n' > "$WORK/docker-compose.yml"
printf '{}\n' > "$WORK/config/whisper/model_aliases.json"
echo 'a: 1' > "$WORK/config/x.yaml"
printf '/DEPLOYED.json\n/.env.bak-*\n/.env.tmp.*\n/.DEPLOYED.json.*\nconfig/payee-rules.yaml\nconfig/utility/utility-config.yaml\nconfig/new-host.yaml\n' > "$WORK/.gitignore"
printf '# host-only\ndocker-compose.override.yml\n.env\n.env.secrets\nconfig/payee-rules.yaml\nconfig/utility/utility-config.yaml\nDEPLOYED.json\n' > "$WORK/deploy/host-only-allowlist.txt"
for f in deploy.sh preflight.sh check-deploy-parity.sh; do
  [ -f "$SCRIPT_DIR/$f" ] && cp "$SCRIPT_DIR/$f" "$WORK/scripts/$f"
done
git -C "$WORK" add -A; git -C "$WORK" commit -qm c1
C1="$(git -C "$WORK" rev-parse HEAD)"
echo 'a: 2' > "$WORK/config/x.yaml"
# C2's allowlist names one more host-only config file: preflight --ref C2 must require it.
echo 'config/new-host.yaml' >> "$WORK/deploy/host-only-allowlist.txt"
git -C "$WORK" commit -qam c2
C2="$(git -C "$WORK" rev-parse HEAD)"
git -C "$WORK" remote add origin "$ORIGIN"; git -C "$WORK" push -q origin main
git -C "$WORK" reset -q --hard "$C1"
# GIT_TEST_ASSUME_DIFFERENT_OWNER taints the local-path remote too; real hosts fetch
# over https. Drop it for upload-pack so only the WORK tree stays untrusted.
git -C "$WORK" config remote.origin.uploadpack 'env -u GIT_TEST_ASSUME_DIFFERENT_OWNER git-upload-pack'
TAG2="sha-${C2:0:7}"

# Host-only files (allowlisted). .env holds a line that must survive byte-for-byte.
ENV_ORIG="$T/env.orig"
printf 'TAILSCALE_IP=100.64.0.1\n# keep me\nOTHER_SETTING="a b=c"\nLOKI_URL=http://localhost:3100/x\n' > "$ENV_ORIG"
cp "$ENV_ORIG" "$WORK/.env"; chmod 600 "$WORK/.env"
: > "$WORK/.env.secrets"
# Host-only config files (gitignored, allowlisted). Their content is a canary: never printed.
HOSTCFG="config/payee-rules.yaml config/utility/utility-config.yaml config/new-host.yaml"
mk_hostcfg() { local f; mkdir -p "$WORK/config/utility"; for f in $HOSTCFG; do echo 'payee: PAYEE-CANARY' > "$WORK/$f"; done; }
mk_hostcfg

# ── stub docker ────────────────────────────────────────────────────────────────
STUB="$T/stub"; mkdir -p "$STUB/bin" "$STUB/net" "$STUB/health" "$STUB/rev"
# Render template (as `docker compose config --format json` would print it).
# @TAG@ is replaced by the IMAGE_TAG the stub sees; core-api carries a canary secret.
mkrender() {
  jq -n --arg work "$WORK" --arg host "$HOSTDIR" '
    def own($x): "ghcr.io/davistroy/open-brain/\($x):@TAG@";
    def cfg: {type:"bind", source:"\($work)/config", target:"/app/config", read_only:true};
    {name:"open-brain", services:{
      postgres:{image:"pgvector/pgvector:pg16", volumes:[{type:"bind",source:"\($host)/pgdata",target:"/var/lib/postgresql/data"}]},
      redis:{image:"redis:7.4-alpine", volumes:[{type:"bind",source:"\($host)/redis-data",target:"/data"}]},
      cloudflared:{image:"cloudflare/cloudflared:2025.6.1"},
      "core-api":{image:own("core-api"), environment:{CANARY_SECRET:"hunter2"}, volumes:[cfg]},
      workers:{image:own("workers"), volumes:[cfg]},
      "slack-bot":{image:own("slack-bot")},
      "voice-capture":{image:own("voice-capture")},
      "web-next":{image:own("web-next")},
      "file-ingestion":{image:own("file-ingestion")},
      "financial-ingest":{image:own("ingest-sidecar")},
      "utility-ingest":{image:own("ingest-sidecar")},
      "actual-ingest":{image:own("actual-ingest")},
      "faster-whisper":{image:"ghcr.io/speaches-ai/speaches:latest-cpu", volumes:[
        {type:"volume",source:"hf_hub_cache",target:"/cache"},
        {type:"bind",source:"\($work)/config/whisper/model_aliases.json",target:"/m.json",read_only:true}]}
    }}'
}
cat > "$STUB/bin/docker" <<'STUBEOF'
#!/usr/bin/env bash
S="${STUB_DIR:?}"
echo "IMAGE_TAG=${IMAGE_TAG:-} $*" >> "$S/calls.log"
render() { sed "s/@TAG@/${IMAGE_TAG:-latest}/g" "$S/render.json"; }
last="${*: -1}"
case "$*" in
  "plugin ls"*) cat "$S/plugins" 2>/dev/null; exit 0 ;;
  "network inspect "*) [ -e "$S/net/$last" ]; exit ;;
  "manifest inspect "*) if grep -qxF -- "$last" "$S/missing-manifests" 2>/dev/null; then echo "no such manifest: $last" >&2; exit 1; fi; echo '{}'; exit 0 ;;
  compose*)
    case " $* " in *" -f - "*) cat > /dev/null ;; esac
    case "$*" in
      *"config --format json"*) [ -e "$S/fail-render" ] && exit 1; render; exit 0 ;;
      *"config --services"*) render | jq -r '.services | keys[]'; exit 0 ;;
      *"config --hash "*) echo "$last new-$last-${IMAGE_TAG:-latest}"; exit 0 ;;
      *"config"*) render; exit 0 ;;
      *" pull "*) [ -e "$S/fail-pull" ] && exit 1; exit 0 ;;
      *" up "*) [ -e "$S/fail-up" ] && exit 1; exit 0 ;;
    esac; exit 1 ;;
  "image inspect "*) echo "[\"ghcr.io/x@sha256:dig-${last#sha256:img-}\"]"; exit 0 ;;
  exec*)
    case "$*" in
      *schema_migrations*) echo "0037"; exit 0 ;;
      *grep*) [ -e "$S/marker-missing" ] && { echo 0; exit 1; }; echo 1; exit 0 ;;
    esac; exit 1 ;;
  inspect*)
    svc="${last#open-brain-}"
    [ -e "$S/gone/$svc" ] && { echo "Error: No such object: $last" >&2; exit 1; }
    case "$*" in
      *".Mounts"*) jq -c --arg s "$svc" '[.services[$s].volumes[]? | select(.type=="bind") | {Type:"bind",Source:.source,Destination:.target}]' "$S/running.json"; exit 0 ;;
      *"State"*) q="$S/healthseq/$svc"   # one state per call; the last line repeats
                 if [ -s "$q" ]; then head -1 "$q"; [ "$(wc -l < "$q")" -gt 1 ] && sed -i 1d "$q"; exit 0; fi
                 if [ -r "$S/health/$svc" ]; then cat "$S/health/$svc"; else echo healthy; fi; exit 0 ;;
      *"image.revision"*) if [ -r "$S/rev/$svc" ]; then cat "$S/rev/$svc"; else cat "$S/rev-default"; fi; exit 0 ;;
      *"config-hash"*) echo "old-$svc"; exit 0 ;;
      *".Config.Image"*) echo "configured/$svc"; exit 0 ;;
      *".Image"*) echo "sha256:img-$svc"; exit 0 ;;
    esac ;;
esac
exit 1
STUBEOF
chmod +x "$STUB/bin/docker"
export STUB_DIR="$STUB" PATH="$STUB/bin:$PATH"

reset_stub() {
  rm -rf "$STUB/net" "$STUB/health" "$STUB/healthseq" "$STUB/rev" "$STUB/gone"; mkdir -p "$STUB/net" "$STUB/health" "$STUB/healthseq" "$STUB/rev" "$STUB/gone"
  rm -f "$STUB/calls.log" "$STUB/missing-manifests" "$STUB/fail-"* "$STUB/marker-missing"
  mkrender > "$STUB/render.json"; cp "$STUB/render.json" "$STUB/running.json"
  printf 'ID NAME ENABLED\nabc loki:latest true\n' > "$STUB/plugins"
  touch "$STUB/net/observability" "$STUB/net/br0"
  echo "$C2" > "$STUB/rev-default"
}
reset_fixture() {
  git -C "$WORK" -c safe.directory="$WORK" checkout -q -f main
  git -C "$WORK" reset -q --hard "$C1"
  rm -f "$WORK/DEPLOYED.json" "$WORK"/.env.bak-* "$WORK"/.env.tmp.* "$WORK"/.DEPLOYED.json.* "$BACKUP/deploy-log.jsonl" "$WORK/stray.txt"
  cp "$ENV_ORIG" "$WORK/.env"; chmod 600 "$WORK/.env"; : > "$WORK/.env.secrets"
  rm -rf "$WORK/config/payee-rules.yaml" "$WORK/config/utility/utility-config.yaml" "$WORK/config/new-host.yaml"; mk_hostcfg
  reset_stub
}
deploy() { # deploy <args...>  — as a non-root caller with the test-only override
  OUT="$(env DEPLOY_ALLOW_NONROOT=1 BACKUP_ROOT="$BACKUP" DEPLOY_HEALTH_TIMEOUT=2 DEPLOY_HEALTH_INTERVAL=1 DEPLOY_HEALTH_SETTLE=0 \
         GIT_TEST_ASSUME_DIFFERENT_OWNER=1 ${DEPLOY_ENV:-} bash "$WORK/scripts/deploy.sh" "$@" 2>&1)"; RC=$?
}
preflight() { OUT="$(env PREFLIGHT_REPO_DIR="$WORK" bash "$WORK/scripts/preflight.sh" "$@" 2>&1)"; RC=$?; }
parity_tree() { # the real drift check, tree layer, against <ref>
  OUT="$(env PARITY_REPO_DIR="$WORK" PARITY_LOCAL_COMPOSE="$WORK/docker-compose.yml" PARITY_REF="$1" PARITY_LAYERS=tree \
         bash "$WORK/scripts/check-deploy-parity.sh" 2>&1)"; RC=$?; }
# An `mv` that kills deploy.sh (its parent) when it is about to rename onto *$KILL_MV_ON:
# the run dies between mktemp and mv.
REAL_MV="$(command -v mv)"; export REAL_MV
mkdir -p "$T/killmv"
cat > "$T/killmv/mv" <<'MVEOF'
#!/usr/bin/env bash
case "${*: -1}" in *"${KILL_MV_ON:-//none//}") kill -TERM "$PPID"; sleep 1; exit 1 ;; esac
exec "$REAL_MV" "$@"
MVEOF
chmod +x "$T/killmv/mv"
no_tmp() { local left="" f; for f in "$WORK"/.env.tmp.* "$WORK"/.DEPLOYED.json.*; do [ -e "$f" ] && left="${left} ${f##*/}"; done
  [ -z "$left" ] && ok "$1: no temp file left" || bad "$1: temp file(s) left: $left"; }
head_is() { [ "$(git -C "$WORK" -c safe.directory="$WORK" rev-parse HEAD)" = "$1" ]; }
state_changing='compose.* (pull|up)( |$)'

echo "== syntax =="
for f in deploy.sh preflight.sh; do
  if [ -f "$WORK/scripts/$f" ] && bash -n "$WORK/scripts/$f"; then ok "bash -n $f"; else bad "bash -n $f (missing or invalid)"; fi
done

echo "== refusals before any change =="
for s in postgres redis cloudflared; do
  reset_fixture; deploy "$C2" core-api "$s"
  check "refuses $s" 1 "$RC"; has "names the refused service ($s)" "$s"
  head_is "$C1" && ok "tree unchanged ($s)" || bad "tree moved ($s)"
  calls_hasnt "no pull/up ($s)" "$state_changing"
done
reset_fixture; deploy "$C2" core-api bogus-svc
check "refuses an unknown service" 1 "$RC"; has "says unknown" 'unknown service'
reset_fixture; deploy "$C2"
check "refuses an empty service list without --tree-only" 1 "$RC"
reset_fixture; deploy "$C2" financial-ingest
check "refuses financial-ingest without utility-ingest" 1 "$RC"; has "explains the shared image" 'ingest-sidecar|together'
reset_fixture; deploy "$C2" utility-ingest core-api
check "refuses utility-ingest without financial-ingest" 1 "$RC"
head_is "$C1" && ok "tree unchanged (ingest pair)" || bad "tree moved (ingest pair)"
reset_fixture; deploy "$C2" core-api --no-such-flag
check "refuses an unknown option" 1 "$RC"
reset_fixture; deploy "$C2" core-api --allow-unlabeled
check "--allow-unlabeled no longer exists (a pre-5.1 rollback is manual)" 1 "$RC"; has "says unknown option" 'unknown option: --allow-unlabeled'
if [ "$(id -u)" != 0 ]; then
  reset_fixture
  OUT="$(env BACKUP_ROOT="$BACKUP" bash "$WORK/scripts/deploy.sh" "$C2" core-api 2>&1)"; RC=$?
  check "refuses a non-root caller without the test-only override" 1 "$RC"; has "says root" 'root'
fi
reset_fixture; deploy 0000000000000000000000000000000000000000 core-api
check "refuses a commit that does not exist" 1 "$RC"
head_is "$C1" && ok "tree unchanged (unknown commit)" || bad "tree moved (unknown commit)"

echo "== unknown image tag =="
reset_fixture; echo "ghcr.io/davistroy/open-brain/workers:$TAG2" > "$STUB/missing-manifests"
deploy "$C2" core-api workers
check "refuses a tag missing in the registry" 1 "$RC"; has "names the missing image" "workers:$TAG2"
head_is "$C1" && ok "tree unchanged (missing tag)" || bad "tree moved (missing tag)"
calls_hasnt "no pull/up (missing tag)" "$state_changing"
calls_has "manifest inspect ran with the sha tag" "manifest inspect ghcr.io/davistroy/open-brain/core-api:$TAG2"

echo "== dirty tree =="
reset_fixture; echo '# edit' >> "$WORK/config/x.yaml"
deploy "$C2" core-api
check "refuses a dirty tracked file outside the allowlist" 1 "$RC"; has "names the dirty path" 'config/x.yaml'
head_is "$C1" && ok "stopped before checkout (dirty)" || bad "checked out despite a dirty tree"
calls_hasnt "no pull/up (dirty)" "$state_changing"
reset_fixture; touch "$WORK/stray.txt"
deploy "$C2" core-api
check "refuses an untracked file outside the allowlist" 1 "$RC"; has "names the stray path" 'stray.txt'

echo "== config gate =="
reset_fixture
jq '.services.postgres.volumes = [{type:"volume",source:"postgres_data",target:"/var/lib/postgresql/data"}]' "$STUB/render.json" > "$T/r" && mv "$T/r" "$STUB/render.json"
deploy "$C2" core-api
check "refuses a named-volume render for postgres" 1 "$RC"; has "names postgres" 'postgres'
calls_hasnt "no pull/up (named volume)" "$state_changing"
reset_fixture
jq '.services.redis.volumes = [{type:"volume",source:"redis_data",target:"/data"}]' "$STUB/render.json" > "$T/r" && mv "$T/r" "$STUB/render.json"
deploy "$C2" core-api
check "refuses a named-volume render for redis" 1 "$RC"
reset_fixture; mkdir -p "$T/elsewhere"
jq --arg s "$T/elsewhere" '.services.postgres.volumes[0].source = $s' "$STUB/running.json" > "$T/r" && mv "$T/r" "$STUB/running.json"
deploy "$C2" core-api
check "refuses a bind source that differs from the running mount" 1 "$RC"; has "shows the mismatch" 'postgres.*/var/lib/postgresql/data'
calls_hasnt "no pull/up (mount mismatch)" "$state_changing"
reset_fixture
jq 'del(.services["web-next"])' "$STUB/render.json" > "$T/r" && mv "$T/r" "$STUB/render.json"
deploy "$C2" core-api
check "refuses a render without the 13 known services" 1 "$RC"; has "names the missing service" 'web-next'
reset_fixture; touch "$STUB/gone/postgres"
deploy "$C2" core-api
check "refuses when postgres is not running (no mount to compare)" 1 "$RC"

echo "== drift check =="
reset_fixture
printf '#!/usr/bin/env bash\necho "TREE scripts/odd.sh"\nexit 1\n' > "$T/parity-tree.sh"
DEPLOY_ENV="DEPLOY_PARITY_SCRIPT=$T/parity-tree.sh" deploy "$C2" core-api
check "a TREE finding from the drift check stops the deploy" 1 "$RC"
has "prints how to return the tree" "checkout --detach $C1"
calls_hasnt "no pull/up (TREE drift)" "$state_changing"
reset_fixture
printf '#!/usr/bin/env bash\necho "ERROR: boom" >&2\nexit 2\n' > "$T/parity-2.sh"
DEPLOY_ENV="DEPLOY_PARITY_SCRIPT=$T/parity-2.sh" deploy "$C2" core-api
check "drift check exit 2 stops the deploy" 1 "$RC"; calls_hasnt "no pull/up (exit 2)" "$state_changing"
reset_fixture
printf '#!/usr/bin/env bash\necho "UNDEPLOYED abc1234..x: 1 file(s) changed"\nexit 1\n' > "$T/parity-undep.sh"
DEPLOY_ENV="DEPLOY_PARITY_SCRIPT=$T/parity-undep.sh" deploy "$C2" core-api
check "UNDEPLOYED-only findings are expected before a deploy" 0 "$RC"

echo "== --dry-run =="
reset_fixture; echo '{"commit":"'"$C1"'","cloudflare_workers":{"email-worker":"v9"}}' > "$WORK/DEPLOYED.json"
cp "$WORK/DEPLOYED.json" "$T/dep.before"
deploy "$C2" --dry-run $APP9
check "--dry-run succeeds" 0 "$RC"
head_is "$C1" && ok "dry-run: tree unchanged" || bad "dry-run: tree moved"
cmp -s "$WORK/.env" "$ENV_ORIG" && ok "dry-run: .env unchanged" || bad "dry-run: .env changed"
cmp -s "$WORK/DEPLOYED.json" "$T/dep.before" && ok "dry-run: DEPLOYED.json unchanged" || bad "dry-run: DEPLOYED.json changed"
[ ! -e "$BACKUP/deploy-log.jsonl" ] && ok "dry-run: no log line" || bad "dry-run: log written"
[ -z "$(ls "$WORK"/.env.bak-* 2>/dev/null)" ] && ok "dry-run: no .env backup" || bad "dry-run: .env backup written"
calls_hasnt "dry-run: no pull/up" "$state_changing"
has "dry-run prints the up command" 'up -d --force-recreate --no-deps'
has "dry-run shows the bind gate result" 'postgres.*bind'
no_canary "dry-run"

echo "== --tree-only =="
reset_fixture; echo '{"commit":"old","images_commit":"'"$C1"'","cloudflare_workers":{"email-worker":"v9"}}' > "$WORK/DEPLOYED.json"
deploy "$C2" --tree-only
check "--tree-only succeeds" 0 "$RC"
head_is "$C2" && ok "tree-only: checked out the commit" || bad "tree-only: HEAD is not the target"
calls_hasnt "tree-only: no pull/up" "$state_changing"
[ "$(jq -r .commit "$WORK/DEPLOYED.json")" = "$C2" ] && ok "tree-only: DEPLOYED.json has the commit" || bad "tree-only: DEPLOYED.json commit"
[ "$(jq -r '.services_recreated | length' "$WORK/DEPLOYED.json")" = 0 ] && ok "tree-only: recreated nothing" || bad "tree-only: services_recreated not empty"
[ "$(jq -r '.cloudflare_workers["email-worker"]' "$WORK/DEPLOYED.json")" = v9 ] && ok "tree-only: cloudflare_workers preserved" || bad "tree-only: cloudflare_workers lost"
cmp -s "$WORK/.env" "$ENV_ORIG" && ok "tree-only: .env (IMAGE_TAG) untouched" || bad "tree-only: .env changed"
[ "$(jq -r .image_tag "$WORK/DEPLOYED.json")" = latest ] && ok "tree-only: image_tag records what compose renders (latest)" || bad "tree-only: image_tag=$(jq -r .image_tag "$WORK/DEPLOYED.json")"
[ "$(wc -l < "$BACKUP/deploy-log.jsonl" 2>/dev/null)" = 1 ] && ok "tree-only: one log line" || bad "tree-only: log lines"
[ "$(jq -r .images_commit "$WORK/DEPLOYED.json")" = "$C1" ] && ok "tree-only: images_commit copied from the previous DEPLOYED.json" || bad "tree-only: images_commit=$(jq -r .images_commit "$WORK/DEPLOYED.json")"
no_canary "tree-only"
parity_tree "$C2"
check "after tree-only on new code, the drift check still reports it" 1 "$RC"
has "UNDEPLOYED names the images commit, not the tree commit" "^UNDEPLOYED ${C1:0:12}\\.\\.${C2}"
reset_fixture
deploy "$C2" --tree-only
check "--tree-only with no previous DEPLOYED.json" 0 "$RC"
jq -e 'has("images_commit") and .images_commit == null' "$WORK/DEPLOYED.json" >/dev/null && ok "tree-only, no previous record: images_commit is null" || bad "tree-only first record: $(jq -c . "$WORK/DEPLOYED.json")"
parity_tree "$C2"
check "images_commit null: the drift check reports UNDEPLOYED" 1 "$RC"; has "UNDEPLOYED line" '^UNDEPLOYED '

echo "== full run =="
reset_fixture; echo '{"commit":"'"$C1"'","cloudflare_workers":{"email-worker":"v9"}}' > "$WORK/DEPLOYED.json"
echo '{"old":1}' > "$BACKUP/deploy-log.jsonl"
# shellcheck disable=SC2086
deploy "$C2" $APP9 --marker workers=/app/dist/main.js:alert_state:
check "full run succeeds" 0 "$RC"
has "the real drift check ran against the target and saw UNDEPLOYED (C1..C2)" "^  \\| UNDEPLOYED ${C1:0:12}"
has "UNDEPLOYED-only findings let the deploy continue" "drift: only UNDEPLOYED"
head_is "$C2" && ok "full: HEAD is the target" || bad "full: HEAD is not the target"
UP="$(grep -E 'compose.* up ' "$STUB/calls.log")"
[ "$(printf '%s\n' "$UP" | grep -c .)" = 1 ] && ok "exactly one up call" || bad "up calls: $UP"
for s in $APP9; do printf '%s' "$UP" | grep -qE " $s( |$)" || bad "up does not name $s"; done; ok "up names each service"
printf '%s' "$UP" | grep -q -- '--force-recreate' && printf '%s' "$UP" | grep -q -- '--no-deps' && printf '%s' "$UP" | grep -q -- 'up -d' \
  && ok "up has -d --force-recreate --no-deps" || bad "up flags: $UP"
calls_hasnt "never --remove-orphans" 'remove-orphans'
calls_hasnt "never compose down" 'compose.* down'
printf '%s' "$UP" | grep -qE ' (postgres|redis|cloudflared)( |$)' && bad "up names a stateful service" || ok "up names no stateful service"
printf '%s' "$UP" | grep -q "^IMAGE_TAG=$TAG2 " && ok "IMAGE_TAG set on up" || bad "IMAGE_TAG on up: $UP"
calls_has "IMAGE_TAG set on pull" "^IMAGE_TAG=$TAG2 compose.* pull .*core-api"
grep -q "^IMAGE_TAG=$TAG2\$" "$WORK/.env" && ok ".env gets IMAGE_TAG=$TAG2" || bad ".env has no IMAGE_TAG line"
[ "$(grep -c '^IMAGE_TAG=' "$WORK/.env")" = 1 ] && ok ".env has exactly one IMAGE_TAG line" || bad ".env IMAGE_TAG count"
diff <(grep -v '^IMAGE_TAG=' "$WORK/.env") "$ENV_ORIG" >/dev/null && ok ".env keeps the other lines byte-for-byte" || bad ".env other lines changed"
[ "$(stat -c %a "$WORK/.env")" = 600 ] && ok ".env mode kept (600)" || bad ".env mode $(stat -c %a "$WORK/.env")"
B="$(ls "$WORK"/.env.bak-* 2>/dev/null | head -1)"
[ -n "$B" ] && cmp -s "$B" "$ENV_ORIG" && [ "$(stat -c %a "$B")" = 600 ] && ok ".env backed up first (same content, mode 600)" || bad ".env backup missing or wrong"
hasnt "never prints other .env lines" 'OTHER_SETTING|keep me|100\.64\.0\.1'
D="$WORK/DEPLOYED.json"
[ "$(jq -r .commit "$D")" = "$C2" ] && ok "DEPLOYED.json commit" || bad "DEPLOYED.json commit"
[ "$(jq -r .image_tag "$D")" = "$TAG2" ] && ok "DEPLOYED.json image_tag" || bad "DEPLOYED.json image_tag"
[ "$(jq -r .images_commit "$D")" = "$C2" ] && ok "DEPLOYED.json images_commit = the deployed commit" || bad "DEPLOYED.json images_commit=$(jq -r .images_commit "$D")"
[ "$(jq -r '.containers | length' "$D")" = 13 ] && ok "DEPLOYED.json has 13 containers" || bad "DEPLOYED.json containers: $(jq -c '.containers|keys' "$D")"
[ "$(jq -r '[.containers[] | select(.image_id != null and .repo_digest != null)] | length' "$D")" = 13 ] && ok "13 image IDs + repo digests" || bad "image ids/digests incomplete"
[ "$(jq -r .schema_ledger_max "$D")" = 0037 ] && ok "DEPLOYED.json schema_ledger_max" || bad "ledger max: $(jq -r .schema_ledger_max "$D")"
[ "$(jq -r '.services_recreated | sort | join(" ")' "$D")" = "$(printf '%s\n' $APP9 | sort | tr '\n' ' ' | sed 's/ $//')" ] && ok "services_recreated" || bad "services_recreated: $(jq -c .services_recreated "$D")"
jq -e '.deployed_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z$")' "$D" >/dev/null && ok "deployed_at is UTC ISO" || bad "deployed_at"
[ "$(jq -r '.cloudflare_workers["email-worker"]' "$D")" = v9 ] && ok "cloudflare_workers preserved" || bad "cloudflare_workers lost"
[ "$(wc -l < "$BACKUP/deploy-log.jsonl")" = 2 ] && ok "deploy-log.jsonl gained one line" || bad "log lines: $(wc -l < "$BACKUP/deploy-log.jsonl")"
tail -1 "$BACKUP/deploy-log.jsonl" | jq -e --arg c "$C2" '.commit == $c' >/dev/null && ok "log line is JSON with the commit" || bad "log line"
calls_has "marker checked inside the container" 'exec open-brain-workers grep'
calls_has "label checked on the recreated containers" 'image.revision.*open-brain-core-api'
no_canary "full run"
grep -q hunter2 "$WORK/DEPLOYED.json" "$BACKUP/deploy-log.jsonl" && bad "canary written to a record" || ok "records hold no rendered config"

echo "== verify failures =="
reset_fixture; echo unhealthy > "$STUB/health/workers"
deploy "$C2" core-api workers
check "an unhealthy container fails the deploy" 1 "$RC"; has "names the unhealthy service" 'workers'
has "no DEPLOYED.json: says there is no scripted rollback" 'no scripted rollback: see runbook §5 manual rollback'
hasnt "no DEPLOYED.json: suggests no rollback command" 'Roll back: scripts/deploy.sh'
[ ! -e "$WORK/DEPLOYED.json" ] && ok "unhealthy: no DEPLOYED.json" || bad "unhealthy: DEPLOYED.json written"
[ ! -e "$BACKUP/deploy-log.jsonl" ] && ok "unhealthy: no log line" || bad "unhealthy: log written"
reset_fixture; echo "$C1" > "$STUB/rev/core-api"
deploy "$C2" core-api workers
check "a wrong revision label fails the deploy" 1 "$RC"; has "names the label" 'revision'
[ ! -e "$WORK/DEPLOYED.json" ] && ok "wrong label: no DEPLOYED.json" || bad "wrong label: DEPLOYED.json written"
reset_fixture; : > "$STUB/rev/core-api"
deploy "$C2" core-api
check "a missing label fails the deploy" 1 "$RC"; has "points to the manual rollback" 'runbook'
hasnt "does not suggest the removed flag" 'allow-unlabeled'
echo "== verify settles =="
reset_fixture; printf 'healthy\nrestarting\n' > "$STUB/healthseq/workers"
deploy "$C2" core-api workers
check "healthy, then not healthy after the settle: fails" 1 "$RC"; has "names the service that fell over" 'workers.*(settle|no longer)'
[ ! -e "$WORK/DEPLOYED.json" ] && ok "settle failure: no DEPLOYED.json" || bad "settle failure: DEPLOYED.json written"
reset_fixture; printf 'starting\nhealthy\n' > "$STUB/healthseq/workers"
deploy "$C2" core-api workers
check "starting, then healthy and still healthy after the settle: succeeds" 0 "$RC"
echo "== rollback hints =="
reset_fixture; echo '{"commit":"'"$C1"'","images_commit":"'"$C1"'"}' > "$WORK/DEPLOYED.json"; echo unhealthy > "$STUB/health/workers"
deploy "$C2" core-api workers
check "verify failure with a previous deploy" 1 "$RC"
has "rollback names DEPLOYED.json's images_commit" "Roll back: scripts/deploy.sh ${C1} core-api workers"
reset_fixture; echo '{"commit":"'"$C2"'","images_commit":"'"$C2"'"}' > "$WORK/DEPLOYED.json"; echo unhealthy > "$STUB/health/workers"
deploy "$C2" core-api workers
check "verify failure when images_commit is the target" 1 "$RC"
has "images_commit = target: no scripted rollback" 'no scripted rollback: see runbook §5 manual rollback'
hasnt "images_commit = target: no rollback command" 'Roll back: scripts/deploy.sh'
reset_fixture; echo '{"commit":"'"$C1"'","images_commit":"'"$C1"'"}' > "$WORK/DEPLOYED.json"; touch "$STUB/fail-up"
deploy "$C2" core-api
check "a failed recreate" 1 "$RC"; has "failed recreate: rollback names images_commit" "Roll back: scripts/deploy.sh ${C1} core-api"
reset_fixture; git -C "$WORK" -c safe.directory="$WORK" checkout -q --detach "$C2"; touch "$STUB/fail-pull"
deploy "$C2" core-api
check "a failed pull with the tree already at the target" 1 "$RC"
has "PREV = target: says there is no previous commit" 'no previous commit'
has "PREV = target: points to the runbook" 'docs/runbooks/deploy.md'
hasnt "PREV = target: no checkout back to the same commit" "checkout --detach ${C2}"
echo "== temp files =="
reset_fixture
DEPLOY_ENV="PATH=$T/killmv:$PATH KILL_MV_ON=/.env" deploy "$C2" core-api
[ "$RC" != 0 ] && ok "killed while replacing .env (rc=$RC)" || bad "kill before the .env rename did not stop the run"
no_tmp "killed before the .env rename"
cmp -s "$WORK/.env" "$ENV_ORIG" && ok "killed before the .env rename: .env unchanged" || bad ".env changed"
reset_fixture
DEPLOY_ENV="PATH=$T/killmv:$PATH KILL_MV_ON=/DEPLOYED.json" deploy "$C2" --tree-only
[ "$RC" != 0 ] && ok "killed while writing DEPLOYED.json (rc=$RC)" || bad "kill before the DEPLOYED.json rename did not stop the run"
no_tmp "killed before the DEPLOYED.json rename"
reset_fixture; deploy "$C2" core-api
check "a normal run" 0 "$RC"; no_tmp "normal run"
reset_fixture; touch "$STUB/marker-missing"
deploy "$C2" core-api --marker core-api=/app/x.js:needle
check "a missing marker fails the deploy" 1 "$RC"
reset_fixture; touch "$STUB/fail-pull"
deploy "$C2" core-api
check "a failed pull stops before up" 1 "$RC"; calls_hasnt "no up after a failed pull" 'compose.* up '
has "failed pull prints how to return the tree" "checkout --detach $C1"
cmp -s "$WORK/.env" "$ENV_ORIG" && ok "failed pull: .env untouched" || bad "failed pull: .env changed"

echo "== a second deploy replaces the IMAGE_TAG line =="
reset_fixture; printf 'IMAGE_TAG=sha-0000000\n' >> "$WORK/.env"; cp "$WORK/.env" "$T/env.withtag"
deploy "$C2" core-api
check "deploy over an existing IMAGE_TAG" 0 "$RC"
[ "$(grep -c '^IMAGE_TAG=' "$WORK/.env")" = 1 ] && grep -q "^IMAGE_TAG=$TAG2\$" "$WORK/.env" && ok "IMAGE_TAG replaced in place" || bad "IMAGE_TAG lines: $(grep '^IMAGE_TAG' "$WORK/.env")"
diff <(grep -v '^IMAGE_TAG=' "$WORK/.env") "$ENV_ORIG" >/dev/null && ok "other lines still byte-for-byte" || bad "other lines changed"

echo "== preflight =="
reset_fixture
preflight
check "preflight: everything present" 0 "$RC"
no_canary "preflight"
reset_fixture; printf 'ID NAME ENABLED\nx other:latest true\ny loki:latest false\n' > "$STUB/plugins"
rm -f "$STUB/net/observability" "$STUB/net/br0"
jq --arg s "$T/no/such/dir" '.services.workers.volumes += [{type:"bind",source:$s,target:"/x"}]' "$STUB/render.json" > "$T/r" && mv "$T/r" "$STUB/render.json"
printf 'TAILSCALE_IP=\n' > "$WORK/.env"; rm -f "$WORK/.env.secrets"
rm "$WORK/config/whisper/model_aliases.json"; mkdir "$WORK/config/whisper/model_aliases.json"
preflight
check "preflight: missing items exit 1" 1 "$RC"
has "lists the loki plugin" 'MISSING.*loki'
has "lists the observability network" 'MISSING.*observability'
has "lists the br0 network" 'MISSING.*br0'
has "lists TAILSCALE_IP" 'MISSING.*TAILSCALE_IP'
has "lists .env.secrets" 'MISSING.*\.env\.secrets'
has "lists the missing bind source" "MISSING.*$T/no/such/dir"
has "lists model_aliases.json not a regular file" 'MISSING.*model_aliases\.json'
no_canary "preflight (missing)"
rmdir "$WORK/config/whisper/model_aliases.json"
echo "== preflight: host-only config files =="
reset_fixture; rm "$WORK/config/utility/utility-config.yaml"
preflight
check "preflight: missing host-only config file exits 1" 1 "$RC"; has "lists utility-config.yaml" 'MISSING.*config/utility/utility-config\.yaml'
reset_fixture; : > "$WORK/config/payee-rules.yaml"
preflight
check "preflight: empty host-only config file exits 1" 1 "$RC"; has "lists the empty payee-rules.yaml" 'MISSING.*config/payee-rules\.yaml'
reset_fixture; rm "$WORK/config/payee-rules.yaml"; mkdir "$WORK/config/payee-rules.yaml"
preflight
check "preflight: a directory in place of a host-only config file exits 1" 1 "$RC"; has "lists the payee-rules.yaml directory" 'MISSING.*config/payee-rules\.yaml'
reset_fixture
preflight
check "preflight: host-only config files present" 0 "$RC"; has "reports them" 'ok:.*config/utility/utility-config\.yaml'
hasnt "never prints a host-only file's content" 'PAYEE-CANARY'
reset_fixture; rm "$WORK/config/new-host.yaml"
preflight
check "preflight (tree's allowlist): new-host.yaml not required" 0 "$RC"
preflight --ref "$C2"
check "preflight --ref C2 reads C2's allowlist and requires new-host.yaml" 1 "$RC"; has "lists new-host.yaml" 'MISSING.*config/new-host\.yaml'
reset_fixture; rm "$WORK/config/utility/utility-config.yaml"
deploy "$C2" core-api
check "deploy stops when a host-only config file is missing" 1 "$RC"; has "names it" 'config/utility/utility-config\.yaml'
head_is "$C1" && ok "missing host-only config: stopped before checkout" || bad "missing host-only config: tree moved"
hasnt "deploy never prints a host-only file's content" 'PAYEE-CANARY'
reset_fixture; : > "$STUB/plugins"
deploy "$C2" core-api
check "deploy stops when preflight fails" 1 "$RC"
head_is "$C1" && ok "preflight failure: stopped before checkout" || bad "preflight failure: tree moved"

echo "== safe.directory does not come from the global config =="
grep -q safe "$GIT_CONFIG_GLOBAL" && bad "harness gitconfig sets safe.directory" || ok "harness runs with an empty global gitconfig"

echo
echo "deploy harness: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
