# Open Brain — Deploy Runbook

**Applies to:** Post-P17 homeserver deployments  
**Images:** `ghcr.io/davistroy/open-brain/*:latest`  
**Registry:** GitHub Container Registry (GHCR)  
**Repo:** `github.com/davistroy/open-brain`

---

## 1. One-time GHCR authentication setup (homeserver)

This is required once per homeserver Docker daemon. Images are published as private packages under your GitHub account.

**Create a GitHub fine-grained PAT:**

1. Go to `github.com` → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Click "Generate new token"
3. Set scope: **Repository permissions — Packages: Read**
4. Copy the token value

**Store in Bitwarden:**

```bash
# On your dev machine
bws secret create --key dev/open-brain/ghcr-pat --value "<token>"
```

**Configure Docker on homeserver:**

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net

# Retrieve PAT from Bitwarden
export BWS_ACCESS_TOKEN="<your-bws-access-token>"
export CR_PAT=$(bws secret get dev/open-brain/ghcr-pat --output value)

# Authenticate Docker to GHCR
echo "$CR_PAT" | docker login ghcr.io -u davistroy --password-stdin
# Expected: "Login Succeeded"

# Verify ~/.docker/config.json was written
grep -q ghcr.io ~/.docker/config.json && echo "Auth stored" || echo "Auth missing"
```

This persists across reboots — Docker stores the credential in `~/.docker/config.json`.

---

## 2. Normal deploy flow

After P17, every merge to `main` triggers `.github/workflows/build-images.yml` which pushes fresh images to GHCR. The homeserver deploy is:

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# Pull latest compose file
git pull origin main

# Pull all 8 updated GHCR images
docker compose pull

# Restart services with new images (graceful — existing containers stop first)
docker compose up -d --remove-orphans

# Verify all containers are running
docker compose ps
```

**Expected: all custom containers show `ghcr.io/davistroy/open-brain/*:latest` as the image.**

```bash
# Confirm image references
docker ps --format "table {{.Names}}\t{{.Image}}" | grep open-brain

# Health check
curl -sf http://localhost:3002/api/v1/captures?limit=1 | head -c 100
```

---

## 3. Verify deploy

After every deploy, confirm the correct images are running:

```bash
# All open-brain containers and their image references
docker ps --format "table {{.Names}}\t{{.Image}}" | grep open-brain
```

Expected output (one row per service):
```
open-brain-core-api      ghcr.io/davistroy/open-brain/core-api:latest
open-brain-workers       ghcr.io/davistroy/open-brain/workers:latest
open-brain-slack-bot     ghcr.io/davistroy/open-brain/slack-bot:latest
open-brain-voice-capture ghcr.io/davistroy/open-brain/voice-capture:latest
open-brain-web           ghcr.io/davistroy/open-brain/web:latest
open-brain-voice-pipecat ghcr.io/davistroy/open-brain/voice-pipecat:latest
open-brain-file-ingestion ghcr.io/davistroy/open-brain/file-ingestion:latest
open-brain-financial-ingest ghcr.io/davistroy/open-brain/ingest-sidecar:latest
open-brain-utility-ingest   ghcr.io/davistroy/open-brain/ingest-sidecar:latest
```

**Deep health check:**
```bash
# Core API responding
curl -sf http://localhost:3002/api/v1/captures?limit=1

# Web UI serving
curl -sf http://localhost:5173/health.txt

# Redis alive
docker exec open-brain-redis redis-cli ping

# Postgres accepting connections
docker exec open-brain-postgres pg_isready -U openbrain -d openbrain
```

---

## 4. Rollback to a prior SHA

Every deploy pushes two tags: `latest` and `sha-<7-char-SHA>`. To pin a service to a prior SHA:

**Find available SHA tags:**
```bash
# View recent image pushes in GitHub Packages tab:
# github.com/davistroy?tab=packages → select any open-brain/* package → Tags
```

**Roll back a single service (e.g., core-api):**

```bash
# Create a compose override to pin the SHA
cat > /mnt/user/appdata/open-brain/docker-compose.override.yml <<'EOF'
services:
  core-api:
    image: ghcr.io/davistroy/open-brain/core-api:sha-abc1234
EOF

# Pull the pinned image
docker compose pull core-api

# Restart with pinned image
docker compose up -d core-api

# Confirm
docker ps --format "{{.Names}} {{.Image}}" | grep core-api
```

**Roll back all services to a prior SHA:**

```bash
# Update docker-compose.yml: change :latest to :sha-<OLDSHA> for each service
# then pull + restart
git diff  # confirm your edit
docker compose pull
docker compose up -d --remove-orphans
```

**Remove the override when done:**
```bash
rm /mnt/user/appdata/open-brain/docker-compose.override.yml
docker compose pull
docker compose up -d --remove-orphans
```

---

## 5. Emergency local build fallback

If GHCR is unreachable or a pushed image is broken, rebuild from the local source tree:

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# Ensure you are on the desired git commit
git log --oneline -5

# Build and start a single service from source
docker compose --profile local-build up -d --build core-api

# Or rebuild all custom services from source
docker compose --profile local-build up -d --build \
  core-api workers slack-bot voice-capture web \
  voice-pipecat file-ingestion financial-ingest utility-ingest
```

The `local-build` profile activates the `build:` blocks in `docker-compose.yml`. Without the profile, compose uses `image:` only and skips builds.

---

## 6. Deploy with a pending schema migration

When a PR includes a new Drizzle migration (`packages/shared/drizzle/0NNN_*.sql`), apply the migration BEFORE bringing up new images:

```bash
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# 1. Pull latest git (includes new migration files)
git pull origin main

# 2. Apply the migration
docker exec -i open-brain-postgres psql -U openbrain -d openbrain \
  < packages/shared/drizzle/0NNN_description.sql

# Verify migration applied
docker exec open-brain-postgres psql -U openbrain -d openbrain \
  -c "\dt" | grep -i new_table_name

# 3. Pull new images
docker compose pull

# 4. Restart services
docker compose up -d --remove-orphans

# 5. Health check
curl -sf http://localhost:3002/api/v1/captures?limit=1 | head -c 100
```

**Order matters:** Migration first, images second. Rolling back after migration requires a separate `git revert` + manual `DROP` for schema additions — treat migrations as one-way unless a compensating rollback migration exists.

---

## 7. Post-deploy PWA cache clear

After deploying a new `web` image, the PWA service worker aggressively caches Vite-hashed bundles. Users (including you) must clear the cache to see updates:

1. Hard-refresh: `Ctrl+Shift+R` (or `Cmd+Shift+R` on Mac)
2. In DevTools Console:
   ```js
   caches.keys().then(names => Promise.all(names.map(n => caches.delete(n))))
   ```

This is a known recurring issue after every web rebuild — SW unregister alone is insufficient.

---

## Reference

| Resource | URL |
|----------|-----|
| GitHub Packages | `github.com/davistroy?tab=packages` |
| Actions runs | `github.com/davistroy/open-brain/actions/workflows/build-images.yml` |
| Dashboard | `https://brain.troy-davis.com` |
| Core API health | `http://localhost:3002/api/v1/captures?limit=1` |
| Web UI health | `http://localhost:5173/health.txt` |
| Observability runbook | `docs/runbooks/observability.md` |
| DR restore runbook | `docs/runbooks/restore-rehearsal.md` |
