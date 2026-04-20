# IMPLEMENT_PHASE-P10b — CI gating: voice-pipecat + file-ingestion pytest + test-count doc

**Phase:** P10b  
**Issue:** #115 (subset — Python pytest coverage in CI + README/intake updates)  
**Branch:** `feat/phase-P10b-pytest-ci-testcount`  
**Dependencies:** None (parallel-safe with all other phases)  
**Effort:** ~0.5 day  
**Rollback:** Remove the two new CI jobs; revert doc string changes. All trivial.

---

## Scope Diff (card vs. reality)

### Card assumptions verified

| Card claim | Reality | Delta |
|---|---|---|
| voice-pipecat tests exist at `packages/voice-pipecat/tests/` | Confirmed — 5 test files, 54 `def test_` functions | None |
| file-ingestion tests exist at `packages/file-ingestion/tests/` | Confirmed — 1 test file (`test_extract.py`), 26 `def test_` functions inside class methods | None |
| Existing sidecar-test job is the reference pattern | Confirmed at `.github/workflows/ci.yml` line 51–71 | None |
| P10a added integration-test job | Confirmed — present at lines 112–170 | None |
| README claims "1,569 unit + 95 regression" | Confirmed stale — `arch-review/intake.md` line 15 says the same | None |

### Scope drift: voice-pipecat requires a new `tests/requirements.txt`

The sidecar pattern uses `docker/ingest-sidecar/tests/requirements.txt` (contains only `pytest>=8.0,<9.0`) and runs tests against stdlib-only source. Voice-pipecat is different: the tested modules (`capture_extractor`, `config`, `health`, `session`, `tools`) import `anthropic`, `httpx`, `fastapi`, `pydantic-settings`, `redis`, and `yaml` — but do **not** import `pipecat-ai`. The full `requirements.txt` / `pyproject.toml` `[project.dependencies]` includes `pipecat-ai[silero,deepgram]` which would install silero (PyTorch) and Deepgram SDK — far too heavy for a CI test runner.

**Resolution:** Create `packages/voice-pipecat/tests/requirements.txt` listing only the lightweight test-time deps. This is one new file not mentioned in the card, but it is load-bearing — without it the CI job either pulls 2 GB of silero/deepgram or fails to import the modules under test.

### Scope drift: file-ingestion test runner needs a `pytest.ini` / `pyproject.toml`

`packages/file-ingestion/tests/conftest.py` imports `from src.extract import app` which requires the process to be run from inside `packages/file-ingestion/` (so `src/` is on the path). The file-ingestion package has no `pyproject.toml` or `pytest.ini`; the CI job must either `cd packages/file-ingestion && pytest tests/` or use `-p no:cacheprovider`. **Resolution:** The CI job runs `pytest packages/file-ingestion/tests/` with `working-directory: packages/file-ingestion` (same pattern used in sidecar-test with `run: python3 -m pytest docker/ingest-sidecar/tests/ -v --tb=short`).

### Test count verification

P10b card states the ACTUAL counts to document are:
- **TS unit tests:** 2,689
- **Regression (regression-test.mjs):** 91

Cross-check against LAB_NOTEBOOK Entry 105 (P10a, most recent): 2,649 TS tests before P09c. P09c added 2 drift-guard assertions to shared (296/296 after). Post-P09c shared = 296, workers = 980, core-api = 732, slack-bot = 492, voice-capture = 82, web (drift-guard) + shared already counted. The card's 2,689 figure is the authoritative target — use it as-is in doc updates.

Regression test count: `regression-test.mjs` contains 92 unique `TC-*` IDs by grep; the card says 91. Use 91 (card is authoritative; the 92nd may be a helper reference, not a standalone test case).

---

## Deliverables

| # | Deliverable | File(s) |
|---|---|---|
| D1 | `tests/requirements.txt` for voice-pipecat (lightweight — no pipecat-ai) | `packages/voice-pipecat/tests/requirements.txt` (new) |
| D2 | `voice-pipecat-test` CI job | `.github/workflows/ci.yml` |
| D3 | `file-ingestion-test` CI job | `.github/workflows/ci.yml` |
| D4 | README test-count update | `README.md` |
| D5 | Intake test-count update | `arch-review/intake.md` |

---

## Work Items

