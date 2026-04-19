#!/usr/bin/env bash
# verify-secrets.sh — Read-only audit: required ENV vars vs BWS vs .env.secrets.
#
# Companion to scripts/load-secrets.sh (P08). Pure inspection, no writes.
#
# Usage:
#   bash scripts/verify-secrets.sh                 # full markdown table to stdout
#   bash scripts/verify-secrets.sh --quiet         # summary line only
#   bash scripts/verify-secrets.sh --check-hash    # delegate to load-secrets.sh --verify-hash
#   bash scripts/verify-secrets.sh --target-dir DIR  # default: $APP_DIR or cwd
#
# Exit codes:
#   0  all required present in both BWS and .env.secrets
#   1  drift detected (any required missing from either side)
#   2  BWS unreachable (auth/network/precondition failure)
#   4  --check-hash mismatch (delegated)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/secrets-map.sh
source "${SCRIPT_DIR}/lib/secrets-map.sh"

# -----------------------------------------------------------------------------
# Parse flags
# -----------------------------------------------------------------------------
QUIET="false"
CHECK_HASH="false"
TARGET_DIR="${APP_DIR:-$(pwd)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --quiet)        QUIET="true"; shift ;;
    --check-hash)   CHECK_HASH="true"; shift ;;
    --target-dir)   TARGET_DIR="$2"; shift 2 ;;
    --target-dir=*) TARGET_DIR="${1#*=}"; shift ;;
    -h|--help)
      sed -n '1,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

ENV_SECRETS_FILE="${TARGET_DIR}/.env.secrets"

# -----------------------------------------------------------------------------
# --check-hash: delegate to load-secrets.sh, propagate exit code.
# -----------------------------------------------------------------------------
if [[ "$CHECK_HASH" == "true" ]]; then
  bash "${SCRIPT_DIR}/load-secrets.sh" --verify-hash --target-dir "${TARGET_DIR}"
  exit $?
fi

# -----------------------------------------------------------------------------
# Pull BWS catalog (just keys; values not needed for audit).
# -----------------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not found in PATH" >&2
  exit 2
fi

BWS_BIN="${BWS_BIN:-}"
if [[ -z "$BWS_BIN" ]]; then
  if   [[ -f "${HOME}/bin/bws.exe" ]]; then BWS_BIN="${HOME}/bin/bws.exe"
  elif [[ -f "${HOME}/bin/bws"     ]]; then BWS_BIN="${HOME}/bin/bws"
  elif command -v bws >/dev/null 2>&1; then BWS_BIN="$(command -v bws)"
  else
    echo "ERROR: bws CLI not found" >&2
    exit 2
  fi
fi

if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
  echo "ERROR: BWS_ACCESS_TOKEN is not set" >&2
  exit 2
fi

if ! BWS_JSON="$("${BWS_BIN}" secret list --output json 2>/dev/null)"; then
  echo "ERROR: 'bws secret list' failed (auth or connectivity)" >&2
  exit 2
fi

BWS_KEYS_FILE="$(mktemp)"
trap 'rm -f "${BWS_KEYS_FILE}"' EXIT
echo "${BWS_JSON}" | jq -r '.[] | .key' > "${BWS_KEYS_FILE}"

bws_has() {
  grep -Fxq "$1" "${BWS_KEYS_FILE}"
}

# -----------------------------------------------------------------------------
# Local .env.secrets parse (key names only, never values).
# -----------------------------------------------------------------------------
ENV_KEYS_FILE="$(mktemp)"
# shellcheck disable=SC2064
trap "rm -f '${BWS_KEYS_FILE}' '${ENV_KEYS_FILE}'" EXIT

if [[ -f "${ENV_SECRETS_FILE}" ]]; then
  # Strip comments + blank lines + trailing CR; capture KEY before '='.
  grep -E '^[A-Z_][A-Z0-9_]*=' "${ENV_SECRETS_FILE}" | awk -F'=' '{print $1}' > "${ENV_KEYS_FILE}"
fi

env_has() {
  [[ -f "${ENV_KEYS_FILE}" ]] && grep -Fxq "$1" "${ENV_KEYS_FILE}"
}

# -----------------------------------------------------------------------------
# Build report rows. Required first, then optional.
# Status column:
#   OK     = present in both BWS and .env.secrets
#   DRIFT  = required, missing from one or both sides
#   PRESENT/MISSING = optional, informational only (no exit-code impact)
# -----------------------------------------------------------------------------
DRIFT_COUNT=0

declare -a ROWS=()

add_row() {
  ROWS+=("$1")
}

for bws_name in "${!REQUIRED_SECRETS[@]}"; do
  env_name="${REQUIRED_SECRETS[$bws_name]}"
  in_bws="no"; in_env="no"; status="OK"
  if bws_has "$bws_name"; then in_bws="yes"; fi
  if env_has "$env_name"; then in_env="yes"; fi
  if [[ "$in_bws" != "yes" || "$in_env" != "yes" ]]; then
    status="DRIFT"
    ((DRIFT_COUNT++))
  fi
  add_row "| ${env_name} | ${bws_name} | ${in_bws} | ${in_env} | ${status} |"
done

for bws_name in "${!OPTIONAL_SECRETS[@]}"; do
  env_name="${OPTIONAL_SECRETS[$bws_name]}"
  in_bws="no"; in_env="no"
  if bws_has "$bws_name"; then in_bws="yes"; fi
  if env_has "$env_name"; then in_env="yes"; fi
  if [[ "$in_bws" == "yes" && "$in_env" == "yes" ]]; then
    status="PRESENT"
  elif [[ "$in_bws" == "no" && "$in_env" == "no" ]]; then
    status="missing (optional)"
  else
    status="partial (optional)"
  fi
  add_row "| ${env_name} | ${bws_name} | ${in_bws} | ${in_env} | ${status} |"
done

# -----------------------------------------------------------------------------
# Render
# -----------------------------------------------------------------------------
if [[ "$QUIET" != "true" ]]; then
  echo ""
  echo "=== Open Brain — secrets audit ==="
  echo "Target:      ${ENV_SECRETS_FILE}"
  echo "BWS source:  ${BWS_BIN}"
  echo ""
  echo "| ENV_VAR | BWS_NAME | In BWS? | In .env.secrets? | Status |"
  echo "|---------|----------|---------|------------------|--------|"
  for row in "${ROWS[@]}"; do
    echo "$row"
  done
  echo ""
fi

if (( DRIFT_COUNT == 0 )); then
  echo "OK: 0 drift in ${#REQUIRED_SECRETS[@]} required secrets."
  exit 0
fi

echo "DRIFT: ${DRIFT_COUNT} of ${#REQUIRED_SECRETS[@]} required secret(s) missing from BWS or .env.secrets." >&2
echo "Run 'bash scripts/load-secrets.sh --force' to reconcile (after verifying BWS contents)." >&2
exit 1
