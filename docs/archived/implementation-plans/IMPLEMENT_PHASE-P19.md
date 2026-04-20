# IMPLEMENT_PHASE-P19.md — Financial Account Monitoring

**Phase:** P19
**GH Issue:** #62
**Wave:** 4 (Arc 3 Batch Source Pipelines)
**PHASED_PLAN dependencies:** None (independent of all other phases; extends existing `financial-pipeline.py`)
**Effort estimate:** ~2 days

---

## Scope Diff (card vs. current state)

The PHASED_PLAN § P19 card lists four deliverables:
1. Daily balance-diff capture
2. Position-change detection (new holdings, large movements)
3. Anomaly detection against trailing 30-day window
4. Configurable alert thresholds in YAML

Current state of `scripts/financial-pipeline.py` (3,035 LOC):

| Card deliverable | Actual status | Action |
|---|---|---|
| Daily balance-diff capture | `--balances` command exists (line 645) — posts a raw snapshot every day, but **no diff vs. yesterday, no anomaly detection, no alerts**. | **IN SCOPE** — extend, don't replace |
| Position-change detection | `--investments` command exists (lines 818–1064) — computes weekly delta and top movers vs. 7 days ago. **No alert threshold logic, no Pushover notification.** | **IN SCOPE** — add threshold-gated Pushover alerts |
| Anomaly detection (30-day window) | **Missing** — no function computing rolling 30-day baseline or flagging deviations. | **IN SCOPE** — new function `detect_balance_anomalies()` |
| Configurable thresholds in YAML | **Missing** — no `monitoring` block in `config/financial/plaid-config.yaml`. | **IN SCOPE** — add `monitoring:` section to YAML + loader |

