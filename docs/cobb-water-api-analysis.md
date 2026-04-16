# Cobb County Water System — API Analysis

Reverse-engineered from HAR capture of `ccw-css.cobbcounty.org` (2026-04-16).

## Platform Identity

This is **UMAX CSS** (Customer Self-Service) by **Itineris** — a commercial utility customer portal platform. The issuer in JWTs is `https://css.itineris.net/`. The SPA is Angular with Kendo UI components. Hosted on Azure (Azure Front Door, ASP.NET backend, Azure B2C for identity).

**Version:** V25SP06 (from the B2C id_token `extension_version` claim).

---

## Architecture Overview

```
Browser (Angular SPA)
    |
    v
ccw-css.cobbcounty.org          <-- ASP.NET MVC, serves SPA + manages OIDC session
    |
    |-- /Session/GetAuthTokenForCurrentUser  --> returns JWT (15 min TTL)
    |
    v
ccw-csswebapi.cobbcounty.org    <-- REST API backend (separate subdomain)
    |
    |-- Authorization: Bearer <JWT> on every request
    |
    v
Azure B2C (ccwb2cprod.b2clogin.us)  <-- Identity provider (OIDC)
```

Two domains:
- **ccw-css.cobbcounty.org** — SPA host + session management (cookie-based ASP.NET session)
- **ccw-csswebapi.cobbcounty.org** — REST API (JWT Bearer auth, CORS restricted to ccw-css origin)

---

## Authentication Flow

### Step 1: Azure AD B2C OIDC Login

The login uses **Azure AD B2C** with a custom policy (`B2C_1A_CCWPROD_SIGNUP_SIGNIN_MFA`). This is a full browser-based OIDC flow — not a simple API call.

**OAuth2 authorize parameters:**
| Parameter | Value |
|-----------|-------|
| client_id | `cf9c0a6f-293e-473d-b27f-e3fc2690dbd1` |
| redirect_uri | `https://ccw-css.cobbcounty.org/signin-oidc` |
| response_type | `code id_token` |
| scope | `openid profile offline_access https://fabrikamb2c.onmicrosoft.com/demoapi/demo.read` |
| response_mode | `form_post` |
| B2C tenant | `ccwb2cprod.onmicrosoft.us` |
| Policy | `B2C_1A_CCWPROD_SIGNUP_SIGNIN_MFA` |

**Sequence:**
1. `GET /` → 302 to `/session/signin`
2. `/session/signin` → 302 to B2C authorize URL
3. B2C renders login page at `ccwb2cprod.b2clogin.us`
4. User submits credentials via `POST /SelfAsserted` (form-urlencoded: `signInName` + `password`)
5. B2C may require MFA (policy name includes "MFA")
6. `GET /api/CombinedSigninAndSignup/confirmed` with `csrf_token`
7. B2C redirects back via form POST to `/signin-oidc` with `code`, `id_token`, `state`
8. ASP.NET validates tokens, establishes server-side session (HttpOnly cookies)
9. `/Session/CheckSignIn` → 302 to `/`

**Key detail:** The SelfAsserted POST requires:
- A `X-CSRF-TOKEN` header (base64-encoded, obtained from the B2C login page)
- A `tx` query parameter with `StateProperties` (base64 JSON containing a `TID`)
- Form body: `request_type=RESPONSE&signInName=<email>&password=<password>`

### Step 2: JWT Token Acquisition

After the OIDC session is established, the SPA calls:

```
GET https://ccw-css.cobbcounty.org/Session/GetAuthTokenForCurrentUser
```

This returns a JWT (RS256-signed, issued by `https://css.itineris.net/`).

**JWT payload structure:**
```json
{
  "nameid": "<user-uuid>",
  "UserId": "<user-uuid>",
  "RegisteredEntities": "[{\"EntityId\":\"AP0037554\",\"EntityType\":\"AccountParty\"}]",
  "ImpersonatedByUserWithUserId": "00000000-0000-0000-0000-000000000000",
  "nbf": 1776361385,
  "exp": 1776362285,
  "iat": 1776361385,
  "iss": "https://css.itineris.net/",
  "aud": "https://css.itineris.net/"
}
```

