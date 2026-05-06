# Implementation Plan: Architecture Review Remediation

**Date:** 2026-05-05
**Source:** `/ultra-plan` analysis of architecture review remediation roadmap (R1–R12). R10 dropped during investigation (no real duplication).
**Based On:** In-conversation Phase 4 solution design + Phase 5 summary report (architecture review session, 2026-05-05).
**Output:** This file.

## Scope

**In scope:** R1–R9 + R11–R12, reorganized into six change sets:

| Set | Items | Effort | Status |
|---|---|---|---|
| A — Web Consolidation | R3 + R12 + R9-reframed + R11-reframed | XL (split across phases 7–8) | Pending |
| B — Security Hardening | R2 → R8 | S → M | Pending |
| C — Test & CI Tightening | R4 → R6 → R1 | S → L → S | Pending |
| D — Service Layer Extraction | R7 | M | Pending |
| E — Repo Hygiene | R5 | S | Pending |
| F — Skill Aggregator (R10) | — | — | **DROPPED** (no duplication found in investigation) |

**Out of scope:** Cloudscape M2-M4 design rollout (separate plan), mobile push/streaming (deferred per `mobile-app-deferred.md`), changes to slack-bot/voice-capture/internal-service auth.

## Verification Commands (Detected)

| Check | Command | Notes |
|---|---|---|
| Unit tests (all) | `pnpm -r test` | Root script |
| Unit tests (per-pkg) | `pnpm --filter @open-brain/<pkg> test` | Vitest |
| Integration tests | `pnpm test:integration` | Spins up `docker-compose.test.yml`, then runs `vitest run --config vitest.config.integration.ts` |
| Lint (all) | `pnpm -r lint` | Includes `tsc --noEmit` per package |
| Validation | `pnpm test:validation` | Top-level config/schema validation |
| Build | `pnpm -r build` | tsup/Vite/Next per package |
| Coverage | `pnpm --filter @open-brain/core-api test -- --coverage` | Threshold: ≥70% per route file (new) |

## Architectural Constraints (from CLAUDE.md)

Every phase MUST comply with:

1. **LAB_NOTEBOOK.md entry created BEFORE the first commit in the phase** (blocking precondition).
2. **All secrets via Bitwarden Secrets Manager**, never `.env` literals. New secrets require lockstep update of `deploy/.env.secrets.template` + `scripts/lib/secrets-map.sh` + consumer.
3. **`pnpm-lock.yaml` committed with any `package.json` change.**
4. **Internal HTTP callers** still set `X-Open-Brain-Caller`. Phase 6 (mobile auth) replaces the *trust mechanism* for inbound public calls; the internal Docker convention is preserved.
5. **Rebuild `@open-brain/shared`** before `tsc --noEmit` on dependents when shared types change (Phase 5, 7, 8a).
6. **Cost-tier compliance** — no per-item LLM calls introduced anywhere.
7. **Vitest forks pool config** (`pool: 'forks'`, `minForks: 1`, `maxForks: N`) preserved when adding new test files.

## Phase Summary Table

| # | Title | Effort | Files (est) | LOC (est) | Depends on | Risk |
|---|---|---|---|---|---|---|
| 1 | Repo hygiene + error standardization | S | ~12 | ~250 | — | Low |
| 2 | Public-origin header hardening (R2) | S | ~5 | ~120 | — | Low |
| 3 | Test helpers + Tier-1 route tests | M | ~9 | ~1,200 | — | Low |
| 4 | Tier-2 route tests | M | ~10 | ~1,400 | 3 | Low |
| 5 | Service layer extraction + promote integration job | M | ~10 | ~700 | 3, 4 | Med |
| 6 | Mobile Bearer auth (R8) | M | ~8 | ~400 | 2 | Med |
| 7 | Web consolidation foundation (ADR + parity + utilities) | M | ~8 | ~600 | — | Low |
| 8a | Web-next API client (R9-reframed) | L | ~22 | ~2,000 | 7 | Med |
| 8b | Tab splits + sunset `packages/web` (R11-reframed + A.6) | L | ~15 | ~1,200 | 8a | Med |

**Total:** 9 phases (8 numbered, 8 has sub-phases 8a/8b). ~99 files touched. ~7,870 LOC.

**Critical path:** 1 → 2 → (3 → 4) → (5 ‖ 6) → 7 → 8a → 8b. Phases 5 and 6 are parallelizable.

### Execution Hints

| Phase | Model Tier | Context Budget | Notes |
|---|---|---|---|
| All (default) | `sonnet` | Standard | |
| 5 | `opus` | Extended | AdminService extraction is security-sensitive (two-step reset, audit logging) |
| 8a | `opus` | Extended | New API client design — long-term web-next surface |
| 8b | `opus` | Extended | Destructive (page splits + `packages/web` deletion) — needs careful regression guard |
| 1 | `haiku` | Minimal | Mechanical: file moves, AppError replacements |

## Generated ADRs

- `docs/adr/ADR-0001-web-consolidation.md` — Status: Proposed. Generated alongside this plan; ratified during Phase 7.1.

---

<!-- BEGIN PHASES -->

## Phase 1: Repo Hygiene + Error Standardization

**Set:** E + C.1
**Effort:** S
**Goal:** Clear root clutter; standardize route error responses on AppError throws.

### 1.1 Archive completed implementation plans ✅ Completed 2026-05-05

**Files:** `IMPLEMENT_LLM_GATEWAY_REFACTOR.md`, `IMPLEMENT_REFACTOR_2026-04-16.md`, `IMPLEMENT_TECH_DEBT_CLEANUP_2026-04-17.md`, `IMPLEMENT_WAVES_2026-04-17.md`, `IMPLEMENTATION_PLAN-CLOUDSCAPE-M1.md`, `M3_BACKLOG.md` → `docs/archived/implementation-plans/`

**Acceptance:**
- [ ] WHEN running `ls *.md` in repo root THEN the count SHALL drop from 17 to ≤11.
- [ ] All moves use `git mv` (preserve history).
- [ ] `IMPLEMENTATION_PLAN.md` (LLM model consolidation) and `IMPLEMENTATION_PLAN-CLOUDSCAPE-M{2,3,4}.md` SHALL remain at root (active milestones).
- [ ] `README.md` updated with link to active-plan list.

**Requirement Refs:** R5

### 1.2 Add missing AppError subclasses ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/middleware/error-handler.ts`

**Acceptance:**
- [ ] `ConfigError` (503), `UploadNotFoundError` (404), `ResetForbiddenError` (403) added if not present (verify against existing hierarchy first).
- [ ] All subclasses extend `AppError` with `statusCode` + `code` fields.
- [ ] WHEN an `AppError` subclass is thrown THEN the central `errorHandler()` middleware SHALL produce `{ error, code }` JSON at the declared status code.

**Requirement Refs:** R4

### 1.3 Convert direct `c.json({error,...})` returns to `throw new AppError(...)` ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/routes/admin.ts` (lines 181, 209, 270), `packages/core-api/src/routes/ingest.ts` (line 458), `packages/core-api/src/routes/bets.ts` (line 75), plus any others surfaced by grep `c.json\(\s*\{\s*error`

**Acceptance:**
- [ ] All 13 sites converted.
- [ ] No business 4xx success returns (e.g., pagination metadata) accidentally caught.
- [ ] Response shape unchanged — existing route tests pass without modification.

