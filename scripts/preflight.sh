#!/usr/bin/env bash
# preflight.sh — list every missing rebuild/deploy prerequisite on the host (item 5.2).
#
# Usage:  bash scripts/preflight.sh [--ref <commit>]
#
# Checks (REQUIRED unless marked):
#   - the Loki log-driver plugin is installed and enabled (every service logs through it)
#   - the external networks `observability` and `br0` exist (compose never creates them)
#   - `.env` holds a non-empty TAILSCALE_IP (core-api binds to it; item 4.4)
#   - `.env.secrets` exists (every env_file names it)
#   - every bind source in the rendered compose exists (create_host_path:false makes
#     Docker refuse a missing source instead of creating an empty one)
#   - config/whisper/model_aliases.json is a regular file (a missing source bound as a
#     file turns into a directory and speaches fails)
#   - every file entry under config/ in deploy/host-only-allowlist.txt (REF's copy with
#     --ref) is a regular, non-empty file — today config/payee-rules.yaml and
#     config/utility/utility-config.yaml. Gitignored, so a checkout can delete them unseen.
#     Their contents are never read or printed.
#   - `bws` on PATH — WARNING only until item 7.4 installs it on the host
#
# --ref <commit>: check the compose of that commit instead of the working tree's,
# without checking it out (deploy.sh runs this before its checkout). A bind source
# inside the repo that the commit tracks counts as present: the checkout provides it.
#
# The render is held in a shell variable and never printed or written to a file: it
# inlines env_file values. Output is check names and paths only; no .env value is
# printed. Exit 0 = all required items present, 1 = at least one missing.
#
# Host constraints: bash, jq, sed, awk; no python3, no psql. git runs with an explicit
# safe.directory so root can read the claude-owned tree.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${PREFLIGHT_REPO_DIR:-$SCRIPT_DIR/..}" 2>/dev/null && pwd -P)" || {
  echo "ERROR: repo dir not accessible: ${PREFLIGHT_REPO_DIR:-$SCRIPT_DIR/..}" >&2; exit 1; }
REF=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 || { echo "ERROR: --ref needs a commit" >&2; exit 1; } ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
done

g() { git -C "$REPO" -c safe.directory="$REPO" "$@"; }

MISSING=0
miss() { echo "MISSING: $*"; MISSING=$((MISSING + 1)); }
okay() { echo "ok:      $*"; }
warn() { echo "WARNING: $*"; }

# At REF? Then the working tree IS the commit; otherwise read REF's compose from git.
AT_REF=1
if [ -n "$REF" ]; then
  want="$(g rev-parse --verify --quiet "${REF}^{commit}")" || { echo "ERROR: unknown commit: ${REF}" >&2; exit 1; }
  [ "$(g rev-parse HEAD 2>/dev/null)" = "$want" ] || AT_REF=0
  REF="$want"
