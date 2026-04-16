# Implementation Plan — Phase 4: Financial Awareness

**Generated:** 2026-04-15 23:15:00
**Based On:** docs/FINANCIAL_SPRINT_REQUIREMENTS.md, Ultra Plan analysis (session 2026-04-15), HAR file API discovery (Cobb Water, Gas South), email-pipeline.py template
**Total Phases:** 4
**Estimated Total Effort:** ~900 LOC across ~8 files + operational config

---

## Executive Summary

This plan builds the financial awareness layer for Open Brain: automated ingestion of financial transactions from 6 Plaid-connected accounts (Amex, Chase, Truist, Schwab, HSA Bank, PayPal), utility usage data from 3 providers (Cobb EMC power, Gas South gas, Cobb County Water), and manual quarterly processing for 401k and Amazon. All scripts run on the open-brain-vm (192.168.10.53) following the same T0/T1/T2 cost-tiered pattern established by the email pipeline.

The architecture is intentionally simple: Python scripts with SQLite local storage, posting summary captures to the Open Brain API. No new TypeScript code, no new Docker containers, no API cost beyond the existing subscription. The email pipeline (`scripts/email-pipeline.py`) is the proven template — financial follows the same patterns for authentication, classification, aggregation, and capture posting.

Key design decisions: Plaid Development tier (free, 100 items) for financial accounts; `electric-usage-downloader` (open-source Go tool) for power data; direct REST API calls for water and gas; `claude --print` (T2, subscription-covered) for all synthesis. No per-transaction LLM calls — aggregate first, synthesize once.

---

## Plan Overview

Scripts run on the VM as Python cron jobs. Each phase adds a new data source, and each leaves the system in a working state. Phase 1 is the foundation (Plaid + daily transactions). Phase 2 adds investment tracking and monthly synthesis. Phase 3 adds utility usage from three different APIs. Phase 4 handles low-frequency manual data drops.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies |
|-------|------------|------------------|-----------------|--------------|
| 1 | Plaid Foundation | financial-pipeline.py, daily transactions + balances, merchant categories | L (~4 files, ~500 LOC) | Troy: Plaid keys + bank linking |
| 2 | Investment & Synthesis | Weekly Schwab report, monthly financial analysis | M (~1 file extended, ~150 LOC) | Phase 1 data flowing |
| 3 | Utility Pipeline | Power (SmartHub), Gas (API+PDF), Water (API), monthly comparison | M (~3 files, ~400 LOC) | Troy: SmartHub + Gas South creds |
| 4 | Manual Inboxes | 401k PDF parser, Amazon CSV parser, file inbox watcher | S (~1 file extended, ~150 LOC) | None |

<!-- BEGIN PHASES -->

---

## Phase 1: Plaid Foundation

**Estimated Complexity:** L (~4 files, ~500 LOC)
**Dependencies:** Troy provides Plaid API keys + links 6 bank accounts via Plaid Link
**Parallelizable:** Items 1.1-1.2 must be sequential; 1.3-1.4 can follow in any order after 1.2

### Goals

- Establish Plaid integration with 6 financial accounts
- Build daily transaction sync with T0 merchant categorization
- Deliver daily balance snapshots as Open Brain captures
- Create the merchant categorization lookup table

### Work Items

#### 1.1 Plaid Account Setup & Link Server
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase A1
**Files Affected:**
- `scripts/plaid-link-server.py` (create)
- `config/financial/plaid-config.yaml` (create)

**Description:**
Install `plaid-python` in VM venv. Create a minimal Flask server that serves the Plaid Link UI for one-time bank account linking. Troy runs it in a browser, authenticates with each bank, and the server stores the resulting `access_token` per account in Bitwarden. Also create the Plaid config YAML with product list, environment (development), country codes, and account nicknames.

