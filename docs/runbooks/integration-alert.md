# Runbook: Integration Quota Alerts

**Alerts:** `ComposioQuotaWarning` (warning), `ComposioQuotaCritical` (critical)
**Metric:** `openbrain_composio_monthly_usage` (gauge, refreshed from Redis per Prometheus scrape)
**Rule file:** `config/prometheus/alerts/integration.yml`

---

## Alert conditions

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `ComposioQuotaWarning` | `>= 15,000` calls this month (75% of 20K free tier) | warning |
| `ComposioQuotaCritical` | `>= 19,000` calls this month (95% — hard stop imminent) | critical |

**Note:** `ComposioClient.execute()` also sends a Pushover alert on the exact call that crosses 15K (edge-triggered). These Prometheus rules add level-triggered monitoring for persistent Grafana visibility.

---

## Diagnosis

### 1. Check current month usage

```bash
# On homeserver via Redis
docker compose exec redis redis-cli -p 6380 GET "composio:monthly_usage:$(date +%Y-%m)"
```

### 2. Check Prometheus gauge value

```bash
curl -s "http://localhost:9090/api/v1/query?query=openbrain_composio_monthly_usage"
```

### 3. Identify which tools are using Composio

Composio usage comes from `ComposioClient.execute()` calls. Search the codebase for call sites:

```bash
grep -rn "composio.execute\|ComposioClient\|composio.run" packages/ --include="*.ts"
```

Key consumers as of P03:
- `packages/workers/src/jobs/` — email, calendar, Notion operations
- OpenClaw skills at `~/.openclaw/workspace/skills/` (not in this repo)

---

## Mitigation

### Warning level (15K+)

1. **Identify the high-volume operation.** Check the Composio dashboard for tool breakdown (app.composio.dev → Logs).

2. **Switch high-volume operations to direct API:**
   - Per CLAUDE.md: reads + < 50 calls/day → Composio OK. Writes + bulk ops → use direct API.
   - Email operations: switch to MSAL Graph API direct (`packages/shared/src/services/` graph client if available)
   - Calendar: switch to Google Calendar API direct
   - OneDrive: already using rclone (no Composio)

3. **Reduce call frequency** — batch operations instead of per-item calls.

### Critical level (19K+)

4. **`ComposioClient.execute()` will start throwing `ComposioQuotaError`** for new calls.
   Services that catch this error will degrade gracefully (skip the Composio action).

5. **Wait for monthly reset** (1st of next month) — the Redis counter `composio:monthly_usage:YYYY-MM`
   is key-per-month; a new month starts a new key automatically.

6. **Emergency: reset the counter** (use only if you have confirmed the excess usage was erroneous):
   ```bash
   docker compose exec redis redis-cli -p 6380 SET "composio:monthly_usage:$(date +%Y-%m)" 0
   ```
   This will re-enable Composio calls but does NOT reset your Composio plan usage — check the Composio dashboard to verify actual consumption.

---

## Prevention

- All new Composio call sites in `workers/main.ts` MUST pass Redis + Pushover to `ComposioClient`
  (without these, the quota meter is inactive — silent overrun).
- Review Composio dashboard (app.composio.dev) monthly for unexpected tool usage.
- Per CLAUDE.md: Composio free tier is 20K/month — treat it as a shared resource across all operations.

---

## Related

- `packages/shared/src/services/composio-client.ts` — quota meter implementation
- CLAUDE.md "Composio quota meter (P03)" operational rule
