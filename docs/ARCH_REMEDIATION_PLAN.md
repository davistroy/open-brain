# Implementation Plan — Architecture Review Remediation

Generated from /review-arch findings. Addresses confirmed bugs, performance issues, and code quality defects.

---

## Phase 1: Critical Fixes

### Phase Completion Checklist
- [ ] core-api starts and all route groups register
- [ ] Zod version unified across all packages
- [ ] CI workflow added
- [ ] All existing tests pass

### Testing Requirements
- pnpm -r test passes
- pnpm -r lint passes

---

#### 1.1 Wire all services in core-api index.ts — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Read packages/core-api/src/index.ts and packages/core-api/src/app.ts fully
- Read all service files in packages/core-api/src/services/ to understand constructor signatures: embedding.ts, search.ts, trigger.ts, entity.ts, bet.ts, session.ts, pipeline.ts
- Instantiate EmbeddingService using litellmUrl, litellmApiKey, configService, db
- Instantiate SearchService using db and embeddingService
- Instantiate TriggerService using db and embeddingService
- Instantiate EntityService using db
- Instantiate BetService using db and captureService
- Instantiate SessionService using db
- Instantiate PipelineService using db and Redis connection options
- Create skillQueue as BullMQ Queue for the skill-execution queue
- Create documentPipelineQueue as BullMQ Queue for the document-pipeline queue
- Recreate CaptureService passing pipelineService so auto-enqueue works
- Pass all services into createApp() call
- Verify compilation: pnpm --filter @open-brain/core-api lint

---

#### 1.2 Align Zod to v3 across all packages — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Read packages/shared/package.json
- Change zod in packages/shared/package.json from ^4.3.6 to ^3.23.0
- Search packages/shared/src/ for zod v4-only APIs that would break under v3 (brand, new pipe semantics, ZodError.format v4 shape)
- Run pnpm install at repo root to regenerate lock file
- Run pnpm -r build and pnpm -r lint to verify no breakage

---

#### 1.3 Fix N+1 in SearchService — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Read packages/core-api/src/services/search.ts fully
- Find the SQL migration defining actr_temporal_score in packages/shared/drizzle/ to get the exact decay formula
- Remove the per-row DB loop that calls actr_temporal_score via a separate SQL query for each result row
- Implement equivalent JS decay function using capture.created_at already in the capture map (zero extra DB calls)
- Match the decay formula from the SQL function exactly
- Update packages/core-api/src/__tests__/search-service.test.ts to cover temporal decay path
- Run pnpm --filter @open-brain/core-api test

---

#### 1.4 Add GitHub Actions CI workflow — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Create .github/workflows/ directory and .github/workflows/ci.yml
- Triggers: push to any branch, pull_request targeting main
- Job on ubuntu-latest: Node 20, pnpm 9.15.0 via pnpm/action-setup@v4
- Steps: checkout, node setup, pnpm setup, pnpm store cache keyed on hash of pnpm-lock.yaml, pnpm install --frozen-lockfile, build shared package first then remaining packages, pnpm -r lint, pnpm -r test
- No secrets or tokens in the file

---

#### 1.5 Extract vector custom type to shared schema types file — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Read packages/shared/src/schema/core.ts and packages/shared/src/schema/supporting.ts
- Create packages/shared/src/schema/types.ts with only the vector custom type definition (single source of truth)
- In core.ts: remove the vector definition and import from ./types.js
- In supporting.ts: remove the vector definition and import from ./types.js
- Run pnpm --filter @open-brain/shared build to verify

---

#### 1.6 Fix wildcard CORS and document temp file cleanup — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Read packages/core-api/src/app.ts
- Change cors origin from wildcard star to an explicit array: https://brain.k4jda.net, http://localhost:5173, http://localhost:3000
- Read packages/core-api/src/routes/documents.ts
- Add a finally block after the pipeline enqueue to delete the temp file using unlink from node:fs/promises, wrapped in .catch to swallow errors so upload never fails on cleanup
- Run pnpm --filter @open-brain/core-api test

---

## Phase 2: Code Quality

### Phase Completion Checklist
- [ ] SessionService accepts governanceEngine as typed constructor param
- [ ] as-any mutation removed from app.ts
- [ ] command.ts split into per-group files under handlers/commands/
- [ ] All tests pass

### Testing Requirements
- pnpm -r test passes
- Session and governance tests pass with new constructor signature

---

#### 2.1 Type SessionService constructor and remove as-any wiring — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Read packages/core-api/src/services/session.ts in full
- Read packages/core-api/src/services/governance-engine.ts for the GovernanceEngine type
- Add optional governanceEngine parameter to SessionService constructor (typed as GovernanceEngine or undefined)
- Store as private governanceEngine property on the class
- Update all internal usages in session.ts to reference this.governanceEngine
- In packages/core-api/src/app.ts: remove the (sessionService as any).governanceEngine = governanceEngine post-construction mutation block
- In packages/core-api/src/index.ts (updated in 1.1): pass governanceEngine as a constructor argument when creating SessionService
- Run pnpm --filter @open-brain/core-api test

---

#### 2.2 Split slack-bot command.ts into per-command-group files — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Read packages/slack-bot/src/handlers/command.ts in full (836 lines)
- Create packages/slack-bot/src/handlers/commands/ directory
- Create one file per command group: capture.ts, search.ts, brief.ts, board.ts, bet.ts, trigger.ts, entity.ts, metadata.ts (capture-type and brain-view), pipeline.ts, skill.ts, help.ts
- Create index.ts that exports a unified dispatch map and re-exports all command handlers
- Move handler logic from command.ts into the appropriate file, keeping all imports and types intact
- Update packages/slack-bot/src/handlers/command.ts to import from ./commands/index.js and delegate (target under 60 lines)
- Run pnpm --filter @open-brain/slack-bot test

