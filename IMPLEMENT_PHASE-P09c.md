# IMPLEMENT_PHASE-P09c — Sibling enum CHECKs: sessions table (session_type + status)

**Phase:** P09c
**Severity:** Medium
**Effort estimate:** ~2 hours (matches card — canonical sets are clean, web drift-guard scope is limited to `status` only, and the TS types already exist in `packages/shared/src/types/session.ts`)
**Dependencies:** **P01** (PR #123 — drift-guard infrastructure), **P09a** (PR #138 — migration template + 4-surface lockstep pattern), **P09b** (PR #139 — drift-guard for pipeline_events, same `describe`-block pattern)
**Branch (Gate 2):** `feat/phase-P09c-sessions-enum-checks`
**Homeserver migration:** **YES** — migration `0026_sessions_enum_checks.sql` (operator approval required at Gate 5; apply at Gate 5.5)

---

## Scope Diff vs. PHASED_PLAN.md

The phase card says "Pre-flight + migration 0026 + TS/Zod updates. Governance session type literals are used in `packages/core-api/src/services/session.ts`; drift-guard scope if web surfaces these."

**Three drifts from the card assumption surfaced during planning:**

1. **TS types already exist in `@open-brain/shared`.** The card implies creating them ("TS/Zod updates"), but `packages/shared/src/types/session.ts` already declares:
   ```typescript
   export type SessionStatus = 'active' | 'paused' | 'complete' | 'abandoned'
   export type SessionType = 'governance' | 'review' | 'planning'
   ```
   Both are already exported via `packages/shared/src/types/index.ts` and re-exported via the shared package barrel. Work item reduces to: **add JSDoc lockstep comments** (same pattern as P09a/P09b), not creating new types.

2. **No Zod enum exists for `session_type` or `status`.** Route validation in `packages/core-api/src/routes/sessions.ts` uses inline `VALID_TYPES` and `VALID_STATUSES` arrays (TypeScript-typed against the `SessionType` / `SessionStatus` unions). This is adequate: the route's arrays and the TS types are already in sync. A Zod enum is not required and not worth adding in this phase.

3. **Web drift-guard scope: `status` only (NOT `session_type`).** The board component (`packages/web/src/pages/Board.tsx:12-13`) declares **its own** local `SessionType = 'quick_check' | 'quarterly'` and `SessionStatus = 'active' | 'complete' | 'paused'`. These are UI-layer concepts intentionally decoupled from the API types — the Board maps `quick_check` → `governance` and `quarterly` → `review` before calling the API (line 346). This mapping is Board-specific logic, not a drift. The web's `SessionStatus` is a subset (3 of 4): it omits `'abandoned'` because the Board UI never enters an abandoned state directly. This is intentional UI simplification, not a bug. **Drift-guard for `session_type` is NOT appropriate** (the web type is a different concept). **Drift-guard for `status` is also NOT appropriate** (the web type is a deliberate subset with different semantics for the UI layer). The card's "drift-guard scope if web surfaces these" resolves to: drift-guard is out of scope for both columns in this phase.

**No phase-card acceptance criteria are invalidated. The scope narrows slightly (no new type files; TS types already exist) and the drift-guard work is eliminated (confirmed web types are intentionally different). No operator approval required for the diff.**

---

## Context

P09c closes the 2 remaining sibling-enum gaps from issue #119: `sessions.session_type` and `sessions.status`. Mirrors the pattern from migration 0022 (`captures.source`), migration 0024 (`captures.capture_type` + `captures.pipeline_status`, P09a), and migration 0025 (`pipeline_events.stage` + `pipeline_events.status`, P09b).

**Why this matters:** today, a typo writing `status: 'completd'` would silently land in the sessions table. The CHECK constraint catches it at DB write time. The TS union (`SessionType` / `SessionStatus` in `@open-brain/shared`) is already the suspenders; migration 0026 adds the belt.

**Producer inventory for `session_type`:**

| File | Values written |
|------|---------------|
| `packages/core-api/src/services/session.ts:130` | `session_type: input.type` (from `CreateSessionInput.type: SessionType`) — routes to `'governance'`, `'review'`, `'planning'` |
| `packages/slack-bot/src/handlers/commands/board.ts:31,54` | `'governance'`, `'review'` (via `client.sessions_create()`) |
| Test fixtures (non-canonical, not constrained by CHECK) | `'governance'` only |

**Producer inventory for `status`:**

| File | Values written |
|------|---------------|
| `packages/core-api/src/services/session.ts:131` | `'active'` (create) |
| `packages/core-api/src/services/session.ts:280` | `'paused'` (pause) |
| `packages/core-api/src/services/session.ts:317` | `'abandoned'` (abandon on resume of expired) |
| `packages/core-api/src/services/session.ts:338` | `'active'` (resume) |
| `packages/core-api/src/services/session.ts:391` | `'complete'` (complete) |
| `packages/core-api/src/services/session.ts:454` | `'abandoned'` (abandon) |

All 4 status values (`active`, `paused`, `complete`, `abandoned`) are actively produced. No dead-code values.

**Consumer inventory (reads but does not write):**

| File | How consumed |
|------|-------------|
| `packages/core-api/src/routes/sessions.ts:78-79` | `statusFilter` query param validation against `VALID_STATUSES` array |
| `packages/core-api/src/services/session.ts:162,265,269,302,373,377,443,447` | Status guard checks (`!== 'active'`, `=== 'paused'`, etc.) |
| `packages/core-api/src/services/governance-engine.ts:215,243` | Passes `session.session_type` to capture creation |
| `packages/workers/src/skills/drift-monitor-query.ts:260` | `WHERE s.session_type = 'governance'` — read filter |
| `packages/slack-bot/src/handlers/session.ts:117,119` | Status checks (`=== 'complete'`, `=== 'abandoned'`) |
| `packages/slack-bot/src/lib/formatters.ts:349,350` | Display logic, status emoji selector |
| `packages/web/src/pages/Board.tsx` | Display + local UI logic (uses own local type — see Scope Diff §3) |

---

## OPERATOR PRE-FLIGHT (Gate 3 implementer runs at start of implementation)

> The operator has pre-authorized SSH to homeserver for pre-flight SQL. The Gate 3 implementer runs this at the start of implementation; it is not blocked on operator paste-back.

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
docker exec -it open-brain-postgres psql -U openbrain -d openbrain <<'SQL'
SELECT DISTINCT session_type, COUNT(*) FROM sessions GROUP BY session_type ORDER BY 2 DESC;
SELECT DISTINCT status, COUNT(*) FROM sessions GROUP BY status ORDER BY 2 DESC;
SQL
```

**Implementer action:** paste both result sets verbatim into the LAB_NOTEBOOK pre-action entry for P09c Gate 3 work item #2. Compare against the code universe documented above. Any DB-only value must be:

- **Added** to the canonical set (TS union + DB CHECK, both surfaces), OR
- **Migrated/cleaned** in this same migration *before* the CHECK is added (`UPDATE sessions SET session_type = '<canonical>' WHERE session_type = '<bad>'`), OR
- **Documented as intentional rejection** (ALTER TABLE ... NOT VALID + follow-up cleanup)

**If the audit surfaces unexpected values, STOP and revise the canonical set before writing the migration.**

**Expected canonical sets (pending pre-flight confirmation):**

`session_type` (3 values): `governance`, `review`, `planning`

`status` (4 values): `active`, `paused`, `complete`, `abandoned`

---

## Work Items

### 1. Map all `sessions.session_type` and `sessions.status` producers (read-only, no commit)

Run and capture into the LAB_NOTEBOOK pre-action entry:

```bash
# All non-test session_type write sites
git grep -nE "session_type:" packages/ -- ':!*test*' ':!*spec*' ':!*__tests__*' ':!dist'

# Check for ternary-style assignments (P09a lesson: keyed-property grep misses ternaries)
git grep -nE "session_type\s*:\s*[^'\"]*\?" packages/ -- ':!*test*' ':!dist'

# All status write sites in session service (status: 'xxx' patterns)
git grep -nE "status:\s*'(active|paused|complete|abandoned)'" packages/core-api/src/services/session.ts
```

**Verify the canonical sets match the code universe above.** No surprises expected — the `SessionType` and `SessionStatus` unions in `@open-brain/shared` are already imported by the route validator and enforced at the API boundary.

### 2. Run DB pre-flight audit and reconcile (SSH, no commit)

Execute the pre-flight SQL from the OPERATOR PRE-FLIGHT section above. Compare DB reality with the grep universe. Document reconciliation in LAB_NOTEBOOK.

**Escape hatch if unexpected values found:** Same 3-option decision tree as P09a work item #2 (add / migrate / reject-with-NOT-VALID).

### 3. Update JSDoc lockstep comments on existing TS types

**File:** `packages/shared/src/types/session.ts`

The types already exist. Add canonical-set documentation comments mirroring P09a/P09b style:

```typescript
/**
 * Session type -- the category of governance or review session.
 * Canonical 3-value set (P09c / migration 0026 / issue #119). Lockstep across:
 *
 *   - This TS union (canonical source of truth)
 *   - DB CHECK: sessions_session_type_check (migration 0026)
 *   - Route validation: VALID_TYPES array in packages/core-api/src/routes/sessions.ts
 *
 * Adding a value -> update BOTH surfaces (TS union + DB CHECK) in lockstep.
 * ALSO run a pre-flight SELECT DISTINCT audit before tightening.
 */
export type SessionType = 'governance' | 'review' | 'planning'

/**
 * Session lifecycle status.
 * Canonical 4-value set (P09c / migration 0026 / issue #119). Lockstep across:
 *
 *   - This TS union (canonical source of truth)
 *   - DB CHECK: sessions_status_check (migration 0026)
 *   - Route validation: VALID_STATUSES array in packages/core-api/src/routes/sessions.ts
 *
 * Semantics:
 *   - `active`    -- session in progress, accepting respond() calls
 *   - `paused`    -- session paused (up to 30 days); resumable via resume()
 *   - `complete`  -- terminal success; summary generated and captured
 *   - `abandoned` -- terminal failure/cancel; no summary generated
 *
 * Adding a value -> update BOTH surfaces in lockstep.
 */
export type SessionStatus = 'active' | 'paused' | 'complete' | 'abandoned'
```

### 4. Update Drizzle schema comments

**File:** `packages/shared/src/schema/supporting.ts`

Update lines 91-92 from inline value lists to cross-references:

```typescript
    session_type: text('session_type').notNull(), // 3 values; CHECK constraint in migration 0026; canonical TS union: SessionType in packages/shared/src/types/session.ts
    status: text('status').notNull().default('active'), // 4 values; CHECK constraint in migration 0026; canonical TS union: SessionStatus in packages/shared/src/types/session.ts
```

### 5. Write migration `packages/shared/drizzle/0026_sessions_enum_checks.sql`

Template follows `0024_captures_enum_checks.sql` and `0025_pipeline_events_enum_checks.sql` structure (idempotent DROP IF EXISTS + ADD):

```sql
-- Migration 0026: CHECK constraints on sessions.session_type + sessions.status
--
-- Tightens both columns from unconstrained text to canonical value sets.
-- TS unions in packages/shared/src/types/session.ts are source of truth;
-- these CHECKs are DB-level belt-and-suspenders.
--
-- Pre-flight audits (MANDATORY -- see CLAUDE.md "Pre-flight DB audit" rule):
--   SELECT DISTINCT session_type, COUNT(*) FROM sessions GROUP BY session_type ORDER BY 2 DESC;
--   SELECT DISTINCT status, COUNT(*) FROM sessions GROUP BY status ORDER BY 2 DESC;
--
-- P09c pre-flight (homeserver, <DATE>):
--   session_type: [FILL IN FROM AUDIT RESULTS]
--   status:       [FILL IN FROM AUDIT RESULTS]
--
-- session_type canonical set (3 values):
--   governance | review | planning
--   All values are actively produced via SessionService.create() and
--   slack-bot board command handler. Route layer (sessions.ts) validates
--   against VALID_TYPES before any write reaches the DB.
--
-- status canonical set (4 values):
--   active | paused | complete | abandoned
--   All 4 values are actively produced by SessionService lifecycle methods.
--   Default on create is 'active'. 'paused' and 'abandoned' are terminal-ish
--   (paused can be resumed within 30 days). 'complete' and 'abandoned' are
--   true terminals.
--
-- If any unexpected value appears in a future audit, STOP and revise the
-- canonical set (TS union + DB CHECK, both surfaces) BEFORE applying.

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_session_type_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_session_type_check
  CHECK (session_type IN (
    'governance',
    'review',
    'planning'
  ));

ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_status_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_status_check
  CHECK (status IN (
    'active',
    'paused',
    'complete',
    'abandoned'
  ));
```

### 6. Add drift-guard test assertions

**File:** `packages/shared/src/__tests__/web-type-drift.test.ts`

Scope decision (from Scope Diff §3): the web `SessionType` and `SessionStatus` in `Board.tsx` are Board-UI-specific types, intentionally different from the API/DB types. No web-side assertions are warranted.

The drift-guard for P09c is **TS-only**: add canonical const arrays and assertions that the TS union in `packages/shared/src/types/session.ts` matches the canonical sets. This catches any future accidental change to the union that isn't matched by a migration.

Add two canonical const arrays alongside existing `CANONICAL_CAPTURE_SOURCES`, etc.:

```typescript
// Canonical 3-value SessionType set (P09c / migration 0026 / issue #119).
// Source of truth: packages/shared/src/types/session.ts.
const CANONICAL_SESSION_TYPES = [
  'governance', 'planning', 'review',
] as const

// Canonical 4-value SessionStatus set (P09c / migration 0026 / issue #119).
// Source of truth: packages/shared/src/types/session.ts.
const CANONICAL_SESSION_STATUSES = [
  'abandoned', 'active', 'complete', 'paused',
] as const
```

Add one path constant and one `describe` block with two assertions:

```typescript
const SESSION_TYPES_PATH = resolve(__dirname, '../types/session.ts')
// (add to existing const block at top of test file)
```

```typescript
describe('Session type drift guard (phase-P09c / #119)', () => {
  const sessionTypesSource = readFileSync(SESSION_TYPES_PATH, 'utf8')

  it('SessionType TS union matches canonical 3-value list', () => {
    const unionLiterals = extractUnionLiterals(sessionTypesSource, 'SessionType')
    const unionSorted = sorted(unionLiterals)
    const canonicalSorted = sorted(CANONICAL_SESSION_TYPES)

    expect(
      unionSorted,
      `Drift detected in SessionType:\n` +
        `  union     (packages/shared/src/types/session.ts): ${JSON.stringify(unionSorted)}\n` +
        `  canonical (this test):                            ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `Update the \`export type SessionType = ...\` union in ` +
        `packages/shared/src/types/session.ts to match CANONICAL_SESSION_TYPES ` +
        `in this test file, AND update the DB CHECK constraint in ` +
        `packages/shared/drizzle/0026_sessions_enum_checks.sql.`,
    ).toEqual(canonicalSorted)
  })

  it('SessionStatus TS union matches canonical 4-value list', () => {
    const unionLiterals = extractUnionLiterals(sessionTypesSource, 'SessionStatus')
    const unionSorted = sorted(unionLiterals)
    const canonicalSorted = sorted(CANONICAL_SESSION_STATUSES)

    expect(
      unionSorted,
      `Drift detected in SessionStatus:\n` +
        `  union     (packages/shared/src/types/session.ts): ${JSON.stringify(unionSorted)}\n` +
        `  canonical (this test):                            ${JSON.stringify(canonicalSorted)}\n` +
        `\n` +
        `Update the \`export type SessionStatus = ...\` union in ` +
        `packages/shared/src/types/session.ts to match CANONICAL_SESSION_STATUSES ` +
        `in this test file, AND update the DB CHECK constraint in ` +
        `packages/shared/drizzle/0026_sessions_enum_checks.sql.`,
    ).toEqual(canonicalSorted)
  })
})
```

**Note:** The `extractUnionLiterals()` helper already handles both files in `packages/web/src/lib/api.ts` AND `packages/shared/src/types/pipeline-event.ts` (see P09b). Reading `packages/shared/src/types/session.ts` uses the same function — no new helper required. The `WEB_API_PATH`-specific error message in `extractUnionLiterals()` will need a small adjustment: pass the file path in the error message string rather than hard-coding `WEB_API_REL`. Review the function signature before writing the assertion to confirm it accepts an arbitrary file source.

**Why no web-side assertions?** `Board.tsx` declares `SessionType = 'quick_check' | 'quarterly'` and `SessionStatus = 'active' | 'complete' | 'paused'` as local Board UI types. These intentionally do not match the API types: `quick_check` maps to `'governance'` and `quarterly` maps to `'review'` before the API call (Board.tsx:346). The web's `SessionStatus` omits `'abandoned'` because the Board UI ends sessions via `complete` or exits the page (abandoned is only produced by server-side timeout/restart logic). Asserting parity between these UI types and the DB canonical set would be wrong.

### 7. Run all tests

```bash
pnpm --filter @open-brain/shared exec tsc --noEmit
pnpm --filter @open-brain/workers exec tsc --noEmit
pnpm --filter @open-brain/core-api exec tsc --noEmit
pnpm --filter @open-brain/shared test
pnpm --filter @open-brain/workers test
pnpm --filter @open-brain/core-api test
```

All must pass. The drift-guard test in shared validates TS union ↔ canonical const parity for both `SessionType` and `SessionStatus`.

---

## Acceptance Criteria

1. Migration `0026_sessions_enum_checks.sql` exists, idempotent (DROP IF EXISTS + ADD), contains both CHECK constraints (`sessions_session_type_check` + `sessions_status_check`).
2. `SessionType` TS union in `packages/shared/src/types/session.ts` has JSDoc lockstep comment referencing migration 0026.
3. `SessionStatus` TS union in `packages/shared/src/types/session.ts` has JSDoc lockstep comment referencing migration 0026.
4. Drizzle schema comments on `sessions.session_type` and `sessions.status` (in `supporting.ts`) reference migration 0026 and the TS union (not inline value lists).
5. Drift-guard test file has 2 new assertions (SessionType + SessionStatus canonical-vs-TS-union parity).
6. All package `tsc --noEmit` clean; all unit suites green.
7. LAB_NOTEBOOK Entry 104 with pre-flight audit results, reconciliation analysis, and scope-diff rationale for the web drift-guard exclusion.

---

## Rollback Plan

- **Local code:** `git revert <commit-sha>` for each commit.
- **Local DB (if applied):** `docker exec open-brain-postgres psql -U openbrain -d openbrain -c "ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_session_type_check; ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;"`
- **Homeserver (Gate 5.5 only, after operator apply):** same SQL via `ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net`.
- No data migration; constraints are purely additive. Existing rows already comply (verified via pre-flight).

---

## Out of Scope

- **Adding Zod enums for `SessionType` / `SessionStatus`.** Route validation uses inline `VALID_TYPES` / `VALID_STATUSES` arrays already typed against the TS unions. Adding Zod here would duplicate the TS union without additional safety benefit at this phase.
- **Tightening `SessionRecord.session_type` and `SessionRecord.status` fields from `string` to the union types.** The `SessionRecord` interface (session.ts:27-28) uses `string` for DB row compatibility. Tightening to the union is a future cleanup — orthogonal to the CHECK constraint.
- **Tightening `CoreApiTypes.session_type` in the slack-bot** (`packages/slack-bot/src/lib/core-api-types.ts:123`). That interface mirrors the raw API response shape; the field is `string` intentionally. Out of scope.
- **Web drift-guard for `SessionType` / `SessionStatus`.** Board.tsx uses its own UI-specific local types that intentionally diverge from the API types — not a bug. See Scope Diff §3.
- **P10a+** — subsequent phases.

---

## Homeserver Gate 5.5

After PR merge, operator applies migration on homeserver:

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
docker exec -it open-brain-postgres psql -U openbrain -d openbrain <<'SQL'
-- Paste migration 0026_sessions_enum_checks.sql content here
SQL
```

Or copy the file and apply:
```bash
docker cp 0026_sessions_enum_checks.sql open-brain-postgres:/tmp/
docker exec -it open-brain-postgres psql -U openbrain -d openbrain -f /tmp/0026_sessions_enum_checks.sql
```

Verify with:

```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'sessions'::regclass
  AND contype = 'c';
```

Expected: 2 rows (`sessions_session_type_check`, `sessions_status_check`).

---

## Files Touched

| File | Action |
|------|--------|
| `packages/shared/src/types/session.ts` | **EDIT** — add JSDoc lockstep comments to `SessionType` and `SessionStatus` |
| `packages/shared/src/schema/supporting.ts` | **EDIT** — update schema comments on `session_type` (line 91) and `status` (line 92) |
| `packages/shared/drizzle/0026_sessions_enum_checks.sql` | **NEW** — migration with 2 CHECK constraints |
| `packages/shared/src/__tests__/web-type-drift.test.ts` | **EDIT** — add 2 canonical consts + 1 path constant + 1 describe block with 2 assertions |
| `LAB_NOTEBOOK.md` | **EDIT** — Entry 104 |

**No new type files.** No Zod schema files. No worker or route files touched (the TS types were already imported and used correctly).

---

## CLAUDE.md Updates

Add to **Database / schema** section:

- `sessions.session_type` has 3 valid values: `governance`, `review`, `planning`. Canonical TS union: `SessionType` (`packages/shared/src/types/session.ts`). DB CHECK: migration 0026. Route validator: `VALID_TYPES` array in `packages/core-api/src/routes/sessions.ts`. **Adding a value → update all three in lockstep.**
- `sessions.status` has 4 valid values: `active`, `paused`, `complete`, `abandoned`. Canonical TS union: `SessionStatus` (`packages/shared/src/types/session.ts`). DB CHECK: migration 0026. Route validator: `VALID_STATUSES` array in `packages/core-api/src/routes/sessions.ts`. **Adding a value → update all three in lockstep.**
- **Board.tsx declares its own local `SessionType` = `'quick_check' | 'quarterly'` and `SessionStatus` = `'active' | 'complete' | 'paused'`.** These are Board UI types, not API types. The Board maps UI types to API types before calling the API (e.g., `quick_check` → `governance`). Do NOT assert parity between Board.tsx types and the shared canonical types.
