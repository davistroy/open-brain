#!/usr/bin/env bash
# deploy.sh — deploy one commit to the homeserver and record what runs (item 5.2, ADR-0006).
#
# Usage (as root, in the host checkout /mnt/user/appdata/open-brain):
#   bash scripts/deploy.sh <sha> [options] <service> [<service> …]
#   bash scripts/deploy.sh <sha> --tree-only [--dry-run]
#
# Options:
#   --dry-run          run every read-only gate, print the plan, change nothing
#                      (tree, .env, DEPLOYED.json, the deploy log, containers).
#   --tree-only        move the tree to <sha>, run every gate, write DEPLOYED.json;
#                      recreate nothing and leave .env's IMAGE_TAG alone.
#   --allow-unlabeled  skip ONLY the org.opencontainers.image.revision label check — for a
#                      rollback to a commit built before the label existed (item 5.1).
#   --marker <svc>=<path>:<string>
#                      after the recreate, grep <string> in <path> inside open-brain-<svc>
#                      (repeatable). Proof that the fix is live, not merely merged.
#
# Step order (every refusal comes before the first change):
#   1. arguments: unknown / stateful (postgres, redis, cloudflared) services, half of the
#      ingest pair, an empty list without --tree-only        -> refuse
#   2. root (DEPLOY_ALLOW_NONROOT=1 is a TEST-ONLY override)    -> refuse
#   3. git fetch; resolve <sha> to a full commit; tag = sha-<first 7 chars of the full sha>
#      (the CI tag is ${GITHUB_SHA::7}; `rev-parse --short` can be longer)
#   4. preflight.sh --ref <sha> (environment: plugin, networks, .env, binds)
#   5. clean tree: `git status --porcelain` minus deploy/host-only-allowlist.txt
#   6. image tags: each named service's image at the sha tag exists (docker manifest inspect)
#   7. config gate on <sha>'s compose, read from git (no checkout yet)
#   --- first change ---
#   8. git checkout --detach <sha>                    (from here, a failure prints how to
#   9. drift check (check-deploy-parity.sh, layers    return the tree to the previous HEAD)
#      file,tree, PARITY_REF=<sha>)
#  10. config gate again, on the checked-out tree
#      --tree-only: write DEPLOYED.json and stop
#  11. docker compose pull <services>                 (IMAGE_TAG=sha-xxxxxxx exported)
#  12. docker compose up -d --force-recreate --no-deps <services>
#  13. .env: back up, then set exactly one IMAGE_TAG=sha-xxxxxxx line (atomic)
#  14. verify: healthy within DEPLOY_HEALTH_TIMEOUT, revision label == <sha>, markers
#  15. record: DEPLOYED.json (atomic) + one line in ${BACKUP_ROOT}/deploy-log.jsonl
#
# Never: git clean / stash / pull, `compose down`, a bare `up -d`, --remove-orphans. The
# rendered compose is held in shell variables only — it inlines env_file values — and
# .env is read for the IMAGE_TAG line only; no other line is printed.
#
# Host constraints: bash, jq, sed, awk; no python3, no psql (the ledger is read through
# `docker exec open-brain-postgres psql`). git runs with -c safe.directory=<repo> because
# root runs this in a tree owned by `claude`.
#
# Environment: BACKUP_ROOT (default /mnt/user/backup/openbrain), DEPLOY_HEALTH_TIMEOUT
# (seconds, default 180), DEPLOY_HEALTH_INTERVAL (default 5), DEPLOY_REPO_DIR (default
# the script's repo). TEST-ONLY: DEPLOY_ALLOW_NONROOT=1, DEPLOY_PARITY_SCRIPT=<path>.
#
# Exit: 0 deployed (or dry-run plan printed), 1 refused or failed.
set -uo pipefail

ALL13="actual-ingest cloudflared core-api faster-whisper file-ingestion financial-ingest postgres redis slack-bot utility-ingest voice-capture web-next workers"
STATEFUL="postgres redis cloudflared"
OWN_PREFIX="ghcr.io/davistroy/open-brain/"
HEALTH_FMT='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}'
REV_FMT='{{index .Config.Labels "org.opencontainers.image.revision"}}'

