#!/usr/bin/env bash
# test-compose-data-binds.sh — the Postgres and Redis data directories must render
# as fail-closed bind mounts from the BASE compose file (remediation item 4.3,
# PLT-001 / DA7-05 / SA7-04).
#
# Why: until 4.3 the base file declared NAMED volumes (postgres_data, redis_data)
# and the live raw-bind pin existed only in the host's gitignored
# docker-compose.override.yml (ADR-0004). On a rebuilt host, or on any render that
# lost the override, a recreate started Postgres on an EMPTY named volume — an
# empty database that still passes its healthcheck. A SHORT-syntax bind is not
# enough either: it turns create_host_path back on, so a missing source becomes a
# freshly created empty directory and initdb runs on it. Long syntax with
# `bind.create_host_path: false` makes Docker refuse to start instead.
#
# Cases:
#   1. base file, no override, OPENBRAIN_DATA_DIR unset → binds at the live host paths
#   2. OPENBRAIN_DATA_DIR set → the bind sources follow it
#   3. base + deploy/docker-compose.override.yml.template → the template replaces the
#      two data binds by target (no append), stays fail-closed, and changes nothing else
#   4. negative control: a short-syntax override (today's host shape) must FAIL
#   5. negative control: an override that maps the data back to named volumes must FAIL
#
# Hygiene: renders are held in pipes only and never printed (`docker compose config`
# inlines env_file values). A failure prints the postgres/redis volume fields only.
# Hermetic: --env-file /dev/null, OPENBRAIN_DATA_DIR unset, no override auto-merge
# (explicit -f). Creates a placeholder .env.secrets only when absent, removes it after.
# Needs docker (compose v2) and jq; no daemon access beyond `config`.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
BASE="$REPO/docker-compose.yml"
TEMPLATE="$REPO/deploy/docker-compose.override.yml.template"

LIVE_PG="/mnt/user/appdata/open-brain/pgdata"
LIVE_RD="/mnt/user/appdata/open-brain/redis-data"
TPL_PG="/CHANGE_ME/open-brain/pgdata"
TPL_RD="/CHANGE_ME/open-brain/redis-data"

for bin in docker jq; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FAIL: $bin not found"; exit 1; }
done

WORK="$(mktemp -d)"
CREATED_SECRETS=0
# shellcheck disable=SC2317  # invoked via trap
cleanup() {
  rm -rf "$WORK"
  if [ "$CREATED_SECRETS" = 1 ]; then rm -f "$REPO/.env.secrets"; fi
}
trap cleanup EXIT
if [ ! -e "$REPO/.env.secrets" ]; then
  (umask 077; : > "$REPO/.env.secrets")
  CREATED_SECRETS=1
fi

# render <compose args…> — JSON render on stdout, nothing else.
render() {
  env -u OPENBRAIN_DATA_DIR TAILSCALE_IP="${TAILSCALE_IP:-100.64.0.1}" \
    docker compose --env-file /dev/null "$@" config --format json 2>"$WORK/stderr"
}
# shellcheck disable=SC2317  # invoked indirectly through check's "$fn"
render_dd() {  # render with OPENBRAIN_DATA_DIR=$1
  local dd="$1"; shift
  TAILSCALE_IP="${TAILSCALE_IP:-100.64.0.1}" OPENBRAIN_DATA_DIR="$dd" \
    docker compose --env-file /dev/null "$@" config --format json 2>"$WORK/stderr"
}

