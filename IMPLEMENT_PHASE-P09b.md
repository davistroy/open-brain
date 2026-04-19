# IMPLEMENT_PHASE-P09b — Sibling enum CHECKs: pipeline_events table (stage + status)

**Phase:** P09b
**Severity:** Medium
**Effort estimate:** ~3 hours (revised up from 2h -- stage drift between `pipeline.yaml`, Drizzle schema comment, and actual code producers is wider than the card assumed; reconciliation is the load-bearing work)
**Dependencies:** **P01** (PR #123 -- drift-guard pattern), **P09a** (PR #138 -- migration template, 4-surface lockstep pattern)
**Branch (Gate 2):** `feat/phase-P09b-pipeline-events-enum-checks`
**Homeserver migration:** **YES** -- migration `0025_pipeline_events_enum_checks.sql` (operator approval required at Gate 5; apply at Gate 5.5)

---

## Scope Diff vs. PHASED_PLAN.md

The phase card says "same pattern as P09a" and "2 CHECK constraints active; drift-guard scope is limited to type parity only." This is correct in intent, but **three material drifts surfaced during planning**:

1. **`stage` has a 3-way disagreement** that the phase card did not anticipate:

   | Source | Values |
   |--------|--------|
   | `config/pipeline.yaml` stage names | `classify`, `embed`, `extract`, `link_entities`, `check_triggers`, `notify` (6) |
   | Drizzle schema comment (`packages/shared/src/schema/core.ts:54`) | `classify \| embed \| extract \| link_entities \| check_triggers \| notify` (6 -- matches config) |
   | Actual code producers (grep of `stage:` in `db.insert(pipeline_events).values(...)`) | `received`, `extract`, `embed`, `extract_entities`, `link_entities`, `document-parse`, `document-chunk`, `document-embed` (8 -- **adds `received`, `extract_entities`, `document-parse`, `document-chunk`, `document-embed`; drops `classify`, `check_triggers`, `notify`**) |
   | Test fixtures (`packages/workers/src/__tests__/pipeline-health.test.ts:94`) | `classify`, `embed` (only 2, one of which -- `classify` -- has zero producers in production code) |

   **Code producers are the source of truth for the CHECK constraint.** `classify`, `check_triggers`, and `notify` appear only in `pipeline.yaml` (a design-time config) and a test fixture, but have zero actual `db.insert(pipeline_events)` call sites. Including them in the CHECK is harmless (future-proofing if those stages get wired up) and avoids breakage if `pipeline.yaml` is used to dynamically name stages in a future pipeline refactor.

   **Recommendation:** Include all 11 unique values (8 from code + 3 from config) in the canonical set. This is the conservative approach that matches both the running system and the declared intent. The DB pre-flight audit will tell us if homeserver has any additional values from old code paths.

2. **`status` is clean.** All producers use exactly `'started' | 'success' | 'failed'` (3 values). The `recordStageEvent()` function in `packages/workers/src/jobs/ingestion-worker.ts:28` already has a TypeScript union `status: 'started' | 'success' | 'failed'` that matches this, but it's a local parameter type, not an exported canonical type. The direct `db.insert()` calls in other files (`document-pipeline.ts`, `embed-capture.ts`, `extract-entities.ts`, `link-entities.ts`) use string literals without the union constraint.

3. **Web UI drift-guard scope is limited.** The web's `PipelineEvent` interface (`packages/web/src/lib/types.ts:21-27`) declares `stage: string` and `status: string` -- no union constraint. Pipeline events are display-only in `CaptureCard.tsx` and `CaptureDetail.tsx` (rendered as a list, not used in filter dropdowns). The drift-guard should only ensure the TS canonical types exist and match the DB CHECK; no web filter arrays or Record maps need updating (unlike P09a's `CaptureType` which had 4 web-surface assertions).

**No phase-card acceptance-criterion is invalidated; scope expands to include the drift reconciliation. No operator approval required for the diff.**

---

## Context

P09b closes 2 of the 6 sibling-enum gaps from issue #119 (`pipeline_events.stage` + `pipeline_events.status`). Mirrors the `captures.source` pattern from migration 0022 / `captures.capture_type` + `captures.pipeline_status` from migration 0024 (P09a). P09c (`sessions.session_type`/`status`) follows the same template.

**Why this matters:** today, a typo in any worker writing `stage: 'exract'` would silently corrupt the pipeline_events table -- no constraint catches it. The CHECK constraint is the belt; the TS union is the suspenders.

**Producer file inventory:**

