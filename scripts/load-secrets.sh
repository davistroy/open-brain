#!/usr/bin/env bash
# load-secrets.sh — Reconcile Open Brain .env.secrets from Bitwarden Secrets Manager.
#
# Replaces the pre-P08 stub. Single command rebuilds .env.secrets after a
# disaster-recovery rebuild or fresh deploy. Counterpart to scripts/backup.sh
# (P04b) which strips .env.secrets from the backup payload — round-trip:
#   backup.sh strips  ->  load-secrets.sh restores  ->  verify-secrets.sh audits
#
# Usage:
#   bash scripts/load-secrets.sh                   # full reconcile (refuses clobber)
#   bash scripts/load-secrets.sh --force           # overwrite existing .env.secrets
#   bash scripts/load-secrets.sh --dry-run         # list what would be written
#   bash scripts/load-secrets.sh --verify-hash     # check sha256 sidecar (no writes)
#   bash scripts/load-secrets.sh --rehash-only     # regenerate .sha256 only
#   bash scripts/load-secrets.sh --target-dir DIR  # default: $APP_DIR or cwd
#
# Env overrides:
#   BWS_BIN               override path to bws binary (default ~/bin/bws.exe then PATH lookup)
#   BWS_ACCESS_TOKEN      required for actual BWS calls (mock skips)
#   APP_DIR               default --target-dir
#   PUSHOVER_API_URL      override Pushover endpoint (test mock)
#
# Exit codes:
#   0  success / hash match
#   1  precondition failure (missing bws, jq, BWS_ACCESS_TOKEN, etc.)
#   2  required secret missing in BWS — partial file NOT written
#   3  refuse to clobber existing .env.secrets (use --force)
#   4  --verify-hash mismatch (sha256 drift detected)
#   5  unexpected runtime error
#
# Notes:
#   - bws secret list may include unrelated projects if BWS_ACCESS_TOKEN scopes
#     more than one. The mapping table filters by name; extras are ignored.
#   - .env.secrets and .env.secrets.sha256 are written 0600. .gitignore covers both.
#   - Atomic write: $TMP_ENV_SECRETS -> mv onto target (POSIX-atomic on same FS).
#   - Never echoes secret VALUES — only ENV_VAR / BWS-name identifiers.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/secrets-map.sh
source "${SCRIPT_DIR}/lib/secrets-map.sh"
# shellcheck source=lib/pushover-notify.sh
source "${SCRIPT_DIR}/lib/pushover-notify.sh"

# -----------------------------------------------------------------------------
# Parse flags
# -----------------------------------------------------------------------------
MODE="reconcile"   # reconcile | dry-run | verify-hash | rehash-only
FORCE="false"
TARGET_DIR="${APP_DIR:-$(pwd)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      MODE="dry-run"; shift ;;
    --verify-hash)  MODE="verify-hash"; shift ;;
    --rehash-only)  MODE="rehash-only"; shift ;;
    --force)        FORCE="true"; shift ;;
    --target-dir)   TARGET_DIR="$2"; shift 2 ;;
    --target-dir=*) TARGET_DIR="${1#*=}"; shift ;;
    -h|--help)
      sed -n '1,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "ERROR: unknown flag: $1" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

ENV_SECRETS_FILE="${TARGET_DIR}/.env.secrets"
SHA_FILE="${ENV_SECRETS_FILE}.sha256"

# -----------------------------------------------------------------------------
# Preconditions
# -----------------------------------------------------------------------------
need_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq is required (not found in PATH)" >&2
    echo "  Unraid: install via nerdpack or 'apt install jq'" >&2
    exit 1
  fi
}

