# Implementation Plan: P22b — Insurance Cross-Policy Comparison + Gap Analysis

**Phase:** P22b
**GitHub Issue:** #68 (subset — synthesis + gap analysis layer)
**Branch slug:** `feat/phase-P22b-insurance-gap-analysis`
**Depends on:** P22a (merged — `insurance_policies` table populated, `scripts/insurance-policy-extract.py` operational, `GET /api/v1/insurance-policies` route live)
**Wave:** 4 (Arc 3 Batch Source Pipelines)
**Effort estimate:** 1–2 days

---

## Scope Verification (Gate 1)

### P22a deliverables confirmed present

| Deliverable | Status |
|---|---|
| `scripts/insurance-policy-extract.py` | Exists — 1,143 lines, full T0 extractor for health/auto/home/umbrella |
| `packages/shared/drizzle/0029_insurance_policies.sql` | Exists — table with `coverage JSONB NOT NULL` |
| `GET /api/v1/insurance-policies` | Exists — `packages/core-api/src/routes/insurance-policies.ts` registered, supports `?policy_type=` and `?active_only=` filters |

### Schema notes (exact columns from migration 0029)

```sql
insurance_policies (
  id UUID, policy_number TEXT, provider TEXT NOT NULL,
  policy_type TEXT NOT NULL,          -- CHECK: 'health' | 'auto' | 'home' | 'umbrella'
  effective_date DATE, expiration_date DATE,
  insured_name TEXT,
  coverage JSONB NOT NULL,            -- structured coverage tree per policy type
  raw_text TEXT, source_file TEXT,
  extracted_at TIMESTAMPTZ, created_at TIMESTAMPTZ
)
-- UNIQUE INDEX on source_file WHERE NOT NULL
-- INDEX on policy_type, provider, effective_date
```

### Coverage JSONB structure (from extractor — confirmed in insurance-policy-extract.py)

All policy types have common keys: `deductibles`, `limits`, `coverage_types`, `exclusions`, `notes`.
- **health** adds: `out_of_pocket_max`, `co_insurance`, `co_pays`
- **auto** adds: `limits` (bodily_injury, property_damage, uninsured_motorist, etc.)
- **home** adds: `limits` (dwelling, other_structures, personal_property, loss_of_use, liability, medical_payments)
- **umbrella** adds: `limits` (per_occurrence, aggregate), `deductibles` (self_insured_retention)

### API route behavior (confirmed in insurance-policies.ts)

- `GET /api/v1/insurance-policies` → `{ policies: InsurancePolicy[] }` (all active by default)
- `?active_only=false` → includes expired policies
- `?policy_type=health` → filter by type
- Returns Drizzle-mapped rows with all columns including `coverage` JSONB

### No scope drift from PHASED_PLAN.md card

The card says:
- `scripts/insurance-gap-analysis.py`: pulls all active policies; T2 CLI synthesizes gap analysis (under-coverage, over-coverage, redundancy, missing categories)
- Capture: annual summary for policy renewal review
- Optional: triggered by any new policy upload (keeps comparison current)

All of this is buildable against the actual schema and route. No invalidated assumptions. The "triggered by new upload" optional is achievable via a CLI flag (`--trigger-on-upload`) but is scope-bounded below.

---

## Cost-Tier Compliance

Per CLAUDE.md cost-tier rules:

| Step | Tier | Rationale |
|---|---|---|
| Fetch policies via GET /api/v1/insurance-policies | T0 Python (HTTP to local API) | Read-only, deterministic |
| Parse and normalize coverage JSONB | T0 Python | Deterministic comparison logic |
| Gap analysis heuristics (missing categories, redundancy detection) | T0 Python | Rule-based |
| Narrative gap analysis synthesis | **T2 Claude CLI** (`claude --print`) | Batch/async, no human waiting |
| POST capture to core-api | T0 Python HTTP | Simple REST call |

T3 API must NOT be used. The `subprocess.run(["claude", "--print", "-p", prompt])` pattern from `scripts/financial-pipeline.py` is the canonical T2 invocation.

---

## Work Items

### 1.1 — Core gap analysis script `scripts/insurance-gap-analysis.py`

**File:** `scripts/insurance-gap-analysis.py` (new)

**Logic:**

**Step 1 — Fetch active policies (T0):**
```python
GET {CAPTURES_URL_base}/api/v1/insurance-policies?active_only=true
```
Parse JSON response into list of policy dicts. Fail fast if HTTP error; log count fetched.

**Step 2 — Normalize coverage tree (T0):**
Build a unified coverage summary per policy_type bucket. For each active policy, extract:
- Policy type + provider + effective/expiration dates
- Deductible amounts (list of `{category, amount_usd}`)
- Limits (list of `{category, amount_usd, per}`)
- OOP max (health only)
- Co-insurance % (health only)
- Coverage types present

**Step 3 — T0 gap heuristics (deterministic):**

