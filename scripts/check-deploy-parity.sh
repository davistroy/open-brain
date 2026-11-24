#!/usr/bin/env bash
# check-deploy-parity.sh — does production run THIS repo's compose? (#302)
#
# Enforces the invariant:  deployed docker-compose.yml  ≡  origin/main's, modulo a
# short, EXPLICIT allowlist of host deviations.
#
# ── Why this exists ────────────────────────────────────────────────────────────
# `docker compose pull` + `up -d --force-recreate` ships IMAGE changes, because every
# service pins `:latest`. It does NOT ship compose changes — `up` reads the compose
# file sitting on the host, which only moves when a human remembers to run
#   git checkout origin/main -- docker-compose.yml
# Nothing does that on a schedule, and until now nothing compared the two copies.
#
# The cost, measured 2026-07-15 (Entry 211): the deployed compose was ~1 month stale,
# so PR #244's `/backup-latest` mount was never deployed — which is the real reason the
# backup dead-man's switch (#294) is inert. The workers container HAD been recreated;
# a recreate simply cannot help when the file itself is old. Both the issue and the
# remediation plan asserted "just recreate workers", and both were wrong.
#
# This is the 7th instance in one week of the same class — #278, #290, #292, #294,
# #299, Entry 201, #302 — and every one of them drifted for the same reason: nothing
# compared the two copies. The one mechanism in this repo with a proven track record,
# `validate-init-schema.sh`, works precisely because it COMPARES. This is that shape,
# applied to deployment.
#
# ── Why source-diff, not `docker compose config` ───────────────────────────────
# Rendering requires `.env` on both sides, and `.env` on the host is root:0600 (so a
# non-root check cannot read it) — while `.env`'s absence is itself part of #281. A
# source diff needs no secrets, no root, and no interpolation, and it answers the
# actual question: "is production running this file?"
#
# `docker compose config` still has a job — the BEFORE/AFTER gate around a deploy
# (Entry 179 / ADR-0004). That is a different check: it proves a change did only what
# you intended. This one proves the file is current in the first place.
#
# ── Four layers (Phase 4 / item 4.1, ADR-0006) ─────────────────────────────────
# PARITY_LAYERS (comma list; default file,hash,tree,alerts in local mode, file in ssh
# mode) selects what runs:
#   file    compose file TEXT vs REF (the original check; allowlist = D131 port line)
#   hash    per service: `docker compose config --hash <svc>` vs the running container's
#           com.docker.compose.config-hash label  ->  `STALE <svc>`; plus the two
#           ingest sidecars must run the SAME image ID (shared-image trap, Entry 201)
#   tree    `git diff REF -- config scripts packages/shared/drizzle` + `git status`,
#           minus deploy/host-only-allowlist.txt  ->  `TREE <path>`; and, when
#           DEPLOYED.json exists, `git diff --stat <its images_commit>..REF` minus
#           docs/*.md non-empty  ->  `UNDEPLOYED` (merged but never deployed; item 5.2)
#   alerts  check-alerts-parity.sh in local mode (rule bodies vs the deployed dir)
# Output is hashes, service names and paths ONLY. `docker compose config` inlines
# env_file values, so this script never prints a rendered config.
#
# git runs through g(): `-c safe.directory=<repo>` so root can read a claude-owned tree
# ("dubious ownership" used to surface as "not inside a git repo" and the cron never
# produced a result). A failed fetch exits 2 with git's own error.
#
# ── Exit codes ─────────────────────────────────────────────────────────────────
#   0  in parity (only allowlisted deviations)
#   1  DRIFT — production is not running this repo's compose
#   2  could not perform the check (never silently "pass"; see #303's lesson —
#      a check that cannot run must not look like a check that passed)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${PARITY_REPO_DIR:-$SCRIPT_DIR/..}" 2>/dev/null && pwd -P)" || {
  echo "ERROR: PARITY_REPO_DIR not accessible: ${PARITY_REPO_DIR:-$SCRIPT_DIR/..}" >&2; exit 2; }
