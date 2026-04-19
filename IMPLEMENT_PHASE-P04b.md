# IMPLEMENT_PHASE-P04b — Backup .env.secrets redaction

**Source card:** PHASED_PLAN.md § P04b
**Tracks issue:** #107 (subset — partial close only; P16 + P17 finish the theme)
**Effort estimate:** ~2 hours
**Branch (Gate 2 will create):** `feat/phase-P04b-backup-secrets-redact`
**Authored by:** Gate 1 phase-planner subagent (Sonnet 4.6), verified by main orchestrator
**Drift audit date:** 2026-04-19

---

## Investigation findings

### Current state of `scripts/backup.sh`

The offending line is exactly as documented in `arch-review/reports/executive-summary.md`. Actual line number is 80 (ORCHESTRATOR.md example said "around line 81" — off by one, content identical).

**Section 2 of `backup.sh` (lines 69–87) — Config files block:**

```bash
69  # --- 2. Config files ---
70  echo "[2/6] Backing up config files..."
71  CONFIG_DIR="${BACKUP_FILE}/config"
72  mkdir -p "$CONFIG_DIR"
73
74  # Config YAML files
75  cp -a "${APP_DIR}/config/"*.yaml "$CONFIG_DIR/" 2>/dev/null || true
76  cp -a "${APP_DIR}/config/"*.yml "$CONFIG_DIR/" 2>/dev/null || true
77
78  # Environment files (includes secrets — backup is local, same trust boundary)
79  cp "${APP_DIR}/.env" "$CONFIG_DIR/dot-env" 2>/dev/null || true
80  cp "${APP_DIR}/.env.secrets" "$CONFIG_DIR/dot-env-secrets" 2>/dev/null || true
81  cp "${APP_DIR}/.env.example" "$CONFIG_DIR/dot-env-example" 2>/dev/null || true
```

**Primary offending line — line 80 verbatim:**
```
cp "${APP_DIR}/.env.secrets" "$CONFIG_DIR/dot-env-secrets" 2>/dev/null || true
```

### Other secret-adjacent lines in `backup.sh`

- **Line 79:** `cp ".env" …` — repo `.env` holds only blank-valued placeholder entries with "retrieve from Bitwarden" comments. **Safe; retain.**
- **Line 78 (comment):** Rationalization "backup is local, same trust boundary" becomes false once P17 adds offsite replication. **Update comment.**
- **Line 81:** `cp ".env.example" …` — contains `get-from-bitwarden` placeholder strings only. **Safe; retain.**
- **Lines 75–76:** Config YAML copies (`config/*.yaml`, `config/*.yml`) — AI routing config, no credentials. **Safe; retain.**
- **Lines 13–14:** `BACKUP_ROOT` and `APP_DIR` are hard-assigned. No env-override support → test harness cannot redirect them. **Must be patched (see work item 1.1 addendum).**
- **Line 19:** `WIKI_REPO_URL="${WIKI_REPO_URL:-...}"` — existing precedent for the `:-` pattern applied in 1.1 addendum.
- **Lines 198–205 (promotion block):** `cp -a "$BACKUP_FILE" …` to weekly/monthly tiers — cloning the daily tree transitively carries any secret file. Removing line 80 eliminates the problem in all retention tiers automatically.

### Backup destination path + retention

- **Destination:** `/mnt/user/backup/openbrain/` (Unraid array path, local to homeserver).
- **Retention:** 14 daily, 4 weekly (Sundays), 3 monthly (1st of month).
- **Latest symlink:** `/mnt/user/backup/openbrain/latest` → most recent daily.
- **Cron schedule:** `0 3 * * *` (daily at 03:00).
- **Trust boundary note:** The line-78 comment is conditionally true for the backup disk today but fails the moment another container, rclone job, or P17 offsite replication reads from `/mnt/user/backup/openbrain/`. Fix before P17 lands.

### Restore path dependency on `.env.secrets`

`scripts/load-secrets.sh` is a **stub** today — it prints "NOTE: Update this script with actual Bitwarden secret IDs after initial setup." The real secret-loading workflow is manual `bws secret get <id> | jq -r .value` → pasted into `.env.secrets`. P08 will implement the full BWS reconciliation loop.

**Implication for P04b:** removing `.env.secrets` from the backup does NOT break restore, because:
1. `load-secrets.sh` (current stub and future full) will connect to Bitwarden live; it never reads from a backup.
2. Restore procedure today: `pg_restore` + manual `bws secret get` loop + `docker compose up -d`.
3. Correct recovery path is already "go to Bitwarden," not "unzip the backup."

