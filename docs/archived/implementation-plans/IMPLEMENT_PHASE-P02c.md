# IMPLEMENT_PHASE-P02c.md — recordAgentCompletion final-tier plumb-through

**Phase:** P02c (Wave 1, Bootstrap phase 4 of 5)
**Closes:** #122 (sole PR; fully closes the issue — `Closes #122` is safe here)
**Severity:** Low
**Estimated effort:** ~4 hours
**Dependencies:** None (additive on #101 gateway work)
**Branch name:** `feat/phase-P02c-final-tier-key`
**Drift audit date:** 2026-04-18
**Base HEAD:** `6e4be28` (clean tree, P02b doc sweep)
**Authored by:** Gate 1 phase-planner subagent (Sonnet 4.6)

---

## 1. Scope Drift

**PROCEEDED** — 5 drift checks cleared:

| Check | Result |
|---|---|
| `AgentResult` already has `finalTierKey`? | **No.** 6 existing fields: `text`, `toolCalls`, `tokenUsage`, `duration`, `iterations`, `stopReason`. Grep confirms `finalTierKey` appears only in `PHASED_PLAN.md`. |
| `runAgent` has a place to track current tier across iterations? | **Yes.** `resolution` variable (L218) is reassigned on fallback swap (L323: `resolution = nextResolution`). At loop exit, `resolution.tierKey` reflects the last-swapped tier. |
| `recordAgentCompletion()` accepts `finalTierKey` today? | **No.** Current 3-param signature; P02c adds optional 4th param `finalTierKey?: string` (Option A — additive, minimal blast). |
| Other `recordAgentCompletion` callers besides email-compose? | **No.** Single production caller at `email-compose.ts:368`. |
| Other `runAgent` callers that consume `AgentResult`? | **Yes — 4** (`email-compose-assist`, `wiki-lint`, `wiki-ingest`, `monthly-reflection`). All use legacy `client+model` path; none call `recordAgentCompletion`. Optional field is backward-compatible. |

---

## 2. Current-State Baseline

### 2.1 `AgentResult` (`run-agent.ts` L78-91)

```ts
AgentResult {
  text: string
  toolCalls: AgentToolCall[]
  tokenUsage: AgentTokenUsage
  duration: number
  iterations: number
  stopReason: string
}
```

### 2.2 `recordAgentCompletion()` (`llm-gateway.ts` L807-814)

```ts
async recordAgentCompletion(
  taskName: string,
  tierKey: string,   // initial, not final
  result: { iterations, tokenUsage, latencyMs },
): Promise<void>
```

Internally: `tier = this.configService.getModelTier(tierKey)` → derives `model` + `clientUsed` for the audit row. **`ai_audit_log` has NO `tier_key` column** — only `model` + `client_used` are written. No schema migration needed.

### 2.3 `runAgent` swap logic

- `let resolution` (L218) — reassigned on fallback swap at L323
- `let client` (L324) — reassigned from `nextResolution.client`
- `let model` (L325) — reassigned from `nextResolution.model`
- Return at L440-447 — single injection point for `finalTierKey`

### 2.4 Current email-compose call (`email-compose.ts:368`)

```ts
await this.llmGateway.recordAgentCompletion(EMAIL_COMPOSE_TASK, resolvedTierKey, { ... })
```

`resolvedTierKey` set at L318 from `agentResolution.tierKey` (initial).

### 2.5 Existing test coverage

- `email-compose-fault-injection.test.ts` L175-184: currently asserts `recordCall[1] === 't2_quality'` (INITIAL tier) with a comment documenting the known imprecision. P02c updates to also assert `recordCall[3] === 't1_fast'` (final/fallback tier).
- `run-agent.test.ts` L782-814: fallback swap test asserts `result.text` + `result.iterations` but not `result.finalTierKey`. P02c extends.
- `llm-gateway.test.ts` L187-228: `recordAgentCompletion` tests use 3-arg form; backward-compatible with new optional 4th param.

---

## 3. Work Items

### 3.1 Add `finalTierKey?: string` to `AgentResult` and track across iterations

**File:** `packages/shared/src/services/run-agent.ts`

Interface addition (after L90):
```ts
/**
 * Tier key of the tier that ultimately served the final iteration.
 * Matches the initial resolved tier when no fallback swap occurred.
 * Undefined when runAgent is called without a clientResolver (legacy path).
 */
finalTierKey?: string
```

Loop tracking — after L261 (before `while`):
```ts
let currentTierKey: string | undefined = resolution?.tierKey
```

After the swap assignment (after L325 `model = nextResolution.model`):
```ts
currentTierKey = nextResolution.tierKey
```

Return statement (L440) add:
```ts
finalTierKey: currentTierKey,
```

**Why optional not required:** 4 legacy callers don't use `clientResolver`. `currentTierKey` will be `undefined` in those runs. Optional field preserves backward compat.

### 3.2 Update `recordAgentCompletion()` — optional 4th parameter

**File:** `packages/shared/src/services/llm-gateway.ts`

Add 4th parameter:
```ts
async recordAgentCompletion(
  taskName: string,
  tierKey: string,
  result: { iterations, tokenUsage, latencyMs },
  finalTierKey?: string,   // NEW
): Promise<void> {
  const effectiveTierKey = finalTierKey ?? tierKey
  const tier = this.configService.getModelTier(effectiveTierKey)
  // ... rest unchanged; all downstream flows (model, clientUsed, costUsd, logAudit) from tier lookup
}
```

Also extend the `logger.info` context at L832 to include `finalTierKey: effectiveTierKey` so operators can see both in the log.

**Why Option A over Option B:** P02c is Low severity. Additive signature change = zero breakage for existing callers. Replacing `tierKey` with full `AgentResult` would touch production + tests unnecessarily.

### 3.3 Update email-compose.ts call site

**File:** `packages/workers/src/skills/email-compose.ts` (L368)

```ts
await this.llmGateway.recordAgentCompletion(
  EMAIL_COMPOSE_TASK,
  resolvedTierKey,
  {
    iterations: agentResult.iterations,
    tokenUsage: { input: agentResult.tokenUsage.inputTokens, output: agentResult.tokenUsage.outputTokens },
    latencyMs: Date.now() - startMs,
  },
  agentResult.finalTierKey,   // NEW — undefined when no swap occurred; gateway falls back to tierKey
)
```

No guard needed — the gateway's `finalTierKey ?? tierKey` handles the undefined case.

### 3.4 Update fault-injection test

**File:** `packages/workers/src/__tests__/email-compose-fault-injection.test.ts`

In first test (fallback-to-success scenario):
- Remove the explanatory imprecision-comment block (L171-183)
- Keep the existing assertion `expect(recordCall[1]).toBe('t2_quality')` (initial tier param — unchanged)
- Add new assertion:
  ```ts
  const finalTierKeyArg = recordCall[3] as string | undefined
  expect(finalTierKeyArg).toBe('t1_fast')
  ```
- Update file-top test-description comment to reflect final-tier assertion now works

Second test (exhausted chain) — no `recordAgentCompletion` call, no change.

### 3.5 Extend run-agent.test.ts with finalTierKey assertions

**File:** `packages/shared/src/services/__tests__/run-agent.test.ts`

Three small additions:

**3.5a** — Fallback swap test (L782-814): add
```ts
expect(result.finalTierKey).toBe('t1_fast')
```

**3.5b** — Legacy path test (L856-870): add
```ts
expect(result.finalTierKey).toBeUndefined()
```

**3.5c** — No-swap resolver test (L745-767): add
```ts
expect(result.finalTierKey).toBe('t2_quality')
```

---

## 4. Acceptance Criteria

- [ ] `AgentResult` interface has `finalTierKey?: string` field
- [ ] `runAgent()` sets `finalTierKey` = initial tier key when no swap; = fallback tier key after successful swap; = `undefined` in legacy path
- [ ] `recordAgentCompletion()` accepts optional 4th `finalTierKey?: string`; uses it for tier lookup when provided, else falls back to the 2nd `tierKey` param
- [ ] `email-compose.ts` passes `agentResult.finalTierKey` as 4th arg
- [ ] Fault-injection test asserts `recordCall[3] === 't1_fast'`
- [ ] `run-agent.test.ts` extended with 3 new `finalTierKey` assertions
- [ ] `pnpm --filter @open-brain/shared build && test`: green
- [ ] `pnpm --filter @open-brain/workers build && test`: green
- [ ] No schema migration (no `tier_key` column in `ai_audit_log`)
- [ ] LAB_NOTEBOOK Entry 095 with Hypothesis + Rollback before first commit
- [ ] PR body uses `Closes #122` bare (sole PR closes issue fully — no partial-closure gotcha)

---

## 5. Rollback Plan

Single-commit atomic revert. `git revert <P02c-sha>` on main:
- `AgentResult` loses `finalTierKey`; 4 non-gateway callers unaffected (optional field)
- `recordAgentCompletion` loses 4th param; call sites passing it get TS2554 at next build
- `email-compose.ts` reverts to 3-arg call
- Tests revert assertions
- Zero schema/compose change; zero-downtime revert

---

## 6. Test Plan

```bash
pnpm --filter @open-brain/shared build
pnpm --filter @open-brain/shared test
pnpm --filter @open-brain/workers build
pnpm --filter @open-brain/workers test
pnpm -r test   # regression
```

Expected: shared 277/277 + 3 assertion extensions (still 277 files, a few more assertions), workers 960/960 + 1 new assertion.

---

## 7. Homeserver Deploy Notes

No compose/migration/env/config changes. Batch with A70.

**Semantic refinement post-merge:** `ai_audit_log.model` for agent-loop rows written by `recordAgentCompletion` changes meaning — before P02c it was the initial tier's model; after P02c it's the tier that actually served. Operators doing historical cross-PR cost analysis should treat the P02c merge date as a semantic cutover marker. Not a schema change.

---

## 8. Operational Rules Candidates

- **R-P02c-01:** Return-field additions to shared types must be optional (`field?: T`) unless all callers are updated in the same PR.
- **R-P02c-02:** Gateway audit logs record the tier that *actually served* the request — not the initially-routed tier. Initial routing is config-queryable; audit captures execution.
- **R-P02c-03:** Additive parameter changes to service methods append optional params to the signature; never reorder or replace existing params.
