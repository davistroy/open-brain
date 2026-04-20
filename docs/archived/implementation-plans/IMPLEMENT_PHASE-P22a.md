# IMPLEMENT_PHASE-P22a.md — Insurance Policy PDF Extraction + Coverage Matrix

**Phase:** P22a
**GH Issue:** #68 (subset — extraction only; P22b handles gap analysis)
**Wave:** 4 (Arc 3 Batch Source Pipelines)
**PHASED_PLAN dependencies:** None (independent; P22b depends on this)
**Effort estimate:** ~2 days

---

## Scope Diff (card vs. current state)

| Card item | Current state | Action |
|-----------|---------------|--------|
| `scripts/insurance-policy-extract.py` — does not exist | No insurance/policy scripts anywhere in `scripts/` | **CREATE** |
| Handles health, auto, home, umbrella | No policy-type handling exists | **IN SCOPE** |
| New `insurance_policies` table (migration) | Latest migration is `0027_search_hnsw_ef_search.sql`; next is `0028` | **CREATE 0028** |
| `coverage JSONB` column | Schema defines JSONB pattern elsewhere (`app_settings.value JSONB`); same approach | **IN SCOPE** |
| Structured extraction validated against known-good fixture | No prior fixture; create synthetic fixtures for 3 policy types | **IN SCOPE** |
| `scripts/lib/capture_api.py` | EXISTS at `scripts/lib/capture_api.py` — used by financial-pipeline, utility-pipeline | **REUSE** |

**No scope drift.** Card assumptions are clean against the codebase. The only concrete adjustment: next migration number is `0028` (not unspecified in card).

**Cost-tier note:** PDF parsing is T0 (Python/pdfplumber, no LLM). Extraction is pure rule-based with regex for dollar amounts, percentages, date ranges, and keyword-section matching. Zero API calls in P22a. LLM synthesis is P22b scope only.

---

## Work Items

### W1 — Drizzle migration 0028: `insurance_policies` table

**What:** Create the storage table for extracted policy coverage data. Follows the same JSONB pattern as `app_settings` and `skills_log.result`.

**Schema design:**

```sql
CREATE TABLE insurance_policies (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_number TEXT,
  provider      TEXT        NOT NULL,
  policy_type   TEXT        NOT NULL,   -- health | auto | home | umbrella
  effective_date DATE,
  expiration_date DATE,
  insured_name  TEXT,
  coverage      JSONB       NOT NULL,   -- structured coverage tree (see below)
  raw_text      TEXT,                   -- full extracted PDF text (searchable)
  source_file   TEXT,                   -- original filename for traceability
  extracted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX insurance_policies_policy_type_idx ON insurance_policies (policy_type);
CREATE INDEX insurance_policies_provider_idx ON insurance_policies (provider);
CREATE INDEX insurance_policies_effective_date_idx ON insurance_policies (effective_date);
```

**`coverage` JSONB shape** (flexible per policy type — enforced in application layer, not DB CHECK):

```jsonc
{
  "deductibles": [
    { "category": "individual", "amount_usd": 1500, "applies_to": "medical" }
  ],
  "out_of_pocket_max": [
    { "category": "individual", "amount_usd": 5000 }
  ],
  "limits": [
    { "category": "liability", "amount_usd": 100000, "per": "occurrence" }
  ],
  "co_insurance": { "percentage": 80, "after_deductible": true },
  "co_pays": [
    { "service": "primary_care_visit", "amount_usd": 25 }
  ],
  "exclusions": ["cosmetic surgery", "experimental treatments"],
  "coverage_types": ["hospitalization", "emergency", "preventive"],
  "notes": []
}
```

**Files touched:**
- `packages/shared/drizzle/0028_insurance_policies.sql` (NEW)
- `packages/shared/src/schema/supporting.ts` — add `insurancePolicies` Drizzle table definition (follows existing pattern in `supporting.ts` for non-core tables like `admin_audit`, `entity_links`)
- `packages/shared/src/schema/index.ts` — export `insurancePolicies`
- `scripts/init-schema.sql` — regenerate after migration (Gate 3 implementer runs `pnpm --filter @open-brain/shared generate` or manually appends)

**Migration file location:** `packages/shared/drizzle/0028_insurance_policies.sql`

**Acceptance criteria:**
- [ ] Migration applies clean against current schema (`psql < 0028_insurance_policies.sql` on homeserver after schema prep)
- [ ] `SELECT * FROM insurance_policies LIMIT 1` works (empty, no error)
- [ ] Drizzle type in `supporting.ts` compiles (`tsc --noEmit` on shared passes)

