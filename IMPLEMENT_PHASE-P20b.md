# Implementation Plan: P20b — Lab Report Trend Analysis + Historical Comparison

**Phase:** P20b
**GitHub Issue:** #67 (subset — synthesis layer)
**Branch slug:** `feat/phase-P20b-lab-report-synthesis`
**Depends on:** P20a (merged — `lab_results` table populated, `scripts/lab-report-extract.py` operational)
**Wave:** 4 (Arc 3 Batch Source Pipelines)
**Effort estimate:** 1–1.5 days

---

## Scope Verification (Gate 1)

### P20a deliverables confirmed present

| Deliverable | Status |
|---|---|
| `scripts/lab-report-extract.py` | Exists — 631 lines, fully functional T0 extractor |
| `packages/shared/drizzle/0028_lab_results.sql` | Exists — table created with correct schema |
| `lab_results` columns available to synthesis | `report_id`, `collection_date`, `test_name`, `raw_value`, `numeric_value`, `units`, `ref_low`, `ref_high`, `derived_flag`, `extracted_at`, `ordering_provider`, `source_file` |

### Schema notes (exact column names from migration 0028)

```sql
lab_results (
  report_id TEXT, collection_date DATE, test_name TEXT,
  raw_value TEXT, numeric_value FLOAT, units TEXT,
  ref_range_text TEXT, ref_low FLOAT, ref_high FLOAT, ref_comparator TEXT,
  lab_flag TEXT, derived_flag TEXT,          -- 'HIGH' | 'LOW' | 'ABNORMAL' | 'NORMAL'
  extracted_at TIMESTAMPTZ,
  ordering_provider TEXT, source_file TEXT, layout TEXT
)
-- UNIQUE (report_id, test_name)
-- INDEX on collection_date DESC, report_id, test_name
```

### No scope drift from PHASED_PLAN.md card

The card says:
- `scripts/lab-report-synthesis.py`: pulls latest + prior N reports; T2 CLI synthesizes trend analysis
- Capture records: current state, notable changes, reference-range trajectory
- Optional: alert on specific values breaching custom thresholds

All of this is buildable against the actual schema. No invalidated assumptions.

---

## Cost-Tier Compliance

Per CLAUDE.md cost-tier rules:

| Step | Tier | Rationale |
|---|---|---|
| Query `lab_results` table | T0 Python | Deterministic DB read |
| Format trend data into prompt | T0 Python | String manipulation |
| Trend/comparison synthesis | **T2 Claude CLI** (`claude --print`) | Batch/async, no human waiting |
| POST capture to core-api | T0 Python HTTP | Simple REST call |

T3 API must NOT be used. The financial-pipeline.py `subprocess.run(["claude", "--print", "-p", prompt])` pattern is the canonical T2 invocation used here.

---

## Work Items

### 1.1 — Core synthesis script `scripts/lab-report-synthesis.py`

**File:** `scripts/lab-report-synthesis.py` (new)

**Logic:**

1. **Query** `lab_results` grouped by `report_id` + `collection_date`, ordered by `collection_date DESC`. Default: all stored reports; `--last N` limits to most-recent N reports (default: 5).
2. **Build trend table (T0):** For each test name that appears in multiple reports, compute:
   - Most recent value + flag
   - Prior values + flags (chronological list)
   - Direction: IMPROVING / WORSENING / STABLE / VARIABLE (deterministic rule: last two values trending toward normal range = IMPROVING, away = WORSENING, same = STABLE, alternating = VARIABLE)
   - Is current value abnormal? (derived_flag IN ('HIGH', 'LOW', 'ABNORMAL'))
3. **Filter for anomalies:** Collect test rows where `derived_flag != 'NORMAL'` or direction == 'WORSENING'.
4. **Build CLI prompt:** Structured prompt with:
   - Summary table of all tests with values across reports (bounded to 4000 chars before truncation)
   - Flagged anomalies section
   - Instruction for T2: summarize current state, note changes since last report, identify values trending toward or away from reference range
5. **Call `claude --print`** via `subprocess.run(["claude", "--print", "-p", prompt], timeout=120)`.
6. **POST capture** to `POST /api/v1/captures` with:
   - `content`: synthesis text + raw trend table appended
   - `source`: `"api"`
   - `type`: `"observation"`
   - `brain_view`: `"personal"`
   - `source_metadata`: `{ type: "lab_trend_analysis", report_count: N, flagged_tests: [...], collection_dates: [...], has_synthesis: bool }`
7. **Custom threshold alerts (optional):** If `config/lab-report.yaml` contains `alert_thresholds` keys, check each current value against operator-defined bounds (e.g., `HbA1c: { high: 5.7 }`). Log warnings; include in capture metadata.

**CLI interface:**

```
python scripts/lab-report-synthesis.py
  [--last N]            # how many most-recent reports to include (default: 5)
  [--dry-run]           # print JSON to stdout, no capture POST
  [--config PATH]       # override config/lab-report.yaml
  [--no-synthesis]      # skip claude --print, post raw data table only
  [--report-id ID]      # synthesize a single specific report vs all prior
```

**Config additions to `config/lab-report.yaml`:**

```yaml
synthesis:
  default_report_window: 5       # how many reports back to compare
  max_prompt_chars: 4000         # truncation ceiling for CLI prompt
  captures_url: ""               # CAPTURES_URL or read from env

alert_thresholds: {}             # e.g.  HbA1c: { high: 5.7 }
```

