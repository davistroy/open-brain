# Implementation Plan: Consolidate LLM Model Assignments into ai-routing.yaml

**Date:** 2026-04-21
**Scope:** Move all hardcoded LLM model references into `config/ai-routing.yaml`, add comprehensive documentation
**Risk:** Low — plumbing changes only, no behavior change for existing features
**Rollback:** `git revert` — no migrations, no schema changes

---

## Phase 1: Agent Skill Model Resolution (Set A — atomic, deploy together)

### 1.1 Add missing task_routing entries to ai-routing.yaml

**File:** `config/ai-routing.yaml`

**Changes:**
- Add `wiki_lint: t1_fast` to task_routing section (currently missing)
- Add `monthly_reflection: t2_quality` to task_routing section (currently missing)
- Change `wiki_ingest: t1_spark` → `wiki_ingest: t1_fast` (skill requires Anthropic provider for runAgent(); t1_spark is openai_compat which won't work)
- Add `models.intent: "gpt-5.4"` to models section (Slack intent router reads this)

**Acceptance:**
- [x] `wiki_lint`, `monthly_reflection` entries present in task_routing
- [x] `wiki_ingest` points to `t1_fast` (Anthropic tier)
- [x] `models.intent` entry present
- [ ] ConfigService loads without error (run unit tests)

### 1.2 Wire configService to wiki-ingest skill

**File:** `packages/workers/src/skills/wiki-ingest.ts`

**Changes:**
- Import `resolveTaskModel`, `ModelResolverError` from `@open-brain/shared`
- Add `private readonly resolvedModel: string | null` and `resolvedTierKey: string | null` fields
- In constructor: if `this.configService` exists, call `resolveTaskModel(this.configService.get('ai'), 'wiki_ingest')` to set `resolvedModel`/`resolvedTierKey`. Log at INFO level.
- If no configService, set both to null.
- In `run()`: use `this.resolvedModel` instead of `this.model`. Throw `ModelResolverError` if null.
- Remove the `opts.model ?? 'claude-haiku-4-5-20251001'` hardcoded default.
- Keep `opts.model` as a test-only escape hatch (same pattern as email-compose).

**Reference:** Follow `packages/workers/src/skills/email-compose.ts` lines 265-310 exactly.

**Acceptance:**
- [x] No hardcoded model string in wiki-ingest.ts
- [x] `resolveTaskModel()` called in constructor
- [x] ModelResolverError thrown if no configService and no opts.model
- [ ] Existing wiki-ingest tests pass (may need mock configService updates)

### 1.3 Wire configService to wiki-lint skill

**File:** `packages/workers/src/skills/wiki-lint.ts`

**Changes:**
- Same pattern as 1.2. Replace `opts.model ?? 'claude-sonnet-4-5-20250929'` with `resolveTaskModel()`.
- Import `resolveTaskModel`, `ModelResolverError` from `@open-brain/shared`.
- Add `resolvedModel`/`resolvedTierKey` fields with constructor resolution.
- Use `resolvedModel` in `run()`.

**Acceptance:**
- [x] No hardcoded model string in wiki-lint.ts
- [x] Old model ID `claude-sonnet-4-5-20250929` removed from codebase
- [ ] Existing tests pass

### 1.4 Wire configService to monthly-reflection skill

**File:** `packages/workers/src/skills/monthly-reflection.ts`

**Changes:**
- Same pattern as 1.2. Replace `opts.model ?? 'claude-sonnet-4-5-20250929'` with `resolveTaskModel()`.
- The `options.model` override in `run()` at line 300 should remain as test escape hatch (same as email-compose).
- Production path: `options.model ?? this.resolvedModel`.

**Acceptance:**
- [x] No hardcoded model string in monthly-reflection.ts
- [x] Old model ID `claude-sonnet-4-5-20250929` removed from codebase
- [ ] Existing tests pass

### 1.5 Pass configService to agent skills in skill-execution worker

**File:** `packages/workers/src/jobs/skill-execution.ts`

**Changes:**
- Find the instantiation blocks for wiki-ingest, wiki-lint, and monthly-reflection.
- Add `configService: opts.configService` to each skill's options (same as email-compose already receives).
- The `opts.configService` is already available in the worker — it's just not being passed through.

**File:** `packages/workers/src/jobs/wiki-ingest-worker.ts`

**Changes:**
- Pass `configService` from worker opts to WikiIngestSkill constructor.
- The worker opts already carry configService from main.ts — just thread it through.

**Acceptance:**
- [x] All 4 agent skills (wiki-ingest, wiki-lint, monthly-reflection, email-compose) receive configService
- [x] Workers start cleanly with no ModelResolverError (YAML entries from 1.1 are present)
- [x] `pnpm --filter @open-brain/workers exec tsc --noEmit` passes

### 1.6 Update tests for new model resolution

**Files:** Test files for wiki-ingest, wiki-lint, monthly-reflection

**Changes:**
- Tests that construct these skills need a mock configService that returns ai-routing config with the appropriate task_routing entries.
- Follow the mock pattern from email-compose tests.
- Tests that pass `opts.model` directly should still work (escape hatch).

**Acceptance:**
- [ ] All worker tests pass: `pnpm --filter @open-brain/workers test`
- [ ] All core-api tests pass: `pnpm --filter @open-brain/core-api test`
- [ ] TypeScript clean: `pnpm --filter @open-brain/workers exec tsc --noEmit`

---

## Phase 2: YAML Documentation Rewrite (Set C — after Phase 1)

### 2.1 Rewrite ai-routing.yaml with comprehensive documentation

**File:** `config/ai-routing.yaml`

**Changes:**
- Add file-level header comment: purpose, who reads it, what breaks on bad edits
- Add `models:` section documentation (embedding config, intent model for Slack)
- Add `model_tiers:` section documentation: each tier with provider type, cost class, fallback chain, and editing guidelines
- Add `task_routing:` section documentation organized by constraint class:
  - **ANTHROPIC ONLY (agent skills)** — wiki_ingest, wiki_lint, monthly_reflection, email_compose. These use `runAgent()` with Anthropic tool_use. MUST point to an Anthropic tier (t1_fast or t2_quality). Routing to t1_spark/t1_jetson/t0_local WILL CRASH at runtime.
  - **JSON MODE REQUIRED** — entity_extraction. Uses `response_format: { type: "json_object" }`. MUST point to an OpenAI-compatible tier (t1_spark, t1_jetson, t0_local). Anthropic tiers do NOT support JSON mode.
  - **CLASSIFICATION (fast, cheap)** — intent, capture, brain_view, voice, confidence, question, email. Small input, single-word output. Route to cheapest/fastest tier.
  - **ROUTINE TASKS (free tier)** — entity_linking, search_synthesis, daily_sweep, daily_connections, drift_monitoring, email_daily_digest. Structured output, moderate complexity. Free tiers handle these well.
  - **QUALITY-CRITICAL (paid)** — governance, weekly_brief. Human-facing synthesis that justifies paid model quality.
- Add `monthly_budget:` section documentation explaining soft/hard limits and circuit breaker behavior
- Per-entry inline comments for any non-obvious assignment

**Acceptance:**
- [ ] Every task_routing entry has a comment explaining its constraint class
- [ ] Agent skills marked "ANTHROPIC ONLY" with explanation
- [ ] JSON mode constraint documented on entity_extraction
- [ ] Cost implications documented per tier
- [ ] ConfigService still loads cleanly (YAML comments don't break parsing)

---

## Verification Checklist (run after all phases)

- [ ] `pnpm --filter @open-brain/workers test` — all tests pass
- [ ] `pnpm --filter @open-brain/core-api test` — all tests pass
- [ ] `pnpm --filter @open-brain/workers exec tsc --noEmit` — TypeScript clean
- [ ] `grep -rn 'claude-sonnet-4-5-20250929\|claude-haiku-4-5-20251001' packages/workers/src/skills/` returns zero hits (no hardcoded models remain)
- [ ] `grep -n 'models.intent\|gpt-5.4' config/ai-routing.yaml` confirms intent model present
- [ ] Local startup test: workers process connects and logs resolved models at INFO level

---

## Out of Scope

- **A71 (memory-consolidation task-key rename):** Related but separate — `search_synthesis` key stays for now
- **Slack-bot ConfigService refactor:** Slack-bot keeps lightweight js-yaml load per CLAUDE.md rule
- **Runtime provider validation:** Could add a check that agent skill tasks point to Anthropic tiers, but comments are sufficient for a single-operator system
- **Changing tier assignments:** This plan consolidates references, not changes routing decisions (except wiki_ingest t1_spark → t1_fast which is a bug fix)
