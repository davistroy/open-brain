# IMPLEMENT_PHASE-P01.md — Infra Hardening Kit

**Phase:** P01 (Wave 1)
**Bundles:** #103 (Critical) + #105 (High) + #110 (High)
**Severity:** 2 Critical + 1 High
**Estimated effort:** ~1 day
**Dependencies:** None
**Branch name:** `feat/phase-P01-infra-hardening-kit`
**Drift audit date:** 2026-04-18
**Authored by:** Gate 1 phase-planner subagent (Sonnet 4.6)

---

## Scope Drift

Three divergences from the P01 card were found. **None invalidate acceptance criteria — proceeding.**

**Drift 1 — CaptureSource already 9 values in web/types.ts (partial fix already landed)**

The P01 card assumes `CaptureSource` in the web package has drifted to 6 values and needs to be updated to 9. Reality: `packages/web/src/lib/types.ts` line 9 already declares all 9 values (`'api' | 'slack' | 'voice' | 'document' | 'mcp' | 'email' | 'file' | 'consolidation' | 'system'`). The drift is only in `packages/web/src/components/SearchFilters.tsx` line 10, which hardcodes a 6-value `CAPTURE_SOURCES` array `['slack', 'voice', 'api', 'document', 'mcp', 'email']` rather than using the type.

Adjustment: Work item 3.2 (array fix) is still needed. No change to other work items.

**Drift 2 — web-type-drift.test.ts reads from api.ts, not types.ts; CaptureSource is in types.ts**

The existing drift-guard at `packages/shared/src/__tests__/web-type-drift.test.ts` extracts union literals by scanning `packages/web/src/lib/api.ts` for `export type Name = ...` blocks. `CaptureSource` is declared in `packages/web/src/lib/types.ts`, not `api.ts`. The new CaptureSource drift-guard must reference `types.ts` directly.

Adjustment: Work item 3.1 must target `packages/web/src/lib/types.ts` as the source file and also parse the `CAPTURE_SOURCES` array from `SearchFilters.tsx`. Shared canonical is a raw TS union (not a Zod enum) — the test hardcodes the 9-value expected set or imports from `packages/core-api/src/schemas/capture.ts` `CAPTURE_SOURCES` (Zod enum).

**Drift 3 — init-schema.sql is missing migrations 0018-0022 (3 tables + 1 ENUM + 1 CHECK)**

The current `scripts/init-schema.sql` is missing:
- `email_classifications`, `email_corrections`, `email_daily_summaries` tables (migration 0020)
- `file_upload_status` ENUM + `file_uploads` table (migration 0021)
- `captures_source_check` CHECK constraint (migration 0022)

Tables `mcp_activity` (0018) and `email_drafts` (0019) are present but with older comment labels (`0014b` / `0015b`) rather than their actual numbered migrations.

Adjustment: regeneration scope is slightly larger than the card implied — but still within ~1 day.

---

## Current-state baseline

**docker-compose.yml services (13 active):**

| Service | Container name | Current mem_limit | Node service? |
|---------|----------------|-------------------|---------------|
| postgres | open-brain-postgres | NONE | No |
| redis | open-brain-redis | NONE | No |
| core-api | open-brain-core-api | NONE | Yes (Node 22) |
| workers | open-brain-workers | NONE | Yes (Node 22) |
| slack-bot | open-brain-slack-bot | NONE | Yes (Node 22) |
| voice-pipecat | open-brain-voice-pipecat | 4g (EXISTING) | No (Python) |
| file-ingestion | open-brain-file-ingestion | 1536m (EXISTING) | No (Python) |
| faster-whisper | open-brain-faster-whisper | 8g (EXISTING) | No (Python) |
| voice-capture | open-brain-voice-capture | NONE | Yes (Node 22) |
| web | open-brain-web | NONE | No (nginx static) |
| cloudflared | open-brain-cloudflared | NONE | No (Go binary) |
| financial-ingest | open-brain-financial-ingest | NONE | No (Python) |
| utility-ingest | open-brain-utility-ingest | NONE | No (Python) |

10 services need `mem_limit` added. 3 already have it.

**Drizzle migration count:** 22 files in `packages/shared/drizzle/`, numbered 0000–0022. Last: `0022_captures_source_check.sql`.

**init-schema.sql last git-touch:** commit `a6f1f4e` (Phase 1: Pre-deploy code fixes). Missing migrations 0020, 0021, 0022.

**Current SearchFilters.tsx CAPTURE_SOURCES array (line 10):** `['slack', 'voice', 'api', 'document', 'mcp', 'email']` — 6 values.

**web-type-drift.test.ts current coverage:** `FileUploadStatus` + `IngestSourceType` (both read from `packages/web/src/lib/api.ts`). Does NOT cover `CaptureSource`.