**JWT lifetime: 15 minutes.** The SPA must refresh by calling `GetAuthTokenForCurrentUser` again (using the server-side session cookie).

### Step 3: API Authentication

The SPA sends the JWT as `Authorization: Bearer <token>` on every API call to `ccw-csswebapi.cobbcounty.org`. The CORS preflight explicitly allows the `authorization` header.

> **Note:** Chrome's HAR export stripped the Authorization headers and cookies (common with HttpOnly cookies and security-sensitive headers). The auth mechanism was confirmed via: (1) CORS preflight allowing `authorization` header, (2) WebSocket connection passing `access_token` as query parameter, (3) `getAuthenticationToken` function in page source, (4) `access-control-allow-credentials: true` in responses.

---

## Key Identifiers

These are needed for all API calls:

| ID | Value (Troy's account) | Description |
|----|----------------------|-------------|
| accountId | `100101623` | Water utility account number |
| regEntId | `AP0037554` | Registered entity (account party) ID |
| regEntType | `AccountParty` | Entity type |
| serviceId | `S0228354` | Water service ID |
| userId | `bcb53fef-ac4c-4eff-baa2-a549a5b6e0d4` | B2C user UUID |

---

## API Endpoints Reference

**Base URL:** `https://ccw-csswebapi.cobbcounty.org/api`

**Required headers on ALL authenticated calls:**
```
Authorization: Bearer <jwt-token>
Accept: application/json, text/plain, */*
Origin: https://ccw-css.cobbcounty.org
Referer: https://ccw-css.cobbcounty.org/
```

### Usage Data (Primary Target)

#### GET /account/GetBilledUsageGraphData

**This is the main endpoint for water consumption and billing history.**

```
GET /api/account/GetBilledUsageGraphData
    ?accountId=100101623
    &serviceId=S0228354
    &includeWeatherOverlay=false
    &getEstimatedProjected=false
    &neighborhoodComparison=false
    &compareRange=None
    &compareWithProductId=
```

**Response** (JSON, ~7KB):
```json
{
  "billedAmountCurrency": "USD",
  "totalBilledAmount": 676.17,
  "status": "Completed",
  "serviceId": "S0228354",
  "consumptionUnits": ["TGAL"],
  "periodFromDate": "2025-04-09T12:00:00",
  "summary": [
    "Total amount: USD 676.17",
    "Total consumption: TGAL 109.00"
  ],
  "billedUsage": [
    {
      "billedAmount": 61.40,
      "category": "May 2025",
      "label": "May 25",
      "startDate": "2025-04-09T12:00:00",
      "endDate": "2025-05-08T12:00:00",
      "consumptionSummaryPerUnit": [
        { "totalConsumption": 10.0, "unit": "TGAL" }
      ],
      "consumptionSummary": [
        {
          "tariffPeriodDescription": "TGAL",
          "tariffPeriodId": "TGAL",
          "consumption": 10.0,
          "consumptionUnit": "TGAL"
        }
      ],
      "averageTemperature": 0.0,
      "averagePrecipitation": 0.0,
      "difference": 0.0
    }
    // ... 11 billing periods returned (configurable: NumberOfMonthsOfBillingHistoryToDisplay = 24)
  ],
  "consumption": [
    {
      "id": "TGAL",
      "description": "TGAL",
      "unit": "TGAL",
      "consumption": [
        { "category": "May 2025", "label": "May 25", "value": 10.0, "endDate": "2025-05-08T12:00:00" }
        // ...
      ]
    }
  ]
}
```

**Data fields per billing period:**
- `billedAmount` — dollar amount (USD)
- `totalConsumption` — water usage in TGAL (thousand gallons)
- `startDate` / `endDate` — billing period date range
- `category` — human-readable month label
- Weather overlay fields (temperature, precipitation) — available but not populated in this capture

**Example curl:**
```bash
curl -s 'https://ccw-csswebapi.cobbcounty.org/api/account/GetBilledUsageGraphData?accountId=ACCOUNT_ID&serviceId=SERVICE_ID&includeWeatherOverlay=false&getEstimatedProjected=false&neighborhoodComparison=false&compareRange=None&compareWithProductId=' \
  -H 'Authorization: Bearer JWT_TOKEN' \
  -H 'Accept: application/json' \
  -H 'Origin: https://ccw-css.cobbcounty.org'
```

### Account & Billing Information

#### GET /registeredentity/getsummarydata

Account summary including address, service types, and account identifiers.

```bash
curl -s 'https://ccw-csswebapi.cobbcounty.org/api/registeredentity/getsummarydata' \
  -H 'Authorization: Bearer JWT_TOKEN' \
  -H 'Accept: application/json' \
  -H 'Origin: https://ccw-css.cobbcounty.org'
```

**Key response fields:**
- `[0].id` — registered entity ID (e.g., "AP0037554")
- `[0].accountsData[0].id` — account ID (e.g., "100101623")
- `[0].accountsData[0].serviceTypes[0].firstServiceId` — service ID (e.g., "S0228354")
- `[0].accountsData[0].premisesAddress` — full address object
- `[0].accountsData[0].status` — "Active"

#### GET /registeredentity/GetAccountsWithDetails

Current balance, last payment, and bill info.

```bash
curl -s 'https://ccw-csswebapi.cobbcounty.org/api/registeredentity/GetAccountsWithDetails?regEntId=REG_ENT_ID&regEntType=AccountParty' \
  -H 'Authorization: Bearer JWT_TOKEN' \
  -H 'Accept: application/json' \
  -H 'Origin: https://ccw-css.cobbcounty.org'
```

**Response:**
```json
[{
  "accountId": "100101623",
  "dueBalance": 63.29,
  "pastDueBalance": 0.0,
  "lastPaymentSettleAmount": 44.75,
  "lastPaymentTransactionDate": "2026-03-20T12:00:00Z",
  "lastBillId": "B009274416",
  "lastBillDueAmount": 63.29,
  "lastBillDueDate": "2026-04-20T12:00:00Z"
}]
```

#### GET /account/getSortedServices

Service (meter) details.

```bash
curl -s 'https://ccw-csswebapi.cobbcounty.org/api/account/getSortedServices?accountId=ACCOUNT_ID&includeUnmetered=true&includeServicesWithMeteredParent=true&excludeRelatedServicesTypeInterPremises=false&productSwitch=false' \
  -H 'Authorization: Bearer JWT_TOKEN' \
  -H 'Accept: application/json' \
  -H 'Origin: https://ccw-css.cobbcounty.org'
```

**Response:**
```json
[{
  "serviceId": "S0228354",
  "serviceType": "WATER",
  "serviceTypeDescription": "Water Service",
  "meterSerialNumber": "16109146",
  "contractStartDate": "2014-07-11T12:00:00Z",
  "meterLocation": "25' Left"
}]
```

#### GET /account/getaccount

Full account details (address, bill recipients, language).

```bash
curl -s 'https://ccw-csswebapi.cobbcounty.org/api/account/getaccount?accountId=ACCOUNT_ID' \
  -H 'Authorization: Bearer JWT_TOKEN' \
  -H 'Accept: application/json' \
  -H 'Origin: https://ccw-css.cobbcounty.org'
```

#### GET /user/getcurrentuser

Current user profile (name, email, security role, last sign-in).

```bash
curl -s 'https://ccw-csswebapi.cobbcounty.org/api/user/getcurrentuser' \
  -H 'Authorization: Bearer JWT_TOKEN' \
  -H 'Accept: application/json' \
  -H 'Origin: https://ccw-css.cobbcounty.org'
```

### Other Available Endpoints (observed in HAR)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/account/getloans` | GET | Loan/payment plan data |
| `/api/account/getMoveRequests` | GET | Service move requests |
| `/api/account/getaccountpaymentsetup` | GET | Payment configuration |
| `/api/account/GetAccountPreferences` | GET | Account preference toggles |
| `/api/account/GetAccountQuicklinks` | GET | Available actions (move, utility request) |
| `/api/registeredentity/hasownerregisteredentity` | GET | Ownership check |
| `/api/registeredentity/getregisteredentity` | GET | Full entity profile (name, address, phones, email) |
| `/api/settings/GetGlobalSettings` | GET | 183 platform config items |
| `/api/settings/GetLanguages` | GET | Supported languages |
| `/api/settings/GetUserSettings` | GET | User preferences |
| `/api/settings/GetDynamicTranslations` | GET | UI translations |
| `/api/customcontent/*` | GET | Custom content, alerts, help text |

---

## Session Management

| Aspect | Details |
|--------|---------|
| **Identity Provider** | Azure AD B2C (`ccwb2cprod.b2clogin.us`) |
| **B2C Tenant** | `ff814df0-9943-4c3a-b473-8bdf2285d0b6` |
| **OIDC client_id** | `cf9c0a6f-293e-473d-b27f-e3fc2690dbd1` |
| **Server session** | ASP.NET HttpOnly cookies on `ccw-css.cobbcounty.org` |
| **API auth** | JWT Bearer token on `ccw-csswebapi.cobbcounty.org` |
| **JWT lifetime** | 15 minutes |
| **JWT issuer** | `https://css.itineris.net/` |
| **JWT refresh** | Call `GET /Session/GetAuthTokenForCurrentUser` (requires valid server session) |
| **Inactivity timeout** | 30 minutes (`logoutAfterInactivityPeriod` setting) |
| **B2C id_token lifetime** | ~60 minutes (exp - iat = 3600s) |
| **MFA** | Configured (`mfaChoice: 'all'`) but may not be enforced for all users |
| **CSRF protection** | B2C login uses `X-CSRF-TOKEN` header; API calls rely on CORS + Bearer token |
| **CORS** | `access-control-allow-origin: https://ccw-css.cobbcounty.org` (single origin, strict) |

---

## Rate Limiting & Anti-Bot Assessment

| Factor | Finding |
|--------|---------|
| **Rate limit headers** | None observed (`X-RateLimit-*` absent) |
| **WAF** | Azure Front Door (x-azure-ref headers), no evidence of aggressive blocking |
| **CAPTCHA** | reCAPTCHA v2 configured (site key in HTML) — used for public forms, not authenticated API calls |
| **Bot detection** | No Cloudflare/Akamai/PerimeterX fingerprinting observed |
| **User-Agent checks** | Unknown — Python `urllib` gets 403 from Cloudflare on other sites, but this is Azure-hosted |
| **Response times** | 80-960ms, consistent — no throttling observed |
| **IP blocking** | Not tested, but Azure Front Door could enforce |

**Assessment:** Low anti-bot friction on the API side. The main defense is the B2C OIDC login flow, which is browser-based and complex to automate.

---

## Feasibility Assessment for Automated Collection

### The Hard Part: Authentication

The Azure AD B2C OIDC flow is the primary obstacle. It is a multi-step browser-based flow with:
1. Server-side state (nonce, CSRF token, state parameter)
2. Potential MFA challenge
3. HttpOnly session cookies
4. Cross-domain form POSTs

**Three approaches:**

#### Approach A: Headless Browser (Playwright/Puppeteer) — Recommended

Use a headless browser to:
1. Navigate to `https://ccw-css.cobbcounty.org/`
2. Fill and submit the B2C login form
3. Handle MFA if prompted
4. Wait for redirect back to the app
5. Call `GetAuthTokenForCurrentUser` via page JS
6. Extract the JWT
7. Use the JWT for direct API calls (valid for 15 min)

**Pros:** Handles all the OIDC complexity, MFA, CSRF tokens automatically. 
**Cons:** Requires a browser runtime. Heavier than pure HTTP.

#### Approach B: Replicate OIDC Flow in HTTP Client

Manually replicate the B2C flow:
1. GET `/session/signin` — capture redirect URL and state
2. GET B2C authorize URL — parse the login page HTML for CSRF token and state
3. POST `/SelfAsserted` with credentials + CSRF token
4. GET `/confirmed` with CSRF token
5. Parse the form POST response (code + id_token)
6. POST `/signin-oidc` with code, id_token, state
7. Capture session cookies
8. GET `/Session/GetAuthTokenForCurrentUser` — extract JWT

**Pros:** Lightweight, no browser needed.
**Cons:** Fragile — any B2C page change breaks it. MFA handling is very difficult without a browser. Cookie management is tricky.

#### Approach C: Manual Token Extraction + Refresh Loop

Since the JWT lasts only 15 minutes but the server session lasts 30+ minutes:
1. Log in manually in a browser once
2. Extract the session cookies
3. Use session cookies to call `GetAuthTokenForCurrentUser` every 14 minutes
4. Use the JWT for API calls

**Pros:** Simplest code. **Cons:** Requires periodic manual login when the session expires.

### The Easy Part: Data Extraction

Once you have a valid JWT, the API calls are straightforward REST GETs. No pagination, no GraphQL, no complex query parameters. A single call to `GetBilledUsageGraphData` returns 11+ months of billing history.

### Recommended Implementation

```python
# Pseudocode for Approach A (Playwright)

from playwright.sync_api import sync_playwright
import requests

def get_water_usage():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        # 1. Navigate and login
        page.goto('https://ccw-css.cobbcounty.org/')
        page.wait_for_url('**/b2clogin.us/**')
        page.fill('#signInName', 'EMAIL')
        page.fill('#password', 'PASSWORD')
        page.click('#next')
        
        # 2. Handle MFA if needed
        # page.wait_for_selector('#mfa-code-input', timeout=5000)
        # ... handle MFA ...
        
        # 3. Wait for redirect back to app
        page.wait_for_url('https://ccw-css.cobbcounty.org/**', timeout=30000)
        
        # 4. Extract JWT
        jwt = page.evaluate('''() => {
            return fetch('/Session/GetAuthTokenForCurrentUser')
                .then(r => r.text())
                .then(t => t.replace(/"/g, ''));
        }''')
        
        browser.close()
    
    # 5. Call API with JWT
    headers = {
        'Authorization': f'Bearer {jwt}',
        'Accept': 'application/json',
        'Origin': 'https://ccw-css.cobbcounty.org'
    }
    
    # Get account IDs first
    summary = requests.get(
        'https://ccw-csswebapi.cobbcounty.org/api/registeredentity/getsummarydata',
        headers=headers
    ).json()
    
    account_id = summary[0]['accountsData'][0]['id']
    service_id = summary[0]['accountsData'][0]['serviceTypes'][0]['firstServiceId']
    
    # Get usage data
    usage = requests.get(
        f'https://ccw-csswebapi.cobbcounty.org/api/account/GetBilledUsageGraphData'
        f'?accountId={account_id}&serviceId={service_id}'
        f'&includeWeatherOverlay=false&getEstimatedProjected=false'
        f'&neighborhoodComparison=false&compareRange=None&compareWithProductId=',
        headers=headers
    ).json()
    
    # Get current balance
    balance = requests.get(
        f'https://ccw-csswebapi.cobbcounty.org/api/registeredentity/GetAccountsWithDetails'
        f'?regEntId={summary[0]["id"]}&regEntType=AccountParty',
        headers=headers
    ).json()
    
    return usage, balance
```

### Data Available for Collection

| Data Point | Endpoint | Frequency |
|------------|----------|-----------|
| Monthly consumption (TGAL) | GetBilledUsageGraphData | Monthly (billing cycle) |
| Monthly billed amount (USD) | GetBilledUsageGraphData | Monthly |
| Billing period dates | GetBilledUsageGraphData | Monthly |
| Current balance due | GetAccountsWithDetails | Real-time |
| Past due balance | GetAccountsWithDetails | Real-time |
| Last payment amount/date | GetAccountsWithDetails | Real-time |
| Next bill due date | GetAccountsWithDetails | Real-time |
| Meter serial number | getSortedServices | Static |
| Service start date | getSortedServices | Static |

**Note:** Daily usage data is NOT available. The `EnableDailyUsage` global setting is `false`, meaning the portal only shows monthly billed readings, not daily smart meter data.

---

## Security Notes

**IMPORTANT:** The HAR file contained plaintext credentials. The password for `troy.davis@hotmail.com` on this portal was exposed. Consider:
1. Rotating the password immediately
2. Deleting the HAR file after analysis
3. Storing the new password in Bitwarden

The credentials in the HAR are URL-encoded in the `SelfAsserted` POST body. This is inherent to how B2C login forms work — credentials are always transmitted in the POST body (over TLS).
