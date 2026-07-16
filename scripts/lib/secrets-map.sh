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
# REQUIRED secrets (12) — must be present in BWS or reconcile fails.
# Map: BWS_SECRET_NAME -> ENV_VAR_NAME
#
# The BWS-name column is NOT a convention — it is whatever the secret is
# literally called in Bitwarden. Verify with `bws secret list`, never assume
# (#278: 11 of 14 required names here were invented and matched nothing, so
# load-secrets.sh would have exit-2'd on any real DR rebuild).
#
# Most open-brain secrets use the `open-brain-*` prefix, which is deliberate:
# the machine token spans 3 projects and bare names COLLIDE across them
# (ANTHROPIC_API_KEY/OPENAI_API_KEY/GOOGLE_API_KEY each exist twice). A
# lookup is by `.key` alone, so a unique prefix is the only way to be sure
# you get open-brain's copy. PUSHOVER_*/GITEA_TOKEN are mapped bare only
# because those keys are unambiguous today.
# -----------------------------------------------------------------------------
declare -A REQUIRED_SECRETS=(
  ["open-brain-postgres-password"]="POSTGRES_PASSWORD"
  ["open-brain-redis-password"]="REDIS_PASSWORD"
  ["open-brain-openai-api-key"]="OPENAI_API_KEY"
  ["open-brain-mcp-api-key"]="MCP_API_KEY"
  ["open-brain-admin-api-key"]="ADMIN_API_KEY"
  ["open-brain-slack-bot-token"]="SLACK_BOT_TOKEN"
  ["open-brain-slack-app-token"]="SLACK_APP_TOKEN"
  ["PUSHOVER_API_TOKEN"]="PUSHOVER_APP_TOKEN"
  ["PUSHOVER_USER_KEY"]="PUSHOVER_USER_KEY"
  ["GITEA_TOKEN"]="GITEA_TOKEN"
  ["open-brain-cloudflare-tunnel-token"]="CLOUDFLARE_TUNNEL_TOKEN"
  # REQUIRED, not optional: the secret exists in BWS, and its absence silently
  # kills the whole T1 tier (#283 — 401 on 100% of calls for two weeks, unnoticed
  # because a totally-failing FREE tier looks identical to an idle one).
  ["dev/jetson/llm-api-key"]="JETSON_API_KEY"
)

# -----------------------------------------------------------------------------
# OPTIONAL secrets (9) — written if present in BWS, silently skipped if not.
# SMTP_HOST/USER/PASS/FROM are interlocked: any one present causes
# load-secrets.sh to also emit SMTP_PORT=$SMTP_PORT_DEFAULT (a non-secret).
# -----------------------------------------------------------------------------
declare -A OPTIONAL_SECRETS=(
  # SLACK_USER_TOKEN: demoted from REQUIRED (#278). It is an xoxp- user token
  # for Slack channel cleanup; it is NOT set in prod and does not exist in BWS,
  # so requiring it made every reconcile fail for an unconfigured feature.
  ["open-brain-slack-user-token"]="SLACK_USER_TOKEN"
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
  # INT-M5 (Phase 8.1): voice-capture Bearer auth. Optional/two-phase — when set,
  # voice-capture enforces Bearer on POST /api/capture and the core-api proxy
  # forwards it upstream; unset = pre-rollout warn-and-allow. BWS item creation
  # operator-deferred until the iOS Shortcut + clients are updated to send it.
  ["dev/open-brain/voice-capture-secret"]="VOICE_CAPTURE_SECRET"
  # #311 actual-ingest — Actual Budget daily job (spec §7). OPTIONAL until the
  # sidecar is deployed (OA-20), so current reconciles don't exit-2 for a secret
  # that isn't in BWS yet. Consumer: docker/actual-sidecar (env_file: .env.secrets).
  # ⚠️ OA-20 / #278: the BWS `.key` values below are PLACEHOLDERS — the Actual
  # creds live in BWS project `ai-work` (item "Actual Budget — My Finances").
  # VERIFY the real `.key` with `bws secret list` before the deploy; a wrong name
  # here is silently skipped (OPTIONAL), so actual-ingest would start with an
  # empty secret. Do NOT assume the names match this convention.
  ["actual-budget-password"]="ACTUAL_PASSWORD"
  ["actual-budget-sync-id"]="ACTUAL_SYNC_ID"
  ["actual-budget-server-url"]="ACTUAL_SERVER_URL"
)

# Non-secret SMTP port default emitted alongside any SMTP_* present.
SMTP_PORT_DEFAULT="587"

# Names of env-vars that, if any are populated, cause SMTP_PORT to be emitted.
SMTP_TRIGGER_ENVS=("SMTP_HOST" "SMTP_USER" "SMTP_PASS" "SMTP_FROM")