**Tasks:**
1. [ ] SSH to VM, install plaid-python: `pip install plaid-python flask`
2. [ ] Create `config/financial/plaid-config.yaml` with: environment (development), products (transactions, balance, investments), account list (amex, chase, truist, schwab, hsa, paypal) with nicknames
3. [ ] Create `scripts/plaid-link-server.py` — minimal Flask app: serves Plaid Link drop-in, handles `/create_link_token` and `/exchange_public_token` endpoints, prints access_token for user to store in Bitwarden
4. [ ] Troy: sign up at plaid.com, store `client_id` and `secret` in Bitwarden as `dev/open-brain/plaid`
5. [ ] Troy: run link server, authenticate 6 accounts, store access tokens in Bitwarden as `dev/open-brain/plaid-tokens`

**Acceptance Criteria:**
- [ ] `plaid-python` installed in VM venv
- [ ] Plaid Link server runs and serves bank linking UI
- [ ] All 6 accounts linked (access tokens stored in Bitwarden)
- [ ] Config YAML has correct product list and account mapping

**Notes:**
The link server is a one-time tool — not a permanent service. After all accounts are linked, it can be stopped. If a bank connection breaks, re-run for that specific account. Plaid access_tokens don't expire (unless the bank revokes consent).

---

#### 1.2 Transaction Sync Script
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase A2
**Files Affected:**
- `scripts/financial-pipeline.py` (create — main script)

**Description:**
Build the core financial pipeline script modeled after `email-pipeline.py`. Uses `/transactions/sync` (cursor-based) to pull new transactions daily for all 6 accounts. Stores in SQLite (`~/.financial-pipeline/financial.db`) with WAL mode. T0 categorizes using Plaid categories + merchant YAML overrides. Posts a daily transaction summary capture to Open Brain.

**Tasks:**
1. [ ] Create `scripts/financial-pipeline.py` with CLI subcommands: `--sync`, `--balances`, `--daily-summary`
2. [ ] Implement Plaid client initialization: read config YAML, retrieve secrets from Bitwarden via `bws`, create PlaidApi client
3. [ ] Implement SQLite schema: tables `accounts` (id, plaid_id, name, type, institution), `transactions` (id, account_id, date, amount, merchant, plaid_category, ob_category, pending), `sync_cursors` (account_id, cursor, last_sync)
4. [ ] Implement `--sync`: for each account, call `/transactions/sync` with stored cursor, insert/update transactions, store new cursor
5. [ ] Implement T0 categorization: map Plaid `personal_finance_category` → Open Brain category using config + merchant overrides
6. [ ] Implement `--daily-summary`: aggregate today's transactions by account + category, format as readable text, POST to `/api/v1/captures` with `source: 'api'`, `source_metadata: { type: 'financial_daily', ... }`
7. [ ] Add VM cron: `30 6 * * * cd ~/open-brain && venv/bin/python scripts/financial-pipeline.py --sync --balances --daily-summary >> ~/logs/financial-pipeline.log 2>&1`

**Acceptance Criteria:**
- [ ] Transactions sync from all 6 accounts without errors
- [ ] SQLite stores transactions with correct categorization
- [ ] Cursor-based sync only pulls new/modified transactions (not full re-pull)
- [ ] Daily summary capture posted to Open Brain
- [ ] Cron runs at 6:30 AM daily

**Notes:**
Use `X-Open-Brain-Caller: financial-pipeline` header for rate limit bypass (add to BYPASS_CALLERS Set in core-api rate-limit.ts if needed). Handle Plaid `ITEM_LOGIN_REQUIRED` error gracefully — log warning, skip account, continue others.

---

#### 1.3 Daily Balance Snapshot
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase A3
**Files Affected:**
- `scripts/financial-pipeline.py` (extend)

**Description:**
Add `--balances` subcommand to the financial pipeline. Calls `/accounts/balance/get` for all linked accounts. Stores in SQLite `daily_balances` table. Posts a daily balance capture with net worth calculation.