Drift notes:
- Plaid access, SQLite schema (`daily_balances`, `holdings`, `transactions` tables), capture posting, and Bitwarden secret retrieval all exist and work — no infrastructure changes needed.
- The `--balances` cron is **not yet wired** in `deploy/cron/unraid-ingest.cron`. P19 must add a daily `--balances --account-monitoring` cron entry. The `--process-inbox` entry fires at 06:00; the balance+monitoring run should be at 07:00 (clear of the existing slot).
- Pushover is used by other pipeline components (utility pipeline, workers) — use the same `PushoverService` pattern (subprocess to send) already established in `scripts/`. The financial pipeline does NOT import from `@open-brain/shared`; it is a standalone Python script. Pushover send must be implemented as a direct HTTP call using Python `urllib` (not curl — Cloudflare is not in the path here; this is an internal outbound call to Pushover's API).
- `PUSHOVER_USER_KEY` and `PUSHOVER_API_TOKEN` are in Bitwarden (keys: `pushover-user-key`, `pushover-api-token`). Both are already retrieved in `utility-pipeline.py` using the same `get_bws_secret()` pattern as `financial-pipeline.py`.
- Cost tier: this is T0 (Python arithmetic over SQLite data) + Pushover HTTP. No LLM calls. No API cost.

---

## Work Items

### W1 — `config/financial/plaid-config.yaml`: Add `monitoring:` section

**What:** Add a top-level `monitoring:` block defining alert thresholds. All numeric thresholds must have sensible defaults so the pipeline degrades gracefully if the block is absent.

**Current file:** `config/financial/plaid-config.yaml` (56 lines — see lines 1–56).

**New block to append:**

```yaml
# Account health monitoring — used by --account-monitoring flag
monitoring:
  # Balance change alerts
  balance_drop_pct: 20.0        # alert if any account drops > N% day-over-day
  balance_drop_abs: 500.0       # alert if any account drops > $N day-over-day (absolute)
  credit_utilization_pct: 80.0  # alert if credit utilization exceeds N%

  # Investment position alerts
  position_change_pct: 10.0     # alert if any single holding moves > N% week-over-week
  portfolio_drop_pct: 5.0       # alert if total portfolio value drops > N% week-over-week

  # Anomaly detection — 30-day rolling window
  anomaly_sigma: 2.5            # flag balance if current deviates > N standard deviations from 30d mean
  anomaly_min_history_days: 7   # skip anomaly check if fewer than N days of history exist

  # Net worth tracking
  net_worth_drop_pct: 5.0       # alert if net worth drops > N% day-over-day

  # Capture behavior
  post_capture_on_alert: true   # always post a capture when alerts fire
  post_daily_capture: true      # post a monitoring summary capture even when no alerts
```

**Files touched:**
- `config/financial/plaid-config.yaml` — append `monitoring:` block

**Acceptance:**
- [ ] YAML loads clean with `yaml.safe_load()`
- [ ] Pipeline function `load_monitoring_config(cfg)` returns the block with defaults for any missing key

---

### W2 — `scripts/financial-pipeline.py`: `load_monitoring_config()` + `detect_balance_anomalies()`

**What:** Two new functions:

**`load_monitoring_config(cfg: dict) -> dict`**
- Reads `cfg.get('monitoring', {})` and fills in defaults for every key listed in W1
- Returns the normalized dict; callers use `mcfg['balance_drop_pct']` etc.

**`detect_balance_anomalies(conn, account_key, today_balance, mcfg) -> list[str]`**
- Queries `daily_balances` for the trailing 30 days for `account_key`
- Computes mean + standard deviation of `current_balance` over those rows
- If fewer than `anomaly_min_history_days` rows → returns `[]` (not enough history)
- If `abs(today_balance - mean) > anomaly_sigma * std` → returns a list of human-readable alert strings, e.g. `["HSA Bank: balance $8,420 is 3.1σ above 30-day mean ($6,100)"]`
- Pure Python arithmetic on SQLite data — no LLM call

**Location:** insert after the existing `store_balances()` function (line ~644 in current file) to keep all balance-related functions together.

**Files touched:**
- `scripts/financial-pipeline.py`

**Acceptance:**
- [ ] `load_monitoring_config({})` returns full defaults (unit-testable without YAML file)
- [ ] `detect_balance_anomalies()` with synthetic history returns correct sigma calculation
- [ ] Returns `[]` when history is < `anomaly_min_history_days`

---

### W3 — `scripts/financial-pipeline.py`: `send_pushover_alert()` helper

**What:** New helper function that sends a Pushover notification directly via Python `urllib`. Keeps all external calls in the pipeline self-contained.

```python
def send_pushover_alert(cfg: dict, title: str, message: str, priority: int = 0) -> bool:
    """Send a Pushover notification. Returns True on success."""
    ...
```

Implementation:
- Calls `get_bws_secret('pushover-user-key')` and `get_bws_secret('pushover-api-token')` (same pattern as Plaid credentials — both keys already established; see `utility-pipeline.py` for the pattern)
- POSTs to `https://api.pushover.net/1/messages.json` using `urllib.request.urlopen` (stdlib — no new dependencies)
- Returns `True` on HTTP 200, `False` on any error (logs but does not raise)
- `priority=1` for anomaly/large-drop alerts; `priority=0` for informational

**Files touched:**
- `scripts/financial-pipeline.py` — new function near top with other utilities

**Acceptance:**
- [ ] Function exists and can be called without side effects when `cfg` lacks `monitoring` block
- [ ] Graceful failure (returns False, logs warning) on network error — never raises

---

### W4 — `scripts/financial-pipeline.py`: `cmd_account_monitoring()` — new command

**What:** New `--account-monitoring` flag that runs the full monitoring pass: balance diff, position change check, and anomaly detection, then Pushover-alerts on threshold breaches and posts a summary capture.

**Logic:**

```
1. Load monitoring config via load_monitoring_config(cfg)
2. Fetch today's balances from daily_balances table (must run AFTER --balances)
3. Fetch yesterday's balances from daily_balances table
4. Compute per-account day-over-day delta (absolute + percentage)
5. For each account:
   a. If |delta_pct| > balance_drop_pct OR |delta_abs| > balance_drop_abs → alert
   b. If account type is credit AND utilization > credit_utilization_pct → alert
   c. Call detect_balance_anomalies(conn, account_key, today_balance, mcfg)
      → append any anomaly strings to alerts
6. Compute total net worth (today vs. yesterday)
   → If |net_worth_delta_pct| > net_worth_drop_pct → alert
7. If any investment accounts: check holdings table for last two snapshots
   → Per holding: if |pct_change| > position_change_pct → alert
   → If portfolio total drop > portfolio_drop_pct → alert
8. Build alerts list + monitoring summary text
9. If alerts: send_pushover_alert() with consolidated alert summary (priority=1)
10. If post_daily_capture OR any alerts: _post_capture() with monitoring summary
```

**Capture format** (`type: "financial_monitoring"`):

```
Financial Account Monitor -- YYYY-MM-DD

STATUS: [OK | ALERTS FIRED]

Account Balances (vs. yesterday):
  American Express: -$2,341 (no change / +$50 / -$200)
  Truist Checking: $8,200 (-$300, -3.5%)  ← threshold breach if applicable
  ...

Net Worth: $XXX,XXX (+$YYY / -$ZZZ vs yesterday)

Alerts:
  [if any]

Anomaly Flags:
  [if any]
```

**When no prior day data exists** (e.g., first run): skip diffs and anomaly checks; post informational capture only.

**Files touched:**
- `scripts/financial-pipeline.py` — add `cmd_account_monitoring()` function + `--account-monitoring` argparse flag + call in `main()`

**Acceptance:**
- [ ] `--account-monitoring` flag exists and runs without error on a cold DB (no prior day data)
- [ ] Produces a capture with `source_metadata.type == 'financial_monitoring'`
- [ ] Alerts fire correctly against synthetic SQLite data (verifiable via direct DB manipulation)
- [ ] No Pushover call when all values are within thresholds

---

### W5 — `deploy/cron/unraid-ingest.cron`: Add daily balance + monitoring cron

**What:** Add two new cron entries to run after the existing `--process-inbox` at 06:00:

```
# Financial daily balance snapshot + account monitoring — 7:00 AM daily
# Run in sequence: balances first (writes to daily_balances), then monitoring (reads from it).
0 7 * * * /usr/bin/docker exec open-brain-financial-ingest python /app/financial-pipeline.py --balances >> /var/log/financial-balances.log 2>&1
5 7 * * * /usr/bin/docker exec open-brain-financial-ingest python /app/financial-pipeline.py --account-monitoring >> /var/log/financial-monitoring.log 2>&1
```

**Scheduler slot check:** The workers scheduler has these 07:xx slots occupied:
- `0 7` — budget-check
- `15 7` — drift-monitor

The `financial-pipeline.py` runs in the ingest sidecar Docker container via `docker exec`, NOT through BullMQ. These are host-level cron jobs, completely separate from the workers scheduler. No collision.

**Files touched:**
- `deploy/cron/unraid-ingest.cron`

**Acceptance:**
- [ ] Both cron lines present with correct format
- [ ] Log file paths distinct from existing `/var/log/financial-ingest.log`
- [ ] Install instructions already in file header — no changes needed to header prose

---

### W6 — Tests: unit tests for W2 + W4 logic

**What:** Add a test module `scripts/tests/test_financial_monitoring.py` covering:

1. `load_monitoring_config({})` → returns full defaults
2. `load_monitoring_config({'monitoring': {'balance_drop_pct': 15.0}})` → overrides one value, others stay default
3. `detect_balance_anomalies()` with 10 synthetic rows → correctly computes sigma and flags correctly
4. `detect_balance_anomalies()` with 3 rows (below `anomaly_min_history_days=7`) → returns `[]`
5. `cmd_account_monitoring()` with a fresh in-memory SQLite DB (no prior rows) → no crash, returns gracefully

**Test runner:** Same pattern as `docker/ingest-sidecar/tests/` — pytest, `requirements.txt` in `scripts/tests/`.

**New files:**
- `scripts/tests/__init__.py` (empty)
- `scripts/tests/requirements.txt` (pytest, pyyaml — same as sidecar tests)
- `scripts/tests/test_financial_monitoring.py`

**Acceptance:**
- [ ] `pytest scripts/tests/test_financial_monitoring.py` — all 5 tests pass
- [ ] No imports of external services (Plaid, Pushover) in tests — mock or test pure functions only
- [ ] `pyproject.toml` — add `scripts/tests/` to `[tool.pytest.ini_options].testpaths` (or keep standalone since sidecar tests are also standalone)

---

## Execution Order

```
W1 (YAML config)        → first; gates W2/W4 reading the config
W2 (Python helpers)     → depends on W1 for config structure; W3 depends on nothing
W3 (Pushover helper)    → independent; add alongside W2 for locality
W4 (cmd_account_monitoring) → depends on W2 + W3
W5 (cron entries)       → depends on W4 being present
W6 (tests)              → can write alongside W2/W4; validate before W5
```

---

## Pre-implementation verifications (Gate 3 implementer must perform)

1. **Pushover secret key names** — verify actual BWS key names: `grep -n "pushover" scripts/utility-pipeline.py` — confirm the names match `pushover-user-key` and `pushover-api-token` (or adjust W3 accordingly).

2. **`daily_balances` schema** — confirm columns: `id, date, account_id, current_balance, available_balance, credit_limit, created_at` (init-schema.sql or migration 0021+). The `--balances` command stores one row per sub-account per day; `cmd_account_monitoring()` reads them back.

3. **`holdings` schema** — confirm columns: `date, security_id, name, ticker, quantity, close_price, value, type, account_id` (init-schema.sql). `cmd_account_monitoring()` queries the two most recent distinct dates.

4. **Account type values in SQLite** — credit accounts are stored with `type = 'credit'` or `type = 'loan'` in the `accounts` table (check `plaid-config.yaml` → maps to Plaid subtypes → stored as `acct_type = pa.get("type", ...)`). Credit utilization formula: `(current_balance / credit_limit) * 100` where `credit_limit > 0`.

5. **Bitwarden Pushover key names** — run `bws secret list | grep -i pushover` on open-brain-vm before writing W3 to confirm exact key names.

6. **Scheduler slot registry audit** — the new cron entries are host-level (not BullMQ), so the workers scheduler registry doesn't apply. But verify `unraid-ingest.cron` doesn't already have a 07:00 or 07:05 entry: `grep "7 \*" deploy/cron/unraid-ingest.cron`.

---

## Deliverables checklist

| File | Change | Work item |
|------|--------|-----------|
| `config/financial/plaid-config.yaml` | Add `monitoring:` block | W1 |
| `scripts/financial-pipeline.py` | `load_monitoring_config()` + `detect_balance_anomalies()` | W2 |
| `scripts/financial-pipeline.py` | `send_pushover_alert()` | W3 |
| `scripts/financial-pipeline.py` | `cmd_account_monitoring()` + `--account-monitoring` argparse flag | W4 |
| `deploy/cron/unraid-ingest.cron` | Two new cron entries (07:00 balances, 07:05 monitoring) | W5 |
| `scripts/tests/__init__.py` | New (empty) | W6 |
| `scripts/tests/requirements.txt` | New (pytest, pyyaml) | W6 |
| `scripts/tests/test_financial_monitoring.py` | New — 5 test cases | W6 |

---

## LAB_NOTEBOOK requirement

Before first commit: new entry with:
- **Objective:** Add daily financial account health monitoring to `financial-pipeline.py` — balance diffs, anomaly detection, Pushover alerts, and a daily summary capture (GH #62)
- **Hypothesis:** All logic is T0 Python arithmetic over SQLite data; Pushover is a single HTTP POST; no LLM calls; no schema migration; extends existing pipeline without touching existing commands. Low risk.
- **Rollback:** Revert the PR; the `--account-monitoring` flag simply disappears; existing `--balances`, `--investments`, etc. are unaffected; cron entries removed from `unraid-ingest.cron`; no homeserver migration required.

---

## Rollback plan

Pure Python script extension + YAML config addition + cron entries. No schema migration. No Docker image changes. No workers scheduler changes. Rollback = revert the PR and remove the two new cron lines from `unraid-ingest.cron` on homeserver (single `sed` or manual edit).

No homeserver deploy action required beyond installing the updated cron file — which the operator does manually as with all cron changes (per existing `unraid-ingest.cron` instructions).

---

## Acceptance criteria (phase-level)

- [ ] `--account-monitoring` flag runs cleanly with no prior data in `daily_balances`
- [ ] With synthetic SQLite data: balance drop > threshold triggers Pushover (mocked in tests)
- [ ] With synthetic SQLite data: anomaly > 2.5σ triggers alert string
- [ ] With synthetic SQLite data: within-threshold run produces informational capture only, no Pushover
- [ ] Capture posted with `source_metadata.type == 'financial_monitoring'` and correct date
- [ ] `pytest scripts/tests/test_financial_monitoring.py` — all 5 tests pass
- [ ] `config/financial/plaid-config.yaml` loads without error
- [ ] `ruff check scripts/financial-pipeline.py` — no new lint errors introduced
- [ ] `deploy/cron/unraid-ingest.cron` has both new entries at 07:00 and 07:05
- [ ] GH issue #62 can be closed
