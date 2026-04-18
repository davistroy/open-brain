# IMPLEMENT_PHASE-P02a.md — Zod Config Validation for ai-routing.yaml

**Phase:** P02a (Wave 1, Bootstrap phase 2)
**Closes:** #102 (subset — cost fields Zod validation only; P02b/P03 close the rest)
**Severity:** Critical
**Estimated effort:** ~1 day
**Dependencies:** None (gates P02b, P03)
**Branch name:** `feat/phase-P02a-zod-config-validation`
**Drift audit date:** 2026-04-18
**Authored by:** Gate 1 phase-planner subagent (Sonnet 4.6)

---

## 1. Scope Drift

Five divergences found. **None invalidate acceptance criteria — PROCEEDED.**

**Drift 1 — Field names are `cost_per_1k_input` / `cost_per_1k_output`, NOT `cost_per_1k_in` / `cost_per_1k_out`.** The P02a card, ORCHESTRATOR.md bootstrap check, and the task brief all use the shorter suffixes. Actual YAML + `ModelTierEntrySchema` (when extended) + `AIModelEntrySchema` all use the full `_input`/`_output`. Every plan reference below uses the authoritative names.

**Drift 2 — `ModelTierEntrySchema` does NOT currently declare cost fields.** `packages/shared/src/types/config.ts` line 78–85 defines the schema with six fields: `provider`, `model`, `base_url`, `max_completion_tokens`, `timeout_ms`, `fallback`. No cost fields. YAML has them on some tiers, but Zod silently strips them — they never reach `ModelTierEntry`. P02a must ALSO extend this schema (not just add a business-rule validator). Without this, P03's `estimateTierCostUsd()` widening would have nothing to read. This amplifies P02a scope modestly but is in the critical path.

**Drift 3 — `ConfigService` is in `packages/shared/src/config/loader.ts`**, NOT `packages/shared/src/services/config-service.ts`. The test file is at `packages/shared/src/config/__tests__/loader.test.ts`. All plan references use the correct path.

**Drift 4 — `estimateTierCostUsd()` is a stub returning 0.** `packages/shared/src/services/llm-gateway.ts` line 38–41. P02a does NOT modify it; that's P03's scope. Confirmed compatible.

**Drift 5 — ORCHESTRATOR.md bootstrap check references `budget.monthly_hard_cap_usd`; actual field is `monthly_budget.hard_limit_usd`.** Doc drift in ORCHESTRATOR.md only; not P02a scope. Deferred to post-bootstrap cleanup.

---

## 2. Current-State Baseline

### 2.1 ai-routing.yaml tier inventory

| Tier key | Provider | `cost_per_1k_input` in YAML | `cost_per_1k_output` in YAML | Exempt (ollama)? |
|---|---|---|---|---|
| `t0_local` | `ollama` | not set | not set | YES — free local |
| `t1_jetson` | `openai_compat` | **not set** | **not set** | NO — needs fix (Work item 3.1) |
| `t1_spark` | `openai_compat` | `0` | `0` | NO — self-declared free |
| `t1_fast` | `anthropic` | `0.0008` | `0.004` | NO — PAID, set |
| `t2_quality` | `anthropic` | `0.003` | `0.015` | NO — PAID, set |

**`t1_jetson` is the single problem tier.** `openai_compat` is not `ollama`, so the validator requires an explicit cost declaration. Jetson is free local GPU — explicit `0` is correct. Must be added to YAML as part of this PR.

**`t1_spark` cost=0 is legitimate** — Qwen 35B on DGX Spark is free. Schema allows explicit zero for `openai_compat` tiers.

### 2.2 `task_routing` completeness

All 30 task→tier mappings reference tiers that exist in `model_tiers`. The existing `validateTaskRouting()` in `ConfigService.load()` warns non-fatally on unknown tiers. P02a upgrades this to a hard throw.

### 2.3 `monthly_budget` current state

`monthly_budget.soft_limit_usd: 20` and `monthly_budget.hard_limit_usd: 35`. Both positive. `AIConfigSchema` has defaults of 30/50 if omitted. Validator requires both explicitly positive and `hard > soft`.

### 2.4 `ConfigService.load()` current flow

`packages/shared/src/config/loader.ts` lines 74–82:
1. `loadOne()` for each of the 4 YAML files → `schema.parse()` (silently strips unknown fields including cost fields)
2. `this.validateTaskRouting()` — non-fatal, logs warnings
3. No cost-field validation exists

The new `validateAiRoutingConfig(config)` call goes after line 81, as a fail-fast throw.

### 2.5 Existing Zod + test patterns