**Tasks:**
1. [ ] Implement `--balances`: call Plaid `/accounts/balance/get` for each account, store in `daily_balances` (date, account_id, current, available, limit)
2. [ ] Calculate net worth: sum all balances (positive for checking/savings/investments, negative for credit cards)
3. [ ] Format balance capture: "Financial Snapshot — [date]\n\nAmex: -$X\nChase: -$Y\n...\nNet Worth: $Z"
4. [ ] POST capture with `source_metadata: { type: 'balance_snapshot', net_worth: Z, accounts: {...} }`

**Acceptance Criteria:**
- [ ] Balances retrieved for all 6 accounts
- [ ] Net worth calculated correctly (credit cards negative, bank/investment positive)
- [ ] Daily balance capture posted with structured metadata

---

#### 1.4 Merchant Categorization Engine
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase A6
**Files Affected:**
- `config/financial/merchants.yaml` (create)

**Description:**
Create the merchant-to-category lookup table. Plaid provides base categories, but they're often too generic. The YAML provides exact and pattern-based overrides for known merchants.

**Tasks:**
1. [ ] Create `config/financial/merchants.yaml` with structure: exact matches (merchant_name → category), pattern matches (regex → category), Plaid category mapping (plaid_category → ob_category)
2. [ ] Seed with common merchants: grocery stores, gas stations, subscriptions (Netflix, Spotify, AWS, etc.), restaurants, utilities
3. [ ] Categories: Dining, Groceries, Gas/Fuel, Subscriptions, Travel, Household, Medical, Insurance, Utilities, Shopping, Entertainment, Professional, Transfers, Income, Uncategorized
4. [ ] Implement category resolution order in financial-pipeline.py: exact match → pattern match → Plaid category map → "Uncategorized"

**Acceptance Criteria:**
- [ ] YAML file loads correctly in pipeline
- [ ] At least 50 common merchant patterns seeded
- [ ] Resolution order works: exact → pattern → Plaid → fallback
- [ ] Uncategorized transactions logged for future rule additions

---

### Phase 1 Testing Requirements

- [ ] Run `--sync` with real Plaid data (after Troy links accounts)
- [ ] Verify transactions appear in SQLite with correct categories
- [ ] Verify daily summary capture appears in Open Brain search
- [ ] Verify balance snapshot capture with correct net worth
- [ ] Run full cron cycle: `--sync --balances --daily-summary`

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] Financial pipeline running daily on VM cron
- [ ] 6 accounts syncing transactions
- [ ] Daily balance + transaction captures in Open Brain
- [ ] LAB_NOTEBOOK entry created with Plaid setup details, sync verification, and categorization accuracy

---

## Phase 2: Investment & Monthly Synthesis

**Estimated Complexity:** M (~1 file extended, ~150 LOC)
**Dependencies:** Phase 1 (transaction data flowing)
**Parallelizable:** 2.1 and 2.2 are independent

### Goals

- Weekly investment position reports from Schwab
- Comprehensive monthly financial analysis with T2 synthesis

### Work Items

#### 2.1 Weekly Investment Report
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase A4
**Files Affected:**
- `scripts/financial-pipeline.py` (extend)

**Description:**
Add `--investments` subcommand. Calls Plaid `/investments/holdings/get` for the Schwab account. Stores positions in SQLite `holdings` table. Posts a weekly investment summary capture with allocation breakdown and weekly change.

**Tasks:**
1. [ ] Implement `--investments`: call Plaid investments API, store in `holdings` (date, security_id, name, ticker, quantity, close_price, value, type, account_id)
2. [ ] Calculate allocation: % of total by asset type (stocks, bonds, ETFs, cash)
3. [ ] Calculate weekly change: compare to last week's holdings (value delta, % change)
4. [ ] Format and POST capture: "Weekly Investment Summary — [date]\n\nTotal: $X (±Y%)\nAllocation: Stocks X%, Bonds Y%, Cash Z%\nTop movers: ..."
5. [ ] Add VM cron: `0 7 * * 0` (Sundays 7 AM)

**Acceptance Criteria:**
- [ ] Schwab holdings retrieved via Plaid investments API
- [ ] Positions stored with correct values and types
- [ ] Weekly change calculated against prior snapshot
- [ ] Investment capture posted to Open Brain

---

