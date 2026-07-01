# Open Brain — Deploy Runbook

**Applies to:** Homeserver production deployments (Unraid, `/mnt/user/appdata/open-brain/`)
**Images:** `ghcr.io/davistroy/open-brain/*:latest`
**Registry:** GitHub Container Registry (GHCR)
**Repo:** `github.com/davistroy/open-brain`

---

## Service and image inventory

| Container | Image | Port(s) |
|-----------|-------|---------|
| `open-brain-postgres` | `pgvector/pgvector:pg16` | `127.0.0.1:5432` |
| `open-brain-redis` | `redis:7.4-alpine` | `127.0.0.1:6380` |
| `open-brain-core-api` | `ghcr.io/davistroy/open-brain/core-api:latest` | `127.0.0.1:3002`, `<tailscale-ip>:3002` |
| `open-brain-workers` | `ghcr.io/davistroy/open-brain/workers:latest` | — |
| `open-brain-slack-bot` | `ghcr.io/davistroy/open-brain/slack-bot:latest` | — |
| `open-brain-voice-capture` | `ghcr.io/davistroy/open-brain/voice-capture:latest` | `0.0.0.0:3001` |
| `open-brain-web-next` | `ghcr.io/davistroy/open-brain/web-next:latest` | `0.0.0.0:3003` |
| `open-brain-voice-pipecat` | `ghcr.io/davistroy/open-brain/voice-pipecat:latest` | `8765`, `8766` |
| `open-brain-file-ingestion` | `ghcr.io/davistroy/open-brain/file-ingestion:latest` | `127.0.0.1:8080` |
| `open-brain-financial-ingest` | `ghcr.io/davistroy/open-brain/ingest-sidecar:latest` | — |
| `open-brain-utility-ingest` | `ghcr.io/davistroy/open-brain/ingest-sidecar:latest` | — |
| `open-brain-faster-whisper` | `fedirz/faster-whisper-server:0.5.0-cpu` | `127.0.0.1:10300` |
| `open-brain-cloudflared` | `cloudflare/cloudflared:2025.6.1` | — |
| `open-brain-loki` | `grafana/loki:3.4.3` | `127.0.0.1:3100` (observability profile) |
| `open-brain-pushgateway` | `prom/pushgateway:v1.11.0` | `127.0.0.1:9091` (observability profile) |
| `open-brain-prometheus` | `prom/prometheus:v3.4.2` | `127.0.0.1:9090` (observability profile) |
| `open-brain-grafana` | `grafana/grafana:12.0.2` | `0.0.0.0:3050` (observability profile) |

**App images** (8 `ghcr.io/davistroy/open-brain/*` packages): core-api, workers, slack-bot, voice-capture, web-next, voice-pipecat, file-ingestion, ingest-sidecar (shared by financial-ingest and utility-ingest).

> **Note:** `.env.secrets` is root-owned (chmod 600) on the homeserver. All `docker compose` commands must be run as root.

---

## 1. One-time GHCR authentication setup (homeserver)

Required once per homeserver Docker daemon. Images are published as private packages.

**Create a GitHub fine-grained PAT:**

1. Go to `github.com` → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Click "Generate new token"
3. Set scope: **Repository permissions — Packages: Read**
4. Copy the token value

**Store in Bitwarden and configure Docker on homeserver:**

```bash
ssh root@homeserver.k4jda.net

export BWS_ACCESS_TOKEN="<your-bws-access-token>"
export CR_PAT=$(bws secret get dev/open-brain/ghcr-pat --output value)

echo "$CR_PAT" | docker login ghcr.io -u davistroy --password-stdin
# Expected: "Login Succeeded"

grep -q ghcr.io ~/.docker/config.json && echo "Auth stored" || echo "Auth missing"
```

---

## 2. Normal deploy flow

Every merge to `main` triggers `.github/workflows/build-images.yml`, which pushes fresh `:latest` images to GHCR. Deploy sequence:

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# 1. Pull latest compose file + scripts
git pull origin main

# 2. Pull updated GHCR app images
docker compose pull

# 3. Restart each app service with the new image
#    --force-recreate: picks up new image even if compose config unchanged
#    --no-deps: leaves postgres/redis/observability running
docker compose up -d --force-recreate --no-deps \
  core-api workers slack-bot voice-capture web-next \
  voice-pipecat file-ingestion financial-ingest utility-ingest \
  cloudflared faster-whisper

# 4. Post-deploy verification (see §3)
```

---

## 3. Verify deploy

### Quick check

```bash
# All containers and their status
docker compose ps

# App image references (expect ghcr.io/davistroy/open-brain/*:latest)
docker ps --format "table {{.Names}}\t{{.Image}}" | grep open-brain
```

Expected image rows:
```
open-brain-core-api           ghcr.io/davistroy/open-brain/core-api:latest
open-brain-workers            ghcr.io/davistroy/open-brain/workers:latest
open-brain-slack-bot          ghcr.io/davistroy/open-brain/slack-bot:latest
open-brain-voice-capture      ghcr.io/davistroy/open-brain/voice-capture:latest
open-brain-web-next           ghcr.io/davistroy/open-brain/web-next:latest
open-brain-voice-pipecat      ghcr.io/davistroy/open-brain/voice-pipecat:latest
open-brain-file-ingestion     ghcr.io/davistroy/open-brain/file-ingestion:latest
open-brain-financial-ingest   ghcr.io/davistroy/open-brain/ingest-sidecar:latest
open-brain-utility-ingest     ghcr.io/davistroy/open-brain/ingest-sidecar:latest
```

### Deep health check

```bash
# Source secrets for REDIS_PASSWORD
. /mnt/user/appdata/open-brain/.env.secrets

