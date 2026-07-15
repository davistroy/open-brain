# Actual Budget — Integration Guide

How to programmatically read/write a **self-hosted Actual Budget** instance via the official Node client. Instance-specific values (server host, budget sync ID, credentials, account IDs) are **placeholders** here — keep those in a private/gitignored file or your secrets manager, never in this repo.

---

## 1. Mental model (read this first)

Actual is **local-first / CRDT-sync**. There is **no general REST API** on the server. Instead:

1. The official **Node client (`@actual-app/api`)** connects to the server, **downloads the full budget into a local SQLite cache dir** you specify.
2. You **query and mutate that local copy** with JS functions or **ActualQL**.
3. Changes **sync back** to the server (and every other device/browser on that budget) as CRDT messages.

A session is always: `init()` → `downloadBudget(syncId)` → …queries/mutations… → `shutdown()`.

> ⚠️ The API operates on the **live budget**. If the instance is bank-synced (SimpleFIN/GoCardless), that integration also writes to it. Any writes propagate to the real data and every device. For experiments, work **read-only** or `exportBudget()` a copy and test against a throwaway budget/`dataDir`. Back up before bulk writes.

---

## 2. Connection config (fill in from your private notes / secrets manager)

| Thing | Value |
|---|---|
| Server URL | `http://<ACTUAL_HOST>:5006` (or `https://<your-actual-domain>`) |
| Internal port | `5006` |
| Server version | pin your client to match (see §3) |
| Budget **sync ID** | `<SYNC_ID>` — find in the web UI **Settings → Advanced Settings**, or the server's `server-files/account.sqlite` → `files.group_id` |
| Encryption | if the budget is **E2E-encrypted**, pass `{ password }` to `downloadBudget` (the file key, distinct from the login password) |
| Server login password | store in a **secrets manager** (Bitwarden Secrets Manager / Vault / etc.); never commit it |

**Never hardcode** the sync ID, server host, or password in a committed file. Read them from env / secrets at runtime.

### Networking note (macvlan deployments)
If Actual runs as a **macvlan** container (its own L2 IP), be aware:
- Devices on the **same LAN** can reach `http://<container-ip>:5006` directly.
- The **container host itself usually cannot reach its own macvlan IP** — if your code runs on that host, run it inside a container on the same macvlan network, or in Actual's own netns:
  `docker run --rm --network container:<actual-container> node:20 …` → server is then `http://127.0.0.1:5006`.
- Off-LAN: use the HTTPS hostname (behind a reverse proxy / tailnet).

---

## 3. The API — `@actual-app/api` (Node.js)

- npm: <https://www.npmjs.com/package/@actual-app/api>
- **Match the package version to your server version** to avoid budget-migration surprises: `npm i @actual-app/api@<server-version>`.
- Native dep `better-sqlite3` — use a **glibc** Node image (`node:20`, not `-alpine`) for prebuilt binaries.

### Lifecycle
```js
const api = require('@actual-app/api');

await api.init({
  dataDir: process.env.ACTUAL_DATA_DIR || '/tmp/actual-cache',
  serverURL: process.env.ACTUAL_SERVER_URL,   // http://<ACTUAL_HOST>:5006
  password: process.env.ACTUAL_PASSWORD,      // from secrets manager
});

await api.downloadBudget(process.env.ACTUAL_SYNC_ID);
// encrypted budgets: api.downloadBudget(syncId, { password: process.env.ACTUAL_FILE_KEY })

// ... queries / mutations ...

await api.shutdown();
```

### Data conventions
- **Amounts are integers in minor units** (cents): `$12.34 → 1234`. Divide by 100 for display.
- **Sign:** negative = outflow (spending), positive = inflow. **Account balance = sum of its transaction amounts**; credit-card balances are **negative** when money is owed.
- **Dates:** `YYYY-MM-DD`. **Budget months:** `YYYY-MM`.

---

## 4. Function reference (`@actual-app/api`)

