# QA Architect Findings

**Reviewer:** QA Architect
**Date:** 2026-04-18
**Target:** `C:/Users/Troy Davis/dev/personal/open-brain` (main, HEAD `9443f93`)
**Confidence:** High

---

## Test Strategy Assessment

- **Strategy documented:** Partial — test conventions are encoded in `CLAUDE.md` (Vitest Windows profile, rate-limit bypass header, mock hygiene rules, integration runner), `docs/USER_TEST_PLAN.md`, and implementation-plan docs. No dedicated `TESTING.md`.
- **Strategy appropriate for architecture:** Yes — the mix (Vitest unit suites per package, DB-backed integration tests, shell-based E2E against live stack, pytest for Python sidecars, HTTP-based regression script, manual PWA/Slack UI plan) fits a single-operator self-hosted system with async BullMQ pipelines and cross-language components.
- **Actual test suite consistent with strategy:** Partial — the written artifacts are strong but the CI gate only covers the unit-test layer and the Python sidecar tests. Integration tests (`test:integration` scripts, `docker-compose.test.yml`), regression script (`scripts/regression-test.mjs`), and E2E shell scripts (`scripts/e2e-phase1.sh`, `scripts/e2e-full.sh`) all exist but are **never invoked by CI**. They run only on-demand against the live homeserver.

## Test Pyramid Analysis

| Layer | Count | % of Total | Assessment |
|-------|-------|------------|------------|
| Unit (TS `it`/`test` blocks) | ~2,682 across 128 unit test files | 97.5% | Dense and well-distributed across workers (49), core-api (47), shared (17), slack-bot (14), voice-capture (5), web (3) |
| Integration (TS, DB+Redis backed) | 7 files, ~50+ blocks (suites in `packages/core-api/src/__tests__/integration/` + `packages/workers/.../integration/ingest-e2e.test.ts`) | ~1.5% | Infra exists (`docker-compose.test.yml`, `setup.ts`, `helpers.ts`) with ephemeral Postgres/Redis/sidecar on tmpfs, but gated behind `test:integration` which CI does not run. |
| Python sidecar (pytest) | `docker/ingest-sidecar/tests/test_trigger_server.py` (15+ test functions) | — | Regression-targeted: each test cites the PR # (#91/#92/#93) it defends against. Strong pattern. |
| Python voice-pipecat (pytest) | 5 files (`test_capture_extractor.py`, `test_config.py`, `test_health.py`, `test_session.py`, `test_tools.py`) | — | **Not exercised in CI** — only `docker/ingest-sidecar/tests/` is referenced by `sidecar-test` job. |
| Python file-ingestion (pytest) | 1 test file (`test_extract.py`) | — | **Not exercised in CI.** |
| Regression (HTTP) | `scripts/regression-test.mjs` — 91 unique TC IDs, ~243 pass/fail call sites | — | Rich coverage of API surface, Slack integration path optional; intake claims "95 regression tests" — actual count is 91 TC-IDs (close but off by 4). |
| E2E (shell) | `scripts/e2e-phase1.sh` (196 lines), `scripts/e2e-full.sh` (482 lines) | — | Curl-driven against live services. Not in CI; manual. |
| USER_TEST_PLAN (manual) | 113 TC-IDs in `docs/USER_TEST_PLAN.md`; 1,201 lines; ~90% claimed auto-capable via Chrome | — | Checklist is thorough but uses only 2 `[AUTO]` section markers and 1 `[MANUAL]`; per-TC tagging is not line-level. |
| **TS Unit + integration total** | **135 test files, ~2,689 blocks** | **100%** | Bottom-heavy in the right way, but integration gate is aspirational. |

**Pyramid assessment:** Correctly bottom-heavy at the unit layer. Integration layer exists but is starved by CI omission. E2E layer exists but is not automated.

**Skipped/`.only`:** **Zero** `it.skip`, `test.skip`, `describe.skip`, or `.only(` usages across all 135 TS test files. Clean.