#### 2.2 Monthly Financial Synthesis
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase A5
**Files Affected:**
- `scripts/financial-pipeline.py` (extend)

**Description:**
Add `--monthly-report` subcommand. Aggregates all transactions for the month from SQLite, groups by category, compares to prior month and prior year same month. Uses `claude --print` (T2, subscription-covered) for synthesis. Posts comprehensive monthly financial report capture.

**Tasks:**
1. [ ] Implement `--monthly-report`: query SQLite for all transactions in prior month
2. [ ] Aggregate: total spend by category, top 10 merchants by spend, new merchants (first appearance), subscription changes (new/cancelled), large transactions (>$200)
3. [ ] Compare: MoM change by category (% and $), YoY if history exists
4. [ ] Build Claude CLI prompt: structured data + "Analyze this month's spending patterns, flag unusual items, identify trends"
5. [ ] Call `claude --print` with prompt, capture output
6. [ ] POST capture: "Monthly Financial Report — [month year]" with full synthesis
7. [ ] Add VM cron: `0 8 1 * *` (1st of month, 8 AM)

**Acceptance Criteria:**
- [ ] Monthly report aggregates correctly from SQLite
- [ ] T2 synthesis produces useful insights (not just restating numbers)
- [ ] MoM comparison shows meaningful deltas
- [ ] Monthly capture posted with structured source_metadata

**Notes:**
The aggregation rule applies here: 100+ transactions → Python aggregates → 1 Claude CLI call → 1 capture. Never per-transaction LLM calls.

---

### Phase 2 Testing Requirements

- [ ] Run `--investments` with real Schwab data
- [ ] Run `--monthly-report` with at least 1 month of transaction history
- [ ] Verify Claude CLI synthesis quality (manual review)
- [ ] Verify both captures appear in Open Brain search

### Phase 2 Completion Checklist

- [ ] All work items complete
- [ ] Weekly investment cron active (Sundays)
- [ ] Monthly report cron active (1st of month)
- [ ] LAB_NOTEBOOK entry with synthesis quality assessment and sample outputs

---

## Phase 3: Utility Pipeline

**Estimated Complexity:** M (~3 files, ~400 LOC)
**Dependencies:** Troy provides SmartHub credentials + Gas South credentials
**Parallelizable:** 3.1, 3.2, 3.3 are all independent; 3.4 depends on all three

### Goals

- Automated power usage tracking (15-min resolution)
- Monthly gas usage with therms from bill PDF parsing
- Monthly water usage from REST API
- Unified utility comparison synthesis

### Work Items

#### 3.1 Cobb EMC Power (SmartHub)
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase B1
**Files Affected:**
- `config/utility/utility-config.yaml` (create)
- VM: install `electric-usage-downloader` binary

**Description:**
Install the open-source `electric-usage-downloader` Go tool on the VM. Configure with Cobb EMC SmartHub credentials. Daily cron pulls 15-minute kWh data and stores in local CSV or SQLite. Monthly aggregation creates a power usage capture.

**Tasks:**
1. [ ] Download `electric-usage-downloader` binary from GitHub releases to `~/bin/` on VM
2. [ ] Create `~/.electric-usage-downloader/config.yaml` with SmartHub username/password (from Bitwarden `dev/open-brain/cobb-emc`), timezone, output format
3. [ ] Test: run manually, verify kWh data retrieved for recent days
4. [ ] Add VM cron: `0 4 * * *` (daily 4 AM) — pull previous day's data
5. [ ] Create `config/utility/utility-config.yaml` with account IDs, API URLs, alert thresholds
6. [ ] In `scripts/utility-pipeline.py`: implement power monthly aggregation (total kWh, daily average, peak hour, cost estimate at rate/kWh)

**Acceptance Criteria:**
- [ ] electric-usage-downloader retrieves data from Cobb EMC SmartHub
- [ ] Daily cron pulls 15-min resolution data
- [ ] Monthly aggregate calculates total kWh and daily average

---