resolve_bws_bin() {
  if [[ -n "${BWS_BIN:-}" ]]; then
    if [[ ! -x "${BWS_BIN}" && ! -f "${BWS_BIN}" ]]; then
      echo "ERROR: BWS_BIN=${BWS_BIN} not found or not executable" >&2
      exit 1
    fi
    return 0
  fi
  # Default: prefer ~/bin/bws.exe (Windows convention from CLAUDE.md), then PATH
  if [[ -f "${HOME}/bin/bws.exe" ]]; then
    BWS_BIN="${HOME}/bin/bws.exe"
  elif [[ -f "${HOME}/bin/bws" ]]; then
    BWS_BIN="${HOME}/bin/bws"
  elif command -v bws >/dev/null 2>&1; then
    BWS_BIN="$(command -v bws)"
  else
    echo "ERROR: bws CLI not found (~/bin/bws.exe, ~/bin/bws, or PATH)" >&2
    exit 1
  fi
  export BWS_BIN
}

require_bws_token() {
  if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
    echo "ERROR: BWS_ACCESS_TOKEN is not set" >&2
    echo "  Export it from your shell before running this script." >&2
    exit 1
  fi
}

# -----------------------------------------------------------------------------
# Mode: --verify-hash (no writes, no BWS calls; pure local check)
# -----------------------------------------------------------------------------
if [[ "$MODE" == "verify-hash" ]]; then
  if [[ ! -f "${ENV_SECRETS_FILE}" ]]; then
    echo "ERROR: ${ENV_SECRETS_FILE} not found" >&2
    exit 1
  fi
  if [[ ! -f "${SHA_FILE}" ]]; then
    echo "ERROR: ${SHA_FILE} not found — run load-secrets.sh --rehash-only to create" >&2
    exit 1
  fi
  expected="$(awk '{print $1; exit}' "${SHA_FILE}")"
  actual="$(sha256sum "${ENV_SECRETS_FILE}" | awk '{print $1}')"
  if [[ "$expected" == "$actual" ]]; then
    echo "OK: .env.secrets sha256 matches sidecar (${actual:0:12}...)"
    exit 0
  fi
  echo "DRIFT: .env.secrets sha256 mismatch" >&2
  echo "  expected: ${expected}" >&2
  echo "  actual:   ${actual}" >&2
  notify_pushover_mismatch "Secrets file SHA256 differs from expected (${actual:0:12} != ${expected:0:12}). Run load-secrets.sh --force to reconcile, or load-secrets.sh --rehash-only after intentional manual edits." || true
  exit 4
fi

# -----------------------------------------------------------------------------
# Mode: --rehash-only (regenerate .sha256 only; no BWS calls)
# -----------------------------------------------------------------------------
if [[ "$MODE" == "rehash-only" ]]; then
  if [[ ! -f "${ENV_SECRETS_FILE}" ]]; then
    echo "ERROR: ${ENV_SECRETS_FILE} not found — nothing to hash" >&2
    exit 1
  fi
  sha256sum "${ENV_SECRETS_FILE}" | awk '{print $1}' > "${SHA_FILE}"
  chmod 0600 "${SHA_FILE}"
  echo "OK: rewrote ${SHA_FILE}"
  exit 0
fi

# -----------------------------------------------------------------------------
# Modes: reconcile + dry-run (both need BWS)
# -----------------------------------------------------------------------------
need_jq
resolve_bws_bin
require_bws_token

# Refuse to clobber existing .env.secrets unless --force or --dry-run.
if [[ "$MODE" == "reconcile" && -e "${ENV_SECRETS_FILE}" && "$FORCE" != "true" ]]; then
  echo "ERROR: ${ENV_SECRETS_FILE} already exists" >&2
  echo "  Re-run with --force to overwrite, --rehash-only to refresh sha sidecar," >&2
  echo "  or --verify-hash to check drift." >&2
  exit 3
fi

if [[ ! -d "${TARGET_DIR}" ]]; then
  echo "ERROR: target dir ${TARGET_DIR} does not exist" >&2
  exit 1
fi
if [[ ! -w "${TARGET_DIR}" ]]; then
  echo "ERROR: target dir ${TARGET_DIR} is not writable" >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# Pull BWS secrets in one call
