# Implementation Plan — Phase 7: Architectural Consolidation

**Generated:** 2026-03-30
**Based On:** `/review-arch` audit + deep investigation by 4 parallel agents
**Total Phases:** 5 (Phase 26-30, continuing from IMPLEMENTATION_PLAN-PHASE6.md Phase 25)
**Estimated Total Effort:** ~800 LOC across ~25 files

---

## Context

The `/review-arch` audit identified 14 findings across 6 dimensions. Deep investigation corrected several findings and revealed 4 root causes. This plan addresses those root causes with integrated changes that reinforce the architecture rather than patching individual symptoms.

### Key Corrections from Investigation

| Original Finding | Investigation Result |
|------------------|---------------------|
| F10: EmbeddingService has no tests | **WRONG** — 284 lines of tests exist in `core-api/__tests__/embedding-service.test.ts`. Only minor gap: no explicit 2560->768 truncation test. |
| F3/F4: 8 god modules need splitting | **OVERBLOWN** — 6 of 8 are well-structured (cohesive classes, clean strategy pattern, linear orchestration). Only 4 files actually need splitting. |
| F6: One blocking readFileSync | **BROADER** — Root cause is `loadPromptTemplate()` in shared using `readFileSync`. Affects `llm-gateway.ts` (high-frequency) + 4 other callers. |
| F7: Inconsistent error handling | **MORE NUANCED** — Individual handlers are consistent. Real gaps: missing safety net in dispatch layer + double-fault risk in catch blocks. |

### Root Causes

| ID | Root Cause | Findings | Impact |
|----|-----------|----------|--------|
| RC1 | `@open-brain/shared` is schema-only, not a full shared utilities layer | F1, F2, F12 | Logger x3 duplication, Pushover x2, LLM client x7, env defaults diverge |
| RC2 | `loadPromptTemplate()` is synchronous by design | F6 | Every prompt read blocks event loop — llm-gateway (high freq), extract-entities (per capture) |
| RC3 | `routes/skills.ts` contains business logic (mutable state, file I/O, raw SQL) | F5 | 441 LOC route file with module-level mutable state |
| RC4 | Entity resolution duplicated with divergent implementations | F3 (partial) | extract-entities uses indexed SQL (efficient); link-entities loads all into memory (scaling risk) |

### Change Interaction Map

```
RC1 (shared utilities) ──MUST COME FIRST──> RC2 (template caching, part of shared)
                                          > RC3 (skills service imports shared logger)
                                          > RC4 (entity resolver imports shared HttpError)
                                          > Phase 29 (slack-bot imports shared types)
                                          > Phase 30 (workers startup uses shared validation)

RC3 (skills service extraction) ──INDEPENDENT OF──> RC4 (entity resolver)
RC3 ──INDEPENDENT OF──> Phase 29 (slack-bot changes)

F8 (CI Node version) ──FULLY INDEPENDENT──> everything
F14 (pg-notify reconnect) ──INDEPENDENT OF──> everything except shared logger (RC1)
```

### Files Left Alone (investigated, found well-structured)

These were flagged as god modules but investigation confirmed they're cohesive:
- `workers/src/skills/pipeline-health.ts` (494) — single class, linear orchestration
- `workers/src/services/document-parser.ts` (421) — clean strategy pattern already
- `workers/src/jobs/document-pipeline.ts` (417) — orchestration that delegates
- `workers/src/skills/drift-monitor.ts` (394) — already decomposed (query logic extracted)
- `workers/src/jobs/budget-check.ts` (387) — single job, linear flow
- `slack-bot/src/lib/formatters.ts` (398) — flat collection of pure functions

---

## Phase 26: Foundation — Expand @open-brain/shared (RC1 + RC2)

**Estimated Complexity:** M (~8 files created, ~6 files modified, ~400 LOC)
**Dependencies:** None — this is the foundation for all subsequent phases
**Risk:** Medium — touching shared package requires rebuilding all consumers

### Goals

- Eliminate cross-package utility duplication
- Add template caching to fix blocking reads on hot paths
- Standardize env var defaults and API key validation
- Move `pino` and `openai` deps to shared, remove from consumers

### Work Items

#### 26.1 Create shared logger factory

