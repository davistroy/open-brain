# Implementation Plan — Open Brain Cleanup & Deploy

**Generated:** 2026-04-10 21:15:00
**Based On:** Ultra Plan health check analysis (7 items + bonus findings from production validation on 2026-04-10)
**Total Phases:** 4
**Estimated Total Effort:** ~50 LOC code changes + server-side operations across 4 files

---

## Executive Summary

Production validation on 2026-04-10 found all 9 Open Brain containers healthy and the pipeline processing correctly, but identified 7 issues ranging from stale Docker images (PR #45 code not deployed) to server-side cleanup needs and a budget-check code path hitting a non-existent API endpoint. Investigation revealed that items #1 (stale images) and #2 (missing scheduled skills) share a single root cause: Docker images were not rebuilt after the latest commit was pulled.

This plan groups the work into four phases: homeserver cleanup (zero-risk server ops), code fixes (budget-check URL separation and stale JSDoc), Docker rebuild and deploy (which delivers both the code fixes and the already-merged PR #45 features), and documentation of a known upstream issue. The critical ordering constraint is that Phase 2 code fixes must be committed before Phase 3 rebuild, otherwise the budget-check 404 persists in the new images.

No database migrations are required. No architectural changes. This is operational hygiene — getting deployed state in sync with committed state, cleaning up artifacts, and fixing one code-level issue that emerged from the LiteLLM-to-OpenAI migration.

---

## Plan Overview

The implementation strategy follows a risk-ordered sequence: cleanup first (reversible, zero-blast-radius), then code fixes (testable locally), then deploy (rebuilds all images with both the fixes and the already-merged PR #45 features), and finally documentation.

Phase 1 (cleanup) and Phase 2 (code fixes) are independent and can run in parallel. Phase 3 (deploy) depends on Phase 2 being committed and pushed. Phase 4 (documentation) is independent of all others.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies |
|-------|------------|------------------|-----------------|--------------|
| 1 | Homeserver Cleanup | Stale files removed, test capture deleted, backup.sh committed + cron set up | S (~1 file committed, 5 server ops) | None |
| 2 | Code Fixes | Budget-check URL fix, scheduler JSDoc update | S (~2 files, ~40 LOC) | None |
| 3 | Docker Rebuild & Deploy | All 5 custom images rebuilt, 10 skills registered, PR #45 features live | M (~0 code files, deploy operations) | Phase 2 |
| 4 | Documentation | punycode warning documented in CLAUDE.md | S (~1 file, ~5 LOC) | None |

<!-- BEGIN PHASES -->

---

## Phase 1: Homeserver Cleanup

**Estimated Complexity:** S (~1 file committed, 5 server operations)
**Dependencies:** None
**Parallelizable:** Yes — all operations are independent of each other

### Goals

- Remove stale files and directories from homeserver that create confusion
- Delete orphaned test data from the database
- Commit the backup script to version control and activate automated backups

### Work Items

#### 1.1 Delete stale `packages/workers/src/src/` directory ✅ Completed 2026-04-10
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-10]**
**Requirement Refs:** Health check item #5
**Files Affected:**
- `packages/workers/src/src/` on homeserver (delete entire directory)

**Description:**
A 524K duplicate of the workers source tree exists at `packages/workers/src/src/` on the homeserver, created by an accidental copy on March 8. It has no functional impact (Docker builds from the correct path and `.dockerignore` excludes it), but it's confusing and wastes disk.

**Tasks:**
1. [ ] SSH to homeserver and verify the directory contents are a stale duplicate: `ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net "diff <(ls /mnt/user/appdata/open-brain/packages/workers/src/src/) <(ls /mnt/user/appdata/open-brain/packages/workers/src/)"`
2. [ ] Delete the stale directory: `sudo rm -rf /mnt/user/appdata/open-brain/packages/workers/src/src/`
3. [ ] Verify it's gone: `ls /mnt/user/appdata/open-brain/packages/workers/src/src/ 2>&1`

**Acceptance Criteria:**
- [ ] Directory `packages/workers/src/src/` no longer exists on homeserver
- [ ] No impact on running containers (they don't read from this path)

**Notes:**
This directory is NOT in git — it only exists on the homeserver filesystem. No git operations needed.

---

#### 1.2 Delete orphaned test capture ✅ Completed 2026-04-10
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-10]**
**Requirement Refs:** Health check item #6
**Files Affected:**
- Database row: `captures` table, id `477f2087-1c9e-4012-98d1-5dc4d2b108a7`

**Description:**
A test capture created during the bond investigation session on 2026-04-10 is marked "please delete" in its content. It should be removed via the API to keep the captures list clean.

**Tasks:**
1. [ ] Delete via API: `curl -s -X DELETE -H 'X-Open-Brain-Caller: integration-test' http://127.0.0.1:3002/api/v1/captures/477f2087-1c9e-4012-98d1-5dc4d2b108a7`
2. [ ] Verify deletion: `curl -s -H 'X-Open-Brain-Caller: integration-test' http://127.0.0.1:3002/api/v1/captures/477f2087-1c9e-4012-98d1-5dc4d2b108a7` (should return 404)

**Acceptance Criteria:**
- [ ] Capture `477f2087` no longer appears in `GET /api/v1/captures`
- [ ] No entity_links or other dependent rows left orphaned (CASCADE should handle this)

**Notes:**
Must include `X-Open-Brain-Caller: integration-test` header to bypass rate limiting. Check whether the API supports hard DELETE or only soft-delete (sets `deleted_at`). Either is acceptable.

---

#### 1.3 Commit backup.sh to git and activate cron ✅ Completed 2026-04-10
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-10]**
**Requirement Refs:** Health check item #7
**Files Affected:**
- `scripts/backup.sh` (retrieve from homeserver, commit to git)
- Homeserver crontab (add cron entry)

**Description:**
A comprehensive backup script (`scripts/backup.sh`, 5.4K) exists on the homeserver but is not tracked in git. It handles Postgres dumps (custom format), config file archival, schema export, and manifest generation with 14-day daily / 4-week weekly / 3-month monthly retention. The script's own header specifies a cron schedule (`0 3 * * *`) but it is NOT currently in any crontab — backups are not running.

**Tasks:**
1. [ ] Copy backup.sh from homeserver to local repo: `scp -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net:/mnt/user/appdata/open-brain/scripts/backup.sh scripts/backup.sh`
2. [ ] Verify the file matches what's on the server (diff)
3. [ ] Stage and commit: `git add scripts/backup.sh`
4. [ ] On homeserver, set up crontab for the `claude` user: add `0 3 * * * cd /mnt/user/appdata/open-brain && bash scripts/backup.sh >> /tmp/open-brain-backup.log 2>&1`
5. [ ] Verify cron entry: `ssh ... "crontab -l | grep backup"`
6. [ ] Create backup directory if needed: `sudo mkdir -p /mnt/user/backup/openbrain`

**Acceptance Criteria:**
- [ ] `scripts/backup.sh` exists in git and matches homeserver copy
- [ ] Crontab entry active for daily 3 AM backups
- [ ] `/mnt/user/backup/openbrain/` directory exists on homeserver
- [ ] Manual test run succeeds: `bash scripts/backup.sh`

**Notes:**
The script uses `docker exec` for pg_dump, which requires the postgres container to be running. The cron job will fail silently if containers are down — this is acceptable (backups resume when containers restart). Consider whether crontab should be on the `claude` user (has sudo) or `root`.

---

#### 1.4 Delete stale Dockerfile.prebuild ✅ Completed 2026-04-10
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-10]**
**Requirement Refs:** Health check item #7
**Files Affected:**
- `packages/web/Dockerfile.prebuild` on homeserver (delete)