# -----------------------------------------------------------------------------
echo "Loading Open Brain secrets from BWS via ${BWS_BIN}..."
if ! BWS_JSON="$("${BWS_BIN}" secret list --output json 2>/dev/null)"; then
  echo "ERROR: 'bws secret list' failed (check BWS_ACCESS_TOKEN scope and connectivity)" >&2
  exit 1
fi

# Build a name->value lookup once. Use a temp file (not env vars) so we never
# expose secret values in the process listing.
LOOKUP_FILE="$(mktemp)"
trap 'rm -f "${LOOKUP_FILE}" "${TMP_ENV_SECRETS:-}"' EXIT

# Emit "key\tvalue" TSV lines (tab-separated; values may contain '=' but not tab).
# jq -r with @tsv handles escaping; if any secret legitimately contains a tab
# we'd need a different separator, but no Open Brain secret should.
echo "${BWS_JSON}" | jq -r '.[] | [.key, .value] | @tsv' > "${LOOKUP_FILE}"

# Helper: look up a BWS-name in the JSON, echo the value (or empty string).
# Uses awk to extract the second column on tab-delimited input.
lookup_bws() {
  local key="$1"
  awk -F'\t' -v k="$key" '$1 == k {print $2; exit}' "${LOOKUP_FILE}"
}

# -----------------------------------------------------------------------------
# Reconcile: required first (collect missing), then optional (best-effort).
# -----------------------------------------------------------------------------
MISSING_REQUIRED=()
PRESENT_OPTIONAL=()
MISSING_OPTIONAL=()

# Pre-pass: required.
for bws_name in "${!REQUIRED_SECRETS[@]}"; do
  env_name="${REQUIRED_SECRETS[$bws_name]}"
  value="$(lookup_bws "$bws_name")"
  if [[ -z "$value" ]]; then
    MISSING_REQUIRED+=("${env_name} (BWS: ${bws_name})")
  fi
done

