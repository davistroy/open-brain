# Runbook: Capture Flow Stale Alert

**Alert:** `CaptureFlowStale` (warning)
**Metric:** `openbrain_captures_total` (counter at core-api /metrics, recording rule `openbrain_captures_per_6h`)
**Rule file:** `config/prometheus/alerts/capture-flow.yml`

---

## Alert condition

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `CaptureFlowStale` | No captures ingested for 6 hours | warning |

**Note:** The application-level `pipeline-health` skill (every 6h) handles time-of-day gating (07:00-midnight active hours) and 24h suppression. This Prometheus rule fires unconditionally; the skill provides the business-hours filter.

---

## Diagnosis

### 1. Check most recent captures

```bash
# Via external API (Cloudflare tunnel)
curl -s "https://brain.troy-davis.com/api/v1/captures?limit=5" | python3 -m json.tool | head -30
```

```sql
-- Directly on homeserver DB
SELECT id, source, created_at, pipeline_status
FROM captures
WHERE deleted_at IS NULL
ORDER BY created_at DESC
LIMIT 10;
```

### 2. Check core-api health

```bash
# Internal health (Docker network)
curl -s http://homeserver.k4jda.net:3002/api/v1/captures?limit=1

# Check container
docker ps | grep core-api
docker logs open-brain-core-api-1 --tail 50
```

### 3. Check Cloudflare tunnel

The external capture endpoint goes through `brain.troy-davis.com` → Cloudflare Tunnel → core-api.

```bash
# Test the tunnel endpoint
curl -s -X POST "https://brain.troy-davis.com/api/v1/captures" \
  -H "Content-Type: application/json" \
  -d '{"content":"test capture for flow check","source":"api"}' | python3 -m json.tool
```

If you get a Cloudflare 52x error, the tunnel is down.

### 4. Check email pipeline

If only email captures are missing (other sources working), check the Cloudflare Email Worker:

- Email worker logs: Cloudflare Dashboard → Workers → `brain-email-worker`
- Sender allowlist: Dashboard → Settings → Sender Allowlist
- Check that `brain@troy-davis.com` email worker is active

### 5. Check Prometheus counter

```bash
# Has counter increased at all in the last 6h?
curl -s "http://localhost:9090/api/v1/query?query=increase(openbrain_captures_total[6h])"
```

---

## Mitigation

### Cloudflare tunnel down

1. On homeserver, check tunnel container (if using cloudflared Docker):
   ```bash
   docker ps | grep cloudflared
   docker logs cloudflared --tail 30
   docker compose restart cloudflared
   ```

2. If using systemd cloudflared:
   ```bash
   systemctl status cloudflared
   systemctl restart cloudflared
   ```

### core-api down or degraded

```bash
docker compose restart core-api
# Wait ~10s for healthcheck to pass
docker ps | grep core-api  # Status should be "healthy"
```

### False positive (expected quiet period)

If this alert fires overnight or on a vacation day when no captures are expected, it is a false positive. The `pipeline-health` skill already suppresses the Pushover notification for 24h after sending. The Prometheus alert may fire but no action is needed.

---

## Related

- `docs/runbooks/pipeline-alert.md` — if capture is flowing but pipeline is stuck
- `packages/workers/src/skills/pipeline-health.ts` — application-level capture flow check