**Description:**
A 328-byte experimental Dockerfile from March 12 exists on the homeserver. It is not referenced by docker-compose.yml, not tracked in git, and serves no current purpose.

**Tasks:**
1. [ ] Delete on homeserver: `rm /mnt/user/appdata/open-brain/packages/web/Dockerfile.prebuild`
2. [ ] Verify: `ls /mnt/user/appdata/open-brain/packages/web/Dockerfile.prebuild 2>&1`

**Acceptance Criteria:**
- [ ] File no longer exists on homeserver

**Notes:**
Trivial operation. File is not in git.

---

### Phase 1 Testing Requirements

- [ ] No containers affected — all operations are filesystem or database cleanup
- [ ] API DELETE for test capture returns success (200 or 204)
- [ ] `backup.sh` manual test run completes without errors
- [ ] `git status` shows only `scripts/backup.sh` as a new file

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] Stale directory, test capture, and experimental Dockerfile removed
- [ ] backup.sh committed to git
- [ ] Backup cron active on homeserver
- [ ] No regressions (containers still healthy)

---

## Phase 2: Code Fixes

**Estimated Complexity:** S (~2 files, ~40 LOC changed)
**Dependencies:** None
**Parallelizable:** Yes — both fixes are in different files

### Goals

- Eliminate the budget-check 404 by separating the spend API URL from the inference URL
- Update stale scheduler documentation to reflect current skill registrations