say()  { echo "$*"; }
step() { echo; echo "== $* =="; }
err()  { echo "ERROR: $*" >&2; }
in_list() { case " $2 " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

usage() { sed -n '2,24p' "${BASH_SOURCE[0]}"; }

# git with an explicit safe.directory (root in a claude-owned tree).
g() { git -C "$REPO" -c safe.directory="$REPO" "$@"; }
at_target() { [ "$(g rev-parse HEAD 2>/dev/null)" = "$SHA" ]; }

# docker compose against <sha>'s compose: the working tree when it is checked out,
# otherwise the file read from git with the repo as project directory (so ./config,
# .env and the override resolve exactly as they will after the checkout).
dc() {
  if at_target; then
    (cd "$REPO" && docker compose "$@")
  else
    local ov=()
    [ -f "$REPO/docker-compose.override.yml" ] && ov=(-f "$REPO/docker-compose.override.yml")
    g show "${SHA}:docker-compose.yml" | docker compose --project-directory "$REPO" -f - "${ov[@]}" "$@"
  fi
}

# Read only the IMAGE_TAG value from .env (never any other line).
env_image_tag() {
  [ -f "$REPO/.env" ] || return 0
  sed -n 's/^IMAGE_TAG=//p' "$REPO/.env" | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

return_hint() {
  say "  The tree is now at ${SHA:0:12} (it was at ${PREV:0:12}). To return it:"
  say "    cd ${REPO} && git -c safe.directory=${REPO} checkout --detach ${PREV}"
}
stop_after_checkout() { err "$*"; return_hint >&2; exit 1; }

# ── config gate ────────────────────────────────────────────────────────────────
# Render held in memory. Asserts: the 13 known services; postgres and redis render only
# binds; every bind source equals the running container's mount for the same target
# (postgres/redis must be running); every bind source exists. Prints, per service,
# whether `config --hash` differs from the running container's label.
gate() {
  local render got s fails=0 binds mounts t src rsrc want have
  if ! render="$(dc config --format json 2>/dev/null)" || [ -z "$render" ]; then
    err "config gate: 'docker compose config' failed for ${SHA:0:12}"; return 1
  fi
  got="$(printf '%s' "$render" | jq -r '.services | keys[]' | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ "$got" != "$ALL13" ]; then
    for s in $ALL13; do in_list "$s" "$got" || err "config gate: service ${s} is missing from the render"; done
    for s in $got; do in_list "$s" "$ALL13" || err "config gate: unknown service ${s} in the render"; done
    fails=$((fails + 1))
  else
    say "  services: the 13 known services"
  fi
  for s in postgres redis; do
    if ! printf '%s' "$render" | jq -e --arg s "$s" \
         '(.services[$s].volumes // []) as $v | ($v | length) > 0 and all($v[]; .type == "bind")' >/dev/null; then
      err "config gate: ${s} does not render as raw binds only (a named volume is an EMPTY database on this host)"
      printf '%s' "$render" | jq -r --arg s "$s" '.services[$s].volumes[]? | "    \(.type) \(.source) -> \(.target)"' >&2
      fails=$((fails + 1))
    fi
  done
  for s in $ALL13; do
    binds="$(printf '%s' "$render" | jq -r --arg s "$s" '.services[$s].volumes[]? | select(.type == "bind") | "\(.target)\t\(.source)"')"
    [ -n "$binds" ] || continue
    if ! mounts="$(docker inspect -f '{{json .Mounts}}' "open-brain-${s}" 2>/dev/null)" || [ -z "$mounts" ]; then
      if in_list "$s" "postgres redis"; then
        err "config gate: open-brain-${s} is not running — cannot prove its bind equals the live data"; fails=$((fails + 1))
      else
        say "  ${s}: not running; mounts not compared"
      fi
      mounts='[]'
    fi
    while IFS=$'\t' read -r t src; do
      [ -n "$t" ] || continue
      if [ ! -e "$src" ]; then err "config gate: ${s} bind source does not exist: ${src}"; fails=$((fails + 1)); fi
      rsrc="$(printf '%s' "$mounts" | jq -r --arg t "$t" '.[] | select(.Destination == $t) | .Source' | head -1)"
      if [ -z "$rsrc" ]; then
        if in_list "$s" "postgres redis"; then
          err "config gate: ${s} ${t}: no running mount to compare"; fails=$((fails + 1))
        else
          say "  ${s}: ${t} is a new bind (${src})"
        fi
      elif [ "$rsrc" != "$src" ]; then
        err "config gate: ${s} ${t}: render binds ${src}, the running container mounts ${rsrc}"; fails=$((fails + 1))
      elif in_list "$s" "postgres redis"; then
        say "  ${s}: bind ${src} -> ${t} (= running mount)"
      fi
    done <<< "$binds"
  done
  say "  config hash vs running container:"
  for s in $ALL13; do
    want="$(dc config --hash "$s" 2>/dev/null | awk 'NF { print $NF; exit }')"
    have="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "open-brain-${s}" 2>/dev/null)"
    case "$have" in
      ''|'<no value>') say "    ${s}: not running" ;;
      *) if [ "$want" = "$have" ]; then say "    ${s}: unchanged"; else say "    ${s}: CHANGES"; fi ;;
    esac
  done
  [ "$fails" -eq 0 ] || { err "config gate: ${fails} problem(s)"; return 1; }
  say "  config gate: OK"
}