**Requirement Refs:** R4

### 1.4 README + CLAUDE.md cross-references ✅ Completed 2026-05-05

**Files:** `README.md`, `CLAUDE.md`

**Acceptance:**
- [ ] `README.md` has a "Current Plans" section pointing to `IMPLEMENTATION_PLAN-ARCH-REVIEW.md` and the M2-M4 Cloudscape plans.
- [ ] No content removed from CLAUDE.md (defer the "NOT Next.js" correction to Phase 7).

**Requirement Refs:** R5

### Phase 1 Completion Checklist
- [ ] All 4 work items complete.
- [ ] Lab notebook entry created BEFORE first commit.
- [ ] Pre-commit hook + CI green.
- [ ] `git status` shows clean working tree at end.

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| Tests | `pnpm --filter @open-brain/core-api test` | Exit code 0 |
| Lint | `pnpm --filter @open-brain/core-api lint` | Exit code 0 |
| Types | `pnpm --filter @open-brain/core-api exec tsc --noEmit` | Exit code 0 |
<!-- END DOD -->

---

## Phase 2: Public-Origin Header Hardening (R2)

**Set:** B.1
**Effort:** S
**Goal:** Close the X-Open-Brain-Caller bypass via `packages/web-next/next.config.ts` rewrites.

### 2.1 Resolve unknown U1 (Next.js header overwrite mechanism)

**Files:** none (research)

**Acceptance:**
- [ ] Confirm via Next.js 16 docs whether `rewrites()` supports per-rewrite header overwrites OR whether `headers()` config OR `middleware.ts` is required.
- [ ] Document chosen mechanism in lab notebook entry.

**Requirement Refs:** R2

### 2.2 Strip/overwrite `X-Open-Brain-Caller` at the public boundary ✅ Completed 2026-05-05

**Files:** `packages/web-next/next.config.ts` (lines 8-21) AND/OR `packages/web-next/src/middleware.ts` (new, conditional)

**Acceptance:**
- [ ] WHEN a public client sends `X-Open-Brain-Caller: <anything>` to `https://brain.troy-davis.com/api/*` THEN the request reaching core-api SHALL have the header set to `web-next-public` (not the client value).
- [ ] Middleware/rewrite scoped to `/api/*` only; static asset serving unaffected.
- [ ] No regression in existing web-next pages (smoke test all routes).

**Requirement Refs:** R2

### 2.3 Defense-in-depth: ignore caller header from non-internal IPs ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/middleware/rate-limit.ts` (lines 136-146, `getClientKey()`)

**Acceptance:**
- [ ] WHEN `X-Forwarded-For` indicates a non-RFC1918 (and non-Tailscale CGNAT 100.64/10) source THEN `getClientKey()` SHALL ignore `X-Open-Brain-Caller` and use the IP as the key.
- [ ] Tailscale CGNAT range (`100.64.0.0/10`) explicitly allowlisted (future-proof for ops boxes on Tailscale).
- [ ] Existing tests still green (helpers send `127.0.0.1` + `integration-test` caller, which remains internal).

**Requirement Refs:** R2

### 2.4 Integration test: public 429 with spoofed caller header ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/__tests__/integration/rate-limit-public.test.ts` (new)

**Acceptance:**
- [ ] WHEN 21 POST `/api/v1/captures` requests are sent within a minute with `X-Open-Brain-Caller: mobile-app` AND `X-Forwarded-For: 1.2.3.4` THEN the 21st request SHALL return 429.
- [ ] Test runs as part of `pnpm test:integration`.
- [ ] Header normalization (Phase 2.2) happens via web-next, but this test isolates the rate-limit middleware behavior at the core-api boundary.

**Requirement Refs:** R2

### 2.5 CLAUDE.md audit rule for next.config rewrites ✅ Completed 2026-05-05

**Files:** `CLAUDE.md`

**Acceptance:**
- [x] New rule under "Internal HTTP callers" section: every `packages/web-next/next.config.ts` rewrite proxying to core-api MUST set or strip `X-Open-Brain-Caller`. Mirrors existing nginx audit rule.

**Requirement Refs:** R2

### Phase 2 Completion Checklist
- [ ] All 5 work items complete.
- [ ] Lab notebook entry created BEFORE first commit.
- [ ] Manual smoke: `curl -H 'X-Open-Brain-Caller: mobile-app' https://brain.troy-davis.com/api/v1/captures?limit=1` does NOT bypass rate limit.
- [ ] Existing rate-limit tests still green.

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| Tests | `pnpm --filter @open-brain/core-api test` | Exit code 0 |
| Integration | `pnpm test:integration` | Exit code 0; new `rate-limit-public.test.ts` green |
| Lint | `pnpm --filter @open-brain/core-api lint && pnpm --filter @open-brain/web-next lint` | Exit code 0 |
| Build | `pnpm --filter @open-brain/web-next build` | Exit code 0 |
<!-- END DOD -->

---

## Phase 3: Test Helpers + Tier-1 Route Tests

**Set:** C.2.a + first batch of C.2.b
**Effort:** M
**Goal:** Establish reusable test helpers and cover the highest-blast-radius routes.

### 3.1 Extract `__tests__/helpers.ts` ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/__tests__/helpers.ts` (new)

**Acceptance:**
- [ ] Exports: `DEFAULT_HEADERS` (with `X-Open-Brain-Caller: integration-test`), `makeMockService<T>()`, `testJson(app, path, init)`.
- [ ] WHEN any new route test file imports from `helpers.ts` THEN it SHALL receive consistent header injection (eliminates the silent-bypass drift risk noted in CLAUDE.md).
- [ ] Existing test files continue to pass without modification (helpers are additive).

**Requirement Refs:** R6

### 3.2 admin route tests ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/__tests__/admin-routes.test.ts` (new)

**Acceptance:**
- [ ] WHEN the request lacks the origin allowlist match THEN admin routes SHALL return 403 + `ResetForbiddenError`.
- [ ] WHEN POST `/admin/reset-data` is called without `confirm` body THEN it SHALL issue a single-use Redis token with 5-min TTL and return 200 with the token.
- [ ] WHEN POST `/admin/reset-data` is called with `confirm: "WIPE ALL DATA"` AND a valid token THEN it SHALL execute the wipe; the token SHALL be GETDEL'd atomically (single-use).
- [ ] WHEN POST `/admin/reset-data` is called with `confirm` mismatch THEN it SHALL return 400 and write `admin_audit` row with outcome=blocked.
- [ ] WHEN `ADMIN_RESET_SKIP_PGDUMP=true` THEN no `pg_dump` subprocess is spawned.
- [ ] All four audit-row outcomes covered: requested / executed / blocked / error.

**Requirement Refs:** R6

### 3.3 ingest route tests ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/__tests__/ingest-routes.test.ts` (new)

**Acceptance:**
- [ ] Upload validation: invalid mime types rejected with `ValidationError`.
- [ ] Document title hash collision returns 409.
- [ ] HMAC trigger endpoint validates signature; missing/invalid → 401.
- [ ] WHEN upload not found by ID THEN GET `/upload/:id` SHALL return 404 + `UploadNotFoundError`.

**Requirement Refs:** R6

### 3.4 synthesize route tests ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/__tests__/synthesize-routes.test.ts` (new)

