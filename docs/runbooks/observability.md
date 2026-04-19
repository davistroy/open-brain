# Observability Stack Runbook

**Services:** Loki, Prometheus, Grafana, Pushgateway  
**Profile:** `observability`  
**Managed via:** `docker-compose.yml` (P12 — IaC consolidation)

---

## Architecture

```
app containers (13) ──loki log driver──> Loki (3100) ──> Grafana (3050)
                                                              ^
core-api /metrics ──> Prometheus (9090) ──────────────────────┘
workers metrics ──> Pushgateway (9091) ──> Prometheus
```

All four observability services run on the `open-brain` Docker network under the `observability` compose profile and are co-located with the application stack.

---

## Prerequisites (one-time, per Docker host)

The Loki Docker log driver plugin must be installed on the Docker daemon before starting the stack. This is a host-level operation — Docker Compose cannot install plugins.

```bash
docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
```

Verify:
```bash
docker plugin ls | grep loki
```

This was already performed on the homeserver as part of P11a. Only needed again after a full OS rebuild.

---

## Bring-up

```bash
docker compose --profile observability up -d
```

Expected: 4 new containers start and pass healthchecks within 60 seconds.

Verify each service is healthy:

```bash
curl -s http://localhost:9090/-/healthy     # Prometheus
curl -s http://localhost:3100/ready         # Loki
curl -s http://localhost:3050/api/health    # Grafana
curl -s http://localhost:9091/-/healthy     # Pushgateway
```

All should return HTTP 200.

---

## Grafana password

The Grafana admin password is set via the `GRAFANA_ADMIN_PASSWORD` environment variable in `.env.secrets`. Store it in Bitwarden:

- **Bitwarden item:** `open-brain-grafana-admin-password`
- **Env var:** `GRAFANA_ADMIN_PASSWORD`

If `GRAFANA_ADMIN_PASSWORD` is not set, Grafana defaults to `admin` — change this immediately on first login.

---

## Cutover from standalone containers

If the homeserver currently runs Loki, Prometheus, Grafana, and Pushgateway as standalone containers (started via `docker run` or `scripts/deploy-loki.sh`), follow these steps to migrate to compose management.

### Step 1: Migrate Grafana password

Retrieve the current password from the running standalone Grafana container:

```bash
docker exec grafana env | grep GF_SECURITY_ADMIN_PASSWORD
```

Store it in Bitwarden under `open-brain-grafana-admin-password` and add it to `.env.secrets`.

### Step 2: Migrate Loki log history (optional)

The standalone Loki container stored its data at `/mnt/user/appdata/loki/`. To preserve log history, copy the data into the new `loki_data` named volume before the first compose-up:

```bash
# Start a temporary container to get the volume mount point
docker run --rm -v open-brain_loki_data:/loki/data alpine sh -c \
  "cp -r /mnt/user/appdata/loki/. /loki/data/"
```

Or simply accept a clean start — historical logs are in the standalone container until it is stopped.

### Step 3: Stop standalone containers

```bash
docker stop loki prometheus grafana pushgateway
docker rm loki prometheus grafana pushgateway
```

Do **not** remove volumes at this stage — they serve as a fallback if rollback is needed.

### Step 4: Start compose profile

```bash
docker compose --profile observability up -d
```

### Step 5: Verify

```bash
# All four containers healthy
docker compose ps --profile observability

# Prometheus targets healthy (including core-api and pushgateway)
curl -s http://localhost:9090/api/v1/targets | python3 -m json.tool | grep '"health"'

# Grafana dashboards load
curl -s http://localhost:3050/api/health
```

### Step 6: Update LOKI_URL in .env.secrets

The 13 application services use `${LOKI_URL:-http://loki:3100/loki/api/v1/push}` as the log driver URL. Once Loki is in compose on the same Docker network, the default `loki:3100` is correct. If `LOKI_URL` was previously set in `.env.secrets` to `http://homeserver.k4jda.net:3100/...`, either remove it (to use the new default) or update it to `http://loki:3100/loki/api/v1/push`.

After changing `LOKI_URL`, application containers must be recreated (not just restarted) for the new log driver URL to take effect:

```bash
docker compose up -d --force-recreate
```

---

## Tear-down (stop without data loss)

```bash
docker compose --profile observability stop
```

This stops the containers but preserves the named volumes (`prometheus_data`, `grafana_data`, `loki_data`). Data is intact for restart.

To also remove containers (volumes still preserved):

```bash
docker compose --profile observability down
```

---

## Alert rules

Prometheus loads alert rules from `config/prometheus/alerts/*.yml` (5 rule files from P11b):

| File | Alerts |
|------|--------|
| `budget.yml` | AI cost budget breach (soft/hard) |
| `capture-flow.yml` | No captures in 6h during active hours |
| `container-health.yml` | Container down / OOM |
| `integration.yml` | Integration error rate elevated |
| `pipeline.yml` | Pipeline failure rate / queue depth |

To reload alert rules without restarting Prometheus:

```bash
curl -X POST http://localhost:9090/-/reload
```

To validate rule files locally:

```bash
bash scripts/validate-alert-rules.sh
```

---

## Rollback

If the compose-managed stack fails and the standalone containers still exist:

```bash
# Stop compose profile
docker compose --profile observability stop

# Restart standalone containers
docker start loki prometheus grafana pushgateway
```

The standalone containers retain their original data. No configuration changes are required — they use host bind-mounts to `/mnt/user/appdata/{loki,prometheus,grafana}/`.

If the standalone containers were removed, restore from `git log` — the full `docker run` parameters are in the history of `scripts/deploy-loki.sh` (deleted in P12 but preserved in git).

---

## Data volume locations

| Volume | Contents | Host path (homeserver standalone) |
|--------|----------|-----------------------------------|
| `loki_data` | Log chunks, TSDB index, compactor state | `/mnt/user/appdata/loki/` |
| `prometheus_data` | TSDB metrics history | Varies — check `docker inspect prometheus` |
| `grafana_data` | User preferences, alert silences | Varies — check `docker inspect grafana` |

Dashboards and datasources are provisioned-as-code (`config/grafana/provisioning/`) — they do not need data migration. Only user preferences and alert silence configuration are in `grafana_data`.
