# Implementation Plan: Action Items A65–A68 (CS-ζ through CS-ι)

**Generated:** 2026-04-18
**Based On:** Ultra Plan analysis of A65/A66/A67/A68 (Phase 1–4 investigation report, 2026-04-18)
**Total Phases:** 4 (independent, any order; ordered here by ascending risk)
**Estimated Total Effort:** ~6–14 hours across 4 PRs

---

## Executive Summary

Four independent action items from the post-tech-debt backlog:

1. **A65 / CS-ζ** — Close the "F4 import type experiment" with rationale; codebase already follows `import type` discipline and PR #97's drift-guard covers the runtime failure mode. Optional lightweight eslint enforcement.
2. **A66 / CS-η** — Tighten `captures.source` via a Postgres CHECK constraint (not `pgEnum`) and fix CLAUDE.md's 7-vs-8 source undercount (production uses `'file'`; CLAUDE.md omits it).
3. **A68 / CS-θ** — Add Python lint (`ruff`) and typecheck (`pyright`) CI coverage for `docker/ingest-sidecar/`, `packages/voice-pipecat/`, and `packages/file-ingestion/`. Defer `scripts/` typecheck (sparse hints).
4. **A67 / CS-ι** — Integrate `email-compose` with `LLMGatewayService` without rewriting the multi-turn agent loop. Add a `resolveAgentClient(taskName)` method on the gateway; extend `runAgent()` with an optional `clientResolver` factory; migrate `email-compose` to opt in. Preserves backward compatibility for every other `runAgent()` caller.

No atomic coupling between phases — each ships as an independent PR. Ordered by ascending risk so the smallest/safest lands first and the sole medium-risk change (CS-ι) lands last when the rest are de-risked.

---

## Plan Overview

| Phase | Code | Item | Key Deliverables | Est. Effort | Risk |
|-------|------|------|------------------|-------------|------|
| 1 | CS-ζ | A65 | Decision record; optional root `eslint.config.js` with `consistent-type-imports` | 15 min – 2 h | Nil |
| 2 | CS-η | A66 | Migration `0022_captures_source_check.sql`; CLAUDE.md fix; pre-flight DB audit | 1–2 h | Low |
| 3 | CS-θ | A68 | Root `pyproject.toml`; new `python-lint` CI job; auto-fix pass; pyright clean on 3 packages | 2–3 h | Low |
| 4 | CS-ι | A67 | `LLMGatewayService.resolveAgentClient()`; `runAgent()` `clientResolver` option; email-compose migration; fault-injection test | 4–8 h | Medium |

All four phases are independent — merge order can swap based on reviewer availability. Flagged follow-ups (sibling TEXT columns, `memory-consolidation`/`weekly-brief` gateway migration, `scripts/` typecheck) are **out of scope** for this plan.

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Legacy `source` value in prod violates new CHECK constraint | Low | High | Pre-flight `SELECT DISTINCT source FROM captures;` on homeserver before applying migration 0022 |
| Eslint `--fix` for `consistent-type-imports` rewrites a runtime import as a type-only import | Low | Medium | If CS-ζ takes Path 1, review the diff file-by-file; skip if any import is used at runtime. Default to Path 2 (close) if diff is non-trivial. |
| Pyright surfaces latent bugs in `voice-pipecat` or `file-ingestion` | Medium | Low | Run pyright locally, fix in same PR before pushing. Never land a broken CI. |
| Fallback client swap in `runAgent` mid-loop creates provider mix-up (Anthropic→OpenAI with incompatible tool-use format) | Low | High | Constrain agent-loop fallback chain to same-provider tiers; add assertion in `resolveAgentClient()` that fallback tier shares provider with primary |
| `runAgent()` signature change breaks other callers | Low | High | New `clientResolver` is optional; existing `client + model` fields remain supported; add unit test for legacy signature in same PR |

---

<!-- BEGIN PHASES -->