---

### W2 — `scripts/insurance-policy-extract.py`: core extraction engine

**What:** Python T0 script that reads insurance policy PDFs and writes structured `coverage` JSONB to the `insurance_policies` table via direct Postgres connection (not via the captures API — structured data deserves its own table, not a blob capture).

**Architecture decision:** Direct psycopg2 INSERT (same pattern used by `financial-pipeline.py` for its SQLite writes), reading `OPEN_BRAIN_DATABASE_URL` from environment (already set in `.env.secrets` on the VM).

**Tooling:**
- `pdfplumber` — primary PDF text extraction (handles multi-column layouts better than PyPDF2 for insurance documents)
- `re` (stdlib) — all extraction patterns
- `psycopg2` — direct Postgres write
- `json` (stdlib) — coverage JSONB serialization

**Policy type detection** (T0 keyword matching, no LLM):

| Signal | Policy type |
|--------|-------------|
| "health insurance", "medical benefits", "prescription drug" | `health` |
| "auto insurance", "automobile", "vehicle", "collision", "comprehensive" | `auto` |
| "homeowners", "dwelling", "renters insurance", "property damage" | `home` |
| "umbrella", "excess liability", "umbrella liability" | `umbrella` |

**Extraction patterns by coverage element:**

| Element | Extraction approach |
|---------|-------------------|
| Deductibles | Regex `\$[\d,]+` near "deductible" within ±3 lines |
| OOP max | Regex near "out-of-pocket maximum", "out of pocket max" |
| Limits | Regex `\$[\d,]+\s*(per occurrence\|per accident\|aggregate)` |
| Co-insurance | Regex `(\d{1,3})%` near "coinsurance", "co-insurance" |
| Co-pays | Table/list detection: "copay", "co-pay" + dollar amount per service line |
| Effective date | ISO date or `MM/DD/YYYY` near "effective date", "policy period" |
| Expiration date | Same patterns near "expiration", "through", "to" in policy period |
| Provider name | First page header extraction (first 10 lines); fallback: `--provider` CLI arg |
| Policy number | Regex near "policy number", "policy #", "certificate number" |
| Exclusions | Section detection: "exclusions", "what is not covered" → bullet list extraction |

**CLI interface** (consistent with financial-pipeline.py pattern):

```
python insurance-policy-extract.py --file policy.pdf [--policy-type health] [--provider "Blue Cross"]
python insurance-policy-extract.py --dir ~/financial-inbox/insurance/  [--dry-run]
python insurance-policy-extract.py --status
python insurance-policy-extract.py --list
```

- `--file`: process single PDF
- `--dir`: process all PDFs in directory (skips files already in DB by `source_file` match)
- `--dry-run`: extract and print JSON without writing to DB
- `--policy-type`: override auto-detection
- `--provider`: override auto-detected provider name
- `--status`: show count of policies in DB
- `--list`: show all stored policies (id, provider, type, effective date)

**Files touched:**
- `scripts/insurance-policy-extract.py` (NEW)
- `scripts/requirements-insurance.txt` (NEW) — `pdfplumber>=0.11`, `psycopg2-binary>=2.9`

**Implementation notes:**
- Section parser works by splitting text into "sections" delimited by all-caps headings or numbered section headers (common insurance document pattern)
- Amounts extracted as integers (cents stripped, commas removed): `$1,500` → `1500`
- Multi-page PDFs: concatenate all page text before parsing (pdfplumber handles natively)
- Duplicate detection: before INSERT, check `source_file` uniqueness; `--file` re-run updates the existing row (UPSERT on `source_file`)
- Memory: pdfplumber streams pages; no full-doc in-memory accumulation for large PDFs
- Error handling: failed parse writes to stderr with page number; partial extraction stored with `notes` field indicating what failed

**Acceptance criteria:**
- [ ] Health policy fixture: deductibles, OOP max, co-pays, co-insurance extracted correctly
- [ ] Auto policy fixture: liability limits, collision/comprehensive deductibles, coverage types extracted
- [ ] Home policy fixture: dwelling limit, liability limit, deductible extracted
- [ ] `--dry-run` outputs valid JSON without DB writes
- [ ] Duplicate `source_file` → UPSERT (no duplicate rows)
- [ ] `pdfplumber` import works in VM Python environment

---

