# Loki Log Aggregation Setup

Loki provides centralized, searchable log aggregation for all Open Brain containers. Logs flow from Docker containers through the Loki log driver into Loki, and are queryable via Grafana Explore.

## Architecture

```
Docker containers → Loki Docker log driver → Loki (port 3100) → Grafana (port 3050)
```

Loki runs as a standalone container (not in docker-compose.yml) on the `open-brain_open-brain` network. Data persists at `/mnt/user/appdata/loki/`.

## Deployment

Run the deployment script from the Open Brain directory on the homeserver:

```bash
cd /mnt/user/appdata/open-brain
bash scripts/deploy-loki.sh
```

The script handles: Loki Docker log driver plugin installation, container creation, Grafana data source configuration.

## Configuring the Docker Log Driver

After Loki is running, add a `logging` section to each service in `docker-compose.yml`:

```yaml
services:
  core-api:
    # ... existing config ...
    logging:
      driver: loki
      options:
        loki-url: "http://localhost:3100/loki/api/v1/push"
        loki-batch-size: "400"
        loki-retries: "2"
        loki-timeout: "2s"
        labels: "container_name"
```

Apply to every service that should send logs to Loki (core-api, workers, slack-bot, voice-capture, web, etc.). Then restart:

```bash
docker compose down && docker compose up -d
```

### Alternative: Daemon-level log driver

To apply Loki logging to ALL Docker containers (not just Open Brain), edit `/etc/docker/daemon.json`:

```json
{
  "log-driver": "loki",
  "log-opts": {
    "loki-url": "http://localhost:3100/loki/api/v1/push",
    "loki-batch-size": "400",
    "loki-retries": "2",
    "loki-timeout": "2s",
    "labels": "container_name"
  }
}
```

Restart Docker after this change. Note: this affects every container on the host, not just Open Brain.

## Querying Logs in Grafana

1. Open Grafana at `http://homeserver:3050`
2. Go to **Explore** (compass icon in left sidebar)
3. Select **Loki** as the data source

### Common LogQL queries

**All logs from a specific container:**
```
{container_name="open-brain-core-api"}
```

**Filter by log content (case-insensitive regex):**
```
{container_name="open-brain-workers"} |~ "(?i)error|fail"
```

**All Open Brain container logs:**
```
{container_name=~"open-brain-.*"}
```

**Pipeline stage failures:**
```
{container_name="open-brain-workers"} |= "pipeline" |= "failed"
```

**Rate of errors per container (last hour):**
```
sum by (container_name) (rate({container_name=~"open-brain-.*"} |~ "(?i)error" [5m]))
```

**JSON log parsing** (if containers emit structured JSON logs):
```
{container_name="open-brain-core-api"} | json | level="error"
```

### Tips

- Use the **Log browser** button to see all available labels (container names, etc.)
- Time range selector at top-right controls the query window
- Click any log line to expand and see all parsed fields
- Use **Live tail** mode for real-time log streaming

## Retention

Logs are retained for **30 days** (720 hours). The compactor runs every 10 minutes and enforces retention by deleting expired chunks. No manual cleanup is needed.

To change retention, edit `config/loki/loki-config.yaml`:

```yaml
limits_config:
  retention_period: 720h  # change this value
```

Then restart the Loki container:

```bash
docker restart loki
```

## Resource Usage

Loki is configured with a 512MB memory limit. On the homeserver (128GB RAM), this is negligible. Storage depends on log volume — expect roughly 50-200MB/day for the Open Brain stack at current activity levels.

## Troubleshooting

**Loki container not starting:**
```bash
docker logs loki
```

**Loki not receiving logs from a container:**
```bash
# Verify the container is using the loki log driver
docker inspect <container-name> --format '{{.HostConfig.LogConfig.Type}}'
# Should output: loki
```

**Grafana cannot reach Loki:**
- Confirm both are on the same Docker network: `docker network inspect open-brain_open-brain`
- Test from Grafana container: `docker exec grafana wget -qO- http://loki:3100/ready`

**No logs appearing despite correct driver:**
- Check Loki readiness: `curl http://localhost:3100/ready`
- Check the Loki log driver does not silently fail: `docker logs <container> 2>&1 | head` may show driver errors
