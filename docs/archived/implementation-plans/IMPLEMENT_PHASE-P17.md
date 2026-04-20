# IMPLEMENT_PHASE-P17.md — Image Registry (GHCR)

**Phase:** P17
**PHASED_PLAN.md card:** § P17 — "Image registry (GHCR)" — Wave 3, #107 subset
**Effort estimate (plan):** ~2 days | **Revised estimate:** ~1 day (scoping below)
**Dependencies:** None (standalone CI/CD work)
**Closes:** partial of #107 (P04b + P16 + P17 complete the issue)
**Operator-approval required:** YES — touches homeserver deploy flow (compose changes)
**Gate 5.5 homeserver deploy:** YES — compose change; no migration

---

## Scope Drift Analysis

Comparing the card description against actual repo state:

| Card reference | Actual state | Drift? |
|---|---|---|
| `.github/workflows/build-images.yml` — new file | Does not exist | None — needs creating |
| `docker-compose.yml` — switch `build:` to `image:` | Services use `build:` today; compose file has 7 built services: `core-api`, `workers`, `slack-bot`, `voice-capture`, `web`, `voice-pipecat`, `file-ingestion`, and 2 that already use `image:` directly: `faster-whisper`, `redis`, `postgres`, `cloudflared`, `loki`, `pushgateway`, `prometheus`, `grafana` | None |
| Keep `build:` as fallback via `--profile local-build` | Not yet present | None — needs adding |
| `docs/runbooks/deploy.md` — updated deploy + rollback | Does not exist | None — needs creating |

**Additional scope item surfaced during plan:**
The ingest sidecar (`financial-ingest`, `utility-ingest`) in docker-compose.yml uses `image: open-brain-ingest-sidecar:latest` (a locally-built tag, not GHCR). The two services share a single `Dockerfile` at `docker/ingest-sidecar/Dockerfile`. This must be included in the GHCR push to make `docker compose pull` work on homeserver.

**Confirmed image inventory** (7 custom-built images to push to GHCR):

| Service | Source | Current compose directive | GHCR tag name |
|---|---|---|---|
| `core-api` | `Dockerfile` (target: `core-api`) | `build: { context: ., target: core-api }` | `open-brain/core-api` |
| `workers` | `Dockerfile` (target: `workers`) | `build: { context: ., target: workers }` | `open-brain/workers` |
| `slack-bot` | `Dockerfile` (target: `slack-bot`) | `build: { context: ., target: slack-bot }` | `open-brain/slack-bot` |
| `voice-capture` | `Dockerfile` (target: `voice-capture`) | `build: { context: ., target: voice-capture }` | `open-brain/voice-capture` |
| `web` | `packages/web/Dockerfile` | `build: { context: ., dockerfile: packages/web/Dockerfile }` | `open-brain/web` |
| `voice-pipecat` | `packages/voice-pipecat/Dockerfile` | `build: { context: packages/voice-pipecat, dockerfile: Dockerfile }` | `open-brain/voice-pipecat` |
| `file-ingestion` | `packages/file-ingestion/Dockerfile` | `build: { context: packages/file-ingestion, dockerfile: Dockerfile }` | `open-brain/file-ingestion` |
| `ingest-sidecar` | `docker/ingest-sidecar/Dockerfile` | `image: open-brain-ingest-sidecar:latest` (in both financial-ingest + utility-ingest) | `open-brain/ingest-sidecar` |

**Third-party images that stay as-is** (no build, no push): `pgvector/pgvector:pg16`, `redis:7-alpine`, `cloudflare/cloudflared:latest`, `fedirz/faster-whisper-server:0.5.0-cpu`, `grafana/loki:latest`, `prom/pushgateway:latest`, `prom/prometheus:latest`, `grafana/grafana:latest`.

**No scope drift requiring operator redirect.** Proceeding.

---

## Architecture Decisions

### Tagging strategy

Two tags per image on every main-branch push:
- `ghcr.io/davistroy/open-brain/<name>:sha-<7-char-SHA>` — immutable, enables exact rollback
- `ghcr.io/davistroy/open-brain/<name>:latest` — convenience tag for `docker compose pull` without pinning

The compose file will reference the `latest` tag by default. The rollback runbook documents how to pin to a specific SHA tag.

### Profile strategy for local dev

A `local-build` profile restores `build:` directives. Any developer (or CI integration test) can run `docker compose --profile local-build up --build` to build from source instead of pulling from GHCR. Without the profile, services use `image:` only.

The `integration-test` CI job (`docker-compose.test.yml`) already builds from source directly — it is unaffected by this change (it does not reference the main `docker-compose.yml`).

### Build caching

GitHub Actions Docker layer cache via `type=gha` cache — significant speedup after first push since the Node 22 alpine base layer and pnpm install layer change infrequently.

### GHCR authentication

Uses the built-in `GITHUB_TOKEN` — no additional secrets required. Packages will be published under `ghcr.io/davistroy/open-brain/*` and visibility set to private (single operator).

### Homeserver pull authentication

