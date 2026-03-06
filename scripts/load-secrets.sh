#!/usr/bin/env bash
# load-secrets.sh — Load Open Brain secrets from Bitwarden Secrets Manager
# Usage: source ./scripts/load-secrets.sh
# Requires: bws CLI (~/bin/bws.exe) and BWS_ACCESS_TOKEN env var set

set -euo pipefail

BWS_BIN="${HOME}/bin/bws.exe"

if [[ ! -f "${BWS_BIN}" ]]; then
  echo "ERROR: bws CLI not found at ${BWS_BIN}" >&2
  exit 1
fi

if [[ -z "${BWS_ACCESS_TOKEN:-}" ]]; then
  echo "ERROR: BWS_ACCESS_TOKEN is not set" >&2
  exit 1
fi

echo "Loading Open Brain secrets from Bitwarden..."

# List all secrets and filter by project name
# Secrets are stored under the 'ai-work' project in Bitwarden
SECRETS=$("${BWS_BIN}" secret list 2>/dev/null)

# Export secrets by name — adjust secret IDs/names after initial Bitwarden setup
# Example: export LITELLM_API_KEY=$("${BWS_BIN}" secret get <secret-id> | jq -r '.value')

echo "NOTE: Update this script with actual Bitwarden secret IDs after initial setup."
echo "See CLAUDE.md for the secrets management policy."
echo ""
echo "Secrets loaded (or skipped if not yet configured)."
