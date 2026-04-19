# IMPLEMENT_PHASE-P10a — CI gating: integration tests

**Phase:** P10a
**Severity:** High
**Effort estimate:** ~4 hours (revised up from ~1 day card estimate — infrastructure is already 80% done; the real work is CI job composition + observe-mode wiring + sidecar build caching, not building the test harness from scratch)
**Dependencies:** None (integration test harness is fully implemented; `docker-compose.test.yml` exists with correct services)
**Branch (Gate 2):** `feat/phase-P10a-ci-integration-tests`
**Homeserver migration:** **NO** — CI-only change, no application code, no DB migrations

---

## Scope Diff vs. PHASED_PLAN.md

The phase card says "starts postgres+pgvector+redis+sidecar containers" and references building `docker-compose.test.yml`. **Three material drifts from the card:**

1. **`docker-compose.test.yml` already exists** at repo root (added in sidecar testing work). It is production-ready:
   - `test-postgres`: `pgvector/pgvector:pg16`, port 5433, `tmpfs` data dir (fast/ephemeral), healthcheck on `127.0.0.1`
   - `test-redis`: `redis:7-alpine`, port 6381, `--save ""` (no persistence), healthcheck on `127.0.0.1`
   - `test-sidecar`: builds from `docker/ingest-sidecar/Dockerfile`, port 8099
   - All healthchecks use `127.0.0.1` (correct per CLAUDE.md Alpine IPv6 rule)

2. **No external API keys needed.** `setup.ts` explicitly stubs the `EmbeddingService` to return zero vectors ("LiteLLM won't be available in test/CI"). The integration tests only need `TEST_POSTGRES_URL` and `TEST_REDIS_URL` — both default to the values matching `docker-compose.test.yml` ports (5433 and 6381). No `OPENAI_API_KEY`, no `MCP_API_KEY`, no secrets required.

3. **sidecar build in `docker-compose.test.yml` will be slow on cold runners** (builds from scratch). The card says "timeout + cache config tuned for ubuntu-latest runners." Sidecar build is the dominant cost. A Docker layer cache using `actions/cache@v5` on `type=gha` will handle this for repeat runs; cold builds need a generous timeout.

**Card phrase "Timeout + cache config tuned for Windows AND ubuntu-latest runners":** The CI currently runs only on `ubuntu-latest`. There is no Windows runner in `.github/workflows/ci.yml`. The Windows vitest profile (forks pool, `minForks`/`maxForks`) is for local dev. This work item targets `ubuntu-latest` only — no Windows runner is needed or warranted in CI for Docker-based integration tests.

**No acceptance criterion is invalidated. Scope narrows (docker-compose file not needed), simplifying WI 1.**

---

## Context

The integration test suite covers 6 test files across `packages/core-api/src/__tests__/integration/`:
- `smoke.test.ts` — schema connectivity + helper utilities
- `captures.test.ts` — CRUD, pipeline_status, source validation
- `entities.test.ts` — entity creation + linking
- `mcp-tools.test.ts` — MCP tool endpoints with real DB
- `rate-limit-internal.test.ts` — rate-limit bypass with `X-Open-Brain-Caller: integration-test`
- `search.test.ts` — hybrid search with zero-vector stubs

The test runner config (`vitest.config.integration.ts`) uses `pool: 'forks'` with `singleFork: true` (serial execution — avoids DB contention), `testTimeout: 30_000`, `hookTimeout: 30_000`, and `bail: 1` (fail-fast on DB setup failure).

The test harness already bypasses rate limiting via `X-Open-Brain-Caller: integration-test` (CLAUDE.md operational rule; `integration-test` is in `BYPASS_CALLERS`).

**Observe mode rationale:** The integration tests are stable locally but have never run in GitHub Actions CI. Two PRs in observe mode (`continue-on-error: true`) lets us catch any CI-specific flakiness (DNS, tmpfs availability, Docker layer issues) before gating PRs on it.

---

## Work Items

### WI 1 — Add `integration-test` job to `.github/workflows/ci.yml`

**File:** `.github/workflows/ci.yml`

Add a new job after the existing `python-lint` job. The job:
- Runs on `ubuntu-latest`
- Has `timeout-minutes: 15` (sidecar build ~3min cold, DB startup ~10s, test run ~60s — total <5min warm; cold first-run budget 15min)
- Uses `continue-on-error: true` (observe mode — non-blocking until 2 stable PRs pass)
- Starts services via `docker compose -f docker-compose.test.yml up -d --wait` (the `--wait` flag waits for all healthchecks before returning)
- Runs the integration test command
- Always tears down services in a final step

The job definition:

