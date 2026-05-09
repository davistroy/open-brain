# Implementation Plan: Post-Remediation Cleanup (Entry 106 + Entry 107)

**Date:** 2026-05-06
**Source:** `/ultra-plan` analysis of LAB_NOTEBOOK Entry 106 (Post-Remediation Architectural Audit) + Entry 107 (Post-Remediation Intent Review).
**Based On:** In-conversation Phase 0–5 ultra-plan output, 2026-05-06.
**Output:** This file.

## Scope

Outstanding tech-debt and doc-drift surfaced after PR #175 (R1–R12 architecture remediation arc) closed. Architecture scorecard 3.7/5.0; intent scorecard 7/10. Sound fundamentals; finishing-quality debt.

**In scope:** F1–F8 (Entry 106 audit) + W1, W2, W3, W4, W7 + S1, S3, S4, S5, W6 (Entry 107 intent review), reorganized into four change sets:

| Set | Items | Effort | Phases |
|---|---|---|---|
| A — Quick wins | F3 + F4 + F6 + F7 | S | Phase 1 |
| B — Documentation alignment | W1 + W2 + W3 + W4 + W7 + S1 + S3 + S4 + S5 + W6 | M | Phase 2 |
| C — Type system & lint hygiene | F1 + F5 | S–M | Phase 3 |
| D — Workers test rigor | F8 + F2 | M | Phase 4 |
| E — Strategic (deferred) | F9 (Vitest 2.x migration) | L | **Deferred** to separate plan |

**Out of scope:**
- **F9 (Vitest 2.x migration)** — Strategic; deserves its own plan with Windows forks-pool compat verification first. Bundling here couples a high-risk migration to low-risk housekeeping.
- **R10 (`morning-brief.ts` decomposition, XL)** — Conditional on adding delivery channels (per Entry 106). Not currently triggered.
- **A71 (memory-consolidation task key)** — Already tracked in CLAUDE.md as a pending action item.
- **A125 (`init-schema.sql` migration parity)** — Separate audit task tracked since arch review.
- **A128 (TanStack Query hook extraction)** — Deferred from arch review Phase 8a; separate plan.
- **All 32 Critical+High items from the 2026-04-18 architecture audit** — closed via PR #175 (R1–R12). Risk Acceptance Register items remain accepted by design.
- **Cloudscape M2/M3/M4 plans** — distinct active plans; no overlap.
- **`IMPLEMENTATION_PLAN.md` (LLM model consolidation)** — distinct active plan; partially complete.

## Verification Commands (Detected)

| Check | Command | Notes |
|---|---|---|
| Unit tests (all) | `pnpm -r test` | Root script |
| Unit tests (per-pkg) | `pnpm --filter @open-brain/<pkg> test` | Vitest |
| Integration tests | `pnpm test:integration` | Spins up `docker-compose.test.yml`, then runs `vitest run --config vitest.config.integration.ts` |
| Lint (all) | `pnpm -r lint` | Includes `tsc --noEmit` per package |
| Validation | `pnpm test:validation` | Top-level config/schema validation |
| Build | `pnpm -r build` | tsup/Vite/Next per package |
| TypeScript only | `pnpm -r exec tsc --noEmit` | Cross-package type check |
| Coverage (workers) | `pnpm --filter @open-brain/workers test -- --coverage` | New gate in Phase 4 |
| Frozen lockfile | `pnpm install --frozen-lockfile` | CI parity check |

## Architectural Constraints (from CLAUDE.md)

Every phase MUST comply with:

1. **LAB_NOTEBOOK.md entry created BEFORE the first commit in the phase** (blocking precondition).
2. **`pnpm-lock.yaml` committed with any `package.json` change** — CI uses `--frozen-lockfile`.
3. **Vitest forks pool config preserved** (`pool: 'forks'`, `minForks: 1`, `maxForks: N`, `hookTimeout/testTimeout: 30_000`) when adding new test config (Phase 4).
4. **Internal HTTP callers** still set `X-Open-Brain-Caller`. Phase 1 module-scope hoist of `BYPASS_CALLERS` preserves all 17 entries verbatim.
5. **Cost-tier compliance** — no per-item LLM calls introduced anywhere.
6. **All secrets via Bitwarden** — no new secrets introduced in this plan.
7. **Node 22 LTS runtime** — Phase 3 aligns `@types/node` to ^22 to match runtime.

