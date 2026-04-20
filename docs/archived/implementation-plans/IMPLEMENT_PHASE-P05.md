# IMPLEMENT_PHASE-P05 — Autonomy uniform through BaseSkill

**Source card:** PHASED_PLAN.md § P05
**Tracks issue:** #108 (full close — Theme 6: Autonomy false-uniform)
**Effort estimate:** ~2 days
**Branch (Gate 2 will create):** `feat/phase-P05-autonomy-uniform`
**Gate 5 path:** operator-approval REQUIRED (touches CLAUDE.md + 20+ skill files)

---

## Investigation findings

### BaseSkill shape today

**File:** `packages/workers/src/skills/base-skill.ts` (lines 17–112)

```typescript
export abstract class BaseSkill<TInput, TResult extends BaseResult> {
  protected db: Database
  protected pushover: PushoverService
  protected skillName: string

  constructor(skillName: string, opts: BaseSkillOpts)

  abstract execute(input: TInput): Promise<TResult>   // async, must return Promise<TResult>

  protected async logResult(result, inputSummary, outputSummary?, captureId?): Promise<void>
  protected async sendNotification(title, message, priority?): Promise<boolean>
  protected formatDuration(ms: number): string
  protected truncate(text: string, max = 100): string
}
```

Key design observations:
- `execute()` is **abstract** — subclasses implement it entirely (no template method / no `super.execute()` call).
- There is **no existing static-member pattern** in BaseSkill (no `static name`, no `static task_routing_key`).
- `LLMSkill` extends `BaseSkill` and is itself abstract; all LLM-heavy skills extend `LLMSkill`.
- The `execute()` return type is `Promise<TResult>` where `TResult extends BaseResult` (minimum: `{ durationMs: number }`).

**Critical implication:** Because `execute()` is abstract and subclasses implement it directly (not via a `run()` hook), adding a gate in BaseSkill requires either:
- **Option A (recommended):** A non-abstract `execute()` on BaseSkill that calls an abstract `run()` (template method pattern). Subclasses rename `execute()` → `run()`.
- **Option B:** Leave execute abstract, add a `checkAutonomyGate()` helper on BaseSkill that subclasses call at the top of their execute() — but this requires touching every proactive skill anyway and is opt-in at call-site (fragile).

**Recommendation: Option A — template method.** BaseSkill gains a concrete `execute()` that checks `static minimum_autonomy` and returns `{status: 'gated', durationMs: 0}` if gated, then delegates to abstract `run()`. Subclasses move their execute body to `run()`. This is a mechanical rename for all subclasses (~19 files) but is correct, testable, and enforced at the framework level. Because `run()` is the new abstract, TypeScript prevents forgetting the implementation. Skills without `static minimum_autonomy` skip the gate entirely (reactive-safe).

**Non-trivial refactor flag:** Renaming `execute()` → `run()` across 19+ skill files is mechanical but broad. The implementer must handle:
- The `runSkill()` helper in `skill-execution.ts` calls `skill.execute(input)` — this now calls the concrete wrapper, which is correct.
- Existing unit tests that instantiate concrete skill subclasses and call `.execute()` continue to work unchanged (public API preserved).
- The abstract method signature changes from `execute(input: TInput): Promise<TResult>` to `protected abstract run(input: TInput): Promise<TResult>`. The `run()` method must be `protected` since external callers only use `execute()`.
- The `ConcreteSkill` test helper in `base-skill.test.ts` must also rename `execute()` → `run()`.

### Autonomy helper shape today

**File:** `packages/shared/src/lib/autonomy.ts`

```typescript
export type AutonomyLevel = 'observe' | 'assist' | 'advise' | 'partner'
export const AUTONOMY_LEVELS: AutonomyLevel[] = ['observe', 'assist', 'advise', 'partner']
export const DEFAULT_AUTONOMY: AutonomyLevel = 'observe'

export function meetsAutonomyLevel(current: AutonomyLevel, required: AutonomyLevel): boolean
  // ordinal comparison: AUTONOMY_LEVELS.indexOf(current) >= AUTONOMY_LEVELS.indexOf(required)
  // SYNC — no async, no DB, no network
```

