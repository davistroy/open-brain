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

**13 containers total**, all in this compose project.

**App images** (8 `ghcr.io/davistroy/open-brain/*` packages): core-api, workers, slack-bot, voice-capture, web-next, voice-pipecat, file-ingestion, ingest-sidecar (shared by financial-ingest and utility-ingest).

> **The observability stack (Loki, Prometheus, Grafana, Pushgateway) is NOT part of this inventory or this compose project.** Since ADR-0004 (2026-07-01) it runs as a standalone `observability` compose project; this repo only joins that project's Docker network as a client. There is no local `--profile observability` anymore. See §7.

> **Note:** `.env.secrets` is root-owned (chmod 600) on the homeserver. All `docker compose` commands must be run as root.

---

## Non-negotiable deploy safety rules

These apply to every procedure in this runbook, not just the sections that call them out explicitly:

1. **Never overwrite or delete `docker-compose.override.yml`.** It is host-only, gitignored, **production state** — it pins postgres/redis to their live raw-bind data directories (`/mnt/user/appdata/open-brain/pgdata`, `/mnt/user/appdata/open-brain/redis-data`, ADR-0004) plus the core-api host port (D131). A `cat > ... <<EOF` or `rm` against this file drops those pins; the next `up` that recreates postgres/redis would attach them to the base compose file's **empty named volumes** instead of the live data. (This runbook's own §5 did exactly that until 2026-07-12 — see LAB_NOTEBOOK Entry 182/183, PLT-C1/A134.)
2. **Never run `docker compose up -d` with no service list.** Always name the services you intend to touch.
3. **Never pass `--remove-orphans`.** It removes any container this compose render doesn't currently declare, including infrastructure this repo doesn't own.
4. **Always pair `--force-recreate` with `--no-deps`** for a targeted service restart — `--no-deps` is what keeps postgres/redis (and, by extension, the external observability network membership) untouched.
5. **Any change to `docker-compose.yml`** — via `git pull`, `git checkout origin/main -- docker-compose.yml`, or a manual edit — must pass the config-diff gate below before the next `up`.

### Parity pre-check (run FIRST, #302)

Before anything else, answer **"is production even running this repo's compose?"** — because `docker compose pull` ships image changes but NOT compose-file changes, so the deployed `docker-compose.yml` silently drifts from `main` until a human runs `git checkout origin/main -- docker-compose.yml`. That drift is how PR #244's `/backup-latest` mount sat undeployed for a month (Entry 211).

```bash
# from any box with the repo + claude@homeserver SSH:
bash scripts/check-deploy-parity.sh
# or ON the homeserver (no self-SSH):
PARITY_LOCAL_COMPOSE=/mnt/user/appdata/open-brain/docker-compose.yml bash scripts/check-deploy-parity.sh
```

