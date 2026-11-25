# Open Brain — Deploy Runbook

**Applies to:** Homeserver production deployments (Unraid, `/mnt/user/appdata/open-brain/`)
**Images:** `ghcr.io/davistroy/open-brain/*:latest`
**Registry:** GitHub Container Registry (GHCR)
**Repo:** `github.com/davistroy/open-brain`

---

## Service and image inventory

| Container | Image | Port(s) |
|-----------|-------|---------|
| `open-brain-postgres` | `pgvector/pgvector:pg16@sha256:1d5335…` (digest-pinned) | `127.0.0.1:5432` |
| `open-brain-redis` | `redis:7.4-alpine` | `127.0.0.1:6380` |
| `open-brain-core-api` | `ghcr.io/davistroy/open-brain/core-api:latest` | `127.0.0.1:3002`, `<tailscale-ip>:3002` |
| `open-brain-workers` | `ghcr.io/davistroy/open-brain/workers:latest` | — |
| `open-brain-slack-bot` | `ghcr.io/davistroy/open-brain/slack-bot:latest` | — |
| `open-brain-voice-capture` | `ghcr.io/davistroy/open-brain/voice-capture:latest` | `0.0.0.0:3001` |
| `open-brain-web-next` | `ghcr.io/davistroy/open-brain/web-next:latest` | `0.0.0.0:3003` |
| `open-brain-file-ingestion` | `ghcr.io/davistroy/open-brain/file-ingestion:latest` | `127.0.0.1:8080` |
| `open-brain-financial-ingest` | `ghcr.io/davistroy/open-brain/ingest-sidecar:latest` | — |
| `open-brain-utility-ingest` | `ghcr.io/davistroy/open-brain/ingest-sidecar:latest` | — |
| `open-brain-actual-ingest` | `ghcr.io/davistroy/open-brain/actual-ingest:latest` | — (br0) |
| `open-brain-faster-whisper` | `ghcr.io/speaches-ai/speaches:0.8.3-cpu` | `127.0.0.1:10300` |
| `open-brain-cloudflared` | `cloudflare/cloudflared:2026.11.2` | — |

**13 containers total**, all in this compose project.

**App images** (8 `ghcr.io/davistroy/open-brain/*` packages): core-api, workers, slack-bot, voice-capture, web-next, file-ingestion, ingest-sidecar (shared by financial-ingest and utility-ingest), actual-ingest.

**The nine application services** are `core-api workers slack-bot voice-capture web-next file-ingestion financial-ingest utility-ingest actual-ingest`. The normal deploy touches only these. `financial-ingest` and `utility-ingest` share one image, so `scripts/deploy.sh` requires both together.

**Not in the normal deploy:** `postgres`, `redis`, `cloudflared` (stateful; `scripts/deploy.sh` refuses them) and `faster-whisper`. These are recreated only in the Phase 8 window of the 2026-11 remediation plan, by hand, one at a time.

> **The observability stack (Loki, Prometheus, Grafana, Pushgateway) is NOT part of this inventory or this compose project.** Since ADR-0004 (2026-07-01) it runs as a standalone `observability` compose project; this repo only joins that project's Docker network as a client. There is no local `--profile observability` anymore. See §7.

> **Note:** `.env.secrets` is root-owned (chmod 600) on the homeserver. All `docker compose` commands must be run as root.

---

## Non-negotiable deploy safety rules

These apply to every procedure in this runbook, not just the sections that call them out explicitly:

1. **Never overwrite or delete `docker-compose.override.yml`** except as items 8.2/8.3 of the 2026-11 remediation plan direct. It is host-only, gitignored, **production state** — it pins postgres/redis to their live raw-bind data directories (`/mnt/user/appdata/open-brain/pgdata`, `/mnt/user/appdata/open-brain/redis-data`, ADR-0004) in short syntax; it holds no core-api port (removed 2026-07-17, Entry 239). Until the host runs a `docker-compose.yml` from `main` at or after item 4.3, the host's base file still declares **empty named volumes**, so a `cat > ... <<EOF` or `rm` against the override would attach postgres/redis to them on the next recreate. (This runbook's own §5 did exactly that until 2026-07-12 — see LAB_NOTEBOOK Entry 182/183, PLT-C1/A134.) From item 4.3 on, `main` binds the same paths itself, fail-closed (`create_host_path: false`); the override's short syntax turns `create_host_path` back on, so each entry is removed — after a backup copy, immediately before its service's planned recreate (postgres in 8.2, redis in 8.3) — and the file is then deleted. Template and rules: `deploy/docker-compose.override.yml.template`.
2. **Never run `docker compose up -d` with no service list.** Always name the services you intend to touch.
3. **Never pass `--remove-orphans`.** It removes any container this compose render doesn't currently declare, including infrastructure this repo doesn't own.
4. **Always pair `--force-recreate` with `--no-deps`** for a targeted service restart — `--no-deps` is what keeps postgres/redis (and, by extension, the external observability network membership) untouched.
5. **Move the host tree only through `scripts/deploy.sh`.** It checks out one commit, runs the drift check and the config gate, and records the result. Do not run `git pull`, `git checkout origin/main -- <file>`, or edit `docker-compose.yml` by hand on the host.
6. **Never write the rendered compose config to a file.** `docker compose config` inlines `env_file` values (secrets). Hold it in a shell variable and print only the fields you check.

### Parity pre-check (run FIRST, #302)

Before anything else, answer **"is production even running this repo's compose?"** — because `docker compose pull` ships image changes but NOT compose-file changes, so the deployed `docker-compose.yml` silently drifts from `main` until a human runs `git checkout origin/main -- docker-compose.yml`. That drift is how PR #244's `/backup-latest` mount sat undeployed for a month (Entry 211).

```bash
# from any box with the repo + claude@homeserver SSH:
bash scripts/check-deploy-parity.sh
# or ON the homeserver (no self-SSH):
PARITY_LOCAL_COMPOSE=/mnt/user/appdata/open-brain/docker-compose.yml bash scripts/check-deploy-parity.sh
```

- **exit 0** → in parity; proceed.
- **exit 1** → DRIFT. Production is missing committed compose changes. Run `bash scripts/deploy.sh <sha> --tree-only` to move the tree to the commit under the gates, then deploy the affected services (§2). Do this **before** treating any compose-dependent change as deployed.
- **exit 2** → the check could not run — do NOT assume parity.

This runs automatically every day via `deploy/cron/unraid-parity-check.cron` (Pushover on drift), so between-deploy drift is loud rather than silent. The config gate below is the *complementary* check: parity proves the file is current; the gate proves postgres and redis still render as binds.

### Config gate

`scripts/deploy.sh` runs the config gate for you, once on the target commit's compose (read from git) and once after the checkout. It refuses to continue unless:

- all 13 services render, and no unknown service appears;
- `postgres` and `redis` render as raw binds only (a named volume means an empty database);
- each bind source exists on the host and equals the mount of the running container.

If you must check by hand, hold the render in a variable and print mount types only:

```bash
cfg=$(docker compose config --format json)
echo "$cfg" | jq -r '.services | to_entries[] | select(.key=="postgres" or .key=="redis") | .key as $s | .value.volumes[]? | "\($s) \(.type) \(.target)"'
```

Expect `postgres bind /var/lib/postgresql/data` and `redis bind /data`. Any `volume` type means STOP: nothing has been recreated yet, so nothing is at risk. Check `docker-compose.override.yml` (rule 1). Do not rewrite it from memory.

---

## 1. One-time GHCR authentication setup (homeserver)

Required once per homeserver Docker daemon. Images are published as private packages.

**Create a GitHub fine-grained PAT:**

1. Go to `github.com` → Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Click "Generate new token"
3. Set scope: **Repository permissions — Packages: Read**
4. Copy the token value

**Store in Bitwarden and configure Docker on homeserver.** The `bws` steps below depend on item 7.4: `bws` is not installed on the Unraid host today. Until 7.4 lands, run the `bws` lines from a machine that has it and paste only the login into the host.

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

Every merge to `main` triggers `.github/workflows/build-images.yml`, which pushes `:latest` **and** `:sha-<7-char-SHA>` images to GHCR. A manual `workflow_dispatch` run pushes `:sha-<7>` for the commit it builds; it moves `:latest` only when run on `main`. Deploy by commit SHA:

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# 1. Rehearse. Runs every read-only gate, prints the plan, changes nothing.
bash scripts/deploy.sh <sha> --dry-run core-api workers slack-bot voice-capture web-next \
  file-ingestion financial-ingest utility-ingest actual-ingest