```yaml
  integration-test:
    name: Integration tests (core-api + real DB)
    runs-on: ubuntu-latest
    timeout-minutes: 15
    # OBSERVE MODE: non-blocking until stable for 2 PRs.
    # After 2 consecutive green PRs, remove this line and add job to
    # branch protection required status checks (Settings > Branches > main).
    continue-on-error: true

    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9.15.0

      - name: Setup Node.js
        uses: actions/setup-node@v5
        with:
          node-version: '22'
          cache: 'pnpm'

      - name: Restore pnpm store cache
        uses: actions/cache@v5
        with:
          path: ~/.local/share/pnpm/store
          key: pnpm-store-${{ hashFiles('pnpm-lock.yaml') }}
          restore-keys: |
            pnpm-store-

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build shared package
        run: pnpm --filter @open-brain/shared build

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Cache Docker layers (sidecar build)
        uses: actions/cache@v5
        with:
          path: /tmp/.buildx-cache
          key: buildx-sidecar-${{ hashFiles('docker/ingest-sidecar/Dockerfile', 'docker/ingest-sidecar/requirements.txt', 'docker/ingest-sidecar/trigger_server.py') }}
          restore-keys: |
            buildx-sidecar-

      - name: Start test services
        run: |
          docker compose -f docker-compose.test.yml build \
            --cache-from type=local,src=/tmp/.buildx-cache \
            test-sidecar
          docker compose -f docker-compose.test.yml up -d --wait
        env:
          BUILDX_NO_DEFAULT_ATTESTATIONS: 1

      - name: Save Docker layer cache
        if: always()
        uses: actions/cache@v5
        with:
          path: /tmp/.buildx-cache
          key: buildx-sidecar-${{ hashFiles('docker/ingest-sidecar/Dockerfile', 'docker/ingest-sidecar/requirements.txt', 'docker/ingest-sidecar/trigger_server.py') }}

      - name: Run integration tests
        run: pnpm --filter @open-brain/core-api exec vitest run --config vitest.config.integration.ts
        env:
          TEST_POSTGRES_URL: postgresql://openbrain_test:test_password@localhost:5433/openbrain_test
          TEST_REDIS_URL: redis://localhost:6381
          NODE_ENV: test

      - name: Dump service logs on failure
        if: failure()
        run: docker compose -f docker-compose.test.yml logs --no-color

      - name: Tear down test services
        if: always()
        run: docker compose -f docker-compose.test.yml down -v
```

**Notes:**
- `TEST_POSTGRES_URL` and `TEST_REDIS_URL` match the defaults in `setup.ts` — this `env:` block is documentation/explicitness, not strictly required.
- `NODE_ENV: test` prevents any production guards from firing during integration tests.
- The "Dump service logs on failure" step is essential for debugging — without it, container startup failures are opaque.
- `down -v` removes volumes (tmpfs on test-postgres, but the `-v` flag is belt-and-suspenders for any named volumes docker compose creates).
- Docker Buildx cache uses `/tmp/.buildx-cache` with content-addressed keys on the sidecar Dockerfile + requirements + server script. Cold miss builds from scratch; warm hit reuses layers.

**Implementation note on `--wait` flag:** `docker compose up --wait` (added in Compose v2.1.1) waits for all service healthchecks to report healthy before returning. All three services in `docker-compose.test.yml` have healthchecks. GitHub Actions runners use Docker Engine 24+ which includes Compose v2 — `--wait` is available.

### WI 2 — Verify `docker compose up --wait` healthcheck timing is adequate

Before committing, confirm the healthcheck parameters in `docker-compose.test.yml` are sufficient for a cold CI runner:

- `test-postgres`: `interval: 2s`, `retries: 10`, `start_period: 5s` → max wait ~25s. Adequate.
- `test-redis`: `interval: 2s`, `retries: 10` → max wait ~20s. Adequate.
- `test-sidecar`: `interval: 5s`, `retries: 5`, `start_period: 5s` → max wait ~30s. Adequate.

No changes to `docker-compose.test.yml` expected; this is a verification step. If timing proves insufficient after first CI run, increase `test-postgres` `retries` to 15 or `start_period` to 10s.

### WI 3 — Validate vitest config compatibility with CI environment

Review `packages/core-api/vitest.config.integration.ts` for any CI-incompatible settings:

```typescript
// Current config (lines 1-20):
pool: 'forks',
poolOptions: { forks: { singleFork: true } },  // serial, avoids DB contention
testTimeout: 30_000,
hookTimeout: 30_000,
bail: 1,
```

Confirm `singleFork: true` is valid in vitest 1.6 (the Windows forks profile uses `minForks`/`maxForks`; `singleFork` is a separate option controlling whether a single fork process runs all tests serially). On Linux CI, both options are valid.

**No changes expected.** The config is already correct for both local and CI use. The `minForks`/`maxForks` guard from CLAUDE.md applies to the unit test config, not the integration config which uses `singleFork: true`.