## Phase Summary Table

| # | Title | Effort | Files (est) | LOC (est) | Depends on | Risk |
|---|---|---|---|---|---|---|
| 1 | Quick wins (deps + perf microfixes) | S | ~5 | ~80 + lockfile | — | Low |
| 2 | Documentation alignment (README + PRD + TDD) | M | 3 | ~400 doc lines | — | None |
| 3 | Type system & lint hygiene | S–M | 3 + (?) | ~10 + lockfile + (?) | — | Med |
| 4 | Workers test rigor (coverage + CI) | M | 2–3 | ~50 | — | Med |

**Total:** 4 phases. ~13–14 files touched. ~540 LOC + ~400 doc lines.

**Critical path:** None. Phases 1–4 are mutually independent (no file overlap) and could ship in parallel branches. Recommended sequential order is increasing-risk: 1 → 2 → 3 → 4 — so the riskiest change tests against the most-recently-clean baseline.

### Execution Hints

| Phase | Model Tier | Context Budget | Notes |
|---|---|---|---|
| 1 | `haiku` | Minimal | Mechanical: dep removals, const hoist, N+1 collect-and-batch |
| 2 | `sonnet` | Standard | Cross-reference every claim against code (docker-compose services, route files, skill registry) |
| 3 | `sonnet` | Standard | Budget 30–60 min for tsc-error fixes after `@types/node` downgrade |
| 4 | `sonnet` | Standard | CI verification + coverage baseline measurement first |

## Generated ADRs

**None.** This is L0–L2 housekeeping; no architectural decisions outlive the plan.

---

<!-- BEGIN PHASES -->

## Phase 1: Quick Wins (Deps + Perf Microfixes)

**Set:** A
**Effort:** S
**Goal:** Remove unused dependencies; hoist module-scope state; fix one N+1 query. All low-risk; tiny LOC; parallelizable internally.

### 1.1 Hoist `BYPASS_CALLERS` to module scope

**Files:** `packages/core-api/src/middleware/rate-limit.ts` (line ~274)

**Acceptance:**
- [ ] `const BYPASS_CALLERS = new Set([...])` moved from inside the closure (currently constructed per request) to module scope, after imports, before middleware export.
- [ ] All 17 internal-caller entries preserved verbatim.
- [ ] Inline comment added: `// Module-scope: constructed once, not per-request.`
- [ ] Existing rate-limit unit + integration tests pass without modification.
- [ ] Observable behavior unchanged (verify with `curl -H 'X-Open-Brain-Caller: integration-test' ...`).

**Requirement Refs:** F7

### 1.2 Fix N+1 in `GET /api/v1/ingest/uploads`

**Files:** `packages/core-api/src/routes/ingest.ts` (lines 156–189 and `:435`)

**Acceptance:**
- [ ] List endpoint at `:435` collects all `captureId`s from upload rows BEFORE shaping responses.
- [ ] Single `db.select().from(captures).where(inArray(captures.id, captureIds))` issued — replaces N round-trips.
- [ ] `Map<string, Capture>` lookup passed to `shapeFileUploadRow()` (or function signature refactored to accept prefetched capture).
- [ ] Response shape byte-identical (`pnpm --filter @open-brain/core-api test` covers route).
- [ ] Query count drops from N+1 to 2 (verify via debug logging once, remove before commit).

**Requirement Refs:** F6

### 1.3 Remove redundant markdown deps from workers

**Files:** `packages/workers/package.json` (lines 33–39), `pnpm-lock.yaml`

**Acceptance:**
- [ ] Pre-flight: `grep -rn "import.*\(remark\|rehype\|unified\|xss\)" packages/workers/src/` returns zero matches (already verified during planning).
- [ ] `pnpm --filter @open-brain/workers remove remark-parse remark-rehype rehype-slug rehype-stringify rehype-autolink-headings unified xss` executed.
- [ ] `pnpm install` regenerates `pnpm-lock.yaml`.
- [ ] `pnpm --filter @open-brain/workers build` exits 0.
- [ ] `pnpm --filter @open-brain/workers test` exits 0.

**Requirement Refs:** F3

### 1.4 Remove orphaned `@anthropic-ai/sdk` from root

**Files:** `package.json` (root, line 31), `pnpm-lock.yaml`

