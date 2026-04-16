# Implementation Plan — Architectural Refactor: Zero Technical Debt

**Generated:** 2026-04-16 16:30:00
**Based On:** Ultra Plan architectural assessment (session 2026-04-16), /review-arch audit, LAB_NOTEBOOK Entry 049, infrastructure inventory of homeserver/obvm/bond
**Total Phases:** 8
**Estimated Total Effort:** ~3,500 LOC across ~60 files + infrastructure changes

---

## Executive Summary

This plan eliminates identified technical debt across Open Brain's architecture, consolidates infrastructure from three machines to one, and establishes a repeatable pattern for all future batch data sources (email, financial, utilities, purchases).

The keystone change is extracting a `BaseSkill` abstract class (Phase 2-3) that standardizes the 27-skill system. This unlocks the email pipeline migration (Phase 4-5) as a clean TypeScript BullMQ worker instead of a Python/SQLite/cron sidecar on a separate VM. The morning brief enhancement (Phase 6) then consumes email classification data via Postgres queries — free, no LLM needed. Infrastructure decommission (Phase 7) removes the VM and OpenClaw morning brief as dependencies. UI decomposition and integration tests (Phase 8) round out quality.

Interrelated issues are grouped into cohesive change sets: migration numbering, scheduler overlap, and type cleanup ship together as foundation (Phase 1). BaseSkill and query extraction ship together (Phase 2-3). Email pipeline, morning brief, and infrastructure decommission form a dependency chain (Phase 4-7). UI and testing are independent (Phase 8).

---

## Plan Overview

Phases are ordered by dependency chain: foundation cleanup unblocks skill architecture, which unblocks email migration, which unblocks infrastructure decommission. Quality work is independent and can run in parallel with later phases.

The critical path is: Phase 1 → Phase 2 → Phase 4 → Phase 5 → Phase 6 → Phase 7. Phase 3 can overlap with Phase 4 (different files). Phase 8 is fully independent.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies |
|-------|------------|------------------|-----------------|--------------|
| 1 | Foundation Cleanup | Fix migration conflicts, stagger scheduler, clean `as any` | S (~8 files, ~50 LOC) | None |
| 2 | BaseSkill + Pilots | Abstract base class, 3 pilot skill migrations, skill-execution update | M (~8 files, ~400 LOC) | None |
| 3 | Complete Skill Migration | Remaining 24 skills migrated to BaseSkill, query files standardized | M (~30 files, ~300 LOC net change) | Phase 2 |
| 4 | Email Auth & Schema | Hotmail client, Gmail client, email_classifications schema, classifier | M (~8 files, ~600 LOC) | Phase 1 (clean migrations) |
| 5 | Email Pipeline Skill | EmailClassifySkill, scheduler registration, ai-routing config | M (~6 files, ~500 LOC) | Phase 2, Phase 4 |
| 6 | Morning Brief Enhancement | Email triage section, Slack DM delivery, query extraction | M (~5 files, ~300 LOC) | Phase 5 |
| 7 | Infrastructure Consolidation | Backup migration to homeserver, disable VM/Bond email jobs | S (~3 files + ops, ~50 LOC) | Phase 6 (validated) |
| 8 | Quality & UI | Settings/System page decomposition, integration tests | M (~12 files, ~600 LOC) | None (independent) |

<!-- BEGIN PHASES -->

---

## Phase 1: Foundation Cleanup

**Estimated Complexity:** S (~8 files, ~50 LOC)
**Dependencies:** None
**Parallelizable:** Yes — all 3 items are independent

### Goals

- Fix migration numbering conflicts that could cause schema issues on fresh setup
- Stagger scheduler jobs to avoid LLM queue contention at 7 AM and 8 AM
- Eliminate `as any` type assertions in production code

### Work Items

#### 1.1 Fix Migration Numbering Conflicts
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Architectural Review F3
**Files Affected:**
- `packages/shared/drizzle/0018_mcp_activity.sql` (renamed from `0014_mcp_activity.sql`)
- `packages/shared/drizzle/0019_email_drafts.sql` (renamed from `0015_email_drafts.sql`)
- `packages/shared/drizzle/meta/` (update Drizzle Kit metadata if present)

**Description:**
Two migration numbering conflicts exist: `0014_activity_feed.sql` + `0014_mcp_activity.sql`, and `0015_backup_log.sql` + `0015_email_drafts.sql`. Renumber the duplicates to 0018 and 0019 respectively (after existing 0017). Verify homeserver DB has all tables applied. Update any Drizzle Kit snapshot metadata.

**Tasks:**
1. [ ] Verify homeserver Postgres has all tables from both 0014 and both 0015 migrations: `sudo docker exec open-brain-postgres psql -U openbrain -d openbrain -c '\dt'`
2. [ ] Rename `0014_mcp_activity.sql` → `0018_mcp_activity.sql`
3. [ ] Rename `0015_email_drafts.sql` → `0019_email_drafts.sql`
4. [ ] Check and update `packages/shared/drizzle/meta/` snapshot files if they reference old names
5. [ ] Verify `scripts/init-schema.sql` doesn't hardcode migration numbers

**Acceptance Criteria:**
- [ ] All migration files have unique numeric prefixes
- [ ] `ls packages/shared/drizzle/0*.sql | sort` shows no duplicate numbers
- [ ] Fresh DB setup via init-schema.sql + migrations applies cleanly

**Notes:**
Both migrations are already applied on homeserver. This is a rename to prevent future confusion, not a schema change. No downtime needed.

---

#### 1.2 Stagger Scheduler Job Overlap
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Architectural Review F10
**Files Affected:**
- `packages/workers/src/scheduler.ts` (modify)

**Description:**
Three jobs fire at 7:00 AM (daily-connections, cost-analysis, capture-reminder-morning) and two LLM-heavy jobs fire at 8:00 AM (budget-check, drift-monitor). Jetson GPU handles one request at a time, so concurrent classification calls serialize with added latency. Stagger by 5-10 minutes. Also reserve the 5:00 AM slot for the email-classify job (Phase 5).

