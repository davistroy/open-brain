#!/usr/bin/env bash
# secrets-map.sh — Single source of truth for BWS-name -> ENV-var mapping.
#
# Sourced by scripts/load-secrets.sh and scripts/verify-secrets.sh.
# Do NOT set -euo pipefail here; let consumers control strictness.
# Define only `declare -A` arrays + simple constants.
#
# Adding a new secret is a STRICT 3-STEP LOCKSTEP (P08 CLAUDE.md rule):
#   1. Add the secret to Bitwarden Secrets Manager (BWS).
#   2. Add the env-var to deploy/.env.secrets.template.
#   3. Add the BWS-name -> ENV-var pair here.
# Skipping step 3 means load-secrets.sh silently misses it on the next reconcile.
#
# REQUIRED secrets MUST exist in BWS at reconcile time, or load-secrets.sh
# exits 2 and refuses to write a partial .env.secrets file.
# OPTIONAL secrets are written if present in BWS and silently skipped if not.

# Require Bash 4+ for associative arrays.
if [[ -z "${BASH_VERSION:-}" ]]; then
  echo "ERROR: secrets-map.sh requires bash (got non-bash shell)" >&2
  return 1 2>/dev/null || exit 1
fi
# shellcheck disable=SC2128
_bash_major="${BASH_VERSION%%.*}"
if (( _bash_major < 4 )); then
  echo "ERROR: secrets-map.sh requires bash 4+ (got ${BASH_VERSION})" >&2
  return 1 2>/dev/null || exit 1
fi
unset _bash_major

# -----------------------------------------------------------------------------
# REQUIRED secrets (13) — must be present in BWS or reconcile fails.
# Map: BWS_SECRET_NAME -> ENV_VAR_NAME
# -----------------------------------------------------------------------------
declare -A REQUIRED_SECRETS=(
  ["open-brain-postgres-password"]="POSTGRES_PASSWORD"
  ["open-brain-openai-api-key"]="OPENAI_API_KEY"
  ["open-brain-mcp-api-key"]="MCP_API_KEY"
  ["open-brain-admin-api-key"]="ADMIN_API_KEY"
  ["open-brain-slack-bot-token"]="SLACK_BOT_TOKEN"
  ["open-brain-slack-app-token"]="SLACK_APP_TOKEN"
  ["open-brain-slack-user-token"]="SLACK_USER_TOKEN"
  ["open-brain-pushover-app-token"]="PUSHOVER_APP_TOKEN"
  ["open-brain-pushover-user-key"]="PUSHOVER_USER_KEY"
  ["dev/open-brain/gitea-token"]="GITEA_TOKEN"
  ["open-brain-cloudflare-tunnel-token"]="CLOUDFLARE_TUNNEL_TOKEN"
  ["open-brain-pushover-token"]="PUSHOVER_TOKEN"
  ["open-brain-pushover-user"]="PUSHOVER_USER"
)

# -----------------------------------------------------------------------------
# OPTIONAL secrets (7) — written if present in BWS, silently skipped if not.
# SMTP_HOST/USER/PASS/FROM are interlocked: any one present causes
# load-secrets.sh to also emit SMTP_PORT=$SMTP_PORT_DEFAULT (a non-secret).
# -----------------------------------------------------------------------------
declare -A OPTIONAL_SECRETS=(
  ["OPENCLAW_DEEPGRAM_API_KEY"]="DEEPGRAM_API_KEY"
  ["OPENCLAW_ANTHROPIC_API_KEY"]="ANTHROPIC_API_KEY"
  ["open-brain-smtp-host"]="SMTP_HOST"
  ["open-brain-smtp-user"]="SMTP_USER"
  ["open-brain-smtp-pass"]="SMTP_PASS"
  ["open-brain-smtp-from"]="SMTP_FROM"
  ["open-brain-grafana-admin-password"]="GRAFANA_ADMIN_PASSWORD"
  # A119: BWS item creation operator-deferred until mobile testing begins.
  # Consumer: core-api mobile Bearer auth (Phase 6.2 middleware + Phase 6.4 client).
  ["dev/open-brain/mobile-api-key"]="MOBILE_API_KEY"
)

# Non-secret SMTP port default emitted alongside any SMTP_* present.
SMTP_PORT_DEFAULT="587"

# Names of env-vars that, if any are populated, cause SMTP_PORT to be emitted.
SMTP_TRIGGER_ENVS=("SMTP_HOST" "SMTP_USER" "SMTP_PASS" "SMTP_FROM")