# ── drift check (item 4.1) against the target ─────────────────────────────────
# check-deploy-parity.sh exit codes: 0 parity, 1 drift, 2 could not check.
# Exit 1 is EXPECTED before a deploy for exactly one finding kind: UNDEPLOYED (the
# commits between DEPLOYED.json and <sha> are what this deploy is about to ship). Any
# other finding — FILE (compose differs from <sha>), TREE (a host edit outside the
# allowlist) — means the tree is not <sha> plus host-only files, so we stop. Exit 2
# stops: a check that cannot run is never a pass.
drift_check() {
  local parity out rc findings other
  parity="${DEPLOY_PARITY_SCRIPT:-$REPO/scripts/check-deploy-parity.sh}"
  out="$(PARITY_REPO_DIR="$REPO" PARITY_LOCAL_COMPOSE="$REPO/docker-compose.yml" \
         PARITY_REF="$SHA" PARITY_LAYERS=file,tree bash "$parity" 2>&1)"; rc=$?
  printf '%s\n' "$out" | sed 's/^/  | /'
  case "$rc" in
    0) say "  drift: in parity with ${SHA:0:12}"; return 0 ;;
    1) findings="$(printf '%s\n' "$out" | grep -E '^(FILE|TREE|STALE|NOTRUNNING|IMAGE|ALERT|UNDEPLOYED) ' || true)"
       other="$(printf '%s\n' "$findings" | grep -v '^UNDEPLOYED ' | grep -c . || true)"
       if [ -n "$findings" ] && [ "${other:-0}" = 0 ]; then
         say "  drift: only UNDEPLOYED findings — expected before a deploy"; return 0
       fi
       err "drift check: findings other than UNDEPLOYED"; return 1 ;;
    *) err "drift check could not run (exit ${rc})"; return 1 ;;
  esac
}

# ── .env IMAGE_TAG line ────────────────────────────────────────────────────────
# Compose reads .env for interpolation, so the daily drift check and any later manual
# compose command render the deployed tag instead of :latest. Back up first (same mode),
# replace the first IMAGE_TAG line in place (drop any others) or append one, temp file in
# the same directory + mv. No line is printed.
set_env_tag() {
  local f="$REPO/.env" bak tmp
  [ -f "$f" ] || { err ".env not found: ${f}"; return 1; }
  bak="$REPO/.env.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$f" "$bak" || { err "cannot back up .env"; return 1; }
  tmp="$(mktemp "$REPO/.env.tmp.XXXXXX")" || { err "cannot create a temp file next to .env"; return 1; }
  if ! awk -v t="$TAG" '
        /^IMAGE_TAG=/ { if (!d) { print "IMAGE_TAG=" t; d = 1 } next }
        { print }
        END { if (!d) print "IMAGE_TAG=" t }' "$f" > "$tmp" \
     || ! chmod --reference="$f" "$tmp" \
     || ! { chown --reference="$f" "$tmp" 2>/dev/null || [ "$(id -u)" != 0 ]; } \
     || ! mv -f "$tmp" "$f"; then
    rm -f "$tmp"; err "cannot update .env (backup kept: ${bak})"; return 1
  fi
  say "  .env: IMAGE_TAG=${TAG} (backup: $(basename "$bak"))"
}