Exported from `@open-brain/shared` via `lib/index.ts` → `src/index.ts` barrel.

**There is NO `checkAutonomy('proactive')` function.** The card's reference to `checkAutonomy` is informal shorthand for calling `meetsAutonomyLevel(currentLevel, skill.static.minimum_autonomy)`. The implementer uses `meetsAutonomyLevel()` directly.

**Caching:** The helper itself is stateless and synchronous. The autonomy level must be fetched from `app_settings` before calling `meetsAutonomyLevel()`. The slack-bot implements a 5-minute in-process cache for `getAutonomyLevel()` (`packages/slack-bot/src/server.ts` lines 24–52). BaseSkill will need the same pattern: a module-level cache for the autonomy level fetch.

**How autonomy level is fetched:** Via HTTP `GET /api/v1/settings/autonomy_level` → `{ value: string }`. Validated against the 4 known levels; defaults to `'observe'` on error.

**BaseSkill needs `coreApiUrl`:** The fetch requires the API URL. BaseSkillOpts does not currently include `coreApiUrl` — only `LLMSkillOpts` has it. For the 4 proactive skills, all are `LLMSkill` subclasses and already have `this.coreApiUrl`. The BaseSkill autonomy fetch should read `coreApiUrl` from:
1. `process.env.OPEN_BRAIN_API_URL` (matches the `LLMSkill` default)
2. Fallback `'http://localhost:3000'`

This avoids adding `coreApiUrl` to `BaseSkillOpts` (which would require updating all 20 skill constructors).

### Proactive skills inventory (P05 scope — exactly 4)

| Skill | File | Class | Current autonomy check | Proposed minimum_autonomy |
|-------|------|-------|------------------------|---------------------------|
| email-compose | `packages/workers/src/skills/email-compose.ts` | `EmailComposeSkill` | None | `'advise'` |
| memory-consolidation | `packages/workers/src/skills/memory-consolidation.ts` | `MemoryConsolidationSkill` | None | `'assist'` |
| daily-sweep-skill | `packages/workers/src/skills/daily-sweep-skill.ts` | `DailySweepSkill` | None | `'assist'` |
| weekly-brief | `packages/workers/src/skills/weekly-brief.ts` | `WeeklyBriefSkill` | None | `'observe'` |

Rationale for `weekly-brief → observe`: Weekly brief is informational delivery (generates a report and emails/Pushover notifies). Per card: "observe (informational, safe at all levels)".

### Proactive skills NOT in P05 scope — candidates for P05.1 follow-up

| Skill | Class | Nature |
|-------|-------|--------|
| `daily-connections` | `DailyConnectionsSkill` | Proactive cron (weekly) |
| `drift-monitor` | `DriftMonitorSkill` | Proactive cron (weekly) |
| `morning-brief` | `MorningBriefSkill` | Proactive cron (daily 6am) |
| `monthly-reflection` | `MonthlyReflectionSkill` | Proactive cron (monthly) |
| `cost-analysis` | `CostAnalysisSkill` | Proactive cron (daily 7am) |
| `capture-dedup-sweep` | `CaptureDedupSweepSkill` | Proactive cron (notifies only) |

P05 gates exactly the 4 skills listed in the card. These 6 are documented for a P05.1 follow-up issue.

### Reactive pipeline skills (MUST NOT be gated)

These skills run as pipeline stages in response to user-triggered captures or as ops monitoring. Gating them at autonomy would stall the capture pipeline when `autonomy_level = observe` (the default):

| Skill | Class | Trigger |
|-------|-------|---------|
| `wiki-ingest` | `WikiIngestSkill` | Pipeline stage (capture complete) |
| `wiki-lint` | `WikiLintSkill` | Pipeline stage |
| `wiki-synthesis` | `WikiSynthesisSkill` | Pipeline stage |
| `capture-reminder` | `CaptureReminderSkill` | Cron — nudge notifications |
| `pipeline-health` | `PipelineHealthSkill` | Ops cron — monitoring |
| `container-health` | `ContainerHealthSkill` | Ops cron — monitoring |
| `storage-audit` | `StorageAuditSkill` | Ops cron — reporting |
| `secret-rotation` | `SecretRotationSkill` | Ops cron — security |
| `stale-captures` | `StaleCapturesSkill` | Pipeline health |
| `email-classify` | `EmailClassifySkill` | Pipeline stage (email ingestion) |

