#!/usr/bin/env bash
# test-compose-host-binds.sh — host bindings fail closed (remediation item 4.4,
# SA7-17 / PLT-014).
#
# Why: a SHORT-syntax bind (`./config:/app/config:ro`) makes Docker CREATE a missing
# source as an empty directory, so a missing OPERATOR_ACTIONS.md, model_aliases.json
# or inbox starts the service with an empty mount. Long syntax with
# `bind.create_host_path: false` makes Docker refuse to start instead. Likewise
# `${TAILSCALE_IP:-100.101.61.122}` silently fell back to a hard-coded address; it is
# now `${TAILSCALE_IP:?…}` so a host without the value fails at the first compose command.
#
# Cases:
#   binds-fail-closed   every bind of every service has create_host_path == false
#   tailscale-required  empty / unset TAILSCALE_IP fails and the message names it
#   core-api-ports      with a value set: 127.0.0.1:3002 + <TAILSCALE_IP>:3002, no 0.0.0.0
#   negative controls   a short-syntax bind is rejected; the old :- fallback is rejected
#
# Hygiene: renders go to pipes and are never printed. Hermetic (--env-file /dev/null).
# Creates a placeholder .env.secrets only when absent and removes it after.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE="$REPO/docker-compose.yml"
TS=100.64.0.1

for bin in docker jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FAIL: $bin not found"; exit 1; }
done
WORK="$(mktemp -d)"; CREATED=0
# shellcheck disable=SC2317
cleanup() { rm -rf "$WORK"; [ "$CREATED" = 1 ] && rm -f "$REPO/.env.secrets"; }
trap cleanup EXIT
if [ ! -e "$REPO/.env.secrets" ]; then (umask 077; : > "$REPO/.env.secrets"); CREATED=1; fi

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }
render() {  # render <TAILSCALE_IP value> <compose args…>
  local ts="$1"; shift
  env -u OPENBRAIN_DATA_DIR TAILSCALE_IP="$ts" \
    docker compose --env-file /dev/null "$@" config --format json 2>"$WORK/stderr"
}
# shellcheck disable=SC2016
BINDS='all(.services[].volumes[]?; .type != "bind" or .bind.create_host_path == false)'
SHORT_LIST='[.services | to_entries[] | .key as $s | .value.volumes[]?
   | select(.type == "bind" and .bind.create_host_path != false) | "\($s):\(.target)"]'

# --- binds-fail-closed
if render "$TS" -f "$BASE" | jq -e "$BINDS" >/dev/null; then
  pass "binds-fail-closed: every bind has create_host_path false"
else
  fail "binds-fail-closed: these binds still create a missing host path:"
  render "$TS" -f "$BASE" | jq -r "$SHORT_LIST | .[]" 2>/dev/null | sed 's/^/    /'
fi

# --- tailscale-required
for v in "" ; do
  if render "$v" -f "$BASE" >/dev/null; then
    fail "tailscale-required: render succeeded with TAILSCALE_IP empty"
  elif grep -q TAILSCALE_IP "$WORK/stderr"; then
    pass "tailscale-required: empty TAILSCALE_IP fails and the message names it"
  else
    fail "tailscale-required: failed, but the message does not name TAILSCALE_IP"
  fi
done
if env -u TAILSCALE_IP -u OPENBRAIN_DATA_DIR docker compose --env-file /dev/null -f "$BASE" config -q 2>"$WORK/stderr"; then
  fail "tailscale-required: render succeeded with TAILSCALE_IP unset"
else
  pass "tailscale-required: unset TAILSCALE_IP fails"
fi

# --- core-api-ports
PORTS="$(render "$TS" -f "$BASE" | jq -c '[.services["core-api"].ports[] | {host_ip, published, target}]')"
WANT='[{"host_ip":"127.0.0.1","published":"3002","target":3000},{"host_ip":"100.64.0.1","published":"3002","target":3000}]'
if [ "$(jq -S -c . <<<"$PORTS")" = "$(jq -S -c . <<<"$WANT")" ] \
   && ! jq -e 'any(.[]; .host_ip == "0.0.0.0" or .host_ip == null)' <<<"$PORTS" >/dev/null; then
  pass "core-api-ports: 127.0.0.1:3002 + \$TAILSCALE_IP:3002, no wildcard"
else
  fail "core-api-ports: unexpected render: $PORTS"
fi

# --- negative controls
cat > "$WORK/short.yml" <<'YML'
services:
  redis:
    volumes:
      - ./config:/x:ro
YML
if render "$TS" -f "$BASE" -f "$WORK/short.yml" | jq -e "$BINDS" >/dev/null; then
  fail "negative control: a short-syntax bind was NOT rejected"
else
  pass "negative control: short-syntax bind is rejected"
fi
sed 's/\${TAILSCALE_IP:?[^}]*}/${TAILSCALE_IP:-100.101.61.122}/' "$BASE" > "$REPO/.compose-neg.tmp.yml"
if env -u TAILSCALE_IP docker compose --env-file /dev/null -f "$REPO/.compose-neg.tmp.yml" config -q 2>/dev/null; then
  pass "negative control: the old :- fallback renders without a value (so the guard above is meaningful)"
else
  fail "negative control: fallback variant unexpectedly failed"
fi
rm -f "$REPO/.compose-neg.tmp.yml"

echo
[ "$FAILS" -eq 0 ] && { echo "OK: host bindings fail closed."; exit 0; }
echo "FAILED: $FAILS check(s)."; exit 1