# ── verify ─────────────────────────────────────────────────────────────────────
verify() {
  local timeout="${DEPLOY_HEALTH_TIMEOUT:-180}" interval="${DEPLOY_HEALTH_INTERVAL:-5}"
  local start=$SECONDS s st pending fails=0 img rev m svc rest path str n
  pending="${SERVICES[*]}"
  while :; do
    local still=""
    for s in $pending; do
      st="$(docker inspect -f "$HEALTH_FMT" "open-brain-${s}" 2>/dev/null)"
      case "$st" in healthy|running) say "  ${s}: ${st}" ;; *) still="${still} ${s}" ;; esac
    done
    pending="${still# }"
    [ -z "$pending" ] && break
    if [ $((SECONDS - start)) -ge "$timeout" ]; then
      for s in $pending; do
        err "verify: open-brain-${s} not healthy after ${timeout}s (state: $(docker inspect -f "$HEALTH_FMT" "open-brain-${s}" 2>/dev/null || echo missing))"
        fails=$((fails + 1))
      done
      break
    fi
    sleep "$interval"
  done
  for s in "${SERVICES[@]}"; do
    img="$(printf '%s' "$RENDER_TARGET" | jq -r --arg s "$s" '.services[$s].image // ""')"
    case "$img" in "$OWN_PREFIX"*) ;; *) say "  ${s}: third-party image, no revision label"; continue ;; esac
    if [ "$ALLOW_UNLABELED" = 1 ]; then say "  ${s}: revision label not checked (--allow-unlabeled)"; continue; fi
    rev="$(docker inspect -f "$REV_FMT" "open-brain-${s}" 2>/dev/null)"
    case "$rev" in
      "$SHA") say "  ${s}: revision ${SHA:0:12}" ;;
      ''|'<no value>') err "verify: open-brain-${s} has no org.opencontainers.image.revision label (a commit built before item 5.1? re-run with --allow-unlabeled)"; fails=$((fails + 1)) ;;
      *) err "verify: open-brain-${s} revision label ${rev:0:12} != ${SHA:0:12}"; fails=$((fails + 1)) ;;
    esac
  done
  for m in "${MARKERS[@]+"${MARKERS[@]}"}"; do
    svc="${m%%=*}"; rest="${m#*=}"; path="${rest%%:*}"; str="${rest#*:}"
    n="$(docker exec "open-brain-${svc}" grep -c -F -- "$str" "$path" 2>/dev/null | head -1)"
    if [ "${n:-0}" -ge 1 ] 2>/dev/null; then say "  marker ${svc}:${path}: found (${n})"
    else err "verify: marker '${str}' not found in open-brain-${svc}:${path}"; fails=$((fails + 1)); fi
  done
  [ "$fails" -eq 0 ]
}

# ── record ─────────────────────────────────────────────────────────────────────
record() {
  local mode="$1" image_tag="$2" s id cfg dig containers='{}' ledger cf doc tmp now recreated
  for s in $ALL13; do
    id="$(docker inspect -f '{{.Image}}' "open-brain-${s}" 2>/dev/null)" || id=""
    cfg="$(docker inspect -f '{{.Config.Image}}' "open-brain-${s}" 2>/dev/null)" || cfg=""
    dig=""
    [ -n "$id" ] && dig="$(docker image inspect -f '{{json .RepoDigests}}' "$id" 2>/dev/null | jq -r '.[0] // empty' 2>/dev/null)"
    containers="$(printf '%s' "$containers" | jq -c --arg s "$s" --arg id "$id" --arg cfg "$cfg" --arg dig "$dig" \
      '. + {($s): {image: (if $cfg == "" then null else $cfg end), image_id: (if $id == "" then null else $id end), repo_digest: (if $dig == "" then null else $dig end)}}')"
  done
  # shellcheck disable=SC2016  # $POSTGRES_USER/$POSTGRES_DB expand inside the container
  ledger="$(docker exec open-brain-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "SELECT max(version) FROM schema_migrations"' 2>/dev/null | tr -d '[:space:]')"
  [ -n "$ledger" ] || say "WARNING: could not read the schema ledger maximum; recorded as null"
  cf=null
  [ -f "$REPO/DEPLOYED.json" ] && cf="$(jq -c '.cloudflare_workers // null' "$REPO/DEPLOYED.json")"
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  recreated="$(printf '%s\n' "${SERVICES[@]+"${SERVICES[@]}"}" | jq -R . | jq -sc 'map(select(. != ""))')"
  doc="$(jq -n --arg commit "$SHA" --arg tag "$image_tag" --arg at "$now" --arg mode "$mode" --arg prev "$PREV" \
    --argjson rec "$recreated" --argjson containers "$containers" --arg ledger "$ledger" --argjson cf "$cf" \
    '{commit: $commit, image_tag: $tag, deployed_at: $at, mode: $mode, previous_commit: $prev,
      services_recreated: $rec, schema_ledger_max: (if $ledger == "" then null else $ledger end),
      containers: $containers, cloudflare_workers: $cf}')" || { err "cannot build DEPLOYED.json"; return 1; }
  tmp="$(mktemp "$REPO/.DEPLOYED.json.XXXXXX")" || { err "cannot create a temp file for DEPLOYED.json"; return 1; }
  if ! printf '%s\n' "$doc" > "$tmp" || ! chmod 644 "$tmp" || ! mv -f "$tmp" "$REPO/DEPLOYED.json"; then
    rm -f "$tmp"; err "cannot write DEPLOYED.json"; return 1
  fi
  say "  DEPLOYED.json: commit ${SHA:0:12}, tag ${image_tag}, ledger ${ledger:-null}"
  local root="${BACKUP_ROOT:-/mnt/user/backup/openbrain}"
  if [ -d "$root" ]; then
    if printf '%s\n' "$(printf '%s' "$doc" | jq -c .)" >> "$root/deploy-log.jsonl"; then
      say "  deploy log: ${root}/deploy-log.jsonl (+1 line)"
    else
      say "WARNING: cannot append to ${root}/deploy-log.jsonl"
    fi
  else
    say "WARNING: ${root} does not exist; deploy log not written"
  fi
}

