# Runbook: actual-ingest (Actual Budget daily job)

**Issue:** #311 · **Design:** `docs/superpowers/specs/2026-07-15-actual-daily-job-design.md` · **Decisions:** D141 (report unmatched, no LLM), D142 (static IP literal)

**What it does:** once daily at **06:00 America/New_York** (host cron), the `actual-ingest` sidecar runs `runBankSync`, T0-categorizes newly-arrived uncategorized transactions from a rules table, sends a Pushover summary, and posts **one aggregated capture** to open-brain.

> **DATA RULE.** The repo is PUBLIC. Balances, amounts, payee names, the Actual sync ID, and server URL live only in Bitwarden + the host-only `config/payee-rules.yaml` + Troy's private Postgres. Never put them in the repo, this runbook, or a commit.

---

## Architecture (one glance)

```
   br0 (macvlan)                       open-brain (bridge)
 actualbudget  ── eth0 ── [ actual-ingest ] ── eth1 ──▶ core-api
  (DNS name)              node:22-slim, .13          /api/v1/captures
```

- **Its own image** `ghcr.io/davistroy/open-brain/actual-ingest:latest` — NOT the shared `ingest-sidecar` tag (D140/Entry 201 trap).
- **Dual-homed:** br0 reaches the Actual server *by DNS name* `actualbudget`; open-brain reaches core-api. `br0` is `external: true` (never `compose down` a file that owns it).
- **Static IP `192.168.10.13`** is a compose literal (D142); br0 has no `ip-range`, so confirm the DHCP pool floor sits above it (OA-21).
- **Long-running container, host-cron-driven:** `docker exec open-brain-actual-ingest node /app/actual-daily.mjs`.

---

## Code map

| Path | Role |
|------|------|
| `scripts/actual/actual-daily.mjs` | thin wiring: env, fs, fetch, `@actual-app/api` lifecycle → `runDaily()` |
| `scripts/actual/lib/rules.mjs` | load + validate `payee-rules.yaml`; malformed → **abort** |
| `scripts/actual/lib/classify.mjs` | `classify(payee, rules)` — exclusions BEFORE rules; unmatched → `null` |
| `scripts/actual/lib/alerts.mjs` | notable tx (>$500) + balance moves (>5%); first-run = no baseline |
| `scripts/actual/lib/capture.mjs` | build the one date-stamped capture |
| `scripts/actual/lib/run-daily.mjs` | orchestration (unit-tested with injected deps) |
| `config/payee-rules.example.yaml` | tracked, synthetic — the schema + fixture |
| `config/payee-rules.yaml` | **host-only, gitignored** — real merchant rules |

The money-correctness logic is fully unit-tested (`scripts/actual/test/`, CI job `actual-ingest-test`). The entrypoint is I/O wiring, verified live after deploy.

---

## The invariant (why this job is careful)

**Zero transactions are linked as transfers.** Naive categorization would invent phantom income (credit-card *payments* read as income) and treat brokerage mechanics as spending. So `classify()` evaluates two exclusion lists (`exclude_transfer`, `exclude_investment`) **before** any category rule — a transfer/investment payee is NEVER categorized. An unmatched payee is **reported, never guessed** (D141): it shows up in the Pushover + capture so you add a rule. A missing/malformed rules file **aborts the run** — it never degrades to "categorize everything" on a run that reports success (#275).

---

## First deploy (operator — OA-18 … OA-21)

Prereqs, in order:

1. **BWS secrets (OA-20).** Confirm the real `.key` names in Bitwarden project `ai-work` (item "Actual Budget — My Finances") with `bws secret list`, then reconcile `scripts/lib/secrets-map.sh` (the placeholders `actual-budget-{password,sync-id,server-url}` are marked ⚠️) and `deploy/.env.secrets.template`. Rebuild `.env.secrets`:
   ```bash
   export BWS_ACCESS_TOKEN=...
   bash scripts/load-secrets.sh --target-dir /mnt/user/appdata/open-brain
   bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain
   ```
2. **Payee rules (OA-19).** Create `config/payee-rules.yaml` on the homeserver (host-only, gitignored) from `config/payee-rules.example.yaml`, with real merchant substrings. Top-level location is deliberate (rides `backup.sh`'s glob).
3. **DHCP floor (OA-21).** Confirm the router's DHCP pool floor is **above** `192.168.10.13`.
4. **Deploy the compose change.** `docker-compose.yml` gained the `actual-ingest` service + the external `br0` network. This is a compose change → it needs the **reconciliation window (#302)**, NOT a bare recreate — see `docs/runbooks/deploy.md`. Adopt main's compose, re-apply the documented deviations, run the two-gate config-diff, then:
   ```bash
   sudo docker compose -f docker-compose.yml -f docker-compose.override.yml pull actual-ingest
   sudo docker compose -f docker-compose.yml -f docker-compose.override.yml up -d --no-deps actual-ingest
   ```
   🚨 Always pass `-f docker-compose.override.yml` (postgres/redis binds). NEVER `--remove-orphans`, NEVER a bare `up -d`, NEVER `compose down` (it owns `br0`).
5. **Install the cron (OA-18).** `deploy/cron/unraid-ingest.cron` has the `0 6` line, but **committing it schedules nothing** — install as root:
   ```bash
   ssh root@homeserver.k4jda.net
   # append the actual-ingest line to /boot/config/plugins/dynamix/custom.cron, then:
   /usr/local/sbin/update_cron
   ```

---

## Live verification (spec §10)

```bash
# 1. Container up + dual-homed
sudo docker inspect open-brain-actual-ingest --format '{{json .NetworkSettings.Networks}}' | python3 -m json.tool

# 2. Reaches Actual (DNS) and core-api
sudo docker exec open-brain-actual-ingest node -e "fetch('http://core-api:3000/api/v1/captures?limit=1').then(r=>console.log('core-api',r.status))"

# 3. Run it by hand and read the log
sudo docker exec open-brain-actual-ingest node /app/actual-daily.mjs
sudo tail -50 /var/log/actual-ingest.log   # after the cron path exists

# 4. Confirm the capture landed (source=api, caller=actual-pipeline) and the Pushover arrived.
# 5. Sanity: the uncategorized count still equals (transfers + investment internals) — the invariant.
```

---

## Common failures

| Symptom | Cause / fix |
|---------|-------------|
| Exit 1, `cannot read payee rules` | `config/payee-rules.yaml` missing on host (OA-19) — abort is intentional (§4.3). |
| Exit 1, `missing required env ACTUAL_*` | Secrets not in `.env.secrets` — redo OA-20 (verify real BWS `.key`). |
| Capture 429s | `actual-pipeline` missing from `BYPASS_CALLERS` (`rate-limit.ts`) — it is added; confirm the deployed core-api has it. |
| `Host is unreachable` to Actual | br0 attachment missing/mis-IP'd, or the Actual server moved. Check `docker inspect` networks; reach it by DNS name, not IP. |
| Everything categorized as nothing / unmatched flood | rules file not mounted — confirm `./config:/app/config:ro` and `ACTUAL_RULES_PATH`. |
| Duplicate capture on re-run | expected — content is date-stamped; a 409 is terminal success. |
| Balance alerts on day one | should not happen (first run records state, emits none). If it does, the state volume was wiped. |

---

## Tuning (env, all optional, defaults in the Dockerfile/compose)

`ACTUAL_NOTABLE_USD` (500) · `ACTUAL_BALANCE_PCT` (0.05) · `ACTUAL_LOOKBACK_DAYS` (7) · `ACTUAL_CATEGORY_GROUP` (the group new categories are created under; defaults to the first non-income group).
