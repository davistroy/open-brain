# Design — Actual Budget daily job (`actual-ingest` sidecar)

**Date:** 2026-07-15
**Status:** Approved (design); implementation pending
**Related:** LAB_NOTEBOOK Entries 207–208 · D141 · #295 · #292 · OA register

> **DATA-HANDLING NOTE.** The repo is **PUBLIC**. Balances, amounts, merchant/payee names,
> account names, the Actual sync ID, server host/URL, and credentials are **deliberately
> absent from this document**. They live only in the gitignored
> `docs/ACTUAL_BUDGET_DEVELOPER_GUIDE.md` and in Bitwarden. Keep it that way when editing.

---

## 1. Objective

Run one job daily at **06:00 America/New_York** that:

1. Refreshes accounts from the bank (`api.runBankSync()` — the budget is SimpleFIN-synced).
2. Categorizes newly-arrived uncategorized transactions using a **T0 rules table** (no LLM).
3. Sends a **Pushover** summary: total balance across accounts + notable changes.
4. Ingests **one aggregated daily capture** into open-brain.

Success: the capture lands each morning, the Pushover arrives, and no transfer or investment-internal
row is ever categorized.

## 2. Why this cannot live in `workers`

Four independent blockers, each verified rather than assumed:

| Blocker | Evidence |
|---|---|
| `workers` cannot reach the Actual server | `Host is unreachable` — Actual is a **macvlan** (`br0`) container, and a host cannot reach its own macvlan IP, so neither can a bridge container routed through that host |
| `@actual-app/api` needs **glibc** | `better-sqlite3` ships glibc prebuilds; the workers image is **Alpine/musl** |
| BullMQ slot `0 6` is taken | `wiki-synthesis`; `scheduler-slots.test.ts` enforces uniqueness in CI |
| BullMQ cron runs **UTC** | #295 — `scheduler.ts` passes no `tz`, so "6am" would fire at 02:00 ET |

## 3. Architecture

A new **`actual-ingest`** sidecar: its own image, dual-homed, driven by host cron.

```
                 br0 (macvlan)                    open-brain (bridge)
  actualbudget  <──── eth0 ──── [ actual-ingest ] ──── eth1 ────>  core-api
   (DNS name)                    node:22-slim                       /api/v1/captures
                                 static .13
```

### 3.1 Networking — proven, not assumed

A throwaway probe container attached to **both** `br0` (macvlan) and `open-brain` (bridge) was run
live on the homeserver. Result:

- `eth0` on `br0` → reached Actual **by IP and by DNS name `actualbudget`**
- `eth1` on `open-brain` → reached `core-api`, returning `{"status":"healthy"}`

Both directions work from one container. **Use the DNS name, never a hardcoded IP.**

**IP allocation:** `br0` declares the whole `/24` with **no `ip-range`**, so Docker's auto-IPAM could
hand out an address that collides with a real DHCP client on the LAN. Every existing `br0` container
therefore has a **hand-assigned static IP**. The sidecar follows that convention with a static address
in the low static block (verified unclaimed: no ping response, ARP `INCOMPLETE`), well below the DHCP pool.

`br0` is **not declared in this repo's compose** — it must be added as `external: true`.

### 3.2 Image — a new one, deliberately