#### 3.2 Cobb County Water (REST API)
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase B2
**Files Affected:**
- `scripts/utility-pipeline.py` (create)

**Description:**
Call the Cobb County Water REST API discovered via HAR analysis. The endpoint returns clean JSON meter readings (date, TGAL quantity). Test auth-free access first; if 401, implement session cookie automation.

API: `GET https://ccw-csswebapi.cobbcounty.org/api/account/getMeterReadings?accountId=<COBB_ACCOUNT_ID>&serviceId=<SERVICE_ID>`

**Tasks:**
1. [ ] Create `scripts/utility-pipeline.py` with CLI subcommands: `--water`, `--gas`, `--power-summary`, `--monthly-comparison`
2. [ ] Implement `--water`: GET meter readings API, parse JSON response, store in SQLite `utility.db` table `water_readings` (date, quantity_tgal, meter_serial)
3. [ ] Test auth-free: `curl` from VM to the API endpoint. If 401, implement login flow to obtain session cookie
4. [ ] Calculate monthly delta: current reading - previous reading = consumption for period
5. [ ] Add VM cron: `0 5 2 * *` (2nd of month, 5 AM) — pull latest readings

**Acceptance Criteria:**
- [ ] Water API returns meter readings from VM
- [ ] Readings stored in SQLite with dates and quantities
- [ ] Monthly consumption calculated as delta between readings

