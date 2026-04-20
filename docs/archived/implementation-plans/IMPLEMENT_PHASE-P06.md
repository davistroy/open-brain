# IMPLEMENT_PHASE-P06 — Cognitive memory producer + schedule

**Source card:** PHASED_PLAN.md § P06
**Tracks issue:** #109 (Theme 7 full close)
**Effort estimate:** ~2 days
**Branch (Gate 2 will create):** `feat/phase-P06-cognitive-memory-producer`
**Gate 5 path:** operator-approval required — touches search hot path (user-visible regression risk) + scheduler cron slot

---

## Investigation findings

### Current state of search path (core-api)

Two entry points both complete without any post-search side-effect hook today:

**`packages/core-api/src/routes/search.ts` (lines 36–108)**
- `GET /api/v1/search` — calls `searchService.search()` OR `searchService.searchWithRelated()` depending on `include_related`, then immediately `c.json(...)`. No hook.
- `POST /api/v1/search` — same, dual sub-paths based on `body.include_related`. No hook.

Producer insertion point is AFTER the search call resolves and BEFORE `return c.json(...)` in all four sub-paths (GET×2 + POST×2).

**`packages/core-api/src/mcp/tools/search-brain.ts` (lines 39–91)**
`searchBrainTool()` always calls `searchService.searchWithRelated()` (include_related=true by default per schema line 13). Only one enqueue site in this file.