**Design rule:** The gate is opt-in. `static minimum_autonomy` absent = ungated. Only skills that explicitly declare `static minimum_autonomy` are gated. This makes BaseSkill safe for all reactive pipeline skills without any changes to them.

### Reference pattern: slack-bot auto-response

**File:** `packages/slack-bot/src/handlers/auto-response.ts` lines 246–250 and 329–334

```typescript
// assist mode gate (line 247):
if (
  meetsAutonomyLevel(autonomyLevel, 'assist') &&
  confidence.composite >= effectiveAssistThreshold &&
  synthesis
) { ... }

// advise mode gate (line 330):
if (
  meetsAutonomyLevel(autonomyLevel, 'advise') &&
  ...
) { ... }
```

**Fetch + cache pattern** (`packages/slack-bot/src/server.ts` lines 24–52):

```typescript
let cachedAutonomyLevel: { level: AutonomyLevel; fetchedAt: number } | null = null
const AUTONOMY_CACHE_TTL = 5 * 60 * 1000

async function getAutonomyLevel(coreApiClient: CoreApiClient): Promise<AutonomyLevel> {
  const now = Date.now()
  if (cachedAutonomyLevel && now - cachedAutonomyLevel.fetchedAt < AUTONOMY_CACHE_TTL) {
    return cachedAutonomyLevel.level
  }
  try {
    const response = await fetch(`${process.env.CORE_API_URL}/api/v1/settings/autonomy_level`)
    if (response.ok) {
      const data = await response.json() as { value: string }
      const level = (['observe', 'assist', 'advise', 'partner'].includes(data.value)
        ? data.value : 'observe') as AutonomyLevel
      cachedAutonomyLevel = { level, fetchedAt: now }
      return level
    }
  } catch { /* default to observe */ }
  cachedAutonomyLevel = { level: 'observe', fetchedAt: now }
  return 'observe'
}
```

BaseSkill will use an identical module-level cache pattern; the import of `meetsAutonomyLevel` and `AutonomyLevel` comes from `@open-brain/shared`.

**Note on auto-response (slack-bot):** The slack-bot auto-response handler takes the autonomy level as a parameter passed in from `server.ts` (which fetches + caches it). It does NOT use BaseSkill and will NOT be changed by P05. There is no consolidation to do; it's architecturally different (event handler, not a queued skill).

---

## Work items

### 1.1 — Augment BaseSkill with static minimum_autonomy hook

**File:** `packages/workers/src/skills/base-skill.ts`

**Design:**
- Add module-level autonomy cache (mirrors slack-bot pattern)
- Change `abstract execute()` to concrete; add `protected abstract run()`
- `execute()` checks `static minimum_autonomy`; if absent, runs ungated; if present, fetches current level and compares
- If gated, logs and returns `{ status: 'gated', durationMs: 0, ...}` cast to TResult
- Export `_resetBaseSkillAutonomyCacheForTest()` for test isolation

**Complete replacement for `base-skill.ts`:**