HOST="${PARITY_HOST:-homeserver.k4jda.net}"
USER_="${PARITY_USER:-claude}"
APP_DIR="${PARITY_APP_DIR:-/mnt/user/appdata/open-brain}"
SSH_KEY="${PARITY_SSH_KEY:-$HOME/.ssh/id_claude_code}"
REF="${PARITY_REF:-origin/main}"
ALERTS_DIR="${PARITY_ALERTS_DIR:-/mnt/user/appdata/observability/config/prometheus/alerts}"

die() { echo "ERROR: $*" >&2; exit 2; }

# git wrapper: explicit safe.directory so a root cron can read a claude-owned tree.
g() { git -C "$REPO_DIR" -c safe.directory="$REPO_DIR" "$@"; }

# ── The allowlist: deviations that are DELIBERATE and DOCUMENTED ───────────────
# Keep this list SHORT and justified. Every entry is a place production knowingly
# differs from main. An unjustified entry here silently re-creates the very drift this
# script exists to catch — if you find yourself adding one, that is the smell.
#
#  D131 — core-api port binding. main declares a dual bind
#           "127.0.0.1:3002:3000" + "${TAILSCALE_IP:-...}:3002:3000"
#         while the host runs a single "3002:3000", re-applied by `sed` after every
#         `git checkout origin/main -- docker-compose.yml` (Entry 179).
#
# NOTE: postgres/redis data binds are NOT a deviation of this file. Since item 4.3 main
# binds them itself (${OPENBRAIN_DATA_DIR:-/mnt/user/appdata/open-brain}/{pgdata,redis-data},
# create_host_path:false). The host's gitignored docker-compose.override.yml still pins
# the same paths in short syntax until items 8.2/8.3 remove each entry; layer 1 does
# not read the override, and layer 2 sees its effect through the rendered config hash.
ALLOW_RE='^[<>][[:space:]]*-[[:space:]]*"(127\.0\.0\.1:3002:3000|\$\{TAILSCALE_IP:-[0-9.]+\}:3002:3000|\$\{TAILSCALE_IP:\?[^}]*\}:3002:3000|3002:3000)"'

command -v git >/dev/null || die "git not found"
if ! GERR="$(g rev-parse --git-dir 2>&1 >/dev/null)"; then
  die "git cannot read ${REPO_DIR}: ${GERR}"
fi

if [ -n "${PARITY_LOCAL_COMPOSE:-}" ]; then
  LOCAL=1; DEFAULT_LAYERS="file,hash,tree,alerts"
else
  LOCAL=0; DEFAULT_LAYERS="file"
fi
LAYERS="${PARITY_LAYERS:-$DEFAULT_LAYERS}"
for l in $(printf '%s' "$LAYERS" | tr ',' ' '); do
  case "$l" in file|hash|tree|alerts) ;; *) die "unknown PARITY_LAYERS entry: ${l}" ;; esac
done
has_layer() { case ",${LAYERS}," in *",$1,"*) return 0 ;; *) return 1 ;; esac; }

if [ "$LOCAL" = 1 ]; then
  echo "== deploy parity: ${PARITY_LOCAL_COMPOSE} (local)  vs  ${REF}  [layers: ${LAYERS}] =="
else
  echo "== deploy parity: ${USER_}@${HOST}:${APP_DIR}/docker-compose.yml  vs  ${REF}  [layers: ${LAYERS}] =="
  for l in hash tree alerts; do
    has_layer "$l" && die "layer '${l}' needs local mode (set PARITY_LOCAL_COMPOSE)"
  done
fi

# A failed fetch means REF may be stale: that is "could not check", never a pass.
if ! FETCH_ERR="$(g fetch --quiet origin 2>&1)"; then
  echo "ERROR: git fetch failed:" >&2
  printf '%s\n' "$FETCH_ERR" | sed 's/^/    /' >&2
  exit 2
fi

RC=0
drift()  { [ "$RC" -eq 2 ] || RC=1; }
cannot() { RC=2; }

REPO_TMP="$(mktemp)"; DEPLOY_TMP="$(mktemp)"
trap 'rm -f "$REPO_TMP" "$DEPLOY_TMP"' EXIT

