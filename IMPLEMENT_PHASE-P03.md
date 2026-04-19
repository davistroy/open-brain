# IMPLEMENT_PHASE-P03.md — Cost estimator widening + Composio quota meter

**Phase:** P03 (Wave 1, **FINAL BOOTSTRAP PHASE** — 5 of 5)
**Refs:** #102 (partial — final subset; manually close #102 after this merges per A72 convention)
**Closes:** #106 (sole PR)
**Severity:** 1 Critical (#102) + 1 High (#106)
**Estimated effort:** ~1 day
**Dependencies:** P02a merged (`ModelTierEntry` cost fields + `PAID_PROVIDERS` export), P02b merged (callClaude gone; all routes through gateway), P02c merged (`effectiveTierKey` for final-tier audit)
**Branch name:** `feat/phase-P03-estimator-composio-quota`
**Drift audit date:** 2026-04-19
**Base HEAD:** `65d9701` (clean tree, P02c doc sweep)
**Authored by:** Gate 1 phase-planner subagent (Sonnet 4.6)
**Bootstrap exit:** After merge, `bootstrap_mode` flips to false and normal ORCHESTRATOR.md approval matrix applies.

---

## 1. Scope Drift

**PROCEEDED** — 4 drift items cleared, none invalidating acceptance:

### DRIFT-1: Plan card uses stale field names `cost_per_1k_in` / `cost_per_1k_out`

Actual fields (post-P02a): `cost_per_1k_input` / `cost_per_1k_output`. Plan references authoritative names throughout.

### DRIFT-2: Config-contract test is fully redundant — P02a covers it

`validateAiRoutingConfig()` + the existing production drift-guard test (`loader.test.ts:690`) already enforce: paid-provider tiers must have both cost fields; ollama exempt; `task_routing` entries must map to valid tiers; `fallback` chain integrity; budget positivity/ordering. Adding a separate `config-contract.test.ts` creates noise without coverage value.

**Adjustment:** Omit the separate test file. `mkTier` fixture in `llm-gateway.test.ts` gets updated to allow cost-field pass-through for the new estimator tests.

### DRIFT-3: Composio "middleware" is actually a guard method on `ComposioClient.execute()`

Plan card's "middleware hard-stop at 19K via middleware" suggests HTTP middleware. Reality: the single choke point is `ComposioClient.execute()` in `packages/shared/src/services/composio-client.ts`. There's no HTTP layer to intercept. The quota-guard lives inside the client.

**Only one production caller:** `packages/workers/src/skills/morning-brief.ts` → `fetchCalendarEvents()` instantiates `new ComposioClient(composioKey)` and calls `client.execute('OUTLOOK_LIST_CALENDARS', …)`. `COMPOSIO_MULTI_EXECUTE_TOOL` in Claude Code's ambient MCP server list is **external** (Composio's cloud) — NOT meter-scoped.

### DRIFT-4: `@open-brain/shared` does not depend on `ioredis`

Adding `ioredis` as a runtime dependency of `shared` is heavy. Better: accept an optional Redis client via constructor (duck-typed), keeps the client testable without Redis and lets workers inject their existing client.

### DRIFT-5: Current `estimateTierCostUsd` already accepts token params (as `_` dummies)

Signature: `(clientUsed: AIClientType, _promptTokens: number, _completionTokens: number): number`. Call sites at line 351 and 821 already pass real token values. Widening = drop `clientUsed`, add `tier: ModelTierEntry | undefined`, use the tokens.

---

## 2. Current-State Baseline

### 2.1 `estimateTierCostUsd` stub

Lines 38-41 of `llm-gateway.ts`:

```ts
function estimateTierCostUsd(clientUsed: AIClientType, _promptTokens: number, _completionTokens: number): number {
  if (clientUsed === 'ollama' || clientUsed === 'anthropic') return 0
  return 0
}
```