```typescript
import { skills_log, logger, PushoverService, meetsAutonomyLevel } from '@open-brain/shared'
import type { Database, AutonomyLevel } from '@open-brain/shared'
import type { BaseResult, BaseSkillOpts } from './types.js'

// Module-level autonomy cache (5-minute TTL, matches slack-bot pattern)
let _autonomyCache: { level: AutonomyLevel; fetchedAt: number } | null = null
const AUTONOMY_CACHE_TTL = 5 * 60 * 1000

async function fetchAutonomyLevel(coreApiUrl: string): Promise<AutonomyLevel> {
  const now = Date.now()
  if (_autonomyCache && now - _autonomyCache.fetchedAt < AUTONOMY_CACHE_TTL) {
    return _autonomyCache.level
  }
  try {
    const response = await fetch(`${coreApiUrl}/api/v1/settings/autonomy_level`)
    if (response.ok) {
      const data = (await response.json()) as { value: string }
      const level = (['observe', 'assist', 'advise', 'partner'].includes(data.value)
        ? data.value
        : 'observe') as AutonomyLevel
      _autonomyCache = { level, fetchedAt: now }
      return level
    }
  } catch {
    // Settings unavailable — default to observe (most restrictive)
  }
  _autonomyCache = { level: 'observe', fetchedAt: now }
  return 'observe'
}

export function _resetBaseSkillAutonomyCacheForTest(): void {
  _autonomyCache = null
}

export abstract class BaseSkill<TInput, TResult extends BaseResult> {
  protected db: Database
  protected pushover: PushoverService
  protected skillName: string

  // Declare a minimum autonomy level for proactive skills.
  // Absence = ungated (reactive pipeline skills are safe).
  static minimum_autonomy?: AutonomyLevel

  constructor(skillName: string, opts: BaseSkillOpts) {
    this.skillName = skillName
    this.db = opts.db
    this.pushover = opts.pushover ?? new PushoverService()
  }

  async execute(input: TInput): Promise<TResult> {
    const ctor = this.constructor as typeof BaseSkill
    const minimumAutonomy = ctor.minimum_autonomy

    if (minimumAutonomy !== undefined) {
      const coreApiUrl = process.env.OPEN_BRAIN_API_URL ?? 'http://localhost:3000'
      const currentLevel = await fetchAutonomyLevel(coreApiUrl)

      if (!meetsAutonomyLevel(currentLevel, minimumAutonomy)) {
        logger.info(
          { skillName: this.skillName, currentLevel, minimumAutonomy },
          `[base-skill] gated — autonomy ${currentLevel} < required ${minimumAutonomy}`,
        )
        return {
          status: 'gated',
          durationMs: 0,
          currentAutonomyLevel: currentLevel,
          requiredAutonomyLevel: minimumAutonomy,
        } as unknown as TResult
      }
    }

    return this.run(input)
  }

  protected abstract run(input: TInput): Promise<TResult>

  // ... (logResult, sendNotification, formatDuration, truncate unchanged)
}
```

**`BaseResult` addition (types.ts):**
```typescript
export interface BaseResult {
  durationMs: number
  notificationSent?: boolean
  status?: 'gated'  // set by BaseSkill.execute() when autonomy gate blocks execution
}
```

---

### 1.2 — Rename execute() → run() on all BaseSkill subclasses

Mechanical rename — no logic changes. Method must be `protected run()`.

Affected files and classes (20 total):

| # | Skill file | Class |
|--:|-----------|-------|
| 1 | `email-compose.ts` | `EmailComposeSkill` |
| 2 | `memory-consolidation.ts` | `MemoryConsolidationSkill` |
| 3 | `daily-sweep-skill.ts` | `DailySweepSkill` |
| 4 | `weekly-brief.ts` | `WeeklyBriefSkill` |
| 5 | `capture-reminder.ts` | `CaptureReminderSkill` |
| 6 | `container-health.ts` | `ContainerHealthSkill` |
| 7 | `cost-analysis.ts` | `CostAnalysisSkill` |
| 8 | `daily-connections.ts` | `DailyConnectionsSkill` |
| 9 | `drift-monitor.ts` | `DriftMonitorSkill` |
| 10 | `email-classify.ts` | `EmailClassifySkill` |
| 11 | `monthly-reflection.ts` | `MonthlyReflectionSkill` |
| 12 | `morning-brief.ts` | `MorningBriefSkill` |
| 13 | `pipeline-health.ts` | `PipelineHealthSkill` |
| 14 | `secret-rotation.ts` | `SecretRotationSkill` |
| 15 | `stale-captures.ts` | `StaleCapturesSkill` |
| 16 | `storage-audit.ts` | `StorageAuditSkill` |
| 17 | `wiki-ingest.ts` | `WikiIngestSkill` |
| 18 | `wiki-lint.ts` | `WikiLintSkill` |
| 19 | `wiki-synthesis.ts` | `WikiSynthesisSkill` |
| 20 | `capture-dedup-sweep.ts` | `CaptureDedupSweepSkill` |