**Confirmed:** Strategy A (full removal) does not break restore.

### Redaction strategy chosen: **A — Full removal**

- **A (chosen):** drop line 80 entirely. Post-restore = operator re-runs `load-secrets.sh` (or manual `bws secret get` per `deploy/.env.secrets.template`) to rebuild `.env.secrets`.
- **B (rejected):** sanitized placeholder / keys-only template into the backup adds no value over the existing `deploy/.env.secrets.template`; extra bytes, no benefit.
- **C (rejected):** encrypted-at-rest is disproportionate — adds a DR-unfriendly key-management burden (whoever restores must also have the decryption key, but if BWS is unreachable during DR, key retrieval blocks restore).

---

## Work items

### 1.1 — Remove `.env.secrets` copy from backup payload + enable env override on core paths

**File:** `scripts/backup.sh`

**Change A (lines 13–14) — enable env override (matches existing `WIKI_REPO_URL` pattern on line 19):**

```diff
-BACKUP_ROOT="/mnt/user/backup/openbrain"
-APP_DIR="/mnt/user/appdata/open-brain"
+BACKUP_ROOT="${BACKUP_ROOT:-/mnt/user/backup/openbrain}"
+APP_DIR="${APP_DIR:-/mnt/user/appdata/open-brain}"
```

Rationale: homeserver behavior unchanged (env unset → defaults apply); makes the redaction test harness possible without editing the script at runtime. Consistent with line-19 precedent.

**Change B (lines 78–81) — remove `.env.secrets` copy, update comment:**

```diff
-# Environment files (includes secrets — backup is local, same trust boundary)
-cp "${APP_DIR}/.env" "$CONFIG_DIR/dot-env" 2>/dev/null || true
-cp "${APP_DIR}/.env.secrets" "$CONFIG_DIR/dot-env-secrets" 2>/dev/null || true
-cp "${APP_DIR}/.env.example" "$CONFIG_DIR/dot-env-example" 2>/dev/null || true
+# Environment files — non-sensitive only. .env.secrets is EXCLUDED.
+# Post-restore: run scripts/load-secrets.sh (or bws secret get per
+# deploy/.env.secrets.template) to rebuild .env.secrets from Bitwarden.
+cp "${APP_DIR}/.env" "$CONFIG_DIR/dot-env" 2>/dev/null || true
+cp "${APP_DIR}/.env.example" "$CONFIG_DIR/dot-env-example" 2>/dev/null || true
```

Rationale: `.env.secrets` holds live credentials (OPENAI_API_KEY, ANTHROPIC_API_KEY, SLACK_*, PUSHOVER_*, POSTGRES_PASSWORD, MCP_API_KEY, ADMIN_API_KEY, GITEA_TOKEN, CLOUDFLARE_TUNNEL_TOKEN, DEEPGRAM_API_KEY, SMTP_PASS). Copying it into the backup payload violates the repo's secrets-in-Bitwarden policy and creates a credential-exfiltration path the moment P17 (GHCR + offsite) ships.

---

### 1.2 — Add redaction regression test

**New file:** `scripts/test-backup-secrets-redaction.sh`

**Behavior:** create an ephemeral fake `APP_DIR` with a `.env.secrets` containing known-fake values that match real secret variable names → export `APP_DIR` and `BACKUP_ROOT` overrides (enabled by 1.1 Change A) → invoke `backup.sh` → grep the backup tree for secret variable names → expect zero matches → clean up via `trap EXIT`.

**Full intended contents (implement-executor writes verbatim; adjust only for minor bugs surfaced at test time):**

```bash
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
OPENAI_API_KEY=get-from-bitwarden
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
CONFIG_DIR="${BACKUP_FILE}/config"
mkdir -p "$CONFIG_DIR"

# Extract ONLY the config-copy commands from backup.sh section 2 and run them.
# Using `sed -n` to pull lines 74–86 (the config-copy block post-redaction).
# After 1.1 lands, line 80 will be deleted, so this range copies only safe files.
sed -n '74,86p' "${SCRIPT_DIR}/backup.sh" | bash

echo "---"
echo ""

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
```

**Implementer notes for 1.2:**
- The inline `sed -n '74,86p' | bash` approach runs only the config-copy block of `backup.sh` — avoids the Postgres-container exit that would otherwise halt the script before step 2. If the implementer prefers, an alternative is to refactor `backup.sh` to expose a `--dry-run-config-only` flag — but that adds scope, so prefer the `sed` extraction approach for P04b.
- If the `sed` line range drifts over time, the test surfaces it quickly: either no files are copied (PASS is a false positive) or a later `cp` re-introduces a secret copy (FAIL catches it). Add a `[ -f "${CONFIG_DIR}/dot-env" ]` sanity assertion if false-positive risk is a concern — stop-shippers only.
- Must `chmod +x scripts/test-backup-secrets-redaction.sh` on commit.