# 2. Deploy. Same command without --dry-run.
bash scripts/deploy.sh <sha> core-api workers slack-bot voice-capture web-next \
  file-ingestion financial-ingest utility-ingest actual-ingest
```

Name only the services whose code changed. Find them with `git diff <last-deployed-sha>..<sha> --stat -- . ':!*.md' ':!docs'`. Keep `financial-ingest` and `utility-ingest` together: they share `ingest-sidecar`, and a service that shares an image with one you named keeps its old image otherwise.

What `scripts/deploy.sh` does, in order: checks its arguments (it refuses the stateful services); runs `scripts/preflight.sh`; refuses a dirty tree; checks that each image tag exists; runs the config gate; checks out `<sha>`; runs the drift check; pulls the named services at `sha-<7>`; runs `up -d --force-recreate --no-deps <services>`; pins `IMAGE_TAG` in `.env`; waits for health and compares each image's revision label with `<sha>`; writes `DEPLOYED.json` and one line in `deploy-log.jsonl`. Read the header of `scripts/deploy.sh` for options (`--tree-only`, `--marker`). After the containers report healthy, it checks them again after `DEPLOY_HEALTH_SETTLE` seconds (default 20) and fails a container that fell over in between.

To prove a fix is live, add a marker: `--marker core-api=/app/dist/<file>:<string>`. Pick a string from the diff.

Then verify (§3).

---

## 3. Verify deploy

### Quick check

```bash
# All containers and their status
docker compose ps

# App image references (expect ghcr.io/davistroy/open-brain/*:sha-<7>)
docker ps --format "table {{.Names}}\t{{.Image}}" | grep open-brain
```

`DEPLOYED.json` in the repo root names the commit that runs. Expected image rows (tag is the deployed `sha-<7>`):
```
open-brain-core-api           ghcr.io/davistroy/open-brain/core-api:sha-<7>
open-brain-workers            ghcr.io/davistroy/open-brain/workers:sha-<7>
open-brain-slack-bot          ghcr.io/davistroy/open-brain/slack-bot:sha-<7>
open-brain-voice-capture      ghcr.io/davistroy/open-brain/voice-capture:sha-<7>
open-brain-web-next           ghcr.io/davistroy/open-brain/web-next:sha-<7>
open-brain-file-ingestion     ghcr.io/davistroy/open-brain/file-ingestion:sha-<7>
open-brain-financial-ingest   ghcr.io/davistroy/open-brain/ingest-sidecar:sha-<7>
open-brain-utility-ingest     ghcr.io/davistroy/open-brain/ingest-sidecar:sha-<7>
open-brain-actual-ingest      ghcr.io/davistroy/open-brain/actual-ingest:sha-<7>
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

`scripts/deploy.sh` already compares each image's revision label with the commit. This extra check
compares manifest digests. **It depends on item 7.4:** `bws` is not installed on the Unraid host, so
run the `bws` line from a machine that has it until 7.4 lands.

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

Extend the `svc` list to cover any other GHCR-image service this deploy touched
(`file-ingestion`, `actual-ingest`; for `financial-ingest`/`utility-ingest`, both run the shared
`ingest-sidecar` image — substitute `ingest-sidecar` as the GHCR package name but check each
container separately). The check compares against `:latest`; if `main` moved after your deploy,
compare against `manifests/sha-<7>` instead.

Any `MISMATCH` means the running container is not the image you meant to deploy. Re-run
`bash scripts/deploy.sh <sha> <svc>` and re-check before declaring the deploy done.

---

## 4. Deploy with a pending schema migration

When a PR includes a new SQL migration (`packages/shared/drizzle/0NNN_*.sql` or `scripts/0NNN_*.sql`), apply it
**before** restarting app images. The homeserver has **no `psql` client** and postgres publishes
`127.0.0.1:5432` only, so migrations run inside a throwaway `pgvector/pgvector:pg16` container.
The ledger is the `schema_migrations` table; `scripts/migrate-manual.sh` reads and writes it.

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# 1. Move the tree to the new commit and run every gate. Recreates nothing.
bash scripts/deploy.sh <sha> --tree-only