Schemas live in `packages/shared/src/types/config.ts`. Tests in `packages/shared/src/config/__tests__/loader.test.ts` use a temp-dir + fixture-YAML pattern: `tmpdir()` + `mkdirSync` + `writeFileSync` for 4 config files, instantiate `ConfigService`, call `.load()`, assert, cleanup in `afterEach`. P02a tests mirror this exactly.

---

## 3. Work Items

### 3.1 Extend `ModelTierEntrySchema` + add `t1_jetson` cost declaration in YAML

**File:** `packages/shared/src/types/config.ts` (edit `ModelTierEntrySchema` at lines 78–85)

Add two optional fields:

```ts
export const ModelTierEntrySchema = z.object({
  provider: z.enum(['anthropic', 'litellm', 'ollama', 'openai', 'openai_compat', 'deepseek']),
  model: z.string(),
  base_url: z.string().optional(),
  max_completion_tokens: z.number(),
  timeout_ms: z.number(),
  fallback: z.string().nullable().default(null),
  cost_per_1k_input: z.number().optional(),   // NEW
  cost_per_1k_output: z.number().optional(),  // NEW
})
```

Use `.optional()` (not `.default(0)`) — the business-rule validator distinguishes "field absent" from "field explicitly zero". Defaulting would erase that distinction.

**File:** `config/ai-routing.yaml` (add cost declaration for `t1_jetson`):

```yaml
t1_jetson:
  provider: openai_compat
  model: "qwen3.5-4b"
  base_url: "http://192.168.10.58:8080/v1"
  max_completion_tokens: 256
  timeout_ms: 5000
  cost_per_1k_input: 0    # NEW — Jetson is free local GPU
  cost_per_1k_output: 0   # NEW
  fallback: t1_spark
```

**Verification after:** `configService.getModelTier('t1_fast')!.cost_per_1k_input === 0.0008` (previously `undefined`).

### 3.2 New file: `packages/shared/src/services/ai-config-schema.ts`

Pure-function validator module. Takes a parsed `AIConfig` and throws with actionable messages.

```ts
export const PAID_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic', 'openai', 'openai_compat', 'litellm', 'deepseek',
])

export function validateAiRoutingConfig(config: AIConfig): void {
  // Rule 1: Tier cost completeness — paid providers need both cost fields
  //         (explicit 0 allowed; undefined fails)
  // Rule 2: task_routing tiers must exist in model_tiers (hard throw)
  // Rule 3: fallback tier refs must exist in model_tiers (hard throw)
  // Rule 4: monthly_budget.soft_limit_usd > 0, hard_limit_usd > 0, hard > soft
}
```

**Actionable error messages** (operator-readable):

```
Tier 't1_fast' has provider='anthropic' but cost_per_1k_input is undefined.
The budget circuit breaker would be blind to this tier's costs.
Set both cost_per_1k_input and cost_per_1k_output in config/ai-routing.yaml.
```

```
task_routing entry 'entity_extraction' maps to tier 't1_nonexistent' which does not exist in model_tiers.
Add 't1_nonexistent' to model_tiers or update task_routing to reference an existing tier.
```

```
Tier 't1_fast' declares fallback 't0_missing' which does not exist in model_tiers.
Either add 't0_missing' to model_tiers or set fallback: null for 't1_fast'.
```

```
monthly_budget.hard_limit_usd (20) must be greater than monthly_budget.soft_limit_usd (30).
Fix: set hard_limit_usd to a value greater than soft_limit_usd in config/ai-routing.yaml.
```

### 3.3 Hook into `ConfigService.load()`

**File:** `packages/shared/src/config/loader.ts`

After `this.validateTaskRouting(this.configs.ai)` (currently line 81):

```ts
import { validateAiRoutingConfig } from '../services/ai-config-schema.js'

// Inside load(), after line 81:
validateAiRoutingConfig(this.configs.ai)
```

Do NOT call from `reload()` — reloads log-and-keep (existing behavior); fail-fast is startup-only.

### 3.4 Unit tests — 7 failure cases

