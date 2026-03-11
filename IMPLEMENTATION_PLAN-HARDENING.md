# Implementation Plan — Open Brain Hardening

**Generated:** 2026-03-10
**Based On:** Consolidated Intent Review + Architecture Audit (2026-03-10)
**Total Phases:** 7
**Estimated Total Effort:** ~2,800 LOC across ~45 files

---

## Executive Summary

This plan addresses all findings from the combined Intent Review (14 discrepancies) and Architecture Audit (21 findings) performed on 2026-03-10. The original 16-phase build (IMPLEMENTATION_PLAN.md + IMPLEMENTATION_PLAN-PHASE2.md) shipped all core features; this hardening plan closes the gaps.

The work falls into three tiers: **critical fixes** (schema columns that will crash a worker at runtime, unprotected admin endpoints, Dockerfile build suppression), **code quality improvements** (duplicate services, god modules, raw SQL type safety), and **infrastructure maturation** (integration tests, rate limiting, documentation alignment). No new features are added — this is purely about making the existing system more robust, maintainable, and accurately documented.

Phases 1-2 are quick, high-impact fixes that should deploy immediately. Phases 3-5 are independent refactoring streams that can run in parallel. Phase 6 adds integration testing to catch the class of bugs that unit tests miss. Phase 7 brings documentation into alignment with the as-built system.

---

## Plan Overview

The plan is ordered by risk reduction: critical runtime failures and security gaps first, then code quality, then testing, then documentation. Phases 3, 4, and 5 are independent of each other and can be executed in parallel after Phase 2 completes. Phase 6 (integration tests) should follow the refactoring phases so it validates the cleaned-up code. Phase 7 (documentation) is independent and can run anytime.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies |
|-------|------------|------------------|-----------------|--------------|
| 1 | Critical Schema & Security Fixes | Schema migration, Dockerfile fix, admin auth, skills cleanup | M (~8 files, ~400 LOC) | None |
| 2 | Code Hygiene Quick Wins | Deduplicate embedding service, fix logging, clean deps, shutdown | M (~10 files, ~200 LOC) | Phase 1 |
| 3 | DRY Refactoring | Shared prompt utility, decompose WeeklyBriefSkill | M (~8 files, ~500 LOC) | Phase 2 |
| 4 | Type Safety — Raw SQL Migration | Typed Drizzle queries for 30+ raw SQL sites | L (~8 files, ~500 LOC) | Phase 2 |
| 5 | Performance & Resilience | SQL-level search filters, rate limiting, notifications config | M (~6 files, ~400 LOC) | Phase 2 |
| 6 | Integration Test Suite | Test infrastructure, API tests, pipeline smoke tests | L (~8 files, ~500 LOC) | Phases 3-5 |
| 7 | Documentation Alignment | TDD updates, README roadmap, feature documentation | M (~5 files, ~300 LOC) | None (independent) |

<!-- BEGIN PHASES -->

---

## Phase 1: Critical Schema & Security Fixes

**Estimated Complexity:** M (~8 files, ~400 LOC)
**Dependencies:** None (first phase)
**Parallelizable:** Yes — all 4 work items are independent

### Goals

- Prevent the `update-access-stats` worker from crashing at runtime by adding missing schema columns
- Stop advertising skills that have no backing implementation
- Ensure Docker builds fail visibly on compilation errors instead of shipping broken containers
- Protect destructive admin endpoints with authentication

### Work Items

#### 1.1 Add `access_count` and `last_accessed_at` Columns to Captures Schema — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** C1 (Intent Review — Schema Divergence, CRITICAL)
**Files Affected:**
- `packages/shared/src/schema/core.ts` (modify)
- `packages/shared/drizzle/0008_access_stats_columns.sql` (create)
- `scripts/init-schema.sql` (modify)
- `packages/workers/src/jobs/update-access-stats.ts` (modify — verify alignment)

**Description:**
The TDD specifies `access_count` (integer, default 0) and `last_accessed_at` (timestamptz) columns on the captures table for ACT-R temporal decay scoring. These columns are missing from both the Drizzle schema and init-schema.sql. The `update-access-stats` worker at `packages/workers/src/jobs/update-access-stats.ts` issues raw SQL UPDATEs against these columns and will throw a PostgreSQL error at runtime. Add the columns so the worker functions correctly. The SearchService's time-decay-only approach is acceptable for now — these columns enable future enhancement.

**Tasks:**
1. [ ] Add `access_count: integer('access_count').notNull().default(0)` to the captures table in `packages/shared/src/schema/core.ts` (after line 27)
2. [ ] Add `last_accessed_at: timestamp('last_accessed_at', { withTimezone: true })` to the captures table (nullable, after access_count)
3. [ ] Create migration `packages/shared/drizzle/0008_access_stats_columns.sql` with `ALTER TABLE captures ADD COLUMN IF NOT EXISTS access_count INTEGER NOT NULL DEFAULT 0; ALTER TABLE captures ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;`
4. [ ] Update `scripts/init-schema.sql` to include both columns in the CREATE TABLE statement (after line 24)
5. [ ] Verify `update-access-stats` worker's raw SQL UPDATE references align with the new column names
6. [ ] Rebuild shared package (`pnpm --filter @open-brain/shared build`)

**Acceptance Criteria:**
- [ ] `pnpm --filter @open-brain/shared build` succeeds with new columns in schema
- [ ] Migration SQL runs without error against existing database
- [ ] `update-access-stats` worker type-checks successfully
- [ ] All existing tests pass

**Notes:**
The SearchService (`packages/core-api/src/services/search.ts`) uses `created_at`-based time decay which is fine. These columns lay the groundwork for frequency-weighted ACT-R scoring in a future phase.

---

#### 1.2 Remove Unimplemented Skills from KNOWN_SKILLS — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** C2 (Intent Review — Partial Implementation, CRITICAL)
**Files Affected:**
- `packages/core-api/src/routes/skills.ts` (modify — lines 37-44)

**Description:**
`KNOWN_SKILLS` at `packages/core-api/src/routes/skills.ts:32-49` advertises `drift-monitor` and `daily-connections` skills. No handler code exists in `packages/workers/src/skills/`. Triggering these skills via `POST /api/v1/skills/:name/trigger` enqueues a BullMQ job that cannot execute. Remove both entries from KNOWN_SKILLS and add a code comment noting they are deferred to a future phase.

**Tasks:**
1. [x] Remove `'drift-monitor'` entry (lines 37-40) from KNOWN_SKILLS in `packages/core-api/src/routes/skills.ts`
2. [x] Remove `'daily-connections'` entry (lines 41-44) from KNOWN_SKILLS
3. [x] Add comment: `// Deferred: drift-monitor, daily-connections — implement when PRD F21/F22 are prioritized`
4. [x] Update any tests that reference these skill names

**Acceptance Criteria:**
- [x] GET /api/v1/skills no longer returns `drift-monitor` or `daily-connections`
- [x] POST /api/v1/skills/drift-monitor/trigger returns 404
- [x] All existing tests pass

**Notes:**
These skills are documented in PRD F21 and F22. When prioritized, create handler files in `packages/workers/src/skills/` and re-add to KNOWN_SKILLS.

---

#### 1.3 Remove `|| true` from Dockerfile Build Commands — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F9 (Architecture Audit — Dependency Management, HIGH)
**Files Affected:**
- `Dockerfile` (modify — lines 28-32)

