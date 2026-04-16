# Financial Sprint Requirements — Open Brain Phase 4

**Generated:** 2026-04-15
**Based On:** Account inventory discussion, HAR file analysis, API discovery, utility portal investigation

---

## Objective

Build the financial awareness layer for Open Brain: automated ingestion of financial transactions, investment positions, and utility usage. All data feeds into the existing capture system for search, synthesis, and cross-referencing.

## Design Principles

- **Cost-tiered processing:** T0 Python extraction → T1 classification → T2 CLI synthesis → capture
- **Aggregation rule:** Never call LLM per-transaction. Aggregate → synthesize → one capture.
- **Infrastructure:** Python scripts on open-brain-vm (192.168.10.53), same pattern as email-pipeline.py
- **Two delivery modes:** Daily transaction snapshot + monthly deep analysis

---

## Financial Accounts

### Plaid-Connected Accounts (6)

| Account | Provider | Plaid Products | Data Expected |
|---------|----------|---------------|---------------|
| Credit Card | American Express | Transactions, Balance | Daily transactions, running balance |
| Credit Card | Chase | Transactions, Balance | Daily transactions, running balance |
| Checking | Truist | Transactions, Balance, Auth | Transactions, balance, account/routing |
| Investments | Schwab | Transactions, Balance, Investments | Positions, holdings, balance, dividends |
| HSA | HSA Bank (account.hsabank.com) | Transactions, Balance | Contributions, distributions, balance |
| Payments | PayPal | Transactions, Balance | Transfers, payments, balance |

**Plaid tier:** Development (free, 100 items, sufficient for 6 accounts)
**Key Plaid APIs:** /transactions/sync, /accounts/balance/get, /investments/holdings/get

### Manual Accounts (1)

| Account | Provider | Access | Frequency |
|---------|----------|--------|-----------|
| 401k | ReadySave (Vanguard) | PDF statement download | Quarterly |

---

## Utility Accounts

### Cobb EMC — Power (kWh)

**Access method:** SmartHub API via [electric-usage-downloader](https://github.com/tedpearson/electric-usage-downloader) (Go tool, reverse-engineered NISC API)
**Resolution:** 15-minute intervals
**Auth:** SmartHub username/password
**Portal:** cobbemc.smarthub.coop
**Data:** kWh consumption, cost per interval
**Automation:** Fully automated daily cron

### Gas South — Natural Gas (therms)

**Access method:** REST API at `manage-api.gassouth.com`
- **Billing history:** `GET /oas/api/account/get-account-activity?accountNumber=2585622233&lookBackMonths=24`
  - Returns: bill dates, amounts, payment history, bill segment details
  - Auth: `authtoken` header (UUID, from portal login)
- **Usage (therms):** NOT in the API response directly. Available in:
  - Linked bill PDF (URL in API response `Url` field) — parse for CCFs, therm factor, therms used
  - Example from March 2026 bill: 66 CCFs × 1.034 = 68.24 therms, $0.65/therm
**Auth:** Login to `manage.gassouth.com` → obtain authtoken UUID
**Automation:** Semi-automated (token refresh on login, then API calls)

### Cobb County Water — Water (TGAL)

**Access method:** REST API at `ccw-csswebapi.cobbcounty.org`
- **Meter readings:** `GET /api/account/getMeterReadings?accountId=100101623&serviceId=S0228354`
  - Returns: JSON array of monthly readings with date, quantity (TGAL), meter serial, read type
  - Auth: Possibly unauthenticated (no auth headers in HAR capture) — needs verification from VM
- **Account info:** `GET /api/account/getSortedServices?accountId=100101623`
**Account ID:** AP0037554 / 100101623
**Service ID:** S0228354
**Automation:** Likely fully automated (test auth-free access first)

---

## Deliverables

### Phase A: Plaid Financial Integration

1. **Plaid setup:** Developer account, API keys, link 6 accounts via Plaid Link
2. **Daily transaction sync:** Python script on VM, pull new transactions via /transactions/sync
3. **Daily balance snapshot:** Pull all account balances, store as daily capture
4. **Weekly investment positions:** Pull Schwab holdings/positions
5. **Merchant categorization:** Plaid auto-categorizes + T0 rule refinements
6. **Monthly financial synthesis:** T2 CLI aggregation → spending by category, trends, unusual items, net worth

### Phase B: Utility Usage Integration

1. **Power (Cobb EMC):** Deploy electric-usage-downloader on VM, daily cron, 15-min kWh data → monthly usage capture
2. **Gas (Gas South):** Python script for API + PDF bill parsing, monthly therms + cost → capture
3. **Water (Cobb County):** Python script for API call, monthly TGAL readings → capture
4. **Usage comparison:** Monthly T2 synthesis comparing YoY utility usage trends

### Phase C: Manual/Low-Frequency

1. **401k (ReadySave):** Quarterly PDF drop → T0 parse → capture
2. **Amazon order history:** Quarterly "Request My Data" export → T0 parse → capture

---

## Architecture

```
Plaid API (daily cron on VM)
  → /transactions/sync → categorize (T0 rules + Plaid categories) → store locally
  → /accounts/balance/get → daily balance snapshot → capture
  → /investments/holdings/get (weekly) → positions → capture
  → Monthly: aggregate all transactions → T2 CLI synthesis → monthly financial capture

electric-usage-downloader (daily cron on VM)
  → SmartHub API → 15-min kWh data → store locally
  → Monthly: aggregate → T2 CLI synthesis → usage capture

Gas South API + PDF (monthly script on VM)
  → /get-account-activity → bill history
  → Download bill PDF → parse therms
  → Monthly capture with therms + cost

Cobb County Water API (monthly script on VM)
  → /getMeterReadings → TGAL readings
  → Monthly capture with usage

Manual drops (quarterly)
  → 401k PDF → /mnt/user/appdata/open-brain/financial-inbox/ → T0 parse → capture
  → Amazon CSV → same path
```

## Secrets (Bitwarden)

| Secret | Storage Key | Notes |
|--------|------------|-------|
| Plaid client_id | `dev/open-brain/plaid` | From Plaid developer dashboard |
| Plaid secret (development) | `dev/open-brain/plaid` | Development environment secret |
| SmartHub credentials | `dev/open-brain/cobb-emc` | Cobb EMC portal login |
| Gas South credentials | `dev/open-brain/gas-south` | manage.gassouth.com login |
| Water API (if auth needed) | `dev/open-brain/cobb-water` | ccw-css portal credentials |

## Risk Factors

- Plaid bank connection failures (some banks occasionally break)
- Gas South auth token expiry (need automated re-login)
- Water API may require auth from non-browser context
- SmartHub tool may need config tuning for Cobb EMC specifically
- Plaid Development tier has 100-item limit (we use 6, but Link sessions count as items until cleaned up)
