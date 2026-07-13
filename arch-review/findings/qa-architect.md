# QA Architect Findings

**Reviewer:** QA Architect
**Date:** 2026-07-12
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High

> **v5 — supersedes the 2026-07-09 v4 review.** Every v4 finding was adjudicated against current HEAD (`cd14c1f`) with fresh evidence, including a **live re-run of the workers coverage suite under vitest 3** (1,091/1,091 tests pass, 46s). Since-v4 changes that matter to QA: (1) vitest 2→3 + @vitest/coverage-v8 lockstep (PR #234) made coverage measurement **honest** — core-api's historical 85.6% was inflated by test files counted as covered source; true coverage was **76.48% (below its own 80% gate)**, remediated the right way (backfill `b828fb5` + dead-code removal `8d3b426` → **81.52%**, no threshold lowered); (2) **CodeQL default setup configured 2026-07-12** (actions/JS/TS/python, weekly + PR analysis) and Dependabot grouped weekly updates + automated security fixes enabled (`cd14c1f`).

---

## v4 Adjudication Table

| v4 ID | v4 Severity | Verdict | Evidence (verified 2026-07-12) |
|-------|-------------|---------|--------------------------------|
| QA-1 workers coverage gate dormant, below floor | High | **STILL OPEN** | `packages/workers/package.json` `"test": "vitest run --passWithNoTests"` — still no `--coverage`. Live vitest-3 re-run: **73.72% lines (8,490/11,516) vs 78% floor — gate would fail**; functions 81.75% passes. Number is byte-identical to v4 (workers' config already excluded `src/__tests__/**` from coverage, so the vitest-3 unmask didn't move it, and no workers src/test changes landed since v4 except the nodemailer bump). `scheduler.ts` still **0%** and has grown 307→495 lines; `jobs/skill-execution.ts` **0.41%** (73–607 uncovered); `jobs/ingest-process.ts` **0%** (305 lines); `skills/memory-consolidation-query.ts` **4.7%**; `skills/refine-brief.ts` **3.48%**. |
| QA-2 ingest e2e permanently off in CI | High | **STILL OPEN** | `ci.yml:212` — "QA-M3 (INGEST_E2E) intentionally NOT enabled here" comment unchanged; `ingest-e2e.test.ts:147` `describe.skipIf(!E2E_ENABLED)`. |
| QA-3 web UI no operative test layer | High | **STILL OPEN** | web-next: 5 test files (125 cases per PR #234 baseline) for 270 src files; `quick-capture.spec.ts` still self-skipping (`test.skip(true, …)` at line 55) and `playwright`/`test:e2e` appear in **no** workflow (grep of `.github/workflows/`: zero hits). |
| QA-4 5 of 8 CI jobs not required checks | Medium | **STILL OPEN** | `gh api` branch protection: required contexts still exactly `["Integration tests (core-api + real DB)","build-and-test"]`. `validate-schema`, `python-lint`, `sidecar-test`, `voice-pipecat-test`, `file-ingestion-test` remain non-blocking — and the **new CodeQL check is also not required**. |
| QA-5 zero-vector embedding stub | Medium | **STILL OPEN** | `core-api/src/__tests__/integration/setup.ts:166` — `embed: async () => new Array(768).fill(0)` unchanged; vector/HNSW/RRF path still has no CI behavioral assertion. |
| QA-6 security scanning monthly + advisory only | Medium | **CHANGED — materially improved; residual Low** | CodeQL **default setup configured** (`gh api code-scanning/default-setup`: state=configured, languages actions/js-ts/python, weekly, updated 2026-07-12T19:56Z; first run green). `automated-security-fixes` enabled=true. `.github/dependabot.yml` added: weekly grouped minor/patch + isolated majors, npm root + both cloudflare dirs + actions. Residual gap (QA-6r): CodeQL is not a required check and there is still no per-PR `pnpm audit` gate — scanning exists but nothing security-related can block a merge. |
| QA-7 email-worker zero tests / zero CI typecheck | Medium | **STILL OPEN — mildly aggravated** | `cloudflare/email-worker/package.json` scripts: `dev`/`deploy`/`tail` only, no test/typecheck; no test files under `cloudflare/` (excluding node_modules). Aggravation: Dependabot now auto-bumps this dir weekly (open PRs #235 postal-mime — the mail parser itself — and #237 workers-types **4→5 major**) and those PRs go green on a CI that never compiles or exercises the worker; a parsing regression would be discovered only via wrangler-on-deploy or lost mail. |
| QA-8 no pre-merge performance check | Medium | **STILL OPEN** | `benchmark-search.mjs` still manual-only; no perf assertion in integration suite; no workflow change. |
| QA-9 `durationMs > 0` flakes ×2 | Low | **STILL OPEN** | `drift-monitor.test.ts:724` and `weekly-brief.test.ts:261` both unchanged. New detail: `weekly-brief.test.ts:634` already uses the correct `toBeGreaterThanOrEqual(0)` — the fix pattern exists in the same file, 373 lines below the flake. |
| QA-10 doc-sync observe mode forever | Low | **STILL OPEN** | `ci.yml:235` `continue-on-error: true` with its 2-green-PR promotion checklist still unmet. |
| QA-11 no accessibility checks | Low | **STILL OPEN** | No axe/a11y anywhere in web-next or workflows. |
| QA-12 ESLint frozen at `--max-warnings 18`; no ESLint in 4 packages | Low | **STILL OPEN** | `web-next/package.json:9` unchanged; shared/slack-bot/voice-capture/mobile still `tsc --noEmit` only. |
| QA-13 real 5–10ms sleeps instead of fake timers | Low | **STILL OPEN** | All 7 unit-test sites unchanged: `mcp-activity-logger.test.ts:212,233,253,271`, `voice-session-service.test.ts:152,250`, `shared/.../run-agent.test.ts:574`. (Integration-suite polls in `pipeline.test.ts`/`ingest-e2e.test.ts` are legitimate.) |
| QA-14 coverage unmeasured in 5 of 7 TS packages | Low | **STILL OPEN** | shared/slack-bot/voice-capture/web-next/mobile test scripts still lack `--coverage`; web-next `test:coverage` script still invoked by nothing. |
| QA-RI-1 first scheduled DR runs unverified (A131) | RI | **STILL OPEN** | No repo/notebook evidence of a scheduled restore-rehearsal or offsite-backup run being confirmed since v4 (LAB_NOTEBOOK newest entries are 183/Dependabot). Homeserver logs remain out of read-only scope. |

**Net-new this cycle:** QA-15 (Low, below). QA-6 is re-issued at reduced severity as **QA-6r** (Low).

## Test Strategy Assessment

- Strategy documented: **Partial** — still no TESTING.md; strategy remains implicit-but-legible (threshold rationale comments, CI promotion checklists, CLAUDE.md Testing/CI rules, "raise coverage, never lower thresholds" constitution in vitest configs).
- Strategy appropriate for architecture: **Yes** — unit-heavy + real-DB integration layer fits the queue-driven service monolith; incident-pinned regression tests (SE-1 SQL pinning, pg-uuid-array/Entry-180, sidecar PR #91–93 suite) remain the standout pattern.
- Actual test suite consistent with strategy: **Partial** — the constitution was **honored under pressure this cycle** (when vitest 3 exposed core-api's true 76.48% vs the 80 gate, the response was test backfill + dead-code removal, not a threshold cut — exactly what the constitution demands), but it remains violated in workers (gate dormant at 73.72% vs the 78 floor) and the E2E layer still never executes.

## Test Pyramid Analysis

Counts are test **files** (post-vitest-3 case counts from PR #234 baseline + backfill: shared 342, core-api 1,209+ (entity/briefs backfill added ~2 files), workers 1,091, slack-bot 504, voice-capture 103, web-next 125, mobile ~30).

| Layer | Count | % of Total | Assessment |
|-------|-------|------------|------------|
| Unit (TS) | ~179 files (~3,500 cases) | 87% | Strong on backend packages; thin on web-next/mobile (unchanged) |
| Unit (Python) | 12 files | 6% | Adequate; all 3 pytest suites run in CI (non-required) |
| Integration | 11 files (core-api 8, workers 3) vs real Postgres+pgvector+Redis | 5.3% | Good; embedding still zero-stubbed (QA-5) |
| Contract / drift-guard | 3 files + `validate-schema` CI parity job | 1.5% | Distinctive strength, unchanged |
| E2E | 1 Playwright file, never runs in CI, self-skips | 0.5% | Effectively absent (QA-3) |
| **Total** | **~206 files** | 100% | |

Pyramid assessment: **Bottom-heavy in the healthy sense; the operational top of the pyramid is still missing** (identical verdict to v4 — QA-2/QA-3 unmoved).

## Test Quality Assessment (from sampling)

v4 sampled 18 files across all layers; this cycle re-verified the specific finding sites plus the new backfill tests (`b828fb5`: entity/briefs service tests — behavioral, DB-boundary-mocked per existing conventions, branch-complete incl. fallback paths) and the vitest-3 migration surface (identical test counts pre/post bump in all 6 packages; per-file glob thresholds confirmed still enforced under vitest 3 by the live run).

| Dimension | Score (1–5) | Evidence |
|-----------|-------------|----------|
| Assertion meaningfulness | 4 | Unchanged from v4; backfill tests continue the specific-value assertion style. Deduction: `durationMs > 0` pair persists (QA-9). |
| Behavior vs implementation coupling | 4 | Unchanged — mocks at architectural seams; deliberate implementation-pinning only as documented regression armor. |
| Test isolation | 4 | Unchanged — forks pool, per-test DB clean, unique queue names; 7 real-sleep sites persist (QA-13). |
| Data management | 4 | Unchanged — factories, tmpfs PG, generated-schema fidelity. |
| Readability | 5 | Unchanged — incident-linked docstrings remain best-in-class. |

Specific quality findings:
- `packages/workers/src/__tests__/drift-monitor.test.ts:724` + `weekly-brief.test.ts:261` — both `durationMs > 0` flakes survive a third review cycle; `weekly-brief.test.ts:634` shows the correct `>= 0` form in the same file (QA-9).
- 7 real-sleep sites unchanged (QA-13).
- Zero `.only` residue; zero unconditional TS skips (re-verified).

## Coverage Assessment

- Configured thresholds: core-api **80/80** (enforced — `test` runs `--coverage` inside required `build-and-test`); workers **78 lines / 81 funcs + four per-file 100% locks** — **configured but dormant** (no `--coverage` in test script). shared/slack-bot/voice-capture/web-next/mobile: unmeasured.
- Reported coverage:
  - **core-api: 81.52% lines (honest, vitest 3)** — the v4/exec-summary figure of 85.57% is **stale and was inflated**: vitest 2 with this repo's custom `coverage.exclude` counted ~76 `*.test.ts` files as covered source. True pre-fix coverage was 76.48% — the CI gate had been passing on false assurance since Phase 1. Remediated 2026-07-12 by backfilling `services/entity.ts` (0→100%) and `services/briefs.ts` (0→99.5%) and deleting 3 genuinely-dead files. **Margin above the gate is now 1.52 points** — expect the gate to actually bite on future PRs (that is it working, but be aware).
  - **workers: 73.72% lines (8,490/11,516) / 81.75% funcs — measured live this review under vitest 3; FAILS the 78 floor.** Identical to v4 (workers' coverage config already excluded test files, so its number was always honest — and it has neither eroded nor improved since v4).
- Critical path coverage gaps (unchanged set, one worse): `scheduler.ts` **0% of 495 lines (grew from 307 — the untested spine is growing)**; `jobs/skill-execution.ts` 0.41%; `jobs/ingest-process.ts` 0% (305 lines); `jobs/wiki-ingest-worker.ts` 0%; `skills/refine-brief.ts` 3.48%; `skills/memory-consolidation-query.ts` 4.7% (feeds the destructive consolidation skill); `jobs/email.ts` 22.98%; all 12 `queues/*.ts` 0–18.75%.

## CI Pipeline Gate Assessment

Branch protection re-verified live via `gh api` this review: required = **`Integration tests (core-api + real DB)` + `build-and-test`** only.

| Gate | Exists? | Blocking? | Finding |
|------|---------|-----------|---------|
| Unit tests (7 TS pkgs + mobile jest) | Yes | **Yes** | Healthy; vitest 3 migration zero-regression (identical counts) |
| Coverage threshold | core-api only | core-api yes (now honest); workers **no** | QA-1 — 1 of 7 packages gated |
| Lint/type check | Yes (tsc everywhere; ESLint web-next only, `--max-warnings 18`; ruff+pyright Python) | tsc/ESLint yes; python-lint **not required** | QA-4, QA-12 |
| Security scan | **Yes — NEW: CodeQL default setup (weekly + PR); Dependabot weekly grouped + auto security fixes** | **No — CodeQL not a required check; no per-PR audit gate** | QA-6r (downgraded from v4 QA-6) |
| Integration tests (real PG+pgvector+Redis) | Yes | **Yes** | Healthy; embedding zero-stubbed (QA-5) |
| Schema parity (`validate-schema`) | Yes | **No — not required** | QA-4 |
| Python sidecar tests (3 jobs) | Yes | **No — not required** | QA-4 |
| E2E tests | File exists | **Not in CI** | QA-3 |
| Doc sync | Yes | No (`continue-on-error: true`) | QA-10 |
| Secrets guards (redaction + BWS roundtrip) | Yes | Yes | Strength, unchanged |
| Cloudflare workers (email-worker, synthetic-monitor) | **Nothing** — no test, no typecheck, no job | — | QA-7; now receiving weekly automated dep bumps with zero CI exercise |

## Test Reliability

- Skipped/disabled: no unconditional skips (re-verified); conditional set unchanged (`ingest-e2e` skipIf, Playwright self-skip, 3 pytest optional-lib guards).
- Retry configuration: Playwright `retries: CI ? 2 : 0` (moot); **no vitest retries** — failures still treated as real. Good.
- Flakiness: 15 most recent CI runs sampled via `gh run list` — **all success**, including the 9 Dependabot PR runs and the vitest-3 migration. The two `durationMs > 0` latent flakes remain the only documented flake class (QA-9).
- Timeouts: unchanged and appropriate (`hookTimeout/testTimeout: 30_000`, `bail: 1` + `singleFork` integration, per-job `timeout-minutes`).
- Open PR queue: 9 Dependabot PRs (#235–#243, incl. two actions majors and workers-types 4→5 majors for both cloudflare dirs) — routine, but the two cloudflare-dir ones merge against zero test/typecheck coverage (QA-7).

## Non-Functional Testing

| Type | In Pipeline? | Ad-hoc? | Missing? |
|------|-------------|---------|----------|
| Load/performance | No | `benchmark-search.mjs`, `validate-knn-similarity.mjs` (manual) | Pre-merge perf assertion (QA-8, unchanged) |
| Security/SAST | **Yes (new)** — CodeQL weekly + PR (advisory); Dependabot weekly + auto-fix | Monthly audit digest | Blocking security gate (QA-6r) |
| Chaos/resilience | Partial-in-unit (fault-injection suites) | — | Stack-level; acceptable at this scale |
| Accessibility | No | No | QA-11 unchanged |
| DR / backup verification | Partial (CI shell guards) | Scheduled homeserver crons | A131 first-scheduled-run verification still unobserved (QA-RI-1) |

## Test Environment Fidelity

Unchanged from v4 — high fidelity where it counts (generated init-schema on real pgvector image, kept honest by the two-DB parity job; real BullMQ/Redis) with the same two deliberate holes: zero-vector embeddings (QA-5) and no app containers in `docker-compose.test.yml` (root cause of QA-2). Fixture strategy (factories + tmpfs PG) remains good.

## Critical Path Coverage Matrix

| Business Path | Unit | Integration | E2E | Gap? |
|--------------|------|-------------|-----|------|
| Capture → pipeline stages | Strong | Real BullMQ+PG (`pipeline.test.ts`) | Disabled (INGEST_E2E) | QA-2 unchanged |
| Hybrid search + MCP search | Strong | FTS real; vector **zero-stubbed** | — | QA-5 unchanged |
| Scheduler + skill-execution runtime | **0% / 0.41% execution coverage; scheduler grew to 495 untested lines** | — | — | **QA-1 — top QA risk, third consecutive review** |
| Voice capture chain | Strong (103) | Proxy covered | — | Accepted (INT-M2-voice deferral) |
| Email ingestion (CF worker) | **None** | **None** | **None** | QA-7 — now auto-dep-bumped weekly with zero CI |
| Slack bot | Strong (504) | — | — | Acceptable |
| Admin destructive ops | Strong (invariant-pinned) | — | — | Acceptable |
| Memory consolidation (destructive) | Skill 84%, **query layer 4.7%** | — | — | Part of QA-1 |
| Backup / DR | Shell guards in CI | — | Scheduled prod rehearsal | QA-RI-1 unverified |
| Web dashboard (270 src files) | 5 lib test files; zero component tests | — | 1 self-skipping smoke, not in CI | QA-3 unchanged |
| Mobile app | ~30 smoke cases | — | — | Accepted (#196) |

## Findings Detail (v5 register)

**QA-1 (High — STILL OPEN, third cycle):** Workers coverage gate dormant; live vitest-3 measurement **73.72% lines vs 78 floor** (functions 81.75% passes; per-file 100% locks pass). Unlike core-api, this number was never inflated — it is a true 4.28-point/~493-line deficit concentrated in the execution spine (`scheduler.ts` 0% and *growing* — 307→495 lines since v4-era measurement; `jobs/skill-execution.ts` 0.41%; `jobs/ingest-process.ts` 0%) and the destructive-consolidation query layer (4.7%). Both Entry-180 production incidents lived in this band. Fix path unchanged: test-catchup, then add `--coverage` to the workers `test` script. This remains the top QA priority; every review cycle it stays open, the untested spine gets larger.

**QA-2 (High — STILL OPEN):** Full-stack ingest e2e permanently disabled in CI (`ci.yml:212` deferral comment; needs the full-stack test compose). The bug classes it defends were all historically deploy-discovered.

**QA-3 (High — STILL OPEN):** Web UI has no operative test layer: 270 src files, 5 lib-module test files, zero component tests, one Playwright smoke that no workflow invokes and which self-skips without a live stack. Minimum fix unchanged: wire the smoke spec into CI on the QA-2 full-stack compose + component tests for the top pages.

**QA-4 (Medium — STILL OPEN, slightly widened):** Required checks still only the two TS jobs; `validate-schema` (sole automated defense for the DA-H1 schema-drift class), `python-lint`, and all three Python test jobs remain non-blocking — and the **new CodeQL check joined the non-required set**. Promote `validate-schema` + `python-lint` at minimum.

**QA-5 (Medium — STILL OPEN):** Zero-vector embedding stub (`setup.ts:166`) means the vector/HNSW/RRF half of hybrid search has no CI behavioral assertion. Checked-in fixture of pre-computed 768-d embeddings still the recommended fix.

**QA-6r (Low — v4 QA-6 CHANGED/downgraded):** Security scanning materially improved since v4: CodeQL default setup (actions/JS-TS/python, weekly + PR analysis, first run green 2026-07-12) + Dependabot weekly grouped updates + automated security fixes. Residual gap: everything is advisory — CodeQL is not a required check and no per-PR dependency-audit gate exists, so a red security scan cannot block a merge. Promote CodeQL to a required check once it has a few weeks of stable signal.

**QA-7 (Medium — STILL OPEN, aggravated):** `cloudflare/email-worker` still has zero tests and zero CI typecheck. Newly aggravating: Dependabot now auto-bumps this directory weekly — open PRs include `postal-mime` (the mail parser) and a `@cloudflare/workers-types` 4→5 **major** — and these merge on a CI that never compiles the worker. `isTransientStatus` + allowlist/reject flow remain pure functions; a ~10-case vitest suite plus a `tsc --noEmit` CI step is cheap and would make the Dependabot automation safe here.

**QA-8 (Medium — STILL OPEN):** No pre-merge performance assertion despite documented `hybrid_search` cliffs; `benchmark-search.mjs` manual-only.

**QA-9 (Low — STILL OPEN):** Both `durationMs > 0` flake sites unchanged (`drift-monitor.test.ts:724`, `weekly-brief.test.ts:261`); the correct `>= 0` pattern already exists at `weekly-brief.test.ts:634`. Two one-line edits, now outstanding across three review cycles.

**QA-10 (Low — STILL OPEN):** `doc-sync` still `continue-on-error: true`; promotion checklist long satisfiable. Promote or delete.

**QA-11 (Low — STILL OPEN):** No a11y checks; nearly free once QA-3 lands.

**QA-12 (Low — STILL OPEN):** web-next ESLint frozen at `--max-warnings 18`; 4 packages have no ESLint.

**QA-13 (Low — STILL OPEN):** 7 real-sleep sites in 3 unit-test files unchanged.

**QA-14 (Low — STILL OPEN):** Coverage unmeasured in 5 of 7 TS packages; `shared` (the most-depended-upon package, 342 cases) still has zero coverage visibility.

**QA-15 (Low — NEW):** The vitest-3 migration revealed that core-api's coverage gate had passed on an **inflated measurement since Phase 1** (custom `coverage.exclude` replaced vitest 2's default exclude list, so ~76 test files self-reported as covered source; true coverage 76.48% vs the 80 gate). Remediation was constitution-correct (backfill + dead-code removal, no threshold cut) and landed same-day. Residual actions: (a) core-api's honest margin is now **1.52 points** — the gate will genuinely bite, which is fine, but stale "85.57%" figures persist in prior reports/exec-summary and should be corrected to **81.52%**; (b) when coverage is eventually enabled for other packages (QA-14), always exclude test globs explicitly rather than relying on defaults; (c) the vitest.config comment "Vitest 2.x feature" on per-file thresholds is now stale (verified still enforced under vitest 3 in this review's live run).

**QA-RI-1 (Requires investigation — STILL OPEN):** First scheduled offsite-backup / restore-rehearsal runs (A131) remain unverified in any repo artifact; homeserver logs out of read-only scope. Until one scheduled rehearsal is observed passing, the DR test layer is unproven. Owner action unchanged: check homeserver cron logs / Pushover history once and note it in LAB_NOTEBOOK.

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 4 |
| Low | 8 |
| Requires investigation | 1 |
| **Total** | **16** |

## What Is Working Well (context for the Review Lead)

- **The coverage constitution passed a real test this cycle:** when vitest 3 exposed core-api below its own gate, the response was same-day test backfill (2 services 0→~100%) + verified dead-code deletion — not a threshold cut. This is the strongest possible evidence the QA culture is genuine.
- vitest 2→3 migration executed with zero test regressions across 6 packages (identical counts pre/post, root-caused coverage delta documented byte-for-byte in the commit message — exemplary migration hygiene).
- Security automation (CodeQL + Dependabot grouping + auto-fix) went from "monthly digest" to "weekly + per-PR advisory" in one commit.
- Incident-pinned regression tests, convention-as-test guards, and the generated-schema fidelity machine all remain intact and are still the project's distinctive QA strengths.