# 2. Source secrets, get POSTGRES_URL from a running container. Keep this in-session only —
#    `migrate-manual.sh --status` prints the password UNMASKED in its "target:" line.
. .env.secrets
POSTGRES_URL=$(docker exec open-brain-core-api printenv POSTGRES_URL)

# 3. Check migration status (applied vs pending)
docker run --rm \
  --network open-brain_open-brain \
  -v /mnt/user/appdata/open-brain:/app -w /app \
  -e POSTGRES_URL="$POSTGRES_URL" \
  pgvector/pgvector:pg16 \
  bash scripts/migrate-manual.sh --status

# 4. Apply pending migrations (ON_ERROR_STOP=1 rolls back a failed migration cleanly —
#    no ledger row, no half-built objects)
docker run --rm \
  --network open-brain_open-brain \
  -v /mnt/user/appdata/open-brain:/app -w /app \
  -e POSTGRES_URL="$POSTGRES_URL" \
  pgvector/pgvector:pg16 \
  bash scripts/migrate-manual.sh

# 5. Deploy the application services (§2)
bash scripts/deploy.sh <sha> core-api workers slack-bot voice-capture web-next \
  file-ingestion financial-ingest utility-ingest actual-ingest

# 6. Verify (see §3)
curl -sf http://localhost:3002/api/v1/captures?limit=1 | head -c 100
```

**Order is mandatory:** tree and gates, then migrations, then images. **Never**: bare
`docker compose up -d` (no service list), `--remove-orphans`, or
`docker exec ... psql < migration.sql` directly (bypasses the `schema_migrations` ledger).

**After Postgres volume recreation** (disaster recovery — a different scenario from a routine
migration): follow the manual-restore checklist in `docs/runbooks/restore-rehearsal.md`
("Manual restore (actual DR)"). `scripts/restore.sh --apply-pending` restores the dump into the
empty database and then applies the migrations newer than its ledger; no schema file is
applied first.

---

## 5. Rollback

A rollback is a deploy of the previous commit. `scripts/deploy.sh` writes every deploy to
`DEPLOYED.json` (current) and `${BACKUP_ROOT}/deploy-log.jsonl` (history, one line per deploy).
The previous commit is the one before the last line in that log.

**Neither procedure touches `docker-compose.override.yml`.** That file only pins postgres/redis to
their live raw-bind data directories (ADR-0004) — see safety rule 1.

### 5a. Find the previous commit

```bash
cd /mnt/user/appdata/open-brain
cat DEPLOYED.json
tail -n 3 /mnt/user/backup/openbrain/deploy-log.jsonl
```

If the log is missing, take the commit from `git log --oneline` and the merged-PR history. Do not
guess from build timestamps (LAB_NOTEBOOK Entry 183: a timestamp guess named the wrong tag).
Confirm the tag exists: `docker manifest inspect ghcr.io/davistroy/open-brain/<svc>:sha-<7>`.

### 5b. Roll back

```bash
bash scripts/deploy.sh <previous-sha> core-api    # name each service that failed
```

When a verify or recreate fails, `scripts/deploy.sh` prints this command with the commit from
`DEPLOYED.json`'s `images_commit` (the last commit whose images went live). When there is none, or
it equals the commit that just failed, it prints "no scripted rollback" instead: use §5c. A
rollback past a migration needs the reverse migration first; read the migration's header and
`docs/runbooks/restore-rehearsal.md`.

**Never** roll back with a bare `docker compose pull` or `up`. Compose reads `IMAGE_TAG` from
`.env`, which still names the commit that just failed, so a bare `pull` fetches that broken
build again. `scripts/deploy.sh` exports the rollback commit's tag and rewrites `.env`.

### 5c. Manual rollback (a commit before item 5.1, or no record)

`scripts/deploy.sh` cannot deploy a commit from before item 5.1: its compose has no `${IMAGE_TAG}`
and its images carry no revision label, so the script refuses it at the image-tag check. Roll
back to one by hand, using the image IDs recorded before the change (`DEPLOYED.json`
`containers.<svc>.image_id`, the deploy log, or a `docker inspect` snapshot) — the images must
still be in the local image store:

```bash
cd /mnt/user/appdata/open-brain
cp -p .env .env.bak-$(date -u +%Y%m%dT%H%M%SZ)
sed -i '/^IMAGE_TAG=/d' .env        # IMAGE_TAG unset: compose renders :latest again
# Only if the tree must move too (it is the riskiest step; snapshot first):
#   git -c safe.directory=$PWD checkout --detach <previous-sha>