**CaptureSource canonical locations:**

- TS union (source of truth): `packages/shared/src/types/capture.ts` line 11 — 9 values
- Zod enum: `packages/core-api/src/schemas/capture.ts` line 4 — 9 values
- Web type: `packages/web/src/lib/types.ts` line 9 — 9 values (already correct)
- Web component array: `packages/web/src/components/SearchFilters.tsx` line 10 — 6 values (NEEDS UPDATE)

---

## Work items

### 1. Docker compose mem_limits (#103)

Add `mem_limit` to the 10 services that lack it. Keep existing limits on voice-pipecat (4g — Pipecat audio), file-ingestion (1536m), faster-whisper (8g — per CLAUDE.md Target Hardware). For Node services, also add `NODE_OPTIONS=--max-old-space-size=1200` to the `environment:` block.

- **1.1 postgres** — add `mem_limit: 8g` (CLAUDE.md Target Hardware mandates 8GB for Postgres)
- **1.2 redis** — add `mem_limit: 512m` (key-value store, 512m is generous)
- **1.3 core-api** — add `mem_limit: 1500m` + `NODE_OPTIONS: "--max-old-space-size=1200"` in environment
- **1.4 workers** — add `mem_limit: 1500m` + `NODE_OPTIONS: "--max-old-space-size=1200"` in environment
- **1.5 slack-bot** — add `mem_limit: 1500m` + `NODE_OPTIONS: "--max-old-space-size=1200"` in environment
- **1.6 voice-capture** — add `mem_limit: 1500m` + `NODE_OPTIONS: "--max-old-space-size=1200"` in environment
- **1.7 web** — add `mem_limit: 256m` (nginx static; no Node)
- **1.8 cloudflared** — add `mem_limit: 256m` (Go binary)
- **1.9 financial-ingest** — add `mem_limit: 1500m` (Python sidecar)
- **1.10 utility-ingest** — add `mem_limit: 1500m` (Python sidecar)

Verification: `docker compose config` must exit 0 after all changes.

### 2. init-schema.sql regeneration (#105)

**2.1 Regeneration strategy**

Edit `scripts/init-schema.sql` to add missing content as idempotent `CREATE TABLE IF NOT EXISTS` / `DO $$ BEGIN IF NOT EXISTS ... END$$;` blocks. Retain all existing content; append/insert the missing blocks in migration order:

- After the current `voice_sessions` block: add `email_classifications`, `email_corrections`, `email_daily_summaries` tables from `packages/shared/drizzle/0020_email_classifications.sql`
- After that: add `file_upload_status` ENUM (guarded `DO $$ BEGIN IF NOT EXISTS ... END$$;`) + `file_uploads` table from `packages/shared/drizzle/0021_file_uploads.sql`
- Before the final `SELECT 'Schema initialization complete'` line: add the `captures_source_check` CHECK constraint from `packages/shared/drizzle/0022_captures_source_check.sql` (use `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`)

**2.2 scripts/validate-init-schema.sh**

Create the script, `chmod +x`, with logic:

1. `docker run -d --name ob-schema-validate -e POSTGRES_DB=validate -e POSTGRES_USER=validate -e POSTGRES_PASSWORD=validate -p 5499:5432 pgvector/pgvector:pg16`
2. Wait until `docker exec ob-schema-validate pg_isready -U validate` succeeds
3. Apply `scripts/init-schema.sql`
4. Apply every file in `packages/shared/drizzle/0*.sql` in sorted order (idempotent via `IF NOT EXISTS` guards)
5. Verify all expected tables exist (captures, pipeline_events, ai_audit_log, entities, entity_links, entity_relationships, sessions, session_messages, bets, skills_log, triggers, capture_associations, activity_feed, app_settings, mcp_activity, backup_log, email_drafts, container_health, voice_sessions, file_uploads, email_classifications, email_corrections, email_daily_summaries)
6. Verify `captures_source_check` CHECK constraint exists
7. `docker rm -f ob-schema-validate`

Exit 1 on any missing table/constraint. Print "validate-init-schema: PASSED" on success.

**2.3 CI wiring**

Add `validate-schema` job to `.github/workflows/ci.yml`:

- Trigger on PRs touching `scripts/init-schema.sql`, `packages/shared/drizzle/**`, or `packages/shared/src/schema/**`
- Detect via `git diff --name-only origin/main...HEAD` pattern match in the job
- Run `bash scripts/validate-init-schema.sh`

### 3. Drift-guard for CaptureSource (#110)

**3.1 Extend web-type-drift.test.ts**

Add two new test cases to `packages/shared/src/__tests__/web-type-drift.test.ts`:

- Define new path constants: `WEB_TYPES_PATH = resolve(__dirname, '../../../web/src/lib/types.ts')` and `SEARCH_FILTERS_PATH = resolve(__dirname, '../../../web/src/components/SearchFilters.tsx')`
- Add a helper `extractArrayLiterals(source, constName)` that parses `const NAME[: Type[]]* = ['a', 'b', ...]` declarations and returns the string literal set
- Test case 1: `'CaptureSource web literal set (types.ts) matches canonical 9-value list'` — read types.ts, extract `CaptureSource` union via existing `extractUnionLiterals()`, assert equality with hardcoded canonical array `['slack', 'voice', 'api', 'document', 'mcp', 'email', 'file', 'consolidation', 'system']`
- Test case 2: `'SearchFilters CAPTURE_SOURCES array matches web CaptureSource type'` — read SearchFilters.tsx, extract `CAPTURE_SOURCES` array literal, assert set equality with the union parsed from types.ts

Both tests fail if a new source value is added without updating all three surfaces.

**3.2 Update SearchFilters.tsx**

Change `packages/web/src/components/SearchFilters.tsx` line 10 from:

```ts
const CAPTURE_SOURCES: CaptureSource[] = ['slack', 'voice', 'api', 'document', 'mcp', 'email'];
```

To:

```ts
const CAPTURE_SOURCES: CaptureSource[] = [
  'slack', 'voice', 'api', 'document', 'mcp', 'email', 'file', 'consolidation', 'system',
];
```

No import changes needed — `CaptureSource` is already imported from `@/lib/types` on line 4.

**3.3 Visual smoke test (optional)**

Run `pnpm --filter @open-brain/web dev`, navigate to Search page, verify Source filter dropdown renders all 9 options without layout break.

---

## Acceptance criteria

- [ ] Every docker-compose service has `mem_limit:` set (13 services total; 10 new + 3 preserved)
- [ ] Node services (core-api, workers, slack-bot, voice-capture) have `NODE_OPTIONS=--max-old-space-size=1200` in environment
- [ ] `docker compose config` validates with exit code 0
- [ ] `scripts/init-schema.sql` contains all 22 migrations' DDL (including email_classifications, email_corrections, email_daily_summaries, file_upload_status ENUM, file_uploads, and captures_source_check constraint)
- [ ] Applying `scripts/init-schema.sql` + all 22 migrations to a fresh pgvector/pgvector:pg16 instance succeeds
- [ ] `scripts/validate-init-schema.sh` exists, is executable, exits 0 locally
- [ ] A `validate-schema` job exists in `.github/workflows/ci.yml`
- [ ] `packages/shared/src/__tests__/web-type-drift.test.ts` has two new test cases covering CaptureSource
- [ ] `packages/web/src/components/SearchFilters.tsx` `CAPTURE_SOURCES` has 9 values
- [ ] `pnpm --filter @open-brain/shared test -- web-type-drift` exits green
- [ ] LAB_NOTEBOOK entry 092 exists with Hypothesis + Rollback + Results sections
- [ ] CLAUDE.md updated if any operational rule emerges
- [ ] PR body closes #103, #105, #110

---

## Rollback plan

- `git revert <squash-sha>` on main; no data-touching changes in this PR.
- Migration 0022 (captures_source_check, applied to homeserver 2026-04-18) is NOT touched — only added to init-schema.sql for fresh DB initialization.
- Docker mem_limit revert: restoring prior docker-compose.yml returns containers to unlimited memory.
- init-schema.sql revert: restores prior content; running homeserver unaffected (init-schema is for fresh installs only).
- validate-init-schema.sh revert: remove the script; CI job becomes no-op.

---

## Test plan

- **Unit:** `pnpm --filter @open-brain/shared test -- web-type-drift` — green
- **Integration:** `bash scripts/validate-init-schema.sh` locally — exits 0 with "validate-init-schema: PASSED"
- **Compose smoke:** `docker compose config` exits 0
- **Full suite:** `pnpm -r test` — no regressions
- **Visual (optional):** Search dropdown shows 9 options

---

## Homeserver deploy notes (Gate 5.5)

P01 triggers Gate 5.5 because it touches `docker-compose.yml`. No DB migration applied to production (init-schema.sql is for fresh DB init only).

Homeserver steps (operator runs):

```bash
cd /mnt/user/appdata/open-brain
git pull origin main
docker compose up -d          # rolling restart with new mem_limits
docker stats --no-stream      # verify limits applied
```

No `psql` commands required.

---

## Operational rules candidates (for Gate 3 implementer to confirm)

- Placeholder; implementer appends discovered rules during execution.
- Likely candidate: "Docker compose `mem_limit` uses unit suffix `g` (gigabytes) or `m` (megabytes) with no space between number and unit."