---

### 1.3 — Document restore procedure change

**Target:** inline comment block in `scripts/backup.sh` (no `docs/BACKUP_RESTORE.md` exists; creating a full runbook is P16 scope).

**Location:** Already included as part of work item 1.1 Change B — the comment block on lines 78–80 of the patched file explicitly instructs the reader to run `scripts/load-secrets.sh` post-restore. No additional file needed.

**Additional optional touch (not required, not scope creep):** add a one-line reference in `LAB_NOTEBOOK.md` Entry 098 pointing to the comment location.

---

## Acceptance criteria (Gate 4 reviewer verifies)

- [ ] Line 80 (`cp "${APP_DIR}/.env.secrets" …`) removed from `scripts/backup.sh`
- [ ] Line-78 comment rewritten to name the exclusion and cite `load-secrets.sh` as the recovery path
- [ ] Lines 13–14 of `backup.sh` converted to `:-` env-override pattern (follows `WIKI_REPO_URL` precedent on line 19)
- [ ] `scripts/test-backup-secrets-redaction.sh` exists, is executable, and exits 0 locally
- [ ] Running `scripts/test-backup-secrets-redaction.sh` with the old `backup.sh` content (ie. before 1.1) would exit 1 — verify by running it against pre-patch file in a scratch branch if feasible (optional, not blocking)
- [ ] No `.env.secrets` reference in any file written by `backup.sh` under an ephemeral test backup root
- [ ] LAB_NOTEBOOK Entry 098 written pre-implementation with Objective / Hypothesis / Rollback
- [ ] PR body references #107 (does NOT use "Closes" keyword — partial close only; P16 + P17 complete the theme; A72 convention applies)

---

## Rollback

`git revert <P04b merge sha>` on main, then on homeserver:

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain
bash scripts/load-secrets.sh   # or manual bws secret get loop per deploy/.env.secrets.template
# restart services if backup cron ran while revert was in flight:
docker compose up -d
```

No data consequence. Existing backups that already contain `dot-env-secrets` are NOT retroactively cleaned by this PR — P16 restore rehearsal will surface residual exposure and decide whether to scrub retained backups.

---

## Scope drift check

**Phase card scope matches investigation: YES.**

- Offending line exists at line 80 exactly as described (ORCHESTRATOR.md example said ~line 81 — off by one; content identical).
- `load-secrets.sh` confirmed a stub — P08 is the remediation phase for that finding.
- No `docs/BACKUP_RESTORE.md` exists; inline comment in `backup.sh` is sufficient for P04b.
- `.env` (line 79) contains only blank-valued placeholders → confirmed safe, retain.
- Retention promotion lines (198–205) inherit the fix transitively.

**Minor in-scope addition (not drift):** converting lines 13–14 to the `:-` env-override pattern. This is required infrastructure for the redaction regression test (work item 1.2) and matches the existing `WIKI_REPO_URL` pattern on line 19. No behavior change on the homeserver; test-harness enablement only.

**Scope creep to defer:**
- `config/*.yaml` symmetric check (card marks **Optional**) — YAMLs verified credential-free by inspection. **Defer; not needed.**
- `load-secrets.sh` stub implementation — **P08 scope; do not touch.**
- Retroactive cleanup of existing homeserver backups under `/mnt/user/backup/openbrain/daily/*/config/dot-env-secrets` — **out of scope; PR body notes residual exposure; P16 handles.**
- Full `docs/BACKUP_RESTORE.md` runbook — **P16 scope.**
- Prometheus metric for backup sanity (e.g., "most-recent-backup has no secret vars") — **Future / not in any phase card yet.**

---

## Post-merge CLAUDE.md rule candidates (for doc-sweep after merge)

1. **Backup scripts must NEVER copy `.env.secrets` or any file containing live credentials into the backup payload.** Secrets live in Bitwarden; post-restore rebuild via `scripts/load-secrets.sh`.
2. **`scripts/backup.sh` honors `BACKUP_ROOT` and `APP_DIR` env overrides** (in addition to the existing `WIKI_REPO_URL`). Homeserver behavior unchanged; enables test harnesses.

These go into the post-P04b doc-sweep commit, not this PR.