**Call sites:**
- Line 351 (`completeWithTierFallback`): `const costUsd = estimateTierCostUsd(client, promptTokens, completionTokens)` — `tier` already in scope
- Line 821 (`recordAgentCompletion`): same pattern; `tier = this.configService.getModelTier(effectiveTierKey)` in scope

### 2.2 `ai-routing.yaml` cost coverage

| Tier | Provider | input | output |
|---|---|---|---|
| `t0_local` | ollama | (absent) | (absent) |
| `t1_jetson` | openai_compat | 0 | 0 |
| `t1_spark` | openai_compat | 0 | 0 |
| `t1_fast` | anthropic | 0.0008 | 0.004 |
| `t2_quality` | anthropic | 0.003 | 0.015 |

All valid per P02a validator. No YAML changes needed.

### 2.3 Composio invocation

**Single caller:** `packages/workers/src/skills/morning-brief.ts` via `fetchCalendarEvents(composioKey, now)`. ~25 calls/week = ~100/month (well below 20K cap). Meter is defensive.

**Dispatch path:** scheduler → `skill-execution.ts` `case 'morning-brief'` → `runSkill(MorningBriefSkill)` → `execute()` → `fetchCalendarEvents()` → `new ComposioClient(composioKey).execute(...)`.

### 2.4 Existing Redis pattern

`packages/workers/src/main.ts` instantiates a `dedupRedis` (ioredis) with `lazyConnect: true`, parsed from `REDIS_URL`. Same pattern for BullMQ. P03 adds a dedicated `composioMeterRedis` following the same shape.

### 2.5 Pushover API

`PushoverService.send({ title, message, priority })`. Priority 1 is high-but-not-emergency. Reuse as-is.

### 2.6 Test fixture impact

`mkTier()` in `llm-gateway.test.ts` doesn't currently forward cost fields. Need to extend so new estimator tests can specify costs. Existing tests (that don't care about cost) keep passing because `undefined ?? 0 === 0`.

---

## 3. Work Items

### 3.1 Widen `estimateTierCostUsd()` — read costs from tier

**File:** `packages/shared/src/services/llm-gateway.ts`

```ts
function estimateTierCostUsd(
  tier: ModelTierEntry | undefined,
  promptTokens: number,
  completionTokens: number,
): number {
  if (!tier) return 0
  const inputCost = tier.cost_per_1k_input ?? 0
  const outputCost = tier.cost_per_1k_output ?? 0
  if (inputCost === 0 && outputCost === 0) {
    // Belt-and-suspenders: if a paid-provider tier somehow has undefined costs,
    // warn so we notice (P02a validator should catch this at startup).
    if (tier.cost_per_1k_input === undefined && PAID_PROVIDERS.has(tier.provider)) {
      logger.warn({ tier: tier.model, provider: tier.provider },
        '[llm-gateway] paid-provider tier has undefined cost — audit will be 0; check P02a validator')
    }
    return 0
  }
  return (promptTokens / 1000) * inputCost + (completionTokens / 1000) * outputCost
}
```

Import: `import { PAID_PROVIDERS } from './ai-config-schema.js'`

**Update both call sites** to pass `tier` instead of `clientUsed`:
- Line 351: `const costUsd = estimateTierCostUsd(tier, promptTokens, completionTokens)`
- Line 821: `const costUsd = estimateTierCostUsd(tier, result.tokenUsage.input, result.tokenUsage.output)`

Update JSDoc above the function.

### 3.2 Add estimator tests to `llm-gateway.test.ts`

**File:** `packages/shared/src/services/__tests__/llm-gateway.test.ts`

Extend `mkTier` factory to forward cost fields:

```ts
function mkTier(overrides: Partial<ModelTierEntry> & { model: string; provider: ModelTierEntry['provider'] }): ModelTierEntry {
  return {
    ...existing fields,
    cost_per_1k_input: overrides.cost_per_1k_input,
    cost_per_1k_output: overrides.cost_per_1k_output,
    ...overrides,
  }
}
```

