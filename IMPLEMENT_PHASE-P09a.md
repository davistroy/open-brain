# IMPLEMENT_PHASE-P09a — Sibling enum CHECKs: captures table

**Phase:** P09a
**Severity:** Medium
**Effort estimate:** ~4 hours (revised up from 3h — `pipeline_status` drift across web type/code/schema-comment is wider than the phase card assumed; reconciliation is the load-bearing work)
**Dependencies:** **P01** (PR #123 — drift-guard pattern at `packages/shared/src/__tests__/web-type-drift.test.ts`; CHECK migration template at `packages/shared/drizzle/0022_captures_source_check.sql`)
**Branch (Gate 2):** `feat/phase-P09a-captures-enum-checks`
**Homeserver migration:** **YES** — migration `0024_captures_enum_checks.sql` (operator approval required at Gate 5; apply at Gate 5.5)

---

## Scope Diff vs. PHASED_PLAN.md

The phase card matches the *intent* of current code state (the captures.source pattern from migration 0022 is fully reusable), but **two material drifts surfaced during planning**:

1. **`pipeline_status` is the dirty one, not `capture_type`.** `capture_type` consumers across the codebase (`bet.ts`, `daily-sweep-skill.ts`, `weekly-brief.ts`, `email-classify.ts`, `documents.ts`, etc.) all use the canonical 8 values (`decision | idea | observation | task | win | blocker | question | reflection`). No drift detected via grep.

2. **`pipeline_status` has 4-way disagreement** that the phase card did not anticipate:

   | Source | Values |
   |--------|--------|
   | Drizzle schema *comment* (`packages/shared/src/schema/core.ts:20`) | `pending` `processing` `extracted` `embedded` `chunked` `complete` `failed` (7) |
   | Web type (`packages/web/src/lib/types.ts:10`) | `pending` `processing` `complete` `partial` `failed` (5; **adds `partial`**, **drops `extracted`/`embedded`/`chunked`/`deleted`**) |
   | Actual code producers (grep of `pipeline_status: '<value>'` writes) | `pending` `processing` `embedded` `complete` `failed` `deleted` (6 — `deleted` from `capture.ts:217` soft-delete; **`extracted` and `chunked` have ZERO producers**; **`partial` has ZERO producers**) |
   | Test fixtures | `pending` `complete` `failed` `embedded` `deleted` `received` (last is stale slack-bot test data — `core-api-client.test.ts:37` and `capture-handler.test.ts:168` — likely needs cleanup) |

   **The DB pre-flight audit is non-negotiable.** Grep cannot tell us what the homeserver Postgres actually contains; production may have rows with `partial` or `extracted` or `chunked` if old code paths populated them. This is exactly the Entry 089 / `bet.ts` `system` source pattern — and at higher stakes, because pipeline_status churns on every capture.

3. The phase card's `pipeline_status: z.string().optional()` line in `packages/core-api/src/schemas/capture.ts:38` is currently *unconstrained* (it's a list-filter parameter, not a write parameter). This is the only place the enum tightening could break a public API contract — the filter accepts any string today; tightening to `z.enum(...)` will reject filter values outside the canonical set. **Not a regression risk** (no caller is sending bad values), but flag for the implementer to use `.optional()` after `z.enum(...)` and run the integration suite.

**No phase-card acceptance-criterion is invalidated; scope expands to include the drift reconciliation. No operator approval required for the diff.**

---

## Context

P09a closes 2 of the 6 sibling-enum gaps from issue #119 (`captures.capture_type` + `captures.pipeline_status`). Mirrors the `captures.source` pattern from migration 0022 / LAB_NOTEBOOK Entry 089 (the "9th value" surprise). P09b (`pipeline_events.stage`/`status`) and P09c (`sessions.session_type`/`status`) follow the same template.

**Why this matters:** today, a typo in any worker setting `pipeline_status: 'pendng'` would silently corrupt the captures table — no constraint catches it, and the dashboard `pipeline_status` filter dropdown would just stop showing the bad row. The CHECK constraint is the belt; the TS union + Zod + drift-guard is the suspenders.

---

## OPERATOR PRE-FLIGHT (BLOCKING — must run before Gate 3 starts)