**File:** `packages/shared/src/config/__tests__/loader.test.ts` (extend, don't replace)

Add a new `describe('ai-routing cost validation')` block. Use the existing temp-dir + fixture YAML pattern.

1. **3.4.1** — paid-provider tier missing `cost_per_1k_input` → throw containing `"cost_per_1k_input"` + `"t1_fast"`
2. **3.4.2** — paid-provider tier has `cost_per_1k_input` but not `cost_per_1k_output` → throw containing `"cost_per_1k_output"` + `"t1_fast"`
3. **3.4.3** — paid-provider tier with explicit `0` cost → does NOT throw (self-declared free)
4. **3.4.4** — `ollama` provider tier with no cost fields → does NOT throw (exempt)
5. **3.4.5** — `task_routing` references non-existent tier → throw containing tier name
6. **3.4.6** — tier's `fallback` references non-existent tier → throw containing fallback name
7. **3.4.7** — `hard_limit_usd <= soft_limit_usd` → throw containing both values

### 3.5 Unit test — production config drift guard

**3.5.1** — Loads the ACTUAL `config/ai-routing.yaml` (not fixture):

```ts
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
const PROD_AI_ROUTING = resolve(__dirname, '../../../../config/ai-routing.yaml')
// In the test: copy into temp dir alongside minimal fixtures for the other 3 files,
// assert service.load() does not throw
```

**Purpose:** future PRs editing `ai-routing.yaml` without matching the schema fail CI — living contract.

### 3.6 Barrel export

**File:** `packages/shared/src/services/index.ts` — add:

```ts
export { validateAiRoutingConfig, PAID_PROVIDERS } from './ai-config-schema.js'
```

Follows existing services barrel pattern. P03 consumes `PAID_PROVIDERS` from this export.

---

## 4. Acceptance Criteria

- [ ] `packages/shared/src/services/ai-config-schema.ts` exists; exports `validateAiRoutingConfig` + `PAID_PROVIDERS`
- [ ] `ModelTierEntrySchema` has `cost_per_1k_input?: number` and `cost_per_1k_output?: number` optional fields
- [ ] `ConfigService.load()` calls `validateAiRoutingConfig()` and throws on violation
- [ ] `config/ai-routing.yaml` `t1_jetson` tier has explicit `cost_per_1k_input: 0` + `cost_per_1k_output: 0`
- [ ] Production `ai-routing.yaml` passes validation (test 3.5.1 green)
- [ ] Startup throws actionable message on paid-provider missing cost field
- [ ] Startup throws on `task_routing` → non-existent tier
- [ ] Startup throws on `fallback` → non-existent tier
- [ ] Startup throws on `hard_limit_usd <= soft_limit_usd`
- [ ] `ollama` provider tiers exempt from cost field requirement
- [ ] All 8 new unit tests green (7 failures + 1 production guard)
- [ ] Existing 283 `@open-brain/shared` tests continue to pass
- [ ] `pnpm --filter @open-brain/shared build` succeeds
- [ ] `pnpm -r test` green
- [ ] LAB_NOTEBOOK entry 093 exists with Hypothesis + Rollback before first commit
- [ ] PR body contains `Closes #102` (partial — full closure after P02b + P03)

---

## 5. Rollback Plan

1. `git revert <squash-sha>` on main — pure TypeScript + config, no DB.
2. `ModelTierEntrySchema` reverts to 6-field form.
3. `ConfigService.load()` reverts to non-fatal `validateTaskRouting()` only.
4. `config/ai-routing.yaml` `t1_jetson` reverts to no-cost-field form (no functional impact).
5. No homeserver compose restart required.
6. P02b + P03 cannot land before P02a re-lands — they depend on `cost_per_1k_input`/`cost_per_1k_output` existing on `ModelTierEntry`.

---

## 6. Test Plan

```bash
# Fast feedback
pnpm --filter @open-brain/shared test

# Target the new/affected file
pnpm --filter @open-brain/shared exec vitest run packages/shared/src/config/__tests__/loader.test.ts

# Regression check — consumers of ModelTierEntry
pnpm -r test

# TS compilation — cost fields exported
pnpm --filter @open-brain/shared build
```

After `load()` with production YAML:
- `getModelTier('t1_fast').cost_per_1k_input === 0.0008` (was `undefined`)
- `getModelTier('t1_spark').cost_per_1k_input === 0`
- `getModelTier('t0_local').cost_per_1k_input === undefined` (ollama, not required)

---

## 7. Homeserver Deploy Notes

P02a is pure code + YAML. No migrations, no compose changes, no new services.

Deploy (batch with next compose-touching phase):

```bash
cd /mnt/user/appdata/open-brain
git pull origin main
docker compose up -d --no-deps core-api workers
```

If `validateAiRoutingConfig` detects a config problem on the homeserver's local `ai-routing.yaml`, the service will refuse to start — intended fail-fast.

Gate 5.5 NOT triggered (no compose/migration changes). Safe to batch.

---

## 8. Operational Rules Candidates

(Implementer appends during Gate 3)

- Paid-provider tiers in `ai-routing.yaml` MUST declare `cost_per_1k_input`/`cost_per_1k_output` (explicit `0` for free endpoints). Startup now fails fast on omission.
- `cost_per_1k_input: 0` is the canonical "free-but-non-ollama" pattern (Jetson, Spark). Do not omit; zero ≠ missing.
- `ModelTierEntry.cost_per_1k_input` is `number | undefined` post-P02a. Consumers (P03 `estimateTierCostUsd` rewrite) must handle `undefined` for ollama tiers as 0.