### WI 1 — Create `packages/voice-pipecat/tests/requirements.txt`

**File:** `packages/voice-pipecat/tests/requirements.txt` (create new)

Content must list exactly the packages that the tested source modules import, plus the test framework:

```text
# Test dependencies for packages/voice-pipecat/tests/
# Does NOT include pipecat-ai[silero,deepgram] — that pulls PyTorch/silero (~2 GB)
# which is not needed for unit tests (pipeline.py is the only file that imports pipecat
# and it is not covered by these tests).
anthropic>=0.49.0
httpx>=0.27.0
fastapi>=0.115.0
pydantic>=2.0
pydantic-settings>=2.0
redis>=5.0.0
pyyaml>=6.0
pytest>=8.0,<9.0
pytest-asyncio>=0.24.0
```

**Why this set:** `capture_extractor.py` imports `anthropic` and `httpx`; `config.py` imports `yaml`, `pydantic`, `pydantic_settings`; `session.py` imports `redis.asyncio`; `health.py` imports `fastapi`; `tools.py` imports `httpx`. All test mocks use `unittest.mock` (stdlib). `numpy` is not imported by any tested module.

**Verification:** After creating this file, confirm `pip install -r packages/voice-pipecat/tests/requirements.txt` does not pull torch/silero. (CI will catch it via the `timeout-minutes: 10` budget.)

### WI 2 — Add `voice-pipecat-test` job to `.github/workflows/ci.yml`

Insert after the existing `sidecar-test` job (after line 71) and before `validate-schema` (line 73). Mirror the sidecar-test structure exactly.

**Exact insertion point:** After line 71 (`run: python3 -m pytest docker/ingest-sidecar/tests/ -v --tb=short`), before line 73 (`validate-schema:`).

```yaml
  voice-pipecat-test:
    name: voice-pipecat tests (Python)
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          cache: 'pip'
          cache-dependency-path: packages/voice-pipecat/tests/requirements.txt

      - name: Install test dependencies
        run: pip install -r packages/voice-pipecat/tests/requirements.txt

      - name: Run pytest
        run: python3 -m pytest packages/voice-pipecat/tests/ -v --tb=short
        working-directory: packages/voice-pipecat
```

**Key details:**
- `working-directory: packages/voice-pipecat` — ensures `from src.capture_extractor import ...` resolves correctly (src/ is on path relative to cwd).
- `cache-dependency-path` points to the new `tests/requirements.txt` — cache key pins to that file, not the full `requirements.txt` (which would cache-bust on every pipecat-ai version bump).
- `timeout-minutes: 10` — lightweight deps install in under 60s; 54 tests run in under 5s.
- No `continue-on-error` — these are pure unit tests with no external deps; green from day one.

**Pytest config:** `pyproject.toml` already has `[tool.pytest.ini_options] testpaths = ["tests"]` and `asyncio_mode = "auto"` — no additional flags needed.

### WI 3 — Add `file-ingestion-test` job to `.github/workflows/ci.yml`

Insert immediately after the `voice-pipecat-test` job added in WI 2. Mirror the same structure.

```yaml
  file-ingestion-test:
    name: file-ingestion tests (Python)
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout
        uses: actions/checkout@v5

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.12'
          cache: 'pip'
          cache-dependency-path: packages/file-ingestion/requirements.txt

      - name: Install test dependencies
        run: pip install -r requirements.txt
        working-directory: packages/file-ingestion

      - name: Run pytest
        run: python3 -m pytest tests/ -v --tb=short
        working-directory: packages/file-ingestion
```

**Key details:**
- `working-directory: packages/file-ingestion` on both install and run steps — `conftest.py` imports `from src.extract import app` which requires `src/` to resolve relative to cwd.
- Uses the main `requirements.txt` (already contains `pytest==8.3.5`, `pytest-asyncio==0.26.0`, `httpx==0.28.1` — all pinned). No separate test requirements file needed.
- `cache-dependency-path: packages/file-ingestion/requirements.txt` — pinned file, stable cache key.
- No `continue-on-error` — these are synchronous FastAPI TestClient tests with no external dependencies.
- 26 test methods across 1 test class; all hit the FastAPI TestClient (no real I/O except fixture files already in `tests/fixtures/`).

### WI 4 — Update README test count

**File:** `README.md`