Full docs: <https://actualbudget.org/docs/api/reference>

**Budget / file**
- `init(config)`, `shutdown()`, `sync()`
- `getBudgets()`, `loadBudget({syncId})`, `downloadBudget(syncId, {password?})`
- `importBudget(input, opts?)`, `exportBudget() → Uint8Array`, `batchBudgetUpdates(fn)`
- `getServerVersion()`, `getPreferences()`, `getIDByName({type, string})`

**Accounts**
- `getAccounts()`, `createAccount(account, initialBalance?)`, `updateAccount(id, fields)`
- `closeAccount(id, transferAccountId?, transferCategoryId?)`, `reopenAccount(id)`, `deleteAccount(id)`
- `getAccountBalance(id, cutoff?) → number` (minor units; `cutoff` = date for a historical balance)

**Transactions**
- `getTransactions(accountId, startDate, endDate) → Transaction[]`
- `addTransactions(accountId, txns[], runTransfers?, learnCategories?)` — raw insert, no rules
- `importTransactions(accountId, txns[], opts?) → {added, updated, errors}` — **reconciles + dedups + runs rules** (use this for imports)
- `updateTransaction(id, fields)`, `deleteTransaction(id)`

**Categories / groups**
- `getCategories(opts?)`, `createCategory(c)`, `updateCategory(id, fields)`, `deleteCategory(id)`
- `getCategoryGroups(opts?) → groups with nested categories`, `createCategoryGroup(g)`, `updateCategoryGroup(id, fields)`, `deleteCategoryGroup(id)`

**Payees / tags**
- `getPayees()`, `getCommonPayees()`, `createPayee(p)`, `updatePayee(id, fields)`, `deletePayee(id)`, `mergePayees(targetId, mergeIds[])`
- `getTags()`, `createTag(t)`, `updateTag(id, fields)`, `deleteTag(id)`

**Budgeting (envelope)**
- `getBudgetMonths()`, `getBudgetMonth(month)`, `setBudgetAmount(month, categoryId, value)`
- `setBudgetCarryover(month, categoryId, flag)`, `holdBudgetForNextMonth(month, value)`, `resetBudgetHold(month)`

**Rules / schedules / notes / bank sync**
- `getRules()`, `getPayeeRules(payeeId)`, `createRule(rule)`, `updateRule(rule)`, `deleteRule(id)`
- `getSchedules()`, `createSchedule(s)`, `updateSchedule(id, fields)`, `deleteSchedule(id)`
- `getNote(id)`, `updateNote(id, note)`
- `runBankSync({accountId})`, `runImport(budgetName, fn)`

---

## 5. ActualQL (`q` / `runQuery`) — flexible queries

Docs: <https://actualbudget.org/docs/api/actual-ql>

```js
const { q, runQuery } = require('@actual-app/api');

// transactions in a date range for one account, with payee + category names
const { data } = await runQuery(
  q('transactions')
    .filter({ account: accountId,
              date: { $gte: '2026-01-01', $lte: '2026-12-31' } })
    .select(['id', 'date', 'payee.name', 'category.name', 'amount'])
);

// sum spending in a category
const { data: rows } = await runQuery(
  q('transactions').filter({ 'category.name': 'Food' }).select(['amount'])
);
const totalCents = rows.reduce((s, t) => s + t.amount, 0);
```

- **Operators:** `$eq $ne $lt $lte $gt $gte $oneof $regex $like $notlike`. Array = AND; `$or` / `$and` for logic.
- **Dotted paths** traverse relations: `payee.name`, `category.name`, `account.name`.
- **Split transactions:** `.options({ splits: 'inline' | 'grouped' | 'all' })` — default `inline` returns subtransactions flat; `grouped` nests them under `subtransactions`.
- Queryable tables: `transactions`, `accounts`, `categories`, `payees`, `schedules`, etc.

---

## 6. Discovering the data model at runtime

