# Runbook: Pipeline Queue Alerts

**Alerts:** `QueueDepthHigh` (warning), `QueueFailedJobsHigh` (warning); Pushover (ADR-0005): `queue-failed|backlog|stalled:<queue>` (warning) and `embed-stall` (critical)
**Metric:** `openbrain_queue_waiting`, `openbrain_queue_failed_24h`, `openbrain_captures_stuck`, `openbrain_captures_unembedded`, `openbrain_pipeline_success_share_7d` (pushed to Pushgateway by `pipeline-health` skill every 6h). `openbrain_queue_failed` is the retained total and is informational only.
**Rule file:** `config/prometheus/alerts/pipeline.yml`

---

## Alert conditions

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `QueueDepthHigh` | `> 100` waiting jobs for 5+ minutes | warning |
| `QueueFailedJobsHigh` | `> 5` jobs failed in the last 24 h (`openbrain_queue_failed_24h`) for 2+ minutes | warning |
| `queue-failed:<queue>` (Pushover) | `>= 5` jobs failed in the last 6 h; "resolved" when the count drops below 5 | warning |
| `embed-stall` (Pushover) | any live capture with no embedding for more than 2 h, not counting `failed` ones; "resolved" when none | **critical** |

Failure counts use `ZCOUNT bull:<queue>:failed <since> +inf` (the failed set is scored by finish time), so old retained failures never keep an alert open. Flow queues keep failed jobs forever; the retained total (`LLEN`/`getJobCounts`) is not an alert input.

### `embed-stall`

Raised when `captures` holds a live row with `embedding IS NULL`, created more than 2 hours ago, and `pipeline_status` not `failed`/`deleted`. The message gives the count, the oldest stalled capture, and the last embedding activity. Typical causes: OpenAI key or credits exhausted (the 2026-08 outage), the `embed-capture` queue stalled, or workers down.

1. Check the provider: `docker logs open-brain-workers --since 1h | grep -i embed`. A `401`/`429`/`insufficient_quota` means the key or credits.
2. Check the queue: `LLEN bull:embed-capture:wait`, `ZCARD bull:embed-capture:failed`.
3. After fixing the cause, the daily sweep (03:00) re-queues stranded captures; to recover sooner run the re-embed script from `docs/runbooks/` (item 1.2) and watch `openbrain_captures_unembedded` fall.
4. The alert clears on the next `pipeline-health` run (every 6 h) once nothing is stalled.

`openbrain_captures_stuck` (captures at `pending`/`processing`/`extracted` for more than 24 h) is a gauge for the dashboard and the daily digest; it does not page.

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