## Phase 1: CS-ζ — A65 Import Type Experiment (Close or Lightweight Enforce) ✅ Completed 2026-04-18

**Complexity:** Trivial
**Dependencies:** None
**Parallelizable:** Yes
**Status:** COMPLETE 2026-04-18 — Path 2 (close with rationale). See LAB_NOTEBOOK Entry 085. Path 1.2 (eslint rule) not triggered — decision gate showed no defective imports, only legitimate inline-type-import style.

### Goals

Resolve A65 without introducing churn. Investigation (Phase 1 of ultra-plan) showed every sampled type import across `core-api`, `workers`, `slack-bot`, `shared`, and `web` already uses `import type` correctly. PR #97's drift-guard covers the specific runtime failure F4 was concerned about (web↔shared Zod enum drift).

### Decision Gate

Run this check first:

```bash
# Count mixed-style imports (potential fix candidates)
grep -rn "import {" --include="*.ts" packages/ | grep -v "node_modules" | grep ", type " | wc -l
```

- **If count ≤ 5:** take **Path 2 (close)**.
- **If count > 5:** take **Path 1 (eslint rule)**.

### Work Items

#### 1.1 Path 2 — Close with rationale (DEFAULT)

- [ ] Add a note to `LAB_NOTEBOOK.md` (Entry ≥ 085) explaining the rationale: investigation showed no runtime drift, drift-guard covers the symptomatic case, de facto discipline is holding.
- [ ] Remove A65 from the action-items backlog (wherever it lives).
- [ ] Close any tracking issue with a link to the notebook entry.

**Verification:** `pnpm test` still green (drift-guard still enforces web↔shared).

#### 1.2 Path 1 — Root eslint rule (ONLY IF decision gate triggers)

- [ ] Create `eslint.config.js` at repo root (flat-config format):

```js
import tseslint from 'typescript-eslint'
export default [
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
    },
  },
]
```

- [ ] Add `eslint` + `typescript-eslint` to root devDependencies (if not already present).
- [ ] Add `lint:types` script to root `package.json`: `eslint 'packages/*/src/**/*.ts'`.
- [ ] Run `pnpm lint:types --fix` and review the diff.
- [ ] Wire `lint:types` into the CI `build-and-test` job.

**Verification:** CI green; `pnpm lint:types` passes; drift-guard test still green; spot-check 3 auto-fixed files for correctness.

**Rollback:** Revert the eslint config + script + CI change. Zero runtime impact.

---

## Phase 2: CS-η — A66 Captures.source CHECK Constraint + CLAUDE.md Fix

**Complexity:** Small
**Dependencies:** None
**Parallelizable:** Yes
**Status:** Local steps COMPLETE 2026-04-18 (2.1, 2.3, 2.4, 2.6). Homeserver steps (2.2 pre-flight audit + 2.5 apply migration) PENDING — require SSH; surfaced to user. See LAB_NOTEBOOK Entry 086.

### Goals

Add database-level rejection of invalid `captures.source` values without the inflexibility of `pgEnum`. Fix the 7-vs-8 undercount in CLAUDE.md (production uses `'file'` for captures derived from uploaded-document file-references; CLAUDE.md lists only 7 values).

### Work Items

#### 2.1 Fix CLAUDE.md source-value list

- [ ] Update `CLAUDE.md` "Capture source types" reference to list all 8 values: `slack, voice, api, document, mcp, email, file, consolidation`.
- [ ] Update `memory/MEMORY.md` if it also enumerates sources.

#### 2.2 Pre-flight DB audit

- [ ] SSH to homeserver: `ssh root@homeserver.k4jda.net`.
- [ ] Run `docker exec open-brain-postgres psql -U openbrain -d openbrain -c "SELECT source, COUNT(*) FROM captures GROUP BY source ORDER BY source;"`.
- [ ] Confirm every distinct value is in the 8-value allowlist. **If not, stop and investigate before applying migration.**

#### 2.3 Write migration `0022_captures_source_check.sql`