main() {
  local arg
  SHA_ARG="" DRY=0 TREE_ONLY=0 ALLOW_UNLABELED=0
  SERVICES=() MARKERS=()
  while [ $# -gt 0 ]; do
    arg="$1"
    case "$arg" in
      --dry-run) DRY=1 ;;
      --tree-only) TREE_ONLY=1 ;;
      --allow-unlabeled) ALLOW_UNLABELED=1 ;;
      --marker) [ $# -ge 2 ] || { err "--marker needs <svc>=<path>:<string>"; return 1; }
                MARKERS+=("$2"); shift ;;
      --marker=*) MARKERS+=("${arg#--marker=}") ;;
      -h|--help) usage; return 0 ;;
      -*) err "unknown option: ${arg}"; usage >&2; return 1 ;;
      *) if [ -z "$SHA_ARG" ]; then SHA_ARG="$arg"
         elif ! in_list "$arg" "${SERVICES[*]+"${SERVICES[*]}"}"; then SERVICES+=("$arg"); fi ;;
    esac
    shift
  done
  [ -n "$SHA_ARG" ] || { err "missing <sha>"; usage >&2; return 1; }

  # 1. service list
  local s bad=0 list="${SERVICES[*]+"${SERVICES[*]}"}"
  for s in $list; do
    if in_list "$s" "$STATEFUL"; then
      err "refusing ${s}: postgres, redis and cloudflared are recreated by hand, one at a time, in a planned window after a same-hour backup"; bad=1
    elif ! in_list "$s" "$ALL13"; then
      err "unknown service: ${s} (known: ${ALL13})"; bad=1
    fi
  done
  local fi_=0 ui_=0
  in_list financial-ingest "$list" && fi_=1
  in_list utility-ingest "$list" && ui_=1
  if [ "$fi_" != "$ui_" ]; then
    err "financial-ingest and utility-ingest share the ingest-sidecar image: deploy them together"; bad=1
  fi
  if [ "$TREE_ONLY" = 1 ] && [ -n "$list" ]; then err "--tree-only recreates nothing; do not name services"; bad=1; fi
  if [ "$TREE_ONLY" = 0 ] && [ -z "$list" ]; then err "no services named (use --tree-only to move the tree only)"; bad=1; fi
  for s in "${MARKERS[@]+"${MARKERS[@]}"}"; do
    case "$s" in
      *=/*:?*) in_list "${s%%=*}" "$ALL13" || { err "--marker: unknown service in '${s}'"; bad=1; } ;;
      *) err "--marker must be <svc>=<absolute path>:<string>, got '${s}'"; bad=1 ;;
    esac
  done
  [ "$bad" = 0 ] || return 1

  # 2. root
  if [ "$(id -u)" != 0 ] && [ "${DEPLOY_ALLOW_NONROOT:-}" != 1 ]; then
    err "run as root (the tree is claude-owned; docker compose needs the root-only .env)"; return 1
  fi

  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO="$(cd "${DEPLOY_REPO_DIR:-$script_dir/..}" 2>/dev/null && pwd -P)" || { err "repo dir not accessible"; return 1; }
  local gerr
  gerr="$(g rev-parse --git-dir 2>&1 >/dev/null)" || { err "git cannot read ${REPO}: ${gerr}"; return 1; }
  PREV="$(g rev-parse HEAD)" || { err "cannot read HEAD"; return 1; }

  # 3. fetch + resolve
  step "resolve ${SHA_ARG}"
  if ! gerr="$(g fetch --quiet origin 2>&1)"; then err "git fetch failed: ${gerr}"; return 1; fi
  SHA="$(g rev-parse --verify --quiet "${SHA_ARG}^{commit}")" || { err "unknown commit: ${SHA_ARG}"; return 1; }
  TAG="sha-${SHA:0:7}"
  unset IMAGE_TAG
  local current_tag
  current_tag="$(env_image_tag)"
  if [ "$TREE_ONLY" = 0 ]; then export IMAGE_TAG="$TAG"; fi
  say "  commit ${SHA}  (tree now at ${PREV:0:12})"
  if [ "$TREE_ONLY" = 1 ]; then say "  mode: tree-only (IMAGE_TAG stays ${current_tag:-latest})"
  else say "  image tag ${TAG}; services: ${list}"; fi
  [ "$DRY" = 1 ] && say "  DRY RUN: nothing will change"
  if [ -f "$REPO/DEPLOYED.json" ] && ! jq -e . "$REPO/DEPLOYED.json" >/dev/null 2>&1; then
    err "DEPLOYED.json is not valid JSON; fix it by hand (its cloudflare_workers field must be preserved)"; return 1
  fi

  # 4. preflight
  step "preflight"
  if ! PREFLIGHT_REPO_DIR="$REPO" bash "$script_dir/preflight.sh" --ref "$SHA" | sed 's/^/  /'; then
    err "preflight failed; nothing changed"; return 1   # pipefail: preflight's exit counts
  fi

  # 5. clean tree
  step "clean tree"
  local allow paths dirty
  allow="$(g show "${SHA}:deploy/host-only-allowlist.txt" 2>/dev/null)" \
    || allow="$(cat "$REPO/deploy/host-only-allowlist.txt" 2>/dev/null)" \
    || { err "deploy/host-only-allowlist.txt is on neither ${SHA:0:12} nor the tree"; return 1; }
  paths="$(g status --porcelain)" || { err "git status failed"; return 1; }
  dirty="$(printf '%s\n' "$paths" | awk -v allow="$allow" '
    BEGIN { n = split(allow, L, "\n"); for (i = 1; i <= n; i++) { l = L[i]; sub(/[[:space:]]*#.*/, "", l); gsub(/^[[:space:]]+|[[:space:]]+$/, "", l); sub(/\/$/, "", l); if (l != "") a[l] = 1 } }
    $0 == "" { next }
    { p = substr($0, 4); sub(/.* -> /, "", p); gsub(/^"|"$/, "", p); sub(/\/$/, "", p)
      ok = 0; for (e in a) if (p == e || index(p, e "/") == 1) { ok = 1; break }
      if (!ok) print "  " $0 }')"
  if [ -n "$dirty" ]; then
    err "the tree has changes outside deploy/host-only-allowlist.txt (commit or revert them; never git clean/stash here):"
    printf '%s\n' "$dirty" >&2
    return 1
  fi
  say "  clean (apart from the host-only allowlist)"

  # 6. image tags (render of <sha>'s compose, held in memory)
  RENDER_TARGET="$(dc config --format json 2>/dev/null)" || RENDER_TARGET=""
  [ -n "$RENDER_TARGET" ] || { err "cannot render the compose of ${SHA:0:12}"; return 1; }
  if [ "$TREE_ONLY" = 0 ]; then
    step "image tags"
    local img imgs="" missing=0
    for s in "${SERVICES[@]}"; do
      img="$(printf '%s' "$RENDER_TARGET" | jq -r --arg s "$s" '.services[$s].image // ""')"
      [ -n "$img" ] || { err "${s} has no image in the render"; missing=1; continue; }
      case "$img" in
        "$OWN_PREFIX"*":$TAG") ;;
        "$OWN_PREFIX"*) err "${s}: the compose of ${SHA:0:12} does not follow IMAGE_TAG (${img})"; missing=1; continue ;;
      esac
      in_list "$img" "$imgs" || imgs="${imgs} ${img}"
    done
    for img in $imgs; do
      if docker manifest inspect "$img" >/dev/null 2>&1; then say "  ${img}: in the registry"
      else err "image not in the registry: ${img} (has build-images finished for ${SHA:0:7}?)"; missing=1; fi
    done
    [ "$missing" = 0 ] || return 1
  fi

  # 7. config gate on the target compose (before any change)
  step "config gate (${SHA:0:12}$(at_target && echo ', checked out' || echo ', read from git'))"
  gate || { err "config gate failed; nothing changed"; return 1; }

  if [ "$DRY" = 1 ]; then
    step "drift check"
    if at_target; then drift_check || return 1
    else say "  skipped: the tree is not at ${SHA:0:12} yet (runs after the checkout)"; fi
    step "plan (dry run — nothing was changed)"
    at_target || say "  git -c safe.directory=${REPO} checkout --detach ${SHA}"
    if [ "$TREE_ONLY" = 1 ]; then
      say "  write DEPLOYED.json (mode tree-only, image_tag ${current_tag:-latest}); recreate nothing"
    else
      say "  IMAGE_TAG=${TAG} docker compose pull ${list}"
      say "  IMAGE_TAG=${TAG} docker compose up -d --force-recreate --no-deps ${list}"
      say "  set IMAGE_TAG=${TAG} in .env (backup first); verify health + revision label; write DEPLOYED.json"
    fi
    return 0
  fi

  # 8. checkout — the first change
  step "checkout"
  if at_target; then say "  already at ${SHA:0:12}"
  else
    g checkout --quiet --detach "$SHA" || { err "git checkout failed; the tree is unchanged"; return 1; }
    say "  HEAD ${PREV:0:12} -> ${SHA:0:12}"
  fi

  # 9. drift check
  step "drift check"
  drift_check || stop_after_checkout "drift check failed; nothing recreated"

  # 10. config gate on the checked-out tree
  step "config gate (checked out)"
  RENDER_TARGET="$(dc config --format json 2>/dev/null)" || RENDER_TARGET=""
  gate || stop_after_checkout "config gate failed after the checkout; nothing recreated"

  if [ "$TREE_ONLY" = 1 ]; then
    step "record (tree-only)"
    # IMAGE_TAG in .env is deliberately left alone: no container was recreated, so the
    # tag that compose renders must stay the one the running containers were made from.
    record tree-only "${current_tag:-latest}" || stop_after_checkout "record failed"
    say; say "tree-only deploy of ${SHA:0:12} done; no container recreated"
    return 0
  fi

  # 11–12. pull + recreate
  step "pull"
  dc pull "${SERVICES[@]}" || stop_after_checkout "docker compose pull failed; nothing recreated"
  step "recreate"
  if ! dc up -d --force-recreate --no-deps "${SERVICES[@]}"; then
    err "docker compose up failed — some containers may have been recreated"
    say "  Roll back: scripts/deploy.sh ${PREV} ${list}  (needs that commit's sha-* images)" >&2
    stop_after_checkout "recreate failed"
  fi

  # 13. persist the tag for later compose runs
  step ".env IMAGE_TAG"
  set_env_tag || err "the containers run ${TAG} but .env was not updated — set IMAGE_TAG=${TAG} in .env by hand"

  # 14. verify
  step "verify"
  if ! verify; then
    err "verify failed; DEPLOYED.json NOT written (the containers were recreated)"
    say "  Roll back: scripts/deploy.sh ${PREV} ${list}  (needs that commit's sha-* images; add --allow-unlabeled for a pre-label commit)" >&2
    return_hint >&2
    return 1
  fi

  # 15. record
  step "record"
  record full "$TAG" || { err "recording failed; the deploy itself succeeded"; return 1; }
  say; say "deployed ${SHA:0:12} (${TAG}): ${list}"
}

# One line: bash has parsed `exit` before main runs, so the checkout replacing this
# file mid-run cannot make bash read the new file's bytes at the old offset.
main "$@"; exit $?