- **exit 0** → in parity; proceed.
- **exit 1** → DRIFT. Production is missing committed compose changes. Run the reconciliation the gate prints (adopt `origin/main`'s compose as root → re-apply the D131 sed → config-diff gate → `--force-recreate --no-deps` the affected services, one wave at a time). Do this **before** treating any compose-dependent change as deployed.
- **exit 2** → the check could not run — do NOT assume parity.

This runs automatically every day via `deploy/cron/unraid-parity-check.cron` (Pushover on drift), so between-deploy drift is loud rather than silent. The config-diff gate below is the *complementary* check: parity proves the file is current; config-diff proves a change did only what you intended.

### Config-diff gate

Run before AND after any operation that could change `docker-compose.yml`'s rendered output:

```bash
docker compose config --format json | jq -S . > /tmp/compose-before.json
# ... git pull / git checkout / manual edit ...
docker compose config --format json | jq -S . > /tmp/compose-after.json
diff /tmp/compose-before.json /tmp/compose-after.json
```

- **Diff empty** → proceed normally.
- **Diff non-empty** → confirm every change is expected, AND confirm both of these still hold in the "after" render:
  - `postgres` renders a **bind** mount at `/var/lib/postgresql/data` sourced from `/mnt/user/appdata/open-brain/pgdata` (`"type": "bind"`, not `"type": "volume"`)
  - `redis` renders a **bind** mount at `/data` sourced from `/mnt/user/appdata/open-brain/redis-data`
- **Either check fails, or you can't explain the diff** → **STOP.** Nothing has been recreated yet — nothing is at risk. Investigate `docker-compose.override.yml` before running `up` (see rule 1: never regenerate it with `cat >`; if it's genuinely missing or wrong, restore it from the last known-good copy, don't rewrite it from memory).

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

The same `CR_PAT` is reused for the GHCR digest-verification checks in §3 and §5.

---

## 2. Normal deploy flow

Every merge to `main` triggers `.github/workflows/build-images.yml`, which pushes fresh `:latest` **and** `:sha-<7-char-SHA>` images to GHCR. Deploy sequence:

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# 1. Record rollback anchors BEFORE pulling anything — see §5a.
#    This is what makes §5's rollback exact-digest-pinned instead of a post-hoc guess.

# 2. Config-diff gate, part 1 — capture compose render before the pull (see safety rules above)
docker compose config --format json | jq -S . > /tmp/compose-before.json

# 3. Pull latest compose file + scripts
git pull origin main

# 4. Config-diff gate, part 2 — diff after; if non-empty, verify postgres/redis still render
#    as raw binds before continuing (see safety rules above). If they don't — STOP.
docker compose config --format json | jq -S . > /tmp/compose-after.json
diff /tmp/compose-before.json /tmp/compose-after.json

# 5. Pull updated GHCR app images
docker compose pull

# 6. Restart each app service with the new image
#    --force-recreate: picks up new image even if compose config unchanged
#    --no-deps: leaves postgres/redis/observability-network membership untouched
docker compose up -d --force-recreate --no-deps \
  core-api workers slack-bot voice-capture web-next \
  voice-pipecat file-ingestion financial-ingest utility-ingest \
  cloudflared faster-whisper

# 7. Post-deploy verification (see §3)
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

### GHCR digest verification

Confirms the freshly recreated containers are actually running the image GHCR currently
publishes for `:latest` — not a stale local cache or a registry propagation lag. Uses direct
manifest-digest comparison (not build-timestamp inference — see §5 for why that matters).

```bash
export BWS_ACCESS_TOKEN="<your-bws-access-token>"
CR_PAT=$(bws secret get dev/open-brain/ghcr-pat --output value)

for svc in core-api workers slack-bot voice-capture web-next; do
  TOKEN=$(curl -s -u "davistroy:${CR_PAT}" \
    "https://ghcr.io/token?scope=repository:davistroy/open-brain/${svc}:pull" | jq -r .token)
  remote=$(curl -s -H "Authorization: Bearer ${TOKEN}" \
    -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
    -D - -o /dev/null \
    "https://ghcr.io/v2/davistroy/open-brain/${svc}/manifests/latest" \
    | grep -i '^docker-content-digest:' | awk '{print $2}' | tr -d '\r')
  local=$(docker inspect "open-brain-${svc}" --format '{{index .RepoDigests 0}}' | cut -d@ -f2)
  if [ "$remote" = "$local" ]; then
    echo "${svc}: MATCH (${local})"
  else
    echo "${svc}: MISMATCH — remote=${remote} local=${local}"
  fi
done
```

Extend the `svc` list to cover any other GHCR-image service this deploy touched (`voice-pipecat`,
`file-ingestion`; for `financial-ingest`/`utility-ingest`, both run the shared `ingest-sidecar`
image — substitute `ingest-sidecar` as the GHCR package name but check each container separately).

Any `MISMATCH` means the running container is not what GHCR currently serves for `:latest` —
re-run `docker compose pull <svc> && docker compose up -d --force-recreate --no-deps <svc>` and
re-check before declaring the deploy done.

---

## 4. Deploy with a pending schema migration

When a PR includes a new SQL migration (`packages/shared/drizzle/0NNN_*.sql`), apply the migration
**before** restarting app images. The homeserver has **no `psql` client** and postgres publishes
`127.0.0.1:5432` only, so migrations run inside a throwaway `pgvector/pgvector:pg16` container
rather than directly on the host.

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# 1. Config-diff gate, part 1 (see safety rules above)
docker compose config --format json | jq -S . > /tmp/compose-before.json

# 2. Pull latest git (includes the new migration file + any compose changes)
git pull origin main

# 3. Config-diff gate, part 2 — non-empty diff? Verify postgres/redis still render as raw
#    binds before continuing. If they don't — STOP, do not run `up`.
docker compose config --format json | jq -S . > /tmp/compose-after.json
diff /tmp/compose-before.json /tmp/compose-after.json

# 4. Source secrets, get POSTGRES_URL from a running container. Keep this in-session only —
#    `migrate-manual.sh --status` prints the password UNMASKED in its "target:" line.
. .env.secrets
POSTGRES_URL=$(docker exec open-brain-core-api printenv POSTGRES_URL)

# 5. Check migration status via a throwaway pgvector container (host has no psql client)
docker run --rm \
  --network open-brain_open-brain \
  -v /mnt/user/appdata/open-brain:/app -w /app \
  -e POSTGRES_URL="$POSTGRES_URL" \
  pgvector/pgvector:pg16 \
  bash scripts/migrate-manual.sh --status

# 6. Apply pending migrations (same throwaway-container pattern; ON_ERROR_STOP=1 rolls back a
#    failed migration cleanly — no ledger row, no half-built objects)
docker run --rm \
  --network open-brain_open-brain \
  -v /mnt/user/appdata/open-brain:/app -w /app \
  -e POSTGRES_URL="$POSTGRES_URL" \
  pgvector/pgvector:pg16 \
  bash scripts/migrate-manual.sh

# 7. Record rollback anchors (§5a), then pull images and restart app services
docker compose pull
docker compose up -d --force-recreate --no-deps \
  core-api workers slack-bot voice-capture web-next \
  voice-pipecat file-ingestion financial-ingest utility-ingest

# 8. Verify (see §3)
curl -sf http://localhost:3002/api/v1/captures?limit=1 | head -c 100
```

**Order is mandatory:** config-diff gate, then migrations, then images. **Never**: bare
`docker compose up -d` (no service list — would recreate postgres/redis against the base compose's
named volumes if the override ever fails to render), `--remove-orphans`, or
`docker exec ... psql < migration.sql` directly (bypasses the `schema_migrations` ledger).
`--status` reads that ledger to show applied vs pending.

**After Postgres volume recreation** (disaster recovery — a different scenario from a routine
migration): see `docs/runbooks/restore-rehearsal.md` for the init-schema + baseline + apply
sequence.

---

## 5. Rollback

Two parts. **5a** records rollback anchors — do this **before every deploy** (§2 step 1, §4
step 7's predecessor). **5b** uses those anchors to roll a service back if a deploy fails smoke
testing or crash-loops.

**Neither procedure touches `docker-compose.override.yml`.** That file exists solely to pin
postgres/redis to their live raw-bind data directories (ADR-0004) and the core-api host port
(D131) — see safety rule 1. Rollback here works entirely through image tags/digests.

### 5a. Record rollback anchors (before every deploy)

CI pushes two tags per build: `:latest` and `:sha-<7-char-SHA>`. Before pulling anything, capture
the **exact digest** of what's currently running for each app service — the digest, not the sha-
tag (a tag can be repointed by a future push; a digest cannot):

```bash
ts=$(date -u +%Y%m%dT%H%M%SZ)
anchor_file="/mnt/user/appdata/open-brain/backups/deploy-anchors/${ts}.txt"
mkdir -p "$(dirname "$anchor_file")"

for svc in core-api workers slack-bot voice-capture web-next; do
  digest=$(docker inspect "open-brain-${svc}" --format '{{index .RepoDigests 0}}')
  echo "${svc} ${digest}" | tee -a "$anchor_file"
done
```

This writes lines like:
```
core-api ghcr.io/davistroy/open-brain/core-api@sha256:5a82b398a5c06c6b8cbb5c0b8fefb70c960bc7693dbbd79b49e3c0daa0fb7d56
```

That digest is ground truth — read directly from the currently-running container, not inferred
from a build timestamp or a guessed commit. (2026-07-12, LAB_NOTEBOOK Entry 183: a
timestamp-based guess at which `:sha-` tag was running for `slack-bot` was **wrong**; only a
direct GHCR manifest-digest comparison caught it. Recording the digest proactively, every deploy,
removes the need to ever guess again.)

Extend the `svc` list to cover any other GHCR-image service this deploy will touch. If
`RepoDigests` is empty for a service (can happen after a local `--build`, §6), fall back to the
local image ID — `docker inspect "open-brain-${svc}" --format '{{.Image}}'` — which still lets
you `docker tag` back to that exact image, just without a registry digest to cross-check.

### 5b. Roll back a service to its recorded anchor

If the post-deploy smoke test (§3) or the crash-loop watch fails:

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

SVC=core-api
DIGEST="ghcr.io/davistroy/open-brain/core-api@sha256:5a82b398a5c06c6b8cbb5c0b8fefb70c960bc7693dbbd79b49e3c0daa0fb7d56"  # from the anchor file

# 1. Pull the exact prior image by digest — not by tag, no guessing which sha- tag it was
docker pull "$DIGEST"

# 2. Point the local :latest tag at it. This is the ONLY thing that changes — no compose
#    file is touched, and docker-compose.override.yml is never read or written here.
docker tag "$DIGEST" "ghcr.io/davistroy/open-brain/${SVC}:latest"

# 3. Recreate just that service
docker compose up -d --force-recreate --no-deps "$SVC"

# 4. Confirm the rollback took
docker inspect "open-brain-${SVC}" --format '{{index .RepoDigests 0}}'
# Expect this to equal $DIGEST
```

Repeat per affected service. **Never** use `docker compose pull` for a rollback — it re-pulls
`:latest`, which is whatever `main` currently publishes (the broken build), not the prior image.

**If you didn't have an anchor recorded** (5a was skipped) — do NOT guess from build timestamps
(Entry 183 proved that wrong once already). Instead, query GHCR directly for the digest of the
specific `:sha-<SHA>` tag you believe was previously deployed (cross-reference the merged-PR
history / `git log`), and treat it as unverified until the digest comparison confirms it:

```bash
TOKEN=$(curl -s -u "davistroy:${CR_PAT}" \
  "https://ghcr.io/token?scope=repository:davistroy/open-brain/${SVC}:pull" | jq -r .token)
curl -s -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
  -D - -o /dev/null \
  "https://ghcr.io/v2/davistroy/open-brain/${SVC}/manifests/sha-<SHA>" \
  | grep -i '^docker-content-digest:'
```

Only proceed to `docker tag`/`up -d` once the digest is confirmed via this lookup — never trust a
tag guess derived from commit timestamps alone.

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

The observability stack (Loki, Prometheus, Grafana, Pushgateway) is **not part of this compose
project**. Since ADR-0004 (2026-07-01) it runs as a standalone `observability` compose project on
the homeserver; open-brain joins it as a **client** — `core-api` and `workers` attach to the
external `observability` Docker network (declared `external: true` in `docker-compose.yml`), the
shared Prometheus scrapes `core-api:3000/metrics`, and `workers` pushes to `pushgateway:9091`.

There is **no local `--profile observability` in this repo anymore** — the four GPL service
definitions and their volumes were deleted from `docker-compose.yml` when the stack was
re-pointed. See `docs/adr/ADR-0004-observability-repoint.md` for the full history.

To bring up, restart, or inspect the observability containers themselves, see
`docs/runbooks/observability.md` — that stack is managed as its own project, outside this
runbook's deploy flow.

**One thing this repo IS responsible for:** the external `observability` network must already
exist before `core-api`/`workers` are (re)created, or `docker compose up` fails with a
"network not found" error. It does on the homeserver by construction (the observability project
creates it); this only matters when standing up a fresh host.

---

## 8. Homeserver-specific notes

- `.env.secrets` is **root-owned** (chmod 600). All `docker compose` commands run as root.
- Deploy path: `/mnt/user/appdata/open-brain/`
- **The live database is NOT on the `postgres_data` named volume declared in `docker-compose.yml`.**
  Since ADR-0004, postgres and redis run on **raw bind mounts** —
  `/mnt/user/appdata/open-brain/pgdata:/var/lib/postgresql/data` and
  `/mnt/user/appdata/open-brain/redis-data:/data` — pinned in the host-only, gitignored
  `docker-compose.override.yml`. The named volumes in the base compose file exist only so the
  repo stays portable for other deployments; on THIS host they're dead weight, not where the data
  lives. **Never delete or truncate the override file** (safety rule 1) — doing so drops back to
  the named-volume declaration, and the next `up` that recreates postgres/redis would attach to an
  **empty** volume (the bind-mounted data on disk is untouched, just detached). Never recreate
  postgres/redis with a bare, no-service-list `up -d` either (safety rule 2). See
  `docs/adr/ADR-0004-observability-repoint.md` for the full history and
  `docs/runbooks/restore-rehearsal.md` for DR recovery.
- Cron entries on Unraid persist in `/boot/config/plugins/dynamix/custom.cron` (not
  `crontab -l`). Current entries: backup (03:00), offsite-backup (03:45), restore-rehearsal
  (Sunday 05:30), and 3 ingest crons. See `docs/runbooks/offsite-backup.md` for cron install
  instructions.
- **LOKI_URL** in `.env` must be `http://localhost:3100/loki/api/v1/push` (the Docker log driver
  runs in the daemon, which cannot resolve compose DNS; Loki still binds `127.0.0.1:3100` on the
  host regardless of which compose project owns the container).

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
| Observability re-point ADR | `docs/adr/ADR-0004-observability-repoint.md` |
| DR restore runbook | `docs/runbooks/restore-rehearsal.md` |
| Offsite backup runbook | `docs/runbooks/offsite-backup.md` |