# Per service: point :latest back at the recorded image ID. NO pull — a pull would
# replace :latest with whatever main publishes now.
docker tag <image_id> ghcr.io/davistroy/open-brain/<package>:latest
env -u IMAGE_TAG docker compose up -d --force-recreate --no-deps <services>
```

`DEPLOYED.json` no longer matches what runs until the next `scripts/deploy.sh`. Record the
rollback in `LAB_NOTEBOOK.md`.

---

## 6. Emergency local build fallback

If GHCR is unreachable or a pushed image is broken, build on the host. `.env` holds
`IMAGE_TAG=sha-<7>`, so a build without an explicit tag would write the local image over the
registry's `sha-<7>` tag and hide that it is not the published image. Give it its own tag, on
both commands, and name the services:

```bash
ssh root@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

git log --oneline -5

LT=local-$(date -u +%Y%m%d)

# One service
IMAGE_TAG=$LT docker compose build core-api
IMAGE_TAG=$LT docker compose up -d --force-recreate --no-deps core-api

# Or all application services (never name postgres, redis, or cloudflared). Keep
# financial-ingest and utility-ingest together: they share the ingest-sidecar image.
IMAGE_TAG=$LT docker compose build \
  core-api workers slack-bot voice-capture web-next \
  file-ingestion financial-ingest utility-ingest actual-ingest
IMAGE_TAG=$LT docker compose up -d --force-recreate --no-deps \
  core-api workers slack-bot voice-capture web-next \
  file-ingestion financial-ingest utility-ingest actual-ingest
```

After this, **`DEPLOYED.json` no longer matches what runs**, and `.env` still names the old
`sha-<7>`: any later compose command without `IMAGE_TAG=$LT` renders the registry image again,
and the daily drift check reports the rebuilt services as stale. Both stay wrong until the next
`scripts/deploy.sh` run, which is the way back to a recorded state once GHCR works. Record the
local build in `LAB_NOTEBOOK.md`.

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
exist before `core-api`/`workers` are (re)created, or a recreate fails with a
"network not found" error. It does on the homeserver by construction (the observability project
creates it); this only matters when standing up a fresh host.

---

## 8. Homeserver-specific notes

- `.env.secrets` is **root-owned** (chmod 600). All `docker compose` commands run as root.
- Deploy path: `/mnt/user/appdata/open-brain/`
- **The live database is on raw bind mounts, not named volumes.** Since ADR-0004, postgres and
  redis run on `/mnt/user/appdata/open-brain/pgdata:/var/lib/postgresql/data` and
  `/mnt/user/appdata/open-brain/redis-data:/data`. Since remediation item 4.3, `main`'s
  `docker-compose.yml` declares exactly these binds itself
  (`${OPENBRAIN_DATA_DIR:-/mnt/user/appdata/open-brain}/{pgdata,redis-data}`, long syntax,
  `create_host_path: false`): a missing data directory makes Docker refuse to start the
  service instead of creating an empty one. Before item 4.3 the base file declared named
  volumes and only the host-only `docker-compose.override.yml` kept the data attached — and the
  host tree keeps that older base file until item 5.5, so the override stays in place until items
  8.2/8.3 remove its entries (safety rule 1). CI (`scripts/test-compose-data-binds.sh`, job
  `validate-compose-dr`) fails any change back to a named volume or short syntax. Never recreate
  postgres/redis with a bare, no-service-list `up -d` (safety rule 2). See
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
| DR restore runbook | `docs/runbooks/restore-rehearsal.md` ("Manual restore"), script `scripts/restore.sh` |
| Offsite backup runbook | `docs/runbooks/offsite-backup.md` |