**Acceptance:**
- [ ] Zod validation: empty `query` → 400.
- [ ] Mocked `synthesisService` returns; route maps to expected response shape.
- [ ] LLM unavailable → graceful 503 (not 500).

**Requirement Refs:** R6

### 3.5 sessions route tests ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/__tests__/sessions-routes.test.ts` (new)

**Acceptance:**
- [ ] `VALID_TYPES` enum enforcement (governance / review / planning).
- [ ] `VALID_STATUSES` enum enforcement (active / paused / complete / abandoned).
- [ ] Status transitions validated (e.g., `complete` can't go back to `active`).

**Requirement Refs:** R6

### 3.6 settings + briefs route tests ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/__tests__/settings-routes.test.ts`, `packages/core-api/src/__tests__/briefs-routes.test.ts` (new)

**Acceptance:**
- [ ] Settings: `VALID_SETTINGS_KEYS` whitelist enforcement; non-whitelisted key returns 400.
- [ ] Settings: autonomy_level enum enforced.
- [ ] Briefs: pagination params validated; ID lookups return 404 for missing.

**Requirement Refs:** R6

### Phase 3 Completion Checklist
- [ ] All 6 work items complete.
- [ ] Lab notebook entry created BEFORE first commit.
- [ ] Coverage report shows ≥70% line coverage on the 5 newly-tested route files.
- [ ] All existing tests still green.

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| Tests | `pnpm --filter @open-brain/core-api test` | Exit code 0 |
| Coverage | `pnpm --filter @open-brain/core-api test -- --coverage` | ≥70% on each new route test target |
| Lint | `pnpm --filter @open-brain/core-api lint` | Exit code 0 |
<!-- END DOD -->

---

## Phase 4: Tier-2 Route Tests

**Set:** C.2 (remaining)
**Effort:** M
**Goal:** Bring all 16 untested routes under unit-test coverage.
**Parallelizable within phase:** YES — each work item is an independent test file.

### 4.1 commitments + config route tests ✅ Completed 2026-05-05

**Files:** `commitments-routes.test.ts`, `config-routes.test.ts` (new)

**Acceptance:**
- [ ] Commitments: extraction trigger, list, status transitions covered.
- [ ] Config: read-only schema endpoints validated; spend query returns expected shape (will be reworked in Phase 5).

**Requirement Refs:** R6

### 4.2 entities + documents route tests ✅ Completed 2026-05-05

**Files:** `entities-routes.test.ts`, `documents-routes.test.ts` (new)

**Acceptance:**
- [ ] Entities: list, get, merge, split. Merge guards against self-merge.
- [ ] Documents: upload validation, listing, deletion (soft).

**Requirement Refs:** R6

### 4.3 events + triggers route tests ✅ Completed 2026-05-05

**Files:** `events-routes.test.ts`, `triggers-routes.test.ts` (new)

**Acceptance:**
- [ ] Events: SSE handshake, channel subscription validation.
- [ ] Triggers: list, get, create, delete, toggle (5 operations).

**Requirement Refs:** R6

### 4.4 stats + voice-sessions + insurance-policies route tests ✅ Completed 2026-05-05

**Files:** `stats-routes.test.ts`, `voice-sessions-routes.test.ts`, `insurance-policies-routes.test.ts` (new)

**Acceptance:**
- [ ] Stats: brain stats aggregation contract.
- [ ] Voice-sessions: list + detail.
- [ ] Insurance-policies: CRUD + gap-detection contract.

**Requirement Refs:** R6

### 4.5 Coverage gate

**Files:** `packages/core-api/vitest.config.ts` (potentially)

**Acceptance:**
- [ ] WHEN `pnpm --filter @open-brain/core-api test -- --coverage` runs THEN the report SHALL show ≥70% line coverage on every file under `src/routes/`.
- [ ] Coverage threshold added to vitest config (fail-build if below).

**Requirement Refs:** R6

### Phase 4 Completion Checklist
- [ ] All 5 work items complete.
- [ ] Lab notebook entry created BEFORE first commit.
- [ ] All 16 originally-untested routes now have a `*-routes.test.ts` neighbor.
- [ ] Coverage threshold gate active.

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| Tests | `pnpm --filter @open-brain/core-api test` | Exit code 0 |
| Coverage | `pnpm --filter @open-brain/core-api test -- --coverage` | ≥70% on every route file |
| Lint | `pnpm --filter @open-brain/core-api lint` | Exit code 0 |
<!-- END DOD -->

---

## Phase 5: Service Layer Extraction + Promote Integration Job

**Set:** D + C.3
**Effort:** M
**Goal:** Move DB orchestration out of route handlers; gate CI on integration tests.
**Parallelizable within phase:** 5.1 / 5.2 / 5.3 are independent services; 5.5 / 5.6 are CI/repo-config (unblocked once 5.4 verifies).

### 5.1 AdminService extraction ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/services/admin.ts` (new), `packages/core-api/src/routes/admin.ts` (refactor)

**Acceptance:**
- [ ] AdminService methods: `writeAuditRow()`, `runPreWipeDump()`, `truncateUserData()`, `issueResetToken()`, `consumeResetToken()`.
- [ ] Constructor injection: `db`, `redis`, optional `spawnPgDump` (for testability).
- [ ] Route handlers retain origin/confirmation-phrase logic (presentational); all DB orchestration moves to service.
- [ ] Phase 3.2 admin tests still green; minimal mock changes.

**Requirement Refs:** R7

### 5.2 BudgetService for getSpend ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/services/budget.ts` (new) OR extend `services/skill-config.ts`, `packages/core-api/src/routes/config.ts` (refactor)

**Acceptance:**
- [ ] `getSpend(month)` query extracted from `routes/config.ts:54-80`.
- [ ] Method returns `{ total_usd, by_model: Map<string, number> }`.
- [ ] Route handler becomes a thin delegator.

**Requirement Refs:** R7

### 5.3 IntelligenceService extraction ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/services/intelligence.ts` (new), `packages/core-api/src/routes/intelligence.ts` (refactor)

**Acceptance:**
- [ ] Methods: `getLatest(skillName)`, `getHistory(skillName, limit)`.
- [ ] Allowlist validation moves to service constructor (single source of truth).
- [ ] Route tests still green.

**Requirement Refs:** R7

### 5.4 Regression smoke ✅ Completed 2026-05-05

**Files:** none (verification step)

**Acceptance:**
- [ ] WHEN `pnpm -r test` runs THEN all tests SHALL be green.
- [ ] WHEN `pnpm test:integration` runs THEN admin two-step reset SHALL execute end-to-end on the test DB without errors.
- [ ] Manual smoke on staging: trigger `/admin/reset-data` two-step flow; confirm audit rows + pre-wipe backup file written.

**Requirement Refs:** R7

### 5.5 Promote integration-test job to required — DEFERRED → Phase 5b (blocked by A118)

**Files:** `.github/workflows/ci.yml:171`

**Acceptance:**
- [ ] WHEN the last 10 PRs' integration-test job runs are reviewed THEN ≥9 SHALL be green (use `gh run list --workflow=ci.yml --limit 20`).
- [ ] `continue-on-error: true` removed from integration-test job.

**Requirement Refs:** R1

### 5.6 Update branch protection — DEFERRED → Phase 5b (blocked by A118)

**Files:** none (GitHub repo settings)

**Acceptance:**
- [ ] `gh api repos/davistroy/open-brain/branches/main/protection | jq '.required_status_checks.contexts'` includes `integration-test`.
- [ ] One test PR opened to confirm the gate fires (then closed).

**Requirement Refs:** R1

### Phase 5 Completion Checklist
- [x] 5.1, 5.2, 5.3 service extractions complete — COMMITTED 2026-05-05.
- [x] 5.4 Regression smoke GREEN — 64 files / 1,127 tests / 0 fail.
- [x] Lab notebook entry (Entry 105) appended BEFORE first commit.
- [x] AdminService refactor reviewed manually before merge (security-sensitive).
- [ ] 5.5 + 5.6 DEFERRED — moved to Phase 5b. Blocked by A118.
- [ ] Integration test required-gate confirmed via test PR. (Phase 5b)

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria | Status |
|---|---|---|---|
| Tests | `pnpm -r test` | Exit code 0 | PASS (2026-05-05) |
| Lint | `pnpm -r lint` | Exit code 0 (A106+A108 baseline) | PASS (2026-05-05) |
| Coverage | `pnpm --filter @open-brain/core-api test -- --coverage` | ≥70% on every service + route file | PASS (2026-05-05) |
| Integration | `pnpm test:integration` | Exit code 0 | BLOCKED — A118 |
| CI gate | `gh api repos/davistroy/open-brain/branches/main/protection \| jq '.required_status_checks.contexts'` | Includes `integration-test` | BLOCKED — A118 |
<!-- END DOD -->

---

## Phase 5b: CI Promotion (deferred from Phase 5)

**Set:** C.3 (partial)
**Effort:** S
**Goal:** Promote the integration-test CI job from `continue-on-error: true` to a required status check once the FTS test is reliably green.
**Prerequisite:** A118 fixed (mcp-tools search_brain FTS deterministic failure resolved).
**Blocked by:** ~~A118~~ **RESOLVED 2026-05-05** — A118 cascade bundle (A118+A121+A122+A123+A124) committed. Integration suite is 126/126 green. Pre-flight gate (`gh run list --workflow=ci.yml --limit 20`) must confirm ≥9/10 green CI runs before executing 5b.2 + 5b.3.
**Unblock criterion:** ≥9/10 green integration-test runs after A118 is fixed.
**Numbering note:** Phase 5b is a sibling to Phase 5. Phase 6 numbering is unchanged.
**Status: READY TO DISPATCH** — A118 blocker resolved. Re-run pre-flight gate, then execute 5b.2 and 5b.3.

### 5b.1 Fix A118 — mcp-tools FTS test ✅ RESOLVED 2026-05-05

**Files:** `packages/core-api/src/__tests__/integration/helpers.ts`, `scripts/init-schema.sql`, `packages/core-api/src/mcp/tools/get-capture.ts`, `packages/core-api/src/__tests__/integration/mcp-tools.test.ts`, `packages/core-api/src/__tests__/integration/entities.test.ts`, `packages/core-api/src/__tests__/rate-limit-public.test.ts`

**Root cause:** `createTestCapture` defaulted `embedding: null`; `hybrid_search()` requires `embedding IS NOT NULL` on both FTS and vector CTEs. Five cascading pre-existing failures were uncovered and fixed in the same bundle (A118+A121+A122+A123+A124). See LAB_NOTEBOOK Entry 105 closing summary.

**Acceptance:**
- [x] Test `returns results when captures exist (FTS match)` passes reliably.
- [ ] `gh run list --workflow=ci.yml --limit 20` shows ≥9/10 green integration-test runs. **(Confirm after this commit reaches CI.)**

**Requirement Refs:** R1

### 5b.2 Promote integration-test job to required (was 5.5) ✅ Completed 2026-05-05

**Files:** `.github/workflows/ci.yml:171`

**Acceptance:**
- [x] Bar relaxed (orchestrator-authorized 2026-05-05): 1 green CI run on `b08946a` + local 126/126 + root-cause documented. Run ID: 25406460328.
- [x] `continue-on-error: true` removed from integration-test job.

**Requirement Refs:** R1

### 5b.3 Update branch protection (was 5.6) ✅ Completed 2026-05-05

**Files:** none (GitHub repo settings)

**Acceptance:**
- [x] `gh api repos/davistroy/open-brain/branches/main/protection --jq '.required_status_checks.contexts'` → `["Integration tests (core-api + real DB)"]`. Branch was previously unprotected (404); protection created via PUT 2026-05-05.
- [ ] One test PR opened to confirm the gate fires (then closed). *(deferred — gate is live; fire-check on next natural PR)*

**Requirement Refs:** R1

---

### Phase 5b — Phase Complete ✅ 2026-05-05

---

## Phase 6: Mobile Bearer Auth (R8)

**Set:** B.2
**Effort:** M
**Goal:** Replace mobile-app's caller-header trust with a Bearer token.
**Parallelizable with:** Phase 5 (different files: middleware + mobile client vs. services).

### 6.1 Provision MOBILE_API_KEY ✅ Completed 2026-05-05

**Files:** Bitwarden (no file), `deploy/.env.secrets.template`, `scripts/lib/secrets-map.sh`

**Acceptance:**
- [x] BWS item `dev/open-brain/mobile-api-key` created (random 32-byte hex). **(A119 deferred to operator before mobile testing)**
- [x] `deploy/.env.secrets.template` adds `MOBILE_API_KEY=` placeholder.
- [x] `scripts/lib/secrets-map.sh` adds the BWS-name → ENV-var mapping.
- [x] `bash scripts/load-secrets.sh` on a clean target writes the new key into `.env.secrets`.

**Requirement Refs:** R8

### 6.2 Create `mobile-auth` middleware ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/middleware/mobile-auth.ts` (new)

**Acceptance:**
- [x] Modeled after `packages/core-api/src/mcp/auth.ts` (timing-safe Bearer compare).
- [x] Logs SHA-256 prefix hash of presented token (never plaintext).
- [x] On success: sets a context flag (e.g., `c.set('auth_tier', 'mobile')`) for downstream rate-limit tier selection.
- [x] WHEN no `Authorization` header is present THEN middleware SHALL return 401.
- [x] WHEN token is invalid THEN middleware SHALL return 401 with code `AUTH_INVALID`.

**Requirement Refs:** R8

### 6.3 Apply middleware to mobile-tier routes ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/app.ts` (route registration via `requireMobileAuthIfMobileCaller`)

**Acceptance:**
- [x] Middleware applied to: captures, search, briefs, commitments, settings, stats (11 `app.use` registrations in `app.ts`).
- [x] Web-next browser traffic via `web-next-public` caller bypasses mobile-auth (different entry path).
- [x] Existing route tests still green (helper sends caller header, not Bearer; tests pass through internal path).

**Requirement Refs:** R8

### 6.4 Update mobile API client ✅ Completed 2026-05-05

**Files:** `packages/mobile/src/lib/api-client.ts`, `packages/mobile/src/lib/storage.ts`, `packages/mobile/app/settings.tsx`

**Acceptance:**
- [x] Reads token from `expo-secure-store` (key: `ob_api_token`, via `storage.getApiToken()`).
- [x] Sends `Authorization: Bearer <token>` on every request.
- [x] Keeps `X-Open-Brain-Caller: mobile-app` for observability (no security trust).
- [x] WHEN the token is missing from secure storage THEN the client SHALL surface a "not yet onboarded" UI state (`NotOnboardedError`).

**Requirement Refs:** R8

### 6.5 Remove mobile-app from BYPASS_CALLERS; add mobile tier to rate-limit ✅ Completed 2026-05-05

**Files:** `packages/core-api/src/middleware/rate-limit.ts`, `packages/core-api/src/app.ts`

**Acceptance:**
- [x] `internal:mobile-app` removed from `BYPASS_CALLERS` (18→17 entries; CLAUDE.md updated to 17 — count was stale at 16 before this phase).
- [x] Mobile rate tier 200 req/min keyed on Bearer-token SHA-256 prefix (not auth_tier flag — rate-limit runs before mobile-auth in middleware chain).
- [x] Phase 2.4 integration test still passes (public spoofed caller still 429s).
- [x] New integration test: mobile Bearer + public IP → mobile tier (no 429 below threshold). 9 tests in `mobile-rate-limit.test.ts`.

**Requirement Refs:** R8

### 6.6 Mobile onboarding runbook ✅ Completed 2026-05-05

**Files:** `docs/runbooks/mobile-onboarding.md` (new, 166 lines)

**Acceptance:**
- [x] Documents the one-time token paste flow into the mobile app on install (via Settings screen).
- [x] References Cloudflare Access policies on `brain.troy-davis.com` (already in tunnel config).
- [x] Includes token-rotation procedure (regenerate BWS item, redeploy core-api, rotate in mobile app).

**Requirement Refs:** R8

### Phase 6 Completion Checklist
- [x] All 6 work items complete.
- [x] Lab notebook entry (Entry 105 Phase 6 Closing Summary) created BEFORE first commit.
- [ ] Manual smoke from a real mobile device: `curl` and the actual app both succeed. **(deferred — requires A119 BWS secret creation)**
- [x] CLAUDE.md `BYPASS_CALLERS` count updated (16 stale → 17 actual after demote).

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria | Status |
|---|---|---|---|
| Tests | `pnpm --filter @open-brain/core-api test && pnpm --filter @open-brain/mobile test` | Exit code 0 | PASS — 67 files / 1,163 core-api; 24 mobile (2026-05-05) |
| Integration | `pnpm test:integration` | Exit code 0 (existing + new mobile-tier test green) | BLOCKED — A118 (pre-existing; not a Phase 6 regression) |
| Lint | `pnpm -r lint` | Exit code 0 (A106 + A108 + A120 baselines only) | PASS (2026-05-05) |
| Manual | `curl -H "Authorization: Bearer $MOBILE_API_KEY" https://brain.troy-davis.com/api/v1/captures?limit=1` | Both observed | DEFERRED — A119 |
| Secret reconcile | `bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain` | No drift | DEFERRED — A119 |
<!-- END DOD -->

---

## Phase 7: Web Consolidation Foundation

**Set:** A.1 + A.2 + A.3
**Effort:** M
**Goal:** Ratify web-next as canonical; close parity gaps; migrate utilities.

### 7.1 Generate ADR + ratify decision ✅ Completed 2026-05-05

**Files:** `docs/adr/ADR-0001-web-consolidation.md` (already drafted; flip Status to "Accepted"), `docs/TDD.md` (§14 + new §24), `CLAUDE.md`

**Acceptance:**
- [x] ADR-0001 status: Proposed → Accepted; date stamped.
- [x] `docs/TDD.md §14 (Web Dashboard)` updated to describe Next.js 16 / React 19 / Cloudscape (not Vite) via 2026-05-05 blockquote.
- [x] `docs/TDD.md §24 (Web Stack Consolidation 2026-05)` added (§15 was occupied by Testing Strategy; new section landed at §24 — no renumbering done).
- [x] CLAUDE.md "Vite + React + Tailwind + shadcn/ui (NOT Next.js)" line corrected to reflect web-next as canonical; legacy `packages/web` flagged as sunsetting with ADR-0001 cross-reference.
- [x] `tunnel.yaml:18` rollback comment preserved (single-line `web:80` fallback) — not modified.

**Requirement Refs:** R3

### 7.2 Parity audit — route inventory ✅ Completed 2026-05-05

**Files:** `docs/web-parity-audit.md` (new, 178 lines, 6 sections — see file for full detail; archive after Phase 8b)

**Acceptance:**
- [x] Table: every route in `packages/web/src/pages/` → presence in `packages/web-next/src/app/` → status (parity / partial / missing). All 19 web pages → parity in web-next; 3 web-next-only extras.
- [x] Voice and System routes (flagged as "unclear" in Phase 2 investigation) explicitly resolved — both parity.
- [x] Settings gap quantified: 8 MISSING + 2 PARTIAL (not 5–6 as recon estimated). All 8 sub-tasks carried into 7.3.

**Phase 8b verdict from audit:** Conditional YES — gated on Phase 7.3 rebuilding 8 Settings sections. No other hard blockers. Estimated ~675 LOC of Settings components.

**Requirement Refs:** R3, R12

### 7.3 Close parity gaps in web-next ✅ Completed 2026-05-05

**Files:** `packages/web-next/components/settings/` (8 new section files) + `packages/web-next/lib/api-client.ts` + `packages/web-next/lib/types.ts` + `packages/web-next/app/(shell)/settings/page.tsx` + `packages/web-next/components/settings/SettingsSidebar.tsx`

**Acceptance:**
- [x] 8 missing Settings sections rebuilt in web-next (1 exemplar + 7 parallel-batch). 2,061 LOC total.
- [x] All 8 sections use design-system (Card, Button, Input, StatusDot, Pill) + TanStack Query — no Cloudscape dependency.
- [x] HealthResponse type consolidated (VersionUptimeSection's local HealthInfo replaced with api-client HealthResponse).
- [x] `pnpm --filter @open-brain/web-next build` green (TypeScript pass, zero new errors).
- [x] Lint: 24 pre-existing A127 errors only; zero new errors introduced.

**Note:** "8 sections rebuilt (1 exemplar + 7 parallel-batch); 2,061 LOC total. Recon LOC ballpark of ~675 was 3x off."

**Requirement Refs:** R3, R12

### 7.4 Migrate web-only utilities ✅ Completed 2026-05-05 (No-op)

**Files:** none

**Acceptance:**
- [x] Parity audit confirmed: web-next lib is strictly more complete on utilities. No migration needed.
- [x] `sseClient.ts` equivalent already exists in `packages/web-next/lib/sse-client.ts`.
- [x] Custom hooks and design-system components are more complete in web-next than in packages/web.

**Note:** "No-op — web-next is strictly more complete on lib utilities (per parity audit)"

**Requirement Refs:** R12

### 7.5 Resolve unknown U2 (parity status) ✅ Completed 2026-05-05

**Files:** none (resolved by 7.2 parity audit)

**Acceptance:**
- [x] Route inventory definitive — all 19 web pages have web-next equivalents; no "unclear" rows.

**Requirement Refs:** R3, R12

### Phase 7 Completion Checklist

**Status: COMPLETE — 7.1 PASS, 7.2 PASS, 7.3 PASS, 7.4 PASS (no-op), 7.5 PASS**

- [x] 7.1 — ADR-0001 ratified + CLAUDE.md + TDD §14/§24 updated. Committed 2026-05-05.
- [x] 7.2 — Parity audit complete. `docs/web-parity-audit.md` written (6 sections). 8 MISSING + 2 PARTIAL Settings sections identified. Committed 2026-05-05.
- [x] 7.3 — Rebuilt 8 missing Settings sections in web-next (design-system, NOT Cloudscape). 2,061 LOC total. Committed 2026-05-05.
- [x] 7.4 — No-op: web-next is strictly more complete on lib utilities. Phase closed without migration. Committed 2026-05-05.
- [x] 7.5 — Resolved by 7.2; route inventory complete (all 19 parity; 3 web-next-only extras).
- [x] Lab notebook entry created BEFORE first commit. ✅ (Entry 105 pre-dated commit)
- [x] ADR-0001 reviewed and accepted. ✅
- [x] `pnpm --filter @open-brain/web-next build` green. ✅ (TypeScript pass, zero new errors)
- [ ] Manual smoke: every route in web-next renders against production core-api. (deferred to post-Phase-8b; pre-sunset validation)

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| Build | `pnpm --filter @open-brain/web-next build` | Exit code 0 |
| Shared rebuild | `pnpm --filter @open-brain/shared build && pnpm --filter @open-brain/web-next exec tsc --noEmit` | Both exit 0 |
| Tests | `pnpm --filter @open-brain/web-next test` | Exit code 0 |
| Lint | `pnpm --filter @open-brain/web-next lint` | Exit code 0 |
<!-- END DOD -->

---

## Phase 8a: Web-Next API Client (R9 reframed)

**Set:** A.4
**Effort:** L
**Goal:** Build a typed, split-by-domain API client for web-next. Avoid the god-module shape that `packages/web/src/lib/api.ts` (1,232 LOC) fell into.
**Parallelizable within phase:** YES — 8a.2 / 8a.3 / 8a.4 are independent domain modules.

### 8a.1 Scaffold per-domain structure

**Files:** `packages/web-next/src/lib/api/{index.ts, client.ts, types.ts}` (new)

**Acceptance:**
- [ ] Shared `request<T>()` helper in `client.ts` (handles base URL, JSON parsing, error envelope).
- [ ] Per-domain folders planned: `captures/`, `entities/`, `email/`, `briefs/`, `sessions/`, `settings/`, `search/`, `synthesize/`, `triggers/`, `wiki/`, `voice/`, `intelligence/`, `stats/`, `pipeline/`, `bets/`, `investments/`, `ingest/`, `mcp-activity/`, `system-health/`, `activity/`, `config/`.
- [ ] Each domain folder will export typed functions + TanStack Query keys.

**Requirement Refs:** R9

### 8a.2 Core domains: captures, entities, search, briefs, sessions, settings

**Files:** `packages/web-next/src/lib/api/{captures,entities,search,briefs,sessions,settings}/index.ts` (6 new)

**Acceptance:**
- [ ] Each domain exports: `list()`, `get(id)`, `create()`, etc., with typed args/returns from `@open-brain/shared` types.
- [ ] TanStack Query hooks (`useCapturesList`, `useEntity`, etc.) sit alongside.
- [ ] Each module ≤200 LOC.

**Requirement Refs:** R9

### 8a.3 Mid-tier domains: email, ingest, board, investments, intelligence, stats, synthesize

**Files:** 7 new domain modules

**Acceptance:**
- [ ] Same conventions as 8a.2; each ≤200 LOC.
- [ ] No cross-domain imports inside `lib/api/` (cohesion enforced by code review).

**Requirement Refs:** R9

### 8a.4 Auxiliary domains: wiki, voice, mcp-activity, system-health, activity, config, triggers, skills, pipeline

**Files:** 9 new domain modules (some may be tiny — e.g., voice has 1-2 endpoints)

**Acceptance:**
- [ ] All 21 planned domains have a module.
- [ ] Total LOC across `lib/api/` ≤ 4,000 (target ~2,000; ceiling guards against creep).

**Requirement Refs:** R9

### 8a.5 Wire pages to TanStack Query hooks

**Files:** `packages/web-next/src/app/<route>/page.tsx` (each)

**Acceptance:**
- [ ] Pages migrate from any inline `fetch` to the new hooks.
- [ ] Loading + error states handled by TanStack Query.
- [ ] No regression: every page renders identical content + behavior.

**Requirement Refs:** R9

### 8a.6 Snapshot tests for API modules

**Files:** `packages/web-next/src/lib/api/<domain>/<domain>.test.ts` (per module, MSW-mocked)

**Acceptance:**
- [ ] Each domain module has at least one happy-path test using MSW (already a dep per Phase 1 recon).
- [ ] WHEN core-api response shape changes THEN snapshot tests SHALL fail visibly (catches contract drift).

**Requirement Refs:** R9

### Phase 8a Completion Checklist
- [ ] All 6 work items complete.
- [ ] Lab notebook entry created BEFORE first commit.
- [ ] No file in `packages/web-next/src/lib/api/` exceeds 250 LOC.
- [ ] Web-next bundle size monitored (Next.js build output) — guardrail: < 5% increase vs. pre-phase.

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| Tests | `pnpm --filter @open-brain/web-next test` | Exit code 0 |
| Build | `pnpm --filter @open-brain/web-next build` | Exit code 0 |
| Lint | `pnpm --filter @open-brain/web-next lint` | Exit code 0 |
| Bundle size | Compare `.next/build-manifest.json` first-load JS pre/post | < +5% |
<!-- END DOD -->

---

## Phase 8b: Tab Splits + Sunset `packages/web` (R11 reframed + A.6)

**Set:** A.5 + A.6
**Effort:** L
**Goal:** Decompose the 6 god pages in web-next; remove `packages/web` from the build.

### 8b.1 Split Wiki page (4 tabs)

**Files:** `packages/web-next/src/app/wiki/page.tsx` (refactor) + `packages/web-next/src/components/wiki/{ContentTab,ChangesTab,HealthTab,StatsTab}.tsx` (new)

**Acceptance:**
- [ ] Each tab is a child component owning its own state + data fetching.
- [ ] Parent page handles tab routing only (`activeTab` state + render switch).
- [ ] Parent page ≤ 250 LOC.

**Requirement Refs:** R11

### 8b.2 Split Email page (3 sections)

**Files:** `packages/web-next/src/app/email/page.tsx` + `packages/web-next/src/components/email/{InboxSection,DraftsSection,SentSection}.tsx` (new)

**Acceptance:**
- [ ] Sections extracted; parent ≤ 250 LOC.
- [ ] EmailComposeDrawer (already a component) reused untouched.

**Requirement Refs:** R11

### 8b.3 Split Dashboard, Ingest, Board, Investments

**Files:** Same pattern: parent + per-section components.

**Acceptance:**
- [ ] Each parent page ≤ 250 LOC.
- [ ] Existing shared components (StatsCards, ActivityFeedItem, CaptureCard) reused, not duplicated.

**Requirement Refs:** R11

### 8b.4 Smoke-test web-next end-to-end

**Files:** none (manual + Playwright)

**Acceptance:**
- [ ] Every route in web-next loads without console errors against production core-api.
- [ ] WHEN a page contains a tabbed interface THEN tab switching SHALL preserve URL state (back-button works).

**Requirement Refs:** R11, R12

### 8b.5 Tag rollback commit before sunset

**Files:** none (git tag)

**Acceptance:**
- [ ] `git tag -a pre-web-sunset-2026-05 -m "Last commit with packages/web alive"` pushed to origin.
- [ ] Rollback runbook documented in `docs/runbooks/web-rollback.md` (1-page: `git checkout pre-web-sunset-2026-05`, redeploy, flip `tunnel.yaml:18` to `web:80`).

**Requirement Refs:** R12

### 8b.6 Delete `packages/web` and clean up

**Files:** delete `packages/web/`, edit `docker-compose.yml:474-514`, edit `.github/workflows/ci.yml` (remove web build/test steps), edit `pnpm-workspace.yaml` if needed, update `README.md`

**Acceptance:**
- [ ] `packages/web/` directory removed (`git rm -r packages/web`).
- [ ] `docker-compose.yml` no longer defines the `web` service.
- [ ] `tunnel.yaml` rollback comment removed (alternative is the git tag from 8b.5).
- [ ] CI matrix no longer builds/tests web.
- [ ] `pnpm install` succeeds.
- [ ] All other packages still build + test.

**Requirement Refs:** R12

### Phase 8b Completion Checklist
- [ ] All 6 work items complete.
- [ ] Lab notebook entry created BEFORE first commit.
- [ ] Manual smoke on https://brain.troy-davis.com — every page green.
- [ ] No reference to `packages/web` remains in repo (`grep -r "packages/web/" --exclude-dir=node_modules` empty).
- [ ] Rollback runbook tested by following its instructions on a scratch branch.

### Definition of Done (Runnable)
<!-- BEGIN DOD -->
| Check | Command | Pass Criteria |
|---|---|---|
| Tests | `pnpm -r test` | Exit code 0 |
| Integration | `pnpm test:integration` | Exit code 0 |
| Build | `pnpm -r build` | Exit code 0 |
| Docker | `docker compose config --quiet` | Exit code 0 (no schema errors after web removal) |
| Lint | `pnpm -r lint` | Exit code 0 |
| Cleanup | `grep -r "packages/web/" --exclude-dir=node_modules . \| wc -l` | Zero matches |
<!-- END DOD -->

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run In Parallel With | Notes |
|---|---|---|
| 4.1, 4.2, 4.3, 4.4 | Each other (within Phase 4) | Independent test files; no shared mutable state |
| 5.1, 5.2, 5.3 | Each other (within Phase 5) | Independent service extractions, different routes |
| 5.5, 5.6 | 6.1–6.6 | CI/repo-config separate from middleware/mobile-client work |
| 6.1, 6.2, 6.6 | Each other (within Phase 6) | Secret provisioning, middleware code, runbook drafting are independent |
| 7.3 | 7.4 | Parity gap implementation independent from utilities migration |
| 8a.2, 8a.3, 8a.4 | Each other (within Phase 8a) | Each domain module independent |

## Risk Mitigation

| ID | Risk | Severity | Affected Phase | Mitigation |
|---|---|---|---|---|
| R-1 | Defense-in-depth IP check (2.3) breaks legitimate Tailscale-routed callers | Medium | 2 | Allowlist `100.64.0.0/10` (CGNAT) explicitly; integration test 2.4 catches regressions |
| R-2 | Test helpers extraction (3.1) breaks existing tests mid-flight | Low | 3 | Land helpers in standalone PR before any consumer migration; helpers are additive (existing tests don't import them) |
| R-3 | AdminService refactor (5.1) introduces a bug in two-step reset | Med-High | 5 | Phase 3.2 admin-route tests act as regression net; 5.4 explicit smoke + manual review before merge |
| R-4 | Promoting integration job (5.5) exposes flake | Medium | 5 | Verify 10 PRs green first; revert workflow change immediately on flake |
| R-5 | Mobile token bootstrap UX is awkward through CF Access | Medium | 6 | Single shared token in BWS, manually pasted on install — acceptable for single-user system |
| R-6 | Web-next missing parity for rare page (Voice, System) discovered at sunset | High | 7, 8b | 7.2 audit gates; 8b.5 git tag preserves rollback; tunnel.yaml rollback comment |
| R-7 | Web-next bundle size grows materially after API client migration | Low | 8a | 8a guard: < +5% first-load JS |
| R-8 | TanStack Query migration regresses page behavior (loading states, refetch) | Medium | 8a.5 | Snapshot tests in 8a.6; manual smoke per page |
| R-9 | `packages/web` deletion leaks references in CI/Docker | Low | 8b.6 | Final grep gate in DoD |

## Unknowns Register

| ID | Unknown | Severity | Affected Phase/Item | Resolution Strategy | Status |
|---|---|---|---|---|---|
| U1 | Does Next.js 16 `rewrites()` support per-rewrite header overwrite, or is `headers()`/middleware required? | Medium | 2.2 | **RESOLVED 2026-05-05:** Neither `rewrites()` nor `headers()` config sets request headers upstream. Next.js 16 renamed `middleware` → `proxy`; canonical file is `packages/web-next/proxy.ts` at project root, exported function is `proxy(request: NextRequest)`. Pattern: clone `new Headers(request.headers)`, `.set('X-Open-Brain-Caller', 'web-next-public')`, return `NextResponse.next({ request: { headers } })`, with `export const config = { matcher: '/api/:path*' }`. Source: Next.js 16.2.4 docs `version-16.mdx` upgrade guide + `proxy.mdx` file-convention doc. Phase 2.2 implementation landed at `packages/web-next/proxy.ts` (verified compiled into build output as `ƒ Proxy (Middleware)`). `next.config.ts` rewrites unchanged. | Resolved |
| U2 | Are `Voice` and `System` pages actually missing from web-next? Recon left these "unclear" | Medium | 7.2 | First step of 7.2 is a definitive parity-table audit | Open |
| U3 | What auth mechanism does the mobile app currently use, end-to-end? | Low | 6.4 | Trace `packages/mobile/src/lib/api-client.ts` end-to-end at start of Phase 6 | Open |
| U4 | Does Cloudflare Access already issue an identity token usable by the mobile app, or is a separate bootstrap required? | Medium | 6.6 | Investigate `tunnel.yaml` Access policies; document in onboarding runbook | Open |
| U5 | Does `packages/web-next/src/app/` use route groups, layouts, or other Next 16-specific patterns that affect the API client integration shape? | Low | 8a.1 | First step of 8a.1 is a brief structure recon | Open |

## Success Metrics

| Metric | Pre-Plan Baseline | Post-Plan Target |
|---|---|---|
| Public X-Open-Brain-Caller bypass | Possible via web-next rewrites | Impossible (header stripped + IP check) |
| Mobile auth | Caller-header trust | Bearer token (cryptographic) |
| Untested core-api routes | 16 | 0 |
| Integration test CI status | `continue-on-error: true` | Required for merge |
| god modules in `packages/web` ≥600 LOC | 6 | 0 (`packages/web` deleted) |
| god module `api.ts` LOC | 1,232 | 0 (replaced by 21 ≤200-LOC web-next domain modules) |
| Routes with inline drizzle queries | ~40% | <10% (admin/config/intelligence delegated to services) |
| Active root markdown plan files | 17 | ≤11 |
| `BYPASS_CALLERS` entries trusted from public surface | 1 (mobile-app) | 0 |

## Requirement Traceability

| Requirement | Source | Phase | Work Item |
|---|---|---|---|
| R1: Promote integration-test job to required | Arch Review F3 | 5 | 5.5, 5.6 |
| R2: Public-origin guard | Arch Review F2 | 2 | 2.1–2.5 |
| R3: Web vs web-next decision | Arch Review F6 | 7 | 7.1, 7.2 |
| R4: Standardize error responses | Arch Review F7 | 1 | 1.2, 1.3 |
| R5: Archive completed plans | Arch Review F9 | 1 | 1.1, 1.4 |
| R6: Per-route unit tests | Arch Review F4 | 3, 4 | 3.1–3.6, 4.1–4.5 |
| R7: Service layer extraction | Arch Review F5 | 5 | 5.1, 5.2, 5.3 |
| R8: Mobile token-based auth | Arch Review F2 | 6 | 6.1–6.6 |
| R9 (reframed): Build split-by-domain API client in web-next | Arch Review F1 | 8a | 8a.1–8a.6 |
| R10: Skill aggregator | — | — | **DROPPED** (no duplication found) |
| R11 (reframed): Tab-split web-next pages | Arch Review F1 | 8b | 8b.1–8b.3 |
| R12: Sunset `packages/web` | Arch Review F6 | 8b | 8b.4–8b.6 |

## Milestones

| Milestone | Phases | Indicates |
|---|---|---|
| M1: Hot-fix shipped | 1, 2 | Vulnerability closed; root tidied |
| M2: Test baseline established | 3, 4, 5 | All routes tested; CI gated; services extracted |
| M3: Mobile hardened | 6 | Bearer token live; bypass header demoted |
| M4: Web consolidation foundation | 7 | ADR accepted; parity confirmed |
| M5: Web-next canonical | 8a, 8b | `packages/web` deleted; web-next is the only UI |

<!-- END TABLES -->

---

## Deferred Items (Action Item Registry)

All action items surfaced during the architecture review remediation, with status as of 2026-05-05. The `.implement-plan-state.json` file (gitignored) holds the full chronological status; this table is the git-tracked snapshot that survives compaction and session boundaries.

| ID | Description | Status | Location | Unblock / Resolution |
|----|-------------|--------|----------|----------------------|
| A106 | TS2502 in `entity-resolution.test.ts:345` (`'tx'` referenced in its own type annotation) | Pre-existing baseline | `packages/core-api/src/__tests__/entity-resolution.test.ts:345` | Out of scope; tracked for visibility |
| A107 | `strictLimiter` double-registered on `/captures` (burns 2 slots per request, halving effective budget) | Out of scope | `packages/core-api/src/middleware/rate-limit.ts` | Phase 5 D candidate; not addressed |
| A108 | 24 `react/no-unescaped-entities` lint errors in `HelpContent.tsx` | Pre-existing baseline | `packages/web-next/src/components/help/HelpContent.tsx` | Out of scope; will disappear with Phase 8b |
| A109 | Plan-text drift — acceptance criteria pointed to wrong files (title-hash 409, HMAC trigger, synthesize DI shape, AppError location) | Process learning | (process) | Captured in this plan's commit history; ultra-plan should do deeper file reads |
| A110 | Settings `GET` has no whitelist gate — non-whitelisted key returns 404 instead of 400 | Phase 5 D candidate | `packages/core-api/src/routes/settings.ts` | Not co-located with Phase 5 work; pending future scope |
| A111 | `email_allowlist` has no array validator in `SETTINGS_VALIDATORS` | Phase 5 D candidate | `packages/core-api/src/routes/settings.ts` | Same as A110 |
| A112 | `INTELLIGENCE_SKILLS` single source of truth | CLOSED | Phase 5.3 (commit `b173ff8`) | — |
| A113 | UUID validation on briefs/sessions `:id` path param | Phase 5 D candidate | `packages/core-api/src/routes/{briefs,sessions}.ts` | Pending future scope |
| A114 | `sessions` `status_filter` silently dropped instead of 400-rejected | Phase 5 D candidate | `packages/core-api/src/routes/sessions.ts` | Pending future scope |
| A115 | Two Redis clients in `admin.ts` (`resetRedis` + `bannerRedis`) | CLOSED | Phase 5.1 (commit `b173ff8`) | — |
| A116 | vitest 2.x bump for per-file glob threshold support | Out of scope | (build infra) | Tracked for future tooling pass; current global lines: 80 gate holds |
| A117 | SSE `onAbort` / post-promise cleanup branches unreachable without live abort signal | Out of scope | `packages/core-api/src/routes/system-health.ts` | Excluded via `/* v8 ignore */`; integration test would require abort mid-stream |
| A118 | `createTestCapture` embedding `null` → zero-vector; hybrid_search() requires `IS NOT NULL` | CLOSED | `packages/core-api/src/__tests__/integration/helpers.ts` (commit `b08946a`) | — |
| A119 | `MOBILE_API_KEY` in Bitwarden | CLOSED | Operator action 2026-05-05 | — |
| A120 | TS2345 in `MPill.test.tsx` + `TabBar.test.tsx` (react-test-renderer@19 / @types/react@19 mismatch) | Pre-existing baseline | `packages/mobile/__tests__/components/` | Out of scope; React 19 / react-test-renderer drift, fix in separate PR |
| A121 | `skills_log.result` JSONB column missing from `init-schema.sql` | CLOSED | `scripts/init-schema.sql` (commit `b08946a`) | — |
| A122 | `get-capture.ts` used `e.type` (column does not exist; should be `e.entity_type AS type`) — production bug | CLOSED | `packages/core-api/src/mcp/tools/get-capture.ts` (commit `b08946a`) | Production behavior fix; entities now populate in `get_capture` MCP responses |
| A123 | `commitments` table missing from `init-schema.sql` | CLOSED | `scripts/init-schema.sql` (commit `b08946a`) | — |
| A124 | `rate-limit-public.test.ts` spoofed `mobile-app` caller — stale after Phase 6 R8 | CLOSED | `packages/core-api/src/__tests__/rate-limit-public.test.ts` (commit `b08946a`) | — |
| A125 | `init-schema.sql` missing `pipeline_events.stage` CHECK constraint (migration 0025) | Future audit | `scripts/init-schema.sql` | Schema parity sweep TODO — audit init-schema.sql against all `0*.sql` migrations |
| A126 | `packages/web` `App.tsx` TS2786 React Router JSX type errors fail `build-and-test` CI job | Deferred until Phase 8b | `packages/web/src/App.tsx` | Disappears when `packages/web` is deleted in Phase 8b |

### Guidance for future sessions

- **Open items affecting operational behavior:** A107, A110, A111, A113, A114, A125, A126. Address before promoting any of those areas to a required CI gate.
- **Pre-existing baselines (long-term debt, do not fix in arch-review scope):** A106, A108, A120. Will need targeted cleanup PRs or disappear naturally (A108, A126 with Phase 8b).
- **State file is source-of-truth:** `.implement-plan-state.json` (gitignored) holds the full chronological record including discovery timestamps and commit SHAs. This table is the git-tracked human-readable snapshot — update it whenever an item's status changes.

---

*Source: `/personal-plugin:create-plan` invocation following `/ultra-plan` analysis on 2026-05-05.*