# The assertion: every postgres/redis mount is a bind with create_host_path false;
# exactly one data mount per service, at the expected source; no named data volume.
# shellcheck disable=SC2016  # jq programs: $pg/$rd/$m are jq variables, not shell
FILTER='
  def data($svc; $t): [.services[$svc].volumes[]? | select(.target == $t)];
  def one($m; $src): ($m | length) == 1 and $m[0].source == $src;
  all((.services.postgres.volumes[]?, .services.redis.volumes[]?);
      .type == "bind" and .bind.create_host_path == false)
  and one(data("postgres"; "/var/lib/postgresql/data"); $pg)
  and one(data("redis"; "/data"); $rd)
  and ((.volumes // {}) | (has("postgres_data") or has("redis_data")) | not)'
SHOW='{postgres: [.services.postgres.volumes[]? | {type, source, target, create_host_path: .bind.create_host_path}],
       redis:    [.services.redis.volumes[]?    | {type, source, target, create_host_path: .bind.create_host_path}],
       named_data_volumes: ((.volumes // {}) | keys | map(select(. == "postgres_data" or . == "redis_data")))}'

FAILS=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; FAILS=$((FAILS + 1)); }

# check <label> <want: ok|bad> <pg src> <rd src> <render fn> [render args…]
check() {
  local label="$1" want="$2" pg="$3" rd="$4" fn="$5"; shift 5
  local got=bad
  if "$fn" "$@" | jq -e --arg pg "$pg" --arg rd "$rd" "$FILTER" >/dev/null; then got=ok; fi
  if [ "$got" = "$want" ]; then
    pass "$label"
  else
    fail "$label (expected the assertion to be '$want', got '$got')"
    if [ -s "$WORK/stderr" ]; then sed 's/^/    compose: /' "$WORK/stderr"; fi
    "$fn" "$@" | jq -c "$SHOW" 2>/dev/null | sed 's/^/    /'
  fi
}

# 1. Base file alone — the fail-closed binds at the live host paths.
check "base render: postgres/redis are fail-closed binds at the live paths" ok \
  "$LIVE_PG" "$LIVE_RD" render -f "$BASE"

# 2. The data directory is a variable with a default.
check "OPENBRAIN_DATA_DIR moves both bind sources" ok \
  "/srv/ob-alt/pgdata" "/srv/ob-alt/redis-data" render_dd /srv/ob-alt -f "$BASE"

# 3. Tracked override template: replaces the data binds by target and stays fail-closed.
if [ -f "$TEMPLATE" ]; then
  check "base + template: data binds replaced by target, still fail-closed" ok \
    "$TPL_PG" "$TPL_RD" render -f "$BASE" -f "$TEMPLATE"
  # …and changes nothing else in the project.
  STRIP='def strip: .services.postgres.volumes |= map(select(.target != "/var/lib/postgresql/data"))
                   | .services.redis.volumes |= map(select(.target != "/data"));
         (.[0] | strip) == (.[1] | strip)'
  if jq -s -e "$STRIP" <(render -f "$BASE") <(render -f "$BASE" -f "$TEMPLATE") >/dev/null; then
    pass "template changes only the two data binds"
  else
    fail "template changes more than the two data binds (it must hold the postgres/redis data binds only)"
  fi
else
  fail "missing $TEMPLATE"
fi

# 4. Negative control: today's host override shape (short syntax) re-enables
#    create_host_path → the assertion must reject it. This is why items 8.2/8.3
#    remove the host override entry before each recreate.
cat > "$WORK/short.yml" <<EOF
services:
  postgres:
    volumes:
      - ${LIVE_PG}:/var/lib/postgresql/data
  redis:
    volumes:
      - ${LIVE_RD}:/data
EOF
check "negative control: short-syntax override is rejected" bad \
  "$LIVE_PG" "$LIVE_RD" render -f "$BASE" -f "$WORK/short.yml"

# 5. Negative control: a change back to named volumes must be rejected.
cat > "$WORK/named.yml" <<'EOF'
services:
  postgres:
    volumes:
      - postgres_data:/var/lib/postgresql/data
  redis:
    volumes:
      - redis_data:/data
volumes:
  postgres_data:
  redis_data:
EOF
check "negative control: named data volumes are rejected" bad \
  "$LIVE_PG" "$LIVE_RD" render -f "$BASE" -f "$WORK/named.yml"

echo
if [ "$FAILS" -eq 0 ]; then
  echo "OK: postgres/redis data render as fail-closed binds (5 cases + template parity)."
  exit 0
fi
echo "FAILED: $FAILS check(s). The Postgres/Redis data directories must be long-syntax binds"
echo "with bind.create_host_path: false in docker-compose.yml — never a named volume, never short syntax."
exit 1