The homeserver needs a `~/.docker/config.json` entry (or `.env` with `CR_PAT`) to pull private GHCR packages. The deploy runbook covers this one-time setup using a fine-grained PAT with `read:packages` scope.

---

## Work Items

### 1.1 — Create `.github/workflows/build-images.yml`

**File:** `.github/workflows/build-images.yml` (new)

On every push to `main`:
1. Checkout with full history
2. Log in to `ghcr.io` with `GITHUB_TOKEN`
3. Set up Docker Buildx with `type=gha` layer cache
4. Extract short SHA (`git rev-parse --short HEAD`)
5. Build and push each of the 8 images with two tags: `sha-<SHORT_SHA>` and `latest`
6. Multi-stage images (root `Dockerfile`) are built once per target using `--target` flag
7. For `voice-pipecat` and `file-ingestion`: `context` is the package subdirectory
8. For `ingest-sidecar`: `context` is the repo root (script paths in Dockerfile are relative to root)

Key workflow structure:
```yaml
on:
  push:
    branches: [main]

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v5
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/setup-buildx-action@v3
      - id: meta
        run: echo "sha=$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"
      # One build-push-action step per image
      # uses: docker/build-push-action@v6
```

Images with `--target` (from root Dockerfile): `core-api`, `workers`, `slack-bot`, `voice-capture`
Images with separate Dockerfile: `web` (context=`.`, dockerfile=`packages/web/Dockerfile`), `voice-pipecat` (context=`packages/voice-pipecat`), `file-ingestion` (context=`packages/file-ingestion`)
Ingest sidecar: context=`.`, dockerfile=`docker/ingest-sidecar/Dockerfile`

**Acceptance:** On merge to main, all 8 images appear at `ghcr.io/davistroy/open-brain/*:latest` in GitHub Packages.

---

### 1.2 — Update `docker-compose.yml` to use GHCR images + add `local-build` profile

**File:** `docker-compose.yml`

For each of the 8 custom services, replace or supplement the `build:` block:

**Pattern for each service:**
```yaml
  core-api:
    image: ghcr.io/davistroy/open-brain/core-api:latest
    build:
      context: .
      target: core-api
      profiles:
        - local-build
    # ... rest unchanged
```

The `build:` block under a `profiles: [local-build]` causes Docker Compose to use `image:` by default and only rebuild from source when `--profile local-build` is passed. This is the compose v2 mechanism for fallback builds.

**Special case: `financial-ingest` and `utility-ingest`**

Currently these services share `image: open-brain-ingest-sidecar:latest`. This must become:
```yaml
  financial-ingest:
    image: ghcr.io/davistroy/open-brain/ingest-sidecar:latest
    build:
      context: .
      dockerfile: docker/ingest-sidecar/Dockerfile
      profiles:
        - local-build
```

Same for `utility-ingest`.

**Acceptance:** `docker compose config` with no profile shows `image:` references; with `--profile local-build` shows `build:` blocks. `docker compose pull` on a clean homeserver pulls all 8 images successfully.

---

### 1.3 — Create `docs/runbooks/deploy.md`

**File:** `docs/runbooks/deploy.md` (new)

Sections:
1. **One-time homeserver GHCR authentication setup** — create a GitHub PAT with `read:packages`, store in Bitwarden (`dev/open-brain/ghcr-pat`), configure `~/.docker/config.json` on homeserver or add `CR_PAT` to `.env.secrets` and run `echo $CR_PAT | docker login ghcr.io -u davistroy --password-stdin`
2. **Normal deploy flow** (post-P17): `git pull` + `docker compose pull` + `docker compose up -d --remove-orphans`
3. **Verify deploy** — `docker compose ps`, `docker ps --format "{{.Names}} {{.Image}}"` to confirm images updated, health check `curl -s http://localhost:3002/api/v1/captures?limit=1`
4. **Rollback to prior SHA** — `docker compose pull <image>:<sha-XXXXXXX>` then `docker compose up -d` with pinned image reference or via override file
5. **Emergency local build fallback** — `docker compose --profile local-build up -d --build <service>` if GHCR is unreachable or an image is broken
6. **Deploy with pending migration** — checklist: apply migration first (psql), then `docker compose pull && docker compose up -d`

---

### 1.4 — LAB_NOTEBOOK pre-action entry

Per CLAUDE.md mandatory rule: before first commit, write LAB_NOTEBOOK entry with Objective, Hypothesis, and Rollback plan.

**This is Gate 3 implementer responsibility** — write the entry before committing any code.

---

## Acceptance Criteria (from PHASED_PLAN.md + plan refinement)

| # | Criterion | How verified |
|---|---|---|
| AC-1 | Every merge to main publishes tagged images to GHCR | Check GitHub Packages tab after first merge: 8 image repos under `ghcr.io/davistroy/open-brain/` |
| AC-2 | `docker compose pull` on homeserver succeeds (authenticated) | Operator runs on homeserver; all 8 images download |
| AC-3 | `docker compose up -d` after pull starts all containers from GHCR images | `docker ps --format "{{.Names}} {{.Image}}"` shows `ghcr.io/...` image references |
| AC-4 | Rollback to prior SHA tested | Operator runs: pin one service to prior SHA tag, `docker compose up -d`, confirm old image running |
| AC-5 | `--profile local-build` still works for local dev | `docker compose --profile local-build up --build core-api` builds from source |
| AC-6 | `docs/runbooks/deploy.md` exists and covers all 4 scenarios | File present and reviewed |
| AC-7 | Build workflow completes in under 20 minutes on ubuntu-latest | Check Actions run time after first merge |