| Gap Class | Detection Rule |
|---|---|
| Missing category | Expected policy types (`EXPECTED_POLICY_TYPES = ['health', 'auto', 'home', 'umbrella']`) not represented in active policies |
| Under-coverage | Health individual deductible > $5,000 (configurable `thresholds.health.high_deductible`); home dwelling limit < $200,000 (configurable) |
| Over-coverage | Auto rental reimbursement AND umbrella redundancy (both cover same auto liability) |
| Redundancy | Two health policies both active with overlapping effective dates |
| Expiring soon | `expiration_date` within N days (default 60, configurable `synthesis.expiry_warning_days`) |

These heuristics produce a structured `gap_findings` list: `[{class, policy_type, description, severity: 'high'|'medium'|'low'}]`.

**Step 4 — Build CLI prompt (T0):**
Structured prompt with:
- Policy inventory table: `provider | type | effective | expiration | key limits`
- Gap findings section from step 3
- Instruction: synthesize as an annual insurance review memo — under-coverage risks, redundancy savings opportunities, renewal priority items, missing coverage recommendations. Keep under 1000 words.
- Truncate prompt at 5000 chars if needed.

**Step 5 — Call `claude --print` (T2):**
```python
subprocess.run(["claude", "--print", "-p", prompt], timeout=120, capture_output=True, text=True)
```
Fallback: if CLI unavailable or timeout, post raw gap findings without synthesis.

**Step 6 — POST capture:**
- `content`: synthesis text + gap findings table
- `source`: `"api"`
- `type`: `"observation"`
- `brain_view`: `"personal"`
- `source_metadata`:
  ```json
  {
    "type": "insurance_gap_analysis",
    "policy_count": N,
    "policy_types_covered": ["health", "auto"],
    "missing_types": ["home", "umbrella"],
    "gap_findings": [...],
    "expiring_soon": [...],
    "has_synthesis": true
  }
  ```

**Step 7 — Optional: trigger-on-upload hook:**
The `--watch-dir DIR` flag, if provided, watches a directory for new PDFs, calls `insurance-policy-extract.py --file <new.pdf>`, then immediately re-runs gap analysis. This uses `watchdog` or a simple `inotifywait` subprocess — flag is present but documented as "requires watchdog package; optional extra".

**CLI interface:**
```
python scripts/insurance-gap-analysis.py
  [--dry-run]               # print JSON, no POST
  [--active-only / --all]   # default: active only
  [--config PATH]           # override config/insurance.yaml
  [--no-synthesis]          # skip claude --print
  [--watch-dir DIR]         # (optional) watch dir for new PDFs
```

**Config file `config/insurance.yaml`** (new):
```yaml
api:
  base_url: ""             # falls back to env OPEN_BRAIN_API_URL or http://localhost:3002

synthesis:
  max_prompt_chars: 5000
  expiry_warning_days: 60
  captures_url: ""         # falls back to api.base_url + /api/v1/captures

thresholds:
  health:
    high_deductible_usd: 5000
    high_oop_max_usd: 10000
  home:
    min_dwelling_usd: 200000
  auto:
    min_bodily_injury_usd: 100000

expected_policy_types:
  - health
  - auto
  - home
  - umbrella
```

**Memory:** Policies are fetched in a single bounded API call (number of active policies is small — typically < 20). All processing is in-memory on that small list. No streaming needed.

### 1.2 — Unit tests `scripts/tests/test_insurance_gap.py`

**File:** `scripts/tests/test_insurance_gap.py` (new)

Test cases (no live DB or API — use fixture dicts):

1. `test_missing_policy_type_detected` — no home policy in fixture → missing_types includes 'home'
2. `test_no_missing_types` — all 4 types present → missing_types is empty
3. `test_health_high_deductible_flag` — deductible $7,500 > threshold $5,000 → under-coverage finding
4. `test_health_normal_deductible_no_flag` — deductible $2,000 → no under-coverage finding
5. `test_redundancy_two_active_health_plans` — two active health policies → redundancy finding
6. `test_expiring_soon` — expiration_date within 30 days → appears in expiring_soon list
7. `test_not_expiring` — expiration_date 180 days out → not in expiring_soon
8. `test_prompt_truncation` — large policy fixture truncates at max_prompt_chars
9. `test_dry_run_no_post` — `dry_run=True` → no HTTP calls to captures endpoint
10. `test_home_under_coverage` — dwelling limit $150,000 < $200,000 threshold → under-coverage finding

All tests are pure-Python fixture-based; no psycopg2 or HTTP calls in test execution.

### 1.3 — Config file `config/insurance.yaml`

New file with the YAML structure defined in 1.1. Default values are conservative (do not fire on edge cases; operator adjusts). Committed into the repo.

### 1.4 — `scripts/requirements-insurance.txt` verification