> ⚠️ **Per CLAUDE.md "Pre-flight DB audit (`SELECT DISTINCT <col>`) is MANDATORY before CHECK-constraint migrations" and LAB_NOTEBOOK Entry 089:** grep alone misses cold paths. The `pipeline_status` 4-way drift documented above makes this **especially load-bearing for P09a** — production may have values that no current code writes.

Run on the homeserver Postgres (active DB):

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
docker exec -it open-brain-postgres psql -U openbrain -d openbrain <<'SQL'
SELECT capture_type, COUNT(*) FROM captures GROUP BY capture_type ORDER BY 2 DESC;
SELECT pipeline_status, COUNT(*) FROM captures GROUP BY pipeline_status ORDER BY 2 DESC;
SQL
```

**Operator action:** paste both result sets verbatim into the LAB_NOTEBOOK pre-action entry for P09a Gate 3 work item #2 (see below). Implementer compares against the grep universe; any DB-only value must be either:

- **Added** to the canonical set (TS union + Zod + DB CHECK + drift-guard, all 4 surfaces), OR
- **Migrated/cleaned** in this same migration *before* the CHECK is added (`UPDATE captures SET pipeline_status = '<canonical>' WHERE pipeline_status = '<bad>'`), OR
- **Documented as intentional rejection** (ALTER TABLE ... NOT VALID + a follow-up phase to clean) — this is the escape hatch *only* if the bad rows are themselves bugs to be deleted, not mass production data.

**If the operator skips the pre-flight and the implementer proceeds on grep alone, flag and halt at Gate 3 work item #2.**

---

## Work Items

### 1. Map all `capture_type` and `pipeline_status` consumers (read-only, no commit)

Run and capture into the LAB_NOTEBOOK pre-action entry:

```bash
git grep -nE "capture_type\s*[:=]\s*['\"][a-z_]+['\"]" packages/ -- ':!*test*' ':!*spec*'
git grep -nE "pipeline_status\s*[:=]\s*['\"][a-z_]+['\"]" packages/ -- ':!*test*' ':!*spec*'
git grep -nE "pipeline_status\s*=\s*'[a-z_]+'" packages/ -- '*.sql'
```

Also pull tests for stale-value cleanup candidates:
```bash
git grep -nE "pipeline_status:\s*'(received|partial|extracted|chunked)'" packages/
```

**Verification:** results pasted into LAB_NOTEBOOK pre-action entry. Cross-check against canonical universe in work item #3.

### 2. OPERATOR pre-flight DB audit results captured in LAB_NOTEBOOK

Implementer pulls the operator-pasted SQL output into the LAB_NOTEBOOK Result section of work item #1's pre-action entry. **Do not proceed past this point until both DB audits are present.**

### 3. Reconcile grep + DB audit; finalize the canonical value lists

**Canonical `CaptureType` (proposed, no drift expected):**
```
'decision' | 'idea' | 'observation' | 'task' | 'win' | 'blocker' | 'question' | 'reflection'
```
(8 values — matches existing schema comment, web type, all code producers.)

**Canonical `PipelineStatus` (proposed — REVISE based on DB audit):**
```
'pending' | 'processing' | 'embedded' | 'complete' | 'failed' | 'deleted'
```
(6 values — matches actual code producers.)

**Drop from prior surfaces:**
- Schema comment values `extracted` and `chunked` (zero producers in repo; verify zero rows in DB audit before dropping)
- Web type value `partial` (zero producers in repo; verify zero rows)

**Add to web type:**
- `embedded`, `deleted` (currently missing from web; both are real producer values)

**If DB audit surfaces additional values** (e.g., legacy `pending_extraction`, `extracted` from 2025 runs): **ADD to canonical**, do NOT delete the rows.

**Verification:** finalized 6-value `PipelineStatus` (or revised) pasted into LAB_NOTEBOOK with rationale per value.

### 4. Migration `packages/shared/drizzle/0024_captures_enum_checks.sql`

Both CHECK constraints in one migration (same table). Idempotent pattern matching `0022_captures_source_check.sql` exactly:

```sql
-- Migration 0024: CHECK constraints on captures.capture_type + captures.pipeline_status
--
-- Tightens both columns from unconstrained text to canonical value sets.
-- TS unions in packages/shared/src/types/capture.ts remain source of truth;
-- these CHECKs are DB-level belt-and-suspenders.
--
-- Pre-flight audits (MANDATORY — see CLAUDE.md "Pre-flight DB audit"):
--   SELECT capture_type, COUNT(*) FROM captures GROUP BY capture_type;
--   SELECT pipeline_status, COUNT(*) FROM captures GROUP BY pipeline_status;
--
-- If any unexpected value appears, STOP and revise the canonical set OR
-- clean the rows BEFORE applying.