fi
# present_at_ref <abs path>: the commit tracks this repo path, so the checkout provides it.
present_at_ref() {
  [ "$AT_REF" = 0 ] || return 1
  case "$1" in "$REPO"/*) g cat-file -e "${REF}:${1#"$REPO"/}" 2>/dev/null ;; *) return 1 ;; esac
}
dc() {
  if [ "$AT_REF" = 1 ]; then
    (cd "$REPO" && docker compose "$@")
  else
    local ov=()
    [ -f "$REPO/docker-compose.override.yml" ] && ov=(-f "$REPO/docker-compose.override.yml")
    g show "${REF}:docker-compose.yml" | docker compose --project-directory "$REPO" -f - "${ov[@]}" "$@"
  fi
}

echo "== preflight: ${REPO}${REF:+ (compose of ${REF:0:12}$([ "$AT_REF" = 1 ] && echo ', checked out' || echo ', not checked out'))} =="

if ! command -v docker >/dev/null; then
  miss "docker not on PATH (cannot check the plugin, networks or render)"
else
  # Loki log driver: every service's logging anchor names driver `loki`.
  if docker plugin ls 2>/dev/null | awk 'NR > 1 && $2 ~ /^loki(:|$)/ && $NF == "true" { f = 1 } END { exit !f }'; then
    okay "Loki log-driver plugin installed and enabled"
  else
    miss "Loki log-driver plugin (docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions)"
  fi
  for net in observability br0; do
    if docker network inspect "$net" >/dev/null 2>&1; then okay "external network ${net}"
    else miss "external network ${net}"; fi
  done
fi

# .env: read ONLY the TAILSCALE_IP line; never print it.
if [ -f "$REPO/.env" ]; then
  ts="$(sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}TAILSCALE_IP=//p' "$REPO/.env" 2>/dev/null | tail -1 | sed -e 's/^["'\'']//' -e 's/["'\'']$//' -e 's/[[:space:]]*$//')"
  if [ -n "$ts" ]; then okay "TAILSCALE_IP set in .env"; else miss "TAILSCALE_IP (required, non-empty) in ${REPO}/.env"; fi
  unset ts
else
  miss "${REPO}/.env (must hold TAILSCALE_IP)"
fi
if [ -f "$REPO/.env.secrets" ]; then okay ".env.secrets present"
else miss "${REPO}/.env.secrets (rebuild with scripts/load-secrets.sh)"; fi

# model_aliases.json must be a regular file (checkout provides it when not at REF).
MA="$REPO/config/whisper/model_aliases.json"
if [ "$AT_REF" = 0 ] && [ "$(g cat-file -t "${REF}:config/whisper/model_aliases.json" 2>/dev/null)" = blob ] && [ ! -d "$MA" ]; then
  okay "config/whisper/model_aliases.json (provided by the checkout)"
elif [ -f "$MA" ]; then okay "config/whisper/model_aliases.json is a regular file"
else miss "config/whisper/model_aliases.json is not a regular file (missing, or a directory Docker created)"; fi

# Host-only config files: every file entry under config/ in deploy/host-only-allowlist.txt
# (read from REF like deploy.sh does, else from the tree) must be a regular, non-empty file.
# They are gitignored, so a checkout from a commit that still tracked one (utility-config.yaml
# before the leak scrub) deletes it and nothing else notices. Contents are never read.
if [ -n "$REF" ]; then
  ALLOW="$(g show "${REF}:deploy/host-only-allowlist.txt" 2>/dev/null)" || ALLOW="$(cat "$REPO/deploy/host-only-allowlist.txt" 2>/dev/null)" || ALLOW=""
else
  ALLOW="$(cat "$REPO/deploy/host-only-allowlist.txt" 2>/dev/null)" || ALLOW=""
fi
if [ -z "$ALLOW" ]; then
  miss "deploy/host-only-allowlist.txt (on neither ${REF:+${REF:0:12} nor }the tree)"
else
  while IFS= read -r p; do
    if [ -f "$REPO/$p" ] && [ -s "$REPO/$p" ]; then okay "host-only config file ${p}"
    else miss "host-only config file ${p} (missing, empty or not a regular file; restore it from the backup)"; fi
  done < <(printf '%s\n' "$ALLOW" | awk '{ sub(/[[:space:]]*#.*/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, "") }
                                         /^config\/[^[:space:]]*[^\/]$/ { print }')
fi
unset ALLOW

# Bind sources: from the render, held in memory only.
if command -v docker >/dev/null; then
  if RENDER="$(dc config --format json 2>/dev/null)" && [ -n "$RENDER" ]; then
    n=0
    while IFS= read -r src; do
      [ -n "$src" ] || continue
      n=$((n + 1))
      if [ -e "$src" ]; then :
      elif present_at_ref "$src"; then :
      else miss "bind source ${src}"; fi
    done < <(printf '%s' "$RENDER" | jq -r '[.services[].volumes[]? | select(.type == "bind") | .source] | unique[]')
    okay "checked ${n} bind source(s)"
  else
    miss "compose render failed (docker compose config); fix the items above first"
  fi
  unset RENDER
fi

if command -v bws >/dev/null; then okay "bws on PATH"
else warn "bws not on PATH — scripts/load-secrets.sh cannot run on this host (OA-33; required after item 7.4)"; fi

if [ "$MISSING" -gt 0 ]; then
  echo "preflight: ${MISSING} required item(s) missing"
  exit 1
fi
echo "preflight: OK"
exit 0