**LLMSkill** (`llm-skill.ts`) is abstract and does NOT implement `execute()` — no change there.

**Test helper `ConcreteSkill`** in `base-skill.test.ts` must also rename `execute()` → `run()`.

External callers (`skill-execution.ts:runSkill()`, top-level `executeXxx()` functions) call `skill.execute()` which now routes through BaseSkill's concrete wrapper → `run()`. No changes needed in callers.

---

### 1.3 — Declare static minimum_autonomy on each of the 4 proactive skills

After the rename in 1.2, add the static declaration inside the class body (before the constructor):

**`EmailComposeSkill`** (`email-compose.ts`):
```typescript
static minimum_autonomy: AutonomyLevel = 'advise'
```

**`MemoryConsolidationSkill`** (`memory-consolidation.ts`):
```typescript
static minimum_autonomy: AutonomyLevel = 'assist'
```

**`DailySweepSkill`** (`daily-sweep-skill.ts`):
```typescript
static minimum_autonomy: AutonomyLevel = 'assist'
```

**`WeeklyBriefSkill`** (`weekly-brief.ts`):
```typescript
static minimum_autonomy: AutonomyLevel = 'observe'
```

Import required in each skill file:
```typescript
import type { AutonomyLevel } from '@open-brain/shared'
```

---

### 1.4 — Unit tests per proactive skill + BaseSkill gate tests

**New test file:** `packages/workers/src/__tests__/base-skill-autonomy.test.ts`

8 tests:
1. Runs ungated when `static minimum_autonomy` is absent (no fetch called)
2. Returns gated result when current level < minimum (observe < assist)
3. Runs when current level equals minimum (assist == assist)
4. Runs when current level exceeds minimum (advise > assist)
5. Gates correctly for advise minimum (assist < advise)
6. Never gates when `minimum_autonomy = observe` (always-safe)
7. Caches the autonomy level for 5 minutes (fetch called exactly once for two execute calls)
8. Defaults to observe when fetch fails (throw → observe → gates when minimum > observe)

**Mock pattern** (per CLAUDE.md rule):
```typescript
vi.spyOn(globalThis, 'fetch').mockResolvedValue({
  ok: true,
  json: vi.fn().mockResolvedValue({ value: 'observe' }),
} as Response)
```
Use `vi.fn().mockResolvedValue(x)` not `async () => x`.

**Additions to existing per-skill test files** (`describe('autonomy gate', …)` block):

- `memory-consolidation.test.ts` — 3 tests (gated at observe, runs at assist, runs at partner)
- `daily-sweep-skill.test.ts` — 3 tests (same pattern, minimum 'assist')
- `weekly-brief.test.ts` — 2 tests (runs at observe, runs at partner — always-safe)
- `email-compose.test.ts` — 4 tests (gated at observe, gated at assist, runs at advise, runs at partner)

`beforeEach` in all autonomy blocks: `_resetBaseSkillAutonomyCacheForTest()`.

---

### 1.5 — CLAUDE.md autonomy semantics update

**Section to update:** `## Pipeline / workers / skills`

**Current text (one bullet):**
```
- Autonomy levels (`app_settings.autonomy_level`): `observe` (default, notifications only) / `assist` (draft + notify) / `advise` (act + report) / `partner` (autonomous). Check via `meetsAutonomyLevel()` from shared.
```

**Replace with (three bullets + table):**
```
- Autonomy levels (`app_settings.autonomy_level`): `observe` (default, notifications only) / `assist` (draft + notify) / `advise` (act + report) / `partner` (autonomous). Check via `meetsAutonomyLevel(current, required)` from shared — pure sync ordinal comparison. Level fetched from `GET /api/v1/settings/autonomy_level` with a 5-min in-process module-level cache per package (slack-bot: `server.ts`, workers: `base-skill.ts`). Default on error: `observe`.
- **BaseSkill autonomy gate (P05):** `BaseSkill.execute()` checks `static minimum_autonomy` before delegating to `protected abstract run()`. Current level below declared minimum → `execute()` returns `{ status: 'gated', durationMs: 0 }` and logs at INFO. Skills without `static minimum_autonomy` run ungated — reactive pipeline skills (wiki-ingest, extract-entities, stale-captures, etc.) must never declare it. **Never override `execute()` in subclasses — implement `run()`.**
- **Proactive skills autonomy table (P05):**

| Skill | minimum_autonomy | Rationale |
|-------|-----------------|-----------|
| `email-compose` | `advise` | Auto-send email — highest-impact action |
| `memory-consolidation` | `assist` | Merges + soft-deletes captures destructively |
| `daily-sweep-skill` | `assist` | Proactive LLM summary + Pushover delivery |
| `weekly-brief` | `observe` | Informational report — safe at all levels |
| slack-bot `auto-response` | (inline check, not BaseSkill) | Event handler, not a queued skill |
```