ALTER TABLE captures
  DROP CONSTRAINT IF EXISTS captures_capture_type_check;

ALTER TABLE captures
  ADD CONSTRAINT captures_capture_type_check
  CHECK (capture_type IN (
    'decision', 'idea', 'observation', 'task', 'win', 'blocker', 'question', 'reflection'
  ));

ALTER TABLE captures
  DROP CONSTRAINT IF EXISTS captures_pipeline_status_check;

ALTER TABLE captures
  ADD CONSTRAINT captures_pipeline_status_check
  CHECK (pipeline_status IN (
    'pending', 'processing', 'embedded', 'complete', 'failed', 'deleted'
    -- REVISE per DB audit (work item #3)
  ));
```

Also create `packages/shared/drizzle/meta/_journal.json` entry if needed (check what 0023 did — likely auto-handled).

**Verification:**
- File exists at `packages/shared/drizzle/0024_captures_enum_checks.sql`
- Run locally: `docker exec open-brain-postgres psql -U openbrain -d openbrain -f /tmp/0024_captures_enum_checks.sql` then `\d captures` — both check constraints listed.
- Round-trip test: insert a known-bad value, expect Postgres `23514` violation.

### 5. TS union update — `packages/shared/src/types/capture.ts`

Add `PipelineStatus` union (mirror `CaptureSource` shape). `CaptureType` already exists; verify it matches canonical 8.

```ts
// existing
export type CaptureType =
  | 'decision' | 'idea' | 'observation' | 'task' | 'win' | 'blocker' | 'question' | 'reflection'

// existing
export type CaptureSource = 'slack' | 'voice' | 'api' | 'document' | 'mcp' | 'email' | 'file' | 'consolidation' | 'system'

// NEW
export type PipelineStatus = 'pending' | 'processing' | 'embedded' | 'complete' | 'failed' | 'deleted'
```

Tighten `CaptureRecord.pipeline_status` from `string` to `PipelineStatus`.
Tighten `CaptureFilter.pipeline_status` from `string` to `PipelineStatus`.

**Verification:** `pnpm --filter @open-brain/shared exec tsc --noEmit` passes; rebuild shared (`pnpm --filter @open-brain/shared build`) before downstream typechecks.

### 6. Zod enum update — `packages/core-api/src/schemas/capture.ts`

Add `PIPELINE_STATUSES` const + `z.enum(...)` — mirror `CAPTURE_SOURCES` shape:

```ts
const CAPTURE_TYPES = ['decision', 'idea', 'observation', 'task', 'win', 'blocker', 'question', 'reflection'] as const
const CAPTURE_SOURCES = ['slack', 'voice', 'api', 'document', 'mcp', 'email', 'file', 'consolidation', 'system'] as const
const PIPELINE_STATUSES = ['pending', 'processing', 'embedded', 'complete', 'failed', 'deleted'] as const  // NEW
```

In `listCapturesSchema`, change `pipeline_status: z.string().optional()` to `pipeline_status: z.enum(PIPELINE_STATUSES).optional()`.

**Verification:** `pnpm --filter @open-brain/core-api exec tsc --noEmit`; existing schema tests (if any) still pass; integration test `captures.test.ts` filter cases still green.

### 7. Drift-guard test extension — `packages/shared/src/__tests__/web-type-drift.test.ts`

Extend the P01 drift-guard with two new `describe` blocks (mirror the existing `CaptureSource drift guard` block exactly):

```ts
// Add canonical 8-value CaptureType set
const CANONICAL_CAPTURE_TYPES = [
  'blocker', 'decision', 'idea', 'observation', 'question', 'reflection', 'task', 'win',
] as const

// Add canonical 6-value PipelineStatus set (revise per DB audit)
const CANONICAL_PIPELINE_STATUSES = [
  'complete', 'deleted', 'embedded', 'failed', 'pending', 'processing',
] as const

describe('CaptureType drift guard (phase-P09a / #119)', () => {
  // Assert web/src/lib/types.ts CaptureType union matches canonical
  // Assert SearchFilters CAPTURE_TYPES array matches web union
  // Assert StatsCards/Timeline CAPTURE_TYPES arrays match (same pattern)
})

describe('PipelineStatus drift guard (phase-P09a / #119)', () => {
  // Assert web/src/lib/types.ts PipelineStatus union matches canonical
  // (Phase card permits "type parity only" scope — no UI dropdown for pipeline_status today,
  //  so we don't need a SearchFilters-style array assertion for it.)
})
```

**Per phase card:** "drift-guard scope is limited to type parity only" applies to P09b/c — for P09a, **`capture_type` IS user-facing** (filter dropdowns in `SearchFilters.tsx` and `Timeline.tsx`), so we DO need the array-vs-union assertion for `CAPTURE_TYPES`. `pipeline_status` is type-parity-only.

Files to read in the test (use existing `extractUnionLiterals` / `extractArrayLiterals` helpers):
- `packages/web/src/lib/types.ts` — `CaptureType` and `PipelineStatus` unions
- `packages/web/src/components/SearchFilters.tsx` — `CAPTURE_TYPES` array (line 7)
- `packages/web/src/pages/Timeline.tsx` — `CAPTURE_TYPES` array (line 26)
- `packages/web/src/components/StatsCards.tsx` — `TYPE_LABELS` and `TYPE_COLORS` Record<CaptureType, ...> — verify all 8 keys present (use a different parser or a manual `JSON.parse`-style check)

**Verification:** `pnpm --filter @open-brain/shared test web-type-drift` — new 4-6 assertions green.

### 8. Web type union update — `packages/web/src/lib/types.ts`

Update `PipelineStatus` from current 5-value set to canonical 6:

```ts
// BEFORE
export type PipelineStatus = 'pending' | 'processing' | 'complete' | 'partial' | 'failed'

// AFTER
export type PipelineStatus = 'pending' | 'processing' | 'embedded' | 'complete' | 'failed' | 'deleted'
```

Verify `CaptureType` matches canonical (it already does — line 7 of types.ts).

**Side effects to check:**
- `packages/web/src/components/CaptureCard.tsx:54` — `PIPELINE_STATUS_COLORS[capture.pipeline_status]` — add color entries for `embedded` and `deleted`; remove `partial`. Use a fallback color so missing keys don't crash UI.
- `packages/web/src/components/system/FlowsTab.tsx:189-190` — `flow.pipeline_status === 'processing' || ... === 'pending'` — these literal comparisons still typecheck under the new union.

**Verification:** `pnpm --filter @open-brain/web exec tsc --noEmit`; `pnpm --filter @open-brain/web build` succeeds.

### 9. Drizzle schema column comment update — `packages/shared/src/schema/core.ts`

Lines 14 and 20 currently have inline comments listing the values. Update both to reference migration 0024:

```ts
capture_type: text('capture_type').notNull(), // 8 values; CHECK constraint in migration 0024; canonical TS union: CaptureType in packages/shared/src/types/capture.ts
// ...
pipeline_status: text('pipeline_status').notNull().default('pending'), // 6 values; CHECK constraint in migration 0024; canonical TS union: PipelineStatus in packages/shared/src/types/capture.ts
```

**Optional (defer if time-pressed):** Drizzle `$type<>()` annotation to surface the union into `select()` return types. Mirror what migration 0022 did *not* do (it left the schema column as `text`). **Recommendation: skip $type annotation in P09a** — keep changes minimal; revisit in a separate cleanup phase if desired.

**Verification:** comment-only change, `tsc --noEmit` passes.

### 10. Stale-fixture cleanup (optional, document if deferred)

Two test fixtures use values outside the canonical set:
- `packages/slack-bot/src/__tests__/core-api-client.test.ts:37` — `pipeline_status: 'pending'` (canonical, OK; investigate why this surfaced)
- `packages/slack-bot/src/__tests__/capture-handler.test.ts:168` — `pipeline_status: 'received'` (NOT canonical — real bug or legacy)

Update `'received'` → `'processing'` if the test intent was "in-flight, not yet complete." If the test logic depends on a specific string, document and skip (flag for follow-up issue).

**Verification:** slack-bot test suite green.

### 11. Run full test suites + tsc across all packages

```bash
pnpm --filter @open-brain/shared build
pnpm --filter @open-brain/shared test
pnpm --filter @open-brain/core-api exec tsc --noEmit
pnpm --filter @open-brain/core-api test
pnpm --filter @open-brain/workers exec tsc --noEmit
pnpm --filter @open-brain/workers test
pnpm --filter @open-brain/slack-bot exec tsc --noEmit
pnpm --filter @open-brain/slack-bot test
pnpm --filter @open-brain/web exec tsc --noEmit
pnpm --filter @open-brain/web build
```

Plus the P01 drift-guard suite:
```bash
pnpm --filter @open-brain/shared exec vitest run web-type-drift
```

**Verification:** all green. Per CLAUDE.md "Workers `lint` script runs `tsc --noEmit` on BOTH src AND test files," any test-file TS error is a regression to fix in this PR, not "ambient noise."

---

## Acceptance criteria (from PHASED_PLAN.md, with P09a-specific elaboration)

- [ ] 2 CHECK constraints active locally (`\d captures` lists `captures_capture_type_check` + `captures_pipeline_status_check`)
- [ ] Migration `0024_captures_enum_checks.sql` exists, idempotent (DROP IF EXISTS + ADD), follows 0022 template
- [ ] `PipelineStatus` TS union exported from `packages/shared/src/types/capture.ts`
- [ ] `PIPELINE_STATUSES` Zod const added to `packages/core-api/src/schemas/capture.ts`; `listCapturesSchema.pipeline_status` tightened to `z.enum(...)`
- [ ] Drift-guard extended for `CaptureType` (web type ↔ SearchFilters/Timeline arrays ↔ StatsCards Records) and `PipelineStatus` (web type ↔ canonical, type-parity only) — green
- [ ] Web type `PipelineStatus` updated; CaptureCard color map covers all 6 values
- [ ] All 4 surfaces (TS / Zod / DB CHECK / drift-guard) listed in CLAUDE.md as the lockstep rule for `capture_type` + `pipeline_status` — extends the existing `captures.source` rule, does not duplicate
- [ ] Pre-flight DB audit results recorded in LAB_NOTEBOOK; canonical value sets reconciled against actual production data
- [ ] Homeserver migration ready for Gate 5.5 (file copied to homeserver `/tmp/`, apply commands documented below)

---

## Rollback plan

**Local rollback (any time):**
```bash
git revert <commit-sha>     # reverts code changes
docker exec open-brain-postgres psql -U openbrain -d openbrain -c \
  "ALTER TABLE captures DROP CONSTRAINT IF EXISTS captures_capture_type_check; ALTER TABLE captures DROP CONSTRAINT IF EXISTS captures_pipeline_status_check;"
```

**Homeserver rollback (after Gate 5.5 apply, if production breakage surfaces):**
```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
docker exec -it open-brain-postgres psql -U openbrain -d openbrain -c \
  "ALTER TABLE captures DROP CONSTRAINT IF EXISTS captures_capture_type_check; ALTER TABLE captures DROP CONSTRAINT IF EXISTS captures_pipeline_status_check;"
# Then revert the merge commit on main; redeploy.
```

**CI catches drift before merge:** if the drift-guard fails on a future PR adding a new pipeline status without updating all 4 surfaces, the test message names both sides and the files to reconcile (mirrors the P01 message pattern).

---

## Out of scope

- Other tables' CHECK constraints (P09b: `pipeline_events.stage` + `pipeline_events.status`; P09c: `sessions.session_type` + `sessions.status`)
- New `capture_type` or `pipeline_status` values — this is a constraint-tightening phase, not a feature phase
- Backfilling/migrating any existing rows whose values fall outside the canonical set — the pre-flight audit MUST surface these; resolution is to either expand the canonical set OR data-fix BEFORE adding the CHECK (handled in work item #3, not a separate phase)
- Drizzle `$type<PipelineStatus>()` schema annotation (deferred; see work item #9)
- pgEnum migration (explicitly rejected per migration 0022 header — CHECK is the chosen pattern)

---

## Homeserver Gate 5.5 commands (pre-staged for homeserver-advisor)

```bash
# Copy migration file to homeserver
scp -i ~/.ssh/id_claude_code packages/shared/drizzle/0024_captures_enum_checks.sql \
  claude@homeserver.k4jda.net:/tmp/

# Apply
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
docker cp /tmp/0024_captures_enum_checks.sql open-brain-postgres:/tmp/
docker exec -it open-brain-postgres psql -U openbrain -d openbrain -f /tmp/0024_captures_enum_checks.sql

# Verify both constraints listed
docker exec -it open-brain-postgres psql -U openbrain -d openbrain -c "\d captures"
# Expect: captures_capture_type_check, captures_pipeline_status_check, captures_source_check

# Smoke test — try inserting a bad value, expect 23514
docker exec -it open-brain-postgres psql -U openbrain -d openbrain -c \
  "INSERT INTO captures (content, content_hash, capture_type, brain_view, source, pipeline_status) VALUES ('test', 'p09a-smoke-' || gen_random_uuid()::text, 'BOGUS', 'personal', 'api', 'pending');"
# Expect: ERROR:  new row for relation "captures" violates check constraint "captures_capture_type_check"

# Cleanup any successful test inserts
docker exec -it open-brain-postgres psql -U openbrain -d openbrain -c \
  "DELETE FROM captures WHERE content_hash LIKE 'p09a-smoke-%';"
```

**Rollback (homeserver, only if needed):**
```bash
docker exec -it open-brain-postgres psql -U openbrain -d openbrain -c \
  "ALTER TABLE captures DROP CONSTRAINT IF EXISTS captures_capture_type_check; ALTER TABLE captures DROP CONSTRAINT IF EXISTS captures_pipeline_status_check;"
```

---

## Files touched (for review focus)

**Created:**
- `packages/shared/drizzle/0024_captures_enum_checks.sql`

**Modified:**
- `packages/shared/src/types/capture.ts` — add `PipelineStatus` union; tighten `CaptureRecord` + `CaptureFilter`
- `packages/shared/src/schema/core.ts` — update inline column comments (lines 14, 20)
- `packages/shared/src/__tests__/web-type-drift.test.ts` — add 2 describe blocks (CaptureType + PipelineStatus drift guards)
- `packages/core-api/src/schemas/capture.ts` — add `PIPELINE_STATUSES` const; tighten `listCapturesSchema.pipeline_status`
- `packages/web/src/lib/types.ts` — update `PipelineStatus` union to canonical 6
- `packages/web/src/components/CaptureCard.tsx` — `PIPELINE_STATUS_COLORS` map updates (add `embedded`/`deleted`, remove `partial`)
- `packages/slack-bot/src/__tests__/capture-handler.test.ts` — fix stale `'received'` fixture (work item #10, optional)

**LAB_NOTEBOOK:** new pre-action entries per work item per ORCHESTRATOR.md Gate 3 protocol.

---

## CLAUDE.md updates required (Gate 5 doc-sweep)

- [ ] **Extend** the existing "captures.source 9 valid values" lockstep rule (around line 130 of CLAUDE.md, in the "Database / schema" section) to ALSO cover `capture_type` (8 values) and `pipeline_status` (6 values). Same 4-surface rule (TS union / Zod / DB CHECK / drift-guard) — list canonical values for all three. Keep it as one consolidated rule, not three.
- [ ] Add a note: P09b will extend the same rule for `pipeline_events.stage` + `pipeline_events.status`; P09c for `sessions.session_type` + `sessions.status`.
- [ ] Add to the "captures.source has 9 valid values" rule: "**Pre-flight DB audit revealed a 4-way drift in `pipeline_status` during P09a planning** — schema comment / web type / code producers / test fixtures all disagreed. The 4-surface lockstep rule eliminates this class of drift permanently."
- [ ] (No new MEMORY.md bullet — this is a CLAUDE.md operational rule, not a survival-of-compaction artifact. The Session Status block will be updated in Gate 5 doc-sweep with the standard "P09a merged" line.)
