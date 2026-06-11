# QA Architect Findings

**Reviewer:** QA Architect
**Date:** 2026-06-10
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High

---

## Prior-Review Closure Verification (2026-04-18 findings)

Before new findings, status of the prior QA review's items (per intake instruction to verify rather than re-report):

| 2026-04-18 Finding | Status |
|---|---|
| H1: Integration/E2E/regression suites not CI-gated | **CLOSED** — `integration-test` job runs core-api + workers integration suites against real Postgres+Redis (`docker-compose.test.yml`) and is the sole required status check on main. |
| H2: No test asserts ai-routing cost fields / task routing | **CLOSED** — `packages/shared/src/types/__tests__/config-tiers.test.ts` + `config/__tests__/loader.test.ts`; `ConfigService.load()` throws fail-fast on missing paid-tier cost fields. |
| H3: memory-consolidation/weekly-brief bypass LLMGatewayService | **CLOSED** — `callClaude` removed in P02b; all skills route through `LLMGatewayService.completeByTask()`. |
| H4: Drift-guard incomplete (`CaptureSource`) | **SUPERSEDED** — `packages/web` deleted (Phase 8b); canonical unions now live in `@open-brain/shared` with DB CHECK constraints validated by `scripts/validate-init-schema.sh` (CI job `validate-schema`). |
| M7: Python tests bifurcated (voice-pipecat, file-ingestion not in CI) | **CLOSED** — dedicated `voice-pipecat-test` and `file-ingestion-test` CI jobs exist. |
| M5: Coverage measured but never gated | **STILL OPEN** — see High-1 below. PR #183 added thresholds but did not activate coverage in CI. |
| M6: SAST missing | **STILL OPEN** — see Medium-8. |
| M10: No memory/RSS soak test | **STILL OPEN** — folded into Medium-6. |

---

## Test Strategy Assessment

