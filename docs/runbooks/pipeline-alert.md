# Runbook: Pipeline Queue Alerts

**Alerts:** `QueueDepthHigh` (warning), `QueueFailedJobsHigh` (warning)
**Metric:** `openbrain_queue_waiting`, `openbrain_queue_failed` (pushed to Pushgateway by `pipeline-health` skill every 6h)
**Rule file:** `config/prometheus/alerts/pipeline.yml`

---

## Alert conditions

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `QueueDepthHigh` | `> 100` waiting jobs for 5+ minutes | warning |
| `QueueFailedJobsHigh` | `> 5` failed jobs for 2+ minutes | warning |

---

## Diagnosis

### 1. Check queue state via Grafana

Open Grafana → "Open Brain — Pipeline Health" dashboard → "Queue Depth by Queue" panel.

### 2. Check queue state via Redis directly

```bash
# On homeserver — check all queues
docker compose exec redis redis-cli -p 6380

# Inside redis-cli:
# List waiting jobs in each queue
LLEN bull:embed-capture:wait
LLEN bull:capture-pipeline:wait
LLEN bull:extract-entities:wait
LLEN bull:link-entities:wait
LLEN bull:wiki-ingest:wait

# List failed jobs
LLEN bull:embed-capture:failed
LLEN bull:capture-pipeline:failed
```

### 3. Check workers container logs

```bash
# On homeserver
docker logs open-brain-workers-1 --tail 100
# Or via Grafana/Loki: {container_name="open-brain-workers-1"} | last 100 lines
```

### 4. Check if workers are running

```bash
docker ps | grep workers
```

---

## Mitigation

### Queue depth high

1. **If workers container is stopped or crashed:** restart it.
   ```bash
   docker compose restart workers
   ```

2. **If workers are running but slow:** check for LLM API timeout or quota issue.
   Inspect the job payload for the stuck queue:
   ```bash
   # View waiting job payloads (first 3)
   docker compose exec redis redis-cli -p 6380 LRANGE bull:embed-capture:wait 0 2
   ```

3. **If queue depth is from a bulk ingest operation:** this is expected behavior.
   Monitor the drain rate in Grafana. No action needed unless depth is growing.

4. **Emergency: clear a queue** (destructive — jobs will be lost):
   ```bash
   docker compose exec redis redis-cli -p 6380 DEL bull:<queue-name>:wait
   ```
   Only do this if jobs are known to be stale/invalid and you are willing to re-ingest.

### Failed jobs high

1. **Let the daily auto-sweep handle it.** The `daily-sweep` job at 03:00 re-queues stale failed captures.

2. **If you need immediate recovery:**
   ```bash
   # Trigger daily-sweep manually via dashboard
   # Dashboard → Skills → Run "daily-sweep"
   ```

3. **Investigate the root cause** of failures before re-queuing:
   ```bash
   # View failed job data
   docker compose exec redis redis-cli -p 6380 LRANGE bull:embed-capture:failed 0 2
   ```

---

## Related

- `docs/runbooks/capture-flow-alert.md` — if queue is empty but no captures are flowing
- `packages/workers/src/skills/pipeline-health.ts` — monitoring skill
- `packages/workers/src/jobs/` — individual job handlers