### WI 4 — Add promotion documentation as inline comment

Add a comment block directly above the `continue-on-error: true` line in the new job (not a separate doc file). This keeps the promotion instructions co-located with the flag:

```yaml
    # OBSERVE MODE — promotion checklist:
    # 1. Verify 2 consecutive PRs show this job green in GitHub Actions
    # 2. Remove the `continue-on-error: true` line below
    # 3. Add "Integration tests (core-api + real DB)" to branch protection
    #    required status checks: Settings > Branches > main > Edit >
    #    "Require status checks to pass" > search for job name
    # 4. Update this comment to: "REQUIRED: promoted YYYY-MM-DD PR #NNN"
    continue-on-error: true
```

No separate documentation file. The checklist lives in the workflow YAML itself.

### WI 5 — Run tests locally before commit

Verify the integration tests still pass locally against `docker-compose.test.yml`:

```bash
# From repo root
docker compose -f docker-compose.test.yml up -d --wait
pnpm --filter @open-brain/core-api exec vitest run --config vitest.config.integration.ts
docker compose -f docker-compose.test.yml down -v
```

This is a smoke check against local drift. The CI job will be the definitive run, but a local pass confirms the test suite is healthy before the PR.

**Note:** Do NOT run `pnpm -r test` (which excludes integration tests by design). The integration config is separate and must be invoked explicitly.

### WI 6 — Write LAB_NOTEBOOK entry

Add Entry 104 before the first commit. Must include:
- Objective: add integration-test CI job in observe mode
- Hypothesis: job green on first PR; sidecar build < 5min warm with layer cache
- Rollback plan: remove the new `integration-test` job from `ci.yml`

---

## Acceptance Criteria

1. New `integration-test` job appears in `.github/workflows/ci.yml`.
2. Job starts with `continue-on-error: true` (observe mode) with promotion checklist comment.
3. Job uses `docker compose -f docker-compose.test.yml up -d --wait` to start services.
4. Job runs `pnpm --filter @open-brain/core-api exec vitest run --config vitest.config.integration.ts`.
5. Job tears down with `docker compose -f docker-compose.test.yml down -v` in an `if: always()` step.
6. Job includes "Dump service logs on failure" step for debuggability.
7. Docker Buildx layer cache configured for sidecar with content-addressed key.
8. Job timeout set to 15 minutes.
9. Job runs green on the first open PR (integration tests pass against ephemeral CI services).
10. LAB_NOTEBOOK Entry 104 written before first commit.

---

## Rollback Plan

- **Code:** `git revert <commit-sha>` — removes the new job from `ci.yml`. No application code touched.
- **If the sidecar build is flaky in CI:** disable the `test-sidecar` service in the CI `docker compose up` command by passing `test-postgres test-redis` (explicit service names) instead of starting all services. The core-api integration tests do not directly test the sidecar; the sidecar is included in `docker-compose.test.yml` for the workers e2e test (`INGEST_E2E=1`), which is not run in this job.
- No homeserver impact. No migrations. No application code.

---

## Out of Scope

- **Promotion to required status check** — this is a manual operator step after 2 stable PRs, documented in the inline comment (WI 4). Not automated.
- **Workers integration tests** — the workers package has an `ingest-e2e.test.ts` guarded by `INGEST_E2E=1`. This is a separate concern for P10b or a future phase.
- **Windows CI runner** — the CLAUDE.md vitest Windows profile is for local dev. Docker-based integration tests run on `ubuntu-latest` only. Windows runners for CI are not warranted.
- **Secrets in CI** — integration tests are explicitly designed to require no API keys (stub embedding service). No `OPENAI_API_KEY` or other secrets need to be added to GitHub Actions.
- **P10b** (Python pytest jobs + test-count doc updates) — separate phase.

---

## Files Touched

| File | Action |
|------|--------|
| `.github/workflows/ci.yml` | **EDIT** — add `integration-test` job after `python-lint` |
| `LAB_NOTEBOOK.md` | **EDIT** — Entry 104 (pre-action, before first commit) |

**Total: 2 files. Zero application code changes.**

---

## Effort Breakdown

| Work Item | Estimated Time |
|-----------|---------------|
| WI 1 — Write CI job YAML | 45 min |
| WI 2 — Verify healthcheck timing | 10 min |
| WI 3 — Validate vitest config | 10 min |
| WI 4 — Add promotion comment | 5 min |
| WI 5 — Local smoke test | 20 min |
| WI 6 — LAB_NOTEBOOK entry | 10 min |
| Buffer (CI iteration if first run fails) | 60 min |
| **Total** | **~2.5–3.5 hours** |

Revised down from the phase card's "~1 day" because `docker-compose.test.yml` exists, the integration test harness is complete, no secrets are needed, and the change is a single-file CI edit.