**Claimed 1,569 unit + 95 regression:** Actual counts diverge.
- Unit: 2,689 `it()`/`test()` blocks across 135 files — far higher than the 1,569 claim (README/intake are stale or counting `describe` blocks differently).
- Regression: 91 unique TC-IDs — 4 short of the 95 claim.

## Test Quality Assessment (from sampling)

Sampled: `email-compose-fault-injection.test.ts`, `web-type-drift.test.ts`, `push-metrics.test.ts`, `smoke.test.ts` (integration), `test_trigger_server.py`, `regression-test.mjs`, `e2e-full.sh`, `e2e-phase1.sh`.

| Dimension | Score (1–5) | Evidence |
|-----------|-------------|----------|
| Assertion meaningfulness | 4 | 5,557 `expect()` calls across 135 files (avg ~41 per file). Fault-injection test asserts on tier identity, call counts, token usage, and model name — not trivial. Drift-guard asserts sorted-literal equality with actionable error messages naming both files. Push-metrics validates Prometheus exposition format literally. Weak-assertion candidates (`toBe(true)` / bare `toBeDefined()`) = 336 (~6%), acceptable. |
| Behavior vs implementation coupling | 3 | Heavy mocking (261 `vi.mock`/`mockResolvedValue`/`mockImplementation` hits across 20+ files) risks coupling to internal collaborators. Good examples exist (fault-injection isolates `runAgent` semantics), but several tests stub whole `Database` / `ConfigService` shells with `as unknown as` casts — a maintenance drag when those interfaces change. |
| Test isolation | 5 | Integration tests use `beforeEach(cleanDatabase)` with a helpers module; `docker-compose.test.yml` uses tmpfs Postgres for reset-free teardown. No cross-test leak observed. Vitest forks `pool: 'forks'` with `minForks: 1`/`maxForks: 4` isolates worker processes (CS1 Windows stability fix, PR #96). Integration suites use `singleFork: true` + `bail: 1` — correct for shared-resource tests. |
| Data management | 4 | `createTestCapture`, `createTestEntity`, `linkEntityToCapture`, `seedTestData` factories in `helpers.ts`. `RUN_ID = Date.now().toString(36)` in regression script avoids cross-run `content_hash` 409s. Pytest conftest uses per-test secret rotation. |
| Readability | 4 | Test docstrings link back to PR #s that introduced the regression — excellent traceability (`test_trigger_server.py` has inline `# PR #91 regression:` annotations). Regression script has clear section banners and PASS/FAIL/BUG/SKIP states. |

**Specific quality findings:**

- `packages/workers/src/__tests__/email-compose-fault-injection.test.ts:170–188` — The test **asserts the observed-but-known-wrong behavior**: "NOTE: The current implementation records with the *initial* resolved tier rather than the one that succeeded. We assert on what's actually recorded and flag it in the test as the observed behavior." This is honest but the comment acknowledges a production accuracy gap (tier-key recording does not reflect which tier actually served). Either file a follow-up to fix `recordAgentCompletion` or promote this test to `.todo()` with a linked issue. As written, future code that "fixes" the behavior will break this test.
- `scripts/regression-test.mjs:138–145` — Hard-codes a `bug()` state for `TC-API-003` when captures never reach `pipeline_status=complete`. This is the right diagnostic shape, but the script records it as a BUG state (not FAIL), and there is no dashboard that surfaces BUG counts between runs — it is a one-shot console emission. Risk: regression runs at 2 AM on homeserver but failures evaporate unless a human reads the output.
- `packages/shared/src/__tests__/web-type-drift.test.ts:54` — Regex-based parsing of a sibling package's TS source to detect enum drift. Works but is fragile to formatting (relies on blank-line boundary + `export` prefix). Intake flags that `CaptureSource` (8→9 values with `'system'`) is **not** covered by this drift guard (only `IngestSourceType` + `FileUploadStatus` are). That blind spot just cost a migration round-trip via the `'system'` value discovery (PR #101 pre-flight audit).
- `docker/ingest-sidecar/tests/test_trigger_server.py:315–330` — `test_dockerfile_cmd_references_trigger_server` parses the Dockerfile as text to catch a "`sleep infinity` regression." Strong pattern but brittle: a future multi-stage Dockerfile or a different CMD shape breaks the parser. Consider testing the built image behavior instead.
- `packages/core-api/src/__tests__/integration/smoke.test.ts:37–48` — beforeAll initializes DB, afterAll tears down. Fine, but there is no `--shard` or parallelization strategy — if integration tests ever grow beyond ~30s cumulative, single-process single-fork will stretch. No flag for that yet.

## Coverage Assessment

- **Configured threshold:** `packages/core-api/vitest.config.ts` sets `thresholds: { lines: 80, functions: 80 }`. No other package enforces thresholds.
- **Reported coverage:** Not published — CI does not upload or gate on coverage. `json-summary` reporter is declared in `workers` and `voice-capture` but there is no artifact publication, no codecov/coveralls, no PR comment.
- **Package coverage gaps (what is NOT lint-covered by pyright or vitest thresholds):**
  - `packages/voice-pipecat/src/` — excluded from pyright (TODO comment in `pyproject.toml:31–33`) due to `redis.asyncio` stub gaps and Anthropic content-block union narrowing. Per-file tests exist (5) but none run in CI.
  - `scripts/` — pyright excludes it entirely (`pyproject.toml:36`); ~20 ops scripts with sparse typing. Ruff only.
  - `packages/file-ingestion/tests/` — excluded from ruff (`extend-exclude`) and not in any CI job.
  - `packages/voice-pipecat/tests/` — excluded from ruff and not in CI.
  - `packages/workers/src/` + `packages/shared/src/` — no coverage threshold gate; coverage is reported locally but not enforced.
- **Critical path coverage gaps:**
  - **Pipeline end-to-end with a real LLM response:** the full `ingest → embed → extract → link → wiki-ingest → consolidation` chain has **unit-mocked** coverage but no CI-run integration coverage with real Postgres+Redis.
  - **Spreading activation + Hebbian association boost in search:** migration 0011/0012 SQL function `spreading_activation` has no integration test that asserts the traversal fan-out behavior.
  - **`memory-consolidation` and `weekly-brief` LLM-bypassing of LLMGatewayService:** intake flags these bypass the gateway (direct Anthropic SDK calls, no tier fallback/audit). There are unit tests but no fault-injection coverage equivalent to `email-compose-fault-injection.test.ts`.
  - **Cross-provider agent-loop mid-loop fallback** is explicitly constrained (same-provider only). No test asserts that an anthropic→openai mid-loop fallback attempt fails cleanly.
  - **Budget circuit breaker + cost-per-1k fields:** the 2026-04-15 cost incident ($100+ Anthropic charges) exposed that zero cost fields in `ai-routing.yaml` blinded the circuit breaker. No test asserts that (a) cost fields are nonzero for all paid tiers, (b) circuit breaker trips at $50 hard cap.

## CI Pipeline Gate Assessment

| Gate | Exists? | Blocking? | Finding |
|------|---------|-----------|---------|
| Unit tests (`pnpm -r test`) | Yes | Yes | Runs per-package vitest with `--passWithNoTests`. Blocking. |
| Coverage threshold | Partial | No | Only `core-api/vitest.config.ts` declares 80% thresholds; CI does not run coverage (`pnpm -r test` runs vitest without `--coverage`), so thresholds never enforce. |
| Lint (TS) | Yes | Yes | `pnpm -r lint` = `tsc --noEmit`. This is where CI was red for 18h (per intake) because lint runs on test files too — `tsup` build doesn't. |
| Lint (Python) | Yes | Yes | `ruff check .`, `ruff format --check .`, `pyright`. Added PR #101. |
| Build | Yes | Yes | Shared built first, then `pnpm --filter !@open-brain/shared -r build`. Web build re-enabled (PR #100). |
| Integration tests | **No** | No | `test:integration` scripts exist per-package, `docker-compose.test.yml` exists, but no CI job spins them up. |
| E2E shell scripts | **No** | No | `scripts/e2e-phase1.sh` + `scripts/e2e-full.sh` run only on homeserver manually. |
| Regression HTTP suite | **No** | No | `scripts/regression-test.mjs` has no CI workflow. |
| Sidecar pytest | Yes | Yes | `sidecar-test` job runs `pytest docker/ingest-sidecar/tests/` with Python 3.12, requirements.txt. 5-min timeout. |
| voice-pipecat pytest | **No** | No | 5 test files exist, no CI job. |
| file-ingestion pytest | **No** | No | 1 test file exists, no CI job. |
| Security scan (SAST) | **No** | No | No CodeQL, Semgrep, Snyk, Trivy, Bandit, or equivalent. GitGuardian secret scanning only (pre-commit; not a CI gate). |
| Dependency audit | Partial | No | `monthly-audit.yml` runs monthly `pnpm outdated` + Dependabot alerts. Informational only. |
| Load/performance | **No** | No | No k6, locust, JMeter, or equivalent. No benchmark-tracking job. |
| Chaos/resilience | **No** | No | No chaos tooling. Fault-injection is done via unit mocks only. |
| Container smoke after deploy | **No** | No | Deploy is manual `git pull + docker compose build + up -d`; no post-deploy smoke gate. |

**Deploy-path risk:** Anything that can deploy despite failing integration, E2E, regression, load, or security — because none of those are CI gates. Only TS lint/build/test + sidecar pytest + Python lint/typecheck gate a merge. Operator (Troy) runs the rest manually at deploy time on homeserver.

## Test Reliability

- **Skipped/disabled tests:** Zero (verified across all 135 TS test files).
- **Retry configuration:** None in vitest configs or CI. No `--retries`, no `testRetry`, no `flaky` markers. If a test flakes, CI fails cleanly — which is a healthy signal, but Windows-specific ioredis/BullMQ races motivated the `pool: 'forks'` + `minForks:1`/`maxForks:4` + `hookTimeout/testTimeout: 30_000` profile (CLAUDE.md-documented, PR #96). That config is the flake guard.
- **Timeout configuration:** 30s hook+test timeouts on unit suites, 30s on integration (appropriate for DB ops), `bail: 1` on integration (correct — no point continuing if setup fails). Python sidecar job has 5-min workflow timeout.
- **Windows stability:** Explicit `pool: 'forks'` accommodation. Good — most teams discover this the hard way.

## Non-Functional Testing

| Type | In Pipeline? | Ad-hoc? | Missing? |
|------|-------------|---------|----------|
| Load/performance | No | No | **Yes — missing** |
| Security/SAST | No | No (GitGuardian only, which is secret-scanning not SAST) | **Yes — missing** |
| Dependency vuln | Partial (monthly) | — | Informational; no blocking PR gate |
| Chaos/resilience | No | Partial (`email-compose-fault-injection.test.ts` is a mock-level fault injector) | Real chaos missing |
| Accessibility | No | Manual (USER_TEST_PLAN for PWA) | Automated a11y missing |
| Memory/RSS | No | No | **Missing** — CLAUDE.md enforces 1.5 GB RSS per process; no test validates this under load |
| Cost/budget | No | No | **Missing** — zero test asserts tier-routing decisions match `ai-routing.yaml` `task_routing` (the exact class of defect that caused the 2026-04-15 $100 incident) |

## Test Environment Fidelity

**Unit layer:** Mock-heavy but consistent — `docker/ingest-sidecar/tests/conftest.py` uses real stdlib HTTP server in-process; `push-metrics.test.ts` mocks `fetch` with `vi.fn`; gateway/config/db are mocked via `as unknown as` casts.

**Integration layer:** High fidelity when run — real `pgvector/pgvector:pg16` image, real `redis:7-alpine`, real sidecar image built from the actual Dockerfile. tmpfs Postgres for speed. Port-mapped to 5433/6381/8099 to avoid conflict with dev stack. But **not run in CI** — so this fidelity is only realized by the operator.

**E2E shell layer:** Runs against the live production homeserver (with `X-Open-Brain-Caller: integration-test` rate-limit bypass). Highest fidelity but zero gating.

**Fixture strategy:** `scripts/regression-test.mjs` uses time-seeded `RUN_ID` for uniqueness. `tests/fixtures/classification-examples.json` backs `validate-t0-classification.test.ts`. Integration helpers generate random capture content. Clean.

## Critical Path Coverage Matrix

| Business Path | Unit | Integration | E2E | Gap? |
|--------------|------|-------------|-----|------|
| Capture ingest (API) → embed → entity extract | Yes (mocked) | Yes (gated behind `test:integration`, not in CI) | Yes (`e2e-full.sh`) | **CI gap** — integration exists but never runs |
| Email Worker → core-api POST /captures | Yes (unit mock of email-compose/classify) | No | No | **Gap** — no end-to-end test of the Cloudflare Email Worker path |
| Slack bot intent → capture vs query routing | Yes (`intent-router.test.ts`) | No | Optional via regression script `--slack` | Gap — intent routing has unit coverage but no live Slack integration test in CI |
| MCP Streamable HTTP | Yes (`mcp-tools.test.ts` integration suite) | Yes (gated) | Yes (`e2e-full.sh` parses SSE) | CI gap |
| Pipeline retry + auto-sweep | Yes | No | No | **Gap** — 5-attempt backoff and daily auto-sweep have no integration test |
| LLM tier fallback (primary→fallback) | Yes (`email-compose-fault-injection.test.ts`) | No | No | Covered for email-compose only; memory-consolidation and weekly-brief bypass the gateway entirely |
| Spreading activation + Hebbian boost | Yes (unit) | No | No | **Gap** — SQL function `spreading_activation` has no integration assertion |
| Budget circuit breaker | No | No | No | **Gap** — $50 hard-cap circuit breaker is un-tested; directly linked to the 2026-04-15 cost incident |
| Voice-capture iOS shortcut path | Yes (unit) | No | No (manual via USER_TEST_PLAN) | Acceptable given single-user / low volume |
| File-ingestion pipeline | Python only (1 test) | No | No | **Gap** — `packages/file-ingestion` has test coverage but no CI job |

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 4 |
| Medium | 6 |
| Low | 5 |
| **Total** | **15** |

### High

1. **Integration, E2E, and regression suites are not CI-gated.** `docker-compose.test.yml` + `test:integration` scripts + `regression-test.mjs` + `e2e-*.sh` are all fully functional and documented in CLAUDE.md. None run in a CI workflow. Deploys proceed on unit-lint-build only. Recommend adding a post-PR workflow that spins the test compose, applies `scripts/init-schema.sql` + `packages/shared/drizzle/0001–0022.sql`, runs `pnpm --filter @open-brain/core-api exec vitest run -c vitest.config.integration.ts` and the workers equivalent, and (optionally, weekly) runs `regression-test.mjs` against a throwaway instance.
2. **No test asserts tier-routing matches `ai-routing.yaml` `task_routing` + nonzero `cost_per_1k`.** The 2026-04-15 $100 cost incident was caused by exactly this class of defect (task_routing pointing at a tier with `cost_per_1k: 0` AND wrong Jetson IP). A config-validation test that loads `ai-routing.yaml` and asserts every paid-tier's cost is > 0 and every task_routing target exists would have prevented it. Low cost, high value.
3. **`memory-consolidation` and `weekly-brief` bypass LLMGatewayService** (intake-flagged). They call Anthropic SDK directly — no tier fallback, no audit log row. There is no fault-injection test equivalent to `email-compose-fault-injection.test.ts` for these two paths. A 429 on Sunday 4 AM will silently eat the consolidation run.
4. **Drift-guard is incomplete.** `web-type-drift.test.ts` asserts `IngestSourceType` + `FileUploadStatus` parity but NOT `CaptureSource` — which just grew from 8 to 9 values (`'system'`) in PR #101 after a cold-path discovery audit. Extend the drift-guard to cover all web-duplicated union types, or (better) make the web package import runtime enums from `@open-brain/shared` via a build-time transform.

### Medium

5. **Coverage is measured but never gated.** `core-api` has 80/80 thresholds but CI runs `pnpm -r test` without `--coverage`. Either enable coverage in CI and gate on the declared thresholds, or remove the declaration to avoid confusing newcomers.
6. **SAST is missing.** No CodeQL (GitHub Advanced Security ships it free for public repos), Semgrep, or equivalent. GitGuardian covers secrets only. For a single-user app this is lower-severity, but the MCP endpoint is publicly reachable via Cloudflare Tunnel with a Bearer token — a SAST regression could surface before a human does.
7. **Python coverage is bifurcated.** Only `docker/ingest-sidecar/tests/` runs in CI. `packages/voice-pipecat/tests/` (5 files) and `packages/file-ingestion/tests/` (1 file) are un-executed. Add them to the `sidecar-test` job or split into separate jobs; at minimum, mark them `[skipped-in-ci]` in a README to prevent false confidence.
8. **`email-compose-fault-injection.test.ts` asserts a known-wrong behavior** (tier-key recorded is the initial resolved tier, not the succeeding one, per inline comment lines 170–184). Either file an issue to fix `recordAgentCompletion` or promote the test to `.todo()`. Leaving a "passing" test that documents a production defect risks the wrong signal on future changes.
9. **Regression script emits `BUG` states that nobody reads.** `scripts/regression-test.mjs` distinguishes PASS/FAIL/BUG/SKIP but is not wired into any dashboard, alert, or follow-up. Stale BUG findings could linger unread between manual runs.
10. **No memory/RSS soak test** despite CLAUDE.md's 1.5 GB hard rule. A 10-minute sustained-load test that records max RSS and fails > 1.5 GB would defend the rule from regressions in the embedding or wiki-ingest paths.

### Low

11. Test-count claims in README/intake (1,569 unit + 95 regression) don't match actual counts (2,689 `it`/`test` blocks + 91 regression TC-IDs). Not consequential, but docs drift.
12. No accessibility automation for the PWA — USER_TEST_PLAN carries it manually. Acceptable for single-user, but axe-core / Lighthouse CI would be cheap.
13. Monthly audit workflow is informational-only (posts to summary, doesn't fail on outdated packages). Consider a yes/no threshold for known-vulnerable packages.
14. E2E shell scripts use `set -euo pipefail` and clean bash but depend on Python3 for JSON parsing — inject `jq` (already available in runners) for consistency, or declare Python3 as a runtime dep explicitly.
15. `tests/validate-t0-classification.test.ts` at repo root uses its own `vitest.config.validation.ts` — ensure this is discovered by `pnpm -r test` (it is, via root config) and documented.

---

## Notes for Synthesizer

The test posture is **strong at the unit layer, well-designed at the integration layer, but undergated by CI**. The gap is not "not enough tests" — it is "good tests that CI doesn't run." A single new workflow that exercises `docker-compose.test.yml` + the per-package `test:integration` script would lift the confidence bar significantly. The highest-leverage fix is a **config-contract test** against `ai-routing.yaml` (High #2) — cheap to write, directly prevents the concrete $100 cost incident that actually happened.