| File | Stage values written | Status values written |
|------|---------------------|----------------------|
| `packages/workers/src/jobs/ingestion-worker.ts` | `received`, `extract` | `started`, `success`, `failed` |
| `packages/workers/src/jobs/embed-capture.ts` | `embed` | `started`, `success`, `failed` |
| `packages/workers/src/jobs/extract-entities.ts` | `extract_entities` | `started`, `success`, `failed` |
| `packages/workers/src/pipeline/stages/link-entities.ts` | `link_entities` | `started`, `success`, `failed` |
| `packages/workers/src/jobs/document-pipeline.ts` | `document-parse`, `document-chunk`, `document-embed` | `started`, `success`, `failed` |

**Consumer file inventory (reads stage/status but doesn't write):**

| File | How consumed |
|------|-------------|
| `packages/core-api/src/services/system-health.ts` | `SELECT stage, status FROM pipeline_events` for pipeline flow view (display-only) |
| `packages/workers/src/skills/pipeline-health-query.ts` | `WHERE status = 'failed'` for alerting |
| `packages/workers/src/skills/pipeline-health.ts` | `stage: string` in `RecentFailure` interface |
| `packages/web/src/components/CaptureCard.tsx` | `capture.pipeline_events` rendered as list |
| `packages/web/src/components/CaptureDetail.tsx` | `capture.pipeline_events` rendered as list |
| `packages/web/src/lib/types.ts` | `PipelineEvent.stage: string`, `PipelineEvent.status: string` |

---

## OPERATOR PRE-FLIGHT (Gate 3 implementer runs at start of implementation)

> The operator has pre-authorized SSH to homeserver for pre-flight SQL. The Gate 3 implementer should run this at the start of implementation; it is not blocked on operator paste-back.

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
docker exec -it open-brain-postgres psql -U openbrain -d openbrain <<'SQL'
SELECT DISTINCT stage, COUNT(*) FROM pipeline_events GROUP BY stage ORDER BY 2 DESC;
SELECT DISTINCT status, COUNT(*) FROM pipeline_events GROUP BY status ORDER BY 2 DESC;
SQL
```

**Implementer action:** paste both result sets verbatim into the LAB_NOTEBOOK pre-action entry for P09b Gate 3 work item #2. Compare against the grep universe documented above. Any DB-only value must be either:

- **Added** to the canonical set (TS union + DB CHECK, both surfaces), OR
- **Migrated/cleaned** in this same migration *before* the CHECK is added (`UPDATE pipeline_events SET stage = '<canonical>' WHERE stage = '<bad>'`), OR
- **Documented as intentional rejection** (ALTER TABLE ... NOT VALID + follow-up cleanup)

**If the audit surfaces unexpected values, STOP and revise the canonical set before writing the migration.**

---

## Work Items

### 1. Map all `pipeline_events.stage` and `pipeline_events.status` producers (read-only, no commit)

Run and capture into the LAB_NOTEBOOK pre-action entry:

```bash
# All non-test stage literal assignments in pipeline_events inserts
git grep -nE "stage:" packages/workers/src/ -- ':!*test*' ':!*spec*' ':!*__tests__*'

# Check for ternary-style assignments (P09a lesson: keyed-property grep misses ternaries)
git grep -nE "stage\s*:\s*[^'\"]*\?" packages/workers/src/ -- ':!*test*'

# All status values in pipeline_events inserts
git grep -nE "status:\s*['\"]" packages/workers/src/ -- ':!*test*' ':!*spec*' ':!*__tests__*' | grep -v pipeline_status

# Check pipeline.yaml for declared stage names
cat config/pipeline.yaml
```

**Expected canonical sets (pending pre-flight confirmation):**

**`stage` (11 values):**
```
classify, check_triggers, document-chunk, document-embed, document-parse,
embed, extract, extract_entities, link_entities, notify, received
```

**`status` (3 values):**
```
started, success, failed
```

### 2. Run DB pre-flight audit and reconcile (SSH, no commit)

Execute the pre-flight SQL from the OPERATOR PRE-FLIGHT section above. Compare DB reality with grep universe. Document reconciliation in LAB_NOTEBOOK.

**Escape hatch if unexpected values found:** Same 3-option decision tree as P09a work item #2 (add / migrate / reject-with-NOT-VALID).

### 3. Create TS types for `PipelineEventStage` and `PipelineEventStatus`

**File:** `packages/shared/src/types/pipeline-event.ts` (new file)

Add two canonical TS union types:

```typescript
/**
 * Pipeline event stage -- the processing step being tracked.
 * Canonical set (P09b / migration 0025 / issue #119). Lockstep across:
 *
 *   - This TS union (canonical source of truth)
 *   - DB CHECK: pipeline_events_stage_check (migration 0025)
 *
 * Values fall into two groups:
 *   - Standard pipeline stages (from config/pipeline.yaml):
 *     classify, embed, extract, link_entities, check_triggers, notify
 *   - Implementation-specific stages (from actual worker code):
 *     received (ingestion entry), extract_entities (entity extraction),
 *     document-parse, document-chunk, document-embed (document pipeline)
 *
 * Adding a value -> update BOTH surfaces (TS union + DB CHECK) in lockstep.
 * ALSO run a pre-flight SELECT DISTINCT audit before tightening.
 */
export type PipelineEventStage =
  | 'classify'
  | 'check_triggers'
  | 'document-chunk'
  | 'document-embed'
  | 'document-parse'
  | 'embed'
  | 'extract'
  | 'extract_entities'
  | 'link_entities'
  | 'notify'
  | 'received'

/**
 * Pipeline event status -- the outcome of a stage invocation.
 * Canonical 3-value set (P09b / migration 0025 / issue #119). Lockstep across:
 *
 *   - This TS union (canonical source of truth)
 *   - DB CHECK: pipeline_events_status_check (migration 0025)
 *
 * Adding a value -> update BOTH surfaces in lockstep.
 */
export type PipelineEventStatus = 'started' | 'success' | 'failed'
```

**Re-export from `packages/shared/src/types/index.ts`** (if it exists) or add the export to the shared package barrel file.

### 4. Tighten `recordStageEvent()` parameter type

**File:** `packages/workers/src/jobs/ingestion-worker.ts`

Change line 27-28 from:
```typescript
  stage: string,
  status: 'started' | 'success' | 'failed',
```
to:
```typescript
  stage: PipelineEventStage,
  status: PipelineEventStatus,
```

Import `PipelineEventStage` and `PipelineEventStatus` from `@open-brain/shared`.

**Note:** The direct `db.insert(pipeline_events).values({...})` calls in other files (`document-pipeline.ts`, `embed-capture.ts`, `extract-entities.ts`, `link-entities.ts`) do NOT go through `recordStageEvent()` -- they insert directly. These files should NOT be changed to import the type (the string literals they use will be validated by `tsc` against the Drizzle column type if/when the Drizzle schema is tightened, but that's a separate concern). The CHECK constraint at the DB level is the primary guard for those direct inserts.

### 5. Update Drizzle schema comment

**File:** `packages/shared/src/schema/core.ts`

Update lines 54-55 from:
```typescript
    stage: text('stage').notNull(),               // classify | embed | extract | link_entities | check_triggers | notify
    status: text('status').notNull(),             // started | success | failed
```
to:
```typescript
    stage: text('stage').notNull(),               // 11 values; CHECK constraint in migration 0025; canonical TS union: PipelineEventStage in packages/shared/src/types/pipeline-event.ts
    status: text('status').notNull(),             // 3 values; CHECK constraint in migration 0025; canonical TS union: PipelineEventStatus in packages/shared/src/types/pipeline-event.ts
```

### 6. Write migration `packages/shared/drizzle/0025_pipeline_events_enum_checks.sql`

Template follows `0024_captures_enum_checks.sql` structure (idempotent DROP IF EXISTS + ADD):

```sql
-- Migration 0025: CHECK constraints on pipeline_events.stage + pipeline_events.status
--
-- Tightens both columns from unconstrained text to canonical value sets.
-- TS unions in packages/shared/src/types/pipeline-event.ts are source of truth;
-- these CHECKs are DB-level belt-and-suspenders.
--
-- Pre-flight audits (MANDATORY -- see CLAUDE.md "Pre-flight DB audit" rule):
--   SELECT DISTINCT stage, COUNT(*) FROM pipeline_events GROUP BY stage ORDER BY 2 DESC;
--   SELECT DISTINCT status, COUNT(*) FROM pipeline_events GROUP BY status ORDER BY 2 DESC;
--
-- P09b pre-flight (homeserver, 2026-04-19):
--   [FILL IN FROM AUDIT RESULTS]
--
-- Stage canonical set (11 values):
--   8 from actual code producers + 3 from pipeline.yaml config (classify,
--   check_triggers, notify -- zero current producers but declared in config,
--   included for forward compatibility).
--
-- Status canonical set (3 values):
--   All producers use exactly these 3 values. The recordStageEvent() function
--   in ingestion-worker.ts already constrains to this union.

ALTER TABLE pipeline_events
  DROP CONSTRAINT IF EXISTS pipeline_events_stage_check;

ALTER TABLE pipeline_events
  ADD CONSTRAINT pipeline_events_stage_check
  CHECK (stage IN (
    'classify',
    'check_triggers',
    'document-chunk',
    'document-embed',
    'document-parse',
    'embed',
    'extract',
    'extract_entities',
    'link_entities',
    'notify',
    'received'
  ));

ALTER TABLE pipeline_events
  DROP CONSTRAINT IF EXISTS pipeline_events_status_check;

ALTER TABLE pipeline_events
  ADD CONSTRAINT pipeline_events_status_check
  CHECK (status IN (
    'started',
    'success',
    'failed'
  ));
```

### 7. Add drift-guard test assertions

**File:** `packages/shared/src/__tests__/web-type-drift.test.ts`

Add a new `describe` block for pipeline_events type parity. Since `PipelineEvent` in the web types uses `stage: string` and `status: string` (not union types), the drift-guard scope is **type parity only** -- verify the canonical TS union values exist and are consistent. No web filter arrays or Record maps need checking.

Add two canonical const arrays near the top of the file (alongside existing `CANONICAL_CAPTURE_SOURCES`, `CANONICAL_CAPTURE_TYPES`, `CANONICAL_PIPELINE_STATUSES`):

```typescript
// Canonical 11-value PipelineEventStage set (P09b / migration 0025 / issue #119).
// Source of truth: packages/shared/src/types/pipeline-event.ts.
const CANONICAL_PIPELINE_EVENT_STAGES = [
  'check_triggers', 'classify', 'document-chunk', 'document-embed',
  'document-parse', 'embed', 'extract', 'extract_entities',
  'link_entities', 'notify', 'received',
] as const

// Canonical 3-value PipelineEventStatus set (P09b / migration 0025 / issue #119).
// Source of truth: packages/shared/src/types/pipeline-event.ts.
const CANONICAL_PIPELINE_EVENT_STATUSES = [
  'failed', 'started', 'success',
] as const
```

Add one `describe` block with two assertions:

1. **PipelineEventStage TS union matches canonical const** -- read `packages/shared/src/types/pipeline-event.ts`, extract the `PipelineEventStage` union literals, assert they match `CANONICAL_PIPELINE_EVENT_STAGES` (sorted).

2. **PipelineEventStatus TS union matches canonical const** -- same pattern for `PipelineEventStatus`.

**Why no web-side assertions?** The web `PipelineEvent.stage` and `PipelineEvent.status` are typed as `string` (no union). They're rendered display-only in `CaptureCard`/`CaptureDetail`. There are no filter dropdowns, no `Record<PipelineEventStage, ...>` maps, and no array constants in the web package. Tightening the web interface to use the unions is out of scope (would require importing from shared, which the web package intentionally avoids).

### 8. Update `PipelineHealthSkill` RecentFailure type (optional tightening)

**File:** `packages/workers/src/skills/pipeline-health.ts`

Change the `RecentFailure` interface's `stage: string` to `stage: PipelineEventStage` (import from `@open-brain/shared`). This is not required for correctness (the DB CHECK is the guard) but maintains the "suspenders" pattern.

Similarly, `packages/workers/src/skills/pipeline-health-query.ts` line 25 uses `stage: string` in the SQL result type -- tighten to `PipelineEventStage`.

### 9. Clean stale test fixture

**File:** `packages/workers/src/__tests__/pipeline-health.test.ts`

Line 94 uses `stage: 'classify'` in a test fixture. This is a valid canonical value (from `pipeline.yaml`), so it's fine to keep. No stale fixture cleanup needed for P09b (unlike P09a which had `'received'` in test fixtures).

### 10. Run all tests

```bash
pnpm --filter @open-brain/shared exec tsc --noEmit
pnpm --filter @open-brain/workers exec tsc --noEmit
pnpm --filter @open-brain/core-api exec tsc --noEmit
pnpm --filter @open-brain/shared test
pnpm --filter @open-brain/workers test
pnpm --filter @open-brain/core-api test
```

All must pass. The drift-guard test in shared validates TS union <-> canonical const parity.

---

## Acceptance Criteria

1. Migration `0025_pipeline_events_enum_checks.sql` exists, idempotent (DROP IF EXISTS + ADD), contains both CHECK constraints.
2. `PipelineEventStage` TS union exported from `@open-brain/shared` with 11 values (or revised count if pre-flight surfaces surprises).
3. `PipelineEventStatus` TS union exported from `@open-brain/shared` with 3 values.
4. Drizzle schema comments on `pipeline_events.stage` and `pipeline_events.status` reference migration 0025 and the TS union (not inline value lists).
5. `recordStageEvent()` parameter type tightened from `string` to `PipelineEventStage`.
6. Drift-guard test file has 2 new assertions (stage + status canonical-vs-TS-union parity).
7. All package `tsc --noEmit` clean; all unit suites green.
8. LAB_NOTEBOOK Entry 103 with pre-flight audit results and reconciliation analysis.

---

## Rollback Plan

- **Local code:** `git revert <commit-sha>` for each commit.
- **Local DB (if applied):** `docker exec open-brain-postgres psql -U openbrain -d openbrain -c "ALTER TABLE pipeline_events DROP CONSTRAINT IF EXISTS pipeline_events_stage_check; ALTER TABLE pipeline_events DROP CONSTRAINT IF EXISTS pipeline_events_status_check;"`
- **Homeserver (Gate 5.5 only, after operator apply):** same SQL via `ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net`.
- No data migration; constraints are purely additive. Existing rows already comply (verified via pre-flight).

---

## Out of Scope

- **Tightening `PipelineEvent` in `packages/web/src/lib/types.ts`** from `string` to union types -- web intentionally avoids importing from shared. Display-only usage means no correctness risk.
- **Tightening direct `db.insert(pipeline_events).values(...)` call sites** in `document-pipeline.ts`, `embed-capture.ts`, `extract-entities.ts`, `link-entities.ts` -- these use string literals that are covered by the DB CHECK. TS-level tightening of the Drizzle schema column type (from `text()` to `pgEnum()` or a custom branded type) is a separate concern for a future phase.
- **Reconciling `pipeline.yaml` stage names with actual code** -- `classify`, `check_triggers`, and `notify` are declared in config but have zero producers. This is an architectural question (are these dead config? will they be wired up?) that's orthogonal to the CHECK constraint.
- **P09c** (sessions table) -- separate phase.

---

## Homeserver Gate 5.5

After PR merge, operator applies migration on homeserver:

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
docker exec -it open-brain-postgres psql -U openbrain -d openbrain < /path/to/0025_pipeline_events_enum_checks.sql
```

Or copy-paste the migration SQL directly into psql. Verify with:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'pipeline_events'::regclass
  AND contype = 'c';
```

Expected: 2 rows (`pipeline_events_stage_check`, `pipeline_events_status_check`).

---

## Files Touched

| File | Action |
|------|--------|
| `packages/shared/src/types/pipeline-event.ts` | **NEW** -- `PipelineEventStage` + `PipelineEventStatus` unions |
| `packages/shared/src/types/index.ts` (or barrel) | **EDIT** -- re-export new types |
| `packages/shared/src/schema/core.ts` | **EDIT** -- update schema comments (lines 54-55) |
| `packages/shared/drizzle/0025_pipeline_events_enum_checks.sql` | **NEW** -- migration with 2 CHECK constraints |
| `packages/shared/src/__tests__/web-type-drift.test.ts` | **EDIT** -- add 2 canonical consts + 1 describe block with 2 assertions |
| `packages/workers/src/jobs/ingestion-worker.ts` | **EDIT** -- tighten `recordStageEvent()` params |
| `packages/workers/src/skills/pipeline-health.ts` | **EDIT** -- tighten `RecentFailure.stage` type |
| `packages/workers/src/skills/pipeline-health-query.ts` | **EDIT** -- tighten SQL result type |
| `LAB_NOTEBOOK.md` | **EDIT** -- Entry 103 |

---

## CLAUDE.md Updates

Add to **Database / schema** section:

- `pipeline_events.stage` has 11 valid values: `classify`, `check_triggers`, `document-chunk`, `document-embed`, `document-parse`, `embed`, `extract`, `extract_entities`, `link_entities`, `notify`, `received`. Canonical TS union: `PipelineEventStage` (`packages/shared/src/types/pipeline-event.ts`). DB CHECK: migration 0025. **Adding a stage -> update both surfaces in lockstep.**
- `pipeline_events.status` has 3 valid values: `started`, `success`, `failed`. Canonical TS union: `PipelineEventStatus` (`packages/shared/src/types/pipeline-event.ts`). DB CHECK: migration 0025. **Adding a status -> update both surfaces in lockstep.**