**New file:** `packages/shared/src/lib/logger.ts`
```typescript
export function createLogger(name?: string): pino.Logger
export const logger: pino.Logger  // default instance
```
- Combines the 3 identical logger.ts files into one
- Adds optional `name` parameter for service identification
- Includes pino-pretty dev transport (missing from voice-capture's inline loggers)

**Files to delete after migration:**
- `packages/workers/src/lib/logger.ts`
- `packages/slack-bot/src/lib/logger.ts`
- `packages/core-api/src/lib/logger.ts`

**Files to update (change imports):**
- All files in workers, slack-bot, core-api that import from `../lib/logger.js`
- All 5 voice-capture service files that create inline pino instances

#### 26.2 Create shared LiteLLM client factory

**New file:** `packages/shared/src/services/litellm-client.ts`
```typescript
export type LiteLLMTimeoutTier = 'fast' | 'standard' | 'extended'
export function createLiteLLMClient(opts?: {
  baseUrl?: string       // default: env LITELLM_URL ?? 'https://llm.k4jda.net'
  apiKey?: string        // default: env LITELLM_API_KEY
  timeout?: LiteLLMTimeoutTier | number  // fast=30s, standard=60s, extended=120s
  maxRetries?: number    // default: SDK default; set 0 for BullMQ-managed jobs
}): OpenAI | null        // returns null if apiKey is empty (caller decides behavior)
```
- Consolidates 7 OpenAI SDK instantiations
- Returns `null` when API key is empty — callers check and disable features (following core-api governance engine pattern)
- Standardizes LITELLM_URL default to `'https://llm.k4jda.net'` everywhere (workers currently defaults to `'http://localhost:4000'` — wrong for Docker)
- `openai` dependency moves to shared `package.json` (already there for EmbeddingService)

**Files to update:**
- `shared/src/services/embedding.ts` — use factory instead of direct `new OpenAI()`
- `core-api/src/services/llm-gateway.ts` — use factory
- `workers/src/jobs/extract-entities.ts` — use factory
- `workers/src/skills/weekly-brief.ts` — use factory with `timeout: 'extended'`
- `workers/src/skills/drift-monitor.ts` — use factory with `timeout: 'extended'`
- `workers/src/skills/daily-connections.ts` — use factory with `timeout: 'extended'`
- `voice-capture/src/services/classification.ts` — use factory with `timeout: 'fast'`

#### 26.3 Create shared PushoverService

**New file:** `packages/shared/src/services/pushover.ts`
```typescript
export class PushoverService {
  constructor(config?: {
    appToken?: string    // default: env PUSHOVER_APP_TOKEN
    userKey?: string     // default: env PUSHOVER_USER_KEY
    onError?: 'throw' | 'swallow'  // throw for BullMQ retry; swallow for non-critical
  })
  get isConfigured(): boolean
  send(opts: { title: string; message: string; priority?: -2|-1|0|1|2; retry?: number; expire?: number }): Promise<void>
}
```
- `onError` parameter resolves the throw-vs-swallow divergence
- Standardizes env var names to `PUSHOVER_APP_TOKEN` / `PUSHOVER_USER_KEY`
- Includes emergency priority support (retry/expire) from workers version

**Files to delete after migration:**
- `packages/workers/src/services/pushover.ts`
- `packages/voice-capture/src/services/notification.ts`

**Files to update:**
- `workers/src/main.ts` — instantiate shared PushoverService with `onError: 'throw'`
- `workers/src/skills/*.ts` — import from shared
- `voice-capture/src/server.ts` — instantiate with `onError: 'swallow'`, keep `notifyCaptureSuccess()` as local convenience wrapper

#### 26.4 Create shared HTTP helpers

**New file:** `packages/shared/src/utils/fetch-helpers.ts`
```typescript
export class HttpError extends Error {
  readonly status: number
  readonly body: string
}
export async function readErrorBody(res: Response): Promise<string>
export async function assertOk(res: Response, context?: string): Promise<void>
```
- Small utility (~30 LOC) that standardizes the `if (!res.ok)` pattern across 12 callsites
- Callers who want to swallow use `try/catch` around `assertOk()`
- `HttpError.status` enables callers to branch on 4xx vs 5xx for retry decisions

#### 26.5 Add template caching to prompt-template.ts (fixes F6 — blocking reads)

**Modified file:** `packages/shared/src/lib/prompt-template.ts`

Add a `TemplateCache` that loads templates from disk once and serves from a `Map`:
```typescript
export class TemplateCache {
  constructor(promptsDir: string)
  get(templateName: string): string           // throws if not found
  render(templateName: string, vars: Record<string, string>): string
  preload(...names: string[]): void           // optional warm-up at startup
  invalidate(): void                          // for hot-reload in dev
}
```
- Existing `loadPromptTemplate()` and `renderPromptTemplate()` remain for backward compat
- New `TemplateCache` is the recommended path — load once at startup, serve from memory
- Eliminates ALL disk I/O on hot paths (llm-gateway, extract-entities, skills)
- `readFileSync` at cache-miss time is acceptable (happens once, at startup or first access)

**Files to update:**
- `core-api/src/services/llm-gateway.ts` — accept TemplateCache in constructor, use `cache.render()`
- `core-api/src/services/governance-engine.ts` — accept TemplateCache in constructor
- `workers/src/jobs/extract-entities.ts` — accept TemplateCache from worker factory, remove readFileSync at line 264
- `workers/src/skills/weekly-brief.ts` — accept TemplateCache
- `workers/src/skills/drift-monitor.ts` — accept TemplateCache
- `workers/src/skills/daily-connections.ts` — accept TemplateCache
- `core-api/src/index.ts` — create TemplateCache(promptsDir), pass to services
- `workers/src/main.ts` — create TemplateCache(promptsDir), pass to worker factories

#### 26.6 Update shared barrel exports and dependency management

**Modified files:**
- `packages/shared/src/index.ts` — add exports for logger, litellm-client, pushover, fetch-helpers, TemplateCache
- `packages/shared/src/lib/index.ts` — add logger, TemplateCache exports
- `packages/shared/src/services/index.ts` — add litellm-client, pushover exports
- `packages/shared/src/utils/index.ts` — add fetch-helpers exports
- `packages/shared/package.json` — add `pino` + `pino-pretty` (devDependency) deps
- Remove `pino` from workers, slack-bot, core-api, voice-capture package.json
- Remove `pino-pretty` from slack-bot package.json

### Verification

1. `pnpm --filter @open-brain/shared build` — shared package builds
2. `pnpm build` — all packages build (import paths work)
3. `pnpm test` — all 1,407 unit tests pass
4. Grep for `readFileSync` in non-test, non-config-loader files — should find zero in hot paths
5. Grep for `new OpenAI(` — should only appear in shared/services/litellm-client.ts and shared/services/embedding.ts
6. Grep for duplicate logger files — workers/lib/logger.ts, slack-bot/lib/logger.ts, core-api/lib/logger.ts should not exist

---

## Phase 27: Core-API Decomposition (RC3)

**Estimated Complexity:** S-M (~3 files created, ~2 files modified, ~150 LOC)
**Dependencies:** Phase 26 (uses shared logger)
**Risk:** Low — extracting business logic from route to service

### Goals

- Remove mutable module-level state, file I/O, raw SQL, and YAML parsing from routes/skills.ts
- Create a proper SkillConfigService in the service layer

### Work Items

#### 27.1 Extract SkillConfigService from routes/skills.ts

**New file:** `packages/core-api/src/services/skill-config.ts` (~180 LOC)

Move from skills.ts:
- `SkillConfig` interface (line 47-50)
- `DEFAULT_SKILLS` constant (lines 56-73)
- `KNOWN_SKILLS` mutable state (line 79) → becomes private class field
- `skillsYamlPath` mutable state (line 82) → becomes constructor param
- `loadSkillsFromYaml()` (lines 115-153)
- `saveSkillsToYaml()` (lines 159-179)
- `validateCronExpression()` (lines 185-204)
- `SkillsYamlData` type alias

New class:
```typescript
export class SkillConfigService {
  constructor(yamlPath: string)
  load(): void
  save(): void
  getAll(): Map<string, SkillConfig>
  get(name: string): SkillConfig | undefined
  update(name: string, patch: Partial<SkillConfig>): SkillConfig
  validateCron(expression: string): { valid: boolean; error?: string }
}
```

**New file:** `packages/core-api/src/services/skill-log.ts` (~50 LOC)

Move from skills.ts:
- `SkillsLogRow`, `SkillsLogDetailRow` type aliases
- The `DISTINCT ON` raw SQL query (lines 228-238) → `getLatestRunPerSkill(db): Promise<SkillsLogRow[]>`
- The log query (lines 329-363) → `getLogsForSkill(db, name, limit): Promise<SkillsLogDetailRow[]>`

#### 27.2 Slim down routes/skills.ts

**Modified file:** `packages/core-api/src/routes/skills.ts` — drops from 441 to ~180 LOC

Routes become thin HTTP handlers:
- `GET /skills` → `skillConfig.getAll()` + `skillLog.getLatestRunPerSkill()` + merge
- `POST /skills/:name/trigger` → validate name via `skillConfig.get()`, enqueue job
- `GET /skills/:name/logs` → `skillLog.getLogsForSkill()`
- `PATCH /skills/:name` → `skillConfig.update()` + `skillConfig.save()`

No more: `readFileSync`, `writeFileSync`, `existsSync`, `mkdirSync`, mutable module state, raw SQL, YAML parsing, cron-parser import.

#### 27.3 Wire SkillConfigService into app factory

**Modified file:** `packages/core-api/src/index.ts`
- Create `SkillConfigService` at startup
- Pass to `createApp()` via AppDependencies

**Modified file:** `packages/core-api/src/app.ts`
- Accept `SkillConfigService` in AppDependencies
- Pass to `registerSkillRoutes()`

### Verification

1. `pnpm --filter @open-brain/core-api build` — builds clean
2. `pnpm --filter @open-brain/core-api test` — all core-api tests pass
3. Skills routes tests specifically: existing tests should pass without modification (they test HTTP behavior, not internals)
4. Manual: `GET /api/v1/skills`, `PATCH /api/v1/skills/weekly-brief` work correctly

---

## Phase 28: Workers Decomposition (RC4 + F6 hot-path fix)

**Estimated Complexity:** M (~2 files created, ~3 files modified, ~200 LOC)
**Dependencies:** Phase 26 (uses shared TemplateCache, entity types)
**Risk:** Medium — changing entity resolution logic in link-entities.ts from in-memory to SQL

### Goals

- Eliminate duplicated entity resolution between extract-entities.ts and link-entities.ts
- Fix link-entities.ts scaling issue (loads all entities into memory)
- Complete the readFileSync fix in extract-entities.ts via TemplateCache (started in Phase 26)

### Work Items

#### 28.1 Create shared entity-resolver.ts

**New file:** `packages/workers/src/lib/entity-resolver.ts` (~120 LOC)

Extract from `extract-entities.ts` (the indexed SQL version — more efficient):
- `resolveOrCreateEntity(db, name, entityType): Promise<string>` — 3-tier resolution: exact name match → alias match → create new
- `linkEntityToCapture(db, entityId, captureId, relationship, confidence): Promise<void>`
- `ENTITY_TYPE_MAP: Record<string, string>`

Extract from `link-entities.ts`:
- `upsertEntityRelationship(db, idA, idB): Promise<void>` — co-occurrence graph
- `dedup(items: string[]): string[]` — case-insensitive dedup

#### 28.2 Update extract-entities.ts to use shared resolver

**Modified file:** `packages/workers/src/jobs/extract-entities.ts`
- Remove `resolveOrCreateEntity()`, `linkEntityToCapture()`, `ENTITY_TYPE_MAP` (moved to entity-resolver.ts)
- Import from `../lib/entity-resolver.js`
- Remove `readFileSync` / `existsSync` imports — template now comes from TemplateCache (Phase 26.5)
- `parseEntityResponse()` stays (LLM output parsing, specific to this job)

#### 28.3 Update link-entities.ts to use shared resolver

**Modified file:** `packages/workers/src/pipeline/stages/link-entities.ts`
- Remove `resolveOrCreateEntityForStage()` (the in-memory version) — replaced by shared `resolveOrCreateEntity()` (indexed SQL)
- Remove `upsertEntityLink()` — replaced by shared `linkEntityToCapture()`
- Remove `dedup()` — moved to entity-resolver.ts
- Keep `upsertEntityRelationship()` import from shared
- Keep `processLinkEntitiesStage()` orchestration

**Key behavioral change:** link-entities.ts switches from loading all entities of a type into memory and filtering in JS to using indexed SQL queries per entity. This fixes the scaling risk and aligns both callers on the same resolution strategy.

### Verification

1. `pnpm --filter @open-brain/workers build` — builds clean
2. `pnpm --filter @open-brain/workers test` — all worker tests pass
3. Specifically verify: `extract-entities.test.ts`, `link-entities.test.ts`, `check-triggers.test.ts`
4. Integration test: ingest a capture end-to-end, verify entities are created and linked correctly
5. Grep for `readFileSync` in extract-entities.ts — should be gone

---

## Phase 29: Slack-bot Improvements

**Estimated Complexity:** S-M (~2 files created, ~3 files modified, ~150 LOC)
**Dependencies:** Phase 26 (uses shared logger)
**Risk:** Low — splitting existing code along clean boundaries, adding safety wrapper

### Goals

- Split capture handler into text-capture and voice-capture flows
- Extract type definitions from core-api-client.ts
- Add error safety net to dispatch layer

### Work Items

#### 29.1 Split capture handler

**New file:** `packages/slack-bot/src/handlers/voice-capture.ts` (~270 LOC)

Move from `capture.ts`:
- `SlackFile`, `VoiceCaptureResponse` types (lines 31-57)
- `findAudioFile()`, `hasAudioAttachment()`, `downloadSlackFile()`, `postToVoiceCapture()`, `ensureAudioExtension()`, `formatVoiceCaptureReply()` (lines 107-224)
- `handleAudioCapture()` (lines 343-450)

**Modified file:** `packages/slack-bot/src/handlers/capture.ts` — drops from 450 to ~180 LOC
- Keeps `handleCapture()` (text capture flow) and `pollForCompletion()`
- Imports and delegates to `handleAudioCapture()` from voice-capture.ts

#### 29.2 Extract types from core-api-client.ts

**New file:** `packages/slack-bot/src/lib/core-api-types.ts` (~190 LOC)

Move all 18 interface/type definitions from core-api-client.ts lines 8-189.

**Modified file:** `packages/slack-bot/src/lib/core-api-client.ts` — drops from 453 to ~260 LOC
- Imports types from core-api-types.ts
- Class methods unchanged

#### 29.3 Add safeHandle error wrapper

**New file or addition to:** `packages/slack-bot/src/lib/safe-handle.ts` (~20 LOC)
```typescript
export async function safeHandle(
  fn: () => Promise<void>,
  say: SayFn,
  threadTs?: string
): Promise<void> {
  try { await fn() }
  catch (err) {
    logger.error({ err }, 'Unhandled handler error')
    try { await say({ text: formatError('Something went wrong', err), thread_ts: threadTs }) }
    catch { /* swallow double-fault */ }
  }
}
```

**Modified file:** `packages/slack-bot/src/server.ts`
- Wrap the top-level message handler in `safeHandle()` — catches `intentRouter.classify()` failures, Redis errors, and any unhandled handler throws
- User gets error feedback instead of silent failure

**Modified file:** `packages/slack-bot/src/handlers/command.ts`
- Wrap `handleCommand()` dispatch in `safeHandle()` — catches `parseCommand()` throws

### Verification

1. `pnpm --filter @open-brain/slack-bot build` — builds clean
2. `pnpm --filter @open-brain/slack-bot test` — all slack-bot tests pass
3. Specifically: `command-handler.test.ts`, `capture-handler.test.ts`, `intent-router.test.ts`
4. Grep for `handleAudioCapture` — should only exist in voice-capture.ts (definition) and capture.ts (import)

---

## Phase 30: Infrastructure Fixes (F8, F14, F12 startup validation)

**Estimated Complexity:** S (~4 files modified, ~80 LOC)
**Dependencies:** Phase 26 (uses shared logger for pg-notify)
**Risk:** Low — small, independent changes

### Goals

- Fix pg-notify silent death with reconnection logic
- Align CI Node version with Docker
- Add startup validation for LITELLM_API_KEY in workers and voice-capture

### Work Items

#### 30.1 Add pg-notify reconnection

**Modified file:** `packages/core-api/src/lib/pg-notify.ts`

Add reconnection with exponential backoff:
```typescript
private async scheduleReconnect(postgresUrl: string): Promise<void> {
  const delays = [1000, 2000, 5000, 10000, 30000]  // 1s, 2s, 5s, 10s, 30s max
  for (const delay of delays) {
    await new Promise(r => setTimeout(r, delay))
    try {
      this.client = new pg.Client({ connectionString: postgresUrl })
      await this.client.connect()
      // Re-register LISTEN channels
      for (const channel of this.channels) {
        await this.client.query(`LISTEN ${channel}`)
      }
      this.client.on('notification', this.handleNotification)
      this.client.on('error', (err) => {
        logger.error({ err }, 'pgNotify connection error — scheduling reconnect')
        this.client = null
        this.scheduleReconnect(postgresUrl)
      })
      logger.info('pgNotify reconnected successfully')
      return
    } catch (err) {
      logger.warn({ err, delay }, 'pgNotify reconnection attempt failed')
    }
  }
  logger.error('pgNotify reconnection exhausted — SSE events will not work until container restart')
}
```

Key changes:
- Track subscribed channel names in `this.channels: Set<string>`
- On error: set `this.client = null`, call `scheduleReconnect()`
- Remove the `if (this.client) return` guard in `start()` that prevents restart
- Re-issue all `LISTEN` commands after reconnect

#### 30.2 Update CI to Node 22

**Modified file:** `.github/workflows/ci.yml`
- Change `node-version: '20'` to `node-version: '22'`

**Modified file:** `package.json`
- Change `"node": ">=20"` to `"node": ">=22"` in engines

#### 30.3 Add LITELLM_API_KEY startup validation

**Modified file:** `packages/workers/src/main.ts`
After reading `LITELLM_API_KEY`, add:
```typescript
if (!litellmApiKey) {
  logger.warn('LITELLM_API_KEY not set — embedding, entity extraction, and skill execution will fail')
}
```
Follow core-api pattern: warn at startup, don't crash. Workers still start (BullMQ retries provide resilience for transient key loading delays).

**Modified file:** `packages/voice-capture/src/server.ts` (or classification.ts)
Same pattern: log warning at startup if key is empty.

### Verification

1. `pnpm build` — all packages build
2. `pnpm test` — all tests pass
3. pg-notify: stop and restart Postgres container while core-api is running — verify SSE reconnects and events resume
4. CI: push to a branch — verify CI uses Node 22
5. Workers: start without LITELLM_API_KEY — verify startup warning is logged

---

## Phase Summary Table

| Phase | Focus | Key Deliverables | Est. Size | Dependencies |
|-------|-------|-----------------|-----------|--------------|
| 26 | Shared utilities expansion (RC1+RC2) | Logger factory, LiteLLM client factory, PushoverService, HTTP helpers, TemplateCache | M (~400 LOC) | None |
| 27 | Core-API skills decomposition (RC3) | SkillConfigService, SkillLogService, slim route handlers | S-M (~150 LOC) | Phase 26 |
| 28 | Workers entity resolver (RC4) | Shared entity-resolver.ts, fix link-entities scaling | M (~200 LOC) | Phase 26 |
| 29 | Slack-bot improvements | Voice-capture split, types extraction, safeHandle wrapper | S-M (~150 LOC) | Phase 26 |
| 30 | Infrastructure fixes | pg-notify reconnection, CI Node 22, API key startup validation | S (~80 LOC) | Phase 26 |

Phases 27-30 can be executed in parallel after Phase 26 completes (they are independent of each other).

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Shared package change breaks consumers | Medium | High | Build all packages after each shared change. Run full test suite. |
| Entity resolver behavior change causes regression | Low | Medium | link-entities already has tests. Run integration tests with real captures. |
| pg-notify reconnection logic has edge cases | Low | Medium | Test with real Postgres restart. Add reconnection state logging. |
| pnpm dependency hoisting changes after moving deps | Low | Low | Run `pnpm install --frozen-lockfile` after changes. Fix any resolution issues. |

## Verification Strategy (End-to-End)

After all 5 phases:
1. `pnpm build` — all packages build clean
2. `pnpm test` — all 1,407+ unit tests pass
3. `pnpm test:integration` — all integration tests pass
4. `docker compose build` — all container images build
5. Deploy to homeserver — all 9 containers healthy
6. Ingest a test capture — full pipeline completes (classify, embed, extract, link, notify)
7. Search the capture — hybrid search returns it
8. Restart Postgres container — verify SSE reconnects within 30 seconds
9. Grep audit:
   - `readFileSync` in hot paths → zero (only at startup/cache-miss)
   - `new OpenAI(` outside shared → zero
   - Duplicate logger files → zero
   - `PUSHOVER_TOKEN` (old env var name) → zero