---

## Deliverables Checklist

- [ ] `.github/workflows/build-images.yml` — 8 images, 2 tags each, GHA layer cache
- [ ] `docker-compose.yml` — all 8 custom services use `image: ghcr.io/...`, `build:` moved under `profiles: [local-build]`
- [ ] `docs/runbooks/deploy.md` — one-time auth, normal deploy, rollback, emergency local build, migration checklist
- [ ] LAB_NOTEBOOK entry (pre-action: Objective + Hypothesis + Rollback)

---

## Rollback Plan

**If GHCR publish breaks CI or homeserver deploy:**
1. Revert `docker-compose.yml` to restore `build:` as default (remove `profiles:` from build blocks, remove `image:` lines)
2. Revert `.github/workflows/build-images.yml` (delete the workflow)
3. Homeserver reverts to `docker compose up -d --build` pattern — unchanged from pre-P17 behavior

**No data changes. No migrations. No schema changes.**

Rollback is a `git revert` of the PR squash commit; homeserver needs one `git pull` + `docker compose up -d --build` to restore prior state.

---

## Notes for Implementer

1. **Build job should run on `ubuntu-latest`, not `self-hosted`** — homeserver is not a GitHub Actions runner and the push workflow does not require homeserver access.

2. **Workflow trigger: `push.branches: [main]` only.** Do NOT trigger on PRs — the PR branch workflow (`ci.yml`) is sufficient for validation. Building all 8 images on every PR would waste Actions minutes.

3. **`ingest-sidecar` build context is the repo root**, not `docker/ingest-sidecar/`, because the Dockerfile copies from `scripts/financial-pipeline.py`, `scripts/utility-pipeline.py`, `scripts/lib/`, and `config/` — all relative to the repo root. Verify the `COPY` statements in `docker/ingest-sidecar/Dockerfile` when writing the workflow step.

4. **Do not change CI `build-and-test` job** — it builds packages for testing, not Docker images. The two workflows are independent.

5. **Package visibility** — after the first push, navigate to `github.com/davistroy` → Packages and set each package to Private if it isn't already. The `GITHUB_TOKEN` workflow creates packages as private by default for private repos. Verify after first run.

6. **`docker compose pull` behavior** — compose v2 only pulls services that have an `image:` key. Services with only `build:` are skipped. After 1.2 lands, all 8 custom services will have `image:` (required for pull to work).

7. **Himalaya binary in workers image** — `Dockerfile` workers target downloads `himalaya.x86_64-linux.tgz` at build time. This bakes the binary into the GHCR image. No runtime download needed on homeserver. Architecture is x86_64 (homeserver is i7-9700, confirmed x86_64).

8. **`continue-on-error`**: the new `build-images` workflow should NOT have `continue-on-error`. A failed image push is a blocking failure that must be fixed before deploying.

---

## Effort Breakdown

| Work item | Estimate |
|---|---|
| 1.1 Build workflow (8 images, cache, auth) | 3–4 hours |
| 1.2 docker-compose.yml profile restructure | 1 hour |
| 1.3 deploy.md runbook | 1 hour |
| 1.4 LAB_NOTEBOOK entry | 15 min |
| Testing: verify workflow triggers + pull on clean env | 1–2 hours (operator-assisted) |
| **Total** | **~6–8 hours** |

Calendar estimate: 1 day.

---

## Post-merge Homeserver Deploy (Gate 5.5 advisory)

This phase has a Gate 5.5 because `docker-compose.yml` changes. Steps for operator:

```bash
# 1. SSH to homeserver
ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net
cd /mnt/user/appdata/open-brain

# 2. One-time GHCR auth (only needed if not already configured)
#    Get PAT from Bitwarden: bws secret get dev/open-brain/ghcr-pat
export CR_PAT=<pat-from-bitwarden>
echo "$CR_PAT" | docker login ghcr.io -u davistroy --password-stdin

# 3. Pull latest code
git pull origin main

# 4. Pull new images (will take a few minutes on first pull)
docker compose pull

# 5. Restart with new images
docker compose up -d --remove-orphans

# 6. Verify all containers running from GHCR images
docker ps --format "table {{.Names}}\t{{.Image}}" | grep open-brain

# 7. Health check
curl -s http://localhost:3002/api/v1/captures?limit=1 | head -c 100
```

**Expected output from step 6:** Each open-brain service shows `ghcr.io/davistroy/open-brain/<name>:latest` as the image.

**Rollback if anything fails:**
```bash
git revert HEAD  # reverts compose changes
docker compose up -d --build  # rebuilds from source locally
```
