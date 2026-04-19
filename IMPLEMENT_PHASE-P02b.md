# IMPLEMENT_PHASE-P02b.md — Migrate all callClaude call sites through gateway; remove callClaude

**Phase:** P02b (Wave 1, Bootstrap phase 3 of 5)
**Closes:** #102 (partial — full closure after P03; PR body MUST use `Closes #102 (partial)` not bare `Closes #102`)
**Severity:** Critical
**Estimated effort:** ~1.5–2 days (scope expanded from 1–1.5 — see Scope Drift)
**Dependencies:** P02a (merged `e8f7c52` — `ModelTierEntry` cost fields + Zod validator live)
**Branch name:** `feat/phase-P02b-callclaude-removal`
**Drift audit date:** 2026-04-18
**Authored by:** Gate 1 phase-planner subagent (Sonnet 4.6)

---

## 1. Scope Drift

Five divergences found. **None invalidate acceptance criteria — PROCEEDED with expanded scope.**

### DRIFT-1: 6 callClaude call sites across 5 files (plan card named only 2)

`grep -r "callClaude" packages/workers/src` returns 6 matches across 5 files:

| File | Line(s) | Gateway path already exists? |
|---|---|---|
| `packages/workers/src/skills/memory-consolidation.ts` | 360 | Yes (L350) |
| `packages/workers/src/skills/weekly-brief.ts` | 99 | Yes (L90) |
| `packages/workers/src/skills/daily-connections.ts` | 152 | Yes (L142) |
| `packages/workers/src/skills/daily-sweep-skill.ts` | 166 | Yes (L156) |
| `packages/workers/src/skills/drift-monitor.ts` | 174 | Yes (L164) |
| `packages/workers/src/jobs/extract-entities.ts` | 138, 181 | Yes (L130, L173 — primary + retry) |

**All 6 consumers already have the gateway-first `if (this.llmGateway)` code path.** `callClaude` is dead-code fallback only activated when `llmGateway` is `null`. P02b hardens each skill to use gateway-or-litellm-fallback (no Anthropic SDK direct path).

### DRIFT-2: `call-claude.ts` lives in `packages/shared`, not `packages/workers/src/lib/`

Plan card said `packages/workers/src/lib/call-claude.ts`. Actual location: `packages/shared/src/services/call-claude.ts`, exported via `packages/shared/src/services/index.ts` line 3. Sibling test file: `packages/shared/src/services/__tests__/call-claude.test.ts` (~14 tests).

### DRIFT-3: memory-consolidation uses task key `'search_synthesis'`, not `'memory_consolidation'` (flag, defer)

`ai-routing.yaml` `task_routing` has no `memory_consolidation` entry. The skill's gateway path calls `completeByTask(..., 'search_synthesis', ...)` — so it works today but audit log records `task_type: 'search_synthesis'` for consolidation runs (semantic mismatch). Deferred to a dedicated follow-up (Action Item A71); P02b does NOT add the new routing key.

### DRIFT-4: memory-consolidation has NO existing unit test

`packages/workers/src/__tests__/` has `weekly-brief.test.ts` but no `memory-consolidation.test.ts`. Must write new.

### DRIFT-5: weekly-brief tests mock `litellmClient`, not `callClaude` directly

Existing `weekly-brief.test.ts` injects `skill.litellmClient = mockLitellm` (no `llmGateway`). Tests pass because skill falls through to litellmClient when gateway is absent. Post-P02b, that fallback path is preserved. New tests must be added for the gateway-injected path.

---

## 2. Current-State Baseline

### 2.1 callClaude call site inventory (exhaustive)

| File | Line | Task name used in gateway path | callClaude options used |
|---|---|---|---|
| `skills/memory-consolidation.ts` | 360 | `'search_synthesis'` | `model: modelAlias`, `maxTokens: 2048`, `temperature: 0.2` |
| `skills/weekly-brief.ts` | 99 | `'weekly_brief'` | `model: modelAlias`, `maxTokens: 2048`, `temperature: 0.3` |
| `skills/daily-connections.ts` | 152 | `'daily_connections'` | `model: modelAlias`, `maxTokens: 2048`, `temperature: 0.4` |
| `skills/daily-sweep-skill.ts` | 166 | `'daily_sweep'` | `model: modelAlias`, `maxTokens: 2048`, `temperature: 0.3` |
| `skills/drift-monitor.ts` | 174 | `'drift_monitoring'` | `model: modelAlias`, `maxTokens: 2048`, `temperature: 0.3` |
| `jobs/extract-entities.ts` | 138, 181 | `'entity_extraction'` | `model: synthesisModel`, `maxTokens: 1024`, `temperature: 0.1` |

