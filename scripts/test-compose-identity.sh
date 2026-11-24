#!/usr/bin/env bash
# test-compose-identity.sh — item 5.1: the compose file and the image build name
# their commit.
#   - the project name is pinned to open-brain, also from a directory with another name
#   - every open-brain image follows IMAGE_TAG (default latest)
#   - the render still holds the same 13 services
#   - every build step labels its image with org.opencontainers.image.revision
#   - the data and inbox directories are gitignored
# Renders only; prints service names, image references and counts, never a full render.
# shellcheck disable=SC2015,SC2016
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE="$REPO/docker-compose.yml"
WORKFLOW="$REPO/.github/workflows/build-images.yml"
PASS=0 FAIL=0
ok()  { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }

T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
# The render needs .env.secrets to exist (env_file); use an empty one in a copy.
cp "$COMPOSE" "$T/docker-compose.yml"; : > "$T/.env.secrets"
render() { (cd "$T" && env -u IMAGE_TAG TAILSCALE_IP=100.64.0.1 "$@" docker compose -f "$T/docker-compose.yml" config --format json 2>/dev/null); }

EXPECTED_SERVICES="actual-ingest cloudflared core-api faster-whisper file-ingestion financial-ingest postgres redis slack-bot utility-ingest voice-capture web-next workers"

echo "== project name =="
name="$(render | jq -r .name)"
[ "$name" = "open-brain" ] && ok "project name is open-brain (rendered from a dir named $(basename "$T"))" || bad "project name is '$name'"

echo "== image tag =="
own() { jq -r '.services[].image | select(startswith("ghcr.io/davistroy/open-brain/"))'; }
n_latest="$(render | own | grep -c ':latest$')"
[ "$n_latest" = 9 ] && ok "IMAGE_TAG unset: 9 open-brain images on :latest" || bad "IMAGE_TAG unset: $n_latest of 9 on :latest"
n_sha="$(render IMAGE_TAG=sha-abc1234 | own | grep -c ':sha-abc1234$')"
[ "$n_sha" = 9 ] && ok "IMAGE_TAG=sha-abc1234: 9 open-brain images on that tag" || bad "IMAGE_TAG=sha-abc1234: $n_sha of 9 on that tag"
n_other="$(render IMAGE_TAG=sha-abc1234 | jq -r '.services[].image | select(startswith("ghcr.io/davistroy/open-brain/") | not)' | grep -c 'sha-abc1234')"
[ "$n_other" = 0 ] && ok "IMAGE_TAG leaves third-party images alone" || bad "IMAGE_TAG changed $n_other third-party images"

echo "== services =="
got="$(render | jq -r '.services | keys[]' | sort | tr '\n' ' ' | sed 's/ $//')"
[ "$got" = "$EXPECTED_SERVICES" ] && ok "the same 13 services" || bad "service set changed: $got"

echo "== build labels =="
steps="$(grep -c 'uses: docker/build-push-action' "$WORKFLOW")"
labels="$(grep -c 'org.opencontainers.image.revision=${{ github.sha }}' "$WORKFLOW")"
[ "$steps" -ge 8 ] && [ "$labels" = "$steps" ] && ok "all $steps build steps set the revision label" || bad "$labels of $steps build steps set the revision label"
grep -q '^  workflow_dispatch:' "$WORKFLOW" && ok "build workflow has workflow_dispatch" || bad "build workflow has no workflow_dispatch"
grep -q 'sha=${GITHUB_SHA::7}' "$WORKFLOW" && ok "sha tag = first 7 chars of the full SHA" || bad "sha tag is not GITHUB_SHA::7"

echo "== gitignore =="
for d in pgdata/ redis-data/ financial-inbox/ utility-inbox/; do
  git -C "$REPO" check-ignore -q "$d" && ok "$d is ignored" || bad "$d is not ignored"
done

echo "compose identity harness: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