# ── Layer 1: compose file text ─────────────────────────────────────────────────
layer_file() {
  local err
  if ! err="$(g show "${REF}:docker-compose.yml" 2>&1 >"$REPO_TMP")"; then
    echo "ERROR: cannot read docker-compose.yml from ${REF}: ${err}" >&2; cannot; return
  fi

  # Read the DEPLOYED compose — read-only either way; this script must never mutate
  # the host. PARITY_LOCAL_COMPOSE reads the file locally (the cron path).
  if [ "$LOCAL" = 1 ]; then
    if [ ! -r "$PARITY_LOCAL_COMPOSE" ] || ! cp "$PARITY_LOCAL_COMPOSE" "$DEPLOY_TMP"; then
      echo "ERROR: cannot read the deployed compose at ${PARITY_LOCAL_COMPOSE}" >&2; cannot; return
    fi
  else
    if ! ssh -i "$SSH_KEY" -o ConnectTimeout=20 -o BatchMode=yes "${USER_}@${HOST}" \
          "cat ${APP_DIR}/docker-compose.yml" > "$DEPLOY_TMP" 2>/dev/null; then
      echo "ERROR: cannot read the deployed compose over ssh (host down? key? path?)" >&2; cannot; return
    fi
  fi
  if [ ! -s "$DEPLOY_TMP" ]; then
    echo "ERROR: deployed compose came back EMPTY — refusing to report parity" >&2; cannot; return
  fi

  # Compare substance, not formatting: comments and blank lines are noise here.
  strip() { grep -vE '^[[:space:]]*(#|$)' "$1"; }
  local raw unexpected
  raw="$(diff <(strip "$REPO_TMP") <(strip "$DEPLOY_TMP") || true)"
  if [ -z "$raw" ]; then
    echo "  file: OK — deployed compose matches ${REF} exactly (not even the D131 deviation)."
    return
  fi
  unexpected="$(printf '%s\n' "$raw" | grep -E '^[<>]' | grep -Ev "$ALLOW_RE" || true)"
  if [ -z "$unexpected" ]; then
    echo "  file: OK — in parity. Only the allowlisted D131 core-api port deviation differs."
    return
  fi
  echo "  file: DRIFT — '<' = in ${REF} but MISSING from production, '>' = on the host but not in ${REF}"
  printf '%s\n' "$unexpected" | sed 's/^/FILE /'
  echo "  Commits touching docker-compose.yml that production may be missing:"
  g log --oneline "${REF}" -- docker-compose.yml 2>/dev/null | head -6 | sed 's/^/    /'
  drift
}

# ── Layer 2: rendered config hash per service vs the running container ─────────
dc() {
  ( cd "$(dirname "$PARITY_LOCAL_COMPOSE")" || exit 2
    if [ "$(basename "$PARITY_LOCAL_COMPOSE")" = docker-compose.yml ]; then
      docker compose "$@"
    else
      docker compose -f "$PARITY_LOCAL_COMPOSE" "$@"
    fi )
}

layer_hash() {
  command -v docker >/dev/null || { echo "ERROR: docker not found (hash layer)" >&2; cannot; return; }
  local services svc want have stale=0 n=0 out
  # Output of `config` is never echoed: it inlines env_file values.
  if ! services="$(dc config --services 2>/dev/null)" || [ -z "$services" ]; then
    echo "ERROR: 'docker compose config --services' failed (is .env.secrets present?)" >&2; cannot; return
  fi
  for svc in $services; do
    n=$((n + 1))
    if ! out="$(dc config --hash "$svc" 2>/dev/null)"; then
      echo "ERROR: 'docker compose config --hash ${svc}' failed" >&2; cannot; continue
    fi
    want="$(printf '%s\n' "$out" | awk 'NF{print $NF; exit}')"
    have="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "open-brain-${svc}" 2>/dev/null)"
    case "$have" in ''|'<no value>') echo "NOTRUNNING ${svc}"; drift; continue ;; esac
    if [ -z "$want" ]; then
      echo "ERROR: empty config hash for ${svc}" >&2; cannot
    elif [ "$want" != "$have" ]; then
      echo "STALE ${svc}"; stale=$((stale + 1)); drift
    fi
  done
  # Two services share ingest-sidecar:latest — recreating one leaves the other on the old image.
  local a b
  a="$(docker inspect -f '{{.Image}}' open-brain-financial-ingest 2>/dev/null)"
  b="$(docker inspect -f '{{.Image}}' open-brain-utility-ingest 2>/dev/null)"
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" != "$b" ]; then
    echo "IMAGE financial-ingest and utility-ingest run different image IDs (shared ingest-sidecar tag)"
    drift
  fi
  echo "  hash: checked ${n} service(s), ${stale} stale"
}

