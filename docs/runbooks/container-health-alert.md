# Runbook: Container Health Alerts

**Alerts:** `ContainerDown` (critical), `ContainerRestartLoop` (warning)
**Metric:** `openbrain_container_healthy` (gauge, pushed to Pushgateway by `container-health` skill every 15min)
**Rule file:** `config/prometheus/alerts/container-health.yml`

---

## Alert conditions

| Alert | Threshold | Severity |
|-------|-----------|----------|
| `ContainerDown` | `openbrain_container_healthy == 0` for 5+ minutes | critical |
| `ContainerRestartLoop` | `changes(openbrain_container_healthy[10m]) > 3` | warning |

**Note:** The `container-health` skill sends a Pushover alert after N consecutive failures (default 3, i.e., ~45 minutes). The `ContainerDown` Prometheus rule fires earlier (5 minutes) for Grafana visibility.

---

## Container health endpoints monitored

| Container | Health URL | Healthy response |
|-----------|-----------|-----------------|
| `core-api` | `http://core-api:3000/health` | `{"status":"healthy"}` |
| `voice-capture` | `http://voice-capture:3001/health` | `{"status":"healthy"}` |
| `voice-pipecat` | `http://voice-pipecat:8766/health` | `{"status":"healthy"}` |
| `file-ingestion` | `http://file-ingestion:8080/health` | `{"status":"healthy"}` |
| `litellm` | `http://litellm:4000/health/liveliness` | 200 OK |

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

1. **Check memory limits** in `docker-compose.yml` for the container's `deploy.resources.limits.memory` setting.
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

- **workers / slack-bot:** No HTTP health endpoints — not monitored by `container-health` skill. Check via `docker ps` and logs.
- **web (nginx):** Not monitored by `container-health` skill (external check via Cloudflare tunnel).
- **postgres / redis:** Monitored via `SystemHealthService` (internal `/health` endpoint), not `container-health` skill.

---

## Related

- `packages/workers/src/skills/container-health.ts` — monitoring skill implementation
- CLAUDE.md "1.5 GB resident memory ceiling" rule