**Acceptance:**
- [ ] Pre-flight: confirm no root TS file imports `@anthropic-ai/sdk` (workspace root has no application code; SDK is independently declared in shared/core-api/workers/voice-capture).
- [ ] `pnpm remove -w @anthropic-ai/sdk` executed.
- [ ] `pnpm install` regenerates `pnpm-lock.yaml`.
- [ ] All consumer packages still build and test green.

**Requirement Refs:** F4

### Phase 1 Completion Checklist

- [ ] All 4 work items complete.
- [ ] Lab notebook entry created BEFORE first commit.
- [ ] `pnpm-lock.yaml` committed in same PR as `package.json` changes.
- [ ] CI green.
- [ ] `git status` shows clean working tree at end.

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| TypeScript | `pnpm -r exec tsc --noEmit` | Exit code 0 |
| Tests | `pnpm -r test` | Exit code 0 |
| Integration | `pnpm test:integration` | Exit code 0 |
| Lint | `pnpm -r lint` | Exit code 0 |
| Build | `pnpm -r build` | Exit code 0 |
| Frozen lockfile | `pnpm install --frozen-lockfile` | Exit code 0 |
| Workers grep | `grep -rn "import.*\(remark\|rehype\|unified\|xss\)" packages/workers/src/` | Zero matches |
<!-- END DOD -->

---

## Phase 2: Documentation Alignment (README + PRD + TDD)

**Set:** B
**Effort:** M
**Goal:** Bring README, PRD, and TDD into alignment with shipped code reality. Zero code risk; cross-reference every claim.

### 2.1 README sweep — container count, package layout, version refs

**Files:** `README.md`

**Acceptance:**
- [ ] **Container count:** line ~218 ("9 containers") corrected to authoritative count from `docker compose -f docker-compose.yml config --services | wc -l`. Recommend stating "13 core services" (per CLAUDE.md P11a) with note that ingest cron services bring active count to 17 in production.
- [ ] **Architecture table** (line ~31): `open-brain-web ... Vite + React + shadcn/ui` row removed (web deleted in Phase 8b per ADR-0001). Replace with `open-brain-web-next ... Next.js 16 + Cloudscape + React 19 + TanStack Query` row.
- [ ] **Monorepo layout** (line ~39): `packages/web/` row removed. Add rows for `packages/web-next/`, `packages/voice-pipecat/` (Pipecat VAD→Deepgram→Claude→TTS), `packages/file-ingestion/` (FastAPI file extraction), `packages/mobile/` (Expo React Native).
- [ ] **Deleted file references** (lines 271–272): `packages/web/src/content/USER_QUICK_START.md` + `USER_GUIDE.md` references removed (deleted in Phase 8b).
- [ ] **Stale "Deferred Features"** (lines 159–160): daily-connections + drift-monitor removed from deferred list (both shipped with cron schedules at 6:10 AM and 7:15 AM).
- [ ] **PRD/TDD version references** updated from v0.6 → v0.7 (S5 fold-in).
- [ ] **Verification:** `grep -c "packages/web/" README.md` returns 0.

**Requirement Refs:** W1, W2, W3, S5, W6 (partial)

### 2.2 PRD feature table update

**Files:** `docs/PRD.md`

**Acceptance:**
- [ ] **F19 description:** "Web dashboard (Vite + React PWA)" → "Web dashboard (Next.js 16 + Cloudscape + React 19)".
- [ ] **F21 (daily-connections), F22 (drift-monitor):** Status `Deferred` → `Complete` with approximate ship date (cron registration in `packages/workers/src/scheduler.ts` is authoritative).
- [ ] **F29–F35:** Status `Planned` → `Complete` with ship dates.
- [ ] **New feature IDs (F36+) added** for previously-undocumented capabilities:
  - `monthly-reflection` — monthly summary skill
  - `morning-brief` — proactive AM briefing
  - `capture-reminder-morning` + `capture-reminder-evening` — autonomy-gated nudges
  - `cost-analysis` — budget reporting skill
  - `container-health` — synthetic monitor
  - `storage-audit` — disk-usage skill
  - `secret-rotation` — BWS rotation runbook trigger
  - `capture-dedup-sweep` — dedup hygiene skill
  - `refine-brief` — async LLM HTML transform
  - `entity-brief` — entity-page synthesis
  - `extract-commitments` — LLM commitment extraction (full pipeline + table + routes)
  - `voice-sessions` — Pipecat session lifecycle REST API
