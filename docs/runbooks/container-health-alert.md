# Runbook: Container Health Alerts

**Alerts:** `container:<name>` via `raiseAlert` (critical or warning); Prometheus `ContainerDown` (critical), `ContainerRestartLoop` (warning)
**Metric:** `openbrain_container_healthy` (gauge, pushed to Pushgateway by `container-health` skill every 15min)
**Rule file:** `config/prometheus/alerts/container-health.yml`

---

## How alerts reach you

Two independent paths watch the same probes.

**1. Application path (`raiseAlert`, ADR-0005).** On every run (every 15 minutes) the `container-health` skill calls `raiseAlert` for EVERY probe, healthy ones too, with the key `container:<name>`:

- It sends **once** when a probe goes ok to bad. A probe is bad after `consecutiveFailureThreshold` (default 3, about 45 minutes) failed runs in a row.
- It sends nothing while the probe stays bad.
- It sends `Resolved: <name> unhealthy` when the probe recovers.
- A `critical` alert that stays open escalates: priority-2 Pushover, then Slack at 24 h, email at 7 d, then daily. An acknowledgement snoozes escalation for 7 days. The 07:30 `ops-digest` lists open alerts as `<name> unhealthy`.

Severity classes:

| Class | Probes | Pushover priority |
|-------|--------|-------------------|
| `critical` | `postgres`, `redis`, `core-api` | 1, escalates |
| `warning` | every other probe | 0, no escalation |

**2. Prometheus path.** `config/prometheus/alerts/container-health.yml` reads the pushed `openbrain_container_healthy` gauge.

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `ContainerDown` | `openbrain_container_healthy == 0` for 5+ minutes | critical |
| `ContainerRestartLoop` | `changes(openbrain_container_healthy[10m]) > 3` | warning |