File: `packages/shared/drizzle/0022_captures_source_check.sql`

```sql
ALTER TABLE captures
  DROP CONSTRAINT IF EXISTS captures_source_check;

ALTER TABLE captures
  ADD CONSTRAINT captures_source_check
  CHECK (source IN ('slack','voice','api','document','mcp','email','file','consolidation'));
```

#### 2.4 Update Drizzle schema annotation (informational only)

- [ ] Add a comment in `packages/shared/src/schema/core.ts` above the `source` column documenting the CHECK constraint and the canonical TS union location (`packages/shared/src/types/capture.ts:CaptureSource`).
- [ ] No runtime schema change — column stays `text('source').notNull()`. The TS union remains the source of truth.

#### 2.5 Apply to homeserver

- [ ] Copy migration to homeserver: `scp packages/shared/drizzle/0022_captures_source_check.sql root@homeserver.k4jda.net:/tmp/`.
- [ ] Apply: `docker exec -i open-brain-postgres psql -U openbrain -d openbrain < /tmp/0022_captures_source_check.sql`.
- [ ] Verify: `docker exec open-brain-postgres psql -U openbrain -d openbrain -c "\d+ captures" | grep check`.
- [ ] Test rejection: `INSERT INTO captures (id, content, source, ...) VALUES (gen_random_uuid(), 'test', 'bogus', ...);` — expect `23514 check_violation`.

#### 2.6 Lab notebook entry

- [ ] Log pre-flight audit results, migration command, verification output in `LAB_NOTEBOOK.md` (Rule 1: Hypothesis + Rollback before execution).

**Verification:** Integration tests pass; manual `INSERT` with invalid source rejected at DB layer; existing captures untouched.

**Rollback:** `ALTER TABLE captures DROP CONSTRAINT captures_source_check;` on the homeserver DB; `git revert` the migration + CLAUDE.md commit.

---

## Phase 3: CS-θ — A68 Python Lint & Typecheck CI

**Complexity:** Small-Medium
**Dependencies:** None
**Parallelizable:** Yes

### Goals

Add `ruff` (lint+format) and `pyright` (typecheck) to CI. Cover the three strongly-typed Python surfaces (`docker/ingest-sidecar/`, `packages/voice-pipecat/src/`, `packages/file-ingestion/src/`). Defer `scripts/` typecheck — sparse hints make it a separate effort.

### Work Items

#### 3.1 Create root `pyproject.toml`

File: `pyproject.toml` (repo root; tool config only, not a package definition)

```toml
[tool.ruff]
target-version = "py311"
line-length = 100
src = [
  "scripts",
  "docker/ingest-sidecar",
  "packages/voice-pipecat/src",
  "packages/file-ingestion/src",
]
extend-exclude = [
  "packages/voice-pipecat/tests",  # pytest conventions differ
  "**/node_modules",
  ".venv",
]

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM"]
ignore = ["E501"]  # formatter owns line length

[tool.pyright]
include = [
  "docker/ingest-sidecar",
  "packages/voice-pipecat/src",
  "packages/file-ingestion/src",
]
exclude = ["scripts", "**/tests", "**/__pycache__"]
pythonVersion = "3.12"
typeCheckingMode = "standard"
reportMissingImports = "warning"  # avoid noise from optional deps
```

#### 3.2 Auto-fix pass (lint + format)

- [ ] Install tools locally: `pip install ruff==0.6.* pyright==1.1.*`.
- [ ] Run `ruff check --fix .`; commit the fixes.
- [ ] Run `ruff format .`; commit the formatting changes.
- [ ] Review diffs in the PR for anything surprising.

#### 3.3 Pyright baseline

- [ ] Run `pyright` locally; fix any errors in the three included packages.
- [ ] If errors are extensive in one package, scope that package out of `include` and file a follow-up (note in PR description).
- [ ] Expected: sidecar clean (already well-typed with `from __future__ import annotations`); voice-pipecat/file-ingestion may surface a handful of issues.