### W3 — Test fixtures and validation

**What:** Three synthetic fixture PDFs (or text representations) plus a validation test that runs extraction against them and asserts key field values. This is the "validated against known-good policy fixture" acceptance criterion from the card.

**Approach:** Rather than generating actual PDFs (complex), create text fixture files (`.txt`) that contain representative insurance policy text. The extractor is tested against these by using `pdfplumber` only when the input is `.pdf`; a `--text-fixture` mode (or a separate `_parse_text()` internal function) allows unit testing on plain text.

**Fixtures to create:**

| File | Content |
|------|---------|
| `scripts/test-fixtures/insurance/health-policy-fixture.txt` | BCBS-style health plan: individual deductible $1,500, family $3,000; OOP max individual $5,000; coinsurance 80/20; PCP copay $25; specialist $50; hospitalization $250; exclusions: cosmetic, experimental |
| `scripts/test-fixtures/insurance/auto-policy-fixture.txt` | Auto policy: liability $100K/$300K; collision deductible $500; comprehensive $250; uninsured motorist $100K; rental reimbursement $30/day |
| `scripts/test-fixtures/insurance/home-policy-fixture.txt` | Homeowners HO-3: dwelling $400K; personal property $150K; liability $300K; deductible $2,500; medical payments $5K per person |

**Validation script** (`scripts/test-insurance-extract.py`):

```python
# Runs extraction against text fixtures; asserts extracted values
# Usage: python scripts/test-insurance-extract.py
# Exit 0 = all assertions pass; Exit 1 = failure with diff
```

**Files touched:**
- `scripts/test-fixtures/insurance/health-policy-fixture.txt` (NEW)
- `scripts/test-fixtures/insurance/auto-policy-fixture.txt` (NEW)
- `scripts/test-fixtures/insurance/home-policy-fixture.txt` (NEW)
- `scripts/test-insurance-extract.py` (NEW)

**Acceptance criteria:**
- [ ] `python scripts/test-insurance-extract.py` exits 0
- [ ] Health fixture: `deductibles[0].amount_usd == 1500` and `co_pays[0].amount_usd == 25`
- [ ] Auto fixture: `limits[0].amount_usd == 100000`
- [ ] Home fixture: `limits[0].amount_usd == 400000` (dwelling)
- [ ] All three policy types detected correctly (no `--policy-type` override needed)

---

### W4 — `insurance_policies` API endpoint (read-only, for P22b)

**What:** A minimal `GET /api/v1/insurance-policies` endpoint on core-api so P22b's gap analysis script can query stored policies without direct DB access. P22a only needs the list endpoint; detail will come in P22b if needed.

**Why in P22a:** P22b's gap analysis needs this to be a stable contract. Better to define it now than have P22b require a schema-layer change.

**Route:** `packages/core-api/src/routes/insurance-policies.ts` (NEW)

```
GET /api/v1/insurance-policies
  Query params: policy_type (optional), active_only (boolean, default true — filters effective_date <= today <= expiration_date)
  Response: { policies: [{ id, provider, policy_type, effective_date, expiration_date, coverage, source_file, extracted_at }] }
```

**Files touched:**
- `packages/core-api/src/routes/insurance-policies.ts` (NEW)
- `packages/core-api/src/index.ts` — register new route under `/api/v1/insurance-policies`

**Implementation notes:**
- No auth middleware (single-user system, consistent with all other routes)
- `active_only=true` default: `WHERE effective_date <= CURRENT_DATE AND (expiration_date IS NULL OR expiration_date >= CURRENT_DATE)`
- Returns full `coverage` JSONB blob — no field selection needed (small payload per policy)
- Uses Drizzle `db.select().from(insurancePolicies).where(...)` pattern
- No pagination needed (policy count is small — dozen at most)

**Acceptance criteria:**
- [ ] `GET /api/v1/insurance-policies` returns 200 with `{ policies: [] }` on empty table
- [ ] `?active_only=false` returns all rows regardless of dates
- [ ] Route registered and accessible
- [ ] `tsc --noEmit` on core-api clean

---

## Execution Order

```
W1 (migration + Drizzle schema)
  ↓
W4 (API endpoint — needs table to exist)     W2 (extraction script — needs table)
  ↓                                               ↓
W3 (test fixtures — validates W2 extraction logic)
```

W1 must land first (both W2 and W4 depend on the table). W2 and W4 are independent of each other and can be written in parallel. W3 tests W2's extraction logic.