Both rules EXCLUDE the external LLM tiers (`container!~".+-llm"`). An LLM tier can stay offline for months (Spark has been offline since August), and `ContainerDown` would page critical every hour for as long as it did. LLM tiers alert only through `raiseAlert`, once, as `warning`. The rule file in this repo is advisory; the running Prometheus reads its own copy (see #292).

### Legacy push (rollback)

While `ALERT_LEGACY_PUSH` is not `false`, and always when `ALERT_STATE_ENABLED=false`, the old priority-1 push also runs: one push on every run past the threshold. It is pinned to the probe names that existed at commit `f341ca6` (`LEGACY_MONITORED_CONTAINERS`: `core-api`, `voice-capture`, `file-ingestion`, `faster-whisper`, `jetson-llm`). Probes added later (`spark-llm`, `postgres`, `redis`) never use it, so rolling back pushes exactly as `f341ca6` did. The switches are literal values in the `workers` `environment:` block of `docker-compose.yml`.

### A down database still alerts

The failure count normally comes from the `container_health` table, which lives in the Postgres being probed. When Postgres is down, the insert and the count both fail. The skill therefore also keeps an in-process streak per probe (module-level, because every job builds a new skill instance) and uses the larger of the two counts. A database outage reaches the threshold after 3 runs even with no database to count in. While the database is down, `raiseAlert` cannot store its state either, so it fails open and re-sends the critical alert on each run until the database returns; that is deliberate.

---

## Probes

| Probe | Source | Check |
|-------|--------|-------|
| `core-api` | `DEFAULT_ENDPOINTS` | `http://core-api:3000/health` |
| `voice-capture` | `DEFAULT_ENDPOINTS` | `http://voice-capture:3001/health` |
| `file-ingestion` | `DEFAULT_ENDPOINTS` | `http://file-ingestion:8080/health` |
| `faster-whisper` | `DEFAULT_ENDPOINTS` | `http://faster-whisper:8000/health` |
| `<tier>-llm` (`jetson-llm`, `spark-llm`, ...) | `config/ai-routing.yaml` `model_tiers` | every tier with `provider: openai_compat` and a `base_url`; the URL is the `base_url` with a trailing `/v1` replaced by `/health` |
| `postgres` | skill | `SELECT 1` through the worker's database connection, 10 s timeout |
| `redis` | skill | `PING` on a short-lived client opened per run, 10 s timeout |

The LLM probes follow the routing config: adding an `openai_compat` tier adds a probe at the next run, with no code change. The name is the tier key without its `t<digit>_` prefix, plus `-llm`. A tier whose `base_url` cannot be parsed is skipped with a warning. `ollama` and `anthropic` tiers are not probed. `/health` on Jetson and Spark needs no token.

**Limit of the Redis probe.** A full Redis outage stops BullMQ, so the scheduled `container-health` job does not run and the probe cannot report it. The probe catches partial failures (Redis up for the queue but slow, refusing new connections, or failing `PING`). A full outage is covered by core-api `/health`, which checks Redis and Postgres and returns 503 when unhealthy, by the Docker healthchecks (`pg_isready`, `redis-cli ping`), and by the external synthetic monitor at `health.troy-davis.com`.

**Docker healthchecks.** `financial-ingest`, `utility-ingest`, `actual-ingest` and `cloudflared` have healthchecks so `docker compose ps` shows state for every service. The three sidecars are idle cron targets, so theirs are liveness only (the interpreter runs). `cloudflared` runs `cloudflared tunnel ready`, which queries its metrics endpoint and exits non-zero until the tunnel has a connection. None of them restarts a container on unhealthy.

**Note (v5 remediation):** the skill dropped a dead `litellm:4000` probe (litellm is a standalone shared proxy outside this stack) and added `faster-whisper:8000/health`.

---

## Diagnosis

### 1. Check Docker container status

```bash
# On homeserver
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### 2. Check container logs

```bash
# Replace <container-name> with the affected container
docker logs open-brain-<container-name>-1 --tail 100

# Or via Grafana/Loki:
# {container_name="open-brain-<container-name>-1"} | last 100 lines
```

### 3. Check for OOM kill

```bash
# On homeserver (Unraid)
dmesg | grep -i "oom-kill\|Out of memory" | tail -20

# Or check dmesg with timestamp
dmesg -T | grep -i oom | tail -20
```

### 4. Check container memory usage

```bash
docker stats open-brain-<container-name>-1 --no-stream
```

CLAUDE.md rule: all processes must stay below **1.5 GB RSS** steady-state.

---

## Mitigation

### Container is stopped or crashing

```bash
# Restart the affected container
docker compose restart <container-name>

# Monitor restart
docker logs open-brain-<container-name>-1 --follow
```

### Container is OOM-killed

1. **Check memory limits** in `docker-compose.yml` for the container's `mem_limit` setting.
2. **Check application memory usage** — look for memory leaks or unbounded caches in recent code changes.
3. **Temporary fix:** restart the container (`docker compose restart <container-name>`).
4. **Permanent fix:** reduce memory usage in application code (bounded buffers, streaming, explicit GC hints).

### Restart loop (ContainerRestartLoop)

A restart loop means the container is starting, failing quickly, restarting. This is usually a configuration or dependency issue rather than OOM.

1. **Check logs for startup errors:**
   ```bash
   docker logs open-brain-<container-name>-1 --tail 50
   ```

2. **Common causes:**
   - Missing environment variable → check `.env` and `.env.secrets` are loaded
   - Database connection failure → check postgres container is healthy
   - Redis connection failure → check redis container is healthy
   - Invalid config YAML → check `config/` directory

3. **Check if dependencies are healthy:**
   ```bash
   docker compose ps
   ```

---

## Container-specific notes

- **workers / slack-bot:** Docker healthchecks run `node -e 'process.exit(0)'` (liveness only — confirms the node runtime responds). These services have no HTTP endpoints and are **not** monitored by the `container-health` skill. Check via `docker ps` and logs, or the Prometheus `WorkersMetricsAbsent` alert (which detects a wedged event loop that still passes the exec probe).
- **web-next:** Not monitored by `container-health` skill. Availability is covered by the Cloudflare Tunnel synthetic monitor at `health.troy-davis.com` and by the external `curl https://brain.troy-davis.com` test.
- **postgres / redis:** Probed by the `container-health` skill (`SELECT 1` / `PING`, see Probes). Their Docker healthchecks (`pg_isready`, `redis-cli ping`) are visible via `docker compose ps`, and core-api `/health` reports both.
- **faster-whisper:** Monitored by the `container-health` skill (`http://faster-whisper:8000/health`, added in the v5 remediation) in addition to its own Docker healthcheck. Check via `docker ps` or `curl http://localhost:10300/health` for the host-mapped port.
- **observability services (loki, prometheus, grafana, pushgateway):** Run under `--profile observability`. Monitor with `docker compose --profile observability ps`.

---

## Related

- `packages/workers/src/skills/container-health.ts` — monitoring skill implementation
- CLAUDE.md "1.5 GB resident memory ceiling" rule