#### 3.4 New CI job

File: `.github/workflows/ci.yml`

```yaml
python-lint:
  name: Python lint & typecheck
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-python@v5
      with:
        python-version: '3.12'
        cache: pip
    - run: pip install ruff==0.6.* pyright==1.1.*
    - run: ruff check .
    - run: ruff format --check .
    - run: pyright
```

- [ ] Add to the workflow alongside existing `build-and-test` and `sidecar-test` jobs.
- [ ] Do NOT make it a required check yet — observe for 1–2 PRs before promoting to required status.

**Verification:** `python-lint` job passes on the PR branch; `pnpm test` + `sidecar-test` still green.

**Rollback:** Revert the workflow job + `pyproject.toml`. Auto-fixed formatting/lint changes can stay (they're improvements regardless).

---

## Phase 4: CS-ι — A67 LLMGatewayService Integration for email-compose

**Complexity:** Medium
**Dependencies:** None (independent of Phases 1–3)
**Parallelizable:** Yes

### Goals

Route `email-compose` through `LLMGatewayService` for tier fallback + audit logging, without breaking the multi-turn agent loop or the other skills that use `runAgent()`. Use **Option C** from the ultra-plan analysis: inject a client-resolver factory into `runAgent`, gateway pre-computes tier selection but does not own the loop.

### Out of Scope (flagged for follow-up)

- `memory-consolidation` and `weekly-brief` also bypass the gateway but are single-completion — migrate them to `completeByTask()` in a **separate PR** (simpler shape, different risk profile).
- Multi-provider fallback chains in agent-loops (e.g., Anthropic→OpenAI). This phase constrains fallback to same-provider tiers only.

### Work Items

#### 4.1 Add `resolveAgentClient()` to LLMGatewayService

File: `packages/shared/src/services/llm-gateway.ts`

```typescript
export interface AgentClientResolution {
  client: Anthropic | OpenAI
  model: string
  tierKey: string
  maxTokens: number
  timeoutMs: number
  fallback?: () => AgentClientResolution | null
}

resolveAgentClient(taskName: string): AgentClientResolution {
  const primary = this.resolveByTask(taskName)
  if (!primary) throw new ModelResolverError(`No tier for task ${taskName}`)

  // Assert: fallback chain shares provider with primary (no cross-provider agent fallback)
  const fallbackChain = this.computeFallbackChain(primary.tierKey)
    .filter(t => t.provider === primary.tier.provider)

  return {
    client: primary.client,
    model: primary.model,
    tierKey: primary.tierKey,
    maxTokens: primary.maxTokens,
    timeoutMs: primary.timeoutMs,
    fallback: () => this.nextInChain(fallbackChain),
  }
}
```

- [ ] Implement `resolveAgentClient()` and private helper `computeFallbackChain()`.
- [ ] Unit test: resolves primary tier, excludes cross-provider tiers from fallback, throws on unmapped task.

#### 4.2 Extend `runAgent()` with `clientResolver` option

File: `packages/workers/src/lib/run-agent.ts`

```typescript
export interface RunAgentOptions {
  // Existing fields stay — backward compatible:
  client?: Anthropic
  model?: string
  maxIterations?: number
  maxTokens?: number
  temperature?: number

  // NEW (optional):
  clientResolver?: () => AgentClientResolution
}
```

- [ ] If `clientResolver` is provided, call it once at start + once per retry; ignore `client`/`model` fields.
- [ ] If `clientResolver` is NOT provided, preserve current behavior exactly.
- [ ] On transient API error (429, 503, timeout) inside the loop: call `resolution.fallback()`; if non-null, swap client+model and retry the SAME iteration once. Cap at 1 fallback swap per iteration.
- [ ] Unit tests:
  - [ ] Legacy signature (client + model) still works — no regression.
  - [ ] New signature (clientResolver) resolves once per iteration.
  - [ ] Fallback swap on 429: retries iteration with fallback client.
  - [ ] No fallback available: error propagates as before.

#### 4.3 Add `recordAgentCompletion()` audit helper

File: `packages/shared/src/services/llm-gateway.ts`

```typescript
async recordAgentCompletion(
  taskName: string,
  tierKey: string,
  result: { iterations: number, tokenUsage: TokenUsage, latencyMs: number }
): Promise<void> { /* writes to ai_audit_log */ }
```

- [ ] Insert row in `ai_audit_log` with task, tier, iterations, input/output tokens, latency. Reuses existing audit schema.
- [ ] Unit test: writes correct row shape.

#### 4.4 Migrate email-compose

File: `packages/workers/src/skills/email-compose.ts`

```typescript
const agentResolution = this.llmGateway.resolveAgentClient(EMAIL_COMPOSE_TASK)
const start = Date.now()
const agentResult = await runAgent(EMAIL_COMPOSE_SYSTEM_PROMPT, tools, instruction, {
  clientResolver: () => agentResolution,
  maxIterations: 10,
  maxTokens: agentResolution.maxTokens,
  temperature: 0.3,
})
await this.llmGateway.recordAgentCompletion(EMAIL_COMPOSE_TASK, agentResolution.tierKey, {
  iterations: agentResult.iterations,
  tokenUsage: agentResult.tokenUsage,
  latencyMs: Date.now() - start,
})
```

- [ ] Remove the now-dead `resolveTaskModel(...)` call in email-compose constructor — `resolveAgentClient()` does this internally.
- [ ] Ensure `llmGateway` is injected into the email-compose skill constructor (check workers `main.ts` — may already be wired; if not, add it).

#### 4.5 Fault-injection test

File: `packages/workers/src/skills/__tests__/email-compose.integration.test.ts`

- [ ] Mock Anthropic SDK to return 429 on first call, 200 on second.
- [ ] Verify `runAgent` uses fallback tier client for retry.
- [ ] Verify audit log has two tier entries (primary failed, fallback succeeded).

#### 4.6 Lab notebook entry

- [ ] Entry with Hypothesis (cost tracking + tier fallback now visible for email-compose), Rollback Plan (revert the three commits in reverse order; email-compose falls back to direct `runAgent(client, model)`), and post-merge results.

**Verification:**
- Unit tests pass for gateway + runAgent + email-compose.
- Integration test with fault injection passes.
- Run a real `email-compose` job on homeserver; confirm audit log row appears; confirm token usage is captured.

**Rollback:** Three atomic commits — revert the caller commit first (4.4), then runAgent changes (4.2), then gateway additions (4.1/4.3). Gateway methods are inert without a caller.

---

<!-- END PHASES -->

## Verification & Close-out

For each merged PR:
- Lab notebook entry updated with results (Rule 2).
- Action-items backlog entry removed (A65 / A66 / A67 / A68).
- CLAUDE.md rule added if any non-trivial finding surfaced during execution (per CLAUDE.md Operational Rules § "Learning Capture").

## Flagged Follow-ups (NOT in this plan)

1. **Sibling TEXT columns with enum smell** (from A66 investigation): `capture_type`, `pipeline_status`, `pipeline_events.stage/status`, `sessions.session_type/status`. Apply the same CHECK-constraint pattern if CS-η proves out.
2. **`memory-consolidation` + `weekly-brief` gateway migration** (from A67 investigation): both bypass the gateway but are single-completion; migrate via `completeByTask()` in a separate PR.
3. **Scripts typecheck** (from A68 investigation): 20 ops scripts in `scripts/` have sparse type hints; adding `pyright` coverage requires adding hints to each. Separate effort.
4. **Cross-provider agent fallback** (from A67 CS-ι scope): agent-loop skills currently cannot fall back Anthropic→OpenAI mid-loop due to tool-use format differences. If we ever need it, requires normalization layer in `runAgent` — separate design.