Enumerate the instance's structure programmatically (don't hardcode IDs):

```js
const accounts = await api.getAccounts();        // [{ id, name, offbudget, closed }]
const groups   = await api.getCategoryGroups();  // groups with nested categories
const payees   = await api.getPayees();          // [{ id, name }]
const months   = await api.getBudgetMonths();    // ['YYYY-MM', ...]

// account balances (minor units → dollars)
for (const a of accounts) {
  const balCents = await api.getAccountBalance(a.id);
  console.log(a.name, (balCents / 100).toFixed(2));
}
```

Common shapes:
- **Account:** `{ id, name, offbudget: bool, closed: bool }`
- **CategoryGroup:** `{ id, name, is_income: bool, categories: [{ id, name, ... }] }`
- **Transaction:** `{ id, account, date, amount, payee, category, notes, cleared, ... }`

---

## 7. Minimal working example

```js
const api = require('@actual-app/api');
(async () => {
  await api.init({
    dataDir: '/tmp/actual-cache',
    serverURL: process.env.ACTUAL_SERVER_URL,
    password: process.env.ACTUAL_PASSWORD,
  });
  await api.downloadBudget(process.env.ACTUAL_SYNC_ID);

  const accounts = await api.getAccounts();
  for (const a of accounts) {
    const bal = await api.getAccountBalance(a.id);   // minor units
    console.log(a.name, (bal / 100).toFixed(2));
  }
  await api.shutdown();
})();
```

Run against a macvlan server from a container in Actual's netns:
```bash
docker run --rm --network container:<actual-container> \
  -e ACTUAL_SERVER_URL=http://127.0.0.1:5006 \
  -e ACTUAL_SYNC_ID="$ACTUAL_SYNC_ID" \
  -e ACTUAL_PASSWORD="$ACTUAL_PASSWORD" \
  -v "$PWD/app.js:/app/app.js:ro" -w /app node:20 \
  bash -c 'npm i -q @actual-app/api@<server-version> && node app.js'
```

---

## 8. Gotchas / pitfalls

- **Download before querying.** Every call after `init()` needs a `downloadBudget()`/`loadBudget()` first.
- **Version-match** the API package to the server. A newer client may migrate the budget on download.
- **Amounts are integer cents.** Never use floats for money; convert only at the display boundary.
- **Writes are real + shared.** They sync to the live budget and every device. If the instance is bank-synced, that also writes here — prefer `importTransactions` (dedups) over `addTransactions` for overlapping imports. Prefer read-only or a copied budget for experiments.
- **`dataDir` is a cache.** Reuse across runs for speed; delete to force a clean re-download. Don't share one `dataDir` between concurrent processes.
- **Single writer.** Avoid concurrent mutating clients on the same budget; serialize writes.
- **macvlan reachability** (see §2).
- **Not the browser story:** the web UI needs HTTPS/`SharedArrayBuffer`; that's irrelevant to the Node API, which talks HTTP to the server directly.

---

## 9. Links

- API overview: <https://actualbudget.org/docs/api/>
- API function reference: <https://actualbudget.org/docs/api/reference>
- ActualQL: <https://actualbudget.org/docs/api/actual-ql>
- Bank sync (SimpleFIN / GoCardless): <https://actualbudget.org/docs/advanced/bank-sync>
- Self-hosting / server: <https://actualbudget.org/docs/install/docker>
- npm `@actual-app/api`: <https://www.npmjs.com/package/@actual-app/api>
- GitHub (app): <https://github.com/actualbudget/actual>
- GitHub (server): <https://github.com/actualbudget/actual-server>
- Community REST wrapper (HTTP instead of Node): <https://github.com/jhonderson/actual-http-api>

---

## 10. If you'd rather have a REST API

Actual has no built-in REST endpoints. The community **`actual-http-api`** wraps `@actual-app/api` in a Dockerized REST service — point it at your server URL, sync ID, and login password. Good option if the consuming service isn't Node.