Two string replacements:

**4a.** Line 53 (`scripts/regression-test.mjs` description):
- Old: `regression-test.mjs     # Comprehensive regression suite (95 tests)`
- New: `regression-test.mjs     # Comprehensive regression suite (91 tests)`

**4b.** The stale "1,569 unit + 95 regression" claim does not appear in the README body (checked — the README Status section references "25 phases" but not the test count). The test count "95 tests" appears only in the `regression-test.mjs` descriptor at line 53.

**Verification:** `grep -n "1,569\|1569\|95 test\|regression" README.md` to confirm only one hit (line 53). Change only that line.

### WI 5 — Update `arch-review/intake.md` test count

**File:** `arch-review/intake.md`

**Line 15** (current): `1,569 unit + 95 regression tests passing`  
**Replace with:** `2,689 unit + 91 regression tests passing`

Also update the CI status line on the same line 15 — it references "sidecar-test" job as the only Python CI job. Append the two new job names:

**Before (part of line 15 or nearby CI section):** refer to `sidecar-test (pytest)` as the only Python job.  
**After:** reflect `sidecar-test`, `voice-pipecat-test`, and `file-ingestion-test` as three Python pytest CI jobs.

**Verification:** `grep -n "1,569\|pytest\|sidecar" arch-review/intake.md` before and after to confirm all references updated.

---

## Acceptance Criteria

- [ ] `packages/voice-pipecat/tests/requirements.txt` exists; does not contain `pipecat-ai`
- [ ] `voice-pipecat-test` job present in `.github/workflows/ci.yml`; `working-directory: packages/voice-pipecat`; installs from `tests/requirements.txt`
- [ ] `file-ingestion-test` job present in `.github/workflows/ci.yml`; `working-directory: packages/file-ingestion`; installs from `packages/file-ingestion/requirements.txt`
- [ ] Both new jobs run without `continue-on-error` (no external network deps)
- [ ] `YAML syntax valid`: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` exits 0
- [ ] `README.md` no longer contains "95 tests" in the regression-test.mjs descriptor
- [ ] `arch-review/intake.md` line 15 shows `2,689 unit + 91 regression tests passing`
- [ ] No TS packages modified; `pnpm -r test` not required (zero application code touched)

---

## Commit Plan

| Commit | Content | Message |
|---|---|---|
| 1 | `packages/voice-pipecat/tests/requirements.txt` (new) | `feat(phase-P10b)/1.1: voice-pipecat test requirements.txt (no pipecat-ai)` |
| 2 | `.github/workflows/ci.yml` — both new jobs | `feat(phase-P10b)/1.2: voice-pipecat-test + file-ingestion-test CI jobs` |
| 3 | `README.md` + `arch-review/intake.md` | `docs(phase-P10b)/1.3: update test counts (2,689 unit + 91 regression)` |

---

## Rollback Plan

All changes are confined to CI configuration and documentation — zero application code, zero schema migrations, zero Docker changes.

- Remove the two new jobs from `.github/workflows/ci.yml`: one-line `git revert` or manual delete.
- Revert README and intake counts: one `git revert`.
- No homeserver deploy required. No operator approval gate.

---

## Notes for Implementer

1. **Voice-pipecat asyncio:** `pyproject.toml` already sets `asyncio_mode = "auto"` — do not add `@pytest.mark.asyncio` or `asyncio_mode` flags to the CI command line.

2. **File-ingestion working directory is critical.** The `conftest.py` at `packages/file-ingestion/tests/conftest.py` imports `from src.extract import app`. If pytest runs from repo root, `src` won't resolve. Both `pip install` and `pytest` steps must have `working-directory: packages/file-ingestion`.

3. **Do not install from `pyproject.toml` for voice-pipecat.** `pip install -e ".[dev]"` would resolve pipecat-ai as a main dependency and pull silero (PyTorch). Always install from `tests/requirements.txt`.

4. **YAML validation step is cheap.** After editing `ci.yml`, run `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` locally before push. Caught a misindented block in P10a (WI 4 history).

5. **Three Python CI jobs post-merge:** `sidecar-test` (13 tests), `voice-pipecat-test` (54 tests), `file-ingestion-test` (26 tests) = 93 Python tests total. Update any future test-count summary with this breakdown.