**Shared search logic:** Both paths call `searchService.searchWithRelated()` / `searchService.search()`. There is NO shared post-search hook in `SearchService`. The producer must be wired at both call sites independently (clean — keep it explicit, don't refactor into a shared helper).

**Queue threading (core-api wiring):**
```
core-api/src/index.ts
  → new Queue('access-stats', {connection})   [NEW]
  → createApp({ ..., accessStatsQueue })       [NEW arg]
  → registerSearchRoutes(app, searchService, accessStatsQueue)  [NEW arg]
  → mountMcpServer(app, { ..., accessStatsQueue })              [NEW arg]
```

`bullmq` is already in `core-api/package.json` (used in `app.ts` line 4) — no new dependency.

### Current state of update-access-stats job

**File:** `packages/workers/src/jobs/update-access-stats.ts` (213 lines)

Current logic:
- `processAccessStatsJob()` lines 76–110 — takes `{captureIds, accessedAt}`; does (1) batch `UPDATE captures SET access_count+1` via `inArray()` — already batched, (2) calls `upsertCoAccessAssociations()` for all pairs — **loops serially**.
- `upsertCoAccessAssociations()` lines 34–63 — loops `for (const [idA, idB] of pairs)` with `db.insert().values(...).onConflictDoUpdate(...)`. **This is the 45-statement source: C(10,2) = 45 pairs = 45 individual INSERTs.**
- `generateCanonicalPairs()` lines 16–26 — pure, already tested, enforces `a < b`.
- `pruneStaleAssociations()` lines 178–212 — **already fully implemented** in TypeScript using `db.delete().where(and(lt(weight, 0.1), lt(last_co_access, 90_days_ago)))`. No SQL function needed.
- `createAccessStatsWorker()` lines 116–140 — already registered in `main.ts`.

**Job payload shape (existing):** `interface AccessStatsJobData { captureIds: string[]; accessedAt: string }` — the card's suggested `{ capture_ids, search_query?, timestamp }` is NOT the current shape. Implementation uses the existing `AccessStatsJobData`; do NOT change the interface.

### Current scheduler + memory-consolidation cron

**`packages/workers/src/scheduler.ts` — Sunday schedule audit:**
- `0 3 * * 0` — **storage-audit (ALREADY TAKEN, line 348)**
- `0 4 * * 0` — memory-consolidation (line 177)
- `0 5 * * 0` — wiki-lint (line 253)

**CRON COLLISION RESOLUTION:** Card specifies `0 3 * * 0`. Use **`30 3 * * 0` (03:30 Sundays)** — still staggered before memory-consolidation at 04:00, runs 30 min after `storage-audit` starts (disk-size check typically completes in seconds).

### BullMQ queue shape

**Name:** `'access-stats'` — already exists in `packages/workers/src/queues/access-stats.ts`. Core-api instantiates its own `new Queue('access-stats', { connection })` — same name string, same Redis, no cross-package code import (workers `AccessStatsJobData` type is inlined in core-api as `{captureIds: string[]; accessedAt: string}`).

**Redis connection:** Existing `redisConnection` object in `core-api/src/index.ts` lines 44–51.

### D26 reference

`LAB_NOTEBOOK.md` line 38: "D26 — Hebbian co-access tracking pairs top-10 results only; active 2026-04-09; Entry 019; alternatives All pairs (N^2 explosion), top-5 (insufficient signal)". Top-10 cap already enforced in worker via `MAX_PAIR_RESULTS = 10`. Enqueue passes `results.slice(0, 10).map(r => r.capture.id!)`.

**Design call on empty searches:** Enqueue only when `results.length >= 1`. Empty-result searches would enqueue zero-payload jobs that the worker returns early from — redundant.

### Integration test pattern

Existing integration infrastructure:
- `packages/workers/src/__tests__/integration/pipeline.test.ts` — real Redis + real Postgres via `docker-compose.test.yml`.
- `waitForJobState()` polls `queue.getJob(jobId).getState()` until target or timeout.
- `initTestDatabase()`, `teardownTestDatabase()`, `getTestDb()`, `cleanDatabase()`, `createTestCapture()` helpers all exist.

**Pattern for P06:** **Simpler alternative preferred** — call `processAccessStatsJob(payload, realDb)` directly with real Postgres and assert DB state. BullMQ plumbing is already E2E-tested by `pipeline.test.ts`; the new test focuses on the batch-UPSERT correctness + canonical pair ordering + second-call accumulation.

---

## Work items

### 1.1 — Producer: instantiate access-stats queue in core-api + thread through app

**File: `packages/core-api/src/index.ts`**

After existing `ingestProcessQueue` creation (around line 77):
```typescript
const accessStatsQueue = new Queue<{ captureIds: string[]; accessedAt: string }>(
  'access-stats',
  { connection: redisConnection },
)
```
Ensure `Queue` is imported from `bullmq`.

Add to graceful shutdown cleanup block (around line 204):
```typescript
accessStatsQueue.close(),
```

Pass `accessStatsQueue` into `createApp({...})`.

**File: `packages/core-api/src/app.ts`**

Add to `AppDependencies` interface:
```typescript
/** Access-stats BullMQ queue — fire-and-forget after search completion */
accessStatsQueue?: Queue<{ captureIds: string[]; accessedAt: string }>
```

Thread into `registerSearchRoutes(app, searchService, accessStatsQueue)` call.
Thread into `mountMcpServer(app, { ..., accessStatsQueue })`.

### 1.2 — Producer: enqueue access-stats on HTTP search completion

**File: `packages/core-api/src/routes/search.ts`**

Update signature:
```typescript
export function registerSearchRoutes(
  app: Hono,
  searchService: SearchService,
  accessStatsQueue?: Queue<{ captureIds: string[]; accessedAt: string }>,
): void
```

For each of the 4 sub-paths (GET include_related=true, GET include_related=false, POST include_related=true, POST include_related=false), insert BEFORE `return c.json(...)`:
```typescript
if (accessStatsQueue && /* results.length >= 1 */) {
  const captureIds = /* top-10 ids */.slice(0, 10)
  accessStatsQueue.add('access-stats', {
    captureIds,
    accessedAt: new Date().toISOString(),
  }).catch(() => { /* fire-and-forget — search response never blocks on Redis */ })
}
```

For `searchWithRelated` paths, `results` is `response.results`. For `search` paths, `results` is the flat array. Map `.capture.id!` for `SearchResult`, `.id!` for plain capture rows.

**DO NOT extract to a shared helper.** Keep inline and explicit for traceability (4 enqueue sites, all near their `return c.json`).

### 1.3 — Producer: enqueue access-stats on MCP search completion

**File: `packages/core-api/src/mcp/server.ts`**
Add `accessStatsQueue?` to `McpServerDeps`.
Thread to `registerMcpTools({ ..., accessStatsQueue })`.

**File: `packages/core-api/src/mcp/tools/index.ts`**
Add `accessStatsQueue?` to `RegisterToolsDeps`.
Pass to `searchBrainTool(input, searchService, accessStatsQueue)` call site.

**File: `packages/core-api/src/mcp/tools/search-brain.ts`**
Signature:
```typescript
export async function searchBrainTool(
  input: SearchBrainInput,
  searchService: SearchService,
  accessStatsQueue?: Queue<{ captureIds: string[]; accessedAt: string }>,
): Promise<string>
```

After `const response = await searchService.searchWithRelated(...)` (~line 44), before building `lines[]`:
```typescript
if (accessStatsQueue && response.results.length > 0) {
  const captureIds = response.results.slice(0, 10).map(r => r.capture.id!)
  accessStatsQueue.add('access-stats', {
    captureIds,
    accessedAt: new Date().toISOString(),
  }).catch(() => { /* fire-and-forget */ })
}
```

### 1.4 — Consumer: batch UPSERT in update-access-stats job

**File: `packages/workers/src/jobs/update-access-stats.ts`**

Replace the for-loop body of `upsertCoAccessAssociations()` with ONE batch `db.execute(sql`INSERT ... VALUES (…), (…) ON CONFLICT ... DO UPDATE …`)`:

```typescript
export async function upsertCoAccessAssociations(
  pairs: Array<[string, string]>,
  accessedAt: string,
  db: Database,
): Promise<number> {
  if (pairs.length === 0) return 0

  const accessedAtDate = new Date(accessedAt)
  const valueFragments = pairs.map(([idA, idB]) =>
    sql`(${idA}::uuid, ${idB}::uuid, 1, 1.0, ${accessedAtDate})`
  )
  const valuesClause = sql.join(valueFragments, sql`, `)

  await db.execute(sql`
    INSERT INTO capture_associations
      (capture_id_a, capture_id_b, co_access_count, weight, last_co_access)
    VALUES ${valuesClause}
    ON CONFLICT (capture_id_a, capture_id_b) DO UPDATE SET
      co_access_count = capture_associations.co_access_count + 1,
      last_co_access  = EXCLUDED.last_co_access,
      weight          = (capture_associations.co_access_count + 1)
                        * exp(-0.005
                          * EXTRACT(EPOCH FROM (
                              EXCLUDED.last_co_access - capture_associations.last_co_access
                            )) / 3600.0)
  `)

  return pairs.length
}
```

45 serial INSERTs → 1 batch `INSERT ... VALUES`. Access_count UPDATE is unchanged (already batched).

**Unit test update required:** `packages/workers/src/__tests__/update-access-stats.test.ts` currently asserts `db.insert` called N times for `upsertCoAccessAssociations` and `processAccessStatsJob`. Change those assertions to `db.execute` called once with an SQL fragment. `generateCanonicalPairs` tests are pure-function — no change.

### 1.5 — Schedule: weekly pruneStaleAssociations

**File: `packages/workers/src/scheduler.ts`**

Add new repeatable job (cron `30 3 * * 0`):
```typescript
const pruneAssociationsCron = '30 3 * * 0'

const pruneAssociationsQueue = new Queue<{ triggeredAt: string }>(
  'prune-associations',
  {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 10 },
    },
  },
)

await pruneAssociationsQueue.add(
  'prune-associations',
  { triggeredAt: new Date().toISOString() },
  {
    repeat: { pattern: pruneAssociationsCron },
    jobId: 'prune-associations-recurring',
  },
)

logger.info({ cron: pruneAssociationsCron }, '[scheduler] prune-associations repeatable job registered')
```

Add `pruneAssociations: Queue<{ triggeredAt: string }>` to `ScheduledQueues` interface. Return it from `registerScheduledJobs()`.

**File: `packages/workers/src/jobs/update-access-stats.ts` — add worker factory:**
```typescript
export function createPruneAssociationsWorker(
  connection: ConnectionOptions,
  db: Database,
): Worker<{ triggeredAt: string }> {
  const worker = new Worker<{ triggeredAt: string }>(
    'prune-associations',
    async (_job) => { await pruneStaleAssociations(db) },
    { connection, concurrency: 1 },
  )
  worker.on('failed', (job, err) => {
    logger.warn({ jobId: job?.id, err: err.message }, 'prune-associations job failed')
  })
  return worker
}
```

**File: `packages/workers/src/main.ts`:**
```typescript
import { createAccessStatsWorker, createPruneAssociationsWorker } from './jobs/update-access-stats.js'
...
workers.push(createPruneAssociationsWorker(connection, db))
```
Include `pruneAssociations` queue in the shutdown close loop.

### 1.6 — Integration test

**New file:** `packages/workers/src/__tests__/integration/access-stats-e2e.test.ts`

Simple pattern (direct function call, real DB — BullMQ E2E already covered by pipeline.test.ts):

```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { eq, and, inArray } from 'drizzle-orm'
import { captures, captureAssociations } from '@open-brain/shared'
import { initTestDatabase, teardownTestDatabase, getTestDb } from './setup.js'
import { cleanDatabase, createTestCapture } from './helpers.js'
import { processAccessStatsJob } from '../../jobs/update-access-stats.js'

beforeAll(async () => { await initTestDatabase() })
afterAll(async () => { await teardownTestDatabase() })
beforeEach(async () => { await cleanDatabase() })

describe('access-stats integration', () => {
  it('populates access_count and capture_associations with canonical ordering', async () => {
    const db = getTestDb()
    const c1 = await createTestCapture({ content: 'Access test A' })
    const c2 = await createTestCapture({ content: 'Access test B' })
    const captureIds = [c1.id as string, c2.id as string]
    const accessedAt = new Date().toISOString()

    await processAccessStatsJob({ captureIds, accessedAt }, db)

    // access_count incremented for both
    const rows = await db.select({ id: captures.id, access_count: captures.access_count })
      .from(captures).where(inArray(captures.id, captureIds))
    for (const r of rows) expect(r.access_count).toBeGreaterThanOrEqual(1)

    // capture_associations: canonical (a < b) ordering
    const [idA, idB] = captureIds[0] < captureIds[1]
      ? [captureIds[0], captureIds[1]]
      : [captureIds[1], captureIds[0]]
    const [assoc] = await db.select().from(captureAssociations)
      .where(and(
        eq(captureAssociations.capture_id_a, idA),
        eq(captureAssociations.capture_id_b, idB),
      ))
    expect(assoc).toBeDefined()
    expect(assoc.co_access_count).toBe(1)
    expect(Number(assoc.weight)).toBeCloseTo(1.0)

    // Second call: co_access_count should increment, weight recomputed
    await processAccessStatsJob({ captureIds, accessedAt: new Date().toISOString() }, db)
    const [assoc2] = await db.select({ co_access_count: captureAssociations.co_access_count })
      .from(captureAssociations)
      .where(and(
        eq(captureAssociations.capture_id_a, idA),
        eq(captureAssociations.capture_id_b, idB),
      ))
    expect(assoc2.co_access_count).toBe(2)
  })
})
```

### 1.7 — LAB_NOTEBOOK Entry 100

Pre-action entry:
```markdown
## Entry 100 — P06: Cognitive memory producer + schedule

**Date:** 2026-04-19
**Phase:** P06 (ORCHESTRATOR.md gate 3)
**Tags:** [workers] [core-api] [cognitive-memory] [bullmq] [scheduler]
**Environment:** laptop (Windows / bash); target = homeserver core-api + workers containers
**Duration:** (fill on completion)

### Objective
Wire Hebbian co-access producer into both search paths (HTTP route + MCP tool), convert 45 serial pair INSERTs to single batch UPSERT, and schedule weekly pruneStaleAssociations at 03:30 Sundays (slotted between storage-audit at 03:00 and memory-consolidation at 04:00). Activates the idle capture_associations table from migrations 0011/0012 (dormant since 2026-04-09).

### Hypothesis
After P06, every search returning ≥1 result fires an access-stats job. After the job processes: captures.access_count is incremented, capture_associations rows are created/updated for all top-10 result pairs (canonical a < b ordering enforced by generateCanonicalPairs), and the Hebbian association boost in SearchService begins providing signal. The batch UPSERT (1 db.execute per job) is measurably faster than 45 serial statements at scale. P24 (spreading activation quality tuning) becomes unblockable after 4 weeks of accumulated data.

### Rollback plan
`git revert <P06 merge sha>` — no schema change (tables pre-exist from 0011/0012). Producer removal stops new jobs from being enqueued; existing association data is preserved but becomes stale. Prune schedule removal is one block delete in scheduler.ts. Search response behavior reverts to no side-effects. Safe without maintenance window.

### Result
(fill on completion)
```

Commit after tests pass as the final commit in the series.

---

## Acceptance criteria (Gate 4 reviewer verifies)

- [ ] HTTP `GET /api/v1/search` and `POST /api/v1/search` produce access-stats jobs on completion (both include_related paths). Enqueue when `results.length >= 1`.
- [ ] MCP `search_brain` tool produces access-stats jobs on completion when `response.results.length >= 1`.
- [ ] `access_count` incremented for returned capture IDs (integration test asserts real DB).
- [ ] `capture_associations` populated on search, canonical ordering (`a < b`) verified (integration test asserts).
- [ ] `update-access-stats.ts` `upsertCoAccessAssociations` uses exactly 1 `db.execute(sql\`INSERT...\`)` call — grep confirms no `for`-loop with `db.insert` inside.
- [ ] Weekly prune runs: `30 3 * * 0` cron visible in scheduler.ts; `prune-associations` worker registered in main.ts.
- [ ] Fire-and-forget: search/MCP response never blocks on Redis — all 5 enqueue sites wrapped in `.catch(() => {})`.
- [ ] Unit tests updated: `update-access-stats.test.ts` asserts `db.execute` called once (not `db.insert` 45 times). All existing tests still pass.
- [ ] New integration test `access-stats-e2e.test.ts` passes.
- [ ] LAB_NOTEBOOK Entry 100 present with Result section filled.
- [ ] No cron slot reuse — `grep -n "0 3 \* \* 0" packages/workers/src/scheduler.ts` returns only storage-audit (the new prune job is at `30 3 * * 0`).

---

## Rollback

`git revert <merge sha>` — no schema change (tables already exist from migrations 0011 + 0012). Producer wiring removal stops new jobs; existing association data remains in place (not harmful). Batch UPSERT reverts to serial loop (no correctness change, just performance). Prune schedule removal is one block deletion in `scheduler.ts`. Safe, no maintenance window.

---

## Scope drift check

**No drift.** All items map 1:1 to card deliverables:
- Producer in both search paths: card specifies `search.ts` + `search-brain.ts` ✓
- Batch upsert: card specifies `update-access-stats.ts` batch INSERT ✓
- Scheduler: card specifies `pruneStaleAssociations()` weekly ✓ (slot shifted `0 3` → `30 3` due to pre-existing `storage-audit` at `0 3`; still staggered before memory-consolidation at `0 4`)
- Integration test: card specifies post-search job verification ✓

**Minor in-scope addition (not drift):** `30 3 * * 0` instead of `0 3 * * 0`. Pre-existing slot collision — 30-minute stagger preserves intent.

---

## Scope creep to defer

- **Tuning association boost weights** (hardcoded 0.1 max in `SearchService.lookupAssociationBoosts`): no usage data yet; defer to P24.
- **Co-access tracking on `get_capture` MCP tool:** single-capture fetches generate 0 pairs; not meaningful.
- **Spreading activation weight curve experiments:** defer until 4 weeks of data.
- **Backfill historical associations from captures.access_count:** out of scope.
- **`search_query` field on job payload:** card suggests it but existing `AccessStatsJobData` shape is `{captureIds, accessedAt}`. Don't add without consensus — would require queue interface migration.

---

## Post-merge CLAUDE.md rule candidates

1. **Scheduler slot registry:** Before adding a new cron to `scheduler.ts`, grep for the exact cron string. Current Sunday slots: `0 3 * * 0` storage-audit, `30 3 * * 0` prune-associations (P06), `0 4 * * 0` memory-consolidation, `0 5 * * 0` wiki-lint.
2. **Access-stats producer pattern:** HTTP search route (4 sub-paths) + MCP search tool (1 site) enqueue `access-stats` after every search with `results.length >= 1`. Fire-and-forget (`.catch(() => {})`). Never extract to a shared helper — 5 enqueue sites, all near their `return`.
3. **Batch UPSERT invariant:** `upsertCoAccessAssociations` uses exactly 1 `db.execute(sql\`INSERT...VALUES...ON CONFLICT\`)` call regardless of pair count. No serial per-pair inserts.
4. **D26 top-10:** Access-stats job receives `results.slice(0, 10).map(r => r.capture.id!)`. Worker also caps at `MAX_PAIR_RESULTS = 10`.
5. **Cross-package queue usage:** `core-api` instantiates `new Queue('access-stats', {connection})` directly — same name string as `packages/workers/src/queues/access-stats.ts`. Do NOT import from `@open-brain/workers` (no such cross-package import exists). Job payload type is inlined as `{captureIds: string[]; accessedAt: string}` in core-api.

---

## Critical Files for Implementation

- `packages/workers/src/jobs/update-access-stats.ts` (batch UPSERT + new `createPruneAssociationsWorker`)
- `packages/core-api/src/routes/search.ts` (4 enqueue sites)
- `packages/core-api/src/mcp/tools/search-brain.ts` (1 enqueue site)
- `packages/core-api/src/mcp/tools/index.ts` (thread `accessStatsQueue`)
- `packages/core-api/src/mcp/server.ts` (add to `McpServerDeps`)
- `packages/core-api/src/app.ts` (add to `AppDependencies`)
- `packages/core-api/src/index.ts` (instantiate queue, pass to app)
- `packages/workers/src/scheduler.ts` (new `prune-associations` queue + cron)
- `packages/workers/src/main.ts` (register prune worker)
- `packages/workers/src/__tests__/update-access-stats.test.ts` (assertion update)
- `packages/workers/src/__tests__/integration/access-stats-e2e.test.ts` (NEW)
- `LAB_NOTEBOOK.md` (Entry 100)