**Source:** `packages/shared/src/services/call-claude.ts` + `packages/shared/src/services/index.ts:3`. Test file: `packages/shared/src/services/__tests__/call-claude.test.ts` (~14 tests).

### 2.2 callClaude vs completeByTask capability analysis

| Feature | callClaude | completeByTask | Used by any consumer? |
|---|---|---|---|
| Single user prompt | ✓ | ✓ | Yes |
| Multi-turn messages | ✓ | ✗ | No |
| System prompt | ✓ | ✗ | No |
| Temperature, maxTokens | ✓ | ✓ | Yes |
| JSON mode | ✗ | ✓ | No (today) |
| Abort signal | ✓ | ✗ | No |
| Token usage return | ✓ | ✗ (only string) | Only for log, not logic |
| Same-tier retry | ✗ | ✓ | — |
| Audit log write | ✗ | ✓ | **Whole point of migration** |

**Zero capability gaps for the patterns actually used.**

### 2.3 task_routing coverage in ai-routing.yaml

| Task | Tier | Provider | Cost |
|---|---|---|---|
| `search_synthesis` | `t1_spark` | openai_compat | free |
| `weekly_brief` | `t2_quality` | anthropic | paid |
| `daily_sweep` | `t1_spark` | openai_compat | free |
| `daily_connections` | `t1_spark` | openai_compat | free |
| `drift_monitoring` | `t1_spark` | openai_compat | free |
| `entity_extraction` | `t1_spark` | openai_compat | free |

`memory_consolidation` absent (uses `search_synthesis` — DRIFT-3). No routing changes required for P02b acceptance.

### 2.4 Test baseline state

- `packages/workers` tests: 948/948 (post-P02a)
- `packages/shared` tests: 291/291 (post-P02a)
- After P02b: workers stays 948/948 (+ at least 1 new memory-consolidation test file, + 1 new weekly-brief gateway test); shared drops to ~277 after deleting `call-claude.test.ts`

---

## 3. Work Items

### 0. LAB_NOTEBOOK Entry 094 (BEFORE first commit — CLAUDE.md Rule 1 + Rule 11)

Hypothesis, Rollback Plan, Risk (Qwen 35B output format may differ from Claude Haiku — fixture regression test in Work Item 8/9 validates).

### 1. Remove callClaude from memory-consolidation.ts

**File:** `packages/workers/src/skills/memory-consolidation.ts`

- Remove `callClaude` from `@open-brain/shared` import at L4.
- In `callLLM()` method (L334–390): keep `if (this.llmGateway)` branch (L349–356); delete the `if (this.anthropicClient) { await callClaude(...) }` branch (L358–370); retain `litellmClient` fallback for test compatibility.
- Remove `modelAlias` from `MemoryConsolidationOptions` interface + `execute()` destructure (dead after removal).
- `executeMemoryConsolidation()` function: drop `anthropicClient?` parameter.
- Update `skill-execution.ts` `'memory-consolidation'` case to stop passing `anthropicClient`.
- Add TODO comment in `callLLM()` noting DRIFT-3 (task name `search_synthesis` should become `memory_consolidation` in A71 follow-up).

### 2. Remove callClaude from weekly-brief.ts

Same pattern as (1). Location: `packages/workers/src/skills/weekly-brief.ts`.
- Remove `callClaude` from import (L3).
- Delete `if (this.anthropicClient)` / `callClaude(...)` branch (L98–104).
- Retain `litellmClient` fallback (L106–113).
- Remove `modelAlias` from `WeeklyBriefOptions` (defined in `weekly-brief-query.ts`).
- Drop `anthropicClient?` from `executeWeeklyBrief()` signature.

### 3. Remove callClaude from daily-connections.ts