---

## Pre-implementation verifications (Gate 3 implementer must perform)

1. **Next migration number:** `ls packages/shared/drizzle/ | grep -E '^[0-9]' | sort | tail -1` — confirm `0027_search_hnsw_ef_search.sql` is current last; use `0028`.

2. **`supporting.ts` table pattern:** Read `packages/shared/src/schema/supporting.ts` lines 1-50 to confirm table definition syntax before writing `insurancePolicies`. Do NOT use `core.ts` pattern (that's for captures/entities).

3. **`index.ts` exports:** `grep -n "export" packages/shared/src/schema/index.ts` — confirm the export pattern for adding `insurancePolicies`.

4. **core-api route registration:** `grep -n "import.*routes" packages/core-api/src/index.ts` — confirm how existing routes are registered (Hono `.route()` pattern).

5. **pdfplumber availability on VM:** SSH to `open-brain-vm` and run `pip show pdfplumber` — if missing, note that `pip install pdfplumber` is a pre-deploy step. If not available, `PyPDF2` is the fallback (less accurate for multi-column layouts).

6. **`OPEN_BRAIN_DATABASE_URL` on VM:** Confirm the env var name matches what financial-pipeline.py uses for Postgres. Check `scripts/financial-pipeline.py` — it uses SQLite internally, not the main DB. Verify actual Postgres connection env var used by other scripts (`grep -r "DATABASE_URL\|POSTGRES" scripts/`).

---

## Deliverables checklist

| File | Change | Work item |
|------|--------|-----------|
| `packages/shared/drizzle/0028_insurance_policies.sql` | NEW migration | W1 |
| `packages/shared/src/schema/supporting.ts` | Add `insurancePolicies` table definition | W1 |
| `packages/shared/src/schema/index.ts` | Export `insurancePolicies` | W1 |
| `scripts/init-schema.sql` | Append 0028 migration content (keep in sync) | W1 |
| `scripts/insurance-policy-extract.py` | NEW extraction script | W2 |
| `scripts/requirements-insurance.txt` | NEW: pdfplumber + psycopg2-binary | W2 |
| `packages/core-api/src/routes/insurance-policies.ts` | NEW GET endpoint | W4 |
| `packages/core-api/src/index.ts` | Register new route | W4 |
| `scripts/test-fixtures/insurance/health-policy-fixture.txt` | NEW fixture | W3 |
| `scripts/test-fixtures/insurance/auto-policy-fixture.txt` | NEW fixture | W3 |
| `scripts/test-fixtures/insurance/home-policy-fixture.txt` | NEW fixture | W3 |
| `scripts/test-insurance-extract.py` | NEW validation test | W3 |

---

## LAB_NOTEBOOK requirement

Before first commit: add entry with:
- **Objective:** Insurance policy PDF extraction — T0 Python rule-based extraction into `insurance_policies` table; API endpoint for P22b
- **Hypothesis:** pdfplumber + regex patterns sufficient for structured extraction from standard insurance policy PDFs; no LLM required; test fixtures confirm extraction correctness
- **Rollback:** `git revert` PR; `DROP TABLE insurance_policies` on homeserver (migration 0028 rollback)

---

## Rollback plan

- **Code:** `git revert` the PR.
- **Schema:** Migration 0028 adds a standalone table with no foreign keys to existing tables. Rollback = `DROP TABLE insurance_policies;` on homeserver. No captures or other data is affected.
- **Homeserver deploy required:** Yes — migration 0028 must be applied manually (`psql < packages/shared/drizzle/0028_insurance_policies.sql`). Gate 5.5 triggered (new migration in `packages/shared/drizzle/`).

---

## Acceptance criteria (phase-level)

- [ ] W1: Migration 0028 applies clean; Drizzle schema compiles
- [ ] W2: `python scripts/insurance-policy-extract.py --dry-run --file <fixture>` outputs valid JSON
- [ ] W3: `python scripts/test-insurance-extract.py` exits 0; all 3 fixture types validated
- [ ] W4: `GET /api/v1/insurance-policies` returns 200; `tsc --noEmit` clean on core-api
- [ ] `pnpm --filter @open-brain/shared exec tsc --noEmit` passes
- [ ] `pnpm --filter @open-brain/core-api exec tsc --noEmit` passes
- [ ] No new operational rules violated (no LLM calls, no per-item API calls, cost tier = T0)
- [ ] GH issue #68 remains open (P22b must also merge before closing)