`node:22-slim` (Debian/glibc, matching the repo's Node 22 LTS rule).

**Not** an extension of `docker/ingest-sidecar/`: that image is Python (`python:3.12-slim`), and
`@actual-app/api` is Node-only. More importantly, `ingest-sidecar:latest` is **already shared by two
services** — the exact configuration that let `financial-ingest` sit on a 2-month-stale image
(Entry 201, D140). Adding a third consumer would deepen that trap. A separate image keeps the
blast radius at one service.

### 3.3 Scheduling — host cron, not BullMQ

The homeserver's TZ is **`America/New_York`**, so a host cron `0 6 * * *` fires at **6am Eastern
natively**. This sidesteps #295 entirely rather than depending on its fix. The BullMQ `0 6` collision
is irrelevant — the slot registry governs repeatable jobs inside `workers`, a different scheduler.

Pattern matches the two existing sidecars: long-running container + `docker exec` from host cron.

> **The cron line is NOT deployed by committing it.** `deploy/cron/unraid-ingest.cron` is a
> *template*; it is installed by hand as root into `/boot/config/plugins/dynamix/custom.cron` +
> `update_cron`. This was verified: two entries present in the template (`--balances`,
> `--account-monitoring`) are **not installed on the host**. Therefore the install step gets a dated
> **`OPERATOR_ACTIONS.md`** entry, not just a commit.

## 4. The payee rules (T0)

### 4.1 Location

**`config/payee-rules.yaml`** — gitignored, **exists only on the homeserver**, bind-mounted read-only
via the established `./config:/app/config:ro`.

The rules contain real merchant names, which constitute a spending profile (some entries are directly
identifying — a club, a health provider, a dealership). They cannot go in a public repo.

Two deliberate properties, each answering a known weakness of a gitignored file:

- **DR-survivable at no cost.** `scripts/backup.sh:90-91` copies `config/*.yaml` — a **non-recursive**
  glob. A file at `config/actual/payee-rules.yaml` would be **silently skipped** (the `cp` is
  `2>/dev/null || true`). Placing it at the **top level of `config/`** makes it match the existing
  glob, so it rides the proven backup + encrypted-offsite path with **zero changes to backup.sh**.
- **Drift-proof by having one copy.** The file lives **only on the homeserver**, exactly like
  `.env.secrets`. There is no laptop copy, so the two cannot diverge — the failure mode behind
  #292, #290, #278 and Entry 201.

The repo ships a tracked **`config/payee-rules.example.yaml`** with **synthetic** payees, serving as
the schema, the loader's test fixture, and the DR reference.

### 4.2 Schema

Ordered — **first match wins**. Exclusions are evaluated before rules.

```yaml
exclude_transfer:    [ <substring>, ... ]   # never categorized (see §5)
exclude_investment:  [ <substring>, ... ]   # never categorized (see §5)
rules:
  - category: <existing or created category name>
    match:   [ <lowercase substring>, ... ]
```

Matching is `payee.toLowerCase().includes(key)`, against `payee_name` falling back to
`imported_payee`.

### 4.3 Failing loud

A missing or malformed rules file **aborts the run with a non-zero exit**. It must never degrade to
"categorize everything as General" on a run that still reports success — that combination is what hid
the gas-therms bug for months (#275). Same principle: a parse miss is an **error**, not a warning.

## 5. The invariant that shapes everything

**Zero of the budget's transactions are linked as transfers.** Naive categorization would invent tens
of thousands of dollars of phantom income (credit-card *payments* read as income) and treat brokerage
mechanics as spending.

Therefore:

- **Transfer-like payees** (card payments, peer-to-peer, bank↔brokerage moves, checks) → **left uncategorized**.
- **Investment internals** (fund buys, contributions, dividends, opening/closing values) → **left uncategorized**.
- Genuine transfer **pairs** exist. **Linking them is out of scope** — mis-linking is harder to undo
  than a category.

This is enforced in code by evaluating both exclusion lists **before** any rule, and is covered by
unit tests using synthetic payees.

### 5.1 Unmatched payees — report, never guess

A payee matching **no** rule and **no** exclusion is **left uncategorized** and **reported** (count +
names in the Pushover and the capture). It is not assigned a fallback category.

Entry 207 anticipated a T1/Spark fallback for new payees. **Deferred, by decision (D141):** a wrong
category is worse than none, and reporting is simpler, cheaper and safer. Spark remains easy to add
later behind the same interface. This keeps the recurring job at **T0 — no LLM, no API spend.**

## 6. Alerting

Bar: **any single transaction > $500** OR **any account balance moving > 5%**.

The balance-move test needs prior state → a small JSON state file (last-run balances per account) in a
**named volume**. First run has no baseline: it records state and reports **no** balance alerts
(it must not fire N false alerts on day one).

Pushover keys come from the environment (see §7). Delivery follows the existing pipeline pattern:
notification failure is logged, never fatal.

## 7. Secrets — via the lockstep, not `bws` in the image

The Actual **password**, **sync ID**, and **server URL** are all sensitive, and `docker-compose.yml`
is **tracked**. None may appear in compose.

They arrive as environment variables through the **proven 3-step lockstep**:

1. Bitwarden secret
2. `deploy/.env.secrets.template` (operator inventory)
3. `scripts/lib/secrets-map.sh` (BWS-name → ENV-var map)

→ consumed via `env_file: .env.secrets`.

This avoids baking the `bws` binary **and** a `BWS_ACCESS_TOKEN` into a new image (the existing
Python sidecar does both; not a reason to repeat it).

> **Known adjacent debt (not fixed here):** `INGEST_TRIGGER_SECRET` violates this same lockstep today
> — it appears in 14 files but in **neither** `secrets-map.sh` nor `.env.secrets.template`, so a DR
> rebuild would start the existing sidecars with an empty secret. Tracked separately; noted so the new
> secrets are not modelled on it. See also A142 (#278).

## 8. Ingest

**One aggregated capture per day** — never per-transaction (the CLAUDE.md aggregation rule; per-tx
would flood the pipeline).

- `POST http://core-api:3000/api/v1/captures` over the `open-brain` bridge (not the public URL —
  Cloudflare Access 302s unauthenticated POSTs).
- `X-Open-Brain-Caller: actual-pipeline`.
- **`actual-pipeline` MUST be added to `BYPASS_CALLERS`** in
  `packages/core-api/src/middleware/rate-limit.ts`. Missing it = silent 429s under burst.
- Payload: `{ content, source: 'api', capture_type: 'observation', brain_view: 'personal', metadata }`.
- Content = balances + **notable** transactions + category rollup + unmatched-payee report, where
  **notable** means exactly the §6 alert bar (single tx > $500, or an account balance move > 5%) —
  the same set that drives the Pushover, so the two never disagree.

**The capture may contain amounts and payee names.** The data rule governs the *public repo*, not
Troy's private Postgres — putting this information into the brain is the entire point of the job.

Idempotency: content is date-stamped, so a same-day re-run is a duplicate. A `409` from core-api is
**terminal success**, not a retry (the voice-spool lesson, v5/P4).

## 9. Error handling

| Failure | Behavior |
|---|---|
| Rules file missing/malformed | **Abort, non-zero exit** (§4.3) |
| `downloadBudget` transient `UND_ERR_SOCKET` | Retry (known transient) |
| `runBankSync` fails | Continue with existing data; **report the failure** in Pushover + capture |
| Categorization write fails | Collect, continue, re-throw at end (per-item fault isolation, the v5/P1 retention pattern) |
| core-api unreachable | Non-zero exit; cron log retains it |
| core-api `409` | Terminal **success** |
| Pushover fails | Log; never fatal |

**Never run two Actual clients against one `dataDir`** → `SQLITE_BUSY`. The container is the only
client and runs once daily; concurrent `docker exec` is the operator's responsibility.

## 10. Testing

Unit-testable in isolation, no network, no Actual instance, **synthetic payees only**:

- **Rules loader** — parse, schema validation, malformed → throws.
- **`classify()`** — order/first-match-wins; exclusions beat rules; unmatched → `null`, never a fallback.
- **The invariant (§5)** — a transfer-like and an investment-like payee are **never** categorized.
  This is the phantom-income guard and gets an explicit named test.
- **Alert logic** — >$500 boundary; >5% boundary; **first run emits no balance alerts**.
- **Capture builder** — one capture; contains the unmatched-payee report.

Live verification after deploy: run once by hand, confirm the capture exists, confirm Pushover
arrives, confirm the uncategorized count still equals transfers + investment internals.

## 11. Out of scope

- Linking transfer pairs (§5) — separate, riskier work.
- T1/Spark classification of new payees (§5.1) — deferred, D141.
- Fixing `INGEST_TRIGGER_SECRET` (§7) or the `backup.sh` non-recursive glob (§4.1) — filed separately.
- Backfilling history — the one-time categorization is already done.

## 12. Deliverables

| # | Item |
|---|---|
| 1 | `docker/actual-sidecar/Dockerfile` (`node:22-slim`) |
| 2 | `scripts/actual/actual-daily.mjs` — entrypoint |
| 3 | `scripts/actual/lib/{rules,classify,alerts,capture}.mjs` — testable units |
| 4 | `config/payee-rules.example.yaml` (tracked, synthetic) + `.gitignore` for the real file |
| 5 | `docker-compose.yml`: `actual-ingest` service + `br0` as `external: true` + named state volume |
| 6 | `rate-limit.ts`: `actual-pipeline` in `BYPASS_CALLERS` |
| 7 | Secrets lockstep: 3 entries (password, sync ID, server URL) |
| 8 | `deploy/cron/unraid-ingest.cron`: the `0 6` line |
| 9 | Unit tests (§10) |
| 10 | `OPERATOR_ACTIONS.md`: dated entries — install cron as root; create `config/payee-rules.yaml` on host; add BWS secrets |
| 11 | `docs/runbooks/actual-daily.md` |