Location: `packages/workers/src/skills/daily-connections.ts`.
- Remove `callClaude` import (L3).
- Delete anthropicClient/callClaude branch (L151–162).
- Retain `litellmClient` fallback (L164–178).
- `modelAlias` cleanup + `executeDailyConnections()` signature update.

### 4. Remove callClaude from daily-sweep-skill.ts

Location: `packages/workers/src/skills/daily-sweep-skill.ts`.
- Remove callClaude import (L3).
- Delete anthropicClient/callClaude branch (L165–176).
- Retain litellmClient fallback.
- `modelAlias` cleanup + `executeDailySweep()` signature update.

### 5. Remove callClaude from drift-monitor.ts

Location: `packages/workers/src/skills/drift-monitor.ts`.
- Remove callClaude import (L3).
- Delete anthropicClient/callClaude branch (L173–184).
- Retain litellmClient fallback.
- `modelAlias` cleanup + `executeDriftMonitor()` signature update.

### 6. Remove callClaude from extract-entities.ts

Location: `packages/workers/src/jobs/extract-entities.ts`. Two call sites (primary + retry).
- Remove callClaude from import destructure (L7).
- Primary (L129–157): three-way `gateway / anthropicClient / litellmClient` becomes two-way `gateway / litellmClient`. Delete anthropicClient branch (L137–144).
- Retry (L172–196): same simplification. Delete anthropicClient branch (L180–185).
- `processExtractEntitiesJob()` signature: drop `anthropicClient?: Anthropic | null`.
- `createExtractEntitiesWorker()` (L283–349): remove "Using Anthropic Claude for entity extraction (legacy)" log branch + `anthropicClient` parameter if no external callers need it. Check `packages/workers/src/main.ts` + `index.ts` during implementation.

### 7. Gateway-injection hardening in skill-execution.ts

**File:** `packages/workers/src/jobs/skill-execution.ts`

- For all 5 skill cases: remove `anthropicClient: opts.anthropicClient` from opts passed to `runSkill()`.
- Remove `modelAlias: synthesisModel` from each case (dead after work items 1–5).
- Add soft warning at worker body top: `if (!opts.llmGateway) { logger.error('[skill-execution] LLMGatewayService not configured — LLM skills will fail at runtime') }`.

### 8. New memory-consolidation.test.ts

**File:** `packages/workers/src/__tests__/memory-consolidation.test.ts` (new). Mirror `weekly-brief.test.ts` structure.

Test cases:
1. Gateway path: `completeByTask('search_synthesis', ...)` is called; `should_merge: true` produces `newCaptureId`
2. Gateway path: `should_merge: false` skips merge
3. JSON parse failure safety valve returns `should_merge: false` (no throw)
4. Empty cluster case: no LLM call when `clusters.length === 0`
5. Gateway response shape assertion (structural behavioral regression)