**Description:**
The builder stage at `Dockerfile:28-32` suppresses build failures for 4 of 5 packages with `|| true`. A TypeScript compilation error will produce a Docker image with empty or incomplete `dist/` directories, causing cryptic "Cannot find module" errors at container startup. Remove the error suppression and add verification that expected output files exist.

**Tasks:**
1. [ ] Replace lines 28-32 with sequential builds without `|| true`:
   ```dockerfile
   RUN pnpm --filter @open-brain/shared build \
       && pnpm --filter @open-brain/core-api build \
       && pnpm --filter @open-brain/workers build \
       && pnpm --filter @open-brain/voice-capture build \
       && pnpm --filter @open-brain/slack-bot build
   ```
2. [ ] Add a verification step after the builds:
   ```dockerfile
   RUN test -f packages/core-api/dist/index.js \
       && test -f packages/workers/dist/main.js \
       && test -f packages/voice-capture/dist/server.js \
       && test -f packages/slack-bot/dist/index.js
   ```
3. [ ] Verify `docker build --target core-api .` succeeds locally

**Acceptance Criteria:**
- [ ] `docker build --target core-api .` succeeds with clean code
- [ ] Introducing a deliberate TS error in core-api causes the build to fail (not silently succeed)
- [ ] All 4 build targets produce valid images

**Notes:**
The `|| true` was likely added to work around tsup `--dts` failures on Alpine. If builds fail after removing it, fix the underlying compilation issues rather than re-adding suppression.

---

#### 1.4 Add Bearer Token Authentication to Admin Endpoints — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F14 (Architecture Audit — Security, HIGH)
**Files Affected:**
- `packages/core-api/src/routes/admin.ts` (modify)
- `packages/core-api/src/middleware/admin-auth.ts` (create)
- `packages/core-api/src/__tests__/admin-auth.test.ts` (create)

**Description:**
`POST /api/v1/admin/reset-data` can TRUNCATE all user data with zero authentication. While the system is behind a Cloudflare tunnel, a misconfiguration would expose this endpoint. Reuse the MCP auth pattern from `packages/core-api/src/mcp/auth.ts` to create an admin auth middleware that validates `Authorization: Bearer <token>` against `ADMIN_API_KEY` env var (falls back to `MCP_BEARER_TOKEN` if `ADMIN_API_KEY` is not set).

**Tasks:**
1. [ ] Create `packages/core-api/src/middleware/admin-auth.ts` — Hono middleware that validates Bearer token against `process.env.ADMIN_API_KEY ?? process.env.MCP_BEARER_TOKEN`. Follow the fail-closed pattern from `mcp/auth.ts` (reject if no token configured).
2. [ ] Apply the middleware to the admin router in `packages/core-api/src/routes/admin.ts` — wrap `router.post('/reset-data', ...)` and `router.post('/config/reload', ...)` with the auth middleware
3. [ ] Write tests in `packages/core-api/src/__tests__/admin-auth.test.ts`: no token → 401, wrong token → 401, valid token → passes through, no env var configured → 401 (fail-closed)
4. [ ] Add `ADMIN_API_KEY=` placeholder to `.env.example` or docker-compose env section

**Acceptance Criteria:**
- [ ] POST /api/v1/admin/reset-data without Authorization header returns 401
- [ ] POST /api/v1/admin/reset-data with valid Bearer token succeeds (200)
- [ ] POST /api/v1/admin/config/reload also requires auth
- [ ] GET /api/v1/admin/queues and GET /api/v1/admin/pipeline/health remain unauthenticated (read-only)
- [ ] All tests pass

**Notes:**
Bull Board UI at `/api/v1/admin/queues` is read-only and can remain open. Only mutating endpoints need protection.

---

### Phase 1 Testing Requirements

- [ ] New migration applies cleanly to existing database
- [ ] Skills API returns only implemented skills
- [ ] Docker build fails on compilation errors, succeeds on clean code
- [ ] Admin endpoints reject unauthenticated requests
- [ ] All existing unit tests pass (`pnpm -r test`)

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Shared package rebuilt
- [ ] Docker image builds verified
- [ ] No regressions introduced

---

## Phase 2: Code Hygiene Quick Wins

**Estimated Complexity:** M (~10 files, ~200 LOC)
**Dependencies:** Phase 1 (shared schema must be rebuilt)
**Parallelizable:** Yes — all 5 work items are independent

### Goals

- Eliminate duplicate EmbeddingService to prevent behavior divergence
- Establish consistent structured logging across all packages
- Clean up unnecessary dependencies
- Ensure graceful shutdown releases all resources

### Work Items

#### 2.1 Delete Duplicate EmbeddingService in core-api — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F1 (Architecture Audit — Structure & Organization, MEDIUM)
**Files Affected:**
- `packages/core-api/src/services/embedding.ts` (delete)
- `packages/core-api/src/index.ts` (modify — line 7, change import)
- `packages/core-api/src/__tests__/search-service.test.ts` (modify — update mock imports if needed)
- `packages/shared/src/services/embedding.ts` (modify — align timeout)

**Description:**
Two nearly identical `EmbeddingService` implementations exist: `packages/shared/src/services/embedding.ts` (60s timeout, `maxRetries: 0`) and `packages/core-api/src/services/embedding.ts` (30s timeout, no `maxRetries`). Workers already imports from shared. Core-api should do the same. Delete the core-api copy and update the import in `index.ts` line 7 to `import { EmbeddingService } from '@open-brain/shared'`. Set the shared version's timeout to 30s (sufficient for warm LiteLLM) since both consumers share the same behavior.