**Tasks:**
1. [ ] Change `daily-connections` from `0 7 * * *` to `0 7 * * *` (keep — it's the anchor)
2. [ ] Change `cost-analysis` from `0 7 * * *` to `10 7 * * *` (7:10 AM)
3. [ ] Change `capture-reminder-morning` from `0 7 * * 1-5` to `5 7 * * 1-5` (7:05 AM)
4. [ ] Change `drift-monitor` from `0 8 * * *` to `15 8 * * *` (8:15 AM)
5. [ ] Add comment block reserving `0 5 * * *` for email-classify (Phase 5)
6. [ ] Update the JSDoc comment block listing all job schedules

**Acceptance Criteria:**
- [ ] No two LLM-calling jobs share the same minute
- [ ] `pnpm --filter @open-brain/workers test` passes
- [ ] JSDoc accurately reflects all cron schedules

---

#### 1.3 Clean `as any` from Production Code
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Architectural Review F7
**Files Affected:**
- `packages/core-api/src/app.ts` (modify — 1 instance)
- `packages/shared/src/services/llm-gateway.ts` (modify — 1 instance)
- `packages/core-api/src/routes/captures.ts` (modify — 2 instances)
- `packages/core-api/src/routes/admin.ts` (modify — 1 instance)
- `packages/workers/src/skills/cost-analysis.ts` (modify — 1 instance)

**Description:**
Replace 5 `as any` assertions in production code with proper types. The DB result typing pattern (`rows.rows as any[]`) appears in 3 files — fix with Drizzle's `sql<Type>` template. Route parameter coercion uses `as any` for enum values — fix with explicit type narrowing.

**Tasks:**
1. [ ] `app.ts`: Replace `documentPipelineQueue as any` with proper Queue type import
2. [ ] `llm-gateway.ts`: Replace `rows.rows as any[]` with typed `sql<{column: type}>` query
3. [ ] `captures.ts`: Replace `query.capture_type as any` and `query.source as any` with Zod-inferred types from the schema
4. [ ] `admin.ts`: Replace `body.level as any` with const assertion or union type
5. [ ] `cost-analysis.ts`: Replace `rows.rows as any[]` with typed SQL template
6. [ ] Verify `pnpm -r typecheck` passes with no new errors

**Acceptance Criteria:**
- [ ] Zero `as any` in production TypeScript files (test files excluded)
- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm -r test` passes

---

### Phase 1 Testing Requirements

- [ ] `pnpm -r test` passes (all 1,569+ unit tests)
- [ ] `pnpm -r typecheck` passes
- [ ] Migration files sort correctly with no duplicate numbers

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] No regressions introduced
- [ ] Deploy to homeserver and verify workers start cleanly

---

## Phase 2: BaseSkill Abstract Class + Pilot Migrations

**Estimated Complexity:** M (~8 files, ~400 LOC)
**Dependencies:** None (can run in parallel with Phase 1)
**Parallelizable:** No — items are sequential

### Goals

- Extract a `BaseSkill<TInput, TResult>` abstract class with shared constructor logic, skills_log writing, and common utilities
- Create an `LLMSkill` subclass for LLM-heavy synthesis skills
- Migrate 3 pilot skills (one simple, one LLM, one agent-based) to validate the pattern
- Update skill-execution.ts dispatcher to work with both old and new patterns during migration

### Work Items

#### 2.1 Create BaseSkill Abstract Class
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Architectural Review F2
**Files Affected:**
- `packages/workers/src/skills/base-skill.ts` (create)
- `packages/workers/src/skills/types.ts` (create)

**Description:**
Create the abstract base class that all skills will extend. Based on investigation of all 27 skills, the universal dependencies are: `db: Database` (all 27), `pushover: PushoverService` (20/27), and a `logResult()` helper that writes to `skills_log` (all 27). The base class also provides `formatDuration()` and `truncate()` utilities used across many skills.

**Tasks:**
1. [ ] Create `types.ts` with `BaseResult` interface (`durationMs: number`, optional `notificationSent: boolean`), `BaseSkillOpts` interface
2. [ ] Create `base-skill.ts` with abstract `BaseSkill<TInput, TResult extends BaseResult>` class:
   - Protected properties: `db`, `pushover`, `skillName`
   - Constructor takes `skillName: string` + `BaseSkillOpts`
   - Abstract method: `execute(input: TInput): Promise<TResult>`
   - Protected `logResult(result, inputSummary, outputSummary?)` → inserts to `skills_log`
   - Protected `formatDuration(ms)`, `truncate(text, max)`
   - Protected `sendNotification(title, message, priority?)` → Pushover with error handling
3. [ ] Create `LLMSkill<TInput, TResult>` extending `BaseSkill`:
   - Additional properties: `llmGateway`, `anthropicClient`, `templates`, `promptsDir`, `coreApiUrl`
   - Constructor takes `LLMSkillOpts` extending `BaseSkillOpts`
   - Protected `renderTemplate(name, vars)` utility
4. [ ] Export all from `packages/workers/src/skills/index.ts`

**Acceptance Criteria:**
- [ ] `BaseSkill` compiles with `strict: true`
- [ ] `LLMSkill` extends `BaseSkill` correctly
- [ ] Type system enforces `execute()` return type includes `durationMs`
- [ ] Unit tests for `logResult()`, `formatDuration()`, `truncate()`, `sendNotification()`

---

#### 2.2 Migrate 3 Pilot Skills
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Architectural Review F2
**Files Affected:**
- `packages/workers/src/skills/capture-reminder.ts` (modify — simple skill pilot)
- `packages/workers/src/skills/daily-connections.ts` (modify — LLM skill pilot)
- `packages/workers/src/skills/daily-connections-query.ts` (no change — validates query separation pattern)
- `packages/workers/src/skills/wiki-ingest.ts` (modify — agent skill pilot)

**Description:**
Migrate one skill from each of the 3 main categories to validate the BaseSkill pattern works:
- **Simple:** `capture-reminder.ts` (159 lines, db + pushover only)
- **LLM Synthesis:** `daily-connections.ts` (491 lines, full LLM stack)
- **Agent-Based:** `wiki-ingest.ts` (502 lines, anthropic + wikiService)

Each migration: extend BaseSkill/LLMSkill, remove constructor boilerplate, replace inline skills_log insert with `this.logResult()`, replace inline Pushover calls with `this.sendNotification()`.

**Tasks:**
1. [ ] Migrate `capture-reminder.ts` → extends `BaseSkill`
2. [ ] Migrate `daily-connections.ts` → extends `LLMSkill`
3. [ ] Migrate `wiki-ingest.ts` → extends `BaseSkill` (agent skills use Anthropic directly, not LLMSkill)
4. [ ] Verify all 3 skill test files still pass without modification (backward-compatible entry point functions)
5. [ ] Verify `executeDailyConnections()` entry point still callable from skill-execution.ts

**Acceptance Criteria:**
- [ ] All 3 pilot skills extend BaseSkill or LLMSkill
- [ ] Constructor boilerplate removed from all 3
- [ ] Existing test suites pass unmodified
- [ ] `pnpm -r test` passes

**Notes:**
Keep the `execute<SkillName>(db, options, ...)` entry point function for backward compatibility with skill-execution.ts. Phase 3 will update the dispatcher after all skills are migrated.

---

#### 2.3 Update Skill-Execution Dispatcher
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Architectural Review F2
**Files Affected:**
- `packages/workers/src/jobs/skill-execution.ts` (modify)

**Description:**
Update the skill-execution BullMQ worker to support both old-style entry functions and new BaseSkill-based skills. During the Phase 2-3 migration period, both patterns coexist. After Phase 3, all skills use the base class.

**Tasks:**
1. [ ] Verify dispatcher still works with the 3 migrated pilot skills
2. [ ] Add a helper function `createAndExecuteSkill<T>(SkillClass, opts, input)` that instantiates and calls `execute()`
3. [ ] Update the 3 pilot skill cases to use the new helper
4. [ ] Verify remaining 24 skills still work via their old entry point functions
5. [ ] Add integration smoke test: dispatch each pilot skill via queue

**Acceptance Criteria:**
- [ ] All 27 skills dispatchable via skill-execution worker
- [ ] Pilot skills use new `createAndExecuteSkill()` path
- [ ] Remaining skills use existing entry point path
- [ ] `pnpm --filter @open-brain/workers test` passes

---

### Phase 2 Testing Requirements

- [ ] New `base-skill.test.ts` with unit tests for BaseSkill utilities
- [ ] All 3 pilot skill test suites pass unmodified
- [ ] `pnpm -r test` passes (no regressions)
- [ ] Skill-execution dispatcher handles both old and new patterns

### Phase 2 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] BaseSkill pattern validated with 3 different skill categories
- [ ] Deploy to homeserver, verify scheduled skills run correctly

---

## Phase 3: Complete Skill Migration

**Estimated Complexity:** M (~30 files, ~300 LOC net change — mostly deletions)
**Dependencies:** Phase 2 (BaseSkill validated)
**Parallelizable:** Yes — skill batches are independent

### Goals

- Migrate remaining 24 skills to use BaseSkill/LLMSkill
- Extract query files for skills with 2+ SQL queries (standardize F5 pattern)
- Update skill-execution dispatcher to use BaseSkill pattern exclusively

### Work Items

#### 3.1 Migrate Simple Skills (8 skills)
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Architectural Review F2, F5
**Files Affected:**
- `packages/workers/src/skills/capture-dedup-sweep.ts` (modify)
- `packages/workers/src/skills/container-health.ts` (modify)
- `packages/workers/src/skills/secret-rotation.ts` (modify)
- `packages/workers/src/skills/stale-captures.ts` (modify)
- `packages/workers/src/skills/db-backup.ts` (modify)
- `packages/workers/src/skills/wiki-backup.ts` (modify)
- `packages/workers/src/skills/redis-snapshot.ts` (modify)
- `packages/workers/src/skills/storage-audit.ts` (modify)

**Description:**
Mechanical migration: extend `BaseSkill`, remove constructor boilerplate, use `this.logResult()` and `this.sendNotification()`. These skills use db + pushover only (no LLM). Each migration is ~20 lines removed per file.

**Tasks:**
1. [ ] Migrate all 8 simple skills to extend `BaseSkill`
2. [ ] Extract `container-health-query.ts` (currently 3 SQL queries inline)
3. [ ] Extract `storage-audit-query.ts` (currently 4 SQL queries inline)
4. [ ] Run test suite for each: `pnpm --filter @open-brain/workers test -- --grep <skill-name>`

**Acceptance Criteria:**
- [ ] All 8 skills extend `BaseSkill`
- [ ] Zero constructor boilerplate duplication
- [ ] All existing tests pass

---

#### 3.2 Migrate LLM Synthesis Skills (6 skills)
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Architectural Review F2, F5
**Files Affected:**
- `packages/workers/src/skills/drift-monitor.ts` (modify)
- `packages/workers/src/skills/daily-sweep-skill.ts` (modify)
- `packages/workers/src/skills/weekly-brief.ts` (modify)
- `packages/workers/src/skills/memory-consolidation.ts` (modify)
- `packages/workers/src/skills/email-compose.ts` (modify)
- `packages/workers/src/skills/cost-analysis.ts` (modify)

**Description:**
Migrate to `LLMSkill`. These share the full LLM dependency stack: litellmClient, anthropicClient, llmGateway, templates, promptsDir, coreApiUrl. After migration, all constructor boilerplate lives in `LLMSkill`.

**Tasks:**
1. [ ] Migrate all 6 LLM skills to extend `LLMSkill`
2. [ ] Extract `daily-sweep-query.ts` from daily-sweep-skill.ts (5 SQL queries inline)
3. [ ] Extract `cost-analysis-query.ts` from cost-analysis.ts (4 SQL queries inline)
4. [ ] Extract `pipeline-health-query.ts` from pipeline-health.ts (3 SQL queries inline)
5. [ ] Run test suite for each skill

**Acceptance Criteria:**
- [ ] All 6 skills extend `LLMSkill`
- [ ] New query files created for skills with 2+ SQL queries
- [ ] All existing tests pass

---

#### 3.3 Migrate Agent & Specialized Skills (7 skills)
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Architectural Review F2, F5
**Files Affected:**
- `packages/workers/src/skills/monthly-reflection.ts` (modify)
- `packages/workers/src/skills/wiki-lint.ts` (modify)
- `packages/workers/src/skills/wiki-synthesis.ts` (modify)
- `packages/workers/src/skills/pipeline-health.ts` (modify)
- `packages/workers/src/skills/morning-brief.ts` (modify)
- `packages/workers/src/skills/morning-brief-query.ts` (create — extract queries from morning-brief)

**Description:**
Agent skills (monthly-reflection, wiki-lint) use Anthropic directly via `runAgent()`. Specialized skills (pipeline-health, morning-brief, wiki-synthesis) have unique dependency profiles. All extend `BaseSkill`. Extract morning-brief queries into a separate file (preparation for Phase 6 enhancement).

**Tasks:**
1. [ ] Migrate agent skills (monthly-reflection, wiki-lint) → extend `BaseSkill`
2. [ ] Migrate specialized skills (pipeline-health, wiki-synthesis, morning-brief) → extend `BaseSkill`
3. [ ] Create `morning-brief-query.ts` extracting all 4 query functions from morning-brief.ts
4. [ ] Run test suite for each skill

**Acceptance Criteria:**
- [ ] All 7 skills extend `BaseSkill`
- [ ] `morning-brief-query.ts` created with exported query functions
- [ ] All existing tests pass

---

#### 3.4 Finalize Skill-Execution Dispatcher
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Architectural Review F2
**Files Affected:**
- `packages/workers/src/jobs/skill-execution.ts` (modify)

**Description:**
Now that all 27 skills use BaseSkill, update the dispatcher to use the `createAndExecuteSkill()` pattern exclusively. Remove old-style entry point function calls. Update the switch/case for each skill to instantiate the class directly.

**Tasks:**
1. [ ] Convert all 27 skill dispatch cases to use `createAndExecuteSkill()`
2. [ ] Remove dead `execute<SkillName>()` entry point imports
3. [ ] Verify concurrency and rate limiting still work
4. [ ] Full test run: `pnpm --filter @open-brain/workers test`

**Acceptance Criteria:**
- [ ] All skills dispatched via BaseSkill pattern
- [ ] No legacy entry point function calls remain in dispatcher
- [ ] All tests pass
- [ ] Deploy to homeserver, verify all 19 scheduled skills run

---

### Phase 3 Testing Requirements

- [ ] All 132 test files pass
- [ ] `pnpm -r typecheck` passes
- [ ] Each migrated skill verified individually
- [ ] Deploy and monitor scheduled skills for 24 hours

### Phase 3 Completion Checklist

- [ ] All 27 skills extend BaseSkill or LLMSkill
- [ ] Query files standardized (8-10 new `*-query.ts` files)
- [ ] Dispatcher updated
- [ ] Deployed and running on homeserver

---

## Phase 4: Email Auth Clients & Schema

**Estimated Complexity:** M (~8 files, ~600 LOC)
**Dependencies:** Phase 1 (clean migration numbering)
**Parallelizable:** Yes — Hotmail and Gmail clients are independent

### Goals

- Implement Hotmail (Graph API) and Gmail API clients in TypeScript
- Create `email_classifications` Drizzle schema and migration
- Build the email classifier that dispatches T0 rules → T1 LLM

### Work Items

#### 4.1 Hotmail Client (MSAL + Graph API)
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Ultra Plan F11, email-pipeline.py HotmailBackend
**Files Affected:**
- `packages/shared/src/services/email/hotmail-client.ts` (create)
- `packages/shared/src/services/email/types.ts` (create)
- `packages/shared/package.json` (modify — add `@azure/msal-node`)

**Description:**
Port the Python `HotmailBackend` class to TypeScript. Uses MSAL for device code + cached token auth, Graph API for inbox fetch, folder management, and email moves. Token cache stored in `app_settings` table (not filesystem).

**Tasks:**
1. [ ] Add `@azure/msal-node` to shared package dependencies
2. [ ] Create `types.ts` with `EmailMessage`, `EmailFolder`, `EmailProvider`, `ClassifiedEmail` interfaces
3. [ ] Create `hotmail-client.ts` with:
   - `authenticate()` — MSAL token acquisition with cache in app_settings
   - `fetchInbox(sinceHours)` — Graph API `$filter` + `$select` + pagination
   - `listFolders()` → `setupFolders()` — create category folders under Inbox
   - `moveEmail(messageId, folderId)` — Graph API move
   - `cleanupSpam(maxAgeDays)` — trash old junk
   - `detectCorrections()` — detect manual user moves
4. [ ] Unit tests with mocked Graph API responses

**Acceptance Criteria:**
- [ ] HotmailClient compiles with strict TypeScript
- [ ] Token cache round-trips through app_settings table
- [ ] Unit tests cover auth, fetch, move, cleanup, correction detection
- [ ] Handles Graph API rate limits (429) with retry

**Notes:**
The MS_CLIENT_ID (`14d82eec-204b-4c2f-b7e8-296a70dab67e`) is a public client ID for device code flow — not a secret. Can be in code. Scopes: `Mail.ReadWrite`, `User.Read`.

---

#### 4.2 Gmail Client (OAuth + Gmail API)
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Ultra Plan F11, email-pipeline.py GmailBackend
**Files Affected:**
- `packages/shared/src/services/email/gmail-client.ts` (create)
- `packages/shared/package.json` (modify — add `google-auth-library`, `googleapis`)

**Description:**
Port the Python `GmailBackend` class to TypeScript. Uses OAuth for auth, Gmail API for inbox fetch, label management, and email labeling. Credentials stored in app_settings (not filesystem).

**Tasks:**
1. [ ] Add `google-auth-library`, `googleapis` to shared package dependencies
2. [ ] Create `gmail-client.ts` with:
   - `authenticate()` — OAuth flow with token cache in app_settings
   - `fetchInbox(sinceHours)` — Gmail API query with `in:inbox after:{date}`
   - `listLabels()` → `setupLabels()` — create missing labels
   - `labelEmail(messageId, labelId)` — modify message (add label, remove INBOX)
   - `cleanupSpam(maxAgeDays)` — trash old spam
   - `detectCorrections()` — detect manual label changes
3. [ ] Unit tests with mocked Gmail API responses

**Acceptance Criteria:**
- [ ] GmailClient compiles with strict TypeScript
- [ ] Token cache round-trips through app_settings table
- [ ] Unit tests cover auth, fetch, label, cleanup, correction detection

**Notes:**
Gmail OAuth token refresh: Google tokens have a 7-day expiry in testing mode. Evaluate Composio for Gmail if token management becomes burdensome (A31).

---

#### 4.3 Email Classifications Schema
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Ultra Plan D95, Entry 049
**Files Affected:**
- `packages/shared/src/schema/email-classifications.ts` (create)
- `packages/shared/src/schema/index.ts` (modify — export new table)
- `packages/shared/drizzle/0020_email_classifications.sql` (create)

**Description:**
Create Postgres table to replace the Python pipeline's SQLite. Same columns, better home. Includes indexes for the morning brief queries (overnight emails by category).

**Tasks:**
1. [ ] Create Drizzle schema: `email_classifications` table with columns:
   - `id` (uuid PK), `message_id` (text, unique per provider), `provider` (text: hotmail|gmail)
   - `sender` (text), `subject` (text), `category` (text), `confidence` (numeric)
   - `tier` (text: sender|keyword|jetson|manual), `folder_id` (text)
   - `processed_at` (timestamptz), `moved` (boolean)
2. [ ] Create `email_corrections` table: `message_id`, `provider`, `old_category`, `new_category`, `detected_at`
3. [ ] Create `email_daily_summaries` table: `date` (PK), `email_count`, `categories_json` (jsonb), `summary_text`, `posted_to_brain` (boolean)
4. [ ] Add indexes: `(provider, processed_at)`, `(category, processed_at)` for morning brief queries
5. [ ] Generate migration SQL file `0020_email_classifications.sql`
6. [ ] Add `email_classification` key to VALID_SETTINGS_KEYS in `settings.ts` (for auth token storage)

**Acceptance Criteria:**
- [ ] Migration applies cleanly on fresh and existing databases
- [ ] Schema exported from `@open-brain/shared`
- [ ] Indexes support efficient overnight-by-category queries

---

#### 4.4 Email Classifier Service
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Ultra Plan F11, email-categories.yaml, cost-tiering architecture
**Files Affected:**
- `packages/shared/src/services/email/email-classifier.ts` (create)
- `packages/shared/src/services/index.ts` (modify — export)
- `config/ai-routing.yaml` (modify — add `email_classification` task)

**Description:**
Port the Python `classify_email()` function chain to TypeScript. Three tiers: T0 sender rules → T0 keyword rules → T1 Jetson LLM (via LLMGatewayService). Loads rules from `email-categories.yaml`. Classification result includes category, confidence, and tier name.

**Tasks:**
1. [ ] Create `email-classifier.ts` with:
   - `loadRules(configPath)` — parse email-categories.yaml
   - `classifyBySender(email, senderRules)` — exact email or domain suffix match, confidence 1.0
   - `classifyByKeyword(email, keywordRules)` — subject keyword match, confidence `min(0.5 + 0.15 * hits, 0.9)`
   - `classifyByLLM(email, llmGateway, categories)` — LLMGateway `completeByTask('email_classification', ...)` with JSON response parsing
   - `classifyEmail(email, rules, llmGateway?)` — tiered dispatcher returning `{category, confidence, tier}`
2. [ ] Handle LLM response quirks: markdown code blocks, `<think>` tags (copied from Python)
3. [ ] Add `email_classification` task to `ai-routing.yaml` → routes to `t1_jetson` with fallback to `t1_spark`
4. [ ] Unit tests with mock rules and mock LLM responses

**Acceptance Criteria:**
- [ ] T0 sender rules match Python behavior (domain suffix matching)
- [ ] T0 keyword rules match Python behavior (confidence formula)
- [ ] T1 LLM classification routes through LLMGatewayService (cost-tracked)
- [ ] Auto-move threshold configurable (default 0.85)
- [ ] All tests pass

---

### Phase 4 Testing Requirements

- [ ] Unit tests for HotmailClient, GmailClient, EmailClassifier
- [ ] Migration applies on fresh DB and existing homeserver DB
- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm -r test` passes

### Phase 4 Completion Checklist

- [ ] All work items complete
- [ ] Auth clients tested with mocked API responses
- [ ] Schema deployed to homeserver Postgres
- [ ] Classifier matches Python behavior for sender + keyword rules

---

## Phase 5: Email Pipeline Skill

**Estimated Complexity:** M (~6 files, ~500 LOC)
**Dependencies:** Phase 2 (BaseSkill), Phase 4 (auth clients + schema + classifier)
**Parallelizable:** No — sequential build on Phase 4

### Goals

- Create the `EmailClassifySkill` that replaces `email-pipeline.py`
- Register as BullMQ scheduled job (5 AM daily)
- Validate against live Hotmail + Gmail with parallel Python comparison

### Work Items

#### 5.1 EmailClassifySkill Implementation
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Ultra Plan F11, D94, D96
**Files Affected:**
- `packages/workers/src/skills/email-classify.ts` (create)
- `packages/workers/src/skills/email-classify-query.ts` (create)

**Description:**
Main skill class extending `BaseSkill`. Orchestrates: fetch emails → classify → organize (move to folders/labels) → detect corrections → generate daily summary → post to Open Brain captures API. Replaces Python `run_pipeline()` + `generate_daily_summary()`.

**Tasks:**
1. [ ] Create `EmailClassifySkill` extending `BaseSkill`:
   - Constructor takes: `db`, `pushover`, `hotmailClient`, `gmailClient`, `classifier`, `llmGateway`
   - `execute(input: {providers, sinceHours, dryRun})` → `EmailClassifyResult`
   - Private methods: `processProvider()`, `organizeEmails()`, `generateSummary()`
2. [ ] Create `email-classify-query.ts` with:
   - `isProcessed(db, messageId)` — check if already classified
   - `recordClassification(db, ...)` — insert to email_classifications
   - `recordCorrection(db, ...)` — insert to email_corrections
   - `getOvernightSummary(db, since)` — aggregated category counts for morning brief
   - `getDailySummary(db, date)` — for daily digest generation
3. [ ] Daily summary uses `claude --print` (T2 CLI, subscription-covered) or `llmGateway.completeByTask('synthesis', ...)` for synthesis
4. [ ] Post summary capture to Open Brain via internal API call (not HTTP)
5. [ ] Unit tests with mocked clients and DB

**Acceptance Criteria:**
- [ ] Skill processes both Hotmail and Gmail in one run
- [ ] Classified emails stored in `email_classifications` table
- [ ] Daily summary posted as capture with `source: 'email'`
- [ ] Respects auto_move_threshold (0.85) from config
- [ ] "Needs Review" category for low-confidence emails
- [ ] All tests pass

---

#### 5.2 Register in Scheduler
**Status: COMPLETE [2026-04-16]**
**Requirement Refs:** Ultra Plan F11
**Files Affected:**
- `packages/workers/src/scheduler.ts` (modify)
- `packages/workers/src/jobs/skill-execution.ts` (modify)

**Description:**
Register `email-classify` as BullMQ repeatable job at 5:00 AM daily. Add dispatch case in skill-execution worker. Configure with `sinceHours: 24` for daily sweep.

**Tasks:**
1. [ ] Add `email-classify` to scheduler at `0 5 * * *` with stable jobId `scheduled_email-classify`
2. [ ] Add dispatch case in skill-execution.ts: instantiate `EmailClassifySkill` with auth clients
3. [ ] Pass Graph API + Gmail tokens from app_settings at skill instantiation time
4. [ ] Update JSDoc comment block in scheduler.ts

**Acceptance Criteria:**
- [ ] Job registered on worker startup
- [ ] Dispatches correctly via skill-execution worker
- [ ] `pnpm --filter @open-brain/workers test` passes

---

#### 5.3 Parallel Validation with Python Pipeline
**Status: PENDING**
**Requirement Refs:** Ultra Plan risk assessment
**Files Affected:**
- No code changes — operational validation

**Description:**
Run both TypeScript (homeserver) and Python (VM) email pipelines for 1 week. Compare: same emails classified? Same categories? Same move behavior? The Python pipeline runs at 5 AM on the VM; the TypeScript pipeline runs at 5 AM on homeserver. Both should produce identical classifications.

**Tasks:**
1. [ ] Deploy Phase 5 to homeserver (docker compose build + up)
2. [ ] Keep Python pipeline running on VM (same 5 AM cron)
3. [ ] After first run: compare `email_classifications` (Postgres) vs `processed_emails` (SQLite) for same date
4. [ ] Check: same message_ids processed? Same categories? Same tier assignments?
5. [ ] Monitor for 7 days. Log discrepancies.
6. [ ] If match rate > 95%: proceed to Phase 7 (disable Python pipeline)

**Acceptance Criteria:**
- [ ] TypeScript pipeline classifies same emails as Python pipeline
- [ ] Category agreement > 95% for T0 rules (should be 100% — deterministic)
- [ ] T1 LLM classifications within reasonable variance (same model, same prompt)
- [ ] Daily summaries posted to Open Brain from TypeScript pipeline
- [ ] No auth token expiry issues during 7-day validation

**Notes:**
MSAL tokens have long refresh windows. Gmail OAuth tokens in testing mode expire after 7 days — this validation period will test the refresh flow.

---

### Phase 5 Testing Requirements

- [ ] Unit tests for EmailClassifySkill
- [ ] Integration test: classify sample emails against real config
- [ ] Parallel validation running for 7 days
- [ ] `pnpm -r test` passes

### Phase 5 Completion Checklist

- [ ] Email-classify skill deployed and running at 5 AM daily
- [ ] Python pipeline still running in parallel for validation
- [ ] Classification results accumulating in Postgres
- [ ] No auth token issues after 7 days

---

## Phase 6: Morning Brief Enhancement

**Estimated Complexity:** M (~5 files, ~300 LOC)
**Dependencies:** Phase 5 (email classifications in Postgres)
**Parallelizable:** Yes — email triage and Slack delivery are independent

### Goals

- Add email triage section to morning brief (query Postgres, no LLM — free)
- Add Slack DM delivery alongside existing Pushover
- Add reference calendars (Ashley's, SCARS) to Composio integration

### Work Items

#### 6.1 Email Triage Section
**Status: PENDING**
**Requirement Refs:** Ultra Plan D95, Entry 049
**Files Affected:**
- `packages/workers/src/skills/morning-brief.ts` (modify)
- `packages/workers/src/skills/morning-brief-query.ts` (modify — add email queries)

**Description:**
Add a new section to the morning brief: "OVERNIGHT EMAIL." Queries `email_classifications` for emails processed since previous brief, grouped by priority categories (Financial & Banking, Work & Office, People [Jamie, Ashley], Account & Security). Shows count + top subjects per category. Non-priority categories show only count.

**Tasks:**
1. [ ] Add `queryOvernightEmail(db, since)` to morning-brief-query.ts:
   - Priority categories: Financial, Work, People (Jamie/Ashley), Account & Security
   - Returns: `{category, count, topSubjects: string[]}[]`
2. [ ] Add `EmailTriageItem` to MorningBriefResult interface
3. [ ] Add email triage section to `formatMessage()` — between schedule and yesterday's thread
4. [ ] Handle case where email-classify hasn't run yet (empty table = skip section)
5. [ ] Update skills_log output_summary to include email counts

**Acceptance Criteria:**
- [ ] Morning brief includes email triage section when data exists
- [ ] Section is omitted gracefully when no email data
- [ ] Priority categories shown with subjects; others shown as count only
- [ ] Zero LLM cost for this section

---

#### 6.2 Slack DM Delivery
**Status: PENDING**
**Requirement Refs:** Ultra Plan A51
**Files Affected:**
- `packages/workers/src/skills/morning-brief.ts` (modify)
- `packages/shared/src/services/slack-messenger.ts` (create or extend existing)

**Description:**
Send the morning brief to a configurable Slack DM channel in addition to Pushover. Use Slack Block Kit for rich formatting (headers, sections, bullet lists). The Slack bot token is already in the environment (`SLACK_BOT_TOKEN`).

**Tasks:**
1. [ ] Create or extend a `SlackMessenger` service that sends formatted messages via `chat.postMessage`
2. [ ] Format morning brief sections using Slack Block Kit (header blocks, section blocks, markdown)
3. [ ] Add `slackChannelId` to morning brief config (app_settings or env var)
4. [ ] Send both Pushover (push alert) AND Slack DM (rich format)
5. [ ] Handle Slack send failures gracefully (log, don't fail the skill)

**Acceptance Criteria:**
- [ ] Morning brief delivered to Slack DM with formatted sections
- [ ] Pushover notification still works (not replaced)
- [ ] Slack delivery failure doesn't prevent skills_log entry
- [ ] Channel ID configurable via settings

---

#### 6.3 Reference Calendars
**Status: PENDING**
**Requirement Refs:** OpenClaw morning brief analysis
**Files Affected:**
- `packages/workers/src/skills/morning-brief.ts` (modify)

**Description:**
The existing `fetchCalendarEvents()` function skips certain calendars. Add a "Reference Calendars" section that fetches Ashley's Calendar and SCARS calendar separately, displayed after the main schedule. These are view-only (not Troy's events).

**Tasks:**
1. [ ] Add `REFERENCE_CALENDARS` set: `["ashley davis", "scars"]` (matched by lowercase calendar name)
2. [ ] Modify `fetchCalendarEvents()` to return two arrays: primary events and reference events
3. [ ] Add reference calendar section to `formatMessage()` after schedule section
4. [ ] Format: grouped by calendar name with event summaries

**Acceptance Criteria:**
- [ ] Reference calendars shown separately from Troy's schedule
- [ ] "No events today" for empty reference calendars (not omitted)
- [ ] Calendar fetch failure handled gracefully per-calendar

---

### Phase 6 Testing Requirements

- [ ] Unit tests for email triage query
- [ ] Unit tests for Slack message formatting
- [ ] Morning brief test suite updated for new sections
- [ ] `pnpm -r test` passes

### Phase 6 Completion Checklist

- [ ] Morning brief includes email triage, Slack delivery, reference calendars
- [ ] Deployed to homeserver and verified on next 7:15 AM run
- [ ] Pushover + Slack both deliver successfully
- [ ] Email section shows real classification data from Phase 5

---

## Phase 7: Infrastructure Consolidation

**Estimated Complexity:** S (~3 files + ops, ~50 LOC)
**Dependencies:** Phase 6 (morning brief validated with email data)
**Parallelizable:** No — operational sequence

### Goals

- Migrate VM backup scripts to homeserver cron
- Disable Python email pipeline on VM
- Disable OpenClaw morning brief on Bond
- Document decommission status

### Work Items

#### 7.1 Migrate Backup Scripts to Homeserver
**Status: PENDING**
**Requirement Refs:** Ultra Plan A52, Entry 049
**Files Affected:**
- Homeserver crontab (modify)

**Description:**
The VM runs 3 backup scripts at 2 AM via cron (db-backup, wiki-backup, redis-snapshot). These SSH into the homeserver and run Docker commands. Simpler: run directly on homeserver via `docker exec`.

**Tasks:**
1. [ ] Create homeserver cron entries:
   - `0 2 * * * docker exec open-brain-postgres pg_dump -U openbrain openbrain | gzip > /mnt/user/appdata/open-brain/backups/db-$(date +%Y%m%d).sql.gz`
   - `15 2 * * * docker exec open-brain-redis redis-cli BGSAVE`
   - `30 2 * * * tar czf /mnt/user/appdata/open-brain/backups/wiki-$(date +%Y%m%d).tar.gz -C /mnt/user/appdata/open-brain wiki/`
2. [ ] Add backup rotation (keep last 14 days)
3. [ ] Verify backups produce valid files
4. [ ] Disable VM backup cron: `ssh claude@obvm.k4jda.net 'crontab -e'` → comment out 3 backup lines

**Acceptance Criteria:**
- [ ] Homeserver backups run at 2 AM and produce valid files
- [ ] Old backups rotated (keep 14 days)
- [ ] VM backup cron disabled

---

#### 7.2 Disable Python Email Pipeline on VM
**Status: PENDING**
**Requirement Refs:** Ultra Plan D94
**Files Affected:**
- VM crontab (modify)

**Description:**
After 7-day parallel validation (Phase 5.3) confirms TypeScript pipeline matches Python, disable the Python pipeline cron on the VM.

**Tasks:**
1. [ ] SSH to VM: `ssh claude@obvm.k4jda.net`
2. [ ] Comment out email pipeline cron line (don't delete — keep as documentation)
3. [ ] Comment out synthetic health check cron (covered by container-health skill + Cloudflare Worker)
4. [ ] Verify: `crontab -l` shows all Open Brain entries commented out
5. [ ] Keep VM running but idle (available for ad-hoc Python work)

**Acceptance Criteria:**
- [ ] No Open Brain cron jobs running on VM
- [ ] TypeScript email-classify skill is the sole email processor
- [ ] VM stays accessible but has no scheduled Open Brain work

---

#### 7.3 Disable OpenClaw Morning Brief
**Status: PENDING**
**Requirement Refs:** Ultra Plan D94, Entry 049
**Files Affected:**
- Bond OpenClaw cron config (modify)

**Description:**
The OpenClaw morning brief on Bond (7 AM, Sonnet) is now fully replaced by Open Brain's enhanced morning brief (7:15 AM, no LLM + Composio for calendar). Disable it to avoid duplicate morning messages. Also disable the daily-usage-report (replaced by Open Brain cost-analysis skill).

**Tasks:**
1. [ ] SSH to Bond: `ssh claude@bond.k4jda.net`
2. [ ] Disable OpenClaw morning-brief cron job
3. [ ] Disable OpenClaw daily-usage-report cron job
4. [ ] Keep OpenClaw backup jobs (OpenClaw-specific, not our concern)
5. [ ] Verify: only OpenClaw backup jobs remain active

**Acceptance Criteria:**
- [ ] No duplicate morning briefs
- [ ] No duplicate cost reports
- [ ] OpenClaw backup jobs unaffected

**Notes:**
This requires access to davistroy's OpenClaw config on Bond. May need Troy to disable manually if claude user lacks permissions. The system cron morning-brief at `/etc/cron.d/morning-brief` should also be disabled.

---

### Phase 7 Testing Requirements

- [ ] Homeserver backups produce valid files for 3 consecutive days
- [ ] No email pipeline runs on VM after disable
- [ ] Morning brief arrives once (from Open Brain only)

### Phase 7 Completion Checklist

- [ ] Backups running on homeserver
- [ ] VM email pipeline disabled
- [ ] OpenClaw morning brief disabled
- [ ] Bond daily-usage-report disabled
- [ ] System runs for 1 week with no issues

---

## Phase 8: Quality & UI Decomposition

**Estimated Complexity:** M (~12 files, ~600 LOC)
**Dependencies:** None (fully independent — can run in parallel with Phase 4+)
**Parallelizable:** Yes — UI and testing items are independent

### Goals

- Decompose large UI page components into focused section components
- Add integration tests for critical paths (search, entities, MCP)

### Work Items

#### 8.1 Decompose Settings.tsx
**Status: PENDING**
**Requirement Refs:** Architectural Review F4
**Files Affected:**
- `packages/web/src/pages/Settings.tsx` (modify — reduce from 1,377 lines)
- `packages/web/src/components/settings/` (create directory + 5-6 components)

**Description:**
Extract the 11 sections of Settings.tsx into focused components. Priority extractions (largest/most complex): EmailAllowlistSection, TriggersSection, AIRoutingSection, DangerZoneSection. Keep state management in parent; pass callbacks as props.

**Tasks:**
1. [ ] Create `packages/web/src/components/settings/` directory
2. [ ] Extract `EmailAllowlistSection.tsx` (manages allowlist CRUD)
3. [ ] Extract `TriggersSection.tsx` (trigger management)
4. [ ] Extract `AIRoutingSection.tsx` (model routing display)
5. [ ] Extract `AutonomyLevelSection.tsx` (autonomy slider)
6. [ ] Extract `DangerZoneSection.tsx` (destructive actions)
7. [ ] Settings.tsx becomes orchestrator (~300 lines): state + layout + imports

**Acceptance Criteria:**
- [ ] Settings.tsx under 400 lines
- [ ] Each extracted component is self-contained with typed props
- [ ] All Settings page functionality preserved (test in browser)
- [ ] No console errors

---

#### 8.2 Decompose System.tsx
**Status: PENDING**
**Requirement Refs:** Architectural Review F4
**Files Affected:**
- `packages/web/src/pages/System.tsx` (modify — reduce from 1,352 lines)
- `packages/web/src/components/system/` (create directory + 5 components)

**Description:**
Extract the 5 tab-based sections into focused components. Each tab becomes its own component: QueuesTab, SkillsTab, FlowsTab, InfrastructureTab, McpActivityTab.

**Tasks:**
1. [ ] Create `packages/web/src/components/system/` directory
2. [ ] Extract `QueuesTab.tsx` (job queue statistics)
3. [ ] Extract `SkillsTab.tsx` (skill execution logs — largest section)
4. [ ] Extract `FlowsTab.tsx` (pipeline flow visualization)
5. [ ] Extract `InfrastructureTab.tsx` (container health, backups, cost)
6. [ ] System.tsx becomes tab router (~200 lines)

**Acceptance Criteria:**
- [ ] System.tsx under 300 lines
- [ ] Each tab component is independently testable
- [ ] All System page functionality preserved (test in browser)

---

#### 8.3 Integration Tests: Search & Entities
**Status: PENDING**
**Requirement Refs:** Architectural Review F6
**Files Affected:**
- `packages/core-api/src/__tests__/integration/search.test.ts` (create)
- `packages/core-api/src/__tests__/integration/entities.test.ts` (create)

**Description:**
Add integration tests that exercise real Postgres with pgvector. Search tests validate the hybrid FTS+vector+RRF pipeline. Entity tests validate resolution, linking, and the entity graph.

**Tasks:**
1. [ ] Create `search.test.ts`: insert captures with embeddings, test hybrid search, FTS-only, vector-only, RRF ranking, temporal decay
2. [ ] Create `entities.test.ts`: insert entities, test resolution, linking, mention counts, canonical name handling
3. [ ] Use existing `initTestDatabase()` and test Postgres setup from `vitest.config.integration.ts`
4. [ ] Include edge cases: empty results, single result, max results

**Acceptance Criteria:**
- [ ] Search integration tests cover hybrid, FTS-only, and vector-only modes
- [ ] Entity tests cover resolution, linking, and graph queries
- [ ] All integration tests pass: `pnpm --filter @open-brain/core-api exec vitest run --config vitest.config.integration.ts`

---

#### 8.4 Integration Tests: MCP Tools
**Status: PENDING**
**Requirement Refs:** Architectural Review F6
**Files Affected:**
- `packages/core-api/src/__tests__/integration/mcp-tools.test.ts` (create)

**Description:**
Add integration tests for MCP tool execution against real Postgres. Test the 8 MCP tools: search_brain, list_captures, brain_stats, capture_thought, get_entity, list_entities, get_weekly_brief, get_capture.

**Tasks:**
1. [ ] Create `mcp-tools.test.ts` with real DB setup
2. [ ] Test each MCP tool with valid input and verify response shape
3. [ ] Test error cases (invalid IDs, empty results)
4. [ ] Verify MCP response format matches Streamable HTTP expectations

**Acceptance Criteria:**
- [ ] All 8 MCP tools tested against real Postgres
- [ ] Response shapes match TypeScript interfaces
- [ ] Error cases handled correctly (404, validation errors)

---

### Phase 8 Testing Requirements

- [ ] UI pages load correctly in browser after decomposition
- [ ] All new integration tests pass
- [ ] Existing unit tests unaffected
- [ ] `pnpm -r test` passes

### Phase 8 Completion Checklist

- [ ] Settings.tsx and System.tsx decomposed
- [ ] 4 new integration test files
- [ ] All tests passing
- [ ] Browser verification of UI functionality

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Phase 1 (all items) | Phase 2 (all items) | Foundation cleanup and BaseSkill design are independent |
| Phase 3 | Phase 4 | Skill migration and email auth clients touch different files |
| Phase 8 (all items) | Phase 4, 5, 6, 7 | UI decomposition and testing are fully independent of email pipeline |
| 8.1 (Settings) | 8.2 (System) | Different pages, different component directories |
| 8.3 (Search tests) | 8.4 (MCP tests) | Different test files |
| 6.1 (Email triage) | 6.2 (Slack delivery) | Different sections of morning-brief |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| MSAL token cache migration fails | Medium | High | Keep Python pipeline on VM as fallback for 7 days (Phase 5.3) |
| Gmail OAuth token expires during validation | Medium | Medium | Evaluate Composio for Gmail if token management is burdensome (A31) |
| BaseSkill migration breaks scheduled skills | Low | High | Migrate 3 pilots first (Phase 2.2), validate on homeserver before full migration |
| Skill-execution dispatcher regression | Low | High | Both old and new dispatch patterns coexist during Phase 2-3 |
| UI decomposition breaks page functionality | Low | Medium | Test each extraction in browser before committing |
| Graph API rate limiting during bulk classification | Low | Low | API_DELAY (100ms between requests) + retry on 429 |
| Bond OpenClaw config inaccessible to claude user | Medium | Low | Troy disables manually if SSH permissions insufficient |

---

## Success Metrics

- [ ] All 8 phases completed
- [ ] All acceptance criteria met
- [ ] Zero `as any` in production TypeScript
- [ ] All 27 skills extend BaseSkill (zero constructor boilerplate duplication)
- [ ] Email pipeline runs as TypeScript BullMQ worker on homeserver (no VM dependency)
- [ ] Morning brief includes email triage, calendar, Slack delivery
- [ ] VM has no Open Brain cron jobs (decommission-ready)
- [ ] OpenClaw morning brief disabled (no duplicate briefs)
- [ ] Settings.tsx < 400 lines, System.tsx < 300 lines
- [ ] 4+ new integration test files covering search, entities, MCP
- [ ] `pnpm -r test` passes with 1,600+ tests (up from 1,569)
- [ ] Monthly API cost unchanged (email classification routes to T1 Jetson, not paid API)

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| Fix migration numbering conflicts | Arch Review F3 | 1 | 1.1 |
| Stagger scheduler overlap | Arch Review F10 | 1 | 1.2 |
| Clean `as any` from production | Arch Review F7 | 1 | 1.3 |
| Extract BaseSkill abstract class | Arch Review F2 | 2 | 2.1 |
| Pilot skill migrations (3 skills) | Arch Review F2 | 2 | 2.2 |
| Update skill-execution dispatcher | Arch Review F2 | 2 | 2.3 |
| Migrate simple skills (8) | Arch Review F2 | 3 | 3.1 |
| Migrate LLM synthesis skills (6) | Arch Review F2 | 3 | 3.2 |
| Migrate agent & specialized skills (7) | Arch Review F2, F5 | 3 | 3.3 |
| Finalize dispatcher | Arch Review F2 | 3 | 3.4 |
| Hotmail Graph API client | Ultra Plan F11 | 4 | 4.1 |
| Gmail API client | Ultra Plan F11 | 4 | 4.2 |
| Email classifications schema | Ultra Plan D95 | 4 | 4.3 |
| Email classifier service | Ultra Plan F11 | 4 | 4.4 |
| EmailClassifySkill implementation | Ultra Plan F11, D94 | 5 | 5.1 |
| Register in scheduler | Ultra Plan F11 | 5 | 5.2 |
| Parallel validation with Python | Risk mitigation | 5 | 5.3 |
| Morning brief email triage | Ultra Plan D95, Entry 049 | 6 | 6.1 |
| Slack DM delivery | Ultra Plan A51 | 6 | 6.2 |
| Reference calendars | OpenClaw morning brief | 6 | 6.3 |
| Backup migration to homeserver | Ultra Plan A52 | 7 | 7.1 |
| Disable Python email pipeline | Ultra Plan D94 | 7 | 7.2 |
| Disable OpenClaw morning brief | Ultra Plan D94 | 7 | 7.3 |
| Decompose Settings.tsx | Arch Review F4 | 8 | 8.1 |
| Decompose System.tsx | Arch Review F4 | 8 | 8.2 |
| Integration tests: search & entities | Arch Review F6 | 8 | 8.3 |
| Integration tests: MCP tools | Arch Review F6 | 8 | 8.4 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-04-16 16:30:00*
*Source: /create-plan command (from Ultra Plan architectural assessment)*