**Notes:**
Account ID `<COBB_ACCOUNT_ID>`, Service ID `<SERVICE_ID>` are hardcoded in config (Troy's account). The API showed readings: Mar 220, Feb 210, Jan 203 TGAL — monthly consumption is the delta (~10 TGAL/month).

---

#### 3.3 Gas South (REST API + PDF Parsing)
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase B3
**Files Affected:**
- `scripts/utility-pipeline.py` (extend)

**Description:**
Login to Gas South portal to obtain authtoken, call billing history API, download bill PDF for therms data. The API provides bill amounts and dates, but therms (CCFs × factor) are only in the bill PDF.

API: `GET https://manage-api.gassouth.com/oas/api/account/get-account-activity?accountNumber=<GAS_ACCOUNT_NUMBER>&lookBackMonths=3`
Auth: `authtoken` header (UUID from login flow)

**Tasks:**
1. [ ] Implement Gas South login: POST to `manage.gassouth.com` login endpoint with credentials (from Bitwarden `dev/open-brain/gas-south`), extract authtoken from response
2. [ ] Implement `--gas`: call billing history API with authtoken header, parse JSON response for bill amounts and dates
3. [ ] For therms: download bill PDF from the `Url` field in API response, extract CCFs and therm factor via regex (`(\d+)\s*CCFs?\s*.*?(\d+\.?\d*)\s*therm factor.*?(\d+\.?\d*)\s*therms`)
4. [ ] Store in SQLite: `gas_readings` (date, bill_amount, ccfs, therm_factor, therms, rate_per_therm)
5. [ ] Add to same monthly cron as water

**Acceptance Criteria:**
- [ ] Gas South login obtains valid authtoken
- [ ] Billing history API returns bill records
- [ ] Bill PDF downloaded and therms extracted correctly
- [ ] Data stored in SQLite with all fields

**Notes:**
From Troy's March 2026 bill: 66 CCFs × 1.034 = 68.24 therms at $0.65/therm. Account number: <GAS_ACCOUNT_NUMBER>. Token likely expires after hours — script re-authenticates on each run.

---

#### 3.4 Monthly Utility Comparison
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase B4
**Files Affected:**
- `scripts/utility-pipeline.py` (extend)

**Description:**
Monthly synthesis across all three utilities. Aggregates power kWh, gas therms, and water TGAL. Compares MoM and YoY (when history exists). Uses `claude --print` for T2 synthesis. Posts unified utility capture.

**Tasks:**
1. [ ] Implement `--monthly-comparison`: query SQLite for latest month's data across all three utilities
2. [ ] Build comparison table: power kWh (daily avg, total, cost est), gas therms (total, cost), water TGAL (consumption, cost est)
3. [ ] Calculate MoM deltas (% change from prior month)
4. [ ] Call `claude --print` with structured data + "Analyze utility usage patterns, flag anomalies, seasonal context"
5. [ ] POST capture: "Utility Summary — [month year]" with all three utilities
6. [ ] Add VM cron: `0 8 2 * *` (2nd of month, 8 AM, after individual pulls at 5 AM)

**Acceptance Criteria:**
- [ ] Monthly comparison includes all three utilities
- [ ] MoM deltas calculated correctly
- [ ] T2 synthesis provides useful context (seasonal, anomalies)
- [ ] Unified capture posted to Open Brain

---

### Phase 3 Testing Requirements

- [ ] electric-usage-downloader retrieves Cobb EMC data
- [ ] Water API returns readings from VM (auth-free or with session)
- [ ] Gas South login + API + PDF parse all work end-to-end
- [ ] Monthly comparison synthesis quality (manual review)

### Phase 3 Completion Checklist

- [ ] All work items complete
- [ ] Three utility data sources flowing
- [ ] Monthly comparison cron active
- [ ] LAB_NOTEBOOK entry with API access verification, parsing accuracy, and sample outputs

---

## Phase 4: Manual Inboxes

**Estimated Complexity:** S (~1 file extended, ~150 LOC)
**Dependencies:** None
**Parallelizable:** 4.1 and 4.2 are independent

### Goals

- Process quarterly 401k PDF statements
- Process quarterly Amazon order CSV exports
- File inbox watcher for drop-and-process workflow

### Work Items

#### 4.1 401k ReadySave PDF Parser
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase C1
**Files Affected:**
- `scripts/financial-pipeline.py` (extend)

**Description:**
Add `--process-inbox` subcommand that watches `~/financial-inbox/` for dropped files. For PDF files matching 401k patterns, extract balance, contributions (employee + employer), and allocation using PyMuPDF regex parsing. Post quarterly 401k capture.

**Tasks:**
1. [ ] Create `~/financial-inbox/` directory on VM
2. [ ] Implement file type detection: PDF → try 401k parser, CSV → try Amazon parser
3. [ ] Implement 401k PDF parser: extract total balance, YTD contributions (employee, employer match), fund allocation table (fund name, %, value)
4. [ ] POST capture: "401k Update — [quarter year]\n\nBalance: $X\nYTD Contributions: $Y (employee) + $Z (match)\nAllocation: ..."
5. [ ] Move processed file to `~/financial-inbox/processed/`

**Acceptance Criteria:**
- [ ] PDF parser extracts balance and contribution data
- [ ] Capture posted with structured allocation data
- [ ] Processed files moved to prevent reprocessing

**Notes:**
ReadySave PDF format may vary. Start with regex-based extraction, iterate on format. Quarterly frequency means manual review of each parse is practical.

---

#### 4.2 Amazon Order CSV Parser
**Status: PENDING**
**Requirement Refs:** FINANCIAL_SPRINT §Phase C2
**Files Affected:**
- `scripts/financial-pipeline.py` (extend)

**Description:**
Parse Amazon "Request My Data" CSV export. Extract order dates, items, prices, and categories. Aggregate into quarterly spending summary. Post capture with top categories and notable purchases.

**Tasks:**
1. [ ] Implement Amazon CSV parser: read CSV, extract OrderDate, Title, Quantity, ItemTotal, Category
2. [ ] Aggregate: total spend, count by category, top 10 items by price
3. [ ] Call `claude --print` with aggregated data: "Summarize this quarter's Amazon spending, identify patterns and notable purchases"
4. [ ] POST capture: "Amazon Spending — Q[n] [year]\n\n$X across Y orders\nTop categories: ..."
5. [ ] Move processed file to `~/financial-inbox/processed/`

**Acceptance Criteria:**
- [ ] CSV parser handles Amazon export format
- [ ] Quarterly summary aggregates correctly
- [ ] T2 synthesis identifies meaningful patterns
- [ ] Capture posted with structured metadata

---

### Phase 4 Testing Requirements

- [ ] Test 401k parser with a sample ReadySave PDF
- [ ] Test Amazon parser with a sample order export CSV
- [ ] Verify file inbox workflow: drop → parse → capture → move to processed

### Phase 4 Completion Checklist

- [ ] All work items complete
- [ ] File inbox watcher documented for Troy
- [ ] LAB_NOTEBOOK entry with parser accuracy and sample outputs

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| 1.3 (balances) | 1.4 (merchants) | Independent after 1.2 completes |
| 2.1 (investments) | 2.2 (monthly synthesis) | Independent — different Plaid products |
| 3.1 (power) | 3.2 (water), 3.3 (gas) | All independent data sources |
| 4.1 (401k) | 4.2 (Amazon) | Independent file parsers |
| Phase 3 (utilities) | Phase 2 (investment/synthesis) | Different data sources, different scripts |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Plaid bank connection fails for one account | Medium | Medium | Test each bank individually during Phase 1.1. Plaid Link has retry UI. Script continues with remaining accounts if one fails. |
| Plaid access_token revoked by bank | Low | High | Store tokens in Bitwarden. Monitor for `ITEM_LOGIN_REQUIRED` errors. Re-run link server for affected account. |
| Gas South authtoken format changes | Low | Medium | Token is UUID — unlikely to change. Login flow authenticated via HAR analysis. Auto-login on each run. |
| Water API requires auth after all | Low | Low | Test auth-free first. Fallback: session cookie from portal login. Worst case: manual monthly download. |
| electric-usage-downloader doesn't work with Cobb EMC | Low | Low | Tool works with hundreds of NISC SmartHub co-ops. Config example provided. Alternative: Green Button CSV export (manual). |
| ReadySave PDF format changes | Low | Low | Quarterly manual process — easy to fix regex. Format changes are rare for financial statements. |
| Claude CLI unavailable on VM | Low | Medium | T2 synthesis deferred; raw aggregation still captured. Retry on next cron run. |
| Cost overrun from accidental API calls | Low | High | All synthesis via `claude --print` (subscription). No Anthropic/OpenAI API calls. Plaid is free (Development tier). |

---

## Success Metrics

- [ ] All 4 phases completed
- [ ] Daily financial snapshot captures appearing in Open Brain (transactions + balances)
- [ ] Weekly investment report captures appearing (Sundays)
- [ ] Monthly financial synthesis captures appearing (1st of month)
- [ ] Monthly utility comparison captures appearing (2nd of month)
- [ ] Merchant categorization accuracy >85% (spot-check 20 transactions)
- [ ] All 3 utility data sources pulling data without errors
- [ ] Zero API cost beyond existing subscription
- [ ] All captures searchable and cross-referenceable in Open Brain

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| Plaid account setup | FINANCIAL_SPRINT §A1 | 1 | 1.1 |
| Transaction sync | FINANCIAL_SPRINT §A2 | 1 | 1.2 |
| Daily balance snapshot | FINANCIAL_SPRINT §A3 | 1 | 1.3 |
| Merchant categorization | FINANCIAL_SPRINT §A6 | 1 | 1.4 |
| Weekly investment report | FINANCIAL_SPRINT §A4 | 2 | 2.1 |
| Monthly financial synthesis | FINANCIAL_SPRINT §A5 | 2 | 2.2 |
| Cobb EMC power usage | FINANCIAL_SPRINT §B1 | 3 | 3.1 |
| Cobb County Water usage | FINANCIAL_SPRINT §B2 | 3 | 3.2 |
| Gas South usage | FINANCIAL_SPRINT §B3 | 3 | 3.3 |
| Utility comparison | FINANCIAL_SPRINT §B4 | 3 | 3.4 |
| 401k PDF processing | FINANCIAL_SPRINT §C1 | 4 | 4.1 |
| Amazon order processing | FINANCIAL_SPRINT §C2 | 4 | 4.2 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-04-15 23:15:00*
*Source: /create-plan command from ultra-plan analysis*