- **Strategy documented:** Partial — no `TESTING.md`, but test conventions are codified and enforced via `CLAUDE.md` ("Testing / CI" section: forks pool profile, rate-limit bypass header, mock-signature rules, integration runner invocation), plus `USER_TEST_PLAN.md` (147 manual cases, v1.0 2026-05-09) for full-system manual validation.
- **Strategy appropriate for architecture:** Yes — per-package Vitest unit suites, DB+Redis-backed integration suites behind the single required CI gate, pytest for 3 Python components, regression-pinned tests for deploy-discovered bugs, manual E2E plan for a single-operator system. The pattern of "every production incident gets a regression test or CI validator" (schema validator, secrets-redaction guard, sidecar pytest citing PRs #91/#92/#93) is genuinely strong.
- **Actual test suite consistent with strategy:** Partial — the documented coverage gate (CLAUDE.md: "Workers coverage gate ... enforces thresholds") does not match reality (coverage never runs in CI — High-1), and several documented regression guards are operator-manual only (Medium-4).

## Test Pyramid Analysis

Counts are `it()`/`test()` blocks (TS) and `def test_` functions (Python), measured 2026-06-10:

| Layer | Count | % of Total | Assessment |
|-------|-------|------------|------------|
| Unit (TS, mocked deps) | ~3,201 blocks / ~164 files (shared 336, core-api 1,140 unit, workers 1,021 unit, slack-bot 492, voice-capture 82, web-next 106, mobile 24) | 92.6% | Dense, well-distributed across backend packages; thin on UI packages (Medium-5) |
| Unit (Python, pytest) | 93 (voice-pipecat 5 files, file-ingestion 1 file, ingest-sidecar 1 file) | 2.7% | All three in CI as separate jobs. Regression-pinned (sidecar tests cite defended PRs inline). |
| Integration (real Postgres+pgvector+Redis) | 147 blocks / 11 files (core-api 131, workers 16) | 4.3% | High fidelity: real `pgvector/pgvector:pg16`, real BullMQ workers, schema from `scripts/init-schema.sql`, stub embeddings only. The CI-required layer. |
| Contract | drift-guards + schema validator (`validate-init-schema.sh`, `config-tiers.test.ts`) | <0.5% | Counted within unit; the four-surface lockstep invariants (TS union / Zod / DB CHECK / route validator) are validated. |
| E2E (automated) | 1 Playwright spec (`web-next/tests/smoke/quick-capture.spec.ts`) + 1 env-gated suite (`workers .../ingest-e2e.test.ts`, `INGEST_E2E=1`) | <0.1% | Neither runs in CI (Medium-3, Medium-4). |
| E2E (manual) | `USER_TEST_PLAN.md` — 147 cases, 16 sections | — | Thorough but human-paced; last full execution status not recorded in-repo. |
| **Total automated** | **~3,458** | 100% | |

**Pyramid assessment:** Appropriately bottom-heavy. The integration layer is small in count but each test exercises full HTTP→service→SQL paths; that is the right shape for this system. The genuine structural gap is the near-absent automated E2E/UI layer for `web-next` (sole production UI) and `mobile`, compensated only by a manual plan.

## Test Quality Assessment (from sampling)

Sampled 18 files: `core-api/__tests__/integration/{search,captures,smoke,mcp-tools}.test.ts`, `integration/{setup,helpers}.ts`, `workers/__tests__/integration/{pipeline,ingest-e2e}.test.ts`, `workers/__tests__/{base-skill-autonomy,memory-consolidation,budget-check}.test.ts`, `shared/src/types/__tests__/config-tiers.test.ts`, `shared/src/config/__tests__/loader.test.ts`, `docker/ingest-sidecar/tests/test_trigger_server.py`, `web-next/lib/__tests__/api-client.test.ts`, `web-next/tests/smoke/quick-capture.spec.ts`, `mobile/__tests__/theme/tokens.test.ts`, `tests/validate-t0-classification.test.ts`.

| Dimension | Score (1–5) | Evidence |
|-----------|-------------|----------|
| Assertion meaningfulness | 4 | Integration search tests assert on result membership, score fields, and totals against seeded FTS content (`search.test.ts:87–112`) — not just status codes. `tokens.test.ts` (mobile) asserts light/dark key-set parity, a real invariant. Some shape-only assertions exist but are a minority. |
| Behavior vs implementation coupling | 4 | Integration layer tests through the public HTTP surface against real SQL — excellent. Unit layer is mock-dense (~1,695 `vi.mock`/`vi.fn` occurrences across core-api+workers tests) but mocks sit at genuine process boundaries (fetch, DB, LLM gateway, Pushover), per the CLAUDE.md mock-hygiene rules. `memory-consolidation.test.ts` mocks only the query module and the LLM, exercising real merge/soft-delete logic. |
| Test isolation | 5 | `beforeEach(cleanDatabase)` TRUNCATEs 11 tables in dependency order (`helpers.ts:26–48`); integration config uses `singleFork: true` + `bail: 1`; `pipeline.test.ts` generates unique BullMQ queue names per test (`uniqueQueueName()`, lines 36–40) to prevent cross-test Redis collisions; tmpfs Postgres gives free teardown. Exemplary. |
| Data management | 4 | Factory functions (`createTestCapture`, `createTestEntity`) with override objects; realistic fixtures in `memory-consolidation.test.ts` (3-capture cluster with similarity metadata); `tests/fixtures/classification-examples.json` backs the T0 validation suite. No shared mutable fixture state observed. |
| Readability | 5 | Tests carry their rationale: `test_trigger_server.py` docstring maps each test to the deploy bug (PR #91/#92/#93) it defends; integration files document the stub-embedding strategy and what signal is meaningful; setup comments explain why init-schema.sql is the source of truth "through migration 0031". |

**Specific quality findings:**

- `packages/workers/src/__tests__/integration/ingest-e2e.test.ts:147` — `describe.skipIf(!E2E_ENABLED)` gates the only test that exercises the built sidecar image over HTTP. CI never sets `INGEST_E2E=1`, so this suite is permanently skipped in CI even though CI *builds* the sidecar image (`docker compose ... up -d --wait --build`) — paying the build cost without the test value. See Medium-3.
- `packages/web-next/package.json` — `"test": "vitest"` (no `run`). Locally this enters watch mode; in CI it relies on Vitest's CI-environment detection to run once. Every other package uses `vitest run`. Inconsistent and a foot-gun for scripted local use. See Low-9.
- `packages/core-api/src/__tests__/integration/search.test.ts:54–66` — `createSearchableCapture()` is a residual no-op wrapper around `createTestCapture()` (its original tsv-update purpose was removed; comment documents this). Harmless, but dead indirection.
- `packages/web-next/tests/smoke/quick-capture.spec.ts:30–40` — the smoke test self-skips when core-api is unreachable. Graceful, but combined with Playwright not being in CI at all, the golden-path web E2E can silently never run anywhere.

## Coverage Assessment

- **Configured thresholds:**
  - `packages/workers/vitest.config.ts` — lines 78 / functions 81 package floor, plus per-file 100% locks on `base-skill.ts`, `ingest-dedup.ts`, `spend-tracker.ts`, `ingest-pipeline.ts`.
  - `packages/core-api/vitest.config.ts` — lines 80 / functions 80.
  - No thresholds: shared, slack-bot, voice-capture, web-next, mobile, Python packages.
- **Reported coverage: NOT MEASURED IN CI.** This is the central coverage finding (High-1): no `--coverage` flag exists anywhere in `.github/workflows/*.yml` or any package `test` script (`vitest run --passWithNoTests` throughout; verified via grep and `git log --follow` on `packages/workers/package.json` — the script never included `--coverage`). Vitest only evaluates `coverage.thresholds` when coverage collection is enabled, so **both packages' thresholds — including the per-file 100% locks — have never gated a single CI run.** CLAUDE.md ("Workers coverage gate (Phase 4 / PR #183) ... enforces ...") documents the gate as active; it is dormant.
- **Critical path coverage gaps (specific):**
  - `packages/web-next/app/**` and `components/**` — zero unit/component tests; vitest `include` is scoped to `lib/__tests__/**` only (4 files: api-client, format, greeting, sse-client). The production dashboard's rendering logic, `proxy.ts` caller-overwrite boundary behavior, and Board.tsx UI↔API type mapping are untested in automation.
  - `packages/mobile/src/**` — 4 test files (theme tokens, 2 components, api-client); recording flow and mobile-auth token handling untested.
  - Scheduler cron-slot registry (`packages/workers/src/scheduler.ts`) — the slot-collision invariant ("no two repeatable jobs on same minute") is enforced by convention/grep, not by a test that parses the registered crons and asserts uniqueness. Cheap test, real incident class (P07 cycle-1 drift).

## CI Pipeline Gate Assessment

Branch protection on main requires **only** "Integration tests (core-api + real DB)".

| Gate | Exists? | Blocking? | Finding |
|------|---------|-----------|---------|
| Integration tests (core-api + workers, real DB/Redis) | Yes | **Yes (only required check)** | Strong gate: real pgvector + Redis + built sidecar image, schema from init-schema.sql, log dump on failure, `down -v` teardown in `always()` step. |
| Unit tests (`pnpm -r test`, 7 TS packages) | Yes (`build-and-test`) | **No** | **A PR with failing unit tests, failing `tsc --noEmit`, or a broken build in any package can merge.** CLAUDE.md notes build-and-test "can now be promoted to required (A126 resolved)" — promotion never executed. See High-2. |
| Coverage threshold | Configured | **No — never executes** | High-1. Coverage thresholds exist in 2 packages but no CI step or test script passes `--coverage`. |
| Lint/typecheck (TS: `tsc --noEmit`; Python: ruff + pyright) | Yes | No (TS, inside build-and-test) / No (python-lint not required) | Same merge-despite-failure exposure as unit tests. |
| Schema validation (`validate-schema`) | Yes | No | Conditionally runs only when schema-related paths changed; diff fallback to `HEAD~1` on push can under-detect multi-commit changes (Low-11). |
| Python tests (3 jobs) | Yes | No | Not required checks; can merge red. |
| Security scan (SAST) | **No** | No | Medium-8. Monthly `monthly-audit.yml` is Dependabot-alerts + `pnpm outdated`, informational only. |
| E2E (Playwright web smoke) | No | No | Exists in repo, never invoked by CI (Medium-4). |
| Regression-guard shell scripts (backup secrets redaction, secrets round-trip, restore rehearsal, Loki routing) | No | No | Documented as "regression guards" in CLAUDE.md but operator-manual only (Medium-4). |
| Root validation suite (`tests/validate-t0-classification.test.ts` via `vitest.config.validation.ts`) | No | No | `pnpm test:validation` referenced nowhere in CI (Medium-4). |
| Doc version sync | Yes | No (`continue-on-error: true`, observe mode) | Documented promotion checklist in-file; acceptable (Low-13). |

**What can deploy despite failing:** unit tests (all 7 TS packages), typecheck, builds, all Python suites, Python lint, schema validation, doc sync — everything except the integration suite. For a solo repo with admin escape hatch this is a deliberate posture, but the one-line promotion of `build-and-test` (explicitly unblocked since Phase 8b) closes most of it for free.

## Test Reliability

- **Skipped/disabled tests:** 1 conditional — `ingest-e2e.test.ts:147` `describe.skipIf(!E2E_ENABLED)` (always skipped in CI; Medium-3). **Zero** unconditional `.skip`/`.only`/`xit`/`@pytest.mark.skip` across all TS and Python test files. Clean.
- **Retry configuration:** None in any Vitest config or CI step (healthy — flakes fail loudly). `playwright.config.ts` sets `retries: 2` in CI — anticipatory flake tolerance for a suite that does not run in CI; harmless today, but if Playwright is promoted to CI, start at `retries: 0` and add retries only with evidence.
- **Timeout configuration:** Appropriate — 30s hook/test timeouts everywhere (documented Windows ioredis/bullmq race mitigation), `singleFork` + `bail: 1` on integration configs, 15-min job timeout on integration CI, 5–10-min on Python jobs. `forbidOnly: !!process.env.CI` in Playwright config is a good guard.
- **Teardown discipline:** `scripts/test-integration.mjs` uses try/finally `down -v`; CI uses `if: always()` teardown plus failure-only log dump. Solid.

## Non-Functional Testing

| Type | In Pipeline? | Ad-hoc? | Missing? |
|------|-------------|---------|----------|
| Load/performance | No | `scripts/benchmark-search.mjs` (HNSW ef_search calibration, LAB_NOTEBOOK Entry 108) | **Yes** — no perf regression gate; the `hybrid_search()` LIMIT push-down and ef_search invariants (protected by CLAUDE.md comments only) have no benchmark check in CI |
| Security/SAST | No | No | **Yes** — no CodeQL/Semgrep/Trivy; MCP endpoint is internet-reachable via tunnel |
| Dependency vulnerabilities | Monthly, informational | `monthly-audit.yml` (Dependabot alerts → Slack) | Blocking gate missing (acceptable, single-user) |
| Chaos/resilience | No | Unit-level fault injection only (mocked 429/timeouts) | Real chaos missing; acceptable for scale |
| Memory/RSS soak | No | No | **Yes** — CLAUDE.md mandates 1.5 GB RSS/process; nothing validates it |
| Accessibility | No | Manual via USER_TEST_PLAN | Automated a11y (axe/Lighthouse) missing (Low-12) |
| Backup/DR | No (CI) | `scripts/test-backup-secrets-redaction.sh`, `test-secrets-roundtrip.sh`, `test-restore-rehearsal.sh` — operator-run | CI execution missing (Medium-4); scripts themselves are well-built (mock-bws fixtures, exit-code contracts) |

## Test Environment Fidelity

**High for the layer that matters.** Integration environment uses the production Postgres image (`pgvector/pgvector:pg16`) with the production schema bootstrap (`scripts/init-schema.sql`, asserted in-repo as "source of truth through migration 0031" and independently cross-validated against Drizzle migrations by `validate-init-schema.sh`), real Redis 7, real BullMQ workers, and the actual sidecar Docker image built from the production Dockerfile. tmpfs Postgres trades durability for speed correctly. Deliberate infidelities are documented and sound: stub zero-vector embeddings (no OpenAI in CI — FTS is the asserted signal), mocked FlowProducer in pipeline tests (flow orchestration covered by unit tests), mocked Pushgateway/Prometheus (DNS-hang avoidance, CLAUDE.md rule). One fidelity gap: the test compose's sidecar points at `test-core-api:3000`, a service that doesn't exist in the file — intentional (trigger-boundary testing only) and commented, but it means sidecar→core-api delivery is never exercised end-to-end anywhere automated.

## Critical Path Coverage Matrix

| Business Path | Unit | Integration | E2E | Gap? |
|--------------|------|-------------|-----|------|
| Capture POST → pipeline status → retrieval | Yes | Yes (`captures.test.ts`, 572 lines, incl. dedup 409) | Manual + un-CI'd Playwright | Minor — automated E2E not gated |
| Hybrid/FTS/vector search + RRF | Yes | Yes (`search.test.ts`; vector signal stubbed to zero) | Manual | Vector-scoring behavior only validated with zero vectors; real-embedding ranking quality is benchmark-script-only |
| BullMQ pipeline retry/backoff/idempotency | Yes | Yes (`pipeline.test.ts`, real Redis) | — | None significant |
| MCP tools over Streamable HTTP | Yes | Yes (`mcp-tools.test.ts`, 586 lines) | Manual | None significant |
| Rate-limit bypass/public tiers | Yes | Yes (internal + public integration suites) | — | None — strong coverage of a security-relevant boundary |
| Voice capture proxy (multipart) | Yes | Yes (`voice-captures.test.ts`) | Manual (iOS shortcut) | Acceptable |
| Batch ingest sidecar → captures API | Python unit (regression-pinned) | Image-boundary e2e exists but **always skipped in CI** | — | **Medium-3** |
| Autonomy gating of destructive skills | Yes (`base-skill-autonomy.test.ts`, all 4 levels + fail-closed default) | — | — | None — well covered |
| Web dashboard UI (web-next) | 4 lib tests only | — | 1 un-CI'd smoke + manual plan | **Medium-5** — sole production UI has no automated render coverage |
| Mobile app | 4 files | — | Manual | Same class as above |
| Backup/secrets round-trip | Shell fixtures (manual) | — | Restore rehearsal (manual cron) | **Medium-4** — guards not in CI |
| Scheduler cron slot uniqueness | No | — | — | Gap — convention-only invariant (see Coverage Assessment) |

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 6 |
| Low | 5 |
| **Total** | **13** |

### High

1. **The coverage gates are dormant — thresholds configured, coverage never collected.** No package `test` script and no CI step passes `--coverage`; `coverage.enabled` is unset, so Vitest never evaluates `thresholds` in `packages/workers/vitest.config.ts` (78/81 floor + four per-file 100% locks, PR #183) or `packages/core-api/vitest.config.ts` (80/80). Verified via grep across workflows/scripts and `git log --follow` on the workers package.json (the script was never `--coverage`). CLAUDE.md asserts the workers gate "enforces" — institutional documentation diverges from reality, and coverage (including the 100%-locked files like `base-skill.ts` and `spend-tracker.ts`) can erode silently. Fix is one line per package (`"test": "vitest run --coverage --passWithNoTests"` or a dedicated CI coverage step), then correct the CLAUDE.md bullet.
2. **`build-and-test` is not a required status check — failing unit tests, typecheck, or builds in all 7 TS packages do not block merge.** Only "Integration tests (core-api + real DB)" gates main. CLAUDE.md itself records that the blocker (A126/packages-web) was resolved in Phase 8b and the job "can now be promoted to required" — the promotion was never executed. The integration suite covers core-api and workers paths only; slack-bot (492 tests), voice-capture, shared, web-next, and mobile have zero blocking automation. One branch-protection API call closes this.

### Medium

3. **The image-boundary ingest e2e never runs anywhere automated.** `workers/src/__tests__/integration/ingest-e2e.test.ts` is `describe.skipIf(!E2E_ENABLED)` and CI never sets `INGEST_E2E=1`, while the `integration-test` job still pays to build the sidecar image (`--build`). The suite was written to defend the PR #91/#92/#93 deploy regressions at the image boundary; the sidecar pytest covers the same bugs at module level, but the Dockerfile-CMD/built-image class is exactly what unit tests miss. Either set `INGEST_E2E=1` in the CI step (services are already up) or drop `--build` and document the suite as operator-only.
4. **Documented regression guards and the validation/E2E suites are operator-manual only.** Not invoked by any CI workflow: `scripts/test-backup-secrets-redaction.sh`, `scripts/test-secrets-roundtrip.sh` (both labeled "regression guard" in CLAUDE.md), `scripts/test-restore-rehearsal.sh`, `scripts/test-loki-routing.sh`, root `pnpm test:validation` (`tests/validate-t0-classification.test.ts`), the Playwright web smoke, and `scripts/regression-test.mjs`. A guard that only runs when a human remembers is a documentation of intent, not a gate — the two secrets-handling scripts in particular defend a credential-leak class and are pure-shell with mock fixtures, i.e., trivially CI-able.
5. **The sole production UI has near-zero automated coverage.** `web-next` vitest is scoped to `lib/__tests__/**` (4 files); `app/**`, `components/**`, and `proxy.ts` (the security-relevant caller-overwrite boundary) have no component or behavioral tests, and the one Playwright smoke is not in CI. Mobile is similar (4 files). The 147-case USER_TEST_PLAN is the de facto UI regression suite — thorough but human-paced and last executed at v1.6.0 deploy. At minimum, add a proxy.ts unit test asserting the `X-Open-Brain-Caller: web-next-public` overwrite, and put the existing Playwright smoke into a non-required CI job.
6. **No performance or memory regression checks.** `benchmark-search.mjs` exists for ad-hoc HNSW calibration but the performance invariants protected only by comments (hybrid_search LIMIT push-down, ef_search injection, batch-UPSERT single-statement rule) have no executable check; the CLAUDE.md 1.5 GB RSS mandate has no soak test. A scheduled (not per-PR) benchmark job with a stored baseline would defend P13's wins.
7. **Local/CI integration-runner drift.** `scripts/test-integration.mjs` (root `pnpm test:integration`) runs only the core-api integration suite; CI's required gate also runs the workers integration suite. A developer's green local run does not predict the required check. Add the workers step to the script's try block.
8. **SAST remains absent (carried from 2026-04-18, still open).** No CodeQL/Semgrep/Trivy in any workflow; `monthly-audit.yml` is informational dependency reporting. The MCP and web surfaces are internet-reachable via Cloudflare Tunnel. CodeQL's default setup is near-zero maintenance for a TS+Python repo.

### Low

9. **`web-next` test script uses watch-mode default** — `"test": "vitest"` instead of `vitest run` (all other packages use `run`). Relies on CI-env detection; hangs scripted non-CI invocations.
10. **CLAUDE.md testing-section drift:** `@vitest/coverage-v8@^1.6.1` documented vs `^2` actual (PR #210); "coverage gate enforces" vs dormant (High-1); "Vitest pool: 'forks' requires minForks+maxForks on vitest 1.6" — repo is on 2.x where the constraint may no longer hold. Stale operational rules get faithfully obeyed.
11. **`validate-schema` CI job's change detection can under-trigger** — fallback diff `HEAD~1...HEAD` on direct pushes misses schema changes in earlier commits of a multi-commit push; cheap fix is running the validator unconditionally (one ephemeral container, ~1 min).
12. **No automated accessibility checks** for web-next; manual-only via USER_TEST_PLAN. Acceptable single-user posture; Lighthouse CI would be cheap if ever desired.
13. **`doc-sync` job in observe mode** (`continue-on-error: true`) with an in-file promotion checklist — fine as designed, flagged so the checklist doesn't rot (pattern precedent: integration-test sat in observe mode until explicitly promoted).

---

## Notes for Synthesizer

The dominant theme is unchanged in kind but improved in degree since 2026-04-18: this codebase writes *good* tests (regression-pinned, well-isolated, high-fidelity integration layer — the prior review's #1 High is genuinely closed and is now the only required gate), but **the gating layer trails the test inventory**. The two High findings are both "the gate everyone believes exists doesn't fire": dormant coverage thresholds and an unpromoted build-and-test check. Both are sub-hour fixes. The structural investment item is UI-layer automation (Medium-5); everything else is wiring existing assets into CI.