---

### 1.6 — LAB_NOTEBOOK Entry 099

Append pre-action entry with Objective / Hypothesis / Rollback (see template in ORCHESTRATOR.md); finalize Result after implementation.

---

## Acceptance criteria (Gate 4 reviewer verifies)

- [ ] `BaseSkill.execute()` is concrete; `protected abstract run()` replaces the former abstract `execute()`. TypeScript compiles (`tsc --noEmit`).
- [ ] All 4 proactive skills declare `static minimum_autonomy` per card.
- [ ] All 20 subclasses + `ConcreteSkill` test helper have `execute()` renamed to `protected run()` with no logic changes.
- [ ] `_resetBaseSkillAutonomyCacheForTest()` exported from `base-skill.ts`.
- [ ] `BaseResult` gains `status?: 'gated'` in `types.ts`.
- [ ] `base-skill-autonomy.test.ts` passes (8 tests).
- [ ] `memory-consolidation.test.ts` +3, `daily-sweep-skill.test.ts` +3, `weekly-brief.test.ts` +2, `email-compose.test.ts` +4 tests pass.
- [ ] slack-bot `auto-response` still works — inline check unchanged (no regression).
- [ ] `pnpm --filter @open-brain/workers run test` passes.
- [ ] `pnpm --filter @open-brain/slack-bot run test` passes.
- [ ] CLAUDE.md has the new autonomy table + "opt-in gate" rule + BaseSkill gate description.
- [ ] LAB_NOTEBOOK Entry 099 present with full pre-action + finalized Result.

---

## Rollback

`git revert <P05 merge sha>` — no data / schema consequence. Skills fall back to previous unguarded behavior. `app_settings.autonomy_level` remains readable (unused). Revert is safe without maintenance window.

---

## Scope drift check

**Card scope matches: YES.**
- 4 named skills exactly in scope.
- execute→run rename is required by the template-method approach (card implies a BaseSkill hook, which requires this).
- BaseResult `status?: 'gated'` addition is a natural consequence of the gated return shape.

**Scope creep to defer (P05.1 candidates):**
- Consolidating slack-bot `auto-response` inline check into BaseSkill hook — auto-response is not a BaseSkill subclass; consolidation is a multi-day refactor and out of P05 scope.
- Adding `minimum_autonomy` to 6 other proactive skills (`daily-connections`, `drift-monitor`, `morning-brief`, `monthly-reflection`, `cost-analysis`, `capture-dedup-sweep`) — open a P05.1 issue.
- Settings page UI for autonomy-level selector — explicit future work.

---

## Scope divergence

None detected. BaseSkill exists; all 4 named skills exist; `meetsAutonomyLevel()` helper exists. The template-method refactor is non-trivial (20+ files) but mechanically straightforward.

---

## Post-merge CLAUDE.md rule candidates (for doc-sweep)

1. **Proactive skills MUST declare `static minimum_autonomy: AutonomyLevel`; reactive pipeline skills MUST NOT. Absence = unconditional execution.**
2. **Never override `execute()` in BaseSkill subclasses — implement `protected run()` instead.**
3. **Gated return shape:** `{ status: 'gated', durationMs: 0, currentAutonomyLevel, requiredAutonomyLevel }`.
4. **Test cache reset:** `_resetBaseSkillAutonomyCacheForTest()` in `beforeEach` for autonomy-gate tests.
5. **Module-level autonomy cache per-package** (not Redis — not a distributed concern).