---

## Phase 3: Performance - Entity Resolution

### Phase Completion Checklist
- [ ] Entity resolution uses targeted DB lookup per mention (no full table scan)
- [ ] Migration file for entity name index added to drizzle/

### Testing Requirements
- pnpm --filter @open-brain/workers test passes
- extract-entities tests pass with updated mock pattern

---

#### 3.1 Optimize entity resolution with indexed DB lookups — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Read packages/workers/src/jobs/extract-entities.ts in full, especially the resolveOrCreateEntity function
- Replace the SELECT all entities WHERE entity_type then JS filter pattern with targeted queries: Tier 1 exact case-insensitive name match using lower() on both sides LIMIT 1; Tier 2 alias match using unnest on the aliases array column LIMIT 1; Tier 3 INSERT new entity unchanged
- Create packages/shared/drizzle/0004_entity_name_lower_idx.sql with CREATE INDEX IF NOT EXISTS for (entity_type, lower(name)) and (entity_type, lower(canonical_name))
- Update packages/workers/src/__tests__/extract-entities.test.ts to mock the new targeted query pattern instead of returning a full candidates array
- Run pnpm --filter @open-brain/workers test

---

## Phase 4: Data Model - Proper Soft Delete

### Phase Completion Checklist
- [ ] deleted_at column added to captures table
- [ ] Migration file created
- [ ] All capture queries filter on deleted_at IS NULL
- [ ] Soft-delete uses deleted_at, not pipeline_status

### Testing Requirements
- pnpm -r test passes
- Capture service tests cover: softDelete sets deleted_at, list excludes deleted, getById throws NotFoundError for deleted

---

#### 4.1 Add deleted_at column and replace pipeline_status soft delete — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Read packages/shared/src/schema/core.ts captures table definition
- Add deleted_at as a nullable timestamptz column to the captures table
- Add an index on deleted_at in the table index config using a partial index WHERE deleted_at IS NULL
- Create packages/shared/drizzle/0005_captures_deleted_at.sql with: ALTER TABLE captures ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ; CREATE INDEX IF NOT EXISTS captures_deleted_at_idx ON captures (deleted_at) WHERE deleted_at IS NULL; UPDATE captures SET deleted_at = updated_at WHERE pipeline_status = 'deleted';
- Read packages/core-api/src/services/capture.ts in full
- Update softDelete to set deleted_at = new Date() instead of pipeline_status = 'deleted'
- Update list() to add isNull(captures.deleted_at) to all WHERE conditions (import isNull from drizzle-orm)
- Update getById() to add isNull(captures.deleted_at) condition so deleted captures appear not found
- Update getStats() to use isNull(captures.deleted_at) filter instead of the raw pipeline_status != 'deleted' SQL fragment; keep pipelineHealth counts meaningful for non-deleted captures
- Read packages/shared/src/types/capture.ts and add optional deleted_at field to CaptureRecord type
- Update packages/core-api/src/__tests__/capture-service.test.ts: assert softDelete sets deleted_at, assert list excludes deleted captures, assert getById throws NotFoundError for deleted captures
- Run pnpm -r test

---

## Phase 5: Web Package Testing

### Phase Completion Checklist
- [ ] packages/web has vitest + testing-library configured
- [ ] Tests exist for lib/api.ts, lib/sse.ts, lib/utils.ts
- [ ] At least one page component smoke-render test
- [ ] pnpm test in web package passes

### Testing Requirements
- pnpm --filter @open-brain/web test passes
- No existing tests broken

---

#### 5.1 Add web package test infrastructure and initial tests — COMPLETE 2026-03-06

**Status:** COMPLETE 2026-03-06

**Tasks:**
- Read packages/web/package.json, packages/web/vite.config.ts
- Read packages/web/src/lib/api.ts, packages/web/src/lib/sse.ts, packages/web/src/lib/utils.ts, packages/web/src/lib/types.ts
- Read the main Dashboard page component to understand its props and data dependencies
- Add to packages/web/package.json devDependencies: vitest at ^1.6.0, @vitest/coverage-v8 at ^1.6.0, @testing-library/react at ^16.0.0, @testing-library/jest-dom at ^6.0.0, jsdom at ^24.0.0
- Add test script to packages/web/package.json: vitest run --passWithNoTests
- Create packages/web/vitest.config.ts with jsdom environment, globals true, setupFiles pointing to ./src/test/setup.ts, and the react vite plugin
- Create packages/web/src/test/setup.ts that imports @testing-library/jest-dom
- Create packages/web/src/lib/__tests__/api.test.ts: test the API fetch wrapper functions using vi.stubGlobal for global fetch
- Create packages/web/src/lib/__tests__/utils.test.ts: test all exported utility functions with typical and edge-case inputs
- Create packages/web/src/lib/__tests__/sse.test.ts: test the useSSE hook by mocking EventSource with a class that implements addEventListener/removeEventListener/close
- Create packages/web/src/pages/__tests__/Dashboard.test.tsx: vi.mock the lib/api module, render Dashboard using @testing-library/react render, assert key UI elements are present in the DOM
- Run pnpm install at root, then pnpm --filter @open-brain/web test