# ── Layer 3: working tree vs REF, minus the host-only allowlist ────────────────
layer_tree() {
  local allow_tmp paths gerr
  allow_tmp="$(mktemp)"
  if ! g show "${REF}:deploy/host-only-allowlist.txt" > "$allow_tmp" 2>/dev/null; then
    if ! cp "${REPO_DIR}/deploy/host-only-allowlist.txt" "$allow_tmp" 2>/dev/null; then
      rm -f "$allow_tmp"
      echo "ERROR: deploy/host-only-allowlist.txt is on neither ${REF} nor the working tree" >&2; cannot; return
    fi
  fi
  gerr="$(mktemp)"
  if ! paths="$( { g diff --name-only "$REF" -- config scripts packages/shared/drizzle || exit 1
                   g status --porcelain || exit 1; } 2>"$gerr" )"; then
    echo "ERROR: git diff/status failed: $(cat "$gerr")" >&2
    rm -f "$allow_tmp" "$gerr"; cannot; return
  fi
  rm -f "$gerr"
  # diff lines are bare paths; status lines are "XY path" (rename: "a -> b").
  paths="$(printf '%s\n' "$paths" | awk '
    /^(.[A-Z? !]|[A-Z?!][A-Z ]) / { sub(/^.. /, ""); sub(/.* -> /, "") }
    { gsub(/^"|"$/, ""); sub(/\/$/, ""); if ($0 != "") print }' | sort -u)"
  local bad
  bad="$(printf '%s\n' "$paths" | awk -v af="$allow_tmp" '
    BEGIN { while ((getline l < af) > 0) { sub(/[[:space:]]*#.*/, "", l); gsub(/^[[:space:]]+|[[:space:]]+$/, "", l); sub(/\/$/, "", l); if (l != "") a[l] = 1 } }
    $0 == "" { next }
    { ok = 0; for (e in a) if ($0 == e || index($0, e "/") == 1) { ok = 1; break } if (!ok) print "TREE " $0 }')"
  rm -f "$allow_tmp"
  if [ -n "$bad" ]; then
    printf '%s\n' "$bad"; drift
  else
    echo "  tree: OK — working tree matches ${REF} apart from the host-only allowlist."
  fi
  layer_undeployed
}

# Part of layer 3 (item 5.2): DEPLOYED.json names the commit scripts/deploy.sh last
# deployed. Code or config that changed between it and REF (docs and *.md excluded) was
# merged but never deployed -> `UNDEPLOYED`. No DEPLOYED.json = nothing to compare yet.
# deploy.sh runs this layer with PARITY_REF=<target> and treats UNDEPLOYED as expected.
#
# The comparison point is `images_commit` — the commit whose images last went live — not
# `commit`, which `--tree-only` moves without recreating anything (so a tree-only run onto
# new code would otherwise hide that code). An old DEPLOYED.json without the field falls
# back to `commit`; `images_commit: null` (only tree-only runs so far) is UNDEPLOYED.
layer_undeployed() {
  local f="${REPO_DIR}/DEPLOYED.json" dep stat files kind
  [ -f "$f" ] || return 0
  if ! kind="$(jq -r 'if has("images_commit") then (if .images_commit == null then "null" else "images" end) else "commit" end' "$f" 2>/dev/null)"; then
    echo "ERROR: ${f} is not readable JSON" >&2; cannot; return
  fi
  if [ "$kind" = null ]; then
    echo "UNDEPLOYED none..${REF}: DEPLOYED.json images_commit is null (no deploy has recreated containers from images yet)"
    drift; return
  fi
  if [ "$kind" = images ]; then
    dep="$(jq -r '.images_commit // empty' "$f" 2>/dev/null)"
  else
    dep="$(jq -r '.commit // empty' "$f" 2>/dev/null)"
  fi
  if [ -z "$dep" ]; then
    echo "ERROR: ${f} has no readable .images_commit or .commit" >&2; cannot; return
  fi
  if ! g cat-file -e "${dep}^{commit}" 2>/dev/null; then
    echo "UNDEPLOYED ${dep:0:12} (the deployed commit is not in this repository; history rewritten?)"
    drift; return
  fi
  # stderr kept apart: a git warning on a successful diff is not a changed file.
  local gerr; gerr="$(mktemp)"
  if ! stat="$(g diff --stat "${dep}..${REF}" -- . ':!*.md' ':!docs' 2>"$gerr")"; then
    echo "ERROR: git diff ${dep:0:12}..${REF} failed: $(cat "$gerr")" >&2; rm -f "$gerr"; cannot; return
  fi
  rm -f "$gerr"
  if [ -n "$stat" ]; then
    files="$(g diff --name-only "${dep}..${REF}" -- . ':!*.md' ':!docs' 2>/dev/null | grep -c .)"
    echo "UNDEPLOYED ${dep:0:12}..${REF}: ${files} file(s) changed since the last deploy (DEPLOYED.json)"
    drift
  else
    echo "  tree: deployed commit ${dep:0:12} carries every non-doc change in ${REF}."
  fi
}

# ── Layer 4: alert rules (local mode of check-alerts-parity.sh) ────────────────
layer_alerts() {
  local out rc
  out="$(ALERTS_LOCAL_DIR="$ALERTS_DIR" ALERTS_REPO_DIR="$REPO_DIR" ALERTS_REF="$REF" \
         bash "${SCRIPT_DIR}/check-alerts-parity.sh" 2>&1)"; rc=$?
  printf '%s\n' "$out" | grep -E '^(ALERT|ERROR) ' || true
  case "$rc" in
    0) echo "  alerts: OK — every open-brain rule body matches the deployed directory." ;;
    1) drift ;;
    *) echo "ERROR: check-alerts-parity.sh exited ${rc}" >&2; cannot ;;
  esac
}