- [ ] **Status column** reflects code reality (cross-reference `packages/workers/src/skills/` directory + `packages/core-api/src/routes/`).
- [ ] **Three undocumented packages** (W6) added to PRD §1 (System Overview): voice-pipecat, file-ingestion, mobile.

**Requirement Refs:** W4, S1, S3, S4, W6 (partial)

### 2.3 TDD §2.1 demote Jetson/Spark to optional

**Files:** `docs/TDD.md`

**Acceptance:**
- [ ] **§2.1:** "Jetson Orin Nano (Required)" → "Jetson Orin Nano (Optional cost-saving tier)".
- [ ] **§2.1:** "DGX Spark (Required)" → "DGX Spark (Optional cost-saving tier)".
- [ ] **Explicit note added:** "Core system runs on OpenAI API alone; Jetson/Spark provide free-tier cost savings via `t1_jetson`/`t1_spark` entries in `config/ai-routing.yaml`. Neither is required to deploy or operate the system."
- [ ] **Verification:** cross-reference `config/ai-routing.yaml` confirms `t1_jetson`/`t1_spark` are tier entries with explicit `cost_per_1k_*: 0`, not hard dependencies.

**Requirement Refs:** W7

### Phase 2 Completion Checklist

- [ ] All 3 work items complete.
- [ ] Lab notebook entry created BEFORE first commit.
- [ ] Manual proofread: every file path in README exists; every PRD feature ID matches a code surface; TDD §2.1 matches `ai-routing.yaml`.
- [ ] `grep -c "packages/web/" README.md` returns 0.

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| Web reference scrub | `grep -c "packages/web/" README.md` | 0 |
| Container count sanity | `docker compose -f docker-compose.yml config --services \| wc -l` | Number matches README claim |
| Doc-sync CI | (existing `doc-sync` job in `.github/workflows/ci.yml`) | Green |
<!-- END DOD -->

---

## Phase 3: Type System & Lint Hygiene

**Set:** C
**Effort:** S–M
**Goal:** Align `@types/node` to runtime version; bump `eslint-config-next` to match Next.js 16. Both touch `package.json` + lockfile; both can surface latent errors needing same-PR fixes.

### 3.1 Pre-flight: enumerate latent type errors (resolve U1)

**Files:** none (research)

**Acceptance:**
- [ ] Branch `chore/types-node-22-pin` created.
- [ ] `packages/core-api/package.json:46` `^25.3.5` → `^22.0.0`.
- [ ] `packages/voice-capture/package.json:29` `^25.3.5` → `^22.0.0`.
- [ ] `pnpm install` regenerates lockfile.
- [ ] `pnpm -r exec tsc --noEmit` run; any errors enumerated in lab notebook entry.
- [ ] **Decision gate:** if errors > 5 surfaces, escalate as a separate fix-and-pin PR before 3.2 lands. If ≤ 5, proceed to 3.2 in same PR.

**Requirement Refs:** F1

### 3.2 Align `@types/node` to ^22 + fix any surfaced errors

**Files:** `packages/core-api/package.json:46`, `packages/voice-capture/package.json:29`, plus any source files surfaced by 3.1

**Acceptance:**
- [ ] Both packages pinned to `^22.0.0` (matching `packages/web-next/package.json:30` baseline).
- [ ] All tsc errors surfaced in 3.1 fixed in same PR (preferred) OR explicitly enumerated and deferred with rationale (if escalated per 3.1 decision gate).
- [ ] `pnpm -r exec tsc --noEmit` exits 0.
- [ ] `pnpm -r build` exits 0.

**Requirement Refs:** F1

### 3.3 Bump `eslint-config-next` to ^16

**Files:** `packages/web-next/package.json:39`

**Acceptance:**
- [ ] `eslint-config-next: ^15.0.0` → `^16.2.4` (matching `next: ^16.2.4`).
- [ ] `pnpm install`.
- [ ] `pnpm --filter @open-brain/web-next lint` run.
- [ ] **Decision gate:** any new errors fixed in same PR. Goal: A127 baseline (24 errors in `HelpContent.tsx`) UNCHANGED. If new rules unavoidably extend the baseline, document in CLAUDE.md alongside A127.