Confirm `psycopg2-binary` and `pdfplumber` are listed (P22a dependency). P22b adds no new mandatory dependencies (`requests` is stdlib in Python 3 via `urllib.request` — avoid the `requests` library to keep deps minimal). If `requests` is already in another requirements file, note that but don't add it to insurance-specific file.

Note: `urllib.request` handles the `GET /api/v1/insurance-policies` and `POST /api/v1/captures` calls — both are simple JSON over HTTP to localhost, no auth headers required (single-user system per CLAUDE.md).

---

## Acceptance Criteria

| # | Criterion | Verification |
|---|---|---|
| AC-1 | `scripts/insurance-gap-analysis.py --dry-run` against a fixture policy set prints valid JSON with keys `policy_count`, `missing_types`, `gap_findings`, `expiring_soon`, `synthesis_text` | Manual + unit test |
| AC-2 | Missing policy type detection correct | Unit test 1.2 case 1–2 |
| AC-3 | Under-coverage heuristics fire at correct thresholds | Unit test 1.2 cases 3–4, 10 |
| AC-4 | Redundancy detection works for overlapping active health plans | Unit test 1.2 case 5 |
| AC-5 | Expiry warning within configured window | Unit test 1.2 cases 6–7 |
| AC-6 | `--dry-run` makes no POST to captures endpoint | Unit test 1.2 case 9 |
| AC-7 | T2 Claude CLI used; no direct Anthropic SDK import | `grep -n "import anthropic" scripts/insurance-gap-analysis.py` returns 0 |
| AC-8 | Prompt truncation does not crash | Unit test 1.2 case 8 |
| AC-9 | POST capture uses `source: 'api'` (valid `CaptureSource`) and `brain_view: 'personal'` | Code review |
| AC-10 | All 10 unit tests pass: `python -m pytest scripts/tests/test_insurance_gap.py -v` | CI |
| AC-11 | Operator validates gap analysis capture quality against their actual policy set (subjective — AC per PHASED_PLAN.md card) | Manual, post-homeserver-deploy |

---

## Explicit Deliverables

1. `scripts/insurance-gap-analysis.py` — new file, T2 CLI gap analysis script
2. `scripts/tests/test_insurance_gap.py` — new file, 10 unit tests
3. `config/insurance.yaml` — new config file with thresholds and API settings
4. `scripts/requirements-insurance.txt` — verified/updated (no new mandatory deps)

---

## Files NOT Changed

- `scripts/insurance-policy-extract.py` — P22a deliverable; P22b only reads its output via API
- `packages/shared/drizzle/0029_insurance_policies.sql` — no schema change
- `packages/core-api/src/routes/insurance-policies.ts` — read-only route; no changes needed
- Any TypeScript packages

---

## Rollback Plan

- Delete `scripts/insurance-gap-analysis.py`, `scripts/tests/test_insurance_gap.py`, `config/insurance.yaml`
- No DB migrations involved — rollback is `git revert`
- Any captures already POSTed remain valid observations; no cleanup required

---

## Homeserver Deploy

**Migration required:** No (migration 0029 was P22a's deliverable; P22b adds no new migrations).

**Operator action after merge:** Copy updated `config/insurance.yaml` to homeserver deploy path. Configure `api.base_url` if localhost:3002 is not the correct internal address. Run `python scripts/insurance-gap-analysis.py --dry-run` to verify API connectivity before first live run.

**Gate 5.5 triggered:** No (no migration, no compose changes).

---

## LAB_NOTEBOOK Pre-Action Entry (Gate 3 prerequisite)

Before first commit in Gate 3, the `implement-executor` MUST write a LAB_NOTEBOOK entry with:
- **Objective:** P22b gap analysis script + tests
- **Hypothesis:** Script fetches active policies from GET /api/v1/insurance-policies, runs T0 heuristics to identify gap classes, calls `claude --print` for narrative synthesis, POSTs one capture per run. All 10 tests green.
- **Rollback plan:** `git revert` the PR; no DB state changes; API route unchanged.

---

## Operator-Approval Matrix

P22b does NOT match any Gate 5 operator-approval trigger:
- Not labeled critical
- Does not edit CLAUDE.md / PRD / TDD
- No homeserver migration
- No change to `captures` or `embeddings` tables

**Auto-merge eligible** after Gate 4 APPROVE + CI green.

---

## Interaction Notes

### insurance-policy-extract.py coverage JSONB structure

The extractor writes `coverage` as a JSON object. The gap script reads it directly from the API response (`policy['coverage']` is already a Python dict after `json.loads(response)`). No re-parsing needed.

### CaptureSource constraint

The POST capture uses `source: 'api'` — this is in the canonical 9-value `CaptureSource` set per CLAUDE.md. Do not use `source: 'document'` or invent a new source value.

### CLAUDE.md pre-flight audit rule

No CHECK-constraint migrations in P22b, so the mandatory pre-flight DB audit rule does not apply.