### Work Items

#### 2.1 Separate budget-check spend URL from inference URL ✅ Completed 2026-04-10
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-10]**
**Requirement Refs:** Health check item #3
**Files Affected:**
- `packages/workers/src/jobs/budget-check.ts` (modify)
- `packages/workers/src/__tests__/budget-check.test.ts` (modify — update tests for new env var)

**Description:**
The budget-check skill queries LiteLLM's `/spend/logs` endpoint for monthly spend data. Since the migration to direct OpenAI API, `LITELLM_URL` is set to `https://api.openai.com/v1` in docker-compose.yml. The budget-check constructs `https://api.openai.com/v1/spend/logs` — which doesn't exist, causing a 404 on every run.

The fix introduces a separate `LITELLM_SPEND_URL` env var. When set, it queries that URL for spend data. When unset (the default), it skips the LiteLLM spend query entirely and relies solely on the local `ai_audit_log` estimation. This cleanly separates "where to send AI inference requests" from "where to query spend data."

**Tasks:**
1. [ ] In `budget-check.ts`, add `LITELLM_SPEND_URL` env var support:
   - Change line 70 from `const litellmUrl = opts?.litellmUrl ?? process.env.LITELLM_URL ?? 'https://llm.k4jda.net'` to `const litellmSpendUrl = opts?.litellmUrl ?? process.env.LITELLM_SPEND_URL ?? ''`
   - Change the guard on line 83 from `if (litellmApiKey)` to `if (litellmSpendUrl && litellmApiKey)` — skip the HTTP call entirely when no spend URL is configured
   - Update the `queryLiteLLMSpend` call to pass `litellmSpendUrl`
2. [ ] Update the JSDoc comment (lines 40-58) to document `LITELLM_SPEND_URL` and remove `LITELLM_URL` reference
3. [ ] Update the `opts` interface to rename `litellmUrl` to `litellmSpendUrl` for clarity
4. [ ] Update existing tests to cover both cases: LITELLM_SPEND_URL set (queries it) and unset (skips, uses local only)
5. [ ] Run `pnpm test` to verify no regressions

**Acceptance Criteria:**
- [ ] When `LITELLM_SPEND_URL` is empty/unset (default), budget-check does NOT attempt any HTTP call to a spend API — no 404 in logs
- [ ] When `LITELLM_SPEND_URL` is set to a valid LiteLLM proxy URL, the existing spend query logic works unchanged
- [ ] Local `ai_audit_log` estimation continues to work as fallback/primary
- [ ] All existing budget-check tests pass
- [ ] No transient `healthy: false` from pipeline-health on container restart

**Notes:**
The `LITELLM_URL` env var in docker-compose.yml is used by other packages (core-api, workers, slack-bot, voice-capture) for AI inference and must NOT be changed. Only budget-check.ts needs the spend URL separation. The standalone LiteLLM proxy at `llm.k4jda.net` could be configured as `LITELLM_SPEND_URL` in the future if spend tracking is re-enabled through it.

---

#### 2.2 Update scheduler JSDoc to reflect current state ✅ Completed 2026-04-10
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-10]**
**Requirement Refs:** Bonus finding (stale daily-connections comment)
**Files Affected:**
- `packages/workers/src/scheduler.ts` (modify — JSDoc only)