has_layer file   && layer_file
has_layer hash   && layer_hash
has_layer tree   && layer_tree
has_layer alerts && layer_alerts

case "$RC" in
  0) echo "  RESULT: in parity (layers: ${LAYERS})."; exit 0 ;;
  2) echo "  RESULT: INCOMPLETE — at least one layer could not run; this is NOT a pass." ;;
  *) echo "  RESULT: DRIFT — production is NOT running ${REF}." ;;
esac
echo
echo "  Fix (as ROOT on the host; the tree is claude-owned, so use git -c safe.directory=\$PWD):"
echo "    1. cd ${APP_DIR} && git -c safe.directory=\$PWD fetch origin"
echo "    2. Application services: scripts/deploy.sh <sha>  (preflight, config gate, named"
echo "       recreate, marker check). Reconcile the compose file / config / scripts first."
echo "    3. Stateful services (postgres, redis, cloudflared): hand recreate in a planned window,"
echo "       one at a time, after a same-hour backup — NO -f flag (plain 'docker compose' keeps the"
echo "       host override), NEVER a bare 'up -d', NEVER --remove-orphans, NEVER 'down'."
echo "    4. STALE <svc> = running container predates the rendered config; recreate that service"
echo "       only (--no-deps). TREE <path> = host edit not on the allowlist: commit it or revert it."
echo "       UNDEPLOYED = merged code/config newer than DEPLOYED.json: scripts/deploy.sh <sha> <services>."
echo "    5. ALERT <file> = copy the rule file into the observability alerts dir as root, then reload."
exit "$RC"