# Fail fast on any missing required.
if (( ${#MISSING_REQUIRED[@]} > 0 )); then
  echo "ERROR: ${#MISSING_REQUIRED[@]} required secret(s) missing from BWS:" >&2
  for missing in "${MISSING_REQUIRED[@]}"; do
    echo "  - ${missing}" >&2
  done
  echo "Refusing to write a partial .env.secrets." >&2
  exit 2
fi

# Pre-pass: optional inventory (no errors, just bookkeeping).
for bws_name in "${!OPTIONAL_SECRETS[@]}"; do
  env_name="${OPTIONAL_SECRETS[$bws_name]}"
  value="$(lookup_bws "$bws_name")"
  if [[ -n "$value" ]]; then
    PRESENT_OPTIONAL+=("${env_name}")
  else
    MISSING_OPTIONAL+=("${env_name}")
  fi
done

# -----------------------------------------------------------------------------
# Dry-run: print plan and exit (no disk writes).
# -----------------------------------------------------------------------------
if [[ "$MODE" == "dry-run" ]]; then
  echo ""
  echo "=== DRY RUN (no files written) ==="
  echo "Target: ${ENV_SECRETS_FILE}"
  echo ""
  echo "Required (${#REQUIRED_SECRETS[@]}):"
  for bws_name in "${!REQUIRED_SECRETS[@]}"; do
    env_name="${REQUIRED_SECRETS[$bws_name]}"
    echo "  WOULD WRITE ${env_name} (from BWS: ${bws_name})"
  done
  echo ""
  echo "Optional present (${#PRESENT_OPTIONAL[@]}):"
  for env_name in "${PRESENT_OPTIONAL[@]}"; do
    echo "  WOULD WRITE ${env_name}"
  done
  echo ""
  echo "Optional missing (${#MISSING_OPTIONAL[@]}) — skipped silently:"
  for env_name in "${MISSING_OPTIONAL[@]}"; do
    echo "  SKIP ${env_name}"
  done
  echo ""

  # Determine if SMTP_PORT would be emitted.
  smtp_port_emit="no"
  for trigger in "${SMTP_TRIGGER_ENVS[@]}"; do
    for present in "${PRESENT_OPTIONAL[@]}"; do
      if [[ "$present" == "$trigger" ]]; then
        smtp_port_emit="yes"
        break 2
      fi
    done
  done
  if [[ "$smtp_port_emit" == "yes" ]]; then
    echo "  WOULD WRITE SMTP_PORT=${SMTP_PORT_DEFAULT} (non-secret default; SMTP_* triggered)"
  else
    echo "  SKIP SMTP_PORT (no SMTP_* present)"
  fi
  echo ""
  echo "=== END DRY RUN ==="
  exit 0
fi

# -----------------------------------------------------------------------------
# Reconcile: write atomically.
# -----------------------------------------------------------------------------
TMP_ENV_SECRETS="$(mktemp -p "${TARGET_DIR}" .env.secrets.tmp.XXXXXX)"
chmod 0600 "${TMP_ENV_SECRETS}"

{
  echo "# =============================================================="
  echo "# Open Brain — .env.secrets"
  echo "# Generated by scripts/load-secrets.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "# Source of truth: Bitwarden Secrets Manager"
  echo "# DO NOT COMMIT. DO NOT BACK UP (see scripts/backup.sh P04b redaction)."
  echo "# Re-run load-secrets.sh after rotating any secret in BWS."
  echo "# =============================================================="
  echo ""
  echo "# --- Required (${#REQUIRED_SECRETS[@]}) ---"
  for bws_name in "${!REQUIRED_SECRETS[@]}"; do
    env_name="${REQUIRED_SECRETS[$bws_name]}"
    value="$(lookup_bws "$bws_name")"
    echo "${env_name}=${value}"
  done

  if (( ${#PRESENT_OPTIONAL[@]} > 0 )); then
    echo ""
    echo "# --- Optional present (${#PRESENT_OPTIONAL[@]}) ---"
    for bws_name in "${!OPTIONAL_SECRETS[@]}"; do
      env_name="${OPTIONAL_SECRETS[$bws_name]}"
      value="$(lookup_bws "$bws_name")"
      if [[ -n "$value" ]]; then
        echo "${env_name}=${value}"
      fi
    done

    # SMTP_PORT default if any SMTP_* present.
    smtp_port_emit="no"
    for trigger in "${SMTP_TRIGGER_ENVS[@]}"; do
      for present in "${PRESENT_OPTIONAL[@]}"; do
        if [[ "$present" == "$trigger" ]]; then
          smtp_port_emit="yes"
          break 2
        fi
      done
    done
    if [[ "$smtp_port_emit" == "yes" ]]; then
      echo "SMTP_PORT=${SMTP_PORT_DEFAULT}"
    fi
  fi
} > "${TMP_ENV_SECRETS}"

# Atomic move onto target.
mv "${TMP_ENV_SECRETS}" "${ENV_SECRETS_FILE}"
chmod 0600 "${ENV_SECRETS_FILE}"

# Compute sha256 sidecar.
sha256sum "${ENV_SECRETS_FILE}" | awk '{print $1}' > "${SHA_FILE}"
chmod 0600 "${SHA_FILE}"

# Clear trap (file successfully moved; LOOKUP_FILE stays in trap).
TMP_ENV_SECRETS=""

# Summary (no values).
written_required="${#REQUIRED_SECRETS[@]}"
written_optional="${#PRESENT_OPTIONAL[@]}"
echo ""
echo "OK: wrote ${ENV_SECRETS_FILE}"
echo "    ${written_required} required + ${written_optional} optional secrets"
echo "    sha256: $(awk '{print $1}' "${SHA_FILE}" | head -c 12)..."
echo "    sidecar: ${SHA_FILE}"
echo ""
echo "Verify with: bash scripts/verify-secrets.sh"
exit 0