**Description:**
The JSDoc comment block at the top of `scheduler.ts` (lines 17-29) lists registered jobs. Two issues:
1. Line 22 says "daily-connections: 9:00 PM daily (cron: 0 21 * * *)" but the actual cron on line 82 is `0 0 29 2 *` (Feb 29 only — effectively disabled by PR #45 for noise reduction)
2. Three new skills added in PR #45 (capture-reminder-morning, morning-brief, capture-reminder-evening) are not listed in the JSDoc

**Tasks:**
1. [ ] Update line 22 to: `daily-connections: DISABLED (cron: 0 0 29 2 * — Feb 29 only, silenced for noise reduction)`
2. [ ] Add lines for the 3 new skills after the existing entries:
   - `capture-reminder-morning: 7:00 AM weekdays (cron: 0 7 * * 1-5) — morning Pushover nudge`
   - `morning-brief: 7:15 AM weekdays (cron: 15 7 * * 1-5) — structured morning briefing (no LLM)`
   - `capture-reminder-evening: 9:00 PM daily (cron: 0 21 * * *) — evening Pushover nudge with capture count`
3. [ ] Verify no functional code changes — JSDoc only

**Acceptance Criteria:**
- [ ] JSDoc accurately lists all 10 scheduled jobs with correct cron expressions
- [ ] `daily-connections` marked as disabled with reason
- [ ] No functional code changes in this work item
- [ ] `pnpm test` passes

**Notes:**
Pure documentation fix. The actual cron values in the code are correct — only the comments are stale.

---

### Phase 2 Testing Requirements

- [ ] `pnpm test` passes with all existing tests
- [ ] Budget-check tests cover: (a) no LITELLM_SPEND_URL → skip HTTP, use local only; (b) LITELLM_SPEND_URL set → query it
- [ ] No type errors: `pnpm --filter @open-brain/workers exec tsc --noEmit`

### Phase 2 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Changes committed and pushed to main
- [ ] Ready for Phase 3 Docker rebuild

---

## Phase 3: Docker Rebuild & Deploy

**Estimated Complexity:** M (~0 code files, deployment operations)
**Dependencies:** Phase 2 (code fixes must be committed and pushed)
**Parallelizable:** No — sequential deploy process

### Goals

- Deploy all code changes (PR #45 features + Phase 2 fixes) to production
- Verify all 10 scheduled skills are registered
- Confirm pipeline processes captures end-to-end

### Work Items

#### 3.1 Pull latest code and rebuild Docker images ✅ Completed 2026-04-10
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-10]**
**Requirement Refs:** Health check items #1, #2
**Files Affected:**
- All 5 custom Docker images (core-api, workers, slack-bot, voice-capture, web)

**Description:**
Pull the latest code (which includes PR #45 morning-brief/capture-reminder/noise-reduction + Phase 2 budget-check fix + backup.sh) and rebuild all Docker images. The multi-stage Dockerfile handles the TypeScript compilation inside the builder stage.

**Tasks:**
1. [ ] SSH to homeserver: `ssh -i ~/.ssh/id_claude_code claude@homeserver.k4jda.net`
2. [ ] Pull latest code: `cd /mnt/user/appdata/open-brain && git pull`
3. [ ] Rebuild all images: `sudo docker compose build`
4. [ ] Restart containers: `sudo docker compose up -d`
5. [ ] Wait 30 seconds for health checks to stabilize

**Acceptance Criteria:**
- [ ] `docker compose build` completes without errors
- [ ] `docker compose up -d` starts all 9 containers
- [ ] All containers with health checks report healthy within 60 seconds

**Notes:**
Build time on homeserver is typically 3-5 minutes (i7-9700, 128GB RAM). The multi-stage build compiles all packages in the builder stage. If build fails, check for pnpm lockfile changes or Node 22 Alpine compatibility.

---

#### 3.2 Verify scheduled skill registration ✅ Completed 2026-04-10
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-10]**
**Requirement Refs:** Health check item #2
**Files Affected:**
- None (verification only)

**Description:**
After rebuild, verify the workers container registers all 10 scheduled jobs (was 7 before). The 3 new ones are: capture-reminder-morning (7 AM weekdays), morning-brief (7:15 AM weekdays), capture-reminder-evening (9 PM daily).

**Tasks:**
1. [ ] Check scheduler registration logs: `sudo docker compose logs workers --tail=50 | grep 'repeatable job registered'`
2. [ ] Verify 10 entries appear (daily-sweep, budget-check, daily-connections, drift-monitor, pipeline-health, daily-sweep-skill, memory-consolidation, capture-reminder-morning, morning-brief, capture-reminder-evening)
3. [ ] Verify budget-check no longer logs "LiteLLM spend API error": `sudo docker compose logs workers --tail=100 | grep 'budget-check'`

**Acceptance Criteria:**
- [ ] 10 `repeatable job registered` log lines present
- [ ] `morning-brief` registered with cron `15 7 * * 1-5`
- [ ] `capture-reminder-morning` registered with cron `0 7 * * 1-5`
- [ ] `capture-reminder-evening` registered with cron `0 21 * * *`
- [ ] No `LiteLLM spend API error` in budget-check logs (when LITELLM_SPEND_URL is unset)

**Notes:**
If budget-check runs immediately on startup (it processes a backlogged job), verify it completes with `spendSource: 'local'` and no 404 error.

---

#### 3.3 End-to-end pipeline verification ✅ Completed 2026-04-10
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: COMPLETE [2026-04-10]**
**Requirement Refs:** Health check item #1 (deploy verification)
**Files Affected:**
- None (verification only)

**Description:**
Submit a test capture and verify it flows through the full pipeline: ingestion → embed → extract-entities → complete. Then verify the health endpoint reports all services healthy.

**Tasks:**
1. [ ] Check health endpoint: `curl -s http://127.0.0.1:3002/api/v1/health`
2. [ ] Submit test capture: `curl -s -X POST http://127.0.0.1:3002/api/v1/captures -H 'Content-Type: application/json' -H 'X-Open-Brain-Caller: integration-test' -d '{"content": "Deploy verification test — safe to delete", "source": "api"}'`
3. [ ] Wait 5 seconds for pipeline processing
4. [ ] Verify capture reached 'complete' status: `curl -s -H 'X-Open-Brain-Caller: integration-test' http://127.0.0.1:3002/api/v1/captures/{id}`
5. [ ] Clean up test capture: `curl -s -X DELETE -H 'X-Open-Brain-Caller: integration-test' http://127.0.0.1:3002/api/v1/captures/{id}`
6. [ ] Verify Slack bot is connected: `sudo docker compose logs slack-bot --tail=5 | grep 'connected'`

**Acceptance Criteria:**
- [ ] Health endpoint returns `{"status":"healthy"}` for postgres, redis, and llm
- [ ] Test capture reaches `pipeline_status: 'complete'` within 10 seconds
- [ ] Entities are extracted (check `entity_links` or entity count in capture response)
- [ ] Slack bot reports "connected via Socket Mode"
- [ ] Web dashboard loads at `http://127.0.0.1:5173/`

**Notes:**
Clean up the test capture after verification to avoid accumulating test data. If the pipeline stalls, check workers logs for the specific capture ID.

---

### Phase 3 Testing Requirements

- [ ] All 9 containers report healthy status
- [ ] Scheduler registers 10 jobs (up from 7)
- [ ] Pipeline processes a capture end-to-end (ingestion → embed → entities → complete)
- [ ] No new errors in any container logs
- [ ] External access via brain.troy-davis.com still works

### Phase 3 Completion Checklist

- [ ] All work items complete
- [ ] All containers healthy
- [ ] All scheduled skills registered
- [ ] Pipeline verified end-to-end
- [ ] Budget-check 404 eliminated
- [ ] PR #45 features (morning-brief, capture-reminders, noise reduction) now live

---

## Phase 4: Documentation

**Estimated Complexity:** S (~1 file, ~5 lines)
**Dependencies:** None
**Parallelizable:** Yes — independent of all other phases

### Goals

- Document the punycode deprecation warning as a known issue so future sessions don't re-investigate it

### Work Items

#### 4.1 Document punycode DEP0040 as known issue
<!-- Status values: PENDING, IN_PROGRESS, COMPLETE [YYYY-MM-DD] -->
**Status: PENDING**
**Requirement Refs:** Health check item #4
**Files Affected:**
- `CLAUDE.md` (modify — add to verified operational rules)

**Description:**
Both workers and slack-bot containers emit Node.js `DEP0040` deprecation warning for the `punycode` module at startup. This is a transitive runtime dependency (likely through @slack/bolt or BullMQ URL processing chain → psl → punycode). It is cosmetic — no functional impact. Cannot be fixed without upstream library updates. Document it so future sessions don't waste time investigating.

**Tasks:**
1. [ ] Add bullet to CLAUDE.md "Verified operational rules" section: `**Node.js punycode DEP0040 warning is cosmetic** — both workers and slack-bot emit this at startup. Transitive runtime dependency (psl → punycode via URL/cookie processing chain). No functional impact. Awaiting upstream fix in @slack/bolt or BullMQ dependency tree. Do not investigate further.`
2. [ ] Commit the documentation update

**Acceptance Criteria:**
- [ ] CLAUDE.md contains the punycode warning documentation
- [ ] Future sessions can quickly identify this as a known non-issue

**Notes:**
This warning appeared when Open Brain upgraded to Node 22 (Node 20 suppressed it). It will resolve when upstream packages (tr46, psl, tough-cookie) migrate away from the deprecated core punycode module.

---

### Phase 4 Testing Requirements

- [ ] CLAUDE.md is valid markdown
- [ ] No functional code changes to test

### Phase 4 Completion Checklist

- [ ] Documentation updated
- [ ] Committed to git

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Phase 1 (all items) | Phase 2 (all items) | Completely independent — cleanup vs code fixes |
| Phase 1 (all items) | Phase 4.1 | Documentation is independent |
| 1.1 (delete src/src/) | 1.2 (delete capture) | Different targets (filesystem vs API) |
| 1.3 (backup.sh) | 1.4 (delete Dockerfile.prebuild) | Different files |
| 2.1 (budget-check) | 2.2 (scheduler JSDoc) | Different files |
| Phase 4.1 | Phase 2 (all items) | Documentation is independent of code fixes |

**Constraints:**
- Phase 3 MUST wait for Phase 2 to be committed and pushed
- Phase 3 work items are sequential (build → verify skills → verify pipeline)

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Docker build fails after code changes | Low | Medium | CI already passes; local `pnpm build` before committing. If build fails, check Alpine compatibility. |
| Container startup regression after rebuild | Low | Medium | Health checks catch failures within 60s. Previous images cached by Docker — `docker compose up -d` with old image tag as fallback. |
| Budget-check test changes break existing tests | Low | Low | Run full `pnpm test` before committing. Budget-check has isolated test file. |
| Backup cron runs when containers are down | Medium | Low | Script will fail (pg_dump needs postgres). Acceptable — resumes on next run. Log to `/tmp/open-brain-backup.log` for visibility. |
| DELETE cascade for test capture removes unexpected data | Low | Medium | Check entity_links for capture ID before deleting. API should handle CASCADE. |
| Brief service interruption during `docker compose up -d` | High | Low | Single-user system; 30-second restart window is acceptable. |

---

## Success Metrics

- [ ] All 4 phases completed
- [ ] All acceptance criteria met
- [ ] All 9 containers healthy after Phase 3 deploy
- [ ] 10 scheduled skills registered (up from 7)
- [ ] Zero 404 errors in budget-check logs
- [ ] Automated backups running daily at 3 AM
- [ ] No stale files remaining on homeserver
- [ ] Morning brief fires on next weekday at 7:15 AM (manual verification after deploy)

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| Stale Docker images — PR #45 not deployed | Health check #1 | 3 | 3.1 |
| morning-brief skill not registered | Health check #2 | 3 | 3.2 |
| LiteLLM spend API returning 404 | Health check #3 | 2 | 2.1 |
| punycode DEP0040 deprecation warning | Health check #4 | 4 | 4.1 |
| Stale nested `src/src/` directory | Health check #5 | 1 | 1.1 |
| Test capture needs cleanup | Health check #6 | 1 | 1.2 |
| Untracked files on homeserver (backup.sh) | Health check #7 | 1 | 1.3 |
| Untracked files on homeserver (Dockerfile.prebuild) | Health check #7 | 1 | 1.4 |
| Stale daily-connections JSDoc comment | Bonus finding | 2 | 2.2 |
| Backup cron not configured | Phase 1 investigation | 1 | 1.3 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-04-10 21:15:00*
*Source: /create-plan command (via /ultra-plan analysis)*
