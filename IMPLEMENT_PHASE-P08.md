# IMPLEMENT_PHASE-P08 — Secret delivery hygiene

**Phase:** P08
**Source card:** PHASED_PLAN.md § P08 (~line 376)
**Tracks issue:** #118 (High — load-secrets.sh stub → full BWS reconciliation)
**Severity:** High
**Effort estimate:** ~4 hours (matches card; no scope drift)
**Dependencies:** **P04b** (PR #129 — added the secrets-redaction guard in `scripts/backup.sh` and the regression test that this phase complements)
**Branch (Gate 2 will create):** `feat/phase-P08-secret-delivery-hygiene`
**Gate 5 path likely:** operator-approval — touches secrets-handling shell scripts and adds a CLAUDE.md operational rule (per ORCHESTRATOR.md matrix). Not a homeserver migration; can deploy at operator's discretion alongside the A70 batch.

---

## Scope Diff vs. PHASED_PLAN.md

**None — phase card matches current code state.** Verified:

- `scripts/load-secrets.sh` exists (33 lines) and is the stub described in MEMORY.md / Entry 091 PLAT-F1. Top of file already declares: *"Update this script with actual Bitwarden secret IDs after initial setup."* No reconciliation logic, no checksum, no Pushover.
- `deploy/.env.secrets.template` exists (116 lines) and lists **18 environment variables** across 9 sections: `POSTGRES_PASSWORD`, `OPENAI_API_KEY`, `MCP_API_KEY`, `ADMIN_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_USER_TOKEN`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`, `PUSHOVER_TOKEN`, `PUSHOVER_USER`, `GITEA_TOKEN`, `CLOUDFLARE_TUNNEL_TOKEN`, `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`. (Note: `SMTP_PORT` has a default value `587` in the template — must be treated as non-secret config or BWS-overridable.)
- `scripts/test-backup-secrets-redaction.sh` exists (139 lines, P04b-shipped). It is the structural template for the new shell-style fixture: `mktemp -d` ephemeral work dir, trap cleanup, fake fixture file, deterministic grep assertion, exit 0/1.
- `scripts/backup.sh` lines 78–82 already document the round trip: *"Post-restore: run scripts/load-secrets.sh (or bws secret get per deploy/.env.secrets.template)..."* — meaning the call site is already wired in operator runbook prose. P08 makes that call actually do something.
- `scripts/verify-secrets.sh` does **not** exist yet — clean slate.
- BWS naming convention: `~/.claude/CLAUDE.md` says `dev/{project-name}/{secret-type}` for new items, but `deploy/.env.secrets.template` references existing items by **flat names** like `open-brain-postgres-password`, `open-brain-openai-api-key`, `OPENCLAW_DEEPGRAM_API_KEY` (shared). The template's name-list is the ground truth for what `bws secret list` will return — load-secrets.sh must map BWS-name → ENV-name. **This mapping table is the single source of truth and lives in the script itself.**

---

## Context

P04b removed `.env.secrets` from the backup payload to ensure secrets never travel through `/mnt/user/backup/openbrain/`. That left a deliberate gap: after a homeserver disaster-recovery rebuild, the operator must re-hydrate `.env.secrets` from Bitwarden Secrets Manager. Today that hydration is manual copy-paste from the Bitwarden UI — error-prone (typos, forgotten variables, stale values) and slow (~18 secrets × 30s = 9 minutes of focused attention).

P08 closes the gap with three deliverables: **`load-secrets.sh`** (writes a fresh `.env.secrets` from BWS in one command), **checksum verification** (detect silent drift between BWS and the on-disk file), and **`verify-secrets.sh`** (read-only audit comparing required-vs-BWS-vs-local). Together with P04b, the system has a complete round-trip: backup strips secrets → load restores them → verify proves they're correct. Pushover alerts on mismatch ensure drift is noisy, not silent.

This phase touches **zero application code** — pure ops tooling. No homeserver migration, no Docker rebuild required to deploy.

---

## Investigation findings

### Required environment variables (from `deploy/.env.secrets.template`)

The template lists 18 keys. For BWS reconciliation, we partition them:

| ENV var | Bitwarden secret name (per template comment) | Required? | Notes |
|---|---|---|---|
| `POSTGRES_PASSWORD` | `open-brain-postgres-password` | yes | core |
| `OPENAI_API_KEY` | `open-brain-openai-api-key` | yes | all packages route LLM here |
| `MCP_API_KEY` | `open-brain-mcp-api-key` | yes | core-api auth |
| `ADMIN_API_KEY` | `open-brain-admin-api-key` (or reuse MCP_API_KEY) | yes | falls back to MCP_API_KEY |
| `SLACK_BOT_TOKEN` | `open-brain-slack-bot-token` | yes | slack-bot |
| `SLACK_APP_TOKEN` | `open-brain-slack-app-token` | yes | slack-bot socket mode |
| `SLACK_USER_TOKEN` | `open-brain-slack-user-token` | yes | core-api channel ops |
| `PUSHOVER_APP_TOKEN` | `open-brain-pushover-app-token` | yes | workers |
| `PUSHOVER_USER_KEY` | `open-brain-pushover-user-key` | yes | workers |
| `PUSHOVER_TOKEN` | `open-brain-pushover-token` | optional | legacy voice-capture (may equal APP_TOKEN) |
| `PUSHOVER_USER` | `open-brain-pushover-user` | optional | legacy voice-capture (may equal USER_KEY) |
| `GITEA_TOKEN` | `dev/open-brain/gitea-token` | yes | wiki repo |
| `CLOUDFLARE_TUNNEL_TOKEN` | `open-brain-cloudflare-tunnel-token` | yes | brain.troy-davis.com |
| `DEEPGRAM_API_KEY` | `OPENCLAW_DEEPGRAM_API_KEY` (shared) | optional | voice-pipecat only |
| `ANTHROPIC_API_KEY` | `OPENCLAW_ANTHROPIC_API_KEY` (shared) | optional | voice-pipecat only |
| `SMTP_HOST` | `open-brain-smtp-credentials` (compound) | optional | omit all 5 to disable email |
| `SMTP_PORT` | (constant default `587`, not a secret) | optional | template hard-codes 587 |
| `SMTP_USER` | `open-brain-smtp-credentials` (compound) | optional | |
| `SMTP_PASS` | `open-brain-smtp-credentials` (compound) | optional | |
| `SMTP_FROM` | `open-brain-smtp-credentials` (compound) | optional | |

**Required = 13.** **Optional = 6** (5 SMTP + 2 voice-pipecat, where SMTP_PORT is non-secret default). The script must:
1. Always populate the 13 required.
2. Populate optionals if the BWS secret exists; skip silently if not.
3. Write `SMTP_PORT=587` if any other SMTP_* is set; omit if none.

### Mapping table approach

A single `declare -A` Bash associative array at the top of `load-secrets.sh` defines `BWS_NAME → ENV_VAR` mappings. This is the **canonical mapping** — `verify-secrets.sh` reads from the same source via Bash sourcing or shared snippet (decided in work item 5).

### Checksum strategy

**Question:** where does the expected hash live?

Options considered:
- **A.** Committed to repo at `scripts/.env.secrets.expected-sha256`. Pro: visible in git history. Con: secrets file content is operator-environment-specific (BWS values can rotate); the hash would need to update on every secret rotation, polluting commit history.
- **B.** Stored in BWS itself (`open-brain-secrets-sha256`). Pro: lives with the secrets. Con: chicken-and-egg if BWS is the thing failing; operator can't audit drift without BWS access.
- **C.** Written to disk **by `load-secrets.sh` itself** at `/mnt/user/appdata/open-brain/.env.secrets.sha256`, then `verify-secrets.sh` (and an optional pre-deploy hook) re-hashes the live `.env.secrets` and compares. Pro: simple, local, no chicken-and-egg, no commit pollution. Con: if `.env.secrets` is hand-edited the hash file must be regenerated.

**Decision: Option C.** `load-secrets.sh` writes the hash file alongside `.env.secrets` after every successful run. `verify-secrets.sh --check-hash` re-hashes and compares; mismatch → Pushover alert + exit 1. Operator can intentionally bypass after manual edits via `load-secrets.sh --rehash-only` (rebuilds hash without rewriting the env file).

### Pushover delivery — shell or Node?

The script must run on a freshly rebuilt homeserver where Node may not yet be installed (it's a disaster-recovery scenario). **Decision: pure curl** to the Pushover API. Token + user key come from the just-loaded `.env.secrets` (or BWS directly if `.env.secrets` is missing/corrupt). Reuses the same env vars the workers use (`PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`).

Mock-friendly: `PUSHOVER_API_URL` env override defaults to `https://api.pushover.net/1/messages.json`. Test fixture sets it to a local sink (`http://127.0.0.1:NNN` or `file://...`).

### `bws secret list` JSON shape

`bws secret list --output json` (per BWS v2.0.0) returns an array of `{id, key, value, note, projectId, organizationId, creationDate, revisionDate}` objects. The script will:
- Run `bws secret list --output json` once (single round-trip; cheaper than per-secret `bws secret get`).
- Pipe through `jq` to produce `key=value` pairs for the keys in our mapping table.
- Validate `jq` is installed (Unraid's homeserver may need explicit install; document in CLAUDE.md if so).

---

## Work Items

### 1. Inventory & mapping table — `scripts/lib/secrets-map.sh`

Create a new shared file `scripts/lib/secrets-map.sh` containing:

```bash
# Single source of truth for BWS → ENV mapping.
# Sourced by load-secrets.sh and verify-secrets.sh.
declare -A REQUIRED_SECRETS=(
  ["open-brain-postgres-password"]="POSTGRES_PASSWORD"
  ["open-brain-openai-api-key"]="OPENAI_API_KEY"
  # ... 13 entries ...
)
declare -A OPTIONAL_SECRETS=(
  ["open-brain-pushover-token"]="PUSHOVER_TOKEN"
  ["OPENCLAW_DEEPGRAM_API_KEY"]="DEEPGRAM_API_KEY"
  # ... 5 entries (SMTP* compound + voice-pipecat) ...
)
SMTP_PORT_DEFAULT="587"
```

**Deliverable:** mapping file exists, sourced by both consumer scripts. **Verify:** `bash -c 'source scripts/lib/secrets-map.sh && echo "${#REQUIRED_SECRETS[@]}"'` prints `13`.

**Depends on:** nothing. **Blocks:** items 2, 5.

---

### 2. Implement `scripts/load-secrets.sh` — full BWS reconciliation

Replace the 33-line stub with a full implementation:

- Source `scripts/lib/secrets-map.sh`.
- Validate preconditions: `BWS_BIN` exists, `BWS_ACCESS_TOKEN` set, `jq` available, output dir writable.
- Flags: `--force` (overwrite existing `.env.secrets`), `--dry-run` (list what would be written, no writes), `--rehash-only` (regenerate `.sha256` without rewriting env file), `--target-dir <dir>` (default `$APP_DIR` or cwd).
- Pull all secrets in one call: `bws secret list --output json`.
- Build `.env.secrets.tmp` atomically: write header banner (timestamp + warning), then `KEY=value` lines for each required + each present optional + `SMTP_PORT=587` if any SMTP_* present.
- For required keys missing from BWS: collect into a list; **fail fast** (exit 2, list missing keys) — do NOT write a partial file.
- For optional keys missing: log to stderr, continue.
- `chmod 0600 .env.secrets.tmp`, then `mv .env.secrets.tmp .env.secrets` (atomic on POSIX).
- Compute `sha256sum .env.secrets > .env.secrets.sha256` (also `chmod 0600`).
- Refuse to clobber existing `.env.secrets` unless `--force` (exit 3 with message pointing to `--force` and `--rehash-only`).

**Deliverable:** `bash scripts/load-secrets.sh --dry-run` lists 13 required + N optional present in BWS without touching disk. **Verify:**
- `bash scripts/load-secrets.sh --dry-run | grep -c '^WOULD WRITE'` returns at least 13.
- After full run with valid BWS_ACCESS_TOKEN: `wc -l .env.secrets` ≥ 13, `stat -c '%a' .env.secrets` = `600`, `.env.secrets.sha256` exists.
- Simulated missing required key (mock BWS output) → exit 2, missing key listed in stderr.

**Depends on:** item 1. **Blocks:** items 3, 4, 6.

---

### 3. Checksum verification block for `load-secrets.sh` and a new `--verify-hash` mode

Already partially covered in item 2 (`load-secrets.sh` writes `.sha256` after each run). This item formalizes the **verification entry point**:

- Add `--verify-hash` flag to `load-secrets.sh`: re-hashes existing `.env.secrets`, compares to `.env.secrets.sha256`, exits 0 on match / 4 on mismatch (no rewrite, no Pushover — pure check).
- **Mismatch path** delegates to item 4 (Pushover). For now, just establish the exit code contract.

**Deliverable:** `bash scripts/load-secrets.sh --verify-hash` returns 0 when in sync, 4 when drifted. **Verify:** Touch `.env.secrets` (modify a value), re-run with `--verify-hash` → exit 4 with diff message.

**Depends on:** item 2. **Blocks:** item 4.

---

### 4. Pushover alert on hash mismatch

Add a `notify_pushover_mismatch()` Bash function (in `scripts/lib/pushover-notify.sh`, sourced by both load-secrets and verify-secrets). Pure `curl`:

```bash
notify_pushover_mismatch() {
  local message="$1"
  local token="${PUSHOVER_APP_TOKEN:-}"
  local user="${PUSHOVER_USER_KEY:-}"
  local url="${PUSHOVER_API_URL:-https://api.pushover.net/1/messages.json}"
  if [[ -z "$token" || -z "$user" ]]; then
    echo "WARN: Pushover credentials missing — alert skipped" >&2
    return 0
  fi
  curl -sf -X POST "$url" \
    -d "token=$token" -d "user=$user" \
    -d "title=Open Brain: secrets drift" \
    -d "message=$message" \
    -d "priority=1"
}
```

Wire into `load-secrets.sh --verify-hash` mismatch path: call `notify_pushover_mismatch "Secrets file SHA256 differs from expected — run load-secrets.sh to reconcile"` before exit 4.

**Deliverable:** mismatch fires Pushover. **Verify:** Test fixture (item 6) overrides `PUSHOVER_API_URL` to a local sink (`http://127.0.0.1:9876` started via `python3 -m http.server` or `nc -l`); after triggering mismatch, sink receives POST with expected body fields.

**Depends on:** item 3. **Blocks:** item 6.

---

### 5. `scripts/verify-secrets.sh` — read-only audit

Standalone script (no side effects):

- Source `scripts/lib/secrets-map.sh`.
- Pull current `bws secret list --output json` → set of present BWS keys.
- Read existing `.env.secrets` → set of present ENV vars.
- Print a 3-column report (markdown table to stdout):

```
| ENV_VAR | BWS_NAME | In BWS? | In .env.secrets? | Status |
|---------|----------|---------|------------------|--------|
| POSTGRES_PASSWORD | open-brain-postgres-password | yes | yes | OK |
| GITEA_TOKEN | dev/open-brain/gitea-token | yes | NO | DRIFT — re-run load-secrets.sh |
| ...
```

- Exit codes: `0` if all required present in both, `1` if any required missing from either, `2` if BWS unreachable.
- Flag `--check-hash` chains to `load-secrets.sh --verify-hash` (delegates; doesn't reimplement).
- Flag `--quiet` suppresses the table and prints only summary line + exit code.

**Deliverable:** `bash scripts/verify-secrets.sh` produces the 3-column report. **Verify:**
- `bash scripts/verify-secrets.sh --quiet` exits 0 in healthy state.
- Remove a required line from `.env.secrets` → `verify-secrets.sh` exits 1 with that variable in DRIFT row.
- Mock `bws` returning empty → exit 2.

**Depends on:** items 1, 2. **Blocks:** item 6.

---

### 6. Test fixture — `scripts/test-secrets-roundtrip.sh`

Mirror `scripts/test-backup-secrets-redaction.sh` patterns (mktemp work dir, trap cleanup, fake fixtures, deterministic grep assertions). Coverage:

1. **Mock BWS:** create a `fake-bws` shell script in `WORK_DIR/bin/` that emits canned JSON for `secret list --output json`. Prepend to PATH or pass via `BWS_BIN` env override (add this override to `load-secrets.sh` for test injection).
2. **Mock Pushover:** start a one-shot listener (`nc -l -p 9876` in background, or python ad-hoc handler), set `PUSHOVER_API_URL=http://127.0.0.1:9876/messages.json`.
3. **Test cases:**
   - 6.1 Happy path: `load-secrets.sh --target-dir $WORK_DIR` writes 13 required keys + present optionals; `chmod` is `0600`; `.sha256` exists; `--verify-hash` exits 0.
   - 6.2 Drift detection: hand-edit `.env.secrets`, run `--verify-hash` → exit 4, Pushover sink received POST.
   - 6.3 Missing required: mock BWS omits `POSTGRES_PASSWORD`, run `load-secrets.sh` → exit 2, no `.env.secrets` written.
   - 6.4 Refuse clobber: `load-secrets.sh` against existing file → exit 3; with `--force` → exit 0.
   - 6.5 `verify-secrets.sh` table: drop a key, confirm DRIFT row appears.
4. Each case prints `PASS` / `FAIL` and increments counters; final summary line. Exit 0 only if all 5 pass.

**Deliverable:** `bash scripts/test-secrets-roundtrip.sh` exits 0. **Verify:** Run the script; expect `=== test-secrets-roundtrip: PASSED (5/5) ===`.

**Depends on:** items 2, 3, 4, 5. **Blocks:** nothing.

---

### 7. Documentation — CLAUDE.md operational rules

Update project `CLAUDE.md` under the existing **"Backup / disaster recovery"** subsection (already exists from P04b, lines containing the `scripts/backup.sh` redaction rule). Add:

- **Round-trip invariant.** `scripts/backup.sh` strips `.env.secrets` (P04b); `scripts/load-secrets.sh` rebuilds it from BWS (P08); `scripts/verify-secrets.sh` audits drift between BWS and the on-disk file. Hash mismatch fires Pushover.
- **Mapping table is authoritative.** `scripts/lib/secrets-map.sh` is the single source of truth for BWS-name → ENV-var mapping. Adding a new secret is a **3-step lockstep**: (1) add to BWS, (2) add to `deploy/.env.secrets.template`, (3) add to `scripts/lib/secrets-map.sh`. Skipping step 3 means `load-secrets.sh` silently misses it on the next reconciliation.
- **Operator runbook.** After homeserver rebuild: `export BWS_ACCESS_TOKEN=...; bash scripts/load-secrets.sh --target-dir /mnt/user/appdata/open-brain` writes a fresh `.env.secrets`. Verify with `bash scripts/verify-secrets.sh`.
- **CI hook (future).** Document but do not implement: a future GitHub Action could `verify-secrets.sh --schema-only` to ensure the template + mapping table stay in sync without ever pulling actual secret values.

**Deliverable:** CLAUDE.md updated; new rule passes a `grep -n 'load-secrets.sh' CLAUDE.md` returning at least 2 matches (the existing P04b reference + the new round-trip invariant).

**Depends on:** items 2, 5. **Blocks:** Gate 5 doc-sweep.

---

## Acceptance criteria (from PHASED_PLAN.md, with concrete commands)

- [ ] `bash scripts/load-secrets.sh --dry-run` lists every variable from `deploy/.env.secrets.template` (13 required mandatory; optionals listed with PRESENT/MISSING).
- [ ] `bash scripts/load-secrets.sh` writes `.env.secrets` (mode 0600) + `.env.secrets.sha256`; refuses to clobber without `--force`.
- [ ] Checksum verification: `bash scripts/load-secrets.sh --verify-hash` exits 4 (non-zero) on mismatch, 0 on match.
- [ ] Pushover alert fires on mismatch (verified via fixture in `scripts/test-secrets-roundtrip.sh` against a local sink).
- [ ] `bash scripts/verify-secrets.sh` reports 3-column drift table; exit 1 if any required missing from BWS or `.env.secrets`.
- [ ] `bash scripts/test-secrets-roundtrip.sh` exits 0 — all 5 cases pass.
- [ ] CLAUDE.md "Backup / disaster recovery" subsection updated with: round-trip invariant + 3-step lockstep rule for adding a new secret.

---

## Rollback plan

Per PHASED_PLAN.md: *"Revert script; manual copy-paste pattern resumes."* Concrete:

1. **Repo revert:** `git revert <merge-sha>` on the P08 PR. `scripts/load-secrets.sh` returns to the 33-line stub; `scripts/verify-secrets.sh` and `scripts/lib/secrets-map.sh` and `scripts/test-secrets-roundtrip.sh` disappear; CLAUDE.md round-trip rule removed.
2. **Homeserver impact:** zero unless the operator already ran `load-secrets.sh` to write `.env.secrets`. The written file remains valid (it's just key=value pairs); only the auto-reconciliation tooling is gone. The `.env.secrets.sha256` file becomes orphaned — harmless, can be deleted.
3. **Operator fallback:** revert to manual Bitwarden Web UI copy-paste against `deploy/.env.secrets.template`. Same workflow used today (Entry 091 PLAT-F1).

No data loss risk — this phase touches no DB, no config consumed by running services, no Docker image. Pure ops tooling that augments an existing manual workflow.

---

## Out of scope

- **BWS bootstrap on homeserver.** Operator must already have `BWS_ACCESS_TOKEN` exported in environment or `~/.bashrc` before running `load-secrets.sh`. The script validates and fails fast on missing token; it does not auto-install BWS or create access tokens.
- **`jq` install.** If `jq` is missing on Unraid, the script fails with a clear message pointing to `nerdpack` / `apt install jq`. Auto-install is out of scope.
- **Per-environment splits (dev vs prod).** Single `.env.secrets` model preserved. Multi-env support is a separate future enhancement.
- **Migration of existing secrets into BWS.** Already done in prior work (Entry 077 era + ongoing); P08 consumes what's already there.
- **CI/GitHub Actions integration of `verify-secrets.sh`.** Documented in CLAUDE.md as a future hook, not implemented now (would require BWS access from GH runners — separate trust decision).
- **Rotation tooling.** P08 reads BWS state and reconciles; it does not rotate or generate new secret values.
- **Backup of the `.env.secrets.sha256` file itself.** Not added to backup.sh (intentional — hash is regenerable from BWS via `load-secrets.sh --rehash-only`).

---

## Files touched (for review focus)

**New files:**
- `scripts/lib/secrets-map.sh` (mapping table — single source of truth)
- `scripts/lib/pushover-notify.sh` (Pushover curl wrapper, sourced by both consumers)
- `scripts/verify-secrets.sh` (read-only 3-column audit)
- `scripts/test-secrets-roundtrip.sh` (5-case fixture)

**Modified files:**
- `scripts/load-secrets.sh` (stub → full implementation; ~33 → ~150 lines estimated)
- `CLAUDE.md` (round-trip invariant + 3-step lockstep rule under "Backup / disaster recovery")

**Untouched (verify they remain unchanged):**
- `scripts/backup.sh` (P04b's redaction guard stays as-is — counterpart, not callee)
- `scripts/test-backup-secrets-redaction.sh` (template only, not a dependency)
- `deploy/.env.secrets.template` (already canonical; P08 reads it implicitly via the mapping table)

---

## CLAUDE.md updates required (for Gate 5 doc-sweep)

- [ ] **"Backup / disaster recovery" subsection — add round-trip paragraph:** `backup.sh` strips → `load-secrets.sh` restores → `verify-secrets.sh` audits. Mismatch → Pushover.
- [ ] **New operational rule (3-step lockstep for adding secrets):** any new secret in BWS must be added in the same commit to (1) `deploy/.env.secrets.template`, (2) `scripts/lib/secrets-map.sh`, otherwise `load-secrets.sh` silently misses it. Mention by name so future `grep` finds it.
- [ ] **Operator runbook bullet:** after homeserver rebuild, `bash scripts/load-secrets.sh --target-dir /mnt/user/appdata/open-brain` is the single command to rebuild `.env.secrets`.
- [ ] Update MEMORY.md count: 25 operational rules → 28 (3 added: round-trip, 3-step lockstep, runbook).
- [ ] Mark Entry 091 PLAT-F1 as RESOLVED with link to P08 entry.

---

## Notes for Gate 3 implementer

- **Sourcing pattern:** keep `scripts/lib/*.sh` files free of `set -euo pipefail` (let the consumer set strictness). Define functions and `declare -A` arrays only.
- **Atomic write:** `.env.secrets.tmp` → `mv` is POSIX-atomic on the same filesystem. If the operator ever sets `--target-dir` to a different mount than `/tmp`, document the requirement (or use `mktemp -p $target_dir`).
- **Avoid leaking secrets in logs:** never `echo` a value, only the BWS-name or ENV-var. Test 6.1 should grep the test output for any of the fake-secret values and fail if found (mirror the P04b pattern).
- **`bws secret list` may include unrelated projects.** If `BWS_ACCESS_TOKEN` is scoped to a project that contains both Open Brain and OpenClaw secrets, the JSON will include both — which is fine, the mapping table filters by name. Document this in load-secrets.sh header comment.
- **Per CLAUDE.md Rule 11:** LAB_NOTEBOOK pre-action entry must precede the first commit of Gate 3. One entry covers all 7 work items.