Audit log assertion is deferred to integration-test scope (unit test mocks the entire gateway, so internal audit write doesn't fire).

### 9. Extend weekly-brief.test.ts with gateway-mock path

**File:** `packages/workers/src/__tests__/weekly-brief.test.ts`

Add `makeSkillWithGateway()` helper + `makeMockGateway()` alongside existing helpers. New describe block `'execute — via LLMGateway'`:
1. `completeByTask('weekly_brief', ...)` is called when gateway is injected
2. Returns correct `WeeklyBriefResult` shape
3. `litellmClient.create` is NOT called when gateway is injected

### 10. Update extract-entities.test.ts gateway mock path

**File:** `packages/workers/src/__tests__/extract-entities.test.ts`

Read structure during implementation. Remove any `callClaude` / `anthropicClient` mock. Ensure both gateway-injected and litellm-fallback paths are covered.

### 11. Delete source files (LAST — after all migrations + tests pass)

1. Delete `packages/shared/src/services/call-claude.ts`
2. Delete `packages/shared/src/services/__tests__/call-claude.test.ts`
3. Edit `packages/shared/src/services/index.ts` line 3 — remove `export * from './call-claude.js'`

**Sequence matters:** delete last, so any missed consumer surfaces as a build error.

### 12. Grep verification (final step before commit)

```bash
grep -r "callClaude" packages/workers/src packages/shared/src
grep -r "call-claude" packages/workers/src packages/shared/src
```

Both must return zero matches (or only unrelated comments).

### 13. Update operational docs

- Add P02b rule to CLAUDE.md: "callClaude removed in P02b — all LLM skills require `llmGateway` injection; direct Anthropic SDK path in skills is GONE. `litellmClient` is the test-compat fallback only."
- Add Action Item A71 for `memory_consolidation` task-name rename follow-up.
- Note that shared test baseline drops 291 → ~277 (delete of `call-claude.test.ts`).

---

## 4. Acceptance Criteria

- [ ] `callClaude` appears zero times in `packages/workers/src/**/*.ts` and `packages/shared/src/**/*.ts` (production + test files)
- [ ] `call-claude` import path appears zero times in any `*.ts` file
- [ ] All 5 skills + extract-entities job use `llmGateway.completeByTask` on the primary path (when gateway injected) — verified by test
- [ ] New `memory-consolidation.test.ts` covers gateway path + 4 additional scenarios (should_merge false, JSON parse fail, empty cluster, output structure regression)
- [ ] `weekly-brief.test.ts` has a new gateway-mock test asserting `completeByTask('weekly_brief', ...)` is invoked
- [ ] Workers test suite: 948/948 baseline maintained (net zero regression; new tests add to count but prior count stays green)
- [ ] Shared test suite: expected drop to ~277 (from 291) after `call-claude.test.ts` deletion; no OTHER shared tests fail
- [ ] `pnpm --filter @open-brain/workers build` + `pnpm --filter @open-brain/shared build` succeed (compile)
- [ ] LAB_NOTEBOOK Entry 094 exists with Hypothesis + Rollback BEFORE first commit
- [ ] PR body uses `Closes #102 (partial — full closure after P03)` (P02b does NOT bare-close #102)
- [ ] CLAUDE.md has new rule about callClaude removal
- [ ] Action Item A71 added for `memory_consolidation` task-name rename

---

## 5. Rollback Plan

1. `git revert <squash-sha>` — restores `call-claude.ts` + its export + all skill fallback branches
2. Workers + shared tests return to pre-P02b baseline (948 + 291)
3. No DB migrations, no compose changes
4. Homeserver revert: `git pull && docker compose up -d workers`
5. Create git tag `pre-p02b-callclaude-removal` at HEAD before merge for quick reference

---

## 6. Test Plan

```bash
# Targeted new tests
pnpm --filter @open-brain/workers exec vitest run src/__tests__/memory-consolidation.test.ts
pnpm --filter @open-brain/workers exec vitest run src/__tests__/weekly-brief.test.ts
pnpm --filter @open-brain/workers exec vitest run src/__tests__/extract-entities.test.ts

# Regression
pnpm --filter @open-brain/workers test
pnpm --filter @open-brain/shared test

# Build
pnpm --filter @open-brain/workers build
pnpm --filter @open-brain/shared build

# Grep verification
grep -r "callClaude" packages/workers/src packages/shared/src
grep -r "call-claude" packages/workers/src packages/shared/src
```

---

## 7. Homeserver Deploy Notes

No compose/migration changes. Batch with A70.

```bash
git pull
docker compose up -d workers
docker compose logs --tail=50 workers
```

Verification:
- Next memory-consolidation run (Sun 4 AM) logs `[memory-consolidation] LLM call complete (gateway)` NOT `(Claude)`
- `ai_audit_log` gets a row per skill run with populated `tier_key`

```sql
SELECT task_type, COUNT(*), SUM(cost_usd::numeric)
FROM ai_audit_log WHERE created_at > NOW() - INTERVAL '1 week'
GROUP BY task_type;
```

---

## 8. Operational Rules Candidates (Implementer captures during Gate 3)

- `callClaude` removed in P02b (2026-04-18) — all LLM skills require `llmGateway` injection. `litellmClient` fallback retained only for test compatibility.
- `memory-consolidation` routes via `'search_synthesis'` task key (naming mismatch, A71 follow-up). Do not "fix" the task name in a drive-by edit — it requires adding a new `task_routing` entry in `ai-routing.yaml` + coordinating tier mapping.
- `completeByTask` writes `ai_audit_log` automatically. Skills must not add manual audit writes.
