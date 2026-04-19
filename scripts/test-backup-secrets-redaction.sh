#!/usr/bin/env bash
# test-backup-secrets-redaction.sh
#
# Regression test: verify scripts/backup.sh does NOT copy .env.secrets
# (or any file containing real secret variable names) into the backup payload.
#
# Usage: bash scripts/test-backup-secrets-redaction.sh
# Exit code: 0 = clean, 1 = secrets found or unexpected error
#
# This test overrides BACKUP_ROOT and APP_DIR to ephemeral temp directories
# (requires the `:-` env-override pattern on scripts/backup.sh lines 13–14).
# It does NOT connect to Docker or Postgres — backup.sh will emit warnings
# when it can't find containers; those are expected. Only the file-copy
# behaviour of step 2 is under test.
#
# Secrets policy: this script MUST NEVER print real secret values. The grep
# pattern matches only variable names; filenames (-l) are printed, not content.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- Ephemeral directories ---
WORK_DIR=$(mktemp -d)
FAKE_APP_DIR="${WORK_DIR}/app"
FAKE_BACKUP_ROOT="${WORK_DIR}/backup"

mkdir -p "${FAKE_APP_DIR}/config"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

echo "=== P04b redaction regression test ==="
echo "  Work dir: ${WORK_DIR}"

# Fake .env.secrets with KNOWN-FAKE values matching real variable names.
cat > "${FAKE_APP_DIR}/.env.secrets" << 'FAKE_SECRETS'
BWS_ACCESS_TOKEN=fake_bws_token_for_test
ANTHROPIC_API_KEY=fake_anthropic_key
OPENAI_API_KEY=fake_openai_key
SLACK_BOT_TOKEN=fake_slack_bot
SLACK_APP_TOKEN=fake_slack_app
SLACK_USER_TOKEN=fake_slack_user
PUSHOVER_TOKEN=fake_pushover_token
PUSHOVER_APP_TOKEN=fake_pushover_app
PUSHOVER_USER_KEY=fake_pushover_user
POSTGRES_PASSWORD=fake_pg_password
MCP_API_KEY=fake_mcp_key
ADMIN_API_KEY=fake_admin_key
GITEA_TOKEN=fake_gitea
CLOUDFLARE_TUNNEL_TOKEN=fake_cf_tunnel
DEEPGRAM_API_KEY=fake_deepgram
SMTP_PASS=fake_smtp_pass
FAKE_SECRETS

cat > "${FAKE_APP_DIR}/.env" << 'FAKE_ENV'
NODE_ENV=production
LOG_LEVEL=info
FAKE_ENV

cat > "${FAKE_APP_DIR}/.env.example" << 'FAKE_EXAMPLE'
# Non-sensitive config only — all secrets retrieved from Bitwarden
NODE_ENV=production
LOG_LEVEL=info
FAKE_EXAMPLE

echo 'version: "3"' > "${FAKE_APP_DIR}/docker-compose.yml"
echo 'log_level: info' > "${FAKE_APP_DIR}/config/app.yaml"

# --- Run backup.sh with overridden paths ---
export APP_DIR="${FAKE_APP_DIR}"
export BACKUP_ROOT="${FAKE_BACKUP_ROOT}"

echo ""
echo "Running backup.sh (Docker/Postgres steps will fail — expected)..."
echo "---"

# backup.sh uses `set -euo pipefail` and will exit non-zero on missing
# containers (step 1). We need step 2 (config copy) to run before the exit.
# backup.sh ordering: step 1 = Postgres dump, step 2 = config files.
# The Postgres step exits 1 on missing container (line 52), so step 2 never
# runs. Fix: inject a fake docker wrapper OR pre-create the backup dir and
# assert on whatever files get written.
#
# Chosen approach: pre-create BACKUP_FILE, run a STRIPPED version of step 2
# inline (sourcing the config block only). Alternative — refactor backup.sh
# to have a `--dry-run-config-only` mode — is deferred; out of P04b scope.

# Simulate what backup.sh step 2 would do, honoring the env overrides:
DATE=$(date +%Y-%m-%d)
BACKUP_FILE="${FAKE_BACKUP_ROOT}/daily/${DATE}"
export CONFIG_DIR="${BACKUP_FILE}/config"
mkdir -p "$CONFIG_DIR"

# Extract ONLY the config-copy commands from backup.sh section 2 and run them.
# Using `sed -n` to pull lines 74–86 (the config-copy block post-redaction).
# After 1.1 lands, line 80 will be deleted, so this range copies only safe files.
sed -n '74,86p' "${SCRIPT_DIR}/backup.sh" | bash

echo "---"
echo ""

# --- Sanity: verify at least one expected non-secret file was copied ---
# Catches a vacuous pass where no files were written at all.
if [ ! -f "${CONFIG_DIR}/dot-env" ]; then
  echo ""
  echo "FAIL: Sanity check — dot-env was not written to backup tree."
  echo "This means the config-copy block did not run at all (vacuous pass)."
  echo "Check that CONFIG_DIR is exported and the sed line range is correct."
  exit 1
fi
echo "Sanity check passed: dot-env present in backup tree."

# --- Grep the backup output for secret variable names ---
echo "Scanning backup tree for secret variable names..."

SECRET_PATTERN='BWS_ACCESS_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|SLACK_USER_TOKEN|PUSHOVER_TOKEN|PUSHOVER_APP_TOKEN|PUSHOVER_USER_KEY|POSTGRES_PASSWORD|MCP_API_KEY|ADMIN_API_KEY|GITEA_TOKEN|CLOUDFLARE_TUNNEL_TOKEN|DEEPGRAM_API_KEY|SMTP_PASS'

MATCHES=$(grep -rl -E "${SECRET_PATTERN}" "${FAKE_BACKUP_ROOT}" 2>/dev/null || true)

if [ -n "${MATCHES}" ]; then
  echo ""
  echo "FAIL: Secret variable names found in backup tree:"
  echo "${MATCHES}" | sed 's/^/  /'
  echo ""
  echo "This means .env.secrets (or equivalent) was copied into the backup payload."
  echo "Fix: remove the offending cp line from scripts/backup.sh (work item 1.1)."
  exit 1
fi

echo ""
echo "PASS: Zero secret variable-name matches in backup tree."
echo "  Backup location: ${FAKE_BACKUP_ROOT}"
echo "  Pattern checked: ${SECRET_PATTERN}"
echo ""
echo "=== test-backup-secrets-redaction: PASSED ==="
exit 0
