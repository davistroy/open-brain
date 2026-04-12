# Deployment Implementation Plan

**Generated:** 2026-04-12 09:00:00
**Revised:** 2026-04-12 — incorporated Ollama, Gitea, and networking reconnaissance
**Based On:** Ultra Plan analysis + infrastructure reconnaissance (LAB_NOTEBOOK Entry 027)
**Total Phases:** 4
**Estimated Total Effort:** ~200 LOC code fixes + operational deployment tasks

---

## Executive Summary

This plan deploys the v2 unified implementation (PR #48, merged 2026-04-12) to the homeserver and activates all new subsystems.

**Key findings from infrastructure reconnaissance:**
- **Ollama** is already running as a standalone container with `gemma4:e4b` (9.6 GB). Reuse it — do not create a duplicate in docker-compose.
- **Gitea wiki repo** (`davistroy/open-brain-wiki`) already exists as a **private** repo. Containers need: (1) `git` binary installed, (2) Gitea access token for auth, (3) network connectivity via `docker network connect`.
- **Both Ollama and Gitea** must be connected to the `open-brain_open-brain` Docker network after every `docker compose up`. This needs automation.
- **5 database migrations** (0013-0017) must be applied — 6 new tables + 2 new columns.
- **OneDrive file ingestion** is deferred until the sync completes and files are organized.

The deployment sequence: fix blockers → build and deploy → validate → activate wiki and intelligence.

---

## Plan Overview

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies |
|-------|------------|------------------|-----------------|--------------|
| 1 | Pre-Deploy Code Fixes | Dockerfile git fix, Ollama compose removal, Gitea URL/token config, network automation, init-schema update, secrets template | S (~6 files, ~250 LOC) | None |
| 2 | Deploy and Migrate | Docker build/up, migrations 0013-0017, network connects, container verification | Operational | Phase 1 |
| 3 | Post-Deploy Validation | Regression tests, dashboard verification, T0 validation, MCP tools | Operational | Phase 2 |
| 4 | Wiki and Intelligence Activation | Wiki worker verification, autonomy promotion, Pipecat status check | Operational | Phase 3 |

<!-- BEGIN PHASES -->

---

## Phase 1: Pre-Deploy Code Fixes

**Estimated Complexity:** S (~6 files, ~250 LOC)
**Dependencies:** None
**Parallelizable:** Yes — all items are independent

### Goals

- Fix deployment blocker: add `git` to Docker images for WikiGitService
- Remove Ollama from docker-compose (reuse existing standalone container)
- Update wiki config for actual Gitea URL and add token-based auth
- Automate `docker network connect` for Ollama and Gitea after compose up
- Update init-schema.sql for disaster recovery
- Create secrets template documenting all required environment variables

### Work Items

#### 1.1 Add git to Docker Base Image
**Status: COMPLETE 2026-04-12**
**Requirement Refs:** LAB_NOTEBOOK Entry 027 — confirmed `git` missing from Alpine containers

**Files Affected:**
- `Dockerfile` (modify) — add `git` to `apk add` in prod-base stage

**Description:**
WikiGitService uses `simple-git` which shells out to the `git` binary. Confirmed missing: `docker exec open-brain-core-api sh -c 'git --version'` returns "not found" on both core-api and workers containers.

**Tasks:**
1. [ ] In `Dockerfile` prod-base stage, change `RUN apk add --no-cache bash` to `RUN apk add --no-cache bash git`
2. [ ] Verify `packages/web/Dockerfile` does NOT need git (web container doesn't use WikiGitService)

**Acceptance Criteria:**
- [ ] Docker build completes without errors
- [ ] `git --version` works inside core-api and workers containers after rebuild

---

#### 1.2 Remove Ollama from Docker Compose and Configure Network Automation
**Status: COMPLETE 2026-04-12**
**Requirement Refs:** LAB_NOTEBOOK Entry 027 — Ollama already running standalone

**Files Affected:**
- `docker-compose.yml` (modify) — comment out ollama service, remove ollama_data volume
- `scripts/post-compose-up.sh` (create) — network connect automation

**Description:**
A standalone Ollama container (`gemma4:e4b`, 9.6 GB) is already running on homeserver. Rather than creating a duplicate, we connect both Ollama and Gitea to the `open-brain_open-brain` network after each `docker compose up`. This requires a post-startup script since compose recreates the network on every `up`.

**Tasks:**
1. [ ] Comment out the `ollama` service block in `docker-compose.yml` with a note: `# Ollama runs as standalone container — connected via post-compose-up.sh`
2. [ ] Remove `ollama_data` from the `volumes:` section (model data lives in standalone container's volume)
3. [ ] Create `scripts/post-compose-up.sh`:
   ```bash
   #!/bin/bash
   # Connect standalone containers to the Open Brain network
   # Run after every: docker compose up -d
   
   NETWORK="open-brain_open-brain"
   
   for CONTAINER in ollama Gitea; do
     if docker inspect "$CONTAINER" >/dev/null 2>&1; then
       docker network connect "$NETWORK" "$CONTAINER" 2>/dev/null && \
         echo "Connected $CONTAINER to $NETWORK" || \
         echo "$CONTAINER already connected to $NETWORK"
     else
       echo "WARNING: $CONTAINER container not found"
     fi
   done
   ```
4. [ ] Verify `OLLAMA_URL=http://ollama:11434/v1` in core-api and workers env (already set — confirm still correct after ollama service removal)

**Acceptance Criteria:**
- [ ] `docker compose config` validates without ollama service
- [ ] `post-compose-up.sh` connects both Ollama and Gitea to the network
- [ ] Core-api can reach `http://ollama:11434/v1/models` after script runs
- [ ] Core-api can reach `http://Gitea:3000/` after script runs

---

#### 1.3 Update Wiki Configuration for Gitea
**Status: COMPLETE 2026-04-12**
**Requirement Refs:** LAB_NOTEBOOK Entry 027 — Gitea URL is `Gitea:3000`, repo is private

**Files Affected:**
- `config/wiki.yaml` (modify) — update repo_url to actual Gitea URL
- `docker-compose.yml` (modify) — add GITEA_TOKEN env var to core-api and workers

**Description:**
The wiki repo is private. Containers must authenticate via Gitea access token in the clone URL. The URL must use the Docker container name `Gitea` (not `gitea.k4jda.net` which doesn't resolve from containers).

**Tasks:**
1. [ ] Update `config/wiki.yaml` `repo_url` from `gitea.k4jda.net/davistroy/open-brain-wiki.git` to `http://Gitea:3000/davistroy/open-brain-wiki.git`
2. [ ] Add note in wiki.yaml: `# Token auth: GITEA_TOKEN env var is embedded in clone URL by WikiGitService`
3. [ ] Add `GITEA_TOKEN: ${GITEA_TOKEN}` to core-api and workers environment sections in `docker-compose.yml`
4. [ ] Verify WikiGitService in `packages/shared/src/services/wiki-git.ts` supports token-based HTTP auth (token embedded in URL: `http://davistroy:${token}@Gitea:3000/...`). If not, add support.
5. [ ] Create Gitea API token (via Gitea web UI or API) and store in Bitwarden as `dev/open-brain/gitea-token`

**Acceptance Criteria:**
- [ ] wiki.yaml has correct Gitea URL
- [ ] WikiGitService can clone private repo with token auth
- [ ] GITEA_TOKEN env var in docker-compose.yml

**Notes:**
The Gitea access token should have `repo` scope (read/write). Create via Gitea Settings → Applications → Generate Token. Token goes in `.env.secrets` on homeserver, NOT in committed config.

---

#### 1.4 Update init-schema.sql for Disaster Recovery
**Status: COMPLETE 2026-04-12**
**Requirement Refs:** Ultra Plan Phase 1 — init-schema.sql missing tables from migrations 0013-0017

**Files Affected:**
- `scripts/init-schema.sql` (modify) — add 6 new tables + 2 new columns

**Description:**
The init-schema.sql baseline is missing tables from migrations 0013-0017: `activity_feed`, `mcp_activity`, `backup_log`, `email_drafts`, `container_health`, `voice_sessions`, plus `client_used` and `cost_usd` columns on `ai_audit_log`. Not a deployment blocker (migrations handle it) but is a disaster recovery risk if the Postgres volume is ever recreated.

**Tasks:**
1. [ ] Read migrations 0013-0017 and add their CREATE TABLE / ALTER TABLE statements to init-schema.sql
2. [ ] Use idempotent patterns: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
3. [ ] Add `DROP TRIGGER IF EXISTS` before any trigger creation (per CLAUDE.md rule)
4. [ ] Add appropriate indexes from the migrations

**Acceptance Criteria:**
- [ ] init-schema.sql can be applied to an empty database without errors
- [ ] All tables from migrations 0000-0017 are represented
- [ ] Script is idempotent (can be re-run)

---

#### 1.5 Create Secrets Template
**Status: COMPLETE 2026-04-12**
**Requirement Refs:** Ultra Plan — new secrets needed for v2 services

**Files Affected:**
- `deploy/.env.secrets.template` (create)

**Description:**
Document all secrets needed across all services, with Bitwarden retrieval instructions.

**Tasks:**
1. [ ] Create `deploy/.env.secrets.template` listing ALL secrets:
   - `LITELLM_API_KEY` — OpenAI API key (Bitwarden: `open-brain-openai-api-key`)
   - `MCP_API_KEY` — MCP bearer token (Bitwarden: existing)
   - `SLACK_BOT_TOKEN` — Slack bot token (Bitwarden: existing)
   - `SLACK_APP_TOKEN` — Slack app token (Bitwarden: existing)
   - `SLACK_USER_TOKEN` — Slack user token for interactive features (NEW)
   - `PUSHOVER_USER_KEY` — Pushover user key (Bitwarden: existing)
   - `PUSHOVER_API_TOKEN` — Pushover API token (Bitwarden: existing)
   - `GITEA_TOKEN` — Gitea API token for private wiki repo (NEW — Bitwarden: `dev/open-brain/gitea-token`)
   - `DEEPGRAM_API_KEY` — Deepgram STT/TTS for voice-pipecat (NEW — optional, voice degraded without it)
   - `ANTHROPIC_API_KEY` — Claude API for voice-pipecat + future routing (NEW — optional for now)
   - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` — outbound email via Himalaya (NEW)
2. [ ] Add Bitwarden item names and `bws` retrieval commands as comments
3. [ ] Ensure `deploy/.env.secrets*` is in `.gitignore`

**Acceptance Criteria:**
- [ ] Template lists every secret referenced in docker-compose.yml
- [ ] Each secret has Bitwarden retrieval instructions
- [ ] Not committed with real values

---

### Phase 1 Testing Requirements

- [ ] Docker builds succeed with `git` added to Alpine base
- [ ] `docker compose config` validates without ollama service
- [ ] `post-compose-up.sh` runs without errors (on homeserver or tested logic)
- [ ] wiki.yaml has correct Gitea URL (`Gitea:3000`)
- [ ] WikiGitService supports token-based HTTP auth
- [ ] init-schema.sql applies cleanly to empty database
- [ ] Secrets template covers all docker-compose.yml references
- [ ] All existing 2,423 unit tests pass

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] All code changes committed and pushed
- [ ] Docker build verified locally
- [ ] LAB_NOTEBOOK.md entry created

---

## Phase 2: Deploy and Migrate

**Estimated Complexity:** Operational
**Dependencies:** Phase 1 (code fixes committed and pushed)
**Parallelizable:** No — sequential deployment steps

### Goals

- Build and deploy all containers to homeserver
- Apply database migrations 0013-0017
- Connect Ollama and Gitea to the Open Brain network
- Verify all services are healthy

### Work Items

#### 2.1 Build and Deploy Containers
**Status: PENDING**

**Description:**
SSH to homeserver, pull latest code, populate secrets, build all Docker images, and bring up the stack.

**Tasks:**
1. [ ] SSH to homeserver: `ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net`
2. [ ] `cd /mnt/user/appdata/open-brain && git pull origin main`
3. [ ] Create `.env.secrets` from template, populate from Bitwarden via `bws secret list`
4. [ ] Build all images: `sudo docker compose build` (several minutes — includes git in Alpine)
5. [ ] Stop old stack: `sudo docker compose down`
6. [ ] Start new stack: `sudo docker compose up -d`
7. [ ] Run post-compose script: `sudo bash scripts/post-compose-up.sh` (connects Ollama + Gitea)
8. [ ] Monitor startup: `sudo docker compose logs -f --tail=20`

**Acceptance Criteria:**
- [ ] All containers show "healthy" or "running"
- [ ] No crash loops in logs
- [ ] Core-api: `curl http://localhost:3002/health` returns healthy
- [ ] Web: `curl -s http://localhost:5173 | head -1` returns HTML
- [ ] Ollama reachable from core-api: verified via health endpoint
- [ ] Gitea reachable from core-api: verified via wiki health

---

#### 2.2 Apply Database Migrations
**Status: PENDING**

**Description:**
Apply migrations 0013 through 0017 — 6 new tables, 2 new columns. Idempotent patterns.

**Tasks:**
1. [ ] Check current state: `sudo docker exec open-brain-postgres psql -U openbrain -c "\dt" | wc -l`
2. [ ] Apply in order:
   ```
   for f in 0013_ai_audit_log_client_tracking 0014_activity_feed 0014_mcp_activity 0015_backup_log 0015_email_drafts 0016_container_health 0017_voice_sessions; do
     sudo docker exec -i open-brain-postgres psql -U openbrain < packages/shared/drizzle/${f}.sql
   done
   ```
3. [ ] Verify: `sudo docker exec open-brain-postgres psql -U openbrain -c "\dt" | grep -E "activity_feed|mcp_activity|backup_log|email_drafts|container_health|voice_sessions"`
4. [ ] Verify columns: `sudo docker exec open-brain-postgres psql -U openbrain -c "\d ai_audit_log" | grep -E "client_used|cost_usd"`

**Acceptance Criteria:**
- [ ] All 6 new tables exist
- [ ] ai_audit_log has `client_used` and `cost_usd` columns
- [ ] No migration errors
- [ ] API routes using new tables return 200

---

#### 2.3 Verify All Services Healthy
**Status: PENDING**

**Description:**
Comprehensive health check of every service after deployment.

**Tasks:**
1. [ ] Health endpoint: `curl http://localhost:3002/health` — all services healthy
2. [ ] Redis: `sudo docker exec open-brain-redis redis-cli ping` — PONG
3. [ ] Postgres: `sudo docker exec open-brain-postgres psql -U openbrain -c "SELECT COUNT(*) FROM captures"`
4. [ ] Slack bot: logs show "Connected to Slack"
5. [ ] Workers: logs show scheduler registrations (all skills including new ones)
6. [ ] File-ingestion: `curl http://localhost:8080/health` — ok
7. [ ] Voice-pipecat: check container status (may be degraded without DEEPGRAM_API_KEY — acceptable)
8. [ ] Cloudflare tunnel: verify `brain.troy-davis.com` resolves
9. [ ] Ollama: health endpoint shows ollama available
10. [ ] Wiki: health endpoint shows wiki status (may show "not initialized" until first clone — acceptable)

**Acceptance Criteria:**
- [ ] Core services healthy: postgres, redis, core-api, workers, slack-bot, web, cloudflared, file-ingestion
- [ ] Ollama and Gitea connected to network and reachable
- [ ] External access works via brain.troy-davis.com

---

### Phase 2 Completion Checklist

- [ ] All containers running
- [ ] Migrations applied (0013-0017)
- [ ] Ollama + Gitea connected to open-brain network
- [ ] Health checks passing
- [ ] LAB_NOTEBOOK.md entry created

---

## Phase 3: Post-Deploy Validation

**Estimated Complexity:** Operational
**Dependencies:** Phase 2 (all services healthy)
**Parallelizable:** Yes — all items independent

### Goals

- Verify no regressions from v1.5.0 functionality
- Validate new dashboard features work in production
- Confirm T0 classification quality on existing Ollama
- Verify MCP tools including new ones

### Work Items

#### 3.1 Run Regression Test Suite
**Status: PENDING**

**Tasks:**
1. [ ] `bash scripts/e2e-phase1.sh` — expect 8/8 pass
2. [ ] `bash scripts/e2e-full.sh` — expect 37+ pass, 0 fail
3. [ ] `node scripts/regression-test.mjs` — expect 87+ pass, 0 bug
4. [ ] Document any failures with root cause

**Acceptance Criteria:**
- [ ] e2e-phase1: 100% pass
- [ ] e2e-full: 0 failures
- [ ] regression: >=95% pass rate, 0 bugs

---

#### 3.2 Verify New Dashboard Features
**Status: PENDING**

**Tasks:**
1. [ ] Navigate to brain.troy-davis.com
2. [ ] StatusStrip at top — health indicators visible
3. [ ] System page — 5 sub-tabs (Queues, Skills, Flows, Infrastructure, MCP Activity)
4. [ ] Settings page — new sections (Voice, Wiki, Email config)
5. [ ] Wiki page — shows wiki browser (after workers clone the repo)
6. [ ] Email page — 3 tabs (Inbound, Drafts/Outbox, Threads)
7. [ ] Voice Conversations page — session list renders
8. [ ] Search page — synthesis answer card works

**Acceptance Criteria:**
- [ ] All pages load without JavaScript errors
- [ ] New features display real data from API

---

#### 3.3 Validate T0 Classification Quality
**Status: PENDING**

**Description:**
Run the validation suite against the existing Ollama/Gemma 4. 90% accuracy threshold required.

**Tasks:**
1. [ ] Run: `npx tsx scripts/validate-t0-classification.ts --t0-url http://homeserver.k4jda.net:11434/v1 --t0-model gemma4:e4b`
2. [ ] Check accuracy: intent >= 90%, capture_type >= 90%, brain_view >= 90%
3. [ ] Optionally run comparison with `--compare` flag against current OpenAI model
4. [ ] If any task below 90%: update `config/ai-routing.yaml` `task_routing` to keep that task on `t1_fast`

**Acceptance Criteria:**
- [ ] T0 accuracy >= 90% on all classification tasks, OR
- [ ] Below-threshold tasks documented and reassigned to T1

---

#### 3.4 Verify MCP Tools
**Status: PENDING**

**Tasks:**
1. [ ] Test `brain_stats` via curl with Bearer auth
2. [ ] Test `search_brain` with a query
3. [ ] Test `capture_thought` — create and verify a capture
4. [ ] Test `get_capture` — fetch the created capture
5. [ ] Verify wiki MCP tools respond appropriately (may return "wiki not ready" initially)
6. [ ] Check mcp_activity table for logged entries

**Acceptance Criteria:**
- [ ] All 8 core MCP tools functional
- [ ] MCP activity logged to mcp_activity table

---

### Phase 3 Completion Checklist

- [ ] Regression tests pass
- [ ] Dashboard verified
- [ ] T0 classification validated (or tasks reassigned)
- [ ] MCP tools working
- [ ] LAB_NOTEBOOK.md entry created

---

## Phase 4: Wiki and Intelligence Activation

**Estimated Complexity:** Operational
**Dependencies:** Phase 3 (system validated)
**Parallelizable:** Yes — items 4.1-4.2 (wiki) independent of 4.3-4.4 (intelligence/voice)

### Goals

- Verify wiki workers can clone and operate on the existing Gitea repo
- Promote autonomy level from observe to assist
- Check Pipecat voice service status

### Work Items

#### 4.1 Verify Wiki Workers
**Status: PENDING**

**Description:**
The Gitea wiki repo already exists with WIKI_SCHEMA.md and directory structure. Verify the wiki-ingest, wiki-lint, and wiki-synthesis workers can clone it and operate.

**Tasks:**
1. [ ] Check worker logs for wiki repo clone success (WikiGitService initializes on startup)
2. [ ] If clone failed: verify GITEA_TOKEN is set, URL is correct, network connectivity works
3. [ ] Trigger wiki-lint manually: `POST /api/v1/skills/wiki-lint/trigger`
4. [ ] Verify lint report written to wiki repo `wiki/maintenance/` directory
5. [ ] Check Wiki.tsx page — should show wiki browser with nav tree
6. [ ] Verify git push works (lint report committed back to Gitea)

**Acceptance Criteria:**
- [ ] Wiki repo cloned successfully by workers container
- [ ] Wiki-lint produces and commits a lint report
- [ ] Wiki.tsx shows navigation tree and page content
- [ ] Git push to Gitea works (token auth confirmed)

---

#### 4.2 Test Wiki-Ingest Pipeline
**Status: PENDING**

**Description:**
Create a test capture and verify it flows through the wiki-ingest pipeline stage, creating a wiki page.

**Tasks:**
1. [ ] Create a capture via API: `POST /api/v1/captures` with meaningful content
2. [ ] Monitor pipeline: verify wiki-ingest job fires (check BullMQ queue or logs)
3. [ ] Verify a wiki page was created in `wiki/sources/` directory
4. [ ] Check page has correct YAML frontmatter (title, type, source_captures, etc.)
5. [ ] Verify page appears in Wiki.tsx browser

**Acceptance Criteria:**
- [ ] Capture triggers wiki-ingest pipeline stage
- [ ] Wiki page created with correct format per WIKI_SCHEMA.md
- [ ] Page visible in dashboard wiki browser

**Notes:**
This requires `WIKI_REPO_URL` set and FlowProducer DAG active (both deployed in PR #48). The wiki-ingest child is gated on `WIKI_REPO_URL` being truthy.

---

#### 4.3 Promote Autonomy Level
**Status: PENDING**

**Description:**
Promote from `observe` to `assist`. Enables: daily sweep Pushover notifications, auto-response Slack DMs with interactive buttons, pipeline-health alerts.

**Tasks:**
1. [ ] Navigate to Settings page on brain.troy-davis.com
2. [ ] Change Autonomy Level from "Observe" to "Assist"
3. [ ] Verify: `GET /api/v1/settings/autonomy_level` returns `assist`
4. [ ] Wait for next daily-sweep-skill (8 PM) or trigger manually
5. [ ] Verify Pushover notification received
6. [ ] Verify auto-response shadow logs appearing (check worker logs)

**Acceptance Criteria:**
- [ ] Autonomy level set to `assist`
- [ ] Proactive features deliver notifications
- [ ] Reversible via Settings page if needed

---

#### 4.4 Check Pipecat Voice Service
**Status: PENDING**

**Description:**
Verify voice-pipecat container status. Full 10+ conversation validation is deferred until Deepgram API key is configured.

**Tasks:**
1. [ ] Check voice-pipecat container logs
2. [ ] If DEEPGRAM_API_KEY configured: test WebSocket on port 8765
3. [ ] If NOT configured: document as pending, verify legacy voice-capture still works
4. [ ] Verify voice session API: `GET /api/v1/voice/sessions` returns empty list (no errors)

**Acceptance Criteria:**
- [ ] Voice-pipecat container running (even if degraded)
- [ ] Voice session API endpoints functional
- [ ] Legacy voice-capture + faster-whisper continue working as fallback

---

### Phase 4 Completion Checklist

- [ ] Wiki workers clone and operate on Gitea repo
- [ ] Wiki-ingest pipeline creates pages from captures
- [ ] Autonomy promoted to assist
- [ ] Pipecat status documented
- [ ] LAB_NOTEBOOK.md entry created

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| 1.1 (Dockerfile) | 1.2, 1.3, 1.4, 1.5 | All Phase 1 items independent |
| 1.2 (Ollama/network) | 1.1, 1.3, 1.4, 1.5 | Different files |
| 1.3 (Wiki config) | 1.1, 1.2, 1.4, 1.5 | Different files |
| 3.1 (regression) | 3.2, 3.3, 3.4 | All validation items independent |
| 4.1-4.2 (wiki) | 4.3-4.4 (intelligence) | Wiki and intelligence independent |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Docker build fails on homeserver | Low | High | Build locally first, test with `docker compose build` |
| Migrations fail on production DB | Low | High | Backup DB before applying; migrations are idempotent |
| Gitea token auth doesn't work from containers | Medium | Medium | Test HTTP clone with token from inside container before full deploy |
| Ollama/Gitea disconnect after compose restart | High | Medium | `post-compose-up.sh` automates reconnection; add to monthly maintenance |
| Voice-pipecat fails without Deepgram key | High | Low | Legacy voice-capture continues; Pipecat deferred |
| T0 classification quality below 90% | Medium | Low | Tasks below threshold stay on T1 (Haiku); fallback chain handles it |
| init-schema.sql update introduces errors | Low | Low | Only used for disaster recovery; test on empty DB |

---

## Success Metrics

- [ ] All containers healthy on homeserver (12 compose + 2 standalone network-connected)
- [ ] Regression test suite: >=95% pass rate
- [ ] Web dashboard accessible via brain.troy-davis.com
- [ ] T0 classification accuracy >= 90% (or tasks reassigned to T1)
- [ ] Wiki workers clone and operate on existing Gitea repo
- [ ] Wiki-ingest creates pages from captures
- [ ] Autonomy level promoted to `assist`
- [ ] 5 new database migrations applied successfully

---

## Deferred Items (NOT in this plan)

| Item | Reason | When |
|------|--------|------|
| OneDrive file ingestion | Sync in progress (454K files, 207.7 GB); files need organizing first | Separate session after sync completes |
| Anthropic API key | OpenAI gpt-5.4 continues working; switch is non-urgent | When key is obtained |
| Full Pipecat voice validation | Needs Deepgram API key + 10 conversations + latency measurement | After key obtained |
| Voice container promotion | Remove voice-capture + faster-whisper after 2-week Pipecat validation | After validation |
| Full batch wiki ingestion | Requires organized OneDrive files + validated wiki-ingest quality | After pilot ingestion |

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| Git in Docker images (blocker) | Entry 027 reconnaissance | 1 | 1.1 |
| Reuse existing Ollama + network automation | Entry 027 reconnaissance | 1 | 1.2 |
| Gitea wiki URL + token auth | Entry 027 reconnaissance | 1 | 1.3 |
| Disaster recovery schema | Ultra Plan investigation | 1 | 1.4 |
| Secrets management | Ultra Plan investigation | 1 | 1.5 |
| Container deployment | Ultra Plan CS2 | 2 | 2.1 |
| Database migrations 0013-0017 | Ultra Plan CS2 | 2 | 2.2 |
| Service health verification | Ultra Plan CS2 | 2 | 2.3 |
| Regression validation | Ultra Plan CS3 | 3 | 3.1 |
| Dashboard feature verification | Ultra Plan CS3 | 3 | 3.2 |
| T0 classification quality | Ultra Plan CS4 | 3 | 3.3 |
| MCP tool verification | Ultra Plan CS3 | 3 | 3.4 |
| Wiki worker activation | Ultra Plan CS5 | 4 | 4.1 |
| Wiki-ingest pipeline test | Ultra Plan CS5 | 4 | 4.2 |
| Autonomy promotion | Ultra Plan CS7 | 4 | 4.3 |
| Voice service check | Ultra Plan CS6 | 4 | 4.4 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-04-12*
*Source: /ultra-plan analysis → infrastructure reconnaissance → /create-plan*
*Revised: Gitea wiki exists (private), Ollama exists (standalone), OneDrive ingestion deferred*
