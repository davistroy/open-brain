# Implementation Plan — Phase 3: Operations, Observability & Wiki

**Generated:** 2026-04-15 14:45:00
**Based On:** Ultra Plan analysis (session 2026-04-15), IMPLEMENT_MASTER_PLAN.md, infrastructure audit, codebase investigation of wiki-ingest, backup systems, LLM gateway, observability stack
**Total Phases:** 8
**Estimated Total Effort:** ~1,200 LOC across ~25 files + operational changes + Grafana dashboards

---

## Executive Summary

This plan addresses 12 items across three themes: **operational fixes** (broken backups, dead Redis queues, wiki-ingest failures, Spark JSON reliability), **observability** (Prometheus metrics, Grafana dashboards, Loki log aggregation, external synthetic monitoring), and **feature completion** (Email Outbound #69, LiteLLM cost routing, Wiki Construction #60).

Key architectural insight: several "blocked" GitHub issues are actually unblocked by small fixes. Email Outbound (#69) is 90% coded — it needs deployment wiring, not development. Wiki Construction (#60) is blocked by a hardcoded model string in one file, not missing infrastructure. LiteLLM cost routing requires an env var change plus one function fix.

The observability stack leverages existing infrastructure (Prometheus, Grafana, and Pushgateway are already running) — the gap is wiring application data into these tools and building dashboards.

Change sets are grouped into integrated phases that share deployment cycles. Operational cleanup (Phases 1-2) requires no code changes and can execute immediately. LLM fixes (Phase 3) share a build+deploy cycle. Observability (Phases 6-7) builds progressively. Wiki Construction (Phase 8) depends on Phase 3 proving wiki-ingest works.

---

## Plan Overview

Phases are ordered by: (1) ops-only changes first (no build needed), (2) code changes sharing a single build+deploy, (3) new deployments, (4) multi-week work last.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies |
|-------|------------|------------------|-----------------|--------------|
| 1 | Operational Cleanup | Flush dead Redis queues, disable stale cron, update GitHub board | S (ops only) | None |
| 2 | Backup Consolidation | Remove broken BullMQ backup jobs, fix VM+homeserver scripts | S (~2 files, ~30 LOC) | None |
| 3 | LLM Reliability | Wiki-ingest model fix, JSON mode for entity extraction | M (~5 files, ~150 LOC) | None |
| 4 | Email Outbound (#69) | Migration, SMTP config, deployment, testing | S (~3 files, ~20 LOC config) | None |
| 5 | LiteLLM Cost Routing | Route through proxy, fix spend aggregation | M (~4 files, ~100 LOC) | None |
| 6 | Synthetic Monitoring | Cloudflare Worker + VM cron for external health checks | S (~2 files, ~80 LOC) | None |
| 7 | Observability Stack | prom-client, Pushgateway wiring, Grafana dashboards, Loki | M (~8 files, ~400 LOC) | Phase 5 (for cost data) |
| 8 | Wiki Construction (#60) | Schema, pilot 100 files, full 10K processing | L (content + orchestration) | Phase 3 (wiki-ingest fix) |

<!-- BEGIN PHASES -->

---

## Phase 1: Operational Cleanup

**Estimated Complexity:** S (ops only — no code changes, no builds)
**Dependencies:** None
**Parallelizable:** Yes — all items are independent

### Goals

- Free Redis memory by flushing permanently failed job residuals
- Stop wasting homeserver I/O on completed OneDrive sync
- Bring GitHub project board in sync with reality

### Work Items

#### 1.1 Flush Dead Redis Queues ✅ Completed 2026-04-15
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Items 3, 4
**Files Affected:**
- None (Redis CLI commands only)

**Description:**
10,970 failed `document-pipeline` jobs and 2,641 failed `ingest-root` jobs are residuals from the batch file ingestion run. They will never retry and are consuming Redis memory (~65MB). Also clean up associated job data hashes.

**Tasks:**
1. [ ] SSH to homeserver, exec into Redis container
2. [ ] `ZREMRANGEBYSCORE bull:document-pipeline:failed -inf +inf` — flush document-pipeline failures
3. [ ] `ZREMRANGEBYSCORE bull:ingest-root:failed -inf +inf` — flush ingest-root failures
4. [ ] Verify with `ZCARD` on both sorted sets that counts are 0
5. [ ] Check Redis memory usage before/after: `INFO memory`

**Acceptance Criteria:**
- [ ] `bull:document-pipeline:failed` count = 0
- [ ] `bull:ingest-root:failed` count = 0
- [ ] No impact on active queues (extract-entities, embed-capture still processing)

**Notes:**
Also consider flushing completed job data for document-pipeline if memory is a concern. Completed jobs are in sorted sets and have associated hash keys.

---

#### 1.2 Disable OneDrive Sync Cron ✅ Completed 2026-04-15
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Item 6
**Files Affected:**
- Homeserver crontab (claude user)

**Description:**
The `sync-onedrive.sh` script runs every 15 minutes via cron on the homeserver. OneDrive reorg is complete (19,507 moved, 2,842 deleted, 2,599 empty dirs removed). The sync is wasting I/O cycles on a stable filesystem.

**Tasks:**
1. [ ] SSH to homeserver: `ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net`
2. [ ] Comment out the sync cron entry: `crontab -e` → comment `*/15 * * * * .../sync-onedrive.sh`
3. [ ] Verify cron change: `crontab -l`

**Acceptance Criteria:**
- [ ] OneDrive sync cron commented out or removed
- [ ] No rsync processes running from the old cron

**Notes:**
If OneDrive files need re-syncing in the future, the script still exists — just re-enable the cron.

---

#### 1.3 Update GitHub Project Board ✅ Completed 2026-04-15
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Item 7
**Files Affected:**
- None (GitHub CLI commands only)

**Description:**
Four issues (#53, #59, #61, #74) were closed on 2026-04-15 but their project board columns were not updated. Issue #73 (Evaluate Qdrant) is open but not on the board.

**Tasks:**
1. [ ] Move #53 (OneDrive Sync) to Done: `gh project item-edit` or drag in UI
2. [ ] Move #59 (File Migration) to Done
3. [ ] Move #61 (Email Pipeline) to Done
4. [ ] Move #74 (Corpus Analysis) to Done
5. [ ] Add #73 (Qdrant Evaluation) to the board in Backlog column

**Acceptance Criteria:**
- [ ] All 4 closed issues show in Done column
- [ ] #73 appears on the board
- [ ] Board accurately reflects current project state

---

### Phase 1 Testing Requirements

- [ ] Redis queue counts verified via CLI after flush
- [ ] `crontab -l` confirms sync disabled
- [ ] GitHub board visually inspected

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] Redis memory freed (check INFO memory)
- [ ] No unintended side effects on active queues
- [ ] LAB_NOTEBOOK entry created

---

## Phase 2: Backup Consolidation

**Estimated Complexity:** S (~2 files changed, ~30 LOC removed)
**Dependencies:** None
**Parallelizable:** Yes — scheduler change and script fixes are independent

### Goals

- Eliminate broken BullMQ backup jobs (all failing since Apr 12 — no Docker socket in workers container)
- Fix the VM Redis backup permission error
- Fix homeserver backup.sh Docker permission error
- Establish VM cron scripts as the canonical backup system

### Work Items

#### 2.1 Remove BullMQ Backup Jobs from Scheduler ✅ Completed 2026-04-15
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Item 2
**Files Affected:**
- `packages/workers/src/scheduler.ts` (modify — remove ~60 lines)

**Description:**
Three BullMQ scheduled jobs (`db-backup`, `wiki-backup`, `redis-snapshot`) run at 2:00/2:15/2:30 AM daily but ALL fail because the workers container has no Docker socket mount and no `/backups` volume. `skills_log` confirms: every run since at least Apr 12 shows `status:failed, size:0, duration:0s`. The VM cron scripts are the working backup system.

**Tasks:**
1. [ ] Remove `db-backup` scheduled job registration (scheduler.ts lines ~308-325)
2. [ ] Remove `wiki-backup` scheduled job registration (scheduler.ts lines ~327-344)
3. [ ] Remove `redis-snapshot` scheduled job registration (scheduler.ts lines ~346-370)
4. [ ] Build shared + workers packages
5. [ ] Deploy updated workers container to homeserver
6. [ ] After deploy, clean up orphan BullMQ repeat keys: `KEYS bull:skill-execution:repeat:*backup*` → `DEL` matching keys

**Acceptance Criteria:**
- [ ] Workers startup logs show no backup job registrations
- [ ] No backup-related skill executions in `skills_log` after next 2 AM cycle
- [ ] VM cron scripts continue running as before (unaffected)

**Notes:**
The backup skills TypeScript code (`packages/workers/src/skills/db-backup.ts`, `wiki-backup.ts`, `redis-snapshot.ts`) can remain in the codebase — just removing the scheduler triggers. If Docker socket access is ever added to workers, they could be re-enabled.

---

#### 2.2 Fix VM Redis Backup Script ✅ Completed 2026-04-15
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Item 5
**Files Affected:**
- `/home/claude/scripts/redis-snapshot.sh` on open-brain-vm (192.168.10.53)

**Description:**
The VM's `redis-snapshot.sh` runs `docker cp` to extract `dump.rdb` from the Redis container, then `cat /tmp/redis-backup.rdb` to pipe it through gzip. The extracted file lands with root ownership, and the `claude` user can't read it. Result: 20-byte empty gzip files for weeks.

**Tasks:**
1. [ ] SSH to VM: `ssh -i ~/.ssh/id_claude_code claude@192.168.10.53`
2. [ ] Edit `redis-snapshot.sh`: change `cat /tmp/redis-backup.rdb` to `sudo cat /tmp/redis-backup.rdb`
3. [ ] Test manually: run the script, verify output file is >20 bytes
4. [ ] Verify next automatic run (2:30 AM) produces a valid backup

**Acceptance Criteria:**
- [ ] Redis backup file is >1KB (real RDB data, not empty gzip header)
- [ ] Automated 2:30 AM run succeeds

---

#### 2.3 Fix Homeserver Backup Script ✅ Completed 2026-04-15
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Item 2
**Files Affected:**
- `/mnt/user/appdata/open-brain/scripts/backup.sh` on homeserver

**Description:**
The homeserver's `backup.sh` runs at 3 AM daily but has been failing since Apr 11 with `permission denied while trying to connect to the Docker daemon socket`. The `claude` user needs `sudo` for docker commands.

**Tasks:**
1. [ ] SSH to homeserver: `ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net`
2. [ ] Edit `backup.sh`: prefix all `docker exec` and `docker compose` commands with `sudo`
3. [ ] Test manually: run the script, verify it produces a backup in `/mnt/user/backup/openbrain/daily/`
4. [ ] Verify next automatic run (3 AM) succeeds

**Acceptance Criteria:**
- [ ] Backup produces valid `openbrain.pgdump` + `schema.sql` + config files
- [ ] `manifest.json` contains correct table counts
- [ ] Automated 3 AM run succeeds

---

### Phase 2 Testing Requirements

- [ ] Workers startup logs show no backup job registrations
- [ ] VM Redis backup produces valid file (>1KB)
- [ ] Homeserver backup produces valid pgdump
- [ ] Verify no orphan repeat keys in Redis after cleanup

### Phase 2 Completion Checklist

- [ ] All work items complete
- [ ] Three backup systems reduced to one canonical (VM cron) + one supplemental (homeserver)
- [ ] No silent backup failures
- [ ] LAB_NOTEBOOK entry created with backup system decision and verification results

---

## Phase 3: LLM Reliability

**Estimated Complexity:** M (~5 files, ~150 LOC)
**Dependencies:** None
**Parallelizable:** No — both items share a build+deploy cycle

### Goals

- Fix wiki-ingest to use configurable, cheaper model (unblocking Wiki Construction)
- Add JSON mode enforcement for entity extraction on Spark (reducing 5% empty-entity failure rate)
- Single build+deploy cycle for both changes

### Work Items

#### 3.1 Make Wiki-Ingest Model Configurable ✅
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Item 1 (Set A)
**Files Affected:**
- `packages/workers/src/skills/wiki-ingest.ts` (modify)
- `config/ai-routing.yaml` (modify)
- `packages/workers/src/jobs/skill-execution.ts` (modify — pass configService)

**Description:**
`wiki-ingest.ts:242` hardcodes `claude-sonnet-4-5-20250929`. The skill uses `runAgent()` with the Anthropic SDK directly — it does NOT go through `ai-routing.yaml` task routing or `LLMGatewayService`. This means changing the YAML has zero effect. The 70% failure rate is Anthropic API connection timeouts during 15-iteration agent loops with Sonnet.

Fix: Change the default model to `claude-haiku-4-5-20251001` (5x cheaper, 3x faster, reliable tool use) and make it configurable via a new `wiki_agent` key in `ai-routing.yaml` models section.

**Tasks:**
1. [ ] Add `wiki_agent: "claude-haiku-4-5-20251001"` to `models:` section in `config/ai-routing.yaml`
2. [ ] In `wiki-ingest.ts`: read model from `configService.get('ai').models.wiki_agent` with fallback to `claude-haiku-4-5-20251001`
3. [ ] Ensure `configService` is passed through to WikiIngestSkill from skill-execution.ts
4. [ ] Verify wiki-ingest skill still constructs tools and runs agent loop correctly with Haiku

**Acceptance Criteria:**
- [ ] Wiki-ingest uses Haiku by default (visible in worker logs)
- [ ] Model is configurable by changing `wiki_agent` in ai-routing.yaml
- [ ] Wiki-ingest success rate >90% (was 30% with Sonnet timeouts)
- [ ] Wiki pages created have acceptable quality (manual spot-check)

**Notes:**
If Haiku wiki page quality is insufficient, upgrade to Sonnet via config change — no code change needed. The agent loop (tool use) is the critical capability; Haiku handles this well for structured wiki tasks.

---

#### 3.2 Add JSON Mode for Entity Extraction ✅
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Item 8 (Set B)
**Files Affected:**
- `packages/shared/src/services/llm-gateway.ts` (modify — add jsonMode option)
- `packages/workers/src/jobs/extract-entities.ts` (modify — enable jsonMode + retry)
- `packages/shared/src/types/config.ts` (modify — extend LLMCompleteOptions if needed)

**Description:**
`completeViaOpenAISDK()` in `llm-gateway.ts:422` does not pass `response_format` to the OpenAI SDK. Qwen 35B on Spark occasionally returns non-JSON responses (~5% failure rate), which `parseEntityResponse()` silently converts to empty arrays — those captures permanently lose their entities.

Fix: Add opt-in `jsonMode` flag to `LLMCompleteOptions`. When enabled, pass `response_format: { type: 'json_object' }` in the SDK call (vLLM supports this). Entity extraction enables it. Also add a single retry on parse failure as a safety net.

**Tasks:**
1. [ ] Add `jsonMode?: boolean` to `LLMCompleteOptions` interface
2. [ ] In `completeViaOpenAISDK()`: when `options.jsonMode` is true, include `response_format: { type: 'json_object' }` in the `create()` call
3. [ ] In `extract-entities.ts`: pass `jsonMode: true` to `completeByTask('entity_extraction', ...)`
4. [ ] In `extract-entities.ts`: after `parseEntityResponse()`, if all arrays are empty AND `raw.length > 50`, retry once (log the retry)
5. [ ] Build shared + workers packages, run tests

**Acceptance Criteria:**
- [ ] Entity extraction requests include `response_format` (verify via Spark vLLM logs or worker debug logging)
- [ ] Malformed JSON rate drops from ~5% to <1%
- [ ] Retry catches remaining edge cases
- [ ] All existing extract-entities tests pass
- [ ] No impact on non-entity-extraction LLM calls (jsonMode is opt-in)

**Notes:**
The `response_format` parameter is supported by vLLM 0.4.0+ and OpenAI API. For the `openai_compat` provider (Spark), vLLM handles it natively. If a future endpoint doesn't support it, the opt-in flag means only the specific caller is affected.

---

### Phase 3 Testing Requirements

- [ ] Shared package tests pass (184 tests)
- [ ] Workers tests pass (897 tests)
- [ ] Wiki-ingest uses configurable model (verify in deployment logs)
- [ ] Entity extraction includes response_format (verify in deployment logs)
- [ ] Manual test: submit a capture, verify entity extraction returns non-empty results

### Phase 3 Completion Checklist

- [ ] All work items complete
- [ ] Shared + workers rebuilt and deployed to homeserver
- [ ] Wiki-ingest success rate verified >90%
- [ ] Entity extraction JSON mode verified working
- [ ] LAB_NOTEBOOK entry created with before/after metrics
- [ ] CLAUDE.md updated with wiki-ingest model configuration rule

---

## Phase 4: Email Outbound (#69)

**Estimated Complexity:** S (~3 files config, migration apply, testing)
**Dependencies:** None — code is already written
**Parallelizable:** Yes

### Goals

- Deploy the already-built email outbound capability
- Close GitHub issue #69

### Work Items

#### 4.1 Apply Email Drafts Migration ✅ Completed 2026-04-15
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** GitHub Issue #69, Ultra Plan Item 9 (Set H)
**Files Affected:**
- `packages/shared/drizzle/0015_email_drafts.sql` (apply to production Postgres)

**Description:**
The `email_drafts` table migration exists but hasn't been applied to production. HimalayaService, EmailDraftService, email routes, Slack commands, MCP tools, and the email-compose skill all exist in code and reference this table.

**Tasks:**
1. [ ] SSH to homeserver, exec into Postgres container
2. [ ] Check if table already exists: `\dt email_drafts`
3. [ ] If not: apply migration `0015_email_drafts.sql`
4. [ ] Verify table created with correct schema

**Acceptance Criteria:**
- [ ] `email_drafts` table exists in production Postgres
- [ ] Schema matches migration (to_address, subject, body, status, send_mode, etc.)

---

#### 4.2 Configure Himalaya SMTP ✅ Completed 2026-04-15
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** GitHub Issue #69
**Files Affected:**
- `config/himalaya/config.toml` (create)
- `docker-compose.yml` (modify — add env var + volume mount)

**Description:**
Himalaya CLI is installed in the workers container (v1.2.0). It needs a TOML config file with SMTP credentials. The config references `config/email.yaml` for defaults (from address, display name, signature). Credentials come from Bitwarden.

**Tasks:**
1. [ ] Retrieve SMTP credentials from Bitwarden (personal email SMTP settings)
2. [ ] Create `config/himalaya/config.toml` with SMTP server, port, auth, TLS settings
3. [ ] Add `HIMALAYA_CONFIG=/app/config/himalaya/config.toml` to workers environment in docker-compose.yml
4. [ ] Ensure `config/himalaya/` directory is covered by existing `./config:/app/config:ro` mount
5. [ ] Rebuild + restart workers container

**Acceptance Criteria:**
- [ ] `HIMALAYA_CONFIG` env var set in workers container
- [ ] Himalaya config file accessible inside container
- [ ] `himalaya account check` succeeds inside container

**Notes:**
The config.toml should NOT be committed to git (contains credentials). Add `config/himalaya/config.toml` to `.gitignore`. Store credentials in Bitwarden as `dev/open-brain/himalaya-smtp`.

---

#### 4.3 End-to-End Email Testing
**Status: PENDING — blocked on SMTP credentials (Troy to provide)**
**Requirement Refs:** GitHub Issue #69
**Files Affected:**
- None (testing only)

**Description:**
Verify the full email outbound pipeline: draft creation → approval → sending → capture creation.

**Tasks:**
1. [ ] Test self-send via Slack: `!email send troy.e.davis@gmail.com "Test from Open Brain"` — verify draft created
2. [ ] Approve draft via Slack: `!email approve <draft_id>` — verify email received in Gmail
3. [ ] Test MCP tools: `draft_email` → `send_email` — verify delivery
4. [ ] Test email-compose skill: trigger via skill-execution queue with a capture that has email context
5. [ ] Verify sent email creates outbound capture with `source: 'email-outbound'`
6. [ ] Close GitHub issue #69

**Acceptance Criteria:**
- [ ] Email delivered to Gmail inbox (self-send)
- [ ] Draft lifecycle works: create → approve → send
- [ ] Outbound capture created in Open Brain
- [ ] Slack commands functional
- [ ] GitHub issue #69 closed

---

### Phase 4 Testing Requirements

- [ ] Himalaya SMTP connectivity test passes
- [ ] Self-send email delivered
- [ ] Draft approval flow works end-to-end
- [ ] No regressions to existing email capture (inbound)

### Phase 4 Completion Checklist

- [ ] All work items complete
- [ ] Email outbound fully operational
- [ ] GitHub issue #69 closed
- [ ] LAB_NOTEBOOK entry created with SMTP config details, delivery verification, and any issues found

---

## Phase 5: LiteLLM Cost Routing

**Estimated Complexity:** M (~4 files, ~100 LOC)
**Dependencies:** None
**Parallelizable:** Yes

### Goals

- Route all LLM API calls through the standalone LiteLLM proxy for unified cost tracking
- Fix broken spend aggregation code
- Enable LiteLLM's built-in budget enforcement and cost dashboards

### Work Items

#### 5.1 Route Traffic Through LiteLLM Proxy ✅ Completed 2026-04-15
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Item 11 (Set I)
**Files Affected:**
- `docker-compose.yml` (modify — 4 env var changes)

**Description:**
The standalone LiteLLM proxy is running on homeserver port 4000 with its own Postgres DB tracking all spend. Currently Open Brain goes direct to `api.openai.com`. Switching to route through the proxy gives unified cost tracking, model aliasing, and budget enforcement. The proxy is on the same Docker host, so latency is minimal (~10-50ms).

**Tasks:**
1. [ ] Verify LiteLLM proxy is on the `open-brain` Docker network: `sudo docker network inspect open-brain | grep litellm`. If not: `sudo docker network connect open-brain litellm`
2. [ ] Update `docker-compose.yml`: change `LITELLM_URL` from `https://api.openai.com/v1` to `http://litellm:4000` for core-api, workers, slack-bot, voice-capture
3. [ ] Update `docker-compose.yml`: change `LITELLM_API_KEY` to LiteLLM master key (from Bitwarden or existing config)
4. [ ] Restart all affected containers: `sudo docker compose up -d core-api workers slack-bot voice-capture`
5. [ ] Verify LLM calls succeed through proxy (check worker logs for entity extraction, check Slack for query response)

**Acceptance Criteria:**
- [ ] All LLM calls route through LiteLLM proxy (visible in LiteLLM logs)
- [ ] No increase in error rate
- [ ] Latency impact <100ms (measure before/after)

---

#### 5.2 Fix Spend Aggregation ✅
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Item 11 (Set I)
**Files Affected:**
- `packages/shared/src/services/llm-gateway.ts` (modify — `getMonthlySpend()` function)
- `packages/workers/src/skills/cost-analysis.ts` (modify — add LiteLLM spend query)

**Description:**
`getMonthlySpend()` in `llm-gateway.ts` calls `/spend/logs` but expects `{total_cost, spend_by_model}`. The actual response is a raw array of individual request records. The aggregation logic is missing.

**Tasks:**
1. [ ] Fix `getMonthlySpend()`: iterate the `/spend/logs` response array, sum the `spend` field, group by `model`
2. [ ] Return `{ totalCost: number, spendByModel: Record<string, number> }`
3. [ ] In `cost-analysis.ts`: use `getMonthlySpend()` for the primary cost data instead of local `ai_audit_log` estimation
4. [ ] Build shared package, deploy

**Acceptance Criteria:**
- [ ] `getMonthlySpend()` returns accurate aggregated data
- [ ] Cost analysis skill reports real spend from LiteLLM (not estimates)
- [ ] Budget check uses real spend for soft/hard limit enforcement

---

#### 5.3 Add LiteLLM to Health Monitoring ✅
**Status: COMPLETE [2026-04-15]**
**Requirement Refs:** Ultra Plan Item 11 (Set I)
**Files Affected:**
- `packages/workers/src/skills/container-health.ts` (modify — add litellm endpoint)

**Description:**
LiteLLM proxy becomes a critical dependency. Add it to the container-health skill's check list so failures trigger Pushover alerts.

**Tasks:**
1. [ ] Add `http://litellm:4000/health` to the container-health endpoints array
2. [ ] Build + deploy workers

**Acceptance Criteria:**
- [ ] Container-health skill checks LiteLLM every 15 minutes
- [ ] LiteLLM downtime triggers Pushover alert after 3 consecutive failures

---

### Phase 5 Testing Requirements

- [ ] LLM calls succeed through proxy (test entity extraction, search synthesis, Slack query)
- [ ] `getMonthlySpend()` returns real aggregated costs
- [ ] Container-health skill includes LiteLLM check
- [ ] No latency regression on user-facing paths

### Phase 5 Completion Checklist

- [ ] All work items complete
- [ ] All LLM traffic routed through LiteLLM proxy
- [ ] Spend aggregation returns accurate data
- [ ] LiteLLM in health monitoring
- [ ] LAB_NOTEBOOK entry created with latency measurements, cost accuracy verification, and any issues
- [ ] CLAUDE.md updated with LiteLLM routing rule

---

## Phase 6: External Synthetic Monitoring

**Estimated Complexity:** S (~2 files, ~80 LOC)
**Dependencies:** None
**Parallelizable:** Yes

### Goals

- Monitor the full external path (DNS → Cloudflare → tunnel → nginx → core-api → Postgres) from outside the infrastructure
- Alert via Pushover when the public endpoint is unreachable
- Complement existing container-internal health checks

### Work Items

#### 6.1 Deploy Cloudflare Worker Synthetic Monitor
**Status: PENDING**
**Requirement Refs:** Ultra Plan Item 12 (Set G)
**Files Affected:**
- `cloudflare/synthetic-monitor/wrangler.toml` (create)
- `cloudflare/synthetic-monitor/src/index.ts` (create)

**Description:**
Deploy a Cloudflare Worker that pings `https://brain.troy-davis.com/api/v1/health` every 5 minutes. Track consecutive failures in KV store. On 2 consecutive failures, POST to Pushover API. This tests the entire external path that container-internal checks miss.

**Tasks:**
1. [ ] Create `cloudflare/synthetic-monitor/` directory
2. [ ] Write `wrangler.toml` with cron trigger `*/5 * * * *`, KV namespace binding, and environment variables (PUSHOVER_TOKEN, PUSHOVER_USER)
3. [ ] Write `src/index.ts`: fetch health endpoint, parse JSON, check `status === 'healthy'`, track failures in KV, send Pushover on threshold
4. [ ] Store Pushover credentials as Worker secrets: `wrangler secret put PUSHOVER_TOKEN`, `wrangler secret put PUSHOVER_USER`
5. [ ] Deploy: `wrangler deploy`
6. [ ] Verify: check Worker logs in Cloudflare dashboard, confirm first successful health check

**Acceptance Criteria:**
- [ ] Worker runs every 5 minutes (visible in Cloudflare dashboard)
- [ ] Healthy state logged on each successful check
- [ ] Pushover alert sent after 2 consecutive failures (test by temporarily breaking the endpoint)
- [ ] No false positives during normal operation

**Notes:**
Set `workers_dev = false` in wrangler.toml (no HTTP route needed — cron-only worker). Use Cloudflare KV for state to survive Worker restarts.

---

#### 6.2 Add VM Cron Synthetic Check
**Status: PENDING**
**Requirement Refs:** Ultra Plan Item 12 (Set G)
**Files Affected:**
- Crontab on open-brain-vm (192.168.10.53)

**Description:**
Second monitoring path: cron job on open-brain-vm that curls the external endpoint every 15 minutes. Provides a different network path than the Cloudflare Worker (LAN → Cloudflare → back to LAN). Logs results for troubleshooting.

**Tasks:**
1. [ ] SSH to VM: `ssh -i ~/.ssh/id_claude_code claude@192.168.10.53`
2. [ ] Add cron entry: `*/15 * * * * curl -sf -o /dev/null -w '%{http_code} %{time_total}s' https://brain.troy-davis.com/api/v1/health >> /home/claude/logs/synthetic-health.log 2>&1`
3. [ ] Create log directory if needed: `mkdir -p /home/claude/logs`
4. [ ] Verify first run produces a log entry

**Acceptance Criteria:**
- [ ] Cron runs every 15 minutes
- [ ] Log captures HTTP status code and response time
- [ ] Log available for troubleshooting

---

### Phase 6 Testing Requirements

- [ ] Cloudflare Worker executes on schedule
- [ ] Worker correctly identifies healthy vs unhealthy responses
- [ ] Pushover alert fires on simulated failure
- [ ] VM cron produces log entries

### Phase 6 Completion Checklist

- [ ] All work items complete
- [ ] Two independent external monitoring paths active
- [ ] No false positive alerts over 24 hours
- [ ] LAB_NOTEBOOK entry created

---

## Phase 7: Observability Stack

**Estimated Complexity:** M (~8 files, ~400 LOC + Grafana dashboard JSON)
**Dependencies:** Phase 5 (LiteLLM routing provides cost data for dashboards)
**Parallelizable:** Items 7.1-7.2 can run in parallel; 7.3 depends on both; 7.4 is independent

### Goals

- Wire application metrics into Prometheus via Pushgateway and prom-client
- Build Grafana dashboards for system health, LLM costs, and pipeline throughput
- Deploy Loki for searchable, retained log aggregation

### Work Items

#### 7.1 Push Metrics to Pushgateway from Skills
**Status: PENDING**
**Requirement Refs:** Ultra Plan Set F1
**Files Affected:**
- `packages/workers/src/skills/pipeline-health.ts` (modify)
- `packages/workers/src/skills/container-health.ts` (modify)

**Description:**
The pipeline-health and container-health skills already collect queue depths and container response times. Add Pushgateway pushes after each check so Prometheus gets time-series data instead of point-in-time snapshots.

**Tasks:**
1. [ ] Add Pushgateway push to pipeline-health: after checking queue depths, push `openbrain_queue_waiting`, `openbrain_queue_failed`, `openbrain_queue_active` gauges per queue
2. [ ] Add Pushgateway push to container-health: push `openbrain_container_healthy` (0/1) and `openbrain_container_response_ms` per container
3. [ ] Use simple HTTP POST to `http://pushgateway:9091/metrics/job/open-brain` (Pushgateway is already running and scraped by Prometheus)
4. [ ] Build + deploy workers

**Acceptance Criteria:**
- [ ] Queue depth metrics visible in Prometheus (query: `openbrain_queue_waiting`)
- [ ] Container health metrics visible in Prometheus
- [ ] Metrics update on each skill execution cycle (every 15 min for containers, every 6 hrs for pipeline)

**Notes:**
Use the Prometheus text exposition format for the push body. No npm dependency needed — simple HTTP POST with text body.

---

#### 7.2 Add prom-client to Core API
**Status: PENDING**
**Requirement Refs:** Ultra Plan Set F2
**Files Affected:**
- `packages/core-api/package.json` (modify — add prom-client dependency)
- `packages/core-api/src/routes/metrics.ts` (create)
- `packages/core-api/src/index.ts` (modify — register /metrics route)
- Prometheus config on homeserver (modify — add scrape target)

**Description:**
Add standard Prometheus metrics export to core-api via the `prom-client` npm package. Expose a `/metrics` endpoint that Prometheus scrapes. Key metrics: HTTP request counts/durations, capture ingestion rates, LLM request counts/costs, embedding stats.

**Tasks:**
1. [ ] `pnpm --filter @open-brain/core-api add prom-client`
2. [ ] Create `src/routes/metrics.ts`: register default metrics + custom counters/histograms
3. [ ] Custom metrics: `openbrain_http_requests_total` (counter, labels: route/method/status), `openbrain_http_request_duration_seconds` (histogram, labels: route), `openbrain_captures_total` (counter, label: source), `openbrain_llm_cost_usd_total` (counter, label: model)
4. [ ] Add Hono middleware to increment HTTP metrics on each request
5. [ ] Mount `/metrics` route (no auth — internal only, not proxied by nginx)
6. [ ] Update Prometheus config on homeserver: add scrape target `core-api:3000` with `/metrics` path
7. [ ] Reload Prometheus: `sudo docker kill -s HUP prometheus`
8. [ ] Build + deploy core-api

**Acceptance Criteria:**
- [ ] `/metrics` returns Prometheus text format
- [ ] Prometheus successfully scrapes core-api (check Prometheus targets page)
- [ ] HTTP request metrics visible in Prometheus
- [ ] Custom business metrics (captures, LLM cost) visible

**Notes:**
Respect the 1.5GB memory ceiling. prom-client is lightweight (~5MB RSS overhead). Use `collectDefaultMetrics()` for Node.js runtime metrics (GC, event loop lag, memory).

---

#### 7.3 Build Grafana Dashboards
**Status: PENDING**
**Requirement Refs:** Ultra Plan Set F3
**Files Affected:**
- Grafana (UI configuration — no code files)

**Description:**
Build three Grafana dashboards using the metrics now available from prom-client (7.2), Pushgateway (7.1), and existing vLLM/node-exporter data.

**Tasks:**
1. [ ] **Dashboard 1: System Overview** — Container health grid, queue depths over time, capture ingestion rate, disk/CPU/memory from node-exporter, uptime counters
2. [ ] **Dashboard 2: LLM Cost & Performance** — Daily/weekly spend by model (from prom-client counter or LiteLLM), token usage by task type, request latency by tier, error rate by model, budget utilization with soft/hard limit lines
3. [ ] **Dashboard 3: Pipeline Health** — Pipeline throughput (captures/hour), stage latency breakdown, failure rate by stage, backlog trending (extract-entities queue), skill execution success/failure rates
4. [ ] Export dashboard JSON to `config/grafana/dashboards/` for version control
5. [ ] Configure Grafana provisioning to auto-load dashboards from the mounted directory

**Acceptance Criteria:**
- [ ] All 3 dashboards render with real data
- [ ] Dashboard JSON exported and version-controlled
- [ ] Key panels: queue depth trend, LLM cost trend, pipeline throughput, container status grid

**Notes:**
Before creating dashboards, export any existing Grafana dashboards as backup. Create new dashboards with unique UIDs to avoid conflicts (per CLAUDE.md protect-unrecoverable-work rule).

---

#### 7.4 Deploy Loki for Log Aggregation
**Status: PENDING**
**Requirement Refs:** Ultra Plan Set F4
**Files Affected:**
- `docker-compose.yml` on homeserver (modify — add Loki service)
- Docker daemon config (modify — set log driver to loki)

**Description:**
Deploy Grafana Loki for centralized, searchable log aggregation. The Loki Explore plugin is already installed in Grafana. Currently logs are only accessible via `docker logs` with no search, retention, or correlation.

**Tasks:**
1. [ ] Add Loki service to docker-compose.yml or as standalone container: `grafana/loki:latest`, port 3100, volume for data persistence
2. [ ] Configure Loki data source in Grafana (point to `http://loki:3100`)
3. [ ] Install the Loki Docker log driver plugin: `sudo docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions`
4. [ ] Configure Open Brain containers to use Loki log driver (add `logging:` section to docker-compose.yml services)
5. [ ] Verify logs appear in Grafana Explore → Loki

**Acceptance Criteria:**
- [ ] Loki service running and healthy
- [ ] Container logs searchable in Grafana Explore
- [ ] Can filter by container name, log level, and keywords
- [ ] Log retention configured (30 days default)

**Notes:**
Loki on the homeserver should be lightweight (single-tenant, local storage). Configure `retention_period: 720h` (30 days). Memory limit ~500MB to stay within the homeserver's 128GB total.

---

### Phase 7 Testing Requirements

- [ ] Prometheus scraping core-api /metrics successfully
- [ ] Pushgateway metrics visible in Prometheus
- [ ] All 3 Grafana dashboards render without errors
- [ ] Loki receives and stores container logs
- [ ] No memory or performance regressions

### Phase 7 Completion Checklist

- [ ] All work items complete
- [ ] Metrics flowing: prom-client → Prometheus → Grafana
- [ ] Metrics flowing: skills → Pushgateway → Prometheus → Grafana
- [ ] Logs flowing: containers → Loki → Grafana
- [ ] 3 dashboards operational
- [ ] LAB_NOTEBOOK entry created with dashboard screenshots and metrics verification

---

## Phase 8: Wiki Construction (#60)

**Estimated Complexity:** L (content creation + orchestration + 2-week processing)
**Dependencies:** Phase 3 (wiki-ingest fix must be deployed and validated)
**Parallelizable:** J1 is independent; J2 depends on J1; J3 depends on J2

### Goals

- Define wiki schema and conventions for consistent page creation at scale
- Validate quality with a 100-file pilot before committing to full processing
- Process ~10,000 file captures into interconnected wiki pages over ~2 weeks
- Close GitHub issue #60

### Work Items

#### 8.1 Wiki Schema & Bootstrap
**Status: PENDING**
**Requirement Refs:** GitHub Issue #60, Ultra Plan Item 10 (Set J1)
**Files Affected:**
- `WIKI_SCHEMA.md` (create — in wiki repo root via WikiGitService)
- `wiki/domains/*.md` (create — 5-10 domain stub pages)
- `config/prompts/wiki-ingest/system.txt` (modify — tune for batch file processing)

**Description:**
The wiki infrastructure exists but the wiki is essentially empty. Before bulk processing, define the schema (page types, frontmatter spec, naming conventions, cross-reference requirements) and bootstrap domain stub pages so wiki-ingest has structural context when creating new content.

**Tasks:**
1. [ ] Write `WIKI_SCHEMA.md`: define 6 page types (entity, concept, source, comparison, synthesis, overview), frontmatter fields, naming conventions, cross-reference requirements (min 2 per page), directory structure
2. [ ] Create domain stub pages: `wiki/domains/work.md`, `wiki/domains/technology.md`, `wiki/domains/personal.md`, `wiki/domains/sailing.md`, `wiki/domains/amateur-radio.md` (match OneDrive 9-domain structure)
3. [ ] Create high-level entity pages: `wiki/entities/open-brain.md`, `wiki/entities/troy-davis.md`, `wiki/entities/stratfield-consulting.md`
4. [ ] Push all pages to Gitea wiki repo
5. [ ] Update wiki-ingest system prompt to reference `WIKI_SCHEMA.md` and prefer linking to existing domain pages

**Acceptance Criteria:**
- [ ] `WIKI_SCHEMA.md` exists in wiki repo root
- [ ] 5-10 domain stub pages created with proper frontmatter
- [ ] 3+ entity bootstrap pages created
- [ ] Wiki-ingest prompt references schema
- [ ] wiki-lint passes on all new pages

---

#### 8.2 Pilot Ingestion (100 Files)
**Status: PENDING**
**Requirement Refs:** GitHub Issue #60, Ultra Plan Item 10 (Set J2)
**Files Affected:**
- Script to queue pilot batch (create — one-off Python or bash)

**Description:**
Select 100 captures from one well-understood domain (e.g., Work), queue them for wiki-ingest, run overnight, review quality in the morning. Validate before committing to 2-week full processing.

**Tasks:**
1. [ ] Query Postgres for 100 file captures from the Work domain: `SELECT id FROM captures WHERE source = 'document' AND content LIKE '%[Document]%' AND brain_view = 'work-internal' LIMIT 100`
2. [ ] Write a script to queue these captures for wiki-ingest via BullMQ
3. [ ] Run overnight with monitoring
4. [ ] Review results: count pages created, check cross-reference density, measure orphan rate (target <5%)
5. [ ] Quality spot-check: read 10 wiki pages manually, assess usefulness
6. [ ] Document results in LAB_NOTEBOOK

**Acceptance Criteria:**
- [ ] 100 captures processed through wiki-ingest
- [ ] Wiki pages created with proper frontmatter and cross-references
- [ ] Orphan rate <5% (pages with <2 cross-references)
- [ ] Quality assessment documented (are pages useful? is content accurate?)
- [ ] Decision: proceed to full processing or tune further

**Notes:**
If quality is poor, tune the wiki-ingest prompt or switch model to Sonnet (via config change from Phase 3). The pilot is the quality gate before committing to 2 weeks of processing.

---

#### 8.3 Full Wiki Processing
**Status: PENDING**
**Requirement Refs:** GitHub Issue #60, Ultra Plan Item 10 (Set J3)
**Files Affected:**
- Batch orchestration script (create)

**Description:**
Process all ~10,000 file captures domain-by-domain over ~2 weeks. Rate: ~1,000 captures/night. Daily spot-checks. wiki-lint runs weekly to catch drift.

**Tasks:**
1. [ ] Write batch orchestration script: query captures by domain, queue for wiki-ingest in batches of 50, respect rate limit (5 jobs/min)
2. [ ] Run nightly: start batch at 10 PM, process ~1,000 captures, finish by morning
3. [ ] Daily morning check: review wiki page count growth, orphan rate, any error captures
4. [ ] Weekly: run wiki-lint, review report, fix any issues
5. [ ] After all domains processed: final stats report (total pages, orphan rate, entity coverage, cross-reference density)
6. [ ] Close GitHub issue #60

**Acceptance Criteria:**
- [ ] All ~10,000 file captures processed through wiki-ingest
- [ ] Final orphan rate <5%
- [ ] Wiki browser shows navigable knowledge base
- [ ] wiki-lint reports clean
- [ ] GitHub issue #60 closed
- [ ] LAB_NOTEBOOK entry with final processing stats

**Notes:**
This is a 2-week background task. The batch script runs autonomously each night. The main risk is wiki-ingest failures or quality drift — the daily spot-checks catch these early.

---

### Phase 8 Testing Requirements

- [ ] WIKI_SCHEMA.md validated by wiki-lint
- [ ] Pilot produces quality pages (manual review)
- [ ] Orphan rate tracked and under threshold
- [ ] Full processing completes without accumulating errors

### Phase 8 Completion Checklist

- [ ] All work items complete
- [ ] Wiki populated with ~10,000 source pages + entity/concept pages
- [ ] Wiki navigable in browser UI
- [ ] GitHub issue #60 closed
- [ ] LAB_NOTEBOOK entries: pilot results, full processing stats, quality assessment

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Phase 1 (all items) | Phase 2, Phase 4, Phase 6 | All ops-only, no shared code |
| Phase 2.1 (scheduler) | Phase 2.2, 2.3 | Code vs ops |
| Phase 3.1 (wiki-ingest) | Phase 3.2 (JSON mode) | Different files, same deploy |
| Phase 4 (email outbound) | Phase 5, Phase 6 | Independent systems |
| Phase 5 (LiteLLM) | Phase 6 (synthetic monitoring) | Independent systems |
| Phase 7.1 (Pushgateway) | Phase 7.2 (prom-client) | Different packages |
| Phase 7.4 (Loki) | Phase 7.1, 7.2, 7.3 | Independent infrastructure |
| Phase 8.1 (schema) | Phase 7 (observability) | Independent |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Haiku produces lower-quality wiki pages than Sonnet | Medium | Medium | Pilot phase (8.2) validates quality. Model is config-driven — upgrade to Sonnet with zero code changes |
| `response_format` unsupported by some openai_compat endpoints | Low | Low | Opt-in flag — only entity extraction enables it. Other callers unaffected |
| SMTP delivery issues with Himalaya | Low | Medium | Test self-send first. Default mode is `review-required` (no auto-send). Credentials from Bitwarden |
| LiteLLM proxy adds latency or becomes SPOF | Low | High | Docker-internal network (~10ms). Add to container-health checks. Rollback: revert env var to api.openai.com |
| Wiki sprawl during full processing | Medium | Medium | Pilot validates quality first. wiki-lint runs weekly. Cross-reference minimum (2/page) enforced by prompt |
| Grafana dashboard creation affects existing dashboards | Low | Medium | Export existing dashboards first (protect unrecoverable work). Use unique UIDs for new dashboards |
| Loki memory consumption on homeserver | Low | Medium | Configure retention at 30 days, memory limit 500MB. Monitor via node-exporter |
| Removing BullMQ backup jobs leaves orphan Redis keys | Low | Low | Explicit key cleanup after deploy. Verify with KEYS scan |

---

## Success Metrics

- [ ] All 8 phases completed
- [ ] All acceptance criteria met
- [ ] Zero silent backup failures (all backup systems producing valid output)
- [ ] Wiki-ingest success rate >90% (was 30%)
- [ ] Entity extraction JSON failure rate <1% (was ~5%)
- [ ] Email outbound operational (GitHub #69 closed)
- [ ] LiteLLM cost data accurate and visible in Grafana
- [ ] External health monitoring active with <1% false positive rate
- [ ] 3 Grafana dashboards operational with real data
- [ ] Container logs searchable in Loki
- [ ] Wiki populated with 10,000+ pages (GitHub #60 closed)
- [ ] LAB_NOTEBOOK entries for every phase

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| Flush dead Redis queues | Ultra Plan Items 3-4 | 1 | 1.1 |
| Disable stale OneDrive sync | Ultra Plan Item 6 | 1 | 1.2 |
| Update GitHub board | Ultra Plan Item 7 | 1 | 1.3 |
| Remove broken BullMQ backup jobs | Ultra Plan Item 2 | 2 | 2.1 |
| Fix VM Redis backup | Ultra Plan Item 5 | 2 | 2.2 |
| Fix homeserver backup.sh | Ultra Plan Item 2 | 2 | 2.3 |
| Fix wiki-ingest model hardcode | Ultra Plan Item 1 | 3 | 3.1 |
| Add JSON mode for entity extraction | Ultra Plan Item 8 | 3 | 3.2 |
| Deploy email outbound | GitHub Issue #69 | 4 | 4.1-4.3 |
| Route through LiteLLM proxy | Ultra Plan Item 11 | 5 | 5.1 |
| Fix spend aggregation | Ultra Plan Item 11 | 5 | 5.2 |
| Add LiteLLM to health checks | Ultra Plan Item 11 | 5 | 5.3 |
| External synthetic monitoring | Ultra Plan Item 12 | 6 | 6.1-6.2 |
| Pushgateway metrics from skills | Ultra Plan Set F1 | 7 | 7.1 |
| prom-client /metrics endpoint | Ultra Plan Set F2 | 7 | 7.2 |
| Grafana dashboards | Ultra Plan Set F3 | 7 | 7.3 |
| Loki log aggregation | Ultra Plan Set F4 | 7 | 7.4 |
| Wiki schema & bootstrap | GitHub Issue #60 | 8 | 8.1 |
| Wiki pilot ingestion | GitHub Issue #60 | 8 | 8.2 |
| Wiki full processing | GitHub Issue #60 | 8 | 8.3 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-04-15 14:45:00*
*Source: /create-plan command from ultra-plan analysis*