Add test cases (testing `estimateTierCostUsd` indirectly via `recordAgentCompletion`'s audit row):

- **A: Paid-provider tier with costs produces non-zero `cost_usd`** — anthropic with `0.003/0.015`, tokens `{input: 1000, output: 500}` → `cost_usd === '0.0105'`
- **B: `openai_compat` tier with explicit `0,0` produces `cost_usd === '0'`**
- **C: Ollama tier (undefined cost fields) produces `cost_usd === '0'`**

### 3.3 Add `ComposioQuotaExceededError` + constants to `composio-client.ts`

**File:** `packages/shared/src/services/composio-client.ts`

```ts
export class ComposioQuotaExceededError extends Error {
  constructor(count: number) {
    super(`Composio monthly quota hard stop: ${count} calls used (limit: 19,000). No further Composio calls this month.`)
    this.name = 'ComposioQuotaExceededError'
  }
}

const COMPOSIO_MONTHLY_HARD_STOP = 19_000
const COMPOSIO_WARN_THRESHOLD = 15_000
```

### 3.4 Extend `ComposioClient` constructor — optional Redis + Pushover injection

Add options-object form. Keep the string-only form for backward compat:

```ts
export interface ComposioClientOptions {
  apiKey?: string
  redis?: { incr: (k: string) => Promise<number>; expire: (k: string, s: number) => Promise<unknown> }  // duck-typed ioredis subset
  pushover?: PushoverService
}

constructor(apiKeyOrOptions?: string | ComposioClientOptions) {
  if (typeof apiKeyOrOptions === 'string' || apiKeyOrOptions === undefined) {
    this.apiKey = apiKeyOrOptions ?? process.env.COMPOSIO_API_KEY ?? ''
  } else {
    this.apiKey = apiKeyOrOptions.apiKey ?? process.env.COMPOSIO_API_KEY ?? ''
    this.redis = apiKeyOrOptions.redis
    this.pushover = apiKeyOrOptions.pushover
  }
  this.url = COMPOSIO_URL
}
```

**Duck-typed `redis`:** avoids adding `ioredis` as a runtime dependency of `@open-brain/shared`. Any ioredis client satisfies the `{incr, expire}` structural type. Tests can inject a minimal mock.

### 3.5 Add `checkAndIncrementQuota()` method + hook into `execute()`

```ts
private getMonthlyKey(): string {
  const now = new Date()
  return `composio:monthly_usage:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

private async checkAndIncrementQuota(): Promise<void> {
  if (!this.redis) return   // no-op backward compat
  const key = this.getMonthlyKey()
  const count = await this.redis.incr(key)
  if (count === 1) {
    await this.redis.expire(key, 35 * 24 * 60 * 60).catch(() => {})   // ~5 weeks TTL
  }
  if (count > COMPOSIO_MONTHLY_HARD_STOP) {
    logger.warn({ count, limit: COMPOSIO_MONTHLY_HARD_STOP }, '[composio] hard stop reached')
    await this.pushover?.send({
      title: 'Composio Quota: BLOCKED',
      message: `Hard stop at ${count} calls (limit ${COMPOSIO_MONTHLY_HARD_STOP}).`,
      priority: 1,
    }).catch(() => {})
    throw new ComposioQuotaExceededError(count)
  }
  if (count === COMPOSIO_WARN_THRESHOLD) {
    logger.warn({ count }, '[composio] 75% monthly quota used')
    await this.pushover?.send({
      title: 'Composio Quota Warning',
      message: `${count} / 20,000 calls used (75%). Hard stop at ${COMPOSIO_MONTHLY_HARD_STOP}.`,
      priority: 1,
    }).catch(() => {})
  }
}
```

Hook into `execute()` as the FIRST line (before `ensureInitialized`):

```ts
async execute(toolSlug: string, args: Record<string, string>) {
  await this.checkAndIncrementQuota()   // throws on > hard stop
  await this.ensureInitialized()
  // ... rest unchanged
}
```

**Design decisions:**
- INCR before the call, not after — prevents quota escape under concurrent calls.
- Initialize handshake not counted — only `tools/call` is.
- Pushover failure swallowed — never block the actual Composio call on notification failure.

### 3.6 Wire Redis + Pushover into `morning-brief` path

**File:** `packages/workers/src/main.ts` — add dedicated meter Redis:

```ts
const composioMeterRedis = new Redis({ ...connection, maxRetriesPerRequest: 3, lazyConnect: true })
await composioMeterRedis.connect()
```

Pass to `skill-execution.ts`'s `case 'morning-brief'`. Add graceful-shutdown: `await composioMeterRedis.quit().catch(() => {})`.

**File:** `packages/workers/src/skills/morning-brief.ts`

Extend `MorningBriefSkillOpts` with `composioRedis?: Redis` + `composioPushover?: PushoverService`. Store on the class. Pass to `fetchCalendarEvents` via new `options?` parameter.

**File:** `fetchCalendarEvents` signature:

```ts
export async function fetchCalendarEvents(
  composioKey: string,
  now: Date,
  options?: { redis?: Redis; pushover?: PushoverService },
): Promise<{ primary: CalendarEvent[]; reference: CalendarEvent[] }> {
  const client = new ComposioClient({
    apiKey: composioKey,
    redis: options?.redis,
    pushover: options?.pushover,
  })
  // ... rest unchanged
}
```

### 3.7 Add unit tests for quota guard

**File:** `packages/shared/src/services/__tests__/composio-quota.test.ts` (new)

Mock Redis (`{ incr: vi.fn(), expire: vi.fn() }`) + Pushover (`{ send: vi.fn() }`). Mock `execute()`'s internal HTTP via `vi.spyOn(global, 'fetch')` or by stubbing `ensureInitialized` + `mpcCall`.

Test cases:
- **A**: counter increments on first call; TTL set
- **B**: TTL NOT set on count > 1
- **C**: Pushover warn fires at exactly 15_000
- **D**: `ComposioQuotaExceededError` thrown at 19_001
- **E**: No Redis injected → execute proceeds normally (backward compat)
- **F**: Pushover failure doesn't block execute (error swallowed)

### 3.8 CLAUDE.md operational rules

**File:** `CLAUDE.md` — add two bullets after the Composio guidance block:

- **`estimateTierCostUsd()` reads from tier config as of P03** — multiplies tokens by `tier.cost_per_1k_input`/`cost_per_1k_output` ÷ 1000. Undefined → 0 (ollama path). Paid-provider + both fields 0 → explicit-free (Jetson/Spark). `ai_audit_log.cost_usd` now reflects real cost for Anthropic tiers. Do not re-add provider-allowlist logic — tier config is the single source of truth.
- **Composio quota meter active (P03)** — `ComposioClient.execute()` increments Redis `composio:monthly_usage:YYYY-MM` on every call. Hard stop throws `ComposioQuotaExceededError` at 19,000 (95% of 20K/month free tier). Pushover warn at 15,000 (75%). Only active when Redis injected via constructor's options form. New Composio callers in workers MUST pass the meter Redis + Pushover from `main.ts`.

---

## 4. Acceptance Criteria

- [ ] `estimateTierCostUsd()` reads costs from `ModelTierEntry`; returns non-zero for paid-provider tiers with populated costs; returns 0 for ollama (undefined) and explicit-zero tiers
- [ ] `ai_audit_log.cost_usd > 0` for anthropic completions (verifiable post-deploy via SQL)
- [ ] `ai_audit_log.cost_usd = '0'` for ollama/t1_jetson/t1_spark — no regression
- [ ] 3 new estimator tests added (A/B/C in 3.2) + `mkTier` factory extended for cost fields
- [ ] `ComposioQuotaExceededError` class exported from `composio-client.ts`
- [ ] `ComposioClient.execute()` increments Redis counter atomically + hard-stops at 19K + warns Pushover at 15K
- [ ] Backward compat: `new ComposioClient(apiKey)` (string form) still works; no Redis injected → no quota enforcement
- [ ] 6 new composio-quota tests (A–F in 3.7)
- [ ] `morning-brief` path wires meter Redis + Pushover from `main.ts` through the skill to `fetchCalendarEvents` to `ComposioClient`
- [ ] Graceful shutdown quits `composioMeterRedis` cleanly
- [ ] `pnpm --filter @open-brain/shared test`: 277/277 + 3 + 6 = 286/286
- [ ] `pnpm --filter @open-brain/workers test`: 960/960 (unchanged, assuming morning-brief tests don't regress)
- [ ] `pnpm -r test`: no regression
- [ ] `CLAUDE.md` updated with 2 new rules
- [ ] PR body uses `Refs #102` (not `Closes`) + `Closes #106`
- [ ] LAB_NOTEBOOK Entry 096 with Hypothesis + Rollback before first commit

---

## 5. Rollback Plan

**Estimator revert:** `git revert`. All `ai_audit_log` rows with `cost_usd > 0` (post-P03) remain accurate historical data — no corruption. Pre-P03 rows unaffected. Local `queryLocalMonthlySpend()` returns 0 for pre-P03 rows (existing behavior). No schema changes.

**Composio meter revert:** Additive; remove meter Redis injection from `main.ts` and `skill-execution.ts` case. `ComposioClient` still works (backward-compat constructor). Redis keys `composio:monthly_usage:*` become inert until TTL expires. `ComposioQuotaExceededError` class can stay (unused but harmless).

**Single-commit atomic revert** preferred.

---

## 6. Test Plan

```bash
pnpm --filter @open-brain/shared build
pnpm --filter @open-brain/shared test
pnpm --filter @open-brain/workers build
pnpm --filter @open-brain/workers test
pnpm -r test   # full regression
```

**Post-deploy manual verification (homeserver):**
```sql
-- After next morning-brief run (or an explicit Anthropic call)
SELECT task_type, model, client_used, cost_usd, prompt_tokens, completion_tokens
FROM ai_audit_log
WHERE client_used = 'anthropic'
ORDER BY created_at DESC LIMIT 5;
-- Expect: cost_usd > 0 (previously always 0)
```

```bash
# Composio counter check
docker exec open-brain-redis redis-cli GET "composio:monthly_usage:2026-04"
# Expect: numeric count incrementing as morning-brief runs
```

---

## 7. Homeserver Deploy Notes

**No Docker Compose changes.** Uses existing `REDIS_URL` env var. No migration.

Deploy (batch with A70):
```bash
cd /mnt/user/appdata/open-brain
git pull origin main
docker compose up -d workers core-api
docker compose logs --tail=50 workers | grep -i "composio\|quota"
```

Expected: `"Composio quota meter Redis initialized"` log line on workers startup.

---

## 8. PR Body Convention (A72 applied)

- `Refs #102` (NOT `Closes`) — P02a and P02b attempted partial closes; prevent another auto-close / reopen cycle. Manually close #102 via comment after this PR merges.
- `Closes #106` — sole PR for Composio quota; bare close is safe.

---

## 9. Operational Rules Candidates (for CLAUDE.md — inline per 3.8)

See Work Item 3.8 above. Two bullets; inline-add to CLAUDE.md is the right call (rules activate at P03 merge; same logic as P02a's 3-rule inline capture).

---

## 10. Top 3 Risks

1. **`mkTier` factory doesn't forward cost fields** — any new paid-provider test would silently produce $0 if the factory isn't extended. Work Item 3.2 addresses this explicitly.
2. **`fetchCalendarEvents()` constructs `ComposioClient` internally** — without the signature change in 3.6, injection path is broken. Implementer must update the function signature + the caller in `morning-brief.ts`.
3. **Concurrent INCR race at the 15K warning threshold** — two parallel calls could both INCR past 15K without either observing count === 15_000 exactly. Single-user system means practical impact is near zero; document in the test that threshold is best-effort. Hard-stop at 19K uses `> HARD_STOP` (not `===`), so no race there.