# Core API — /health is Docker-internal only; use captures endpoint externally
curl -sf http://localhost:3002/api/v1/captures?limit=1 | head -c 100

# Web dashboard — web-next on host port 3003, dashboard at /dashboard
curl -sf http://localhost:3003/dashboard | grep -c "html"

# MCP endpoint
curl -sf http://localhost:3002/mcp -H "Accept: application/json, text/event-stream" | head -c 80

# Redis
docker exec open-brain-redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning ping

# Postgres
docker exec open-brain-postgres pg_isready -U openbrain -d openbrain

# Cloudflare Tunnel — end-to-end test
curl -sf https://brain.troy-davis.com/api/v1/captures?limit=1 | head -c 100
```

---

## 4. Deploy with a pending schema migration

When a PR includes a new SQL migration (`packages/shared/drizzle/0NNN_*.sql`), apply the migration **before** restarting app images.

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# 1. Pull latest git (includes new migration file)
git pull origin main

# 2. Source secrets
. .env.secrets
export POSTGRES_URL="postgresql://openbrain:${POSTGRES_PASSWORD}@localhost:5432/openbrain"

# 3. Check migration status
bash scripts/migrate-manual.sh --status

# 4. Apply pending migrations
bash scripts/migrate-manual.sh

# 5. Pull images and restart app services
docker compose pull
docker compose up -d --force-recreate --no-deps \
  core-api workers slack-bot voice-capture web-next \
  voice-pipecat file-ingestion financial-ingest utility-ingest

# 6. Verify
curl -sf http://localhost:3002/api/v1/captures?limit=1 | head -c 100
```

**Order is mandatory:** migrations first, images second. `--status` reads the `schema_migrations` ledger to show applied vs pending. Do not use `docker exec psql < migration.sql` directly — use `migrate-manual.sh` so the ledger stays in sync.

**After Postgres volume recreation** (disaster recovery): see `docs/runbooks/restore-rehearsal.md` for the init-schema + baseline + apply sequence.

---

## 5. Rollback to a prior SHA

CI pushes two tags per build: `:latest` and `:sha-<7-char-SHA>`. To pin a service:

```
github.com/davistroy?tab=packages → select package → Tags
```

**Roll back a single service:**

```bash
cat > /mnt/user/appdata/open-brain/docker-compose.override.yml <<'EOF'
services:
  core-api:
    image: ghcr.io/davistroy/open-brain/core-api:sha-abc1234
EOF

docker compose pull core-api
docker compose up -d --force-recreate --no-deps core-api
docker ps --format "{{.Names}} {{.Image}}" | grep core-api
```

**Remove override when done:**
```bash
rm /mnt/user/appdata/open-brain/docker-compose.override.yml
docker compose pull core-api
docker compose up -d --force-recreate --no-deps core-api
```

See `docs/runbooks/web-rollback.md` for web-next-specific rollback steps.

---

## 6. Emergency local build fallback

If GHCR is unreachable or a pushed image is broken:

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

git log --oneline -5

# Build a single service from source
docker compose up -d --build core-api

# Or rebuild all custom app services
docker compose up -d --build \
  core-api workers slack-bot voice-capture web-next \
  voice-pipecat file-ingestion financial-ingest utility-ingest
```

---

## 7. Observability stack

The observability services (Loki, Prometheus, Grafana, Pushgateway) use the `observability` Compose profile.

```bash
# Start observability services
docker compose --profile observability up -d

# Restart a single service
docker compose --profile observability up -d --force-recreate --no-deps grafana

# Check status
docker compose --profile observability ps
```

**One-time Docker host prerequisite** (Loki log driver plugin):
```bash
docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions
# Requires a Docker daemon restart to apply to existing containers:
# systemctl restart docker   (blinks ALL containers — plan a maintenance window)
```

Grafana: `http://homeserver.k4jda.net:3050` (admin password in `.env.secrets` as `GRAFANA_ADMIN_PASSWORD`).

See `docs/runbooks/observability.md` for the full bring-up, datasource wiring, and Loki log driver cutover.

---

## 8. Homeserver-specific notes

- `.env.secrets` is **root-owned** (chmod 600). All `docker compose` commands run as root.
- Deploy path: `/mnt/user/appdata/open-brain/`
- **Do not recreate the postgres service casually.** The `postgres_data` Docker volume holds the live DB. A `docker compose down -v` would destroy it. See `docs/runbooks/restore-rehearsal.md` for recovery.
- Cron entries on Unraid persist in `/boot/config/plugins/dynamix/custom.cron` (not `crontab -l`). Current entries: backup (03:00), offsite-backup (03:45), restore-rehearsal (Sunday 05:30), and 3 ingest crons. See `docs/runbooks/offsite-backup.md` for cron install instructions.
- **LOKI_URL** in `.env` must be `http://localhost:3100/loki/api/v1/push` (the Docker log driver runs in the daemon, which cannot resolve compose DNS; Loki binds 127.0.0.1:3100 per ADR-0002).

---

## Reference

| Resource | URL / Path |
|----------|-----------|
| Dashboard | `https://brain.troy-davis.com` (Cloudflare Tunnel) |
| Core API health signal | `http://localhost:3002/api/v1/captures?limit=1` |
| Web dashboard (direct) | `http://localhost:3003/dashboard` |
| Grafana | `http://homeserver.k4jda.net:3050` |
| Prometheus | `http://localhost:9090` |
| Pushgateway | `http://localhost:9091` |
| Observability runbook | `docs/runbooks/observability.md` |
| DR restore runbook | `docs/runbooks/restore-rehearsal.md` |
| Offsite backup runbook | `docs/runbooks/offsite-backup.md` |
| Web rollback runbook | `docs/runbooks/web-rollback.md` |