**Requirement Refs:** F5

### 3.4 Lockfile commit

**Files:** `pnpm-lock.yaml`

**Acceptance:**
- [ ] `pnpm install` after 3.2 + 3.3.
- [ ] Lockfile committed in same PR as `package.json` changes.
- [ ] `pnpm install --frozen-lockfile` exits 0 (CI parity).

**Requirement Refs:** F1, F5

### Phase 3 Completion Checklist

- [ ] All 4 work items complete.
- [ ] Lab notebook entry created BEFORE first commit (with U1 + U4 resolution recorded).
- [ ] `pnpm-lock.yaml` committed alongside package.json changes.
- [ ] A127 baseline unchanged (or documented if extended).
- [ ] CI green.

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| Frozen lockfile | `pnpm install --frozen-lockfile` | Exit code 0 |
| TypeScript | `pnpm -r exec tsc --noEmit` | Exit code 0 |
| Lint | `pnpm -r lint` | Exit code 0 (A127 baseline preserved) |
| Build | `pnpm -r build` | Exit code 0 |
| Tests | `pnpm -r test` | Exit code 0 |
<!-- END DOD -->

---

## Phase 4: Workers Test Rigor

**Set:** D
**Effort:** M
**Goal:** Add coverage thresholds to workers (matching core-api's 80% bar) AND wire workers integration tests into CI. Both ship together: thresholds without CI = unenforced; CI without thresholds = empty rigor.

### 4.1 Measure workers coverage baseline (resolve U2)

**Files:** none (measurement)

**Acceptance:**
- [ ] Run `pnpm --filter @open-brain/workers test -- --coverage`.
- [ ] Document `lines%` and `functions%` in lab notebook entry.
- [ ] Decide threshold value: pin to **floor** of measured baseline (safer; same pattern as core-api Phase 4 of arch-review remediation). Plan to raise incrementally toward 80% in follow-ups.

**Requirement Refs:** F8

### 4.2 Add coverage thresholds to workers vitest config

**Files:** `packages/workers/vitest.config.ts`

**Acceptance:**
- [ ] `test.coverage` extended to mirror `packages/core-api/vitest.config.ts:20-29`:
  ```typescript
  coverage: {
    provider: 'v8',
    reporter: ['text', 'lcov', 'json-summary'],
    include: ['src/**/*.ts'],
    exclude: ['src/index.ts', 'src/main.ts', 'src/__tests__/**'],
    thresholds: { lines: <baseline>, functions: <baseline> },
  }
  ```
- [ ] `<baseline>` value pinned to the floor measured in 4.1.
- [ ] Existing `pool: 'forks'` + `minForks: 1` + `maxForks: 4` + 30 s timeouts preserved (CLAUDE.md mandate).
- [ ] `pnpm --filter @open-brain/workers test -- --coverage` exits 0.

**Requirement Refs:** F8

### 4.3 Verify (or create) `vitest.config.integration.ts` for workers (resolve U3)

**Files:** `packages/workers/vitest.config.integration.ts` (verify or create)

**Acceptance:**
- [ ] File existence checked. If absent: create mirroring `packages/core-api/vitest.config.integration.ts` shape.
- [ ] Required config: `include: ['src/__tests__/integration/**/*.test.ts']`, `pool: 'forks'`, `minForks: 1`, `maxForks: 4`, `hookTimeout: 30_000`, `testTimeout: 30_000`.
- [ ] Locally: `docker compose -f docker-compose.test.yml up -d --wait` then `pnpm --filter @open-brain/workers exec vitest run --config vitest.config.integration.ts` — all 3 test files (`pipeline.test.ts`, `ingest-e2e.test.ts`, `access-stats-e2e.test.ts`) pass.

**Requirement Refs:** F2

### 4.4 Add workers integration test step to CI

**Files:** `.github/workflows/ci.yml`

**Acceptance:**
- [ ] New step added in the `integration-test` job, **after** the existing "Run integration tests" step at line ~200, **before** "Dump service logs on failure":
  ```yaml
  - name: Run workers integration tests
    run: pnpm --filter @open-brain/workers exec vitest run --config vitest.config.integration.ts
    env:
      TEST_POSTGRES_URL: postgresql://openbrain_test:test_password@localhost:5433/openbrain_test
      TEST_REDIS_URL: redis://localhost:6381
      NODE_ENV: test
  ```
- [ ] Reuses already-running `docker-compose.test.yml` services (started at line 198) — no new services or volumes added.
- [ ] Step is part of the existing required `integration-test` job (no separate `continue-on-error: true` job needed; tests pass locally and use the same infrastructure).
- [ ] `gh run list --workflow=ci.yml --limit 5` after merge shows ≥4/5 green runs.

**Requirement Refs:** F2

### 4.5 Verify branch protection still required

**Files:** none (GitHub repo settings audit)

**Acceptance:**
- [ ] `gh api repos/davistroy/open-brain/branches/main/protection --jq '.required_status_checks.contexts'` includes `"Integration tests (core-api + real DB)"` (already required since arch-review Phase 5b — workers step inherits the gate by being part of that job).

**Requirement Refs:** F2

### Phase 4 Completion Checklist

- [ ] All 5 work items complete.
- [ ] Lab notebook entry created BEFORE first commit (with U2 + U3 resolutions recorded).
- [ ] Workers coverage gate active.
- [ ] CI workers integration step green for ≥4/5 consecutive runs.
- [ ] Branch protection confirmed.

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| Workers coverage | `pnpm --filter @open-brain/workers test -- --coverage` | Exit code 0 (thresholds met) |
| Integration (local) | `docker compose -f docker-compose.test.yml up -d --wait && pnpm --filter @open-brain/workers exec vitest run --config vitest.config.integration.ts` | Exit code 0 |
| Tests (all) | `pnpm -r test` | Exit code 0 |
| CI gate | `gh run list --workflow=ci.yml --limit 5` | ≥4/5 green |
| Branch protection | `gh api repos/davistroy/open-brain/branches/main/protection --jq '.required_status_checks.contexts'` | Includes `"Integration tests (core-api + real DB)"` |
<!-- END DOD -->

---

## Phase 5: Vitest 2.x Migration (DEFERRED)

**Set:** E
**Effort:** L
**Status:** **DEFERRED** to its own implementation plan.

**Rationale:** Vitest 2.x reorganizes `poolOptions` config keys; CLAUDE.md explicitly notes that `pool: 'forks'` with `minForks/maxForks` is required for Windows ioredis/bullmq race avoidance. A116 already tracks this as "Out of scope" pending tooling pass. Bundling here would couple a high-risk migration to low-risk housekeeping and risk taint-by-association if migration flakes.

**Triggering condition for separate plan:** Either (a) a new test feature only available in Vitest 2.x is needed, or (b) a known Vitest 1.6 bug bites. Until then: defer.

**When picked up:** investigate forks-pool compat first via local Windows verification + per-package smoke testing, then write a dedicated plan with explicit rollback gates.

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run In Parallel With | Notes |
|---|---|---|
| 1.1, 1.2, 1.3, 1.4 | Each other (within Phase 1) | Independent files; only 1.3 + 1.4 share lockfile commit (sequence at end) |
| 2.1, 2.2, 2.3 | Each other (within Phase 2) | Different files (README / PRD / TDD); zero overlap |
| Phase 1 | Phases 2, 3, 4 | No file overlap across phases |
| Phase 2 | Phases 1, 3, 4 | Doc-only — independent of all code work |
| Phase 3 | Phases 1, 2 | Type/lint hygiene — distinct files from Phase 1 code paths |
| Phase 4 | Phases 1, 2, 3 | Workers config + CI — distinct files |

**Recommendation:** sequential 1 → 2 → 3 → 4 in increasing-risk order. Each phase ends with a clean baseline that the next phase tests against.

## Risk Mitigation

| ID | Risk | Severity | Affected Phase | Mitigation | Rollback |
|---|---|---|---|---|---|
| R-1 | Removing markdown deps breaks workers via dynamic import | Low | 1 | Pre-flight `grep` (verified zero imports). | `git revert` + `pnpm install` |
| R-2 | Removing root `@anthropic-ai/sdk` breaks phantom-dep import | Low | 1 | All consumers explicitly declare. Pre-flight cross-package grep. | `git revert` + `pnpm install` |
| R-3 | N+1 refactor changes response shape | Low | 1 | Existing route tests assert shape. Keep `shapeFileUploadRow()` signature compatible. | `git revert` |
| R-4 | `BYPASS_CALLERS` hoist drops an entry | Low | 1 | Copy verbatim; integration test 2.4 from arch-review (`rate-limit-public.test.ts`) catches missing entries. | `git revert` |
| R-5 | Doc updates introduce new factual errors | Low | 2 | Cross-reference every claim against code (docker-compose services, route files, skill registry). | `git revert` |
| R-6 | `@types/node` downgrade surfaces tsc errors | Medium | 3 | 3.1 pre-flight investigation. Budget 30–60 min for fixes in same PR. If errors > 5, defer and fix-then-pin. | `git revert` + `pnpm install` |
| R-7 | `eslint-config-next` bump expands A127 baseline | Medium | 3 | Run lint immediately after bump. Goal: zero new errors. If unavoidable, document in CLAUDE.md. | `git revert` |
| R-8 | Workers coverage threshold breaks build | High → mitigated | 4 | 4.1 measures first; 4.2 sets threshold to baseline floor. | Adjust threshold value (config-only edit) |
| R-9 | Workers integration tests flake in CI | Medium | 4 | Tests pass locally with `docker-compose.test.yml`. If flake: factor into separate job with `continue-on-error: true` and observe 5 PRs (matches `doc-sync` pattern). | Remove CI step |

## Unknowns Register

| ID | Unknown | Severity | Affected Phase/Item | Resolution Strategy | Status |
|---|---|---|---|---|---|
| U1 | How many `@types/node` 25-only API references exist in core-api/voice-capture? | Medium | 3.1, 3.2 | 3.1 pre-flight: branch + downgrade + `tsc --noEmit`; enumerate errors before committing | Open |
| U2 | What is the current workers test coverage `lines%` and `functions%`? | Medium | 4.1, 4.2 | Run `pnpm --filter @open-brain/workers test -- --coverage` on main; record baseline | Open |
| U3 | Does `packages/workers/vitest.config.integration.ts` exist? | Low | 4.3, 4.4 | First step of 4.3: file check; create if absent | Open |
| U4 | Does `eslint-config-next@^16.2.4` introduce lint rules that fail outside `HelpContent.tsx`? | Low | 3.3 | First step of 3.3: bump + lint + count errors | Open |
| U5 | Authoritative container count for README — 13 (CLAUDE.md "P11a") or 17 (Entry 107)? | Low | 2.1 | `docker compose -f docker-compose.yml config --services \| wc -l` is authoritative | Open |

## Success Metrics

| Metric | Pre-Plan Baseline | Post-Plan Target |
|---|---|---|
| Workers integration tests in CI | 0 (none invoked) | 3 (`pipeline`, `ingest-e2e`, `access-stats-e2e`) |
| Workers coverage gate | None | Threshold pinned to measured baseline floor |
| Root unused deps | 1 (`@anthropic-ai/sdk`) | 0 |
| Workers redundant deps | 7 (markdown stack) | 0 |
| Per-request `Set` allocations in rate-limit middleware | 1 (17-entry Set) | 0 (module-scope) |
| `@types/node` version drift across packages | 2 (^25.3.5 vs ^22.0.0) | 0 (all ^22.x.x) |
| `eslint-config-next` lag behind Next.js | 1 major version | 0 |
| N+1 queries in `GET /api/v1/ingest/uploads` | 21 (1 list + 20 per-row) | 2 (1 list + 1 batched) |
| README claims contradicting code reality | ≥6 (containers, packages, deferred features, paths) | 0 |
| PRD features with stale "Planned"/"Deferred" status while shipped | 9 (F19, F21, F22, F29–F35) | 0 |
| TDD §2.1 false "Required" infrastructure claims | 2 (Jetson, Spark) | 0 |

## Requirement Traceability

| Requirement | Source | Phase | Work Item |
|---|---|---|---|
| F1: Align `@types/node` to ^22 | Entry 106 | 3 | 3.1, 3.2, 3.4 |
| F2: Workers integration tests in CI | Entry 106 | 4 | 4.3, 4.4, 4.5 |
| F3: Remove redundant markdown deps from workers | Entry 106 | 1 | 1.3 |
| F4: Remove root `@anthropic-ai/sdk` | Entry 106 | 1 | 1.4 |
| F5: Bump `eslint-config-next` to ^16 | Entry 106 | 3 | 3.3, 3.4 |
| F6: Fix N+1 in `GET /api/v1/ingest/uploads` | Entry 106 | 1 | 1.2 |
| F7: Hoist `BYPASS_CALLERS` to module scope | Entry 106 | 1 | 1.1 |
| F8: Workers coverage thresholds | Entry 106 | 4 | 4.1, 4.2 |
| F9: Vitest 2.x migration | Entry 106 | — | **DEFERRED** to separate plan |
| W1: README container count | Entry 107 | 2 | 2.1 |
| W2: README references deleted `packages/web` | Entry 107 | 2 | 2.1 |
| W3: README version/feature status stale | Entry 107 | 2 | 2.1 |
| W4: PRD F19, F21/F22, F29–F35 status drift | Entry 107 | 2 | 2.2 |
| W6: Three undocumented packages | Entry 107 | 2 | 2.1, 2.2 |
| W7: TDD §2.1 Jetson/Spark "Required" | Entry 107 | 2 | 2.3 |
| S1: 10+ skills absent from PRD | Entry 107 | 2 | 2.2 |
| S3: extract-commitments undocumented | Entry 107 | 2 | 2.2 |
| S4: Voice sessions partially documented | Entry 107 | 2 | 2.2 |
| S5: README PRD/TDD version refs stale | Entry 107 | 2 | 2.1 |
| R10: morning-brief.ts decomposition | Entry 106 | — | **OUT OF SCOPE** (conditional on adding delivery channels) |
| S2: A71 memory-consolidation task key | Entry 107 | — | **OUT OF SCOPE** (already tracked in CLAUDE.md) |
| S7: ingest.ts TODO | Entry 107 | — | **OUT OF SCOPE** (documentation-level placeholder) |

## Milestones

| Milestone | Phases | Indicates |
|---|---|---|
| M1: Tech-debt cleared | 1 | Quick wins shipped; root + workers package.json clean |
| M2: Docs match reality | 2 | README, PRD, TDD reflect code state; intent scorecard ≥9/10 |
| M3: Type/lint hygiene | 3 | `@types/node` aligned to runtime; eslint-config-next current |
| M4: Workers test rigor | 4 | Integration tests in CI; coverage gate active |

<!-- END TABLES -->

---

## Deferred Items (Action Item Registry)

Items surfaced during this plan's investigation, with status as of 2026-05-06.

| ID | Description | Status | Location | Unblock / Resolution |
|----|-------------|--------|----------|----------------------|
| F9 | Vitest 2.x migration | **DEFERRED** to its own plan | `packages/*/package.json`, `vitest.config.ts` files | Separate plan with Windows forks-pool compat verification first |
| R10 | `morning-brief.ts` decomposition (XL) | Out of scope | `packages/workers/src/skills/morning-brief.ts` | Trigger condition: adding new brief delivery channels (email, push, etc.) |
| A71 | memory-consolidation task key rename | Pre-existing | `packages/workers/src/skills/memory-consolidation.ts:348` | Add `memory_consolidation` task key to `config/ai-routing.yaml`; tracked in CLAUDE.md |
| A125 | `init-schema.sql` migration parity audit | Pre-existing | `scripts/init-schema.sql` | Schema parity sweep — audit init-schema.sql against all `0*.sql` migrations |
| A128 | TanStack Query hooks extraction (R9 follow-up) | Pre-existing | `packages/web-next/lib/api/` | Separate plan; design work scoped after Phase 8a file split |
| A127 | 24 `react/no-unescaped-entities` lint errors in `HelpContent.tsx` | Pre-existing baseline | `packages/web-next/src/components/help/HelpContent.tsx` | Tracked since arch-review Phase 7.3; targeted cleanup PR |

### Guidance for future sessions

- **Open items affecting operational behavior:** F9 (test runner upgrade), A71 (skill task routing), A125 (DR-criticality of init-schema parity).
- **Pre-existing baselines (long-term debt, do not fix in this scope):** A127, A128. Will need targeted cleanup PRs.
- **Periodic intent review:** every 2–3 months to catch doc drift early. Future skills + features must add PRD F-IDs at ship time to avoid re-accruing this debt.

---

*Source: `/personal-plugin:ultra-plan` invocation following Phase 0–5 analysis on 2026-05-06.*
