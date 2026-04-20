# IMPLEMENT_PHASE-P20a — Doctor Lab Reports: Structured Data Extraction

**Phase:** P20a  
**Source issue:** #67 (subset — extraction half)  
**Wave:** 4 (Arc 3 Batch Source Pipelines)  
**Generated:** 2026-04-19  
**Prereqs:** None. P20b (synthesis) depends on this phase.

---

## Scope Diff vs. PHASED_PLAN.md Card

| Item | Card says | Reality | Action |
|------|-----------|---------|--------|
| Table name | `lab_results` | Does not exist yet (last migration is 0027) | Create as migration 0028 |
| Next migration slot | Not specified | 0028 (0027 = `search_hnsw_ef_search`) | Use 0028 |
| PDF libraries | Not specified | Neither `pdfplumber` nor `pymupdf` is in any requirements file | Add to `scripts/requirements-lab.txt` (new, scoped) |
| Layout detection | Quest / LabCorp / hospital-specific | These are the canonical three; add `generic` fallback | Confirmed scope — implement 3 named + 1 fallback |
| Ingest-routes.yaml | Not mentioned in card | Must add `medical` source-type route(s) or route via standalone CLI | Design decision: standalone CLI only (no trigger-server wiring yet — P20b's synthesis decides whether to integrate) |
| `scripts/` peer pattern | `financial-pipeline.py` (3035 LOC), `utility-pipeline.py` | Both use `lib/capture_api.py` and `lib/ingest_router.py` | Follow same structure — no god-module anti-pattern |
| Capture posting | Not mentioned in card | P20b does the synthesis → capture. P20a stores ONLY to `lab_results` table + emits JSON; no capture POST | Confirmed: P20a is pure extract → DB. P20b does capture POST. |
| Brain view | Not specified | `personal` (health data, single user) | Use `personal` |

**No scope drift that requires operator approval.** Deliverables are self-consistent and bounded.

---

## Cost-Tier Compliance

Per CLAUDE.md mandatory cost-tier checklist:

| Step | Tier | Rationale |
|------|------|-----------|
| PDF text extraction | T0 (Python `pdfplumber`) | Deterministic; no LLM needed |
| Layout detection (Quest/LabCorp/hospital/generic) | T0 (rule-based: header/footer regex fingerprinting) | Quest/LabCorp have stable header patterns |
| Row parsing (test name, value, units, ref range, flag) | T0 (regex + column-position heuristics) | Structured grid; no LLM needed |
| Out-of-range flagging | T0 (compare value to ref range bounds) | Pure arithmetic |
| LLM involvement | None in P20a | Aggregation + synthesis is P20b's job |

No LLM calls in this phase. T0 throughout.

---

## Architecture Decisions

**1. Standalone CLI, not trigger-server-wired (yet)**  
The ingest trigger-server is designed for files dropped in an inbox by OneDrive rclone sync. Lab PDFs arrive irregularly (after a doctor visit) and will be manually placed. P20a exposes a direct CLI: `python scripts/lab-report-extract.py --file <path>`. P20b can later wrap this via trigger-server if the operator wants auto-processing. Keeps P20a self-contained.

**2. `lab_results` table in Postgres, not SQLite**  
Financial and utility pipelines use SQLite for local state to avoid network dependency. Lab results are different: they are permanent personal health records that P20b queries, they need to participate in trend analysis across reports, and there is no caching concern. Store in Postgres (`lab_results` table) with a Drizzle migration and schema entry.

**3. Layout detection strategy**  
- Quest: page header contains "Quest Diagnostics" OR "QUEST" within first 200 chars of first page
- LabCorp: header contains "Laboratory Corporation" OR "LabCorp"  
- Hospital-specific: detect by institution name lookup (configurable list in YAML)
- Generic: table-structure scan — find rows matching `<text>\s+<number>\s+<unit>\s+<range>` pattern

**4. Reference range parsing**  
Most labs format ranges as `1.00-2.50` or `<10.0` or `>3.5` or `Negative`. Parser normalizes all to `{low: float|null, high: float|null, comparator: '<'|'>'|null, text: str}`.

**5. Python library choice: `pdfplumber` over `PyMuPDF`**  
`pdfplumber` is pure-Python, MIT-licensed, better at table extraction (it exposes bounding-box-aware word clusters), no C extension dependency. `PyMuPDF` (fitz) is AGPL — not appropriate here. `pdfplumber` is the standard for medical PDF parsing in the Python ecosystem.

---

## Deliverables

### 1.1 — New script: `scripts/lab-report-extract.py`

**Purpose:** CLI-driven PDF → structured `lab_results` rows

**CLI interface:**
```
python scripts/lab-report-extract.py --file <path.pdf>           # extract + upsert
python scripts/lab-report-extract.py --file <path.pdf> --dry-run  # print JSON, no DB write
python scripts/lab-report-extract.py --list                        # show all stored reports
python scripts/lab-report-extract.py --status                      # DB row counts + last run
```

**Extraction pipeline (per file):**
1. Open PDF with `pdfplumber`; stream page by page (never load all pages into memory at once)
2. Detect layout: Quest / LabCorp / hospital / generic
3. Extract report metadata: patient name (optional, single-user so informational), collection date, ordering provider, lab accession number
4. Extract result rows: test name, value (raw string), numeric value (float or null), units, reference range string, parsed low/high bounds, abnormal flag (H/L/A/C/blank)
5. Batch-upsert to `lab_results` via `scripts/lib/db.py` (new shared module — see 1.3)
6. Emit JSON summary to stdout (for P20b orchestration + test assertions)

**Out-of-range flagging logic:**
- If PDF already provides an H/L/A flag → preserve it
- Additionally compute `derived_flag`: compare `numeric_value` to parsed `ref_low`/`ref_high` if both present
- Store both `lab_flag` (raw from PDF) and `derived_flag` (computed) — they occasionally disagree on borderline values

### 1.2 — Migration: `packages/shared/drizzle/0028_lab_results.sql`

```sql
CREATE TABLE IF NOT EXISTS lab_results (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id       text NOT NULL,         -- hash of (collection_date + lab_accession OR file SHA-256)
  source_file     text NOT NULL,         -- original filename (not full path)
  layout          text NOT NULL,         -- 'quest' | 'labcorp' | 'hospital' | 'generic'
  collection_date date NOT NULL,
  ordering_provider text,
  test_name       text NOT NULL,
  test_code       text,                  -- LOINC or lab-specific code when available
  raw_value       text NOT NULL,         -- exactly as printed
  numeric_value   float,
  units           text,
  ref_range_text  text,                  -- raw range string: "1.00-2.50" or "<10.0"
  ref_low         float,
  ref_high        float,
  ref_comparator  text,                  -- '<' | '>' | null
  lab_flag        text,                  -- raw flag from PDF: 'H' | 'L' | 'A' | 'C' | null
  derived_flag    text,                  -- computed: 'HIGH' | 'LOW' | 'ABNORMAL' | 'NORMAL' | null
  extracted_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (report_id, test_name)          -- idempotent re-extract
);

CREATE INDEX idx_lab_results_collection_date ON lab_results (collection_date DESC);
CREATE INDEX idx_lab_results_report_id ON lab_results (report_id);
CREATE INDEX idx_lab_results_test_name ON lab_results (test_name);
```

Note: No Drizzle schema entry required for this table — it is Python-accessed only (P20a/P20b). The migration creates the table; Python uses raw SQL via `psycopg2`. Keeps the Drizzle schema clean of health tables that TypeScript never queries.

### 1.3 — New shared module: `scripts/lib/db.py`

**Purpose:** Lightweight Postgres connection helper for Python scripts that need direct DB access (not via core-api HTTP). Lab results and future batch pipelines that write structured data belong in Postgres, not SQLite.

```python
# Pattern: env-var driven, connection pooling via psycopg2 connection string
# Env: DATABASE_URL (postgres://openbrain:...) 
# Fallback: reads from config/pipeline.yaml db.url field
# Exposes: get_connection() → psycopg2.connection, execute_upsert(conn, sql, rows)
```

Memory contract: never holds more than one page of rows in memory at a time. Uses `executemany()` with parameterized queries for batch upserts.

### 1.4 — Config: `config/lab-report.yaml`

```yaml
# Hospital institution name patterns for layout detection (case-insensitive partial match)
hospital_names:
  - "Piedmont"
  - "Emory"
  - "Northside"
  - "Atrium"
  - "Greenville Health"
  - "Prisma Health"

# Per-test custom thresholds (overrides PDF reference ranges for tests where
# Troy's physician has set custom targets, e.g., lipid panel)
custom_thresholds:
  # example:
  # LDL Cholesterol: { high: 100 }

# Collection date formats to try (pdfplumber returns raw text strings)
date_formats:
  - "%m/%d/%Y"
  - "%m/%d/%y"
  - "%Y-%m-%d"
  - "%B %d, %Y"
```

### 1.5 — Requirements: `scripts/requirements-lab.txt`

```
pdfplumber>=0.11
psycopg2-binary>=2.9
pyyaml>=6.0
```

Scoped per-script file rather than adding to global requirements — keeps sidecar image lean.

### 1.6 — Unit tests: `scripts/tests/test_lab_report_extract.py`

Test fixtures: 3 minimal synthetic PDFs (one per layout: Quest, LabCorp, generic). Using `pdfplumber` in tests requires real PDF bytes or a mock. Strategy: create minimal test PDFs using `reportlab` OR use fixture text-extraction stubs (mock `pdfplumber.open()` to return pre-baked page objects with known word lists).

**Test cases:**
- `test_detect_layout_quest`: header keyword → `'quest'`
- `test_detect_layout_labcorp`: header keyword → `'labcorp'`
- `test_detect_layout_generic_fallback`: no known header → `'generic'`
- `test_parse_result_row_normal`: `Glucose 95 mg/dL 70-99` → row with derived_flag `NORMAL`
- `test_parse_result_row_high`: `LDL Cholesterol 145 mg/dL 0-99 H` → lab_flag `H`, derived_flag `HIGH`
- `test_parse_result_row_range_lt`: `TSH 0.8 mIU/L <4.50` → ref_low=None, ref_high=4.50, ref_comparator `<`
- `test_parse_result_row_non_numeric`: `ABO Type A Positive` → numeric_value=None, units=None
- `test_report_id_stable`: same file extracted twice → same report_id (deterministic hash)
- `test_dry_run_no_db`: `--dry-run` emits JSON stdout, makes zero DB writes
- `test_upsert_idempotent`: extract same report twice → row count unchanged (UNIQUE on report_id + test_name)

---

## Acceptance Criteria

- [ ] **AC-1:** `python scripts/lab-report-extract.py --file <fixture.pdf> --dry-run` emits valid JSON with at least one result row (test with included fixture)
- [ ] **AC-2:** Re-running extract on the same PDF produces zero duplicate rows in `lab_results` (UNIQUE constraint + ON CONFLICT DO NOTHING)
- [ ] **AC-3:** Out-of-range rows have non-null `derived_flag` matching the PDF's `lab_flag` for all H/L cases in the fixture set
- [ ] **AC-4:** `python -m pytest scripts/tests/test_lab_report_extract.py` passes (10 cases, zero failures)
- [ ] **AC-5:** Migration 0028 applies cleanly from scratch: `psql < packages/shared/drizzle/0028_lab_results.sql` succeeds; `\d lab_results` shows all columns + 3 indexes
- [ ] **AC-6:** Script stays within memory ceiling: `pdfplumber` processes pages one at a time; no page-list materialization in memory

---

## Work Items (implementation sequence)

```
1.1  scripts/lib/db.py                                     ~1 h
1.2  packages/shared/drizzle/0028_lab_results.sql          ~0.5 h
1.3  scripts/requirements-lab.txt                          ~0.1 h
1.4  config/lab-report.yaml                                ~0.3 h
1.5  scripts/lab-report-extract.py (core extractor)        ~3 h
1.6  scripts/tests/test_lab_report_extract.py              ~1.5 h
1.7  LAB_NOTEBOOK entry (pre-action + post-action)         (per-commit)
```

**Total estimated effort:** ~1.5 days (matches card estimate)

---

## Pre-flight Checks (before first commit)

1. Confirm migration slot 0028 is free:
   ```bash
   ls packages/shared/drizzle/0028*.sql 2>/dev/null && echo CONFLICT || echo SLOT_FREE
   ```

2. Confirm no existing `lab_results` table on homeserver (should return "did not exist"):
   ```bash
   # On homeserver — operator runs:
   docker exec open-brain-postgres psql -U openbrain -d open_brain -c "\dt lab_results"
   ```

No homeserver deploy required until operator is ready to apply the migration. P20a's Python script can run against the VM or locally; it just needs `DATABASE_URL` pointing to the Postgres instance.

---

## Rollback Plan

- **Script:** Delete `scripts/lab-report-extract.py`. No service dependency.
- **Migration 0028:** `DROP TABLE IF EXISTS lab_results;` — table is additive, no FK constraints from other tables.
- **Config:** Delete `config/lab-report.yaml`. Not loaded by any running service.
- **`scripts/lib/db.py`:** Delete. Only imported by lab-report-extract.py.
- **No application code touched.** No Docker restart required. No impact on running containers.

---

## Dependencies

| Item | Status |
|------|--------|
| P20b (synthesis + capture post) | Unblocked after this PR merges |
| Any prior phase | None — fully independent |
| DB migration slot 0028 | Free (last applied is 0027) |
| `pdfplumber` library | Not yet in any requirements file — must add |
| `psycopg2-binary` | Not yet in scripts requirements — must add |

---

## Files to Create / Modify

| File | Action |
|------|--------|
| `scripts/lab-report-extract.py` | Create |
| `scripts/lib/db.py` | Create |
| `scripts/requirements-lab.txt` | Create |
| `scripts/tests/test_lab_report_extract.py` | Create |
| `packages/shared/drizzle/0028_lab_results.sql` | Create |
| `config/lab-report.yaml` | Create |

No existing files modified. Purely additive.

---

## Gate 5 — Operator Approval Assessment

Per ORCHESTRATOR.md approval matrix:
- Not critical severity: no
- Edits CLAUDE.md / PRD / TDD: no
- Touches homeserver / applies migrations: YES (migration 0028) — **requires operator approval at Gate 5**

Gate 5.5 homeserver commands (pre-apply audit + migration apply + verify):
```bash
# Pre-flight (no table should exist yet)
docker exec open-brain-postgres psql -U openbrain -d open_brain -c "\dt lab_results"

# Apply migration
docker exec -i open-brain-postgres psql -U openbrain -d open_brain < packages/shared/drizzle/0028_lab_results.sql

# Verify
docker exec open-brain-postgres psql -U openbrain -d open_brain -c "\d lab_results"
docker exec open-brain-postgres psql -U openbrain -d open_brain -c "\di lab_results*"
```

No container restart required — no application code changed.