**Memory:** All DB queries use `fetchall()` on bounded result sets (query only test rows from the N most-recent `report_id` values — not the entire table). Single `db.close()` in finally block.

### 1.2 — Trend computation unit tests `scripts/tests/test_lab_synthesis.py`

**File:** `scripts/tests/test_lab_synthesis.py` (new)

Test cases (no DB required — test the pure-Python logic only):

1. `test_trend_direction_improving` — values moving toward reference range = IMPROVING
2. `test_trend_direction_worsening` — values moving away from reference range = WORSENING
3. `test_trend_direction_stable` — same value repeated = STABLE
4. `test_trend_direction_variable` — alternating HIGH/NORMAL = VARIABLE
5. `test_single_report_no_trend` — only one report in DB → trend table has direction=None; synthesis still runs
6. `test_flag_override_abnormal` — lab_flag='A' with no numeric bounds → appears in flagged section
7. `test_prompt_truncation` — very large dataset truncates at max_prompt_chars without error
8. `test_custom_threshold_alert` — config alert_threshold breached → appears in metadata flagged_tests
9. `test_dry_run_no_post` — `--dry-run` flag produces JSON output, no HTTP calls made

All tests use fixture dicts (no pdfplumber, no psycopg2 calls).

### 1.3 — Config file additions `config/lab-report.yaml`

Add `synthesis` section and `alert_thresholds` skeleton (empty dict) to the config. If the file does not yet exist (P20a created it), create it with both `extraction` and `synthesis` top-level keys.

Check: `config/lab-report.yaml` existence.

### 1.4 — `scripts/requirements-lab.txt` verification

Confirm `psycopg2-binary` and `pdfplumber` are listed (P20a dependency). No new Python dependencies for P20b (stdlib `subprocess`, `json`, `logging`; psycopg2 for DB reads already listed).

---

## Acceptance Criteria

| # | Criterion | Verification |
|---|---|---|
| AC-1 | `scripts/lab-report-synthesis.py --dry-run` runs against fixture `lab_results` data and prints valid JSON with keys `report_count`, `flagged_tests`, `trend_table`, `synthesis_text` | Manual + unit test |
| AC-2 | Direction computation correct for all 4 cases (IMPROVING/WORSENING/STABLE/VARIABLE) | Unit test 1.2 cases 1–4 |
| AC-3 | Single-report run produces valid output (no crash on zero prior comparisons) | Unit test 1.2 case 5 |
| AC-4 | `--dry-run` makes no HTTP calls | Unit test 1.2 case 9 |
| AC-5 | T2 Claude CLI (`claude --print`) is used for synthesis; no direct Anthropic SDK import anywhere in the script | `grep -n "import anthropic" scripts/lab-report-synthesis.py` returns 0 |
| AC-6 | Memory: script never loads all `lab_results` rows at once — query is bounded by `report_id IN (SELECT ... LIMIT N)` | Code review + comment in script |
| AC-7 | POST capture uses `source: 'api'` (valid `CaptureSource` per CLAUDE.md — `'api'` is in the 9-value canonical set) | Code review |
| AC-8 | Custom threshold alert from `lab-report.yaml` appears in capture metadata `flagged_tests` | Unit test 1.2 case 8 |
| AC-9 | All 9 unit tests pass: `python -m pytest scripts/tests/test_lab_synthesis.py -v` | CI (python-lint job or equivalent) |

---

## Explicit Deliverables

1. `scripts/lab-report-synthesis.py` — new file, T2 CLI synthesis script
2. `scripts/tests/test_lab_synthesis.py` — new file, 9 unit tests
3. `config/lab-report.yaml` — updated with `synthesis` section + `alert_thresholds` skeleton
4. `scripts/requirements-lab.txt` — verified (no new deps needed; add psycopg2-binary if missing)

---

## Files NOT Changed

- `scripts/lab-report-extract.py` — P20a deliverable; P20b only reads its output table
- `packages/shared/drizzle/0028_lab_results.sql` — no schema change
- Any TypeScript packages — `lab_results` is Python-only per migration comment

---

## Rollback Plan

- Delete `scripts/lab-report-synthesis.py` and `scripts/tests/test_lab_synthesis.py`
- Revert `config/lab-report.yaml` to pre-P20b state
- No DB migrations involved — rollback is a simple `git revert`
- Any captures already POSTed to the system remain (they are valid observations); no cleanup required unless explicitly requested

---

## Homeserver Deploy

**Migration required:** No (migration 0028 was P20a's deliverable; P20b adds no new migrations).

**Operator action after merge:** Copy updated `config/lab-report.yaml` to homeserver deploy path. Run `python scripts/lab-report-synthesis.py --dry-run` to verify end-to-end connectivity before first live run.

**Gate 5.5 triggered:** No (no migration, no compose changes).

---

## LAB_NOTEBOOK Pre-Action Entry (Gate 3 prerequisite)

Before first commit in Gate 3, the `implement-executor` MUST write a LAB_NOTEBOOK entry with:
- **Objective:** P20b synthesis script + tests
- **Hypothesis:** Script queries `lab_results`, computes T0 trend directions, calls `claude --print` for narrative synthesis, POSTs one capture per run. All 9 tests green.
- **Rollback plan:** `git revert` the PR; no DB state changes.

---

## Operator-Approval Matrix

P20b does NOT match any Gate 5 operator-approval trigger:
- Not labeled critical
- Does not edit CLAUDE.md / PRD / TDD
- No homeserver migration
- No change to `captures` or `embeddings` tables

**Auto-merge eligible** after Gate 4 APPROVE + CI green.