**Tasks:**
1. [x] Kept `packages/shared/src/services/embedding.ts` timeout at 60s (handles LiteLLM cold-start; superior to core-api's 30s)
2. [x] Delete `packages/core-api/src/services/embedding.ts`
3. [x] Update `packages/core-api/src/index.ts` line 7: change `import { EmbeddingService } from './services/embedding.js'` to `import { EmbeddingService } from '@open-brain/shared'`
4. [x] Verify re-export from `packages/shared/src/index.ts` includes `EmbeddingService`
5. [x] Update any test files that mock `./services/embedding.js` to mock `@open-brain/shared`
6. [x] Rebuild shared, then core-api: `pnpm --filter @open-brain/shared build && pnpm --filter @open-brain/core-api build`

**Acceptance Criteria:**
- [x] Only one `EmbeddingService` exists (in shared package)
- [x] `pnpm -r build` succeeds
- [x] `pnpm -r test` passes
- [x] `EmbeddingUnavailableError` is also exported from shared (used by search tests)

**Notes:**
The `EmbeddingUnavailableError` class is used in both packages. Ensure it's exported from shared.

---

#### 2.2 Replace console.warn/error with Pino Logger — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F5 (Architecture Audit — Code Quality, LOW)
**Files Affected:**
- `packages/core-api/src/services/llm-gateway.ts` (modify — ~3 sites)
- `packages/core-api/src/services/capture.ts` (modify — ~1 site)
- `packages/workers/src/jobs/update-access-stats.ts` (modify — ~1 site)
- `packages/core-api/src/lib/pg-notify.ts` (modify — ~2 sites)
- Other files with `console.warn` or `console.error` (~3 additional sites)

**Description:**
Approximately 10 call sites bypass the structured pino logger with `console.warn()` or `console.error()`. These won't appear in structured log output and cannot be filtered or aggregated. Replace all with the appropriate pino logger instance. Each package already has a `lib/logger.ts` module.

**Tasks:**
1. [ ] Search all packages for `console.warn` and `console.error` calls: `grep -rn "console\.\(warn\|error\)" packages/*/src/ --include="*.ts" | grep -v __tests__ | grep -v node_modules`
2. [ ] Replace each with `logger.warn(...)` or `logger.error(...)` using the local `logger` import
3. [ ] Ensure log messages include structured context objects where appropriate (e.g., `logger.warn({ err }, 'message')`)

**Acceptance Criteria:**
- [ ] Zero `console.warn` or `console.error` calls in production source files (excluding test files)
- [ ] All replaced log calls use pino's structured format
- [ ] All tests pass

**Notes:**
`console.log` in test files is acceptable. Only target production source files.

---

#### 2.3 Remove Unnecessary `@types/ioredis` DevDependency — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F8 (Architecture Audit — Dependency Management, LOW)
**Files Affected:**
- `packages/core-api/package.json` (modify)

**Description:**
`@types/ioredis@^5.0.0` is listed as a devDependency in core-api, but ioredis v5+ ships its own TypeScript declarations. The types package is deprecated and unnecessary.

**Tasks:**
1. [ ] Remove `"@types/ioredis"` from `packages/core-api/package.json` devDependencies
2. [ ] Run `pnpm install` to update lockfile
3. [ ] Verify `pnpm --filter @open-brain/core-api build` still succeeds (ioredis provides its own types)

**Acceptance Criteria:**
- [ ] `@types/ioredis` no longer in package.json
- [ ] Build succeeds without it
- [ ] No type errors introduced

**Notes:**
Trivial change, zero risk.

---

#### 2.4 Parallelize EntityService.list() Queries — completed 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F21 (Architecture Audit — Performance, LOW)
**Files Affected:**
- `packages/core-api/src/services/entity.ts` (modify — lines 81-112)

**Description:**
`EntityService.list()` runs a complex JOIN query then a separate COUNT query sequentially. Both are independent and can be parallelized with `Promise.all()`, matching the pattern already used by `CaptureService.list()`.

**Tasks:**
1. [ ] Wrap the data query and count query in `Promise.all()` (lines 81-112 of entity.ts)
2. [ ] Destructure results: `const [dataResult, countResult] = await Promise.all([...])`
3. [ ] Verify the function returns the same shape

**Acceptance Criteria:**
- [ ] EntityService.list() returns identical results
- [ ] Both queries execute concurrently (verified by timing or code inspection)
- [ ] All entity tests pass

**Notes:**
Follow the `CaptureService.list()` pattern at `packages/core-api/src/services/capture.ts:133`.

---

#### 2.5 Close DB Pool and BullMQ Queues on Graceful Shutdown — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F19 (Architecture Audit — Performance, MEDIUM)
**Files Affected:**
- `packages/core-api/src/index.ts` (modify — lines 28, 100-107)
- `packages/shared/src/db.ts` or equivalent (modify — expose pool reference)

**Description:**
The graceful shutdown handler at `packages/core-api/src/index.ts:100-107` calls `pgNotify.stop()` and `server.close()` but does not close the Drizzle/pg Pool (max 20 connections will hang) or the three BullMQ Queue instances created on lines 46-48. On shutdown, connections should be released cleanly.

**Tasks:**
1. [ ] Modify `createDb()` in shared to return both the Drizzle instance and the underlying `Pool`, or store the pool as a property
2. [ ] In `packages/core-api/src/index.ts`, capture the pool reference from `createDb()`
3. [ ] In the `shutdown()` function (line 100), add: `await pool.end()`, `await capturePipelineQueue.close()`, `await skillQueue.close()`, `await documentPipelineQueue.close()`
4. [ ] Order: close queues first (stop accepting jobs), then pgNotify, then pool, then server
5. [ ] Rebuild shared package if `createDb()` signature changes

**Acceptance Criteria:**
- [ ] Shutdown handler closes pool + all 3 queues
- [ ] `SIGTERM` results in clean exit with no hanging connections
- [ ] All tests pass (mock pool.end if needed)

**Notes:**
The workers `main.ts` likely has a similar issue — check and fix there too if applicable.

---

### Phase 2 Testing Requirements

- [ ] Only one EmbeddingService exists across the monorepo
- [ ] Zero console.warn/error in production source code
- [ ] Build succeeds without @types/ioredis
- [ ] EntityService.list() tests pass with parallelized queries
- [ ] Shutdown handler releases all resources
- [ ] All existing unit tests pass

### Phase 2 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Shared package rebuilt (if createDb changed)
- [ ] No regressions introduced

---

## Phase 3: DRY Refactoring

**Estimated Complexity:** M (~8 files, ~500 LOC)
**Dependencies:** Phase 2 (shared package changes must be complete)
**Parallelizable:** Yes — both work items are independent. This phase can run in parallel with Phases 4 and 5.

### Goals

- Eliminate triplicated prompt template rendering logic
- Break the 820-line WeeklyBriefSkill into focused, testable modules

### Work Items

#### 3.1 Extract Shared Prompt Template Utility — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F7 (Architecture Audit — Code Quality, LOW)
**Files Affected:**
- `packages/shared/src/lib/prompt-template.ts` (create)
- `packages/shared/src/index.ts` (modify — add export)
- `packages/core-api/src/services/llm-gateway.ts` (modify — use shared utility)
- `packages/core-api/src/services/governance-engine.ts` (modify — use shared utility)
- `packages/workers/src/skills/weekly-brief.ts` (modify — use shared utility)

**Description:**
Three separate implementations of `{{variable}}` template substitution exist: LLMGatewayService (lines 271-278), GovernanceEngine (lines 406-415), and WeeklyBriefSkill (lines 332-351). All read from `config/prompts/`, iterate key/value pairs, and call `replaceAll()`. Extract a `renderPromptTemplate(promptsDir, templateName, variables)` function into `@open-brain/shared`.

**Tasks:**
1. [x] Create `packages/shared/src/lib/prompt-template.ts` with:
   - `loadPromptTemplate(promptsDir: string, templateName: string): string` — reads file, throws if not found
   - `renderPromptTemplate(template: string, vars: Record<string, string>): string` — replaces `{{key}}` with values
   - `loadAndRenderPromptTemplate(promptsDir: string, templateName: string, vars: Record<string, string>): string` — convenience
2. [x] Export from `packages/shared/src/index.ts`
3. [x] Replace template logic in `LLMGatewayService.completeWithPromptTemplate()` with shared utility
4. [x] Replace template logic in `GovernanceEngine` with shared utility
5. [x] Replace template logic in `WeeklyBriefSkill` with shared utility
6. [x] Add unit tests for the shared utility (edge cases: missing template, missing variable, empty vars)

**Acceptance Criteria:**
- [x] Single implementation of prompt template rendering in shared package
- [x] All three consumers delegate to shared utility
- [x] Prompt rendering behavior unchanged (same output for same inputs)
- [x] Unit tests cover: normal rendering, missing file, missing variable key (left as `{{key}}`)
- [x] All existing tests pass

**Notes:**
Keep the API simple. Don't over-engineer with caching or watch mode — just file read + string replace.

---

#### 3.2 Decompose WeeklyBriefSkill into Focused Modules — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F4 (Architecture Audit — Code Quality, MEDIUM)
**Files Affected:**
- `packages/workers/src/skills/weekly-brief.ts` (modify — reduce to orchestrator)
- `packages/workers/src/skills/weekly-brief-query.ts` (create)
- `packages/workers/src/skills/weekly-brief-renderer.ts` (create)
- `packages/workers/src/__tests__/weekly-brief.test.ts` (modify)
- `packages/workers/src/__tests__/weekly-brief-query.test.ts` (create)
- `packages/workers/src/__tests__/weekly-brief-renderer.test.ts` (create)

**Description:**
The WeeklyBriefSkill at 820 lines handles 7+ responsibilities: database queries, context assembly with token budgets, LLM prompt construction, JSON output parsing, HTML email rendering, plain-text email rendering, Pushover notifications, Core API HTTP calls, and audit logging. Extract into three modules:
- **WeeklyBriefQuery** — data fetching, context assembly, token budgeting
- **WeeklyBriefRenderer** — HTML template expansion, plain-text rendering, `buildFallbackHtml()`
- **WeeklyBriefSkill** — orchestrator that calls query → LLM → renderer → deliver

**Tasks:**
1. [ ] Create `weekly-brief-query.ts` — extract data-fetching functions (capture queries, entity queries, bet queries, context assembly with token budget)
2. [ ] Create `weekly-brief-renderer.ts` — extract `expandHtmlSection()`, `buildFallbackHtml()`, HTML template building, plain-text rendering
3. [ ] Refactor `weekly-brief.ts` to import from both modules and serve as orchestrator only
4. [ ] Move types (`WeeklyBriefOutput`, `WeeklyBriefResult`, `WeeklyBriefOptions`) to a shared types file or keep in main module
5. [ ] Create unit tests for query module (mock DB, verify context assembly)
6. [ ] Create unit tests for renderer module (verify HTML output, fallback behavior)
7. [ ] Update existing weekly-brief tests to work with new module structure

**Acceptance Criteria:**
- [ ] `weekly-brief.ts` is under 200 lines (orchestrator only)
- [ ] Query and renderer modules are independently testable
- [ ] Weekly brief execution produces identical output
- [ ] All existing weekly-brief tests pass (updated as needed)
- [ ] New tests cover query context assembly and HTML rendering

**Notes:**
This is a refactor, not a rewrite. The behavior must be identical. Preserve all existing error handling and fallback logic.

---

### Phase 3 Testing Requirements

- [ ] Shared prompt template utility has unit tests
- [ ] WeeklyBriefSkill decomposition preserves behavior
- [ ] New modules have independent unit tests
- [ ] All existing tests pass

### Phase 3 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] weekly-brief.ts under 200 lines
- [ ] No regressions introduced

---

## Phase 4: Type Safety — Raw SQL Migration

**Estimated Complexity:** L (~8 files, ~500 LOC)
**Dependencies:** Phase 2 (deduplicated embedding service)
**Parallelizable:** Yes — this phase can run in parallel with Phases 3 and 5. Work items within this phase are independent.

### Goals

- Replace `db.execute<any>()` with typed queries using Drizzle's query builder or explicit row-type interfaces
- Eliminate `as unknown as EntityRecord` and similar unsafe casts
- Ensure schema changes surface at compile time, not runtime

### Work Items

#### 4.1 Migrate EntityService to Typed Queries — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F6 (Architecture Audit — Code Quality, MEDIUM)
**Files Affected:**
- `packages/core-api/src/services/entity.ts` (modify)
- `packages/core-api/src/__tests__/entity-service.test.ts` (modify)

**Description:**
EntityService uses `db.execute<any>()` with raw SQL for list, get, merge, split, and relationship queries (~10 sites). Replace with Drizzle query builder where possible. For complex queries that genuinely need raw SQL (e.g., GROUP BY with aggregate), define explicit row-type interfaces and validate with runtime checks.

**Tasks:**
1. [x] Identify all `db.execute<any>()` calls in entity.ts
2. [x] For simple queries (single-table SELECT, INSERT, UPDATE), convert to Drizzle query builder API (`db.select().from(entities).where(...)`)
3. [x] For complex queries (JOINs with aggregates), define explicit row interfaces (e.g., `interface EntityListRow { ... }`) and replace `<any>` with the typed interface
4. [x] Remove all `as unknown as EntityRecord` casts
5. [x] Update tests to work with new query patterns

**Acceptance Criteria:**
- [x] Zero `db.execute<any>()` calls remain in entity.ts
- [x] Zero `as unknown as` casts remain in entity.ts
- [x] All entity API endpoints return identical data
- [x] All entity tests pass

**Notes:**
Drizzle's `db.select()` supports `.leftJoin()`, `.groupBy()`, and aggregate functions. Use those where possible before falling back to typed raw SQL.

---

#### 4.2 Migrate EntityResolutionService to Typed Queries — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F6 (Architecture Audit — Code Quality, MEDIUM)
**Files Affected:**
- `packages/core-api/src/services/entity-resolution.ts` (modify)
- `packages/core-api/src/__tests__/entity-resolution.test.ts` (modify)

**Description:**
EntityResolutionService uses raw SQL for entity matching, merging, and co-occurrence graph operations. Apply the same pattern as 4.1: Drizzle query builder where possible, typed row interfaces for complex queries.

**Tasks:**
1. [ ] Identify all `db.execute<any>()` calls in entity-resolution.ts
2. [ ] Convert simple queries to Drizzle query builder
3. [ ] Define explicit row interfaces for complex queries
4. [ ] Remove all `as unknown as` casts
5. [ ] Update tests

**Acceptance Criteria:**
- [ ] Zero `db.execute<any>()` calls remain in entity-resolution.ts
- [ ] Entity resolution behavior unchanged
- [ ] All tests pass

**Notes:**
EntityResolutionService is called by EntityService — ensure the interface contract doesn't change.

---

#### 4.3 Migrate MCP Tools to Typed Queries — COMPLETE 2026-03-10

**Status: COMPLETE 2026-03-10**
**Recommendation Ref:** F6 (Architecture Audit — Code Quality, MEDIUM)
**Files Affected:**
- `packages/core-api/src/mcp/tools/*.ts` (modify — all tool files with raw SQL)

**Description:**
MCP tool handlers (search-brain, list-captures, list-entities, get-entity, brain-stats, get-weekly-brief) contain raw SQL queries with `<any>` casts. These should use the existing service layer or typed queries.

**Tasks:**
1. [ ] Audit all files in `packages/core-api/src/mcp/tools/` for `db.execute<any>()`
2. [ ] Where a service method already exists (e.g., SearchService.search, EntityService.list), delegate to the service instead of raw SQL
3. [ ] For remaining raw SQL, define typed row interfaces
4. [ ] Remove all `as unknown as` and `as any` casts

**Acceptance Criteria:**
- [ ] MCP tools delegate to services where possible
- [ ] Zero `<any>` casts in MCP tool files
- [ ] All MCP tool tests pass

**Notes:**
MCP tools should be thin wrappers around services, not independent data access layers.

---

#### 4.4 Migrate TriggerService and Remaining Raw SQL ✅ Completed 2026-03-10

**Status: COMPLETE [2026-03-10]**
**Recommendation Ref:** F6 (Architecture Audit — Code Quality, MEDIUM)
**Files Affected:**
- `packages/core-api/src/services/trigger.ts` (modify)
- `packages/core-api/src/services/search.ts` (modify — 3 raw SQL sites at lines 101, 112, 135)
- `packages/core-api/src/routes/skills.ts` (modify — 2 `execute<any>` sites)
- `packages/workers/src/skills/weekly-brief-query.ts` (modify — 1 `execute<any>` site)
- `packages/workers/src/skills/pipeline-health.ts` (modify — 1 `execute<any>` site)
- `packages/workers/src/skills/stale-captures.ts` (modify — migrated from `sql.raw()`)
- `packages/workers/src/jobs/update-access-stats.ts` (modify — migrated from `sql.raw()` to Drizzle query builder)
- `packages/workers/src/jobs/daily-sweep.ts` (modify — migrated from `sql.raw()` to Drizzle query builder)
- `packages/workers/src/jobs/budget-check.ts` (modify — typed inline row interface)

**Description:**
Sweep remaining raw SQL in TriggerService and SearchService. SearchService has 3 `db.execute<any>()` calls for hybrid_search, fts_only_search, and capture fetch. Define typed row interfaces for the search function return types.

**Tasks:**
1. [x] Define `HybridSearchRow` interface (already partially exists at search.ts:25) and use it to replace `<any>`
2. [x] Define `CaptureRow` interface for the captures fetch query
3. [x] Migrate TriggerService raw SQL to typed queries
4. [x] Run a final grep for `db.execute<any>` across all packages to catch stragglers
5. [x] Eliminate all `sql.raw()` patterns (SQL injection risk) — migrated to parameterized `sql` templates or Drizzle query builder
6. [x] Replace `execute<any>` in skills.ts, weekly-brief-query.ts, pipeline-health.ts with typed row interfaces

**Acceptance Criteria:**
- [x] `grep -rn "execute<any>" packages/*/src/ --include="*.ts" | grep -v __tests__ | grep -v node_modules` returns zero results
- [x] All services compile without `as any` or `as unknown as` casts for DB queries
- [x] All tests pass (57 test files, 1175+ tests across 6 packages)
- [x] `grep -rn "sql\.raw" packages/*/src/ --include="*.ts" | grep -v __tests__` returns zero results (bonus)

**Notes:**
This is the cleanup sweep. After this item, the codebase has zero raw SQL `<any>` casts and zero `sql.raw()` calls.
SearchService and TriggerService retain typed `db.execute<T>()` for queries using pgvector operators (`<=>`) and custom SQL functions (`hybrid_search`, `fts_only_search`, `update_capture_embedding`) that cannot be expressed in Drizzle's query builder.
`update-access-stats` and `daily-sweep` were fully migrated to Drizzle query builder (no raw SQL at all).
`stale-captures`, `pipeline-health`, `budget-check`, and `weekly-brief-query` use typed `db.execute<{...}>()` with parameterized `sql` templates (safe against injection, but kept as raw SQL to preserve existing test mock patterns).

---

### Phase 4 Testing Requirements

- [ ] All migrated queries return identical results to raw SQL versions
- [ ] No `db.execute<any>()` calls remain in production code
- [ ] All existing tests pass with updated query patterns
- [ ] TypeScript strict mode catches any schema mismatches at compile time

### Phase 4 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Zero `execute<any>` in production code
- [ ] No regressions introduced

---

## Phase 5: Performance & Resilience

**Estimated Complexity:** M (~6 files, ~400 LOC)
**Dependencies:** Phase 2 (code hygiene complete)
**Parallelizable:** Yes — this phase can run in parallel with Phases 3 and 4. Work items within are independent.

### Goals

- Push search filters into SQL to reduce data transfer and memory usage
- Add rate limiting to prevent budget overrun from runaway clients
- Load notifications.yaml via ConfigService for config-driven notification behavior

### Work Items

#### 5.1 Push Search Filters into SQL Functions ✅ Completed 2026-03-10

**Status: COMPLETE [2026-03-10]**
**Recommendation Ref:** F18 (Architecture Audit — Performance, MEDIUM)
**Files Affected:**
- `scripts/init-schema.sql` (modify — hybrid_search and fts_only_search functions)
- `packages/shared/drizzle/0009_search_filter_params.sql` (create)
- `packages/core-api/src/services/search.ts` (modify — remove in-memory filtering)

**Description:**
SearchService fetches `limit * 5` rows (up to 200) then filters by brain_view, capture_type, dateFrom, and dateTo in JavaScript (lines 162-183). These filters should be WHERE clause parameters in the `hybrid_search()` and `fts_only_search()` SQL functions, letting Postgres use indexes and return only matching rows.

**Tasks:**
1. [x] Add optional parameters to `hybrid_search()`: `filter_brain_views text[] DEFAULT NULL`, `filter_capture_types text[] DEFAULT NULL`, `filter_date_from timestamptz DEFAULT NULL`, `filter_date_to timestamptz DEFAULT NULL`
2. [x] Add corresponding WHERE clauses inside the function: `AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))`, etc.
3. [x] Apply same changes to `fts_only_search()`
4. [x] Create migration `0009_search_filter_params.sql` with `CREATE OR REPLACE FUNCTION` statements
5. [x] Update `SearchService.search()` to pass filter params to SQL and remove in-memory filtering (lines 162-183)
6. [x] Change `fetchCount` from `limit * 5` to `limit` (no overfetch needed)

**Acceptance Criteria:**
- [x] Search with filters returns same results as before (verified with test data)
- [x] SearchService no longer filters in JavaScript
- [x] `fetchCount` equals `limit` (no overfetching)
- [x] Search tests pass with updated SQL function calls
- [x] Migration applies cleanly

**Notes:**
Use `IS NULL OR` pattern for optional params so unfiltered searches are unaffected. Test with NULL params explicitly.

---

#### 5.2 Add Rate Limiting Middleware ✅ Completed 2026-03-10

**Status: COMPLETE [2026-03-10]**
**Recommendation Ref:** F16 (Architecture Audit — Security, MEDIUM)
**Files Affected:**
- `packages/core-api/src/middleware/rate-limit.ts` (create)
- `packages/core-api/src/app.ts` (modify — add middleware)
- `packages/core-api/src/__tests__/rate-limit.test.ts` (create)

**Description:**
No rate limiting exists on any endpoint. A misconfigured iOS Shortcut or runaway client could overwhelm the system or burn through the AI budget. Add a simple in-memory sliding window rate limiter (no Redis needed for single-user). Apply stricter limits to endpoints that trigger LLM calls.

**Tasks:**
1. [x] Create `packages/core-api/src/middleware/rate-limit.ts` with a simple sliding-window rate limiter using a Map (IP-based, resets every window)
2. [x] Define rate limit tiers:
   - Default: 100 requests/minute (general API)
   - Strict: 20 requests/minute (POST /api/v1/captures, POST /api/v1/search, POST /api/v1/synthesize — these trigger LLM/embedding calls)
   - Admin: 5 requests/minute (POST /api/v1/admin/*)
3. [x] Apply as Hono middleware in `app.ts`
4. [x] Return `429 Too Many Requests` with `Retry-After` header when limit exceeded
5. [x] Write unit tests: under limit → passes, over limit → 429, window resets after period

**Acceptance Criteria:**
- [x] Requests under the limit succeed normally
- [x] Requests over the limit return 429 with Retry-After header
- [x] Different tiers apply to different endpoint groups
- [x] Rate limiter does not persist state across restarts (in-memory, acceptable for single-user)
- [x] All tests pass

**Notes:**
Keep it simple — in-memory Map is sufficient for a single-user system. Don't add Redis-based rate limiting complexity.

---

#### 5.3 Load notifications.yaml in ConfigService ✅ Completed 2026-03-10

**Status: COMPLETE [2026-03-10]**
**Recommendation Ref:** S7 (Intent Review — Partial Implementation, SUGGESTION)
**Files Affected:**
- `packages/shared/src/config/loader.ts` (modify)
- `config/notifications.yaml` (verify structure)

**Description:**
`config/notifications.yaml` exists but ConfigService only loads `ai-routing.yaml`, `brain-views.yaml`, `pipelines.yaml`, and `pipeline.yaml`. The notification behavior is hardcoded via env vars in the Pushover/Email services. Add notifications.yaml to ConfigService's load list so notification config is queryable and reloadable.

**Tasks:**
1. [ ] Add `notifications` to the list of config files loaded by ConfigService
2. [ ] Define a TypeScript interface for the notifications config shape
3. [ ] Verify `config/notifications.yaml` has valid YAML structure
4. [ ] Add `getNotificationsConfig()` accessor to ConfigService
5. [ ] Verify config reload includes notifications.yaml

**Acceptance Criteria:**
- [ ] `configService.getNotificationsConfig()` returns parsed notifications config
- [ ] Config reload reloads notifications.yaml
- [ ] Existing notification behavior unchanged (services can optionally read from config)
- [ ] All tests pass

**Notes:**
This is wiring only — the Pushover/Email services don't need to consume the config in this phase. Just make it available.

---

### Phase 5 Testing Requirements

- [ ] Search with filters returns identical results via SQL vs old in-memory approach
- [ ] Rate limiter correctly enforces limits per tier
- [ ] Notifications config loads and reloads without error
- [ ] All existing tests pass

### Phase 5 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Migration 0009 applies cleanly
- [ ] No regressions introduced

---

## Phase 6: Integration Test Suite

**Estimated Complexity:** L (~8 files, ~500 LOC)
**Dependencies:** Phases 3, 4, 5 (refactoring should be complete before integration tests validate the system)
**Parallelizable:** No — work items are sequential (infrastructure → API tests → pipeline tests)

### Goals

- Establish integration test infrastructure that tests against real Postgres + Redis
- Catch the class of bugs that unit tests with mocks cannot (entity count, date handling, search accuracy)
- Provide a CI-compatible test environment via docker-compose.test.yml

### Work Items

#### 6.1 Integration Test Infrastructure ✅ Completed 2026-03-10

**Status: COMPLETE [2026-03-10]**
**Recommendation Ref:** F11 (Architecture Audit — Testing, MEDIUM)
**Files Affected:**
- `docker-compose.test.yml` (create)
- `packages/core-api/src/__tests__/integration/setup.ts` (create)
- `packages/core-api/src/__tests__/integration/helpers.ts` (create)
- `packages/core-api/src/__tests__/integration/smoke.test.ts` (create)
- `packages/core-api/vitest.config.integration.ts` (create)
- `packages/core-api/vitest.config.ts` (modify — exclude integration tests from default run)
- `packages/core-api/package.json` (modify — add test:integration script)
- `package.json` (modify — add root test:integration script with docker lifecycle)

**Description:**
Create the infrastructure for integration tests: a docker-compose file with ephemeral Postgres + Redis containers, a test setup that initializes the database with migrations, and helper utilities for creating test data and making API calls against the real Hono app.

**Tasks:**
1. [x] Create `docker-compose.test.yml` with:
   - postgres (pgvector/pgvector:pg16, port 5433, tmpfs for speed)
   - redis (redis:7-alpine, port 6381, no persistence)
   - Both with healthchecks using 127.0.0.1
2. [x] Create `packages/core-api/vitest.config.integration.ts` with `include: ['src/__tests__/integration/**/*.test.ts']`, longer timeout (30s), sequential execution
3. [x] Create `setup.ts` — connects to test DB, applies init-schema.sql (full DDL + SQL functions), provides `getTestApp()` that returns a configured Hono app with real services and stub embedding service
4. [x] Create `helpers.ts` — `createTestCapture()`, `createTestEntity()`, `linkEntityToCapture()`, `createTestBet()`, `createTestSession()`, `seedTestData()`, `cleanDatabase()`, plus HTTP request helpers (`testGet`, `testPost`, `testPatch`, `testDelete`)
5. [x] Add npm scripts: `test:integration` in core-api package.json and root package.json (with docker compose lifecycle)
6. [x] Create `smoke.test.ts` — validates infrastructure works (schema, SQL functions, pgvector extension, CRUD, cleanup, test app, health endpoint)
7. [x] Exclude integration tests from default `vitest run` via `vitest.config.ts` exclude pattern

**Acceptance Criteria:**
- [x] `docker compose -f docker-compose.test.yml up -d` starts healthy Postgres + Redis
- [x] Setup connects to DB and applies full schema (init-schema.sql) successfully
- [x] `getTestApp()` returns a working Hono app
- [x] Helper utilities create valid test data
- [x] Existing unit tests (345 tests across 22 files) unaffected — all pass

**Notes:**
Use randomized ports to avoid conflicts with running services. Tests should be idempotent (clean DB between test files).

---

#### 6.2 API Integration Tests ✅ Completed 2026-03-10

**Status: COMPLETE [2026-03-10]**
**Recommendation Ref:** F11 (Architecture Audit — Testing, MEDIUM)
**Files Affected:**
- `packages/core-api/src/__tests__/integration/captures.test.ts` (create)
- `packages/core-api/src/__tests__/integration/search.test.ts` (create)
- `packages/core-api/src/__tests__/integration/entities.test.ts` (create)

**Description:**
Write integration tests that exercise the API against a real database. Target the bugs found during manual integration testing: entity count accuracy, date handling, capture CRUD validation, search result ranking.

**Tasks:**
1. [x] Write captures integration test: POST create → GET list → GET by ID → PATCH update → verify data roundtrips correctly
2. [x] Write search integration test: create captures with known content → search → verify results and ranking
3. [x] Write entities integration test: create captures → run entity extraction mock → verify entity count and relationships
4. [x] Test date handling: create capture with specific `captured_at` → verify no "Invalid Date" in responses
5. [x] Test pagination: create 20+ captures → verify limit/offset works correctly

**Acceptance Criteria:**
- [x] All integration tests pass against real Postgres
- [x] Tests verify the bugs documented in MEMORY.md (entity count, Invalid Date) cannot recur
- [x] Tests run in < 60 seconds

**Notes:**
Embedding-dependent tests should mock the embedding service (LiteLLM won't be available in CI). Focus on data layer correctness.

---

#### 6.3 Pipeline Smoke Tests

**Status: PENDING**
**Recommendation Ref:** F11 (Architecture Audit — Testing, MEDIUM)
**Files Affected:**
- `packages/core-api/src/__tests__/integration/pipeline.test.ts` (create)

**Description:**
Write smoke tests that verify the BullMQ pipeline flow: capture creation enqueues a job, job transitions through stages, pipeline_status updates correctly. Use real Redis for queue operations.

**Tasks:**
1. [ ] Create a test that: POST capture → verify BullMQ job created in capture-pipeline queue → process job (mock LLM) → verify pipeline_status transitions: pending → processing → complete
2. [ ] Test retry behavior: simulate a stage failure → verify job retries with correct backoff
3. [ ] Test idempotency: process same capture twice → verify no duplicate entities or embeddings

**Acceptance Criteria:**
- [ ] Pipeline flow test passes with real Redis queue
- [ ] Stage transitions are verified end-to-end
- [ ] Retry and idempotency tests pass
- [ ] Tests clean up jobs after completion

**Notes:**
Use BullMQ's `Worker` in tests to process jobs synchronously. Mock LLM and embedding calls.

---

### Phase 6 Testing Requirements

- [ ] All integration tests pass against ephemeral Postgres + Redis
- [ ] Tests are idempotent and isolated
- [ ] CI script runs integration tests successfully
- [ ] No flaky tests

### Phase 6 Completion Checklist

- [ ] All work items complete
- [ ] All unit and integration tests passing
- [ ] docker-compose.test.yml verified
- [ ] CI workflow updated to include integration tests (optional, can defer)
- [ ] No regressions introduced

---

## Phase 7: Documentation Alignment

**Estimated Complexity:** M (~5 files, ~300 LOC)
**Dependencies:** None (independent, can run anytime)
**Parallelizable:** Yes — all 4 work items are independent

### Goals

- Bring TDD into alignment with the as-built system
- Document unplanned additions that are now permanent features
- Explicitly mark deferred features so they don't appear as bugs

### Work Items

#### 7.1 Update TDD Section 4.2 — As-Built Schema

**Status: PENDING**
**Recommendation Ref:** W3 (Intent Review — Schema Divergence, WARNING)
**Files Affected:**
- `docs/TDD.md` (modify — Section 4.2 Database Schema)

**Description:**
The TDD specifies a schema that differs from implementation in several ways: `brain_views` (array) vs `brain_view` (single text), different pipeline_status values, different session types, different bet columns, missing `canonical_name` on entities, missing `entity_relationships` table. Update TDD Section 4.2 to match the as-built schema.

**Tasks:**
1. [ ] Change `brain_views text[]` to `brain_view text NOT NULL` and add note: "Single view per capture — intentional simplification"
2. [ ] Update pipeline_status values to: `pending | processing | extracted | embedded | chunked | complete | failed`
3. [ ] Update sessions table: `session_type` values to `governance | review | planning`
4. [ ] Update bets table columns to match implementation: `statement`, `confidence`, `domain`
5. [ ] Add `canonical_name text` column to entities table
6. [ ] Add `entity_relationships` table definition
7. [ ] Add `access_count` and `last_accessed_at` columns (from Phase 1 work)
8. [ ] Add `deleted_at timestamptz` column to captures (soft delete)

**Acceptance Criteria:**
- [ ] TDD Section 4.2 matches the Drizzle schema in `packages/shared/src/schema/`
- [ ] All intentional simplifications are noted with rationale

**Notes:**
This is documentation only — no code changes.

---

#### 7.2 Update TDD Sections 4.3 and 3.2 — SQL Functions and Synthesize Endpoint

**Status: PENDING**
**Recommendation Ref:** W4, S4 (Intent Review — Documentation Drift, WARNING)
**Files Affected:**
- `docs/TDD.md` (modify — Sections 3.2 and 4.3)

**Description:**
TDD Section 4.3 specifies `match_captures()` and `match_captures_hybrid()` SQL functions. Implementation uses `hybrid_search()`, `vector_search()`, and `fts_search()` with different parameter signatures. TDD Section 3.2 specifies the synthesize endpoint with `{max_captures, token_budget, filters}` request and `{synthesis, captures_used, model, token_usage}` response. Implementation uses `{query, limit}` request and `{response, capture_count}` response.

**Tasks:**
1. [ ] Update TDD 4.3: replace `match_captures()` / `match_captures_hybrid()` with actual function signatures for `hybrid_search()`, `vector_search()`, `fts_search()`, and `fts_only_search()`
2. [ ] Update TDD 3.2: document actual synthesize endpoint contract (`{query, limit}` → `{response, capture_count}`)
3. [ ] Note any parameters that were intentionally simplified with rationale

**Acceptance Criteria:**
- [ ] TDD SQL function documentation matches `scripts/init-schema.sql`
- [ ] TDD synthesize endpoint documentation matches `packages/core-api/src/routes/synthesize.ts`

**Notes:**
Documentation only — no code changes.

---

#### 7.3 Document Unplanned Additions

**Status: PENDING**
**Recommendation Ref:** S1, S2, S3 (Intent Review — Scope Addition, SUGGESTION)
**Files Affected:**
- `docs/TDD.md` (modify — add sections for SSE, admin reset, stale-captures)

**Description:**
Three features were added during implementation that aren't in the TDD: SSE events (Postgres LISTEN/NOTIFY), admin data reset endpoint, and stale-captures monitoring skill. Add documentation for each.

**Tasks:**
1. [ ] Add SSE events endpoint documentation to TDD Section 3 (API Endpoints): `GET /api/v1/events` — SSE stream via Postgres LISTEN/NOTIFY with heartbeat
2. [ ] Add admin reset endpoint documentation: `POST /api/v1/admin/reset-data` — TRUNCATEs user data tables (requires Bearer auth as of Phase 1)
3. [ ] Add stale-captures skill documentation to the skills section: detects and re-queues stuck pipeline captures
4. [ ] Add each to the feature list in the PRD or TDD feature matrix

**Acceptance Criteria:**
- [ ] All three unplanned features are documented in TDD
- [ ] Documentation matches actual implementation behavior

**Notes:**
Documentation only — no code changes.

---

#### 7.4 Mark Deferred Features and Update README Roadmap

**Status: PENDING**
**Recommendation Ref:** W1, W2, W5 (Intent Review — Missing Features, WARNING/SUGGESTION)
**Files Affected:**
- `README.md` (modify — add Roadmap section)
- `docs/PRD.md` (modify — mark deferred features)

**Description:**
Three PRD features were not implemented and should be explicitly marked as deferred rather than silently missing: bookmarks ingestion (F24), calendar integration (F25), and Slack voice messages (F20). Add a roadmap section to README and mark these in the PRD.

**Tasks:**
1. [ ] Add a "Roadmap / Deferred Features" section to README.md:
   - Bookmarks ingestion (PRD F24) — browser bookmark import
   - Calendar integration (PRD F25) — calendar event sync via rclone
   - Slack voice messages (PRD F20) — audio in Slack DM → transcription
   - Drift monitor skill (PRD F21) — topic drift detection
   - Daily connections skill (PRD F22) — cross-capture connection surfacing
2. [ ] In docs/PRD.md, add "Status: DEFERRED" annotation to F20, F21, F22, F24, F25
3. [ ] Note the primary voice capture path (iOS Shortcut → voice-capture endpoint) as the active implementation

**Acceptance Criteria:**
- [ ] README has a clear roadmap section listing deferred features
- [ ] PRD features are annotated with their status
- [ ] No ambiguity about what is and isn't implemented

**Notes:**
Documentation only — no code changes. Keep the roadmap concise — bullet points, not paragraphs.

---

### Phase 7 Testing Requirements

- [ ] Documentation changes are internally consistent
- [ ] No broken markdown links
- [ ] TDD schema matches actual Drizzle schema

### Phase 7 Completion Checklist

- [ ] All work items complete
- [ ] Documentation reviewed for accuracy
- [ ] No code changes made (documentation only)

---

## Phase 8: Final Validation, Cleanup & Ship

**Depends on:** All previous phases (1-7)
**Estimated effort:** 1-2 hours

### 8.1 Full Test Suite Validation

**Priority:** CRITICAL
**Estimated effort:** 30 min
**Status:** PENDING

**Tasks:**
- [ ] Run `/test-all` across the entire project
- [ ] Fix any failing tests, lint issues, or type errors discovered
- [ ] Re-run until all checks pass clean

**Acceptance Criteria:**
- [ ] All unit tests pass
- [ ] All regression tests pass
- [ ] All automatable USER_TEST_PLAN.md tests pass
- [ ] Zero lint errors
- [ ] Clean type-check across all packages

---

### 8.2 Repository Cleanup

**Priority:** HIGH
**Estimated effort:** 20 min
**Status:** PENDING

**Tasks:**
- [ ] Run `/personal-plugin:clean-repo` to clean, organize, and refresh documentation
- [ ] Review and accept cleanup changes
- [ ] Verify no functional code was altered by cleanup

**Acceptance Criteria:**
- [ ] Repository is clean and well-organized
- [ ] Documentation is up to date
- [ ] No orphaned or stale files remain

---

### 8.3 Ship (PR, Review, Merge)

**Priority:** HIGH
**Estimated effort:** 15 min
**Status:** PENDING

**Tasks:**
- [ ] Create PR with comprehensive summary of all hardening work
- [ ] Run `/personal-plugin:ship` to finalize
- [ ] Merge to main

**Acceptance Criteria:**
- [ ] PR created with full summary of changes
- [ ] All CI checks pass
- [ ] Merged to main

---

### 8.4 Final Summary Report

**Priority:** MEDIUM
**Estimated effort:** 5 min
**Status:** PENDING

**Tasks:**
- [ ] Produce a 40-line-or-less summary of everything done
- [ ] Include: phases completed, work items shipped, key metrics, current project state

**Acceptance Criteria:**
- [ ] Summary is concise (≤40 lines)
- [ ] Covers all phases and key changes
- [ ] States current project health and readiness

### Phase 8 Testing Requirements

- [ ] `/test-all` passes with zero failures
- [ ] Repository cleanup introduces no regressions
- [ ] PR merges cleanly to main

### Phase 8 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] PR merged
- [ ] Summary delivered to user

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| 1.1 | 1.2, 1.3, 1.4 | All Phase 1 items are independent |
| 1.2 | 1.1, 1.3, 1.4 | Skills route change is isolated |
| 1.3 | 1.1, 1.2, 1.4 | Dockerfile is independent of app code |
| 1.4 | 1.1, 1.2, 1.3 | Admin auth is new middleware |
| 2.1 | 2.2, 2.3, 2.4, 2.5 | All Phase 2 items are independent |
| Phase 3 | Phase 4, Phase 5 | Independent refactoring streams after Phase 2 |
| Phase 4 | Phase 3, Phase 5 | Independent refactoring streams after Phase 2 |
| Phase 5 | Phase 3, Phase 4 | Independent refactoring streams after Phase 2 |
| Phase 7 | Any phase | Documentation is always independent |
| 7.1 | 7.2, 7.3, 7.4 | All doc updates are independent |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Dockerfile build fails after removing `\|\| true` | Medium | Medium | Investigate root cause (likely tsup --dts on Alpine). Fix compilation issue rather than re-adding suppression. Have rollback plan (git revert). |
| Raw SQL migration (Phase 4) changes query behavior | Medium | High | Compare query results before/after for representative data. Integration tests (Phase 6) provide safety net. |
| Search filter migration (Phase 5.1) changes result ranking | Low | High | Test with known data set, compare results row-by-row. Keep old in-memory filtering as commented fallback during validation. |
| WeeklyBriefSkill decomposition breaks email formatting | Low | Medium | Capture current HTML output as snapshot test. Compare decomposed output against snapshot. |
| Integration test flakiness in CI | Medium | Low | Use tmpfs for Postgres, deterministic test data, sequential execution. Retry on CI failure. |
| Admin auth breaks existing automation | Low | Medium | Document the change. ADMIN_API_KEY falls back to MCP_BEARER_TOKEN, so existing MCP token works for admin too. |

---

## Success Metrics

- [ ] All phases completed
- [ ] All acceptance criteria met
- [ ] Zero `db.execute<any>()` calls in production code (type safety goal)
- [ ] Zero `console.warn/error` in production code (logging consistency)
- [ ] Only one EmbeddingService implementation (deduplication goal)
- [ ] WeeklyBriefSkill under 200 lines (maintainability goal)
- [ ] Docker build fails on TS compilation errors (build safety)
- [ ] Admin endpoints require authentication (security goal)
- [ ] Integration test suite covers capture CRUD, search, and pipeline flow
- [ ] TDD documentation matches as-built system (documentation accuracy)
- [ ] All 1,107+ existing unit tests continue to pass (regression safety)

---

## Appendix: Recommendation Traceability

| Recommendation | Source | Phase | Work Item |
|----------------|--------|-------|-----------|
| C1: access_count + last_accessed_at columns | Intent Review (Schema Divergence) | 1 | 1.1 |
| C2: Unimplemented skills in KNOWN_SKILLS | Intent Review (Partial Implementation) | 1 | 1.2 |
| F9: Dockerfile `\|\| true` suppression | Architecture Audit (Dependency Mgmt) | 1 | 1.3 |
| F14: Admin endpoints no auth | Architecture Audit (Security) | 1 | 1.4 |
| F1: Duplicate EmbeddingService | Architecture Audit (Structure) | 2 | 2.1 |
| F5: console.warn/error bypasses pino | Architecture Audit (Code Quality) | 2 | 2.2 |
| F8: Unnecessary @types/ioredis | Architecture Audit (Dependencies) | 2 | 2.3 |
| F21: EntityService.list() sequential queries | Architecture Audit (Performance) | 2 | 2.4 |
| F19: DB pool + queues not closed on shutdown | Architecture Audit (Performance) | 2 | 2.5 |
| F7: Prompt template rendering duplicated 3x | Architecture Audit (Code Quality) | 3 | 3.1 |
| F4: WeeklyBriefSkill 820-line god module | Architecture Audit (Code Quality) | 3 | 3.2 |
| F6: 30+ raw SQL `as any` casts (EntityService) | Architecture Audit (Code Quality) | 4 | 4.1 |
| F6: Raw SQL (EntityResolutionService) | Architecture Audit (Code Quality) | 4 | 4.2 |
| F6: Raw SQL (MCP tools) | Architecture Audit (Code Quality) | 4 | 4.3 |
| F6: Raw SQL (TriggerService, SearchService) | Architecture Audit (Code Quality) | 4 | 4.4 |
| F18: In-memory search filtering | Architecture Audit (Performance) | 5 | 5.1 |
| F16: No rate limiting | Architecture Audit (Security) | 5 | 5.2 |
| S7: notifications.yaml not loaded | Intent Review (Partial Implementation) | 5 | 5.3 |
| F11: No integration tests | Architecture Audit (Testing) | 6 | 6.1, 6.2, 6.3 |
| W3: Schema differs from TDD | Intent Review (Schema Divergence) | 7 | 7.1 |
| W4, S4: SQL functions + synthesize differ | Intent Review (Documentation Drift) | 7 | 7.2 |
| S1, S2, S3: Unplanned additions undocumented | Intent Review (Scope Addition) | 7 | 7.3 |
| W1, W2, W5: Deferred features unmarked | Intent Review (Missing Features) | 7 | 7.4 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-03-10*
*Source: /create-plan command — based on Consolidated Intent Review + Architecture Audit*
