# Implementation Plan — Arch-Review v7 Remediation, Part 1 of 2 (Phases 1–8)

**Generated:** 2026-11-22 14:02:42
**Based On:** `arch-review/reports/remediation-analysis-2026-11-22.md` (approved analysis); `arch-review/reports/executive-summary.md` (review v7, live-verification table L1–L17); `arch-review/plan-investigation/01-backup-restore.md`, `02-rebuild-deploy-drift.md`, `03-pipeline-queues-search.md` (section C), `04-silent-inert-jobs.md`, `05-llm-gateway-integrations.md` (TH1, IMG1), `06-alerting-monitoring-ci.md`; `docs/adr/ADR-0005-alert-state-model.md`; `docs/adr/ADR-0006-deployed-state-identity.md`. The `arch-review/` paths are local-only (gitignored).
**Total Phases:** 8
**Estimated Total Effort:** ~7,500 LOC across ~115 files (about 40% tests and shell harnesses), plus four host sessions

---

## Executive Summary

Part 1 holds 41 work items from arch-review v7. The items restore the live system, rebuild the alert path, give the deployed state one identity, prove the restore path, and deploy the four changes that were merged and never applied. Part 2 is a separate file, `IMPLEMENTATION_PLAN-2026-11-remediation-part2.md` (Phases 9–16): capture pipeline, small data-loss paths, search and memory, LLM gateway core, budget follow-through, edges, patch pipeline and CI, mechanical hardening. Both parts cover functionality, performance, and stable operations only.

Two recorded decisions carry most of the work. ADR-0005: alert state lives in Postgres (`app_settings` key `alert_state:<key>`), every operational alert goes through one helper (`raiseAlert`), an alert fires when a condition changes, one daily digest carries the reports, and an open critical alert escalates at 24 hours and at 7 days. ADR-0006: a deploy is one command (`scripts/deploy.sh <sha>`) that takes one commit, refuses the stateful services, and writes `DEPLOYED.json`.

Findings that share a root cause are fixed once. Every sender that pushed on every run calls the same alert-state helper (Phases 2–4). Every job that reported success without doing the work writes the same heartbeat record (Phase 3). The weekly rehearsal and a real recovery call the same restore function (Phase 6). Three fixes were completed on 2026-11-22 and are context, not work items: a manual backup plus a persistent `0 3 * * *` backup cron line that runs as root (LAB_NOTEBOOK Entry 253; the old line lived in a `claude` user crontab, which Unraid keeps in RAM, and the 2026-09-07 reboot erased it), restored OpenAI credits (test embedding returned HTTP 200), and 16 deleted stale remote branches.

---

## Plan Overview

Phase 1 restores the core function on the live host with no image build. Phases 2 and 3 build the alert path that every later phase relies on to notice a regression. Phases 4 and 5 make the host adopt `main` safely and end with the first clean deploy, which carries Phases 2–4 to production. Phases 6 and 7 make backup and restore trustworthy and gate Phase 8, where the stateful services are recreated one at a time.

**Critical path:** 1.2 (captures searchable) → 2.1–2.2 (alert state) → 4.1–4.3 (drift check and tracked bind) → 5.2 (`scripts/deploy.sh`) → 5.5 (host tree reconcile) → 6.2–6.3 (restore that asserts indexes and constraints) → 8.2 (Postgres recreate).

**Shared root causes addressed by one item each:**

| Root cause | Items | Single fix |
|---|---|---|
| A sender pushes on every run; no alert state exists | 2.1–2.6, 3.1, 3.2, 3.6, 4.1, 4.5 | `alert-state.ts` and `raiseAlert` (2.1, 2.2); shell scripts keep a state file beside their log (4.1) |
| "Job did not throw" is treated as success | 3.3, 3.4, 3.5, 3.6 | `heartbeat:<source>` record and one reader (3.3) |
| Deployed state is not derived from `main` | 4.1–4.4, 5.1–5.5, 8.1–8.5 | `scripts/deploy.sh` and `DEPLOYED.json` (5.2); host tree reconciled once (5.5) |
| The rehearsal and the documented recovery are different procedures | 6.2, 6.3, 7.2 | `scripts/lib/restore-core.sh` `restore_into` (6.2) |
| `scripts/backup.sh` is edited by several fixes | 6.4 | All Phase 6 `backup.sh` edits land in item 6.4, in one pull request with 6.3 |

**Hard ordering constraints:**

1. Item 4.2 merges before any `workers` recreate from `main`'s compose. `main` mounts the `latest` symlink; the live host mounts the parent directory. Deploying `main`'s compose first breaks the one alert that works.
2. Item 5.1 (`.gitignore` for the data directories) precedes item 5.5 (host tree reconcile).
3. Phases 6 and 7 precede Phase 8. No stateful recreate happens until a restore path that asserts indexes and constraints has passed on a fresh dump.
4. Item 8.1 (migration 0037) precedes every later migration; `scripts/migrate-manual.sh` applies files in order.
5. Item 1.2 precedes the memory-consolidation watermark reset in Part 2 (Phase 11).

**Time-boxed dates:**

| Date | Event | Item |
|---|---|---|
| 2026-11-23 03:00 / 03:45 | First cron-run backup and first offsite copy since the fix | 1.1 |
| ~2026-12-23 | GitHub likely disables scheduled workflows after 60 days without a merge to `main` | 1.6 |
| 2026-12-31 | Test fixtures dated `2026-12-31` in three test files expire and fail required checks | 1.5 |

**How `/implement-plan` runs this plan:**

- Every phase is Sequential. `/implement-plan` orders items by `Depends On`, so every item after the first item of a phase carries a `Depends On` entry: a named technical dependency where one exists, otherwise the preceding item of the phase. A dependency on an item of an earlier phase is marked cross-phase.
- `LAB_NOTEBOOK.md` and `CLAUDE.md` appear under Files Affected only where a task names a specific edit. Every item also appends its result to the phase's notebook entry, per the project protocol.
- The runner needs a clean working tree and a feature branch. Commit the five files that are uncommitted today (item 1.6 lists them) on the feature branch before the first run.
- Merges to `main` are required at four points: after Phase 1 (item 1.6); before item 5.5 (Phases 2–5 merged and `build-images.yml` green for the commit to deploy); before the Phase 6–7 host steps (Phases 6–7 merged); at the end. Run with `--pause-between-phases`.
- HOST items stop the runner. An implementer agent that reaches a HOST item prepares the commands and waits for the owner.
- The file holds 41 items in 8 phases. No item changes more than 8 files, and no phase holds more than 6 items.

**Host sessions:** A — items 1.1–1.4. B — item 5.5. C — the labelled host steps of items 6.3, 6.4, 7.1, 7.3, and 7.4, run together after Phases 6–7 merge and reach the host through `scripts/deploy.sh <sha> --tree-only`. D — Phase 8.

**Host safety rules (every HOST item and host step):**

1. Never run `git clean`, `git stash -u`, or `git pull` in `/mnt/user/appdata/open-brain`, and never rename that directory. The Postgres and Redis data directories (`pgdata/`, `redis-data/`) live inside the working tree.
2. Never run a bare `up -d` (no service name), `--remove-orphans`, or `compose down`.
3. Recreate `postgres`, `redis`, and `cloudflared` one at a time with no `-f` flag. Compose auto-merges `docker-compose.override.yml`; `-f docker-compose.yml` alone renders named volumes, which is an empty database.
4. Never write rendered `docker compose config` output to a file or a log. The render inlines `env_file` values.
5. Back up anything that is not in git before changing it: `custom.cron`, `docker-compose.override.yml`, `.env`.
6. The Unraid host has no `python3` and no `psql`. Use `sed`/`awk` for text and `docker exec open-brain-postgres psql` for SQL.
7. The owner is present for every HOST item. An unattended agent does not execute a HOST item.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies | Execution Mode |
|-------|------------|------------------|-----------------|--------------|----------------|
| 1 | Stabilize the live system | Cron backup and offsite copy confirmed; 359 captures embedded; Spark status recorded; failing cron flag removed; first merge to `main` since 2026-07-20 | S (~12 files, ~250 LOC) | None | Sequential |
| 2 | Alert core | `alert_state` store, `raiseAlert`, escalation, daily `ops-digest`, report pushes moved into the digest, one queue registry | L (~28 files, ~1,550 LOC) | Phase 1 | Sequential |
| 3 | Pipeline, source, and tier watchers | Rolling 24-hour queue counts and the `embed-stall` alert, tolerant operator-action parser with a daily digest line, `heartbeat:<source>` records, failure reporting in the gas, Actual, and email runs, `bws` in the workers image | L (~32 files, ~1,650 LOC) | Phase 2 | Sequential |
| 4 | Deploy foundation: compose, probes, and drift | Four-layer drift check that runs as root, backup mount on the parent directory, tracked database bind, fail-closed host binds, probes for every local tier and the data stores | M (~20 files, ~950 LOC) | Phase 2 (item 2.2) for item 4.5 only; items 4.1–4.4 have none | Sequential |
| 5 | Deploy foundation: identity and first clean deploy | Revision labels, `scripts/deploy.sh`, `scripts/preflight.sh`, `DEPLOYED.json`, safe runbooks, pinned images, host tree at one commit | L (~22 files, ~1,100 LOC) | Phases 2, 3, 4 | Sequential |
| 6 | Backup and restore: the restore path | Atomic migrations, `scripts/restore.sh`, rehearsal assertions, complete backup contents | M (~15 files, ~1,100 LOC) | Phase 5 | Sequential |
| 7 | Backup and restore: offsite, CI, crons, secrets | Offsite freshness checks, `dr-restore-e2e` CI job, `scripts/install-crons.sh`, `bws` on the host | M (~16 files, ~900 LOC) | Phase 6 | Sequential |
| 8 | Stateful window | Migration 0037 applied; Postgres, Redis, and `cloudflared` recreated one at a time; speech-to-text migration live; drift check clean on four layers | S (~3 files, ~100 LOC; host session) | Phases 5, 6, 7 | Sequential |

Items 4.1–4.4 are repo-only and may run alongside Phases 2–3; item 4.5 needs item 2.2. The repo work of Phases 6–7 may start before Phase 5 ends; the changed scripts reach the host through `scripts/deploy.sh`. Part 2 (`IMPLEMENTATION_PLAN-2026-11-remediation-part2.md`, Phases 9–16) builds on Phase 5 of this file; its Phase 15 (patch pipeline and CI) touches GitHub only and may start at any time.

### Execution Hints

| Phase | Model Tier | Context Budget | Notes |
|-------|------------|----------------|-------|
| All (default) | `sonnet` | Standard | Per-item Model Tier fields take precedence |
| Phase 1 | `sonnet` | Standard | Items 1.1–1.4 are HOST; item 1.2 is `opus` (BullMQ flow semantics) |
| Phase 2 | `sonnet` | Extended | `pipeline-health.ts` (644 lines) is edited by 2.2 and 2.6; item 2.2 is `opus` |
| Phase 3 | `sonnet` | Extended | `pipeline-health.ts` is edited again by 3.1 and 3.3 |
| Phase 5 | `opus` | Extended | Items 5.2 and 5.5 carry the deploy gate and the host tree reconcile |
| Phase 8 | `opus` | Extended | Every item is HOST and stateful; one service per step |

### Milestones

| Milestone | Phases | Description |
|-----------|--------|-------------|
| A — Live system stable | 1 | Search finds captures made after 2026-08-01; no capture lacks an embedding; the backup and the offsite copy run from cron |
| B — Alerts and deploy identity live | 1–5 | The host tree is one commit of `main`; Phases 2–4 run in production; old and new alert paths run side by side for one week |
| C — Restore proven | 1–7 | The rehearsal passes with index, constraint, and ledger assertions on a dump less than 36 hours old; the offsite copy holds config files |
| D — Stateful window closed | 1–8 | Drift check clean on four layers; `DEPLOYED.json` lists 13 services; OA-10, OA-27, OA-28, OA-32, OA-35 closed |

<!-- BEGIN PHASES -->

---

## Phase 1: Stabilize the live system

**Estimated Complexity:** S (~12 files, ~250 LOC; host session A)
**Dependencies:** None
**Execution Mode:** Sequential

### Goals

- Confirm that the cron backup and the offsite copy run without a person.
- Make the 359 captures without an embedding searchable.
- Record the state of the Spark tier.
- Stop the cron flag that fails on every run.
- Merge to `main` before 2026-12-23 and remove the test fixtures that expire on 2026-12-31.

### Work Items

#### 1.1 Confirm the cron backup and the offsite refill
**Status: COMPLETE (2026-11-23, LAB_NOTEBOOK Entries 255–256)**
**Model Tier: sonnet**
**Requirement Refs:** LIVE-1 (L1, L2), DA7-08
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)

**Description:**
The `0 3 * * *` `scripts/backup.sh` line entered the persistent host `custom.cron` on 2026-11-22 (Entry 253). The first cron-run backup is 2026-11-23 03:00 and the first offsite copy is 03:45. This item reads the two logs and the backup tree, and runs `scripts/offsite-backup.sh` once by hand when the offsite remote still holds 0 objects.

**Tasks:**
1. [ ] Read the Decision Log and the open Action Items in `LAB_NOTEBOOK.md`, then add the Phase 1 entry (objective, hypothesis, rollback, tags `[deploy] [database] [debug]`) before any host command.
2. [ ] As `root` on the homeserver, after 03:45: `readlink /mnt/user/backup/openbrain/latest`; `grep '"captures"' /mnt/user/backup/openbrain/latest/manifest.json`; `tail -20 /var/log/open-brain-backup.log`.
3. [ ] Read the offsite result: `grep -E 'Total objects|Offsite backup complete' /var/log/open-brain-offsite-backup.log | tail -4`.
4. [ ] When `Total objects` is 0, run the offsite copy once by hand: `cd /mnt/user/appdata/open-brain && bash -c 'set -a; . ./.env.secrets; set +a; bash scripts/offsite-backup.sh'`. Read the log again.
5. [ ] Count the config files on the remote (unknown U2): `docker run --rm -v /mnt/user/appdata/rclone-onedrive/config:/config/rclone rclone/rclone:latest lsf -R open-brain-offsite:daily --config /config/rclone/rclone.conf | grep -c /config/`. The expected count is 0 until items 6.4 and 7.1 ship; record the number.
6. [ ] Confirm the backup alert cleared: `docker exec open-brain-postgres psql -U openbrain -d openbrain -At -c "SELECT result->>'backupStale', created_at FROM skills_log WHERE skill_name='pipeline-health' ORDER BY created_at DESC LIMIT 1"`.
7. [ ] Log each command and result in the notebook entry. Mark U2 resolved in the Unknowns Register.

**Acceptance Criteria:**
- [ ] WHEN the 03:00 cron run has passed THEN `readlink /mnt/user/backup/openbrain/latest` SHALL end with that day's date and `manifest.json` SHALL report a `captures` count of 11,714 or more
- [ ] WHEN the 03:45 offsite run has passed THEN `/var/log/open-brain-offsite-backup.log` SHALL show `Total objects:` greater than 0
- [ ] WHEN `pipeline-health` next runs THEN the newest `pipeline-health` row in `skills_log` SHALL report `backupStale` as `false`
- [ ] The count of `/config/` objects on the remote is recorded in `LAB_NOTEBOOK.md`

**Notes:**
HOST — operator-gated. Run in a session with the owner present; an unattended agent does not execute this item. Backup first: none needed; every step reads, except task 4, which adds objects to the remote. Rollback: none; no step deletes or overwrites. Root is required: the backup tree and the logs are root-owned since Entry 253. `/var/log` lives in RAM, so a reboot clears both logs.

---

#### 1.2 Re-embed the 359 stranded captures
**Status: COMPLETE (2026-11-23, LAB_NOTEBOOK Entry 256 — 357 re-embedded; the 2 `failed` document captures excluded by ruling)**
**Model Tier: opus**
**Requirement Refs:** LIVE-2 (L5), SE7-01, PE-012, DA7-19
**Depends On:** 1.1
**Files Affected:**
- `scripts/redrive-stranded-embeds.mjs` (create)
- `LAB_NOTEBOOK.md` (modify)

**Description:**
359 captures have `embedding IS NULL`: 357 at `pipeline_status = 'extracted'` and 2 at `failed`. The retained BullMQ jobs `embed_<id>` and `ingest-root_<id>` make every re-add return "duplicated", so the nightly sweep and `POST /captures/:id/retry` change nothing. A one-off script removes those two retained jobs per capture and adds a standalone `embed_<id>` job. Enrichment children stay untouched, and entity extraction, commitment extraction, and wiki-ingest are not re-run.

**Tasks:**
1. [ ] Write `scripts/redrive-stranded-embeds.mjs` on the pattern of `scripts/enqueue-email-classify.mjs`: the same `createRequire` path to `bullmq@5.70.4` inside the workers image and the same `REDIS_URL` parsing. Flags: `--ids-file <path>` (one capture UUID per line), `--dry-run`, `--limit <n>`.
2. [ ] Per capture ID, one at a time: read job `embed_<id>` from queue `embed-capture`. State `waiting`, `active`, `delayed`, or `waiting-children` → print `in flight` and skip the capture. Any other state → remove `embed_<id>`. Read job `ingest-root_<id>` from queue `ingest-root`; state `failed` → remove with `{ removeChildren: false }`. Add job `embed` to `embed-capture` with data `{ captureId }` and options `{ jobId: 'embed_<id>', attempts: 5, backoff: { type: 'custom' }, removeOnComplete: { age: 604800 }, removeOnFail: { age: 1209600 } }`. Print one line per capture and a final tally of skipped, removed, and added.
3. [ ] Check the script locally: `node --check scripts/redrive-stranded-embeds.mjs`.
4. [ ] Host: confirm item 1.1 passed, and choose a start time outside 03:00–03:30.
5. [ ] Host, read-only inventory: `docker exec open-brain-postgres psql -U openbrain -d openbrain -At -c "SELECT pipeline_status, count(*) FROM captures WHERE embedding IS NULL AND deleted_at IS NULL GROUP BY 1"` (expected: 357 `extracted`, 2 `failed`). Confirm the module path: `docker exec open-brain-workers test -f /app/node_modules/.pnpm/bullmq@5.70.4/node_modules/bullmq/dist/cjs/index.js`.
6. [ ] Host: stop unless the inventory shows exactly 2 `failed` rows. Record the two IDs, then reset exactly those rows: `UPDATE captures SET pipeline_status='extracted' WHERE id IN (<the two recorded IDs>) AND pipeline_status='failed'`. The statement reports `UPDATE 2`.
7. [ ] Host: write the ID list (`SELECT id FROM captures WHERE embedding IS NULL AND deleted_at IS NULL ORDER BY created_at` to `/tmp/stranded-ids.txt`), copy the script and the list into `open-brain-workers` with `docker cp`, run with `--dry-run`, then with `--limit 10`.
8. [ ] Host: confirm the 10 captures reached `complete` with a non-null embedding, then run without `--limit`. Repeat the run until the inventory query returns no row.
9. [ ] Host: clear the stale error text and refresh statistics: `UPDATE captures SET pipeline_error=NULL WHERE embedding IS NOT NULL AND pipeline_status='complete' AND pipeline_error LIKE '%no credits%'`; `ANALYZE captures`. Log every command and count in `LAB_NOTEBOOK.md`.

**Acceptance Criteria:**
- [ ] WHEN the script runs with `--dry-run` THEN the script SHALL print its decision per capture and change no Redis key
- [ ] WHEN job `embed_<id>` is waiting, active, or delayed THEN the script SHALL skip that capture
- [ ] WHEN the full run completes THEN `SELECT count(*) FROM captures WHERE embedding IS NULL AND deleted_at IS NULL` SHALL return 0
- [ ] WHEN a search runs through `GET /api/v1/search` for a phrase from a capture created after 2026-08-01 THEN the result list SHALL contain that capture
- [ ] WHEN `pipeline-health` next runs THEN queue `embed-capture` SHALL report fewer than 5 failed jobs
- [ ] `node --check scripts/redrive-stranded-embeds.mjs` exits 0
- [ ] The script names only queues `embed-capture` and `ingest-root`; no `extract-entities_`, `extract-commitments_`, or `wiki-ingest_` job is removed or added

**Notes:**
HOST — operator-gated. Tasks 4–9 run on the host; tasks 1–3 are repo work. The owner is present for the host run; an unattended agent does not execute tasks 4–9. Backup first: the daily backup confirmed in item 1.1. Rollback: embeddings are additive; the status reset of 2 rows reverses with `UPDATE captures SET pipeline_status='failed' WHERE id IN (…)` using the two recorded IDs. Never suffix job IDs, never remove the whole flow tree, never mark a capture `failed`, and never re-run entity extraction, commitment extraction, or wiki-ingest in bulk: each is paid per item (cost rule in `CLAUDE.md`). The time window matters: the 03:00 sweep adds a full flow for any capture at `extracted`, which re-runs paid enrichment. The `triggers` table has 0 rows, so no trigger notification can fire. Cost: about 359 embedding calls, roughly $0.20. The host has no `psql`; every SQL statement runs through `docker exec open-brain-postgres psql`. Record capture IDs and counts in the notebook, never capture text: the repository is public. The code fix for the sweep and the retry route is in Part 2 (Phase 9).

---

#### 1.3 Restore the Spark tier or record it as out of service
**Status: COMPLETE — recorded as out of service (2026-11-23, Entry 256; OA-36 OPEN)**
**Model Tier: sonnet**
**Requirement Refs:** L6, INT-011 (probe part)
**Depends On:** 1.2
**Files Affected:**
- `OPERATOR_ACTIONS.md` (modify — only when Spark stays down)
- `LAB_NOTEBOOK.md` (modify)

**Description:**
Every `t1_spark` call timed out in November (entity extraction 68 of 68, commitment extraction 67 of 67). The Spark inference server runs outside this repository. The owner restores the server, or records that Spark tasks run on the paid fallback tier until Part 2 (Phase 12) adds the circuit breaker.

**Tasks:**
1. [ ] Owner: check the Spark endpoint from the homeserver LAN: `curl -s -o /dev/null -w '%{http_code}' http://spark.k4jda.net:8000/health`.
2. [ ] When the result is not 200: the owner restarts the inference server on the Spark host (the procedure lives in the Spark project) and repeats the check.
3. [ ] When Spark stays down: add a dated row to `OPERATOR_ACTIONS.md` ("Restore the `t1_spark` inference server", status `OPEN`, due date set by the owner). The row states the cost of the outage: entity and commitment extraction wait 120 s per call and then run on the paid `t1_fast` tier.
4. [ ] Record the HTTP code, the decision, and the date in `LAB_NOTEBOOK.md`. Mark U4 resolved or accepted in the Unknowns Register.

**Acceptance Criteria:**
- [ ] WHEN the Spark server is restored THEN `curl -s -o /dev/null -w '%{http_code}' http://spark.k4jda.net:8000/health` SHALL print `200`
- [ ] WHEN the Spark server is not restored THEN `OPERATOR_ACTIONS.md` SHALL hold a dated `OPEN` row for the restore
- [ ] The outcome is recorded in `LAB_NOTEBOOK.md`

**Notes:**
HOST — operator-gated. The work happens on the Spark host, outside this repository; the owner performs it, never an unattended agent. Backup first: not applicable; no Open Brain state changes. Rollback: not applicable. Item 4.5 adds the Spark probe. Part 2 (Phase 12) adds the circuit breaker that removes the 120 s wait per call.

---

#### 1.4 Remove the always-failing cron flag and the dead cron lines
**Status: COMPLETE (2026-11-23, LAB_NOTEBOOK Entry 256; first run without the flag = 2026-11-24 06:30)**
**Model Tier: sonnet**
**Requirement Refs:** SE7-07 (cron part), SE7-15 (cron part)
**Depends On:** 1.3
**Files Affected:**
- `deploy/cron/unraid-ingest.cron` (modify)
- `LAB_NOTEBOOK.md` (modify)

**Description:**
The host `custom.cron` utility line runs `utility-pipeline.py --gas --power-summary`. Power ingestion is not built (OA-22, issue #286), so `--power-summary` records an error on every run. The repo template `deploy/cron/unraid-ingest.cron` also carries two Plaid lines (`--balances`, `--account-monitoring`) for a feature dropped in D138; the host has no Plaid lines. This item removes the flag on the host and removes the flag and the two Plaid lines from the template.

**Tasks:**
1. [ ] In `deploy/cron/unraid-ingest.cron`: change the utility line to `--gas` only, rewrite the comment above the line (the power summary returns when issue #286 ships), and delete the `--balances` and `--account-monitoring` lines with their comment block.
2. [ ] Host, as `root`: back up the cron table: `cp /boot/config/plugins/dynamix/custom.cron /boot/config/plugins/dynamix/custom.cron.bak-$(date +%Y%m%d)`.
3. [ ] Host: `sed -i 's/ --gas --power-summary/ --gas/' /boot/config/plugins/dynamix/custom.cron`, then `/usr/local/sbin/update_cron`.
4. [ ] Host: verify `grep -c power-summary /etc/cron.d/root` prints 0, `grep -c 'utility-pipeline.py --gas' /etc/cron.d/root` prints 1, and `grep -c 'scripts/backup.sh' /etc/cron.d/root` prints 1.
5. [ ] Log the commands and results in `LAB_NOTEBOOK.md`.

**Acceptance Criteria:**
- [ ] WHEN the 06:30 utility cron next runs THEN the cron line SHALL invoke `utility-pipeline.py --gas` without `--power-summary`
- [ ] `grep -c power-summary /etc/cron.d/root` prints 0 (host)
- [ ] `grep -c 'scripts/backup.sh' /etc/cron.d/root` prints 1 (host; the edit kept the backup line)
- [ ] `grep -vE '^\s*#' deploy/cron/unraid-ingest.cron | grep -cE -- '--power-summary|--balances|--account-monitoring'` prints 0 (repo)

**Notes:**
HOST — operator-gated. Tasks 2–4 run on the host. The owner is present; an unattended agent does not execute tasks 2–4. Backup first: `custom.cron` is copied before the edit. Rollback: copy the backup file back and run `/usr/local/sbin/update_cron`. `/boot/config` is root-only; connect with `ssh root@homeserver.k4jda.net`. `custom.cron` holds jobs that do not belong to Open Brain; the `sed` expression matches the utility line only. Item 3.4 makes the gas run exit non-zero on errors. Item 7.3 moves every Open Brain line into one managed block.

---

#### 1.5 Defuse the dated test fixtures
**Status: COMPLETE — no change needed (2026-11-23, LAB_NOTEBOOK Entry 256: every suite passes under a 2027-01-15 clock; QA-018 premise false)**
**Model Tier: sonnet**
**Requirement Refs:** QA-018
**Depends On:** 1.4
**Files Affected:**
- `packages/core-api/src/__tests__/bet-routes.test.ts` (modify)
- `packages/core-api/src/__tests__/bet-service.test.ts` (modify)
- `packages/core-api/src/__tests__/insurance-policies-routes.test.ts` (modify)

**Description:**
Three core-api test files hold the literal date `2026-12-31` as a "future" value (`bet-routes.test.ts:14,26,100`, `bet-service.test.ts:62,88`, `insurance-policies-routes.test.ts:39`). After that date the fixtures are in the past and the tests fail required checks. Each literal becomes a date computed from the test clock.

**Tasks:**
1. [ ] Replace each `2026-12-31` literal with a value computed from the clock, for example a module constant `const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)` and its ISO string.
2. [ ] Prove the three files pass after the expiry date: run them once with `vi.useFakeTimers()` and `vi.setSystemTime(new Date('2027-01-15'))` added locally. Do not commit the temporary clock lines.
3. [ ] Run `pnpm --filter @open-brain/core-api test` and confirm the coverage floor (80/80) holds.

**Acceptance Criteria:**
- [ ] WHEN the three test files run with the system time set to 2027-01-15 THEN every test in the three files SHALL pass
- [ ] `grep -rn '2026-12-31' packages/*/src` prints nothing
- [ ] `pnpm --filter @open-brain/core-api test` exits 0

**Notes:**
Ships in ONE pull request with item 1.6. Deadline 2026-12-31. When the host items of Phase 1 slip past 2026-12-15, run items 1.5 and 1.6 ahead of the remaining host items; neither item needs a host result.

---

#### 1.6 Land today's records
**Status: COMPLETE (2026-11-23, PR #403 squash-merged as `ae27416`; CI + Build and Push Images + CodeQL green on it)**
**Model Tier: sonnet**
**Requirement Refs:** PLT-025, QA-006
**Depends On:** 1.5
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify — Entries 252–254, uncommitted today)
- `CLAUDE.md` (modify — cron rule, uncommitted today)
- `deploy/cron/unraid-backup.cron` (create — on disk, untracked today)
- `docs/adr/ADR-0005-alert-state-model.md` (create — on disk, untracked today)
- `docs/adr/ADR-0006-deployed-state-identity.md` (create — on disk, untracked today)
- `IMPLEMENTATION_PLAN-2026-11-remediation.md` (create — on disk, untracked today; owner's call)
- `IMPLEMENTATION_PLAN-2026-11-remediation-part2.md` (create — on disk, untracked today; owner's call)

**Description:**
Five files changed on 2026-11-22 are not on `main`. This item puts the five files into the Phase 1 pull request with items 1.2, 1.4, and 1.5, and merges the pull request. The merge is the first commit on `main` since 2026-07-20: the merge runs every required check on `main` and resets GitHub's 60-day inactivity clock. The owner decides whether the two plan files enter the public repository.

**Tasks:**
1. [ ] Before the first `/implement-plan` run, on a feature branch: commit `LAB_NOTEBOOK.md`, `CLAUDE.md`, `deploy/cron/unraid-backup.cron`, and the two ADR files. The runner refuses a dirty working tree. The five git refs that Entry 253 held were deleted from GitHub on 2026-11-23 (Entry 255), so the notebook is safe to commit.
2. [ ] Ask the owner whether the two plan files are committed. Yes → `git add` both files. No → add both file names to `.git/info/exclude` so the working tree stays clean.
3. [ ] Run `gh auth status` and confirm the active account has push rights on `davistroy/open-brain`, then open the pull request for the Phase 1 branch.
4. [ ] Wait for every required check to pass, then merge.
5. [ ] After the merge: `gh run list --branch main --limit 5` shows a `CI` run and a `Build and Push Images` run on the merge commit. Record the merge SHA in `LAB_NOTEBOOK.md` and mark U6 resolved.

**Acceptance Criteria:**
- [ ] WHEN the pull request merges THEN `git log origin/main -1 --format=%cs` SHALL print a date later than 2026-07-20
- [ ] WHEN the merge commit exists THEN `gh run list --branch main --limit 1` SHALL show a `CI` run on that commit
- [ ] WHEN `git status --short` runs on `main` after the merge THEN the output SHALL list none of the five files
- [ ] The owner's decision on the two plan files is recorded in `LAB_NOTEBOOK.md`
- [ ] The merge date is before 2026-12-23

**Notes:**
Ships in ONE pull request with item 1.5. The weekly `schedule` trigger for `ci.yml` (the rest of QA-006) and the stale-automation alarm (the rest of PLT-025) are in Part 2 (Phase 15). The merge triggers `build-images.yml`; the new `:latest` images deploy nothing until item 5.5. The repository is public: the notebook entries hold no balance, payee, account identifier, or token (financial data rule in project memory).

---

### Phase 1 Testing Requirements

- [ ] `scripts/redrive-stranded-embeds.mjs` passes `node --check`, then `--dry-run` and `--limit 10` on the host before the full run
- [ ] The three fixture files pass with the system time set to 2027-01-15
- [ ] `pnpm --filter @open-brain/core-api test` passes with the coverage floor intact
- [ ] Every required check passes on the Phase 1 pull request

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] Unembedded capture count is 0 on the host
- [ ] Cron backup and offsite copy confirmed from the logs
- [ ] Phase 1 pull request merged to `main` before 2026-12-23
- [ ] `LAB_NOTEBOOK.md` entry holds every host command, result, and count
- [ ] CLAUDE.md and memory updated with any non-trivial learning
- [ ] U2, U4, and U6 updated in the Unknowns Register

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests | `pnpm -r test` | Exit code 0 (coverage thresholds for core-api and workers enforced) |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Re-drive script syntax | `node --check scripts/redrive-stranded-embeds.mjs` | Exit code 0 |
| No dated fixture breaks | Ruling 2026-11-23 (LAB_NOTEBOOK Entry 256): every suite passes under a 2027-01-15 clock; the literals stay | Recorded in Entry 256 |
| Cron template clean | `! grep -E -e '^[^#]*--power-summary' -e '^[^#]*--balances' -e '^[^#]*--account-monitoring' deploy/cron/unraid-ingest.cron` | Exit code 0 |

<!-- END DOD -->

---

## Phase 2: Alert core

**Estimated Complexity:** L (~28 files, ~1,550 LOC)
**Dependencies:** Phase 1
**Execution Mode:** Sequential

### Goals

- Store a state for every operational alert, so an alert fires when a condition changes and stays silent while the condition holds.
- Escalate an open critical alert at 24 hours and at 7 days; let an acknowledgement snooze escalation.
- Send one daily digest that carries the reports.
- Replace the three hand-kept queue lists with one registry.
- Keep the old direct pushes running beside the new path for the first week after deploy.

### Work Items

#### 2.1 Pushover limits and receipts; alert-state store ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** SA7-05, PLT-027, PLT-020 (message length)
**Files Affected:**
- `packages/shared/src/services/pushover.ts` (modify)
- `packages/shared/src/services/__tests__/pushover.test.ts` (create)
- `packages/workers/src/lib/alert-state.ts` (create)
- `packages/workers/src/__tests__/alert-state.test.ts` (create)
- `LAB_NOTEBOOK.md` (modify)

**Description:**
`PushoverService.send()` sends a message of any length and drops the response body, so a body over Pushover's 1,024-character limit is rejected and the priority-2 receipt is lost. No component records whether a condition was already reported. This item caps the message and the title, returns the receipt, adds `getReceipt()`, and creates the alert-state store in `app_settings` with a pure decision function.

**Tasks:**
1. [ ] Add the Phase 2 entry to `LAB_NOTEBOOK.md` (objective, hypothesis, rollback: `ALERT_STATE_ENABLED=false`) before the first commit.
2. [ ] `pushover.ts`: truncate `message` to 1,024 characters and the prefixed `title` to 250 characters. A truncated value ends with `…(+N)`, where N is the number of removed characters. Parse the JSON response and return `{ receipt }` when the priority is 2. Keep the return type assignable from `undefined`, so existing `mockResolvedValue(undefined)` mocks compile.
3. [ ] `pushover.ts`: add `getReceipt(receipt)`, which calls `GET https://api.pushover.net/1/receipts/<receipt>.json?token=<app token>` with a 10 s timeout and returns `{ acknowledged, acknowledgedAt, expired }`.
4. [ ] Create `packages/workers/src/lib/alert-state.ts`: `readAlertState(db, key)`, `writeAlertState(db, key, state)`, and `listOpenAlerts(db)` on `app_settings` key `alert_state:<key>`, following `readScanWatermark` and `writeScanWatermark` in `lib/hnsw-similarity.ts`. State shape: `{ status: 'ok' | 'bad', since, last_notified_at, level, receipt, acked_at }`.
5. [ ] Add the pure function `nextAction(state, { bad, severity, now })` returning `none`, `notify`, or `resolve`: ok→bad gives `notify`, bad→bad gives `none`, bad→ok gives `resolve`, ok→ok gives `none`. A missing or unparseable state counts as ok.
6. [ ] Tests. `pushover.test.ts`: both caps, the `…(+N)` suffix, the receipt for priority 2, `getReceipt` parsing, the title prefix kept. `alert-state.test.ts`: a table of `nextAction` cases, a store round-trip against a mocked `db.execute`, unparseable JSON treated as ok with a warn log.

**Acceptance Criteria:**
- [ ] WHEN `send()` receives a message longer than 1,024 characters THEN `PushoverService` SHALL send exactly 1,024 characters ending with `…(+N)`
- [ ] WHEN `send()` is called with priority 2 THEN `PushoverService` SHALL return the `receipt` from the Pushover response
- [ ] WHEN `nextAction` receives a stored `bad` state and `bad: true` THEN `nextAction` SHALL return `none`
- [ ] WHEN the stored state is missing or unparseable and `bad` is true THEN `nextAction` SHALL return `notify`
- [ ] `pnpm --filter @open-brain/shared test` exits 0
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/alert-state.test.ts` exits 0
- [ ] `grep -c 'alert_state' packages/core-api/src/routes/settings.ts` prints 0

**Notes:**
The `alert_state:*` keys are written through the database layer (`db.execute`) and are not added to the settings API whitelists (`WRITABLE_KEYS`, `READABLE_KEYS`). `app_settings` is not pruned by `data-retention-prune` and survives a Redis loss. The two caps apply to every caller of `PushoverService` (core-api, voice-capture, slack-bot, workers). The shell notifier `scripts/lib/pushover-notify.sh` is unchanged. Rebuild `@open-brain/shared` before running `tsc` in a dependent package.

---

#### 2.2 `raiseAlert` and migration of the operational alerts ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: opus**
**Requirement Refs:** SA7-05, PLT-027
**Depends On:** 2.1
**Files Affected:**
- `packages/workers/src/lib/alert-state.ts` (modify — created in item 2.1)
- `packages/workers/src/skills/base-skill.ts` (modify)
- `packages/workers/src/skills/pipeline-health.ts` (modify)
- `packages/workers/src/jobs/budget-check.ts` (modify)
- `packages/workers/src/__tests__/alert-state.test.ts` (modify — created in item 2.1)
- `packages/workers/src/__tests__/pipeline-health.test.ts` (modify)
- `packages/workers/src/__tests__/budget-check.test.ts` (modify)
- `docs/adr/ADR-0005-alert-state-model.md` (modify)

**Description:**
Skills call `PushoverService` on every run: `pipeline-health.ts:549` (queues), `pipeline-health.ts:584` (backup stale, priority 1 every 6 hours), `budget-check.ts:311` (daily). This item adds `raiseAlert({ key, severity, bad, title, message })`, which sends on ok→bad, sends a priority −1 "resolved" on bad→ok, and sends nothing while the condition holds. `pipeline-health` and `budget-check` call `raiseAlert` under the feature flag `ALERT_STATE_ENABLED`; the old direct pushes keep running while `ALERT_LEGACY_PUSH` is on.

**Tasks:**
1. [ ] `alert-state.ts`: add `raiseAlert(deps, { key, severity, bad, title, message })`. `ALERT_STATE_ENABLED=false` → return without reading state. Otherwise read the state, call `nextAction`, and act: `notify` sends at priority 1 for `critical` and priority 0 for `warning`; `resolve` sends "Resolved: <title>" at priority −1. Write the new state after the send.
2. [ ] `alert-state.ts`: add `alertStateEnabled()` (true unless `ALERT_STATE_ENABLED` is `false`) and `legacyPushEnabled()` (true when `ALERT_STATE_ENABLED` is `false`, or when `ALERT_LEGACY_PUSH` is not `false`).
3. [ ] Fail open: a state read or write error logs at warn and `raiseAlert` sends the alert as ok→bad. A state error never suppresses a send.
4. [ ] `base-skill.ts`: add `protected raiseAlert(args)`, which calls the library function with `this.db` and `this.pushover`.
5. [ ] `pipeline-health.ts`: make three independent calls on every run: key `backup-stale` (critical), key `pipeline-queues` (warning: failed, backlogged, or stalled queues), key `capture-flow` (warning). Each call passes `bad: false` when the condition is clear. `sendAlert()` and `sendBackupStaleAlert()` run only when `legacyPushEnabled()` is true.
6. [ ] `budget-check.ts`: call the library function with key `budget-soft` (warning) and key `budget-hard` (critical); `sendBudgetAlert()` runs only when `legacyPushEnabled()` is true. Change no threshold.
7. [ ] Tests: the switch matrix (both on → both paths send; `ALERT_LEGACY_PUSH=false` → one send on ok→bad, none on the next bad run, one "resolved" on recovery; `ALERT_STATE_ENABLED=false` → legacy pushes only); fail-open on a store error; separate keys for backup and queues.
8. [ ] `ADR-0005`: set Status to `Accepted`; record the two switches and that decision point 8 (the off-host watchdog) ships in Part 2 (Phase 14, item 14.4).

**Acceptance Criteria:**
- [ ] WHEN the backup manifest is stale on two consecutive runs with `ALERT_LEGACY_PUSH=false` THEN `pipeline-health` SHALL send one `backup-stale` message on the first run and none on the second
- [ ] WHEN the backup manifest returns to fresh THEN `pipeline-health` SHALL send one priority −1 "resolved" message and write `status: ok` to `alert_state:backup-stale`
- [ ] WHEN `ALERT_STATE_ENABLED=false` THEN `pipeline-health` and `budget-check` SHALL push exactly as they do at `f341ca6`
- [ ] WHEN the alert-state read throws THEN `raiseAlert` SHALL send the alert
- [ ] WHEN queues fail while the backup is fresh THEN `raiseAlert` SHALL write `alert_state:pipeline-queues` and leave `alert_state:backup-stale` unchanged
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/alert-state.test.ts src/__tests__/pipeline-health.test.ts src/__tests__/budget-check.test.ts` exits 0
- [ ] `pnpm --filter @open-brain/workers test` exits 0 (coverage floor lines 78 / functions 81 holds)

**Notes:**
Rollout: both switches default to on, so for the first week after item 5.5 the old direct pushes and the new path both run. One week after item 5.5 the owner sets `ALERT_LEGACY_PUSH: "false"` in the workers `environment:` block of `docker-compose.yml` and deploys; item 5.5 records that step as a dated operator action. Rollback: `ALERT_STATE_ENABLED: "false"` in the same block. `stale-captures.ts` has no dispatcher case and is not migrated. `container-health` moves to `raiseAlert` in item 4.5, and `secret-rotation` in item 3.6, because those items already edit those files. Product messages (briefs, capture confirmations) are unchanged. The budget thresholds have six sources; Part 2 (Phases 12–13) reduces the six to one, and this item changes the alert path only.

---

#### 2.3 Escalation and acknowledgement ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** SA7-05
**Depends On:** 2.2
**Files Affected:**
- `packages/workers/src/lib/alert-state.ts` (modify — created in item 2.1)
- `packages/workers/src/__tests__/alert-state.test.ts` (modify — created in item 2.1)
- `docs/runbooks/alert-escalation.md` (create)

**Description:**
After item 2.2 an alert that stays open sends no further message, so an unread critical alert stays unread. `nextAction` gains escalation for `critical` alerts: at 24 hours a priority-2 Pushover (Pushover repeats a priority-2 message until acknowledged) plus a Slack direct message; at 7 days an email plus one priority-2 Pushover per day. Acknowledging the Pushover receipt snoozes escalation for 7 days. A `warning` alert never rises above priority 0.

**Tasks:**
1. [ ] Extend `nextAction` with the actions `escalate_24h`, `escalate_7d`, and `repeat_p2`, decided from `since`, `level`, `last_notified_at`, and `acked_at`. `level` records the highest escalation sent (0, 1, or 2).
2. [ ] `raiseAlert`, action `escalate_24h`: send priority 2 with `retry: 600` and `expire: 10800`, store the returned `receipt`, and post the same text through `SlackMessenger` to channel `MORNING_BRIEF_SLACK_CHANNEL`.
3. [ ] Action `escalate_7d`: send the alert text by email through `HimalayaService` to `WEEKLY_BRIEF_EMAIL`, and send priority 2. Action `repeat_p2`: one priority-2 send per 24 hours while the alert is open and unacknowledged.
4. [ ] Acknowledgement: on each `raiseAlert` call with `bad: true`, a stored `receipt`, and no `acked_at`, call `PushoverService.getReceipt()`. `acknowledged` → write `acked_at`. `nextAction` returns `none` for 7 days after `acked_at`, then resumes escalation.
5. [ ] A missing Slack token, a missing email config, or a failed receipt lookup logs at warn and never blocks the Pushover send.
6. [ ] Table-driven tests with a fixed `now`: 23 h → `none`; 24 h → `escalate_24h`; 7 d → `escalate_7d`; 8 d unacknowledged → `repeat_p2`; acknowledged at 30 h → `none` until 30 h + 7 d; a `warning` open 30 d → `none`.
7. [ ] Write `docs/runbooks/alert-escalation.md`: the three alert classes, the escalation timeline, how to acknowledge, the two switches, the rollback.

**Acceptance Criteria:**
- [ ] WHEN a `critical` alert has been open 24 hours and `raiseAlert` runs with `bad: true` THEN `raiseAlert` SHALL send one priority-2 message with `retry=600` and `expire=10800`, store the receipt, and post one Slack message
- [ ] WHEN the stored receipt reports `acknowledged` THEN `raiseAlert` SHALL write `acked_at` and send no escalation for 7 days
- [ ] WHEN a `critical` alert has been open 7 days without acknowledgement THEN `raiseAlert` SHALL send one email and one priority-2 message, and one priority-2 message on each following day
- [ ] WHEN a `warning` alert stays open for 30 days THEN `raiseAlert` SHALL send nothing after the first message
- [ ] WHEN the Slack send or the email send fails THEN `raiseAlert` SHALL still send the Pushover message
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/alert-state.test.ts` exits 0

**Notes:**
Escalation runs when the owning skill next calls `raiseAlert` (`pipeline-health` every 6 hours, `budget-check` daily, `container-health` every 15 minutes), so no new scheduled job is added. The digest of item 2.4 keeps listing an acknowledged alert while the alert is open. `HimalayaService.isConfigured` is false without `HIMALAYA_CONFIG`; the email step then logs and skips.

---

#### 2.4 Daily ops digest ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** PLT-027, SA7-05
**Depends On:** 2.2
**Files Affected:**
- `packages/workers/src/skills/ops-digest.ts` (create)
- `packages/workers/src/scheduler.ts` (modify)
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/workers/src/skills/morning-brief.ts` (modify)
- `packages/workers/src/__tests__/ops-digest.test.ts` (create)
- `packages/workers/src/__tests__/scheduler-register.test.ts` (modify)
- `CLAUDE.md` (modify)
- `docs/skill-inventory.md` (modify)

**Description:**
In one 12-hour window `workers` sent 5 messages, of which 1 needed action. A new skill `ops-digest` sends one Pushover per day at 07:30 in the scheduler timezone: open alerts with their ages first, then one line per report source read from `skills_log`, then the backup age. The full text goes to the Slack direct-message channel. The skill sends nothing when there is nothing to report.

**Tasks:**
1. [ ] Confirm slot `30 7 * * *` is free. No `const *Cron` in `scheduler.ts` uses minute 30 of hour 7 at `f341ca6`; `scheduler-slots.test.ts` is the gate.
2. [ ] Create `ops-digest.ts` with `buildOpsDigest(db, now)` returning `{ openAlerts, infoLines, backupAgeSeconds, pushText, fullText }`. Open alerts come from `listOpenAlerts(db)` with age and severity. Info lines are the newest `skills_log.output_summary` of the last 24 hours for `drift-monitor`, `wiki-lint`, `email-classify`, `capture-dedup-sweep`, `storage-audit`, `memory-consolidation`, and `secret-rotation`.
3. [ ] `OpsDigestSkill.run()`: no open alert and no info line → log and return without sending. Otherwise send `pushText` at priority 0 and post `fullText` through `SlackMessenger` to `MORNING_BRIEF_SLACK_CHANNEL`. `pushText` lists open alerts first, so the 1,024-character cap cuts report lines and never an alert line. The skill declares no `minimum_autonomy`.
4. [ ] `scheduler.ts`: add `const opsDigestCron = '30 7 * * *'`, the registration with scheduler id `scheduled_ops-digest`, and the JSDoc line. `skill-execution.ts`: add the case `ops-digest`.
5. [ ] `morning-brief.ts`: append an ops footer built by `buildOpsDigest` (the count and names of open alerts). A builder error logs at warn and leaves the brief unchanged.
6. [ ] Tests. `scheduler-register.test.ts`: the `skill-execution` repeatables rise from 17 to 18. `ops-digest.test.ts`: empty → no send; open alerts plus info lines → alert lines first; a text over 1,024 characters keeps every alert line.
7. [ ] `CLAUDE.md`: add `30 7` ops-digest to the weekday morning cluster in both scheduler slot registry bullets. `docs/skill-inventory.md`: add the skill row and the schedule row.

**Acceptance Criteria:**
- [ ] WHEN no alert is open and no report row exists in the last 24 hours THEN `ops-digest` SHALL send no Pushover and no Slack message
- [ ] WHEN two alerts are open and five report rows exist THEN the Pushover text SHALL list the two alerts with their ages before any report line
- [ ] WHEN the digest text exceeds 1,024 characters THEN the Pushover text SHALL keep every open-alert line and the Slack message SHALL carry the full text
- [ ] WHEN `registerScheduledJobs` runs THEN the `skill-execution` queue SHALL hold the scheduler `scheduled_ops-digest` with pattern `30 7 * * *`
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/scheduler-slots.test.ts src/__tests__/scheduler-register.test.ts src/__tests__/ops-digest.test.ts` exits 0
- [ ] `grep -c '30 7 \* \* \*' packages/workers/src/scheduler.ts` prints 2 or more (the declaration and the JSDoc line)

**Notes:**
The JSDoc block in `scheduler.ts` and the slot registry in `CLAUDE.md` change in the same commit as the cron (project rule). A JSDoc block cannot contain `*/`. `budget-check` holds `0 7` and `drift-monitor` holds `15 7`. Item 3.2 adds the daily operator-action line to the digest. `core-api/src/services/skill-config.ts` holds display defaults with schedules that already differ from `scheduler.ts`; this item does not edit that file.

---

#### 2.5 Informational pushes move into the digest ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** PLT-027, GitHub issue #312
**Depends On:** 2.4
**Files Affected:**
- `packages/workers/src/skills/base-skill.ts` (modify)
- `packages/workers/src/skills/drift-monitor.ts` (modify)
- `packages/workers/src/skills/wiki-lint.ts` (modify)
- `packages/workers/src/skills/email-classify.ts` (modify)
- `packages/workers/src/skills/capture-dedup-sweep.ts` (modify)
- `packages/workers/src/skills/memory-consolidation.ts` (modify)
- `scripts/backup.sh` (modify)
- `packages/workers/src/__tests__/base-skill.test.ts` (modify)

**Description:**
Five report skills each send their own Pushover (`drift-monitor.ts:212`, `wiki-lint.ts:199`, `email-classify.ts:197`, `capture-dedup-sweep.ts:308`, `memory-consolidation.ts:664`), and `scripts/backup.sh:286-288` pushes after every successful backup. The five skills now call a new `BaseSkill.sendInfo()`, which pushes only while `legacyPushEnabled()` is true; the digest carries the five reports. `backup.sh` drops the success push. The owner renames the Pushover application "Voice Capture" (issue #312, OA-25).

**Tasks:**
1. [ ] `base-skill.ts`: add `protected sendInfo(title, message, priority?)`. `legacyPushEnabled()` true → call `sendNotification()`. False → log at debug and return `false`.
2. [ ] Replace the direct push in each of the five skills with `this.sendInfo(...)`. In `memory-consolidation.ts` change the notification block only.
3. [ ] `scripts/backup.sh`: delete the success `notify_pushover_mismatch` call at lines 286–288. Keep `BACKUP_STATUS="success"` and the failure trap.
4. [ ] `base-skill.test.ts`: `sendInfo` pushes with `ALERT_LEGACY_PUSH` unset and sends nothing with `ALERT_LEGACY_PUSH=false`; a static check reads the five skill files and fails on a `this.pushover.send(` or `this.sendNotification(` call.
5. [ ] Owner action OA-25 (closes issue #312): in the Pushover console rename the application "Voice Capture" to "Open Brain" (`docs/runbooks/pushover-alert-branding.md`, option A). The token does not change. Item 3.2 sets the OA-25 row in `OPERATOR_ACTIONS.md`.

**Acceptance Criteria:**
- [ ] WHEN `ALERT_LEGACY_PUSH=false` and `drift-monitor` runs THEN `drift-monitor` SHALL send no Pushover and SHALL still write its `skills_log` row
- [ ] WHEN `ALERT_LEGACY_PUSH` is unset THEN each of the five skills SHALL push as at `f341ca6`
- [ ] WHEN `scripts/backup.sh` finishes with status success THEN the script SHALL send no Pushover
- [ ] WHEN `scripts/backup.sh` exits non-zero THEN the EXIT trap SHALL send the failure push
- [ ] `grep -cE 'this\.pushover\.send\(|this\.sendNotification\(' <file>` prints 0 for each of the five skill files
- [ ] `bash scripts/test-backup-secrets-redaction.sh` exits 0
- [ ] `pnpm --filter @open-brain/workers test` exits 0

**Notes:**
`storage-audit` sends no push today; the digest reads its `skills_log` row. `cost-analysis`, `daily-connections`, `daily-sweep-skill`, `weekly-brief`, `morning-brief`, `capture-reminder`, `monthly-reflection`, and `wiki-synthesis` send product messages and stay unchanged. Item 3.5 edits `email-classify.ts` again (an auth failure goes through `raiseAlert`). Part 2 (Phase 11) rewrites the SQL of `memory-consolidation.ts`. The `backup.sh` change reaches the host at item 5.5.

---

#### 2.6 One queue registry ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** SE7-11
**Depends On:** 2.2
**Files Affected:**
- `packages/shared/src/queue-names.ts` (create)
- `packages/shared/src/index.ts` (modify)
- `packages/workers/src/skills/pipeline-health.ts` (modify)
- `packages/core-api/src/routes/admin.ts` (modify)
- `packages/core-api/src/services/system-health.ts` (modify)
- `packages/workers/src/__tests__/queue-names.test.ts` (create)
- `packages/core-api/src/__tests__/admin-queue-clear.test.ts` (modify)
- `packages/core-api/src/__tests__/admin-routes.test.ts` (modify)

**Description:**
Three hand-kept queue lists disagree: `ALL_QUEUE_NAMES` in `pipeline-health.ts:109` (8 names, including `notification`, which no worker consumes), `QUEUE_NAMES` in `core-api/src/routes/admin.ts:27` (5 names, so the clear endpoint cannot reach `embed-capture` or `ingest-root`), and `MONITORED_QUEUES` in `core-api/src/services/system-health.ts:147` (9 names). `workers` registers 17 queues. One exported registry replaces the three lists, and a test compares the registry with every `new Worker(` call.

**Tasks:**
1. [ ] Create `packages/shared/src/queue-names.ts` with `WORKER_QUEUES` (17 names: `capture-pipeline`, `ingest-root`, `embed-capture`, `extract-entities`, `extract-commitments`, `check-triggers`, `wiki-ingest`, `document-pipeline`, `ingest-process`, `skill-execution`, `access-stats`, `prune-associations`, `daily-sweep`, `budget-check`, `data-retention-prune`, `pushover`, `email`), `PRODUCER_ONLY_QUEUES` (`wiki-lint`), and `ALL_MONITORED_QUEUES`. Export the module from `packages/shared/src/index.ts`.
2. [ ] `pipeline-health.ts`: replace `ALL_QUEUE_NAMES` with the registry. Failure counts read `WORKER_QUEUES`; waiting counts read `ALL_MONITORED_QUEUES`.
3. [ ] `core-api/src/routes/admin.ts`: `QUEUE_NAMES` becomes the registry (Bull Board and `POST /queues/:name/clear`). `core-api/src/services/system-health.ts`: `MONITORED_QUEUES` becomes the registry.
4. [ ] `queue-names.test.ts`: read every non-test file under `packages/workers/src`, collect the queue name of each `new Worker(` call (resolve the constant `INGEST_ROOT_QUEUE_NAME`), and assert set equality with `WORKER_QUEUES`.
5. [ ] Update the two core-api tests that name the `notification` queue (`admin-queue-clear.test.ts:82,167`, `admin-routes.test.ts:769`), and add a case that clears `embed-capture`.

**Acceptance Criteria:**
- [ ] WHEN a `new Worker('<name>'` call exists without a registry entry THEN `queue-names.test.ts` SHALL fail
- [ ] WHEN `POST /api/v1/admin/queues/embed-capture/clear` arrives from an allowlisted origin THEN the endpoint SHALL clear the queue and write the `queue_clear_executed` audit row
- [ ] WHEN `POST /api/v1/admin/queues/notification/clear` arrives THEN the endpoint SHALL reject the queue name
- [ ] `pnpm --filter @open-brain/shared build && pnpm --filter @open-brain/workers exec vitest run src/__tests__/queue-names.test.ts` exits 0
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/admin-queue-clear.test.ts src/__tests__/admin-routes.test.ts src/__tests__/system-health.test.ts` exits 0

**Notes:**
core-api does not import from `@open-brain/workers` (project rule), so the registry lives in `@open-brain/shared`. The `openbrain_queue_*` gauge names stay. The queue object in `workers/src/queues/notification.ts` is not removed by this item. Item 3.1 changes how `pipeline-health` counts failures across the registry.

---

### Phase 2 Testing Requirements

- [ ] `nextAction` has a table-driven test for every state transition and every escalation boundary
- [ ] The switch matrix (`ALERT_STATE_ENABLED`, `ALERT_LEGACY_PUSH`) is tested for `pipeline-health` and `budget-check`
- [ ] A state-store error is tested to send, never to suppress
- [ ] `scheduler-slots.test.ts` passes with the `ops-digest` cron
- [ ] The registry test compares `WORKER_QUEUES` with every `new Worker(` call
- [ ] workers coverage stays at or above lines 78 / functions 81; core-api stays at or above 80/80

### Phase 2 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing, including `pnpm test:integration`
- [ ] `docs/adr/ADR-0005-alert-state-model.md` status is `Accepted`
- [ ] `docs/runbooks/alert-escalation.md` and `docs/skill-inventory.md` updated
- [ ] Scheduler slot registry in `CLAUDE.md` lists `30 7` ops-digest
- [ ] CLAUDE.md and memory updated with any non-trivial learning
- [ ] No regression: with `ALERT_STATE_ENABLED=false` every migrated sender pushes as at `f341ca6`
- [ ] Deploy and the running-container check happen in item 5.5 (grep a marker of this phase's diff in `open-brain-workers`)

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests | `pnpm -r test` | Exit code 0 (coverage thresholds for core-api and workers enforced) |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Integration | `pnpm test:integration` | Exit code 0 |
| Alert state logic | `pnpm --filter @open-brain/workers exec vitest run src/__tests__/alert-state.test.ts src/__tests__/pipeline-health.test.ts src/__tests__/budget-check.test.ts src/__tests__/ops-digest.test.ts` | Exit code 0 |
| Scheduler slots | `pnpm --filter @open-brain/workers exec vitest run src/__tests__/scheduler-slots.test.ts src/__tests__/scheduler-register.test.ts` | Exit code 0 |
| Shared helpers | `pnpm --filter @open-brain/shared test` | Exit code 0 |
| Queue registry | `pnpm --filter @open-brain/workers exec vitest run src/__tests__/queue-names.test.ts` | Exit code 0 |
| Shell guards | `bash scripts/test-secrets-roundtrip.sh && bash scripts/test-backup-secrets-redaction.sh && bash scripts/test-pushover-encoding.sh` | Exit code 0 |

<!-- END DOD -->

---

## Phase 3: Pipeline, source, and tier watchers

**Estimated Complexity:** L (~32 files, ~1,650 LOC)
**Dependencies:** Phase 2
**Execution Mode:** Sequential

### Goals

- Count queue failures over a rolling 24 hours and alert on captures stuck without an embedding, so the `pipeline-health` alert can clear.
- Make the operator-action reminder correct, short, and daily.
- Record a last-success heartbeat per source and alert when a source goes stale.
- Make the gas, Actual, and email runs report their own failures.
- Make the secret-age check able to run.

### Work Items

#### 3.1 `pipeline-health` that can return to green ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** PE-013, SA7-11, PE-012 (stuck-capture alert)
**Depends On:** 2.2, 2.6 (cross-phase; Phase 2)
**Files Affected:**
- `packages/workers/src/skills/pipeline-health.ts` (modify)
- `packages/workers/src/skills/pipeline-health-query.ts` (modify)
- `packages/workers/src/__tests__/pipeline-health.test.ts` (modify)
- `config/prometheus/alerts/pipeline.yml` (modify)
- `docs/runbooks/pipeline-alert.md` (modify)
- `docs/SLO.md` (modify)
- `LAB_NOTEBOOK.md` (modify)

**Description:**
`pipeline-health` compares the lifetime BullMQ `failed` count (`getJobCounts`) with a threshold of 5, so once 5 jobs have ever failed the alert is true on every run. Nothing measures captures stuck without an embedding. This item counts failures finished in the last 24 hours, adds the critical alert `embed-stall`, and pushes gauges for stuck captures and the 7-day pipeline success share. The Prometheus rule `QueueFailedJobsHigh` reads the new 24-hour gauge.

**Tasks:**
1. [ ] Add the Phase 3 entry to `LAB_NOTEBOOK.md` (objective, hypothesis, rollback) before the first commit.
2. [ ] Extend `QueueHandle` with a 24-hour failed count: `ZCOUNT bull:<queue>:failed <now − 24 h in ms> +inf`. The failed set is scored by `finishedOn`; confirm the score against a real Redis in `src/__tests__/integration`. Update the mock queue factories.
3. [ ] The `pipeline-queues` condition becomes `failed24h >= threshold` per queue. The alert clears when every queue is below the threshold.
4. [ ] `pipeline-health-query.ts`: add `queryEmbedStall(db)` (live captures with `embedding IS NULL` older than 2 hours, plus the newest embedding time), `queryStuckCaptures(db)` (captures at a `SWEEPABLE_STATUSES` value older than 24 hours with `deleted_at IS NULL`), and `queryPipelineSuccessShare(db, 7)`.
5. [ ] `pipeline-health.ts`: call `raiseAlert` with key `embed-stall`, severity `critical`, `bad` when the stalled count is above 0. Add `embedStalled` and `stuckCaptures` to the result and the output summary.
6. [ ] Push the gauges `openbrain_queue_failed_24h{queue}`, `openbrain_captures_stuck`, `openbrain_captures_unembedded`, and `openbrain_pipeline_success_share_7d`. Keep the existing `openbrain_queue_*` gauges.
7. [ ] `config/prometheus/alerts/pipeline.yml`: `QueueFailedJobsHigh` reads `openbrain_queue_failed_24h{job="open-brain"} > 5`. Run `bash scripts/validate-alert-rules.sh`.
8. [ ] Tests: 354 old failures and 0 in 24 hours → no alert; 5 failures in 24 hours → alert, then "resolved" on the next clear run; an unembedded capture 3 hours old → `embed-stall` fires once. Update `docs/runbooks/pipeline-alert.md` and the pipeline success row of `docs/SLO.md`.

**Acceptance Criteria:**
- [ ] WHEN a queue holds 354 failed jobs that all finished more than 24 hours ago THEN `pipeline-health` SHALL report that queue as healthy
- [ ] WHEN 5 jobs fail in one queue within 24 hours THEN `pipeline-health` SHALL raise `pipeline-queues`
- [ ] WHEN the 24-hour failed count of every queue drops below 5 THEN `pipeline-health` SHALL send "resolved" for `pipeline-queues`
- [ ] WHEN a live capture has had no embedding for more than 2 hours THEN `pipeline-health` SHALL raise the critical alert `embed-stall` once
- [ ] WHEN the backup manifest is stale THEN the `backup-stale` alert SHALL fire through its own key and its own call, independent of the queue alert
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/pipeline-health.test.ts` exits 0
- [ ] `bash scripts/validate-alert-rules.sh` exits 0
- [ ] `pnpm --filter @open-brain/workers test:integration` exits 0 (after `docker compose -f docker-compose.test.yml up -d --wait`)

**Notes:**
Item 1.2 is complete on the host before this item deploys; otherwise `embed-stall` fires at once, correctly. Part 2 item 9.3 (job retention) depends on this item: the stuck-capture gauge and the `embed-stall` alert must be live before failed jobs are pruned, or the pruning hides an embed outage. Do not add `removeOnFail` or `removeOnComplete` to the flow children here; job retention also follows the re-drive fix of Part 2 (Phase 9), because completed enrichment-child job IDs are today the only guard against duplicate enrichment. The stuck-capture query imports `SWEEPABLE_STATUSES` from `workers/src/lib/sweepable-statuses.ts`; never inline status strings. The changed rule file reaches Prometheus through the manual root copy in item 5.5; layer 4 of the drift check (item 4.1) reports the gap until then.

---

#### 3.2 Operator-action reminder: one tolerant parser, enforced vocabulary ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** SA7-10, PLT-020, RC7-02 (parser)
**Depends On:** 3.1 (cross-phase: 2.4)
**Files Affected:**
- `packages/shared/src/lib/operator-actions.ts` (create)
- `packages/shared/src/lib/__tests__/operator-actions.test.ts` (create)
- `packages/shared/src/lib/index.ts` (modify)
- `packages/workers/src/skills/ops-digest.ts` (modify — created in item 2.4)
- `packages/workers/src/__tests__/ops-digest.test.ts` (modify — created in item 2.4)
- `.github/workflows/monthly-audit.yml` (modify)
- `OPERATOR_ACTIONS.md` (modify)

**Description:**
Two hand-written parsers (`secret-rotation.ts:286-289` and the awk block in `monthly-audit.yml`) treat a row as open unless its status starts with the literal `DONE` or `BLOCKED`. Replayed against `main`, 24 rows read as overdue, including finished rows. One shared parser replaces the awk block here and the `secret-rotation` parser in item 3.6, a test enforces the status vocabulary on the real register, and the daily digest calls the parser on every run and prints one line: the count of overdue rows and the 3 oldest IDs.

**Tasks:**
1. [ ] Create `packages/shared/src/lib/operator-actions.ts`. `parseOperatorActions(markdown)` reads the `## Open Actions` table, strips `*`, the check-mark character (U+2705), and whitespace from the status cell, then matches `^(DONE|BLOCKED|OBSOLETE|CLOSED)` as closed and `^(OPEN|IN PROGRESS)` as open. Any other status is returned in `parseErrors`. `summarizeOperatorActions(actions, now)` returns `{ open, overdue, oldest, parseErrors }` with the 3 oldest overdue rows. `loadOperatorActions({ url, fallbackPath })` reads the register from `https://raw.githubusercontent.com/davistroy/open-brain/main/OPERATOR_ACTIONS.md` with a 10 s timeout and falls back to the mounted file. Export the module from `lib/index.ts`.
2. [ ] `operator-actions.test.ts`: one case per status form, the fallback path of `loadOperatorActions`, and one test that reads the real `OPERATOR_ACTIONS.md` and fails on an unknown status or on an open row whose due cell is not a `YYYY-MM-DD` date.
3. [ ] Reconcile `OPERATOR_ACTIONS.md` by hand until the test passes: rewrite each status to the vocabulary and keep the detail after the keyword, give OA-10 a date, update the "Status values" header line and "Last reconciled", and set the OA-25 row from item 2.5.
4. [ ] `ops-digest.ts`: on every run call `loadOperatorActions`, `parseOperatorActions`, and `summarizeOperatorActions`. When a row is overdue, print one line: `ops: M overdue; oldest: <3 IDs>`, plus the parse-error count when above 0. A failed load prints `ops: register unreadable` and never blocks the digest.
5. [ ] `monthly-audit.yml`: replace the awk block with a node step that builds `@open-brain/shared` and calls the shared parser. A parse error fails the step.
6. [ ] `ops-digest.test.ts`: 12 overdue rows → one line with the count and the 3 oldest IDs; no overdue row → no operator-action line; a failed fetch → the mounted register is read; both sources fail → `ops: register unreadable`.

**Acceptance Criteria:**
- [ ] WHEN a row's status is `**DONE 2026-07-14**`, `DONE` behind a check-mark character, `OBSOLETE`, or `CLOSED` THEN the parser SHALL treat the row as closed
- [ ] WHEN a row's status is outside the vocabulary THEN the parser SHALL return a parse error and the test over `OPERATOR_ACTIONS.md` SHALL fail
- [ ] WHEN `ops-digest` runs on any day with 12 overdue rows THEN the digest SHALL hold one operator-action line with the count 12 and the 3 oldest row IDs
- [ ] WHEN no row is overdue THEN the digest SHALL print no operator-action line
- [ ] WHEN the fetch from `raw.githubusercontent.com` fails THEN the digest SHALL read the mounted register
- [ ] `pnpm --filter @open-brain/shared exec vitest run operator-actions` exits 0
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/ops-digest.test.ts` exits 0

**Notes:**
The digest prints the operator-action line on every run, so an overdue row is reported each day until the row is closed. The digest reads the register from `main` because the host bind mounts a copy that is only as new as the last `workers` recreate. The line does not depend on `bws`. Every later edit of `OPERATOR_ACTIONS.md` uses the enforced vocabulary: `OPEN`, `IN PROGRESS`, `DONE YYYY-MM-DD`, `BLOCKED (reason)`, `OBSOLETE`, `CLOSED`. Item 3.6 deletes the local parser and the monthly operator-action push from `secret-rotation.ts`, which keeps this item at 7 files. The Phase 3 notebook entry is task 1 of item 3.1.

---

#### 3.3 Per-source heartbeats: store, internal route, reader ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** INT-001, QA-012 (canary), SA7-07
**Depends On:** 3.2
**Files Affected:**
- `packages/workers/src/lib/heartbeat.ts` (create)
- `packages/core-api/src/routes/heartbeat.ts` (create)
- `packages/core-api/src/app.ts` (modify)
- `packages/workers/src/skills/pipeline-health-query.ts` (modify)
- `packages/workers/src/skills/pipeline-health.ts` (modify)
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/workers/src/__tests__/source-freshness.test.ts` (create)
- `packages/core-api/src/__tests__/heartbeat-routes.test.ts` (create)

**Description:**
One global check counts captures from all sources over 6 hours, and every sidecar posts `source: 'api'`, so one source can go silent for months. Each source now records `{ last_attempt_at, last_success_at, ok, errors, meta }` in `app_settings` key `heartbeat:<source>`. Skills in `workers` write through `lib/heartbeat.ts`; host-cron sidecars write through a new core-api route. `pipeline-health` reads the records and raises one alert per stale source.

**Tasks:**
1. [ ] Create `workers/src/lib/heartbeat.ts`: `recordHeartbeat(db, source, { ok, errors, meta })` (an upsert that keeps `last_success_at` when `ok` is false and stores at most 5 error strings), `readHeartbeats(db)`, and `ensureHeartbeatBaseline(db, sources, now)`, which writes a baseline record dated `now` for an expected source that has no record.
2. [ ] Create core-api `routes/heartbeat.ts` with `registerHeartbeatRoutes(app, db)`: `POST /api/v1/internal/heartbeat/:source` writes the same JSON shape. The route accepts the source names `gas` and `actual` (400 otherwise) and the callers `utility-pipeline` and `actual-pipeline` (403 otherwise). Register the route in `app.ts`.
3. [ ] `pipeline-health-query.ts`: add `querySourceFreshness(db, now)` with these thresholds — `gas`: older than 48 h, or `ok=false`, or `meta.latest_bill_date` older than 40 d; `actual`: older than 36 h or `ok=false`; `email:gmail` and `email:hotmail`: `ok=false`, or older than 36 h; `secret-rotation`: `ok=false` or older than 35 d; `memory-consolidation`: `ok=false` or older than 8 d.
4. [ ] `querySourceFreshness` also reports the newest capture per `source` value for `voice`, `slack`, and `email`; an age over 7 d is listed in the output summary and raises no alert.
5. [ ] `pipeline-health.ts`: call `ensureHeartbeatBaseline`, then `querySourceFreshness`; call `raiseAlert` once per source with key `source-stale:<source>` and severity `warning`; push the gauge `openbrain_source_last_success_seconds{source}`; add `staleSources` to the output summary.
6. [ ] `skill-execution.ts`: after `MemoryConsolidationSkill` returns a result that is not gated, call `recordHeartbeat(db, 'memory-consolidation', { ok: result.totalErrors === 0, errors })`.
7. [ ] Tests: a stale heartbeat produces exactly one push, none on the next run, and "resolved" after a fresh heartbeat; a missing record gets a baseline and no alert; route tests for 200, 400, 403, and the stored shape.

**Acceptance Criteria:**
- [ ] WHEN the `gas` heartbeat is 49 hours old THEN `pipeline-health` SHALL raise `source-stale:gas` once and SHALL send nothing for `gas` on the next run
- [ ] WHEN a `gas` heartbeat with `ok: true` arrives THEN `pipeline-health` SHALL send "resolved" for `source-stale:gas`
- [ ] WHEN `POST /api/v1/internal/heartbeat/gas` arrives with caller `utility-pipeline` THEN core-api SHALL upsert `heartbeat:gas` and return 200
- [ ] WHEN the route receives an unknown source or another caller THEN core-api SHALL return 400 or 403 and write nothing
- [ ] WHEN an expected source has no heartbeat record THEN `pipeline-health` SHALL write a baseline record dated now and raise no alert on that run
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/source-freshness.test.ts` exits 0
- [ ] `pnpm --filter @open-brain/core-api exec vitest run src/__tests__/heartbeat-routes.test.ts` exits 0
- [ ] `grep -c 'heartbeat' packages/core-api/src/routes/settings.ts` prints 0

**Notes:**
The `heartbeat:*` keys are written through the database layer and are not added to the settings API whitelists. The route reuses two existing bypass callers, so `rate-limit.ts` does not change. `web-next/proxy.ts` overwrites `X-Open-Brain-Caller` to `web-next-public`, so a public request receives 403. The baseline record makes each threshold count from the first run after deploy: a writer that never ships turns stale instead of staying unseen. The backup-stale path stays independent; quiet hours apply to the capture-flow check only. The dispatcher writes the `memory-consolidation` heartbeat so that `memory-consolidation.ts` stays untouched until Part 2 (Phase 11) fixes its SQL as one change. Writers: gas in item 3.4, Actual and email in item 3.5, `secret-rotation` in item 3.6.

---

#### 3.4 Gas pipeline reports its failures ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** SE7-07, INT-001
**Depends On:** 3.3
**Files Affected:**
- `scripts/utility-pipeline.py` (modify)
- `scripts/lib/capture_api.py` (modify)
- `docker/ingest-sidecar/tests/test_utility_status.py` (modify)

**Description:**
`utility-pipeline.py` exits 0 unless an exception escapes: the exit code ignores `_JSON_ERRORS`, ten gas failure paths (`:382-444`, `:521-568`) log and return without recording an error, and post failures are recorded only with `--json-output` (`:73-77`). A bill row stored with NULL therms blocks a re-fetch of that bill (`:604-643`). The run now exits 1 on any recorded error, records every gas failure, re-fetches a row whose therms parse failed, and posts a `gas` heartbeat.

**Tasks:**
1. [ ] `main()`: set `exit_code = 1` when `_JSON_ERRORS` is non-empty, in every mode.
2. [ ] Append a message to `_JSON_ERRORS` at each of the 10 gas failure returns (`:382-444` and `:521-568`).
3. [ ] Record a `post_capture` failure in every mode, not only with `--json-output`.
4. [ ] Skip check: count a stored bill row as present only when `therms IS NOT NULL`, and write the row with `ON CONFLICT(date) DO UPDATE`.
5. [ ] `scripts/lib/capture_api.py`: add `post_heartbeat(cfg, source, ok, errors, meta, caller)`. The function derives the API base from the capture URL and posts to `/api/v1/internal/heartbeat/<source>` with the `X-Open-Brain-Caller` header. A failed post logs and returns `False`.
6. [ ] `main()`: after a `--gas` run call `post_heartbeat` for source `gas` with `ok` equal to "no error recorded", the first 5 errors, and `meta.latest_bill_date`. A failed heartbeat post records an error.
7. [ ] `test_utility_status.py`: a failing fetch makes `--gas` exit 1 without `--json-output`; each failure return records an error; a NULL-therms row is fetched again; the heartbeat payload carries `ok=false` and the errors.

**Acceptance Criteria:**
- [ ] WHEN `--gas` runs against an unreachable `api_url` THEN the process SHALL exit 1 and `_JSON_ERRORS` SHALL hold the failure
- [ ] WHEN a gas bill row exists with NULL therms THEN the next `--gas` run SHALL fetch and parse that bill again
- [ ] WHEN a `--gas` run ends THEN the pipeline SHALL post a `gas` heartbeat whose `ok` is true only when no error was recorded
- [ ] WHEN `get_bws_secret()` misses a key THEN the process SHALL exit 1 through `sys.exit(1)`, unchanged
- [ ] `UTILITY_CONFIG_DIR=<scratch directory with a bad api_url> python3 scripts/utility-pipeline.py --gas; echo $?` prints 1
- [ ] `python3 -m pytest docker/ingest-sidecar/tests/ -v --tb=short` exits 0
- [ ] `ruff check . && ruff format --check . && pyright` exits 0

**Notes:**
The trigger server maps the return code to a status (`trigger_server.py:376`), so a non-zero exit now reports `error` there. Item 1.4 removed `--power-summary` from the cron line; with the flag present every run would exit 1. `scripts/lib/gas_bill_parse.py` is unchanged. `financial-ingest` and `utility-ingest` share the image `ingest-sidecar`; item 5.5 recreates both together. The heartbeat `meta` holds a bill date only, no account identifier and no amount.

---

#### 3.5 Actual and email runs report their failures ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** SE7-17, SE7-08, INT-010, DA7-11 (alert part)
**Depends On:** 3.3
**Files Affected:**
- `scripts/actual/actual-daily.mjs` (modify)
- `scripts/actual/lib/heartbeat.mjs` (create)
- `scripts/actual/test/heartbeat.test.mjs` (create)
- `packages/workers/src/skills/email-classify.ts` (modify)
- `packages/shared/src/services/email/hotmail-client.ts` (modify)
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/workers/src/__tests__/email-classify.test.ts` (modify)
- `packages/shared/src/services/email/__tests__/hotmail-client.test.ts` (modify)

**Description:**
`actual-daily.mjs:152-155` logs a fatal error and exits 1 with no push; the only Pushover sits on the success path. `email-classify.ts:147-152` swallows a provider error and pushes only when at least one email was classified, so an expired OAuth token reads as a clean run. `hotmail-client.ts:155-176` starts an interactive device-code prompt inside a headless worker. Both runs now write heartbeats, an authentication failure raises an alert, and the email job fails when every configured provider fails.

**Tasks:**
1. [ ] Create `scripts/actual/lib/heartbeat.mjs`. `postHeartbeat({ coreApiUrl, ok, errors, meta })` posts to `/api/v1/internal/heartbeat/actual` with caller `actual-pipeline` and a 10 s timeout. `reportOutcome({ ok, error, postHeartbeat, sendPushover })` posts the heartbeat; when the post fails and `ok` is false, `reportOutcome` sends one priority-1 Pushover.
2. [ ] `actual-daily.mjs`: call `reportOutcome({ ok: true })` after `runDaily` returns; in `main().catch` call `reportOutcome({ ok: false, error })` before `process.exit(1)`. Give `sendPushover` a priority argument.
3. [ ] `heartbeat.test.mjs` (vitest): success posts `ok: true`; a fatal error posts `ok: false` with the message; a failed post on the fatal path sends one priority-1 Pushover; a failed post on the success path sends none.
4. [ ] `email-classify.ts`: record `authFailed` per provider; write the heartbeats `email:gmail` and `email:hotmail` through `recordHeartbeat`; call `raiseAlert` with key `source-stale:email:<provider>` and severity `warning` when a configured provider fails authentication; throw when every configured provider fails; add `authFailed:<provider>` to the output summary.
5. [ ] `hotmail-client.ts`: add `allowInteractive` to `HotmailClientOptions`, default `false`. Without the option a failed silent refresh throws an authentication error and does not start the device-code flow. Raise the silent-refresh failure log from debug to warn.
6. [ ] `skill-execution.ts`: construct `HotmailClient` with `allowInteractive: input?.interactiveAuth === true`.
7. [ ] Tests: both providers fail → the skill rejects; one provider fails → the run completes, the alert fires once, and that provider's heartbeat has `ok: false`; no mail → `ok: true` and no alert; a scheduled run never calls `acquireTokenByDeviceCode`.

**Acceptance Criteria:**
- [ ] WHEN `actual-daily.mjs` fails THEN the run SHALL post heartbeat `actual` with `ok: false` and the error message, and exit 1
- [ ] WHEN the heartbeat post fails on the fatal path THEN the run SHALL send one priority-1 Pushover directly
- [ ] WHEN every configured email provider fails THEN `email-classify` SHALL throw, so the BullMQ job fails
- [ ] WHEN one configured provider fails authentication THEN `email-classify` SHALL write that provider's heartbeat with `ok: false` and raise `source-stale:email:<provider>` once
- [ ] WHEN a scheduled run cannot refresh the Hotmail token silently THEN `HotmailClient` SHALL throw an authentication error and SHALL NOT start the device-code flow
- [ ] WHEN a run finds no new mail THEN `email-classify` SHALL write heartbeats with `ok: true` and raise no alert
- [ ] `npm --prefix scripts/actual test` exits 0
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/email-classify.test.ts` exits 0
- [ ] `pnpm --filter @open-brain/shared test` exits 0

**Notes:**
`scripts/actual` runs vitest (`"test": "vitest run"`); the investigation record names `node --test`, which this package does not use. The skill and the reader of item 3.3 share the key `source-stale:email:<provider>`, so one condition produces one alert. The investigation record asks for priority 1 on an email authentication failure; ADR-0005 classes a failed source as a warning (priority 0, listed in the digest every day until resolved), and this item follows the ADR. A 409 from the capture post stays a success (`run-daily.mjs:128-131`). The Actual heartbeat carries counts and an error string only: no balance, payee, or account name. Gmail and Hotmail classify today (L7); a manual trigger with `input.interactiveAuth: true` keeps the device-code flow for re-consent. `scripts/actual/lib/**` is copied into the `actual-ingest` image.

---

#### 3.6 Secret-age check that can run ✅ Completed 2026-11-23
**Status: COMPLETE 2026-11-23**
**Model Tier: sonnet**
**Requirement Refs:** SEC-008 (functional part), SA7-07, PLT-026, SA7-10 (local parser removal)
**Depends On:** 3.2, 3.3
**Files Affected:**
- `Dockerfile` (modify)
- `packages/workers/src/skills/secret-rotation.ts` (modify)
- `packages/workers/src/__tests__/secret-rotation.test.ts` (modify)

**Description:**
The `workers` image has no `bws` binary. The October and November runs of `secret-rotation` logged `spawn bws ENOENT`, checked 0 secrets, and raised nothing (`secret-rotation.ts:182-203`). The workers stage is `node:22-alpine` (musl), so the glibc install recipe of the ingest sidecar does not run there. This item installs a pinned `bws` that runs on Alpine, makes a failed check raise an alert and write a heartbeat, and deletes the skill's own operator-action pass, which the daily digest replaces.

**Tasks:**
1. [ ] Read the release assets of `bws` 1.0.0 (the version pinned in `docker/ingest-sidecar/Dockerfile`). A musl asset exists → install the musl asset. No musl asset → `apk add --no-cache gcompat` and install the gnu asset. Check the download against a sha256 pinned in the `Dockerfile`.
2. [ ] Prove the binary runs before any other change: `docker build --target workers -t obw:verify . && docker run --rm --entrypoint bws obw:verify --version`.
3. [ ] `secret-rotation.ts`: delete the local operator-action parser, `checkOperatorActions`, and `sendOperatorActionAlert`. The daily digest of item 3.2 carries the operator-action line.
4. [ ] `secret-rotation.ts`: when `querySecrets` throws, call `raiseAlert` with key `secret-check-unavailable` and severity `warning`, write heartbeat `secret-rotation` with `ok: false`, and keep the error in the result. On success write the heartbeat with `ok: true` and `meta.totalSecrets`.
5. [ ] Send the stale-secret report through `sendInfo`. The output summary carries the count and the 5 oldest secret names. The first run flags most secrets, so the summary stays under 300 characters.
6. [ ] Tests: `bws` missing → the warning fires once and the heartbeat has `ok: false`; success → heartbeat `ok: true`; 40 stale secrets → a summary under 300 characters; the tests of the removed operator-action pass are deleted.

**Acceptance Criteria:**
- [ ] WHEN the workers image is built THEN `docker run --rm --entrypoint bws obw:verify --version` SHALL print the pinned version
- [ ] WHEN `bws secret list` fails THEN `secret-rotation` SHALL raise `secret-check-unavailable` once and write heartbeat `secret-rotation` with `ok: false`
- [ ] WHEN `bws secret list` succeeds THEN the result SHALL report `totalSecrets` above 0 and the heartbeat SHALL have `ok: true`
- [ ] WHEN `secret-rotation` runs THEN the skill SHALL read no operator-action register and SHALL send no operator-action push
- [ ] `docker build --target workers -t obw:verify . && docker run --rm --entrypoint bws obw:verify --version` exits 0
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/secret-rotation.test.ts` exits 0

**Notes:**
Unknown U3 (whether a musl build of `bws` 1.0.0 exists) is answered by task 2; the image build is the proof, before merge. `BWS_ACCESS_TOKEN` reaches the container through `env_file: .env.secrets`; item 5.5 confirms the variable on the host and triggers the skill once. The skill parses names and dates from `bws secret list` and never prints a value. The reader thresholds for `secret-rotation` are in item 3.3, which also supplies `recordHeartbeat`. The operator-action pass leaves this skill because the digest of item 3.2 reports overdue rows every day.

---

### Phase 3 Testing Requirements

- [ ] The 24-hour failed count is confirmed against a real Redis in the workers integration suite
- [ ] The `embed-stall` alert is tested to fire once for an unembedded capture older than 2 hours
- [ ] The operator-action parser test runs over the real `OPERATOR_ACTIONS.md`
- [ ] The digest is tested to print the operator-action line on every run that has an overdue row
- [ ] Source freshness is tested for stale, fresh, missing, and recovered heartbeats, with exactly one push per transition
- [ ] The heartbeat route is tested for 200, 400, and 403
- [ ] The gas pipeline is tested to exit 1 on each recorded error path
- [ ] The Actual fatal path and the email all-providers-fail path are tested
- [ ] `docker build --target workers` proves `bws --version` runs on Alpine
- [ ] workers coverage stays at or above lines 78 / functions 81; core-api stays at or above 80/80

### Phase 3 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing, including `pnpm test:integration` and the Python suite
- [ ] `OPERATOR_ACTIONS.md` uses the enforced vocabulary in every row
- [ ] `docs/runbooks/pipeline-alert.md` and `docs/SLO.md` updated
- [ ] CLAUDE.md and memory updated with any non-trivial learning (the operator-action reminder now lives in the daily digest; the `heartbeat:<source>` rule for new sources; `bws` on Alpine)
- [ ] No regression: with `ALERT_STATE_ENABLED=false` every migrated sender pushes as at `f341ca6`
- [ ] Deploy and the running-container check happen in item 5.5 (grep a marker of this phase's diff in `open-brain-workers`, `open-brain-core-api`, and `open-brain-utility-ingest`)

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests | `pnpm -r test` | Exit code 0 (coverage thresholds for core-api and workers enforced) |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Python lint and types | `ruff check . && ruff format --check . && pyright` | Exit code 0 |
| Integration | `pnpm test:integration` | Exit code 0 |
| Pipeline health | `pnpm --filter @open-brain/workers exec vitest run src/__tests__/pipeline-health.test.ts` | Exit code 0 |
| Alert rules | `bash scripts/validate-alert-rules.sh` | Exit code 0 |
| Operator-action parser | `pnpm --filter @open-brain/shared exec vitest run operator-actions` | Exit code 0 |
| Sidecar tests | `python3 -m pytest docker/ingest-sidecar/tests/ -v --tb=short` | Exit code 0 |
| Actual sidecar tests | `npm --prefix scripts/actual test` | Exit code 0 |
| Watchers | `pnpm --filter @open-brain/workers exec vitest run src/__tests__/ops-digest.test.ts src/__tests__/source-freshness.test.ts src/__tests__/email-classify.test.ts src/__tests__/secret-rotation.test.ts` | Exit code 0 |
| `bws` in the workers image | `docker build --target workers -t obw:verify . && docker run --rm --entrypoint bws obw:verify --version` | Exit code 0 |

<!-- END DOD -->

---

## Phase 4: Deploy foundation: compose, probes, and drift

**Estimated Complexity:** M (~20 files, ~950 LOC)
**Dependencies:** Phase 2 (item 2.2) for item 4.5 only; items 4.1–4.4 have none
**Execution Mode:** Sequential

### Goals

- Make the daily drift check run as root and compare four layers.
- Make the backup mount follow the newest backup without a container restart.
- Put the database volume pin into the tracked compose file.
- Make a missing host path or a missing host value fail at start.
- Probe every local LLM tier, Postgres, and Redis, and give the sidecars healthchecks.

### Work Items

#### 4.1 Drift check that runs as root and covers four layers ✅ Completed 2026-11-24
**Status: COMPLETE 2026-11-24**
**Model Tier: sonnet**
**Requirement Refs:** SA7-09, PLT-022, PLT-006, PLT-013, OA-27
**Files Affected:**
- `scripts/check-deploy-parity.sh` (modify)
- `scripts/check-deploy-parity-cron.sh` (modify)
- `scripts/check-alerts-parity.sh` (modify)
- `deploy/cron/unraid-parity-check.cron` (modify)
- `deploy/host-only-allowlist.txt` (create)
- `scripts/test-check-deploy-parity.sh` (create)
- `.github/workflows/ci.yml` (modify)
- `LAB_NOTEBOOK.md` (modify)

**Description:**
The parity cron runs as root in a tree owned by `claude`. Git refuses with "dubious ownership", and `check-deploy-parity.sh:67` reports the refusal as "not inside a git repo", so the cron has produced no result. The check also compares the text of one file only. This item wraps git with `-c safe.directory`, makes a failed fetch exit 2, and adds three layers: the config hash per service, the working tree against an allowlist, and the alert rules. The cron wrapper notifies on a changed result, then weekly.

**Tasks:**
1. [ ] Add the Phase 4 entry to `LAB_NOTEBOOK.md` (objective, hypothesis, rollback) before the first commit.
2. [ ] `check-deploy-parity.sh`: add `REPO_DIR="${PARITY_REPO_DIR:-$SCRIPT_DIR/..}"` and the wrapper `g() { git -C "$REPO_DIR" -c safe.directory="$REPO_DIR" "$@"; }`. Use `g` for `rev-parse`, `fetch`, `show`, and `log`. Print git's stderr on failure. A failed fetch exits 2.
3. [ ] Layer 2, config hash: for each service of `docker compose config --services`, compare `docker compose config --hash <service>` with the container label `com.docker.compose.config-hash` and print `STALE <service>` on a difference. Assert that `open-brain-financial-ingest` and `open-brain-utility-ingest` run the same image ID.
4. [ ] Layer 3, working tree: `g diff --stat origin/main -- config scripts packages/shared/drizzle` and `g status --porcelain`, minus the paths in `deploy/host-only-allowlist.txt`. Create the allowlist: `docker-compose.override.yml`, `.env`, `.env.secrets`, `.env.secrets.sha256`, `config/payee-rules.yaml`, `config/utility/utility-config.yaml`, `DEPLOYED.json`.
5. [ ] Layer 4, alert rules: give `check-alerts-parity.sh` a local mode that reads each rule file from `git show origin/main:config/prometheus/alerts/<file>` and compares the rule body with the deployed directory.
6. [ ] `PARITY_LAYERS` (default `file,hash,tree,alerts`) selects the layers. The output holds hashes, service names, and paths, and never rendered config. Rewrite the fix text at the end of the script: no `-f` flag for a stateful recreate, `scripts/deploy.sh` for application services.
7. [ ] `check-deploy-parity-cron.sh`: write a fingerprint of the result (the exit code plus the sorted finding lines) to a state file beside the log. Notify when the fingerprint changes, and again when 7 days have passed since the last notification. Exit code 2 follows the same rule.
8. [ ] `deploy/cron/unraid-parity-check.cron`: remove the separate `git fetch origin --quiet 2>/dev/null` from the cron line.
9. [ ] Create `scripts/test-check-deploy-parity.sh`: a run with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` exits 0 or 1; a failed fetch exits 2; with a stub notifier the wrapper sends once for an unchanged fingerprint, once more after a changed fingerprint, and once more after 7 days. Wire the harness into `build-and-test` in `ci.yml`.

**Acceptance Criteria:**
- [ ] WHEN the check runs as root in a tree owned by another user THEN `check-deploy-parity.sh` SHALL finish with exit code 0 or 1
- [ ] WHEN `git fetch` fails THEN the script SHALL print git's error and exit 2
- [ ] WHEN a container's `com.docker.compose.config-hash` label differs from the rendered hash THEN the script SHALL print `STALE <service>` and exit 1
- [ ] WHEN the result fingerprint equals the previous fingerprint and fewer than 7 days have passed THEN the cron wrapper SHALL send no notification
- [ ] WHEN the script runs THEN its output SHALL contain no rendered compose config
- [ ] `GIT_TEST_ASSUME_DIFFERENT_OWNER=1 PARITY_LAYERS=file PARITY_LOCAL_COMPOSE=docker-compose.yml bash scripts/check-deploy-parity.sh; test $? -ne 2` exits 0
- [ ] `bash scripts/test-check-deploy-parity.sh` exits 0
- [ ] Host check, run in item 5.5: `env -i HOME=/root PATH=/usr/bin:/bin:/usr/sbin bash -c 'cd /mnt/user/appdata/open-brain && PARITY_LOCAL_COMPOSE=$PWD/docker-compose.yml bash scripts/check-deploy-parity.sh'; echo $?` prints 0 or 1

**Notes:**
Host git is 2.51.1 and honours `-c safe.directory`; do not chown the tree. The script stays read-only, and exit code 2 is never a pass. `docker compose config` inlines `env_file` values, so the script prints hashes only (Host safety rule 4). A Compose plugin upgrade can change the hash algorithm and report every service as stale once. The OA-27 row says `DONE`, but the cron has produced no result; item 8.5 closes OA-27 after a clean run. The check reports drift every day until item 5.5; the fingerprint state reduces that to one notification per week. `/var/log` lives in RAM, so a reboot clears the state file and the next run notifies once. Item 7.3 fixes the install text of the cron template. Container names follow `open-brain-<service>`.

---

#### 4.2 Backup mount that follows the newest backup ✅ Completed 2026-11-24
**Status: COMPLETE 2026-11-24**
**Model Tier: sonnet**
**Requirement Refs:** SA7-02, PLT-015, DA7-02
**Depends On:** 4.1
**Files Affected:**
- `docker-compose.yml` (modify)
- `packages/workers/src/skills/pipeline-health.ts` (modify)
- `packages/workers/src/lib/backup-age.ts` (modify)
- `packages/workers/src/__tests__/pipeline-health.test.ts` (modify)
- `docs/runbooks/backup-alert.md` (modify)

**Description:**
`main`'s compose file mounts the symlink `/mnt/user/backup/openbrain/latest` into `workers` (`docker-compose.yml:254`). Docker resolves a symlink once, at container start, so the mount freezes on the backup of that day. The live host mounts the parent directory, which is why the backup alert works there. This item writes the live mount into the compose file and makes an unreadable manifest count as stale in production.

**Tasks:**
1. [ ] `docker-compose.yml`, service `workers`: replace the `latest` mount with a long-syntax bind of `/mnt/user/backup/openbrain` to the same absolute path, with `read_only: true` and `bind.create_host_path: false`. Set `BACKUP_LATEST_PATH: /mnt/user/backup/openbrain/latest/manifest.json` and `BACKUP_MANIFEST_REQUIRED: "true"`.
2. [ ] `pipeline-health.ts`, `checkBackupAge()`: when `BACKUP_MANIFEST_REQUIRED` is `true` and the manifest is unreadable, return `stale: true` with `ageSeconds: null`. The call site alerts on `stale` alone (today the call site also requires a non-null age) and uses the text "backup manifest unreadable".
3. [ ] `backup-age.ts`: correct the doc comment of `DEFAULT_BACKUP_MANIFEST_PATH`: the default serves local runs, and production sets `BACKUP_LATEST_PATH`.
4. [ ] Tests: required and missing → stale and alerted; not required and missing → not stale; a fresh manifest → not stale.
5. [ ] `docs/runbooks/backup-alert.md`: describe the mount, the two variables, and the "manifest unreadable" case.

**Acceptance Criteria:**
- [ ] WHEN `BACKUP_MANIFEST_REQUIRED=true` and the manifest is unreadable THEN `pipeline-health` SHALL report `backupStale: true` and raise the backup alert
- [ ] WHEN `BACKUP_MANIFEST_REQUIRED` is unset and the manifest is absent THEN `pipeline-health` SHALL report `backupStale: false`
- [ ] WHEN the 03:00 backup moves the `latest` symlink THEN the `workers` container SHALL read the new manifest without a restart (host check in item 5.5: the logged `backupAgeSeconds` is below 93,600 on the day after a backup)
- [ ] `touch .env.secrets && jq -e 'any(.services.workers.volumes[]; .source == "/mnt/user/backup/openbrain" and .read_only == true and .bind.create_host_path == false)' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` exits 0
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/pipeline-health.test.ts` exits 0

**Notes:**
The container path equals the host path so that the absolute symlink target resolves; `stat` follows the symlink on every call. The live `workers` container already has this mount and this `BACKUP_LATEST_PATH`, so the only new behaviour is `BACKUP_MANIFEST_REQUIRED`. Backups are root-owned since Entry 253 and `workers` runs as root. This item merges before any `workers` recreate from `main`'s compose file (item 5.5). The change in `checkBackupAge` works before and after item 2.2; when Phase 2 is in flight, land this item after item 2.2 and rebase.

---

#### 4.3 Track the database volume pin ✅ Completed 2026-11-24
**Status: COMPLETE 2026-11-24**
**Model Tier: opus**
**Requirement Refs:** PLT-001, DA7-05, SA7-04
**Depends On:** 4.2
**Files Affected:**
- `deploy/docker-compose.override.yml.template` (create)
- `docker-compose.yml` (modify)
- `.github/workflows/ci.yml` (modify)
- `.env.example` (modify)

**Description:**
`docker-compose.yml` declares named volumes for Postgres and Redis. The raw-bind pin lives only in the gitignored host file `docker-compose.override.yml`. On a rebuilt host a fresh `up` starts an empty database that passes its healthcheck. This item binds both data directories in the base compose file with `create_host_path: false`, tracks a template of the host override, and makes CI assert that both services render as binds.

**Tasks:**
1. [ ] `docker-compose.yml`: the Postgres data volume becomes a long-syntax bind with source `${OPENBRAIN_DATA_DIR:-/mnt/user/appdata/open-brain}/pgdata`, target `/var/lib/postgresql/data`, and `bind.create_host_path: false`. The Redis data volume becomes a long-syntax bind with source `${OPENBRAIN_DATA_DIR:-/mnt/user/appdata/open-brain}/redis-data`, target `/data`, and the same option. Remove `postgres_data` and `redis_data` from the top-level `volumes:` block.
2. [ ] Create `deploy/docker-compose.override.yml.template` with the two binds only, in long syntax with `create_host_path: false`. The header states when a host needs the override: a data path that `OPENBRAIN_DATA_DIR` cannot express.
3. [ ] `.env.example`: document `OPENBRAIN_DATA_DIR` with its default.
4. [ ] `ci.yml`, job `validate-compose-dr`: add a step that asserts both services render `type == "bind"` with `create_host_path == false` when no override file is present.
5. [ ] Add no `initdb.d` hook: with `restart: unless-stopped` a hook that refuses to initialize would still let the container come back and serve an empty database.

**Acceptance Criteria:**
- [ ] WHEN the base compose file renders with no override file THEN `postgres` and `redis` SHALL each render a bind mount for the data directory with `create_host_path` false
- [ ] WHEN the bind source directory is missing THEN Docker SHALL refuse to start the container and SHALL create no directory
- [ ] WHEN a pull request changes the Postgres or Redis data volume to a named volume THEN the job `validate-compose-dr` SHALL fail
- [ ] `touch .env.secrets && jq -e '.services.postgres.volumes[] | select(.target=="/var/lib/postgresql/data") | .type=="bind" and .bind.create_host_path==false' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` exits 0
- [ ] The same assertion with `.services.redis.volumes[] | select(.target=="/data")` exits 0

**Notes:**
The base change alters the rendered config of `postgres` and `redis`, so the drift check lists both services as stale until items 8.2 and 8.3. Nothing recreates either service before then; `scripts/deploy.sh` (item 5.2) refuses both. The host override uses short syntax, which replaces the base bind for the same target and turns `create_host_path` back on; items 8.2 and 8.3 remove the override entry before each recreate. Live sources: `/mnt/user/appdata/open-brain/pgdata` and `/mnt/user/appdata/open-brain/redis-data`. `OPENBRAIN_DATA_DIR` is a path with a default and no secret value, so the variable needs no `.env` entry (D145 covers secrets). `docker-compose.test.yml` is unchanged.

---

#### 4.4 Host bindings fail closed ✅ Completed 2026-11-24
**Status: COMPLETE 2026-11-24**
**Model Tier: sonnet**
**Requirement Refs:** SA7-17, PLT-014
**Depends On:** 4.3
**Files Affected:**
- `docker-compose.yml` (modify)
- `.github/workflows/ci.yml` (modify)
- `scripts/check-deploy-parity.sh` (modify)
- `.env.example` (modify)

**Description:**
A short-syntax bind creates a missing source as an empty directory, so a missing `OPERATOR_ACTIONS.md`, `model_aliases.json`, or inbox directory starts the service with an empty mount. `TAILSCALE_IP` falls back to a hard-coded address (`docker-compose.yml:162`). Every remaining host bind becomes long syntax with `create_host_path: false`, and `TAILSCALE_IP` becomes required.

**Tasks:**
1. [ ] `docker-compose.yml`: convert every remaining short-syntax host bind (a source that starts with `./` or `/`) to long syntax with `bind.create_host_path: false`: `./config` in 7 services, `./config/postgres/postgresql.conf`, `./config/cloudflare/tunnel.yaml`, `./OPERATOR_ACTIONS.md`, `./config/whisper/model_aliases.json`, and the two inbox directories. Named volumes stay unchanged.
2. [ ] Change the core-api Tailscale port line to `${TAILSCALE_IP:?set TAILSCALE_IP in .env}:3002:3000`.
3. [ ] `ci.yml`, job `validate-compose-dr`: set a dummy `TAILSCALE_IP` for the render steps; add a step that asserts the render fails with an empty `TAILSCALE_IP`; add a step that asserts every bind has `create_host_path == false`.
4. [ ] `scripts/check-deploy-parity.sh`: update `ALLOW_RE` for the new port line.
5. [ ] `.env.example`: document `TAILSCALE_IP` as required.

**Acceptance Criteria:**
- [ ] WHEN `TAILSCALE_IP` is empty THEN `docker compose config -q` SHALL fail with a message that names `TAILSCALE_IP`
- [ ] WHEN a bind source is missing on the host THEN Docker SHALL refuse to start the service
- [ ] `touch .env.secrets && ! TAILSCALE_IP= docker compose -f docker-compose.yml config -q` exits 0
- [ ] `touch .env.secrets && jq -e 'all(.services[].volumes[]?; .type != "bind" or .bind.create_host_path == false)' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` exits 0

**Notes:**
The host `.env` must define `TAILSCALE_IP` before the host adopts this compose file; item 5.5 sets the value first and backs up `.env` before the edit. A `:?` variable breaks every compose command on a host that lacks the value, which is the intended failure. `OPERATOR_ACTIONS.md` stays a file bind: a register edit on the host reaches the container after a recreate, and item 3.2 reads the register from `main` first. `TAILSCALE_IP` is an address with no secret value, so interpolation is safe. Line 622 of the compose file holds a static IP and is no bind.

---

#### 4.5 Probe every local tier and the data stores; healthchecks on the sidecars ✅ Completed 2026-11-24
**Status: COMPLETE 2026-11-24**
**Model Tier: sonnet**
**Requirement Refs:** L6, INT-011 (probe part), PLT-011
**Depends On:** 4.4 (cross-phase: 2.2)
**Files Affected:**
- `packages/workers/src/skills/container-health.ts` (modify)
- `packages/workers/src/jobs/skill-execution.ts` (modify)
- `packages/workers/src/__tests__/container-health.test.ts` (modify)
- `docker-compose.yml` (modify)
- `docs/runbooks/container-health-alert.md` (modify)

**Description:**
`DEFAULT_ENDPOINTS` in `container-health.ts:60-74` is a hand-kept list with a Jetson probe and no probe for Spark, Postgres, or Redis. Once three checks fail, the skill re-sends a priority-1 push every 15 minutes (`:164-171`). Three sidecars and `cloudflared` have no healthcheck. The LLM probes are now built from `model_tiers` in `config/ai-routing.yaml`, Postgres and Redis get probes, every probe alerts through `raiseAlert`, and the four services get healthchecks.

**Tasks:**
1. [ ] `container-health.ts`: build the LLM probes from `configService.get('ai').model_tiers`: every tier with `provider: openai_compat` and a `base_url`, probing the `base_url` with `/v1` replaced by `/health`. Probe name: the tier key `t1_<name>` becomes `<name>-llm` (`jetson-llm` keeps its name; `spark-llm` is new). Remove the hard-coded `jetson-llm` entry.
2. [ ] Add the probes `postgres` (`SELECT 1` through `db`) and `redis` (`PING`), with the same result shape as an HTTP probe.
3. [ ] Call `raiseAlert` per probe with key `container:<name>`, `bad` when the consecutive failure count reaches the threshold, severity `critical` for `postgres`, `redis`, and `core-api`, and `warning` for every other probe. The old `sendAlert` runs only when `legacyPushEnabled()` is true.
4. [ ] `skill-execution.ts`: pass `configService` and a Redis client to `ContainerHealthSkill`.
5. [ ] `docker-compose.yml`: add liveness healthchecks to `financial-ingest` and `utility-ingest` (`["CMD", "python", "-c", "import sys"]`), to `actual-ingest` (`["CMD", "node", "-e", "process.exit(0)"]`), and to `cloudflared` (`["CMD", "cloudflared", "tunnel", "--metrics", "127.0.0.1:2000", "ready"]`; the image has no shell). Keep `restart: unless-stopped` and add no autoheal label.
6. [ ] Tests: the probe list follows the config (a third `openai_compat` tier adds a probe); a tier down for 3 runs alerts once and not on run 4; recovery sends "resolved"; a `SELECT 1` failure raises `container:postgres` as critical.
7. [ ] Update `docs/runbooks/container-health-alert.md`: the probe list, the two classes, the `raiseAlert` behaviour.

**Acceptance Criteria:**
- [ ] WHEN `config/ai-routing.yaml` defines an `openai_compat` tier with a `base_url` THEN `container-health` SHALL probe that tier's `/health` URL
- [ ] WHEN the Spark probe fails on 3 consecutive runs THEN `container-health` SHALL raise `container:spark-llm` once and SHALL send nothing on the fourth failing run
- [ ] WHEN a failed probe recovers THEN `container-health` SHALL send "resolved" for that probe
- [ ] WHEN `SELECT 1` or Redis `PING` fails on 3 consecutive runs THEN `container-health` SHALL raise a critical alert for that store
- [ ] `touch .env.secrets && jq -e 'all(.services[]; .healthcheck != null)' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` exits 0
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/container-health.test.ts` exits 0

**Notes:**
Docker does not restart a container on an unhealthy check, so each healthcheck reports state and never restarts an idle cron-driven sidecar. The compose changes take effect per service at the next recreate: the sidecars in item 5.5, `cloudflared` in item 8.3. Jetson's `/health` needs no token; the 15-minute cadence stays. The Spark probe resolves to `http://spark.k4jda.net:8000/health`. Item 1.3 covers the Spark server; Part 2 (Phase 12) adds the circuit breaker. This item follows item 4.4 because items 4.2–4.4 also edit `docker-compose.yml`. Items 3.3 and 3.5 also edit `jobs/skill-execution.ts`; rebase when Phase 3 is in flight.

---

### Phase 4 Testing Requirements

- [ ] `scripts/test-check-deploy-parity.sh` covers the different-owner run, the failed fetch, and the notify-on-change state
- [ ] `validate-compose-dr` asserts the Postgres and Redis binds, the `create_host_path` option on every bind, and the required `TAILSCALE_IP`
- [ ] `pipeline-health.test.ts` covers the required-and-missing manifest
- [ ] The probe list is tested to follow `model_tiers`, and a failed probe is tested to alert once
- [ ] workers coverage stays at or above lines 78 / functions 81

### Phase 4 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] `docs/runbooks/backup-alert.md` and `docs/runbooks/container-health-alert.md` updated
- [ ] CLAUDE.md and memory updated with any non-trivial learning (the base compose file now binds the data directories; the parity check has four layers and a state file; the `TAILSCALE_IP` requirement; the probe list follows `model_tiers`)
- [ ] No regression: `docker compose config` renders the same 13 services, and with `ALERT_STATE_ENABLED=false` `container-health` pushes as at `f341ca6`
- [ ] Deploy and the running-container check happen in item 5.5

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests | `pnpm -r test` | Exit code 0 (coverage thresholds for core-api and workers enforced) |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Shell guards | `bash scripts/test-secrets-roundtrip.sh && bash scripts/test-backup-secrets-redaction.sh && bash scripts/test-pushover-encoding.sh` | Exit code 0 |
| Parity runs as another owner | `GIT_TEST_ASSUME_DIFFERENT_OWNER=1 PARITY_LAYERS=file PARITY_LOCAL_COMPOSE=docker-compose.yml bash scripts/check-deploy-parity.sh; test $? -ne 2` | Exit code 0 |
| Parity harness | `bash scripts/test-check-deploy-parity.sh` | Exit code 0 |
| Database renders as a bind | `touch .env.secrets && jq -e 'all((.services.postgres.volumes[], .services.redis.volumes[]); .type == "bind" and .bind.create_host_path == false)' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` | Exit code 0 |
| Every bind fails closed | `touch .env.secrets && jq -e 'all(.services[].volumes[]?; .type != "bind" or .bind.create_host_path == false)' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` | Exit code 0 |
| Host value required | `touch .env.secrets && ! TAILSCALE_IP= docker compose -f docker-compose.yml config -q` | Exit code 0 |
| Probes | `pnpm --filter @open-brain/workers exec vitest run src/__tests__/container-health.test.ts` | Exit code 0 |
| Compose healthchecks | `touch .env.secrets && jq -e 'all(.services[]; .healthcheck != null)' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` | Exit code 0 |

<!-- END DOD -->

---

## Phase 5: Deploy foundation: identity and first clean deploy

**Estimated Complexity:** L (~22 files, ~1,100 LOC; host session B)
**Dependencies:** Phases 2, 3, 4
**Execution Mode:** Sequential

### Goals

- Make every image and the compose project name their commit.
- Replace the hand-run deploy with one command that gates, deploys named services, and records the result.
- Remove the scripts and the instructions that can destroy data.
- Pin the third-party images and cap the container log files.
- Move the host tree to one commit of `main` and deploy Phases 2–4.

### Work Items

#### 5.1 Images and compose name their commit ✅ Completed 2026-11-24
**Status: COMPLETE 2026-11-24**
**Model Tier: sonnet**
**Requirement Refs:** SA7-03, PLT-005, RC7-12
**Files Affected:**
- `.github/workflows/build-images.yml` (modify)
- `docker-compose.yml` (modify)
- `.gitignore` (modify)
- `LAB_NOTEBOOK.md` (modify)

**Description:**
Every service uses the `:latest` tag and no image carries a label that names its commit, so nothing on the host states what is running. The compose project name is derived from the directory name. The directories `pgdata/`, `redis-data/`, `financial-inbox/`, and `utility-inbox/` sit inside the git working tree with no `.gitignore` entry. This item labels each image with its commit, lets compose select a tag, pins the project name, and ignores the four directories.

**Tasks:**
1. [ ] Add the Phase 5 entry to `LAB_NOTEBOOK.md` (objective, hypothesis, rollback) before the first commit.
2. [ ] `build-images.yml`: add `labels: org.opencontainers.image.revision=${{ github.sha }}` to each of the 8 build steps, and add `workflow_dispatch:` under `on:`.
3. [ ] `docker-compose.yml`: change the 9 `ghcr.io/davistroy/open-brain/*:latest` image references to `:${IMAGE_TAG:-latest}`, and add the top-level key `name: open-brain`.
4. [ ] `.gitignore`: add `/pgdata/`, `/redis-data/`, `/financial-inbox/`, and `/utility-inbox/`.
5. [ ] Check the render: project name, tag substitution, and the same 13 services.

**Acceptance Criteria:**
- [ ] WHEN `build-images.yml` builds an image THEN the image SHALL carry the label `org.opencontainers.image.revision` with the full commit SHA
- [ ] WHEN `IMAGE_TAG` is unset THEN the compose render SHALL reference `:latest` on all 9 lines
- [ ] WHEN `IMAGE_TAG=sha-abc1234` THEN the compose render SHALL reference `:sha-abc1234` on all 9 lines
- [ ] WHEN compose runs from a directory with another name THEN the project name SHALL be `open-brain`
- [ ] `git check-ignore -q pgdata/ && git check-ignore -q redis-data/ && git check-ignore -q financial-inbox/ && git check-ignore -q utility-inbox/` exits 0
- [ ] `touch .env.secrets && jq -e '.name == "open-brain"' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` exits 0

**Notes:**
The build workflow already pushes a `sha-<short>` tag per image (`git rev-parse --short HEAD`); this item adds the label. `name: open-brain` equals today's derived project name, so the volume and network prefixes (`open-brain_open-brain`) do not change. The `.gitignore` entries land before the host tree reconcile of item 5.5; `git clean` and `git stash -u` stay forbidden on the host regardless. `IMAGE_TAG` is a tag name with no secret value.

---

#### 5.2 `scripts/deploy.sh`, `scripts/preflight.sh`, and `DEPLOYED.json` ✅ Completed 2026-11-24
**Status: COMPLETE 2026-11-24**
**Model Tier: opus**
**Requirement Refs:** SA7-03, PLT-005, RC7-12, PLT-008, INT-019
**Depends On:** 5.1 (cross-phase: 4.1, 4.3)
**Files Affected:**
- `scripts/deploy.sh` (create)
- `scripts/preflight.sh` (create)
- `scripts/test-deploy.sh` (create)
- `scripts/check-deploy-parity.sh` (modify)
- `.gitignore` (modify)
- `.github/workflows/ci.yml` (modify)
- `docs/adr/ADR-0006-deployed-state-identity.md` (modify)

**Description:**
A deploy today is a set of hand-run commands, and nothing records the result. `scripts/deploy.sh <sha> [service …]` runs a fixed gate sequence, recreates only the named application services, refuses `postgres`, `redis`, and `cloudflared`, and writes `DEPLOYED.json`. `scripts/deploy.sh <sha> --tree-only` moves the host tree to the commit and recreates nothing. `scripts/preflight.sh` lists every missing rebuild prerequisite.

**Tasks:**
1. [ ] `scripts/preflight.sh`: check the Loki log-driver plugin, the external networks `observability` and `br0`, the required `.env` value `TAILSCALE_IP`, the file `.env.secrets`, every bind source, `config/whisper/model_aliases.json` as a regular file, and `bws` on the PATH (a warning until item 7.4). Print every missing item and exit 1 when a required item is missing.
2. [ ] `scripts/deploy.sh`, step order: run as root and resolve `<sha>` with `git -c safe.directory`; run `preflight.sh`; clean-tree check (`git status --porcelain` minus `deploy/host-only-allowlist.txt` must be empty); `git fetch` and `git checkout --detach <sha>`; the drift check of item 4.1 against `<sha>` (layers `file` and `tree`); config gate; pull; recreate; verify; record.
3. [ ] Config gate: hold the render in memory and assert that `postgres` and `redis` render `type == "bind"`, that each bind source equals the mount source of the running container (`docker inspect`), and that the service set equals the 13 known services. Print the per-service differences from `docker compose config --hash`. Never write the render to a file or to the log.
4. [ ] Pull: set `IMAGE_TAG=sha-$(git rev-parse --short <sha>)`, confirm the tag exists for each named service (`docker manifest inspect`) before any change, then run `docker compose pull <services>`.
5. [ ] Recreate: `docker compose up -d --force-recreate --no-deps <services>`. Refuse an empty service list unless `--tree-only` is given. Refuse `postgres`, `redis`, and `cloudflared`. Require `financial-ingest` and `utility-ingest` together (shared image). Never pass `--remove-orphans`.
6. [ ] Verify: each recreated container is healthy within a timeout and its image label `org.opencontainers.image.revision` equals `<sha>`. An optional `--marker <service>=<path>:<string>` greps a string inside the running container.
7. [ ] Record: write `DEPLOYED.json` (`commit`, `deployed_at`, the image digest of all 13 containers, `schema_ledger_max` read through `docker exec open-brain-postgres psql`, and a hand-kept `cloudflare_workers` field that the script preserves), and append one line to `${BACKUP_ROOT}/deploy-log.jsonl`. `--dry-run` prints the plan and changes nothing.
8. [ ] `scripts/check-deploy-parity.sh`, layer `tree`: when `DEPLOYED.json` exists, print `UNDEPLOYED` when `git diff --stat <DEPLOYED commit>..origin/main -- . ':!*.md' ':!docs'` is non-empty.
9. [ ] `scripts/test-deploy.sh` with stub `docker` and `git` on the PATH: refuses `postgres`; refuses a dirty tree; refuses a named-volume render; refuses an unknown image tag; `--dry-run` changes nothing; a full run writes `DEPLOYED.json` with the commit. Wire the harness into `build-and-test` in `ci.yml`. Add `/DEPLOYED.json` to `.gitignore`. Set ADR-0006 to `Accepted`.

**Acceptance Criteria:**
- [ ] WHEN `scripts/deploy.sh <sha> postgres` runs THEN the script SHALL refuse and change nothing
- [ ] WHEN the working tree holds a changed tracked file outside the allowlist THEN the script SHALL stop before `git checkout`
- [ ] WHEN the render shows a named volume for `postgres` or `redis`, or a bind source that differs from the running mount, THEN the script SHALL stop before any pull
- [ ] WHEN the script recreates services THEN the `up` command SHALL name each service and SHALL NOT contain `--remove-orphans`
- [ ] WHEN a deploy completes THEN `DEPLOYED.json` SHALL hold the commit, 13 image digests, and the ledger maximum, and `deploy-log.jsonl` SHALL gain one line
- [ ] WHEN `scripts/deploy.sh <sha> --tree-only` runs THEN the script SHALL check out the commit, run every gate, write `DEPLOYED.json`, and recreate no container
- [ ] WHEN `scripts/preflight.sh` finds a missing prerequisite THEN the script SHALL print every missing item and exit 1
- [ ] `bash scripts/test-deploy.sh` exits 0
- [ ] `bash -n scripts/deploy.sh && bash -n scripts/preflight.sh` exits 0

**Notes:**
Both scripts use `bash`, `jq`, `sed`, and `awk` only; the Unraid host has no `python3` and no `psql`. The script never runs `git clean`, `git stash`, or `git pull`. A rollback is `scripts/deploy.sh <previous sha>`, which needs that commit's `sha-*` images in the registry. Cloudflare workers deploy with `wrangler` outside this script; the owner records their version in `cloudflare_workers` by hand (INT-019). Item 4.1 supplies the allowlist and the drift layers; item 4.3 supplies the base binds that the config gate asserts. `faster-whisper` is not on the refuse list; item 8.4 deploys the service by hand inside the stateful window.

---

#### 5.3 Remove the scripts and instructions that destroy data
**Status: COMPLETE 2026-11-24**
**Model Tier: sonnet**
**Requirement Refs:** PLT-016, PLT-028, PLT-012, SA7-12 (operational parts)
**Depends On:** 5.2
**Files Affected:**
- `scripts/monthly-maintenance.sh` (modify)
- `scripts/migrate.sh` (delete)
- `README.md` (modify)
- `docs/loki-setup.md` (modify)
- `docs/RISK_INVESTIGATION_CLOSEOUT.md` (modify)
- `docs/runbooks/deploy.md` (modify)
- `OPERATOR_ACTIONS.md` (modify)
- `CLAUDE.md` (modify)

**Description:**
Tracked files tell the reader to run commands that the project forbids. `scripts/monthly-maintenance.sh:60,64,75` runs `pull`, `build --no-cache`, and an unscoped `up -d`. `scripts/migrate.sh` runs drizzle-kit, which the project does not use. `README.md:207-222` names `migrate.sh` and a bare `up -d`. `docs/runbooks/deploy.md` lists `cloudflared` and `faster-whisper` in a "normal deploy" and writes rendered compose config to `/tmp`. This item deletes the script steps and rewrites the instructions around `scripts/deploy.sh`.

**Tasks:**
1. [ ] `scripts/monthly-maintenance.sh`: delete the pull, build, and `up` steps and the lines that print the output of those steps. The script keeps its read-only checks.
2. [ ] Delete `scripts/migrate.sh`.
3. [ ] `README.md`: remove `migrate.sh` from the file list (line 63) and rewrite lines 207–222: migrations run through `scripts/migrate-manual.sh`; services start through `scripts/deploy.sh <sha> <services>`; the stack has 13 containers.
4. [ ] `docs/runbooks/deploy.md`: the normal deploy is `scripts/deploy.sh <sha> <application services>`; remove `cloudflared` and `faster-whisper` from every application-service list; replace `git pull` (lines 127 and 251) with the script; remove every step that writes `docker compose config` output to a file (lines 69 and 124); add `actual-ingest` to the inventory and the service lists; correct line 41 (the override pins the data binds and holds no core-api port); mark the host `bws` steps (lines 99–100, 206–207) as dependent on item 7.4.
5. [ ] `docs/loki-setup.md:45`: replace `docker compose down && docker compose up -d` with a named-service `up -d --force-recreate --no-deps`, and mark the parts that ADR-0004 moved out of this project as superseded.
6. [ ] `docs/RISK_INVESTIGATION_CLOSEOUT.md:131-139`: mark the `--remove-orphans` and `--profile observability` advice as superseded by ADR-0004.
7. [ ] `OPERATOR_ACTIONS.md`, row OA-10: replace "MUST pass `-f docker-compose.override.yml`" with "no `-f` flag (Compose auto-merges the override), or both files".
8. [ ] `CLAUDE.md`: correct the Key Architecture line "Migrations via Drizzle + drizzle-kit" (migrations run through `scripts/migrate-manual.sh` and the `schema_migrations` ledger), and point the deploy rules at `scripts/deploy.sh`.

**Acceptance Criteria:**
- [ ] WHEN `scripts/monthly-maintenance.sh` runs THEN the script SHALL run no `docker compose pull`, `build`, or `up`
- [ ] WHEN a reader follows the normal deploy in `docs/runbooks/deploy.md` THEN the procedure SHALL recreate application services only and SHALL name none of `cloudflared`, `faster-whisper`, `postgres`, `redis`
- [ ] `! grep -nE 'compose (pull|build|up)' scripts/monthly-maintenance.sh` exits 0
- [ ] `test ! -e scripts/migrate.sh && ! grep -rn 'migrate\.sh' README.md docs/runbooks` exits 0
- [ ] `! grep -nE '^(docker compose config .*> |git pull|docker compose down)' docs/runbooks/deploy.md docs/loki-setup.md` exits 0
- [ ] `grep -c 'actual-ingest' docs/runbooks/deploy.md` prints 1 or more

**Notes:**
Deleting `scripts/migrate.sh` and correcting `README.md:207-222` belong to this item only. `scripts/monthly-maintenance.sh` is not scheduled on the host (L15); the hazard exists when a person runs the script as root. Item 4.1 holds the wording fix in `scripts/check-deploy-parity.sh`. `docs/SLO.md:9` and `docs/TDD.md:4048` are descriptive and out of scope. This item lands before item 5.5, so the host session follows a correct runbook.

---

#### 5.4 Pin the floating images; cap the container logs ✅ Completed 2026-11-24
**Status: COMPLETE 2026-11-24**
**Model Tier: sonnet**
**Requirement Refs:** PLT-029, INT-015, PLT-021, PLT-024
**Depends On:** 5.3
**Files Affected:**
- `docker-compose.yml` (modify)
- `scripts/offsite-backup.sh` (modify)
- `docker-compose.test.yml` (modify)
- `docs/runbooks/offsite-backup.md` (modify)

**Description:**
Four third-party image references float or age: `ghcr.io/speaches-ai/speaches:latest-cpu`, `pgvector/pgvector:pg16`, `rclone/rclone:latest` (`offsite-backup.sh:37`), and `cloudflare/cloudflared:2025.6.1`, which is pinned, about 17 months old, and the only ingress. The shared Loki logging anchor sets no file limit. This item pins each image and adds `max-size` and `max-file` to the logging anchor.

**Tasks:**
1. [ ] `cloudflared`: pin a current release tag. Read the vendor release page and the support window at implementation time (unknown U5).
2. [ ] `speaches`: pin a tested version tag or a digest. The pinned image must load `config/whisper/model_aliases.json` and return the `verbose_json` response that voice-capture reads.
3. [ ] `pgvector`: pin the digest that the live container runs. The owner runs this read-only host query and supplies the digest: `docker image inspect "$(docker inspect open-brain-postgres -f '{{.Image}}')" --format '{{index .RepoDigests 0}}'`. The pinned image stays at pgvector 0.8 or newer (live: 0.8.5).
4. [ ] `x-logging` anchor: add `max-size: "50m"` and `max-file: "2"` under `options`.
5. [ ] `scripts/offsite-backup.sh`: pin `RCLONE_IMAGE` to a version tag, and use the same tag in the commands of `docs/runbooks/offsite-backup.md`.
6. [ ] `docker-compose.test.yml`: `redis:7.4-alpine`, the production version.

**Acceptance Criteria:**
- [ ] WHEN the compose file renders THEN no third-party image reference SHALL use `latest` or a tag without a version
- [ ] WHEN a service is recreated THEN its logging options SHALL hold `max-size: 50m` and `max-file: 2`
- [ ] `touch .env.secrets && TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --images | grep -E 'cloudflared|speaches|pgvector'` shows three pinned references
- [ ] `touch .env.secrets && jq -e '[.services[] | select(.logging.options["max-size"]=="50m" and .logging.options["max-file"]=="2")] | length == 13' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` exits 0 (amended 2026-11-24: a plain `grep -c max-size` of the render prints 14, because the top-level `x-logging` anchor also renders)
- [ ] `! grep -n 'rclone/rclone:latest' scripts/offsite-backup.sh docs/runbooks/offsite-backup.md` exits 0

**Notes:**
Each pin takes effect at that service's next recreate: the application services in item 5.5, `postgres` in item 8.2, `redis` and `cloudflared` in item 8.3, `faster-whisper` in item 8.4. Pinning `pgvector` to the running digest keeps a version change out of the stateful recreate. A `cloudflared` rollback is a one-line revert; the service holds no state. `scripts/validate-init-schema.sh`, `scripts/regenerate-init-schema.sh`, and `scripts/restore-rehearsal.sh` keep `pgvector/pgvector:pg16` for their scratch containers. The logging change alters the rendered config of all 13 services.

---

#### 5.5 Reconcile the host tree and run the first clean deploy ✅ Completed 2026-11-24
**Status: COMPLETE 2026-11-24 (deployed 69a77b0, then d00ed25; LAB_NOTEBOOK Entry 260)**
**Model Tier: opus**
**Requirement Refs:** SA7-03, PLT-005
**Depends On:** 5.1, 5.2, 5.3, 5.4
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `OPERATOR_ACTIONS.md` (modify)

**Description:**
The host tree sits at commit `a1629e4` (2026-06-16), no longer an ancestor of `main`, with 72 modified or untracked paths. On the host, `docker-compose.yml` and `scripts/utility-pipeline.py` differ from `main`, and `0037_drop_voice_sessions.sql` and `config/whisper/` are missing. This item snapshots the host state, moves the tree to one commit of `main` in place, and deploys the nine application services through `scripts/deploy.sh`. The stateful services and `faster-whisper` wait for Phase 8.

**Tasks:**
1. [ ] Preconditions: Phases 2, 3, 4 and items 5.1–5.4 are merged; `build-images.yml` is green for the commit `<sha>`; a backup dated today exists and `pg_restore --list` reads the dump; the offsite object count is above 0 (item 1.1).
2. [ ] Snapshot, as `root`, into `/mnt/user/appdata/open-brain-config-backup/host-snapshot-<date>/` (directory mode 0700, files 0600; amended 2026-11-24: outside `/mnt/user/backup/openbrain`, which `workers` mounts and the offsite job copies): the output of `git -c safe.directory=/mnt/user/appdata/open-brain status --porcelain --ignored`, the output of `git diff --binary`, a tar of every untracked non-ignored file (`git ls-files -o --exclude-standard`, minus `pgdata/`, `redis-data/` and the inboxes — `checkout -f` overwrites an untracked file whose path the target tracks), and a tar of `docker-compose.override.yml`, `.env`, `config/utility/utility-config.yaml`, `config/payee-rules.yaml`, and `/boot/config/plugins/dynamix/custom.cron`. Record the image ID of all 13 containers (`docker inspect --format '{{.Name}} {{.Image}}'`), the `StartedAt` of `open-brain-postgres` and `open-brain-redis`, and `SELECT count(*) FROM captures`.
3. [ ] Classify each of the 72 paths (unknown U1): "matches `main`", "host-only by design" (present in `deploy/host-only-allowlist.txt`), or "drift". The owner decides each "drift" path before the checkout: keep (add to the allowlist or commit to `main`) or discard. The diff of `docker-compose.yml` shows whether the core-api port line still carries the single `3002:3000` bind (D131); the owner confirms that no LAN client depends on that bind before the checkout removes the line.
4. [ ] Back up `.env`, then add `TAILSCALE_IP=<the address the host binds today>` to `.env`.
5. [ ] **Checks BEFORE the checkout (amended 2026-11-24, Phase 5 review I2: any refusal after a hand checkout leaves 7 services reading the new `./config` on old images, and the script has no earlier commit to return to).** As `root`: `git -c safe.directory=/mnt/user/appdata/open-brain fetch origin`; run the target's preflight without checking out: `git -c safe.directory=/mnt/user/appdata/open-brain show <sha>:scripts/preflight.sh | PREFLIGHT_REPO_DIR=/mnt/user/appdata/open-brain bash -s -- --ref <sha>` (read the script's usage first; it must exit 0); `docker manifest inspect ghcr.io/davistroy/open-brain/<image>:sha-<first 7 chars>` for all 8 images; task 3's classification is complete, so the post-checkout clean-tree check holds no surprise. Any failure here: stop, nothing has changed.
6. [ ] As `root`: `git -c safe.directory=/mnt/user/appdata/open-brain checkout -f --detach <sha>`. **Then at once restore `config/utility/utility-config.yaml` (and any other once-tracked host-only file) from the task-2 tar** — the move from `a1629e4` deletes it (Phase 5 review I1: tracked at `a1629e4`, gitignored since; gas would break silently). Copy `config/prometheus/alerts/container-health.yml` (and every other changed rule file) into the observability project's rule directory and reload Prometheus now, before `workers` is recreated (Phase 4 hand-off: else the offline `spark-llm` probe pages hourly). Run `bash scripts/preflight.sh` (exit 0), then `bash scripts/deploy.sh <sha> --dry-run core-api workers slack-bot voice-capture web-next file-ingestion financial-ingest utility-ingest actual-ingest`. The gate shows `postgres` and `redis` as binds whose sources equal the live mounts. If anything fails from here, use the manual rollback in Notes — `deploy.sh` has no earlier deploy to return to.
7. [ ] Run the same `deploy.sh` command without `--dry-run`. Go from task 6 to this task without a pause: `./config` is bind-mounted live into 7 services.
8. [ ] Verify: the nine containers are healthy; `docker exec open-brain-workers cat /mnt/user/backup/openbrain/latest/manifest.json` shows today's date; the revision label of `open-brain-core-api` equals `jq -r .commit DEPLOYED.json`; `docker exec open-brain-workers grep -c 'alert_state:' /app/packages/workers/dist/main.js` prints 1 or more; `scripts/check-deploy-parity.sh` lists exactly `postgres`, `redis`, `cloudflared`, and `faster-whisper` as stale.
9. [ ] Trigger `secret-rotation` once (`curl -s -X POST http://127.0.0.1:3002/api/v1/skills/secret-rotation/trigger`) and read `totalSecrets` above 0 from the newest `secret-rotation` row of `skills_log`.
10. [ ] Confirm the rule copy of task 6: `bash scripts/check-alerts-parity.sh` reports every rule in sync. Then, because root now did all git work in the tree (fetch, checkout), record in `LAB_NOTEBOOK.md` that from this deploy on only `root` runs git in `/mnt/user/appdata/open-brain` (root-owned objects in `.git` break git as `claude`; Phase 4 review M-3, Phase 5 review M4).
11. [ ] `OPERATOR_ACTIONS.md`: add a dated row, due 7 days after this deploy: set `ALERT_LEGACY_PUSH: "false"` in the workers `environment:` block and deploy. Log every command and result in `LAB_NOTEBOOK.md`, and mark U1 resolved.

**Acceptance Criteria:**
- [ ] WHEN the checkout completes THEN `git -c safe.directory=/mnt/user/appdata/open-brain status --porcelain` SHALL list only paths in `deploy/host-only-allowlist.txt`
- [ ] WHEN the deploy completes THEN `docker inspect open-brain-core-api -f '{{index .Config.Labels "org.opencontainers.image.revision"}}'` SHALL equal `jq -r .commit DEPLOYED.json`
- [ ] WHEN the deploy completes THEN the nine application containers SHALL report healthy and `open-brain-postgres` and `open-brain-redis` SHALL show the same `StartedAt` as before the deploy
- [ ] WHEN `scripts/check-deploy-parity.sh` runs after the deploy THEN layer 2 SHALL list exactly `postgres`, `redis`, `cloudflared`, and `faster-whisper` as stale
- [ ] WHEN `SELECT count(*) FROM captures` runs after the deploy THEN the count SHALL be equal to or greater than the count recorded in task 2
- [ ] `docker exec open-brain-workers grep -c 'alert_state:' /app/packages/workers/dist/main.js` prints 1 or more
- [ ] `env -i HOME=/root PATH=/usr/bin:/bin:/usr/sbin bash -c 'cd /mnt/user/appdata/open-brain && PARITY_LOCAL_COMPOSE=$PWD/docker-compose.yml bash scripts/check-deploy-parity.sh'; echo $?` prints 0 or 1

**Notes:**
HOST — operator-gated. Run in a session with the owner present; an unattended agent does not execute this item. The nightly Unraid appdata backup (00:00 ET) restarts Postgres every night, so take the task-2 `StartedAt` reading and the post-deploy reading in the same day, after 00:10 ET. Backup first: the daily backup of task 1 and the root-only snapshot of task 2, taken before the checkout. Rollback: `git checkout -f --detach a1629e4`, re-apply the saved `git diff` and the tar from the snapshot, retag each recorded image ID as `:latest` (`docker tag <id> <repository>:latest`), and recreate the nine services with `up -d --force-recreate --no-deps` and no pull. Run no `docker image prune` until Phase 8 closes. Never run `git clean`, `git stash -u`, or `git pull`, and never rename the host directory: `pgdata/` and `redis-data/` live inside the working tree. Never run a bare `up -d`, `--remove-orphans`, or `compose down`; `deploy.sh` names every service. Never write rendered `docker compose config` output to a file or a log. The host has no `python3` and no `psql`. Every service's config hash changes in this deploy (logging caps, binds, healthchecks); the four services left stale are the ones Phase 8 recreates. The approved analysis shows a raw `up -d` for the application wave; this item routes the wave through `scripts/deploy.sh`, which exists by then and writes `DEPLOYED.json`.

---

### Phase 5 Testing Requirements

- [ ] `scripts/test-deploy.sh` covers each refusal (stateful service, dirty tree, named-volume render, unknown tag), `--dry-run`, `--tree-only`, and the `DEPLOYED.json` content
- [ ] `scripts/preflight.sh` is tested for a missing plugin, a missing network, and a missing bind source
- [ ] The compose render is asserted for the project name, the tag substitution, the log caps, and the pinned images
- [ ] Item 5.5 runs `--dry-run` before the real deploy

### Phase 5 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] `docs/adr/ADR-0006-deployed-state-identity.md` status is `Accepted`
- [ ] `README.md`, `docs/runbooks/deploy.md`, `docs/loki-setup.md`, and `docs/RISK_INVESTIGATION_CLOSEOUT.md` hold no unsafe command
- [ ] Fix verified in the running container (grep a marker): `alert_state:` in `open-brain-workers`, and the revision label on each of the nine application containers
- [ ] `DEPLOYED.json` exists on the host and `deploy-log.jsonl` has one line
- [ ] CLAUDE.md and memory updated with any non-trivial learning (deploys go through `scripts/deploy.sh`; the host tree is a clean checkout; the snapshot location)
- [ ] `OPERATOR_ACTIONS.md` holds the dated `ALERT_LEGACY_PUSH` row
- [ ] No regression: capture count unchanged or higher; Postgres and Redis not restarted

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests | `pnpm -r test` | Exit code 0 (coverage thresholds for core-api and workers enforced) |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Shell guards | `bash scripts/test-secrets-roundtrip.sh && bash scripts/test-backup-secrets-redaction.sh && bash scripts/test-pushover-encoding.sh` | Exit code 0 |
| Deploy harness | `bash scripts/test-deploy.sh` | Exit code 0 |
| Script syntax | `bash -n scripts/deploy.sh && bash -n scripts/preflight.sh` | Exit code 0 |
| No unsafe compose step | `! grep -n -e 'compose pull' -e 'compose build' -e 'compose up' scripts/monthly-maintenance.sh` | Exit code 0 |
| `migrate.sh` removed | `test ! -e scripts/migrate.sh && ! grep -rn 'migrate\.sh' README.md docs/runbooks` | Exit code 0 |
| Data directories ignored | `git check-ignore -q pgdata/ && git check-ignore -q redis-data/ && git check-ignore -q financial-inbox/ && git check-ignore -q utility-inbox/` | Exit code 0 |
| Project name pinned | `touch .env.secrets && jq -e '.name == "open-brain"' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` | Exit code 0 |
| Image tag selectable | `touch .env.secrets && jq -e 'all(.services[].image; test("^ghcr.io/davistroy/open-brain/.*:sha-abc1234$") or (startswith("ghcr.io/davistroy/open-brain/") == false))' <(IMAGE_TAG=sha-abc1234 TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` | Exit code 0 |
| Log caps | `touch .env.secrets && jq -e 'all(.services[]; .logging.options["max-size"] == "50m")' <(TAILSCALE_IP=100.64.0.1 docker compose -f docker-compose.yml config --format json)` | Exit code 0 |
| Images pinned | `! grep -n -e 'speaches:latest' -e 'pgvector/pgvector:pg16$' -e 'rclone/rclone:latest' docker-compose.yml scripts/offsite-backup.sh` | Exit code 0 |

<!-- END DOD -->

---

## Phase 6: Backup and restore: the restore path

**Estimated Complexity:** M (~15 files, ~1,100 LOC)
**Dependencies:** Phase 5 (changed scripts reach the host through `scripts/deploy.sh`; the repo work may start earlier)
**Execution Mode:** Sequential

### Goals

- Make a failed migration leave no object and no ledger row.
- Give a real recovery and the weekly rehearsal one restore function.
- Make the rehearsal fail on a stale dump, a missing index, a missing constraint, or a wrong ledger version.
- Put every piece of state that a rebuild needs into the backup.

### Work Items

#### 6.1 Atomic migrations
**Status: COMPLETE 2026-11-25**
**Model Tier: sonnet**
**Requirement Refs:** DA7-12
**Files Affected:**
- `scripts/migrate-manual.sh` (modify)
- `scripts/test-migrate-manual.sh` (create)
- `.github/workflows/ci.yml` (modify)
- `LAB_NOTEBOOK.md` (modify)

**Description:**
`scripts/migrate-manual.sh` applies a migration with `psql -f` outside a transaction (`:113`) and writes the ledger row in a second session (`:114`). A migration that fails halfway leaves its first statements applied and no ledger row. Each migration now runs in one `psql -1` session together with its ledger insert. A header comment opts a file out, for a statement that cannot run inside a transaction.

**Tasks:**
1. [ ] Add the Phase 6 entry to `LAB_NOTEBOOK.md` (objective, hypothesis, rollback) before the first commit.
2. [ ] Apply path: one call per file, `psql -1 -v ON_ERROR_STOP=1 -f "$f" -c "INSERT INTO schema_migrations (version, checksum) VALUES (…)"`.
3. [ ] A file whose first lines hold `-- migrate:no-transaction` runs without `-1`, writes its ledger row in a second call, and the script prints a notice.
4. [ ] `--status`: compare the sha256 of each applied file with the stored `checksum`, and print a warning line on a mismatch.
5. [ ] Create `scripts/test-migrate-manual.sh` on a scratch `pgvector/pgvector:pg16` container (pattern: `scripts/validate-init-schema.sh`): a two-statement migration whose second statement fails leaves no object and no ledger row; a `-- migrate:no-transaction` file applies; `--baseline`, `--status`, and `--dry-run` still work. Wire the harness into the `validate-schema` job of `ci.yml`.

**Acceptance Criteria:**
- [ ] WHEN the second statement of a migration fails THEN the database SHALL hold no object from the first statement and no ledger row for that version
- [ ] WHEN a migration succeeds THEN its ledger row SHALL be written in the same transaction as its statements
- [ ] WHEN a migration file carries `-- migrate:no-transaction` THEN the script SHALL apply the file without `-1`
- [ ] WHEN `--status` finds an applied file whose checksum differs THEN the script SHALL print a warning for that version
- [ ] `bash scripts/test-migrate-manual.sh` exits 0
- [ ] `bash scripts/validate-init-schema.sh` exits 0

**Notes:**
No migration in `packages/shared/drizzle` contains `BEGIN` or `CONCURRENTLY` today, so every existing file runs under `-1`. On the host the script still runs from a throwaway `pgvector/pgvector:pg16` container. `--status` prints the connection string in its `target:` line; do not log that output. The sentence in `CLAUDE.md` that says a failed attempt rolls back cleanly becomes true with this item; correct the sentence at phase end.

---

#### 6.2 One restore script used by the rehearsal and by a real recovery
**Status: COMPLETE 2026-11-25**
**Model Tier: opus**
**Requirement Refs:** DA7-03, PLT-017, RC7-11 (recovery part), PLT-010
**Depends On:** 6.1
**Files Affected:**
- `scripts/lib/restore-core.sh` (create)
- `scripts/restore.sh` (create)
- `scripts/test-restore.sh` (create)
- `docs/runbooks/restore-rehearsal.md` (modify)
- `docs/runbooks/offsite-backup.md` (modify)
- `docs/runbooks/deploy.md` (modify)
- `config/postgres/postgresql.conf` (modify)

**Description:**
The documented recovery (`docs/runbooks/restore-rehearsal.md:131-200`) applies the schema first and then runs `pg_restore --exit-on-error`, which aborts on the first existing object and restores zero rows. The weekly rehearsal follows a different path. A restore under production memory settings also drops indexes and constraints. This item creates one function, `restore_into`, used by a new `scripts/restore.sh` and by the rehearsal, and rewrites the runbook section as a checklist that calls the script.

**Tasks:**
1. [ ] `scripts/lib/restore-core.sh`, function `restore_into <container> <dump>`: refuse unless `pg_tables` holds no table in schema `public`; run `CREATE EXTENSION IF NOT EXISTS vector`; `docker cp` the dump; run `docker exec -e PGOPTIONS='-c max_parallel_maintenance_workers=0' <container> pg_restore --exit-on-error --no-owner --no-privileges -U openbrain -d openbrain <dump>`; return non-zero on any error.
2. [ ] `scripts/restore.sh`: options `--backup-dir <dir>`, `--target <container>` (default `open-brain-postgres`), and `--apply-pending`, which runs `scripts/migrate-manual.sh` from a throwaway `pgvector/pgvector:pg16` container on the stack network. The script calls `restore_into` and prints the table, index, and constraint counts.
3. [ ] `scripts/test-restore.sh` on a scratch container: a target that holds one table → refusal and no change; an empty target plus a small dump → the restore succeeds and every index of the dump exists.
4. [ ] Rewrite the "Manual restore" section of `docs/runbooks/restore-rehearsal.md` as an ordered checklist: root shell; `.env.secrets` first (item 7.4); confirm the binds render (`docker compose config --format json` piped to `jq`, nothing written to a file); `scripts/preflight.sh`; `up -d postgres` with no `-f` flag; `scripts/restore.sh`; restore the sidecar and host files (item 6.4); `scripts/install-crons.sh` (item 7.3); `scripts/deploy.sh <sha> <services>`. State RPO 24 hours and RTO one working day.
5. [ ] Point `docs/runbooks/offsite-backup.md` ("Restore procedure", step 3) and `docs/runbooks/deploy.md` (lines 296–298) at the checklist.
6. [ ] `config/postgres/postgresql.conf`, lines 8–9: correct the comment that says a lower worker count does not help. `max_parallel_maintenance_workers=0` avoids the shared-memory segment; a non-zero value does not.

**Acceptance Criteria:**
- [ ] WHEN `scripts/restore.sh` targets a database that holds a table THEN the script SHALL refuse and change nothing
- [ ] WHEN `restore_into` restores a dump into an empty database in a container with a 64 MB `/dev/shm` THEN every index and constraint of the dump SHALL exist after the restore
- [ ] WHEN a reader follows the manual-restore checklist THEN each step SHALL be one script call or one command, in the stated order
- [ ] `bash scripts/test-restore.sh` exits 0
- [ ] `! grep -nE 'init-schema.sql|n_live_tup|compose up -d$' docs/runbooks/restore-rehearsal.md` exits 0

**Notes:**
The restore session sets `PGOPTIONS='-c max_parallel_maintenance_workers=0'`, so a correct restore does not depend on the `/dev/shm` size of the Postgres container. Item 8.2 (the Postgres recreate) is still required for live `REINDEX` and migrations. Deleting `scripts/migrate.sh` and correcting `README.md:207-222` are in item 5.3 and are not repeated here. Snapshot model: the dump restores into an empty database, and `init-schema.sql` is not applied first. The comment change in `postgresql.conf` alters no setting and needs no recreate. The host has no `psql`; every SQL call goes through `docker exec`. The end-to-end proof on seeded data is the CI job of item 7.2.

---

#### 6.3 A rehearsal that fails when it should
**Status: COMPLETE 2026-11-25 (repo + host, Entry 262)**
**Model Tier: sonnet**
**Requirement Refs:** DA7-04, DA7-09, PLT-004, QA-003
**Depends On:** 6.2
**Files Affected:**
- `scripts/restore-rehearsal.sh` (modify)
- `scripts/lib/dr-required-objects.txt` (create)
- `scripts/test-restore-rehearsal.sh` (modify)
- `docs/runbooks/restore-rehearsal.md` (modify)

**Description:**
The rehearsal passed every Sunday against a 76-day-old dump. Its only check is a ±10% row count against whatever `latest` points to, in a container with default settings, and `pg_isready` over the socket answers while the init-time server still runs. The rehearsal now fails on a dump older than 36 hours, restores through `restore_into` with the production config, and asserts object counts, index validity, a required-object list, and the ledger maximum against the manifest.

**Tasks:**
1. [ ] Fail with exit 1 when `manifest.timestamp` or the dump modification time is older than `REHEARSAL_MAX_AGE_HOURS` (default 36).
2. [ ] Readiness probe: `pg_isready -h 127.0.0.1` (TCP). Mount `config/postgres/postgresql.conf` into the rehearsal container and keep the default 64 MB `/dev/shm`.
3. [ ] Replace the inline `pg_restore` with `restore_into` from `scripts/lib/restore-core.sh`.
4. [ ] Assert against the manifest key `objects` (written by item 6.4): the index, foreign-key, trigger, and public-function counts, and `max(schema_migrations.version)`. Assert that `SELECT count(*) FROM pg_index WHERE NOT indisvalid` returns 0. A manifest without `objects` (older weekly and monthly backups) logs a warning and skips the count assertions.
5. [ ] Create `scripts/lib/dr-required-objects.txt` with `captures_embedding_hnsw_idx`, `captures_content_tsvector_idx`, `hybrid_search`, `spreading_activation`, `fts_only_search`, and `vector_search`, and assert that each name exists after the restore.
6. [ ] Row counts: accept a difference of at most 1% or at most 20 rows per table, whichever is larger. Count tables with 0 rows. A failed count query is a failure.
7. [ ] On PASS write the current timestamp to `${BACKUP_ROOT}/.rehearsal-last-success` and log one line: `indexes N/N fk N/N triggers N/N functions N/N ledger <version>`.
8. [ ] `scripts/test-restore-rehearsal.sh`: compute fixture dates from today (the fixtures hard-code 2026-04-19). New cases: a stale dump → exit 1; a missing required object → exit 1; a manifest without `objects` → warning and pass; a difference of 15 rows → pass; a difference of 5% → fail. Correct the tolerance text in `docs/runbooks/restore-rehearsal.md`.
9. [ ] Host step after merge (session C): `bash scripts/restore-rehearsal.sh; echo $?` against a dump less than 36 hours old.

**Acceptance Criteria:**
- [ ] WHEN the newest dump is older than 36 hours THEN the rehearsal SHALL exit 1 and send the failure notification
- [ ] WHEN the restored database lacks `captures_embedding_hnsw_idx` THEN the rehearsal SHALL exit 1
- [ ] WHEN the restored index, foreign-key, trigger, or function count differs from the manifest THEN the rehearsal SHALL exit 1
- [ ] WHEN a table's restored row count differs from the manifest by at most 1% or at most 20 rows THEN the rehearsal SHALL accept that table
- [ ] WHEN the manifest has no `objects` key THEN the rehearsal SHALL log a warning and SHALL NOT fail for that reason
- [ ] `bash scripts/test-restore-rehearsal.sh` exits 0
- [ ] Host check (session C): the rehearsal log shows `indexes N/N fk N/N triggers N/N` with equal numbers on both sides (110, 17, and 7 at review time) and the script exits 0

**Notes:**
Ships in ONE pull request with item 6.4: the assertions read the manifest key `objects` that item 6.4 adds to `scripts/backup.sh`, and every `backup.sh` edit of this phase lands in item 6.4. Exact row equality would fail on a correct restore: `backup.sh` counts rows after the dump snapshot. The exit codes 0/1/2, `REHEARSAL_DRY_RUN`, the env overrides, the Pushover priorities, and the Sunday 05:30 slot stay unchanged. Task 9 is a host step: operator-gated, the owner is present; the rehearsal uses a scratch container and changes no production state, so no backup and no rollback apply. The marker of task 7 is read by item 7.3.

---

#### 6.4 The backup holds everything a rebuild needs
**Status: COMPLETE 2026-11-25 (repo + host, Entry 262)**
**Model Tier: sonnet**
**Requirement Refs:** DA7-07, PLT-031, PLT-030, DA7-13, PLT-023
**Depends On:** 6.3
**Files Affected:**
- `scripts/backup.sh` (modify)
- `scripts/test-backup-secrets-redaction.sh` (modify)
- `docs/runbooks/restore-rehearsal.md` (modify)

**Description:**
`scripts/backup.sh` covers the Postgres dump, config YAML, the wiki bundle, and a Redis snapshot that has failed with `NOAUTH` since Redis got a password (`:174-189`). Two SQLite databases, the `actual-ingest` state file, the voice spool, and the host cron table are in no backup, and the manifest records its version as `unknown`. This item repairs the Redis leg, adds the missing state, records object counts and image IDs in the manifest, and sets every file's modification time to the backup time.

**Tasks:**
1. [ ] Redis: `REDISCLI_AUTH="${REDIS_PASSWORD:-}" docker exec -e REDISCLI_AUTH "$REDIS_C" sh -c 'REDISCLI_AUTH="${REDISCLI_AUTH:-$REDIS_PASSWORD}" redis-cli LASTSAVE'`. The name-only `-e` keeps the password out of the process list, and the fallback covers the container before and after item 8.3. Use `BGSAVE SCHEDULE`. A non-numeric `LASTSAVE` reply counts as a failure.
2. [ ] SQLite: for `open-brain-financial-ingest` and `open-brain-utility-ingest`, snapshot the database inside the container through the sqlite3 backup API (`python -c` with `sqlite3.Connection.backup`), then `docker cp` the snapshot into `sidecars/`.
3. [ ] Tar `/data/state.json` from `open-brain-actual-ingest` and `/data/voice-spool` from `open-brain-voice-capture` into `sidecars/`.
4. [ ] Copy `/boot/config/plugins/dynamix/custom.cron` when readable. Write `git -c safe.directory="$APP_DIR" status --porcelain` and `rev-parse HEAD` to `host-tree.txt`. Use the same `-c safe.directory` for the manifest fields `version` and `git_sha`. Copy `DEPLOYED.json` when present.
5. [ ] Manifest: add `objects` (the index, foreign-key, trigger, and public-function counts, plus `max(schema_migrations.version)`), `images` (`docker inspect --format '{{.Image}}'` per container), and `redis_rdb` (`present` or `failed`).
6. [ ] After the manifest is written and before the weekly and monthly promotion copies: `find "$BACKUP_FILE" -type f -exec touch -c {} +`.
7. [ ] Each new step logs a warning on failure and never aborts the backup or blocks the `latest` move. Keep the two config-copy-block marker lines unchanged.
8. [ ] Extend `scripts/test-backup-secrets-redaction.sh`: the new copies (`custom.cron`, `host-tree.txt`, `sidecars/`) hold none of the known secret variable names. Add the restore steps for the sidecar and host files to `docs/runbooks/restore-rehearsal.md`.
9. [ ] Host step after merge (session C): run `scripts/backup.sh` once and check the new files.

**Acceptance Criteria:**
- [ ] WHEN Redis requires a password THEN `backup.sh` SHALL write `redis.rdb` and the manifest SHALL record `redis_rdb: present`
- [ ] WHEN the Redis snapshot fails THEN `backup.sh` SHALL record `redis_rdb: failed`, finish, and move `latest`
- [ ] WHEN the backup completes THEN `sidecars/` SHALL hold a snapshot of each SQLite database, and `PRAGMA integrity_check` on a copied snapshot SHALL return `ok`
- [ ] WHEN the backup completes THEN `manifest.json` SHALL hold `objects`, `images`, and a `git_sha` other than `unknown`
- [ ] WHEN the backup completes THEN every file under the day's directory SHALL have a modification time inside the backup run
- [ ] WHEN a new backup step fails THEN `backup.sh` SHALL log a warning and continue
- [ ] `bash scripts/test-backup-secrets-redaction.sh` exits 0
- [ ] Host check (session C): `ls /mnt/user/backup/openbrain/latest/redis.rdb /mnt/user/backup/openbrain/latest/sidecars/` lists the snapshot files, and `docker exec open-brain-utility-ingest python -c "import sqlite3;print(sqlite3.connect('/tmp/v.db').execute('pragma integrity_check').fetchone())"` against a copied snapshot prints `('ok',)`

**Notes:**
Ships in ONE pull request with item 6.3. `.env.secrets` is never copied. `custom.cron` holds no secret: each cron line sources `.env.secrets` at run time. A plain copy of a WAL-mode SQLite database is corrupt, which is why task 2 uses the backup API. The SQLite snapshots hold financial and utility history; the snapshots stay in the backup tree and on the encrypted offsite remote and never enter the repository. The sidecars are idle at 03:00. Unknown U8 (whether the Unraid appdata backup covers the Docker named volumes) does not block this item. Task 6 lets the offsite copy of item 7.1 see config files: `cp -a` keeps old modification times, and the offsite copy filters on file age. Task 9 is a host step: operator-gated, the owner is present; a backup run adds files only; rollback is to delete the day's directory and re-point `latest`.

---

### Phase 6 Testing Requirements

- [ ] `scripts/test-migrate-manual.sh` proves that a failed migration leaves no object and no ledger row
- [ ] `scripts/test-restore.sh` proves the refusal on a non-empty target and a complete restore under a 64 MB `/dev/shm`
- [ ] `scripts/test-restore-rehearsal.sh` covers the stale dump, the missing object, the old manifest, and both tolerance bounds
- [ ] `scripts/test-backup-secrets-redaction.sh` covers the new backup content
- [ ] The host rehearsal passes on a dump less than 36 hours old (session C)

### Phase 6 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Items 6.3 and 6.4 merged in one pull request
- [ ] `docs/runbooks/restore-rehearsal.md`, `docs/runbooks/offsite-backup.md`, and `docs/runbooks/deploy.md` point at `scripts/restore.sh`
- [ ] Host steps of 6.3 and 6.4 done in session C; results in `LAB_NOTEBOOK.md`
- [ ] Fix verified on the host: `grep -c 'restore_into' /mnt/user/appdata/open-brain/scripts/restore-rehearsal.sh` prints 1 or more after `scripts/deploy.sh <sha> --tree-only`
- [ ] CLAUDE.md and memory updated with any non-trivial learning (migrations are atomic; the restore runs with `max_parallel_maintenance_workers=0`; the backup manifest keys)
- [ ] No regression: the nightly backup still completes and moves `latest`

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests | `pnpm -r test` | Exit code 0 (coverage thresholds for core-api and workers enforced) |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Schema parity | `bash scripts/validate-init-schema.sh` | Exit code 0 |
| Shell guards | `bash scripts/test-secrets-roundtrip.sh && bash scripts/test-backup-secrets-redaction.sh && bash scripts/test-pushover-encoding.sh` | Exit code 0 |
| Migrations atomic | `bash scripts/test-migrate-manual.sh` | Exit code 0 |
| Restore function | `bash scripts/test-restore.sh` | Exit code 0 |
| Rehearsal assertions | `bash scripts/test-restore-rehearsal.sh` | Exit code 0 |
| Runbook holds no old path | `! grep -n -e 'init-schema.sql' -e 'n_live_tup' -e 'compose up -d$' docs/runbooks/restore-rehearsal.md` | Exit code 0 |

<!-- END DOD -->

---

## Phase 7: Backup and restore: offsite, CI, crons, secrets

**Estimated Complexity:** M (~16 files, ~900 LOC; host session C)
**Dependencies:** Phase 6
**Execution Mode:** Sequential

### Goals

- Make the offsite copy fail when its source or its result is stale, and never prune when the local source is stale.
- Run a real backup and a real restore in CI.
- Install every Open Brain cron line from one script, and alert when the offsite copy or the rehearsal stops succeeding.
- Make a fresh host able to rebuild `.env.secrets`.

### Work Items

#### 7.1 Offsite copy that cannot empty itself
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** DA7-08; defect "config files never reached the offsite copy" (investigation 01, NEW-1)
**Files Affected:**
- `scripts/offsite-backup.sh` (modify)
- `scripts/test-offsite-backup.sh` (create)
- `docs/runbooks/offsite-backup.md` (modify)
- `LAB_NOTEBOOK.md` (modify)

**Description:**
`scripts/offsite-backup.sh` copies files newer than 2 days (`:68`), prunes remote files older than 30 days (`:74`), and checks nothing else. When the local backup stopped, the prune emptied the remote, and each run still logged "Offsite backup complete" with 0 objects. Config files never reached the remote, because `cp -a` kept their old modification times. The script now refuses to prune on a stale source, fails when the remote has no fresh dump, and prunes per tier.

**Tasks:**
1. [ ] Add the Phase 7 entry to `LAB_NOTEBOOK.md` (objective, hypothesis, rollback) before the first commit.
2. [ ] Before the prune: find the newest local `daily/*/openbrain.pgdump`. Older than 48 hours → skip the prune, exit 1, and send the failure notification.
3. [ ] After the copy: exit 1 when `rclone lsf -R --max-age 48h --include '*/openbrain.pgdump' <remote>daily` returns nothing.
4. [ ] Prune per tier: `daily/` at 30 days, `weekly/` at 35 days, `monthly/` at 100 days. Exclude `canary/**` from every prune.
5. [ ] Make the rclone call overridable through `RCLONE_CMD`, so a test can stub the call. On success write the current timestamp to `${BACKUP_ROOT}/.offsite-last-success`.
6. [ ] Create `scripts/test-offsite-backup.sh` with a stub `RCLONE_CMD`: a stale local source → no prune call and exit 1; an empty remote listing → exit 1; a fresh source → copy, per-tier prune with the canary excluded, marker written.
7. [ ] `docs/runbooks/offsite-backup.md`: the per-tier retention, the two freshness checks, the canary rule.
8. [ ] Host step after merge (session C): one seeding run with `OFFSITE_MAX_AGE=off`, re-seed `canary/ob-canary.txt`, then count the config objects on the remote.

**Acceptance Criteria:**
- [ ] WHEN the newest local dump is older than 48 hours THEN `offsite-backup.sh` SHALL skip the prune, exit 1, and send the failure notification
- [ ] WHEN the remote holds no dump newer than 48 hours after the copy THEN the script SHALL exit 1
- [ ] WHEN the script prunes THEN `daily/` SHALL use 30 days, `weekly/` 35 days, and `monthly/` 100 days, and `canary/` SHALL be excluded
- [ ] WHEN the run succeeds THEN the script SHALL write `${BACKUP_ROOT}/.offsite-last-success`
- [ ] `bash scripts/test-offsite-backup.sh` exits 0
- [ ] Host check (session C): `rclone lsf -R open-brain-offsite:daily | grep -c /config/` (run through the pinned rclone image) prints a number above 0

**Notes:**
The `touch` step that makes config files visible to `--max-age` is in item 6.4. Do not switch the script to `rclone sync`: `copy` plus an age-based prune keeps a local wipe from deleting remote files (project rule). The default `--max-age 2d` stays; removing the filter while the prune is age-based would start an upload-and-delete loop. The per-tier windows are longer than the local retention (14 daily, 4 weekly, 3 monthly). The crypt remote, its password, its salt, and the 03:45 slot stay unchanged; the `latest` symlink is not followed. Task 8 is a host step: operator-gated, the owner is present; the seeding run adds remote objects only, so no backup and no rollback apply. The marker of task 5 is read by item 7.3.

---

#### 7.2 CI runs a real backup and a real restore
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** QA-003, PLT-004
**Depends On:** 7.1
**Files Affected:**
- `.github/workflows/ci.yml` (modify)
- `scripts/test-restore-e2e.sh` (create)
- `scripts/test-fixtures/dr-seed.sql` (create)

**Description:**
CI runs three shell harnesses that test the scripts against fixtures of their own making. No job runs the real `scripts/backup.sh` against a database or restores its output. A new job `dr-restore-e2e` starts a `pgvector/pgvector:pg16` container with the production Postgres config and the default 64 MB `/dev/shm`, seeds about 5,000 captures, runs the real `scripts/backup.sh`, and then runs the real `scripts/restore-rehearsal.sh`.

**Tasks:**
1. [ ] `scripts/test-restore-e2e.sh`: start `pgvector/pgvector:pg16` named `open-brain-postgres` with `config/postgres/postgresql.conf` mounted (`-c shared_buffers=256MB` for the runner) and the default `/dev/shm`. Load `scripts/init-schema.sql`, then run `scripts/migrate-manual.sh --baseline <latest version>`.
2. [ ] `scripts/test-fixtures/dr-seed.sql`: insert about 5,000 captures with random `vector(768)` values and synthetic text. The heap exceeds 8 MB, so Postgres plans a parallel HNSW build.
3. [ ] Run the real `scripts/backup.sh` with `BACKUP_ROOT` on a scratch path and `APP_DIR` on the repository; the wiki, Redis, and sidecar legs warn and continue. Run the real `scripts/restore-rehearsal.sh` against that backup. Exit non-zero on any failure and remove the containers on exit.
4. [ ] `ci.yml`: add the job `dr-restore-e2e`, which runs the script. Add `bash scripts/test-restore-rehearsal.sh` and `bash scripts/test-offsite-backup.sh` to `build-and-test`.
5. [ ] Prove that the job detects the regression: on a throwaway branch remove `PGOPTIONS` from `restore_into`, confirm that the job fails, and discard the branch.

**Acceptance Criteria:**
- [ ] WHEN `dr-restore-e2e` runs THEN the job SHALL back up and restore the seeded database and pass
- [ ] WHEN `PGOPTIONS='-c max_parallel_maintenance_workers=0'` is removed from `restore_into` THEN the job SHALL fail
- [ ] WHEN a commit changes `scripts/backup.sh`, `scripts/restore-rehearsal.sh`, or `scripts/lib/restore-core.sh` THEN the job SHALL run on that commit
- [ ] `bash scripts/test-restore-e2e.sh` exits 0 locally
- [ ] `bash scripts/test-restore-rehearsal.sh && bash scripts/test-offsite-backup.sh` exits 0

**Notes:**
A seed that is too small never plans a parallel HNSW build, and the regression stays invisible; keep about 5,000 rows. The seed holds synthetic content only. The `validate-schema` job already uses Docker on the runner. Branch-protection changes for the new job are outside this item.

---

#### 7.3 One cron installer; job freshness markers
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PLT-007, QA-003
**Depends On:** 7.2
**Files Affected:**
- `scripts/install-crons.sh` (create)
- `scripts/test-install-crons.sh` (create)
- `.github/workflows/ci.yml` (modify)
- `deploy/cron/unraid-ingest.cron` (modify)
- `deploy/cron/unraid-parity-check.cron` (modify)
- `scripts/backup.sh` (modify)
- `packages/workers/src/skills/pipeline-health.ts` (modify)
- `packages/workers/src/__tests__/pipeline-health.test.ts` (modify)

**Description:**
The backup cron line was lost once, because the line had no tracked definition and lived in a user crontab. Two of the five cron templates give install text that does not work (`sudo tee` as `claude`, verify with `crontab -l`), and only the backup has a freshness alert. This item adds one idempotent installer that writes a managed block into `custom.cron`, a lock in `backup.sh`, and a `pipeline-health` check on the last-success markers of the offsite copy and the rehearsal.

**Tasks:**
1. [ ] `scripts/install-crons.sh`: run as root; `--dry-run` is the default and `--apply` writes. Back up `custom.cron`; remove existing unmanaged lines that name `/mnt/user/appdata/open-brain` or an `open-brain-` container; write one block between `# >>> open-brain managed` and `# <<< open-brain managed` from the cron lines of every `deploy/cron/*.cron` template; run `/usr/local/sbin/update_cron`; check each line against `/etc/cron.d/root`. `CUSTOM_CRON` and `CRON_VERIFY_FILE` override the two paths for tests.
2. [ ] The installer absorbs the existing `0 3 * * *` `scripts/backup.sh` line into the managed block. After `--apply`, exactly one line names `scripts/backup.sh`.
3. [ ] Create `scripts/test-install-crons.sh`: a fixture `custom.cron` with an unmanaged backup line, an unmanaged ingest line, and a job that does not belong to Open Brain. After `--apply`: one backup line, the foreign job unchanged. A second `--apply` changes nothing. `--dry-run` writes nothing. Wire the harness into `build-and-test` in `ci.yml`.
4. [ ] `deploy/cron/unraid-ingest.cron` and `deploy/cron/unraid-parity-check.cron`: replace the install text with "installed by `scripts/install-crons.sh --apply` as root; verify with `grep` on `/etc/cron.d/root`".
5. [ ] `scripts/backup.sh`: line 8 shows the cron line that sources `.env.secrets`. The script takes `flock -n /var/lock/open-brain-backup.lock` and exits with a message when the lock is held.
6. [ ] `pipeline-health.ts`: read `.offsite-last-success` and `.rehearsal-last-success` through the backup mount. Call `raiseAlert` with key `offsite-stale` (critical, older than 48 hours) and key `rehearsal-stale` (warning, older than 8 days). A missing marker counts as stale when `BACKUP_MANIFEST_REQUIRED` is `true`. Add tests for fresh, stale, and missing markers.
7. [ ] Host step after merge (session C): `bash scripts/install-crons.sh` (dry run), review the difference with the owner, then `bash scripts/install-crons.sh --apply`.

**Acceptance Criteria:**
- [ ] WHEN `install-crons.sh --apply` runs on a `custom.cron` that holds an unmanaged backup line THEN the result SHALL hold exactly one `scripts/backup.sh` line, inside the managed block
- [ ] WHEN `--apply` runs twice THEN the second run SHALL change nothing
- [ ] WHEN `custom.cron` holds a job that does not belong to Open Brain THEN the installer SHALL leave that line unchanged
- [ ] WHEN a second `backup.sh` starts while one runs THEN the second SHALL exit before starting a dump
- [ ] WHEN `.offsite-last-success` is older than 48 hours THEN `pipeline-health` SHALL raise `offsite-stale` once
- [ ] `bash scripts/test-install-crons.sh` exits 0
- [ ] `pnpm --filter @open-brain/workers exec vitest run src/__tests__/pipeline-health.test.ts` exits 0
- [ ] Host check (session C): a dry run after `--apply` shows no difference, and each cron line of the five templates appears exactly once in `/etc/cron.d/root`

**Notes:**
The slots stay: backup 03:00, offsite 03:45, parity 05:15, rehearsal Sunday 05:30, ingest 06:00 and 06:30. No secret enters `custom.cron`; each line sources `.env.secrets` at run time. The markers are written by item 6.3 (rehearsal) and item 7.1 (offsite), because those items already edit the two scripts; this item adds the reader, which sees the markers through the backup mount of item 4.2. A second 03:00 line would start two `pg_dump` runs that write the same file; the installer and the lock both prevent that. Never install an Open Brain job with `crontab -e`: Unraid keeps user crontabs in RAM. Task 7 is a host step: operator-gated, the owner is present; backup first: the installer copies `custom.cron` before writing; rollback: copy the backup file back and run `/usr/local/sbin/update_cron`.

---

#### 7.4 Secrets can be rebuilt on a fresh host
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** PLT-002, PLT-003, SA7-04, OA-33
**Depends On:** 7.3
**Files Affected:**
- `scripts/load-secrets.sh` (modify)
- `scripts/test-secrets-roundtrip.sh` (modify)
- `docs/runbooks/restore-rehearsal.md` (modify)
- `OPERATOR_ACTIONS.md` (modify)
- `LAB_NOTEBOOK.md` (modify)

**Description:**
A rebuilt host cannot regenerate `.env.secrets`. `bws` is not installed on the Unraid host, so `load-secrets.sh` exits at its `bws` lookup (`:106-110`). A fresh `.env.secrets` never receives `BWS_ACCESS_TOKEN`, because the script only preserves the token from an existing file (`:315-318`). The script now writes the bootstrap token from the environment into a fresh file, and the host gets a pinned static `bws` that survives a reboot.

**Tasks:**
1. [ ] `scripts/load-secrets.sh`: when no token is preserved from an existing file, write `BWS_ACCESS_TOKEN` from the environment into the new file. The flag `--no-persist-bootstrap` turns the write off.
2. [ ] `scripts/test-secrets-roundtrip.sh`: a fresh target directory with a stub `BWS_BIN` yields exactly one `^BWS_ACCESS_TOKEN=.` line; `--no-persist-bootstrap` yields none; an existing token is still preserved across `--force`.
3. [ ] `docs/runbooks/restore-rehearsal.md`, checklist step "`.env.secrets` first": export `BWS_ACCESS_TOKEN`, run `bash scripts/load-secrets.sh --target-dir /mnt/user/appdata/open-brain`, then `bash scripts/verify-secrets.sh --quiet`.
4. [ ] Host, as `root`: back up `/boot/config/go`. Download the static `bws` 1.0.0 binary (the version of the sidecar image) to `/boot/config/bin/bws` and check its sha256. Add a line to `/boot/config/go` that copies the binary to `/usr/local/bin/bws` with mode 0755 at boot.
5. [ ] Host: run the new `go` line by hand, then `command -v bws && bws --version`, then `bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain --quiet`.
6. [ ] `OPERATOR_ACTIONS.md`: set OA-33 to `DONE <date>`. Log the host steps in `LAB_NOTEBOOK.md`.

**Acceptance Criteria:**
- [ ] WHEN `load-secrets.sh` writes a fresh `.env.secrets` with `BWS_ACCESS_TOKEN` in the environment THEN the file SHALL hold exactly one `BWS_ACCESS_TOKEN=` line
- [ ] WHEN `--no-persist-bootstrap` is passed THEN the file SHALL hold no `BWS_ACCESS_TOKEN=` line
- [ ] WHEN the host boots THEN `/boot/config/go` SHALL place `bws` at `/usr/local/bin/bws`
- [ ] WHEN `verify-secrets.sh --quiet` runs on the host THEN the script SHALL print its summary line and SHALL NOT exit 2 for a missing `bws`
- [ ] `bash scripts/test-secrets-roundtrip.sh` exits 0
- [ ] Host check: `command -v bws && bws --version` prints the pinned version

**Notes:**
HOST — operator-gated. Tasks 4–5 run on the host; tasks 1–3 and 6 are repo work. The owner is present for the host tasks; an unattended agent does not execute tasks 4–5. Backup first: `/boot/config/go` is copied before the edit. Rollback: restore the `go` file and delete `/boot/config/bin/bws`. Do not regenerate the live `.env.secrets` in this item; `verify-secrets.sh` only reads, and the live file already holds the token. `load-secrets.sh` writes the file with mode 0600, and `backup.sh` never copies `.env.secrets`. A static binary on the flash drive is preferred over a container route, whose image pull would need a credential that itself lives in Bitwarden. `BWS_ACCESS_TOKEN` stays outside `scripts/lib/secrets-map.sh` by design; the three-step secret lockstep is unchanged.

---

### Phase 7 Testing Requirements

- [ ] `scripts/test-offsite-backup.sh` covers the stale source, the empty remote, the per-tier prune, and the canary exclusion
- [ ] `scripts/test-restore-e2e.sh` runs the real backup and the real rehearsal on seeded data, and fails once with `PGOPTIONS` removed
- [ ] `scripts/test-install-crons.sh` covers the absorbed backup line, idempotence, and the untouched foreign job
- [ ] `scripts/test-secrets-roundtrip.sh` covers the fresh-file bootstrap token
- [ ] `pipeline-health.test.ts` covers fresh, stale, and missing markers

### Phase 7 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing; job `dr-restore-e2e` green on `main`
- [ ] Session C done: rehearsal passes with assertions on a dump less than 36 hours old (milestone C), seeding run done, crons installed from the managed block, `bws` on the host
- [ ] Fix verified on the host: each cron line appears once in `/etc/cron.d/root`; `grep -c 'offsite-last-success' /mnt/user/appdata/open-brain/scripts/offsite-backup.sh` prints 1 or more
- [ ] Fix verified in the running container (grep a marker): `docker exec open-brain-workers grep -c 'offsite-stale' /app/packages/workers/dist/main.js` prints 1 or more after `scripts/deploy.sh <sha> workers`
- [ ] `docs/runbooks/offsite-backup.md` and `docs/runbooks/restore-rehearsal.md` updated
- [ ] CLAUDE.md and memory updated with any non-trivial learning (the cron installer and the managed block; the offsite freshness rules; `bws` on the host; the bootstrap token rule)
- [ ] OA-33 closed in `OPERATOR_ACTIONS.md`
- [ ] No regression: the 03:00 backup, the 03:45 offsite copy, and the Sunday rehearsal each ran once after session C

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Tests | `pnpm -r test` | Exit code 0 (coverage thresholds for core-api and workers enforced) |
| Lint and types | `pnpm -r lint` | Exit code 0 |
| Shell guards | `bash scripts/test-secrets-roundtrip.sh && bash scripts/test-backup-secrets-redaction.sh && bash scripts/test-pushover-encoding.sh` | Exit code 0 |
| Offsite harness | `bash scripts/test-offsite-backup.sh` | Exit code 0 |
| Rehearsal harness | `bash scripts/test-restore-rehearsal.sh` | Exit code 0 |
| Real backup and restore | `bash scripts/test-restore-e2e.sh` | Exit code 0 |
| Cron installer | `bash scripts/test-install-crons.sh` | Exit code 0 |
| Freshness reader | `pnpm --filter @open-brain/workers exec vitest run src/__tests__/pipeline-health.test.ts` | Exit code 0 |

<!-- END DOD -->

---

## Phase 8: Stateful window

**Estimated Complexity:** S (~3 files, ~100 LOC; host session D)
**Dependencies:** Phases 5, 6, 7
**Execution Mode:** Sequential

### Goals

- Apply the one pending migration.
- Recreate Postgres, Redis, and `cloudflared` one at a time on the tracked configuration.
- Put the speech-to-text migration into production.
- End with a clean drift check and a complete `DEPLOYED.json`.

### Work Items

#### 8.1 Apply migration 0037
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** OA-28, DA7-17
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `OPERATOR_ACTIONS.md` (modify)

**Description:**
Migration `0037_drop_voice_sessions.sql` (`DROP TABLE IF EXISTS voice_sessions CASCADE`) is on `main` and not applied; the ledger stands at 0036. The running core-api, workers, and web-next images post-date the code removal (PR #342). This item confirms that no running code and no foreign key references the table, takes a fresh backup, and applies the migration through `scripts/migrate-manual.sh`.

**Tasks:**
1. [ ] Add the Phase 8 entry to `LAB_NOTEBOOK.md` (objective, hypothesis, and a rollback per step) before any host command. Phase preconditions: milestone C is reached, item 5.5 is complete, and the drift check lists exactly `postgres`, `redis`, `cloudflared`, and `faster-whisper` as stale.
2. [ ] Confirm that no running bundle references the table: `grep -rl voice_sessions` over the application bundle directories of `open-brain-core-api`, `open-brain-workers`, and `open-brain-web-next` (excluding `node_modules`) finds no file.
3. [ ] Confirm that no foreign key references the table: `SELECT conrelid::regclass FROM pg_constraint WHERE confrelid = 'voice_sessions'::regclass` returns no row.
4. [ ] Run `scripts/backup.sh` by hand and confirm the new daily directory.
5. [ ] Run `bash scripts/migrate-manual.sh --status` from a throwaway `pgvector/pgvector:pg16` container on network `open-brain_open-brain`, with the tree mounted (`-v /mnt/user/appdata/open-brain:/app -w /app`) and `POSTGRES_URL` taken from `docker exec open-brain-core-api printenv POSTGRES_URL`. Only `0037` is pending. Do not log the output.
6. [ ] Apply: the same container runs `bash scripts/migrate-manual.sh`.
7. [ ] Verify the ledger and the dropped table, record the result, and set OA-28 to `DONE <date>`.

**Acceptance Criteria:**
- [ ] WHEN the migration has run THEN `SELECT max(version) FROM schema_migrations` SHALL return `0037`
- [ ] WHEN the migration has run THEN `SELECT to_regclass('voice_sessions')` SHALL return NULL
- [ ] WHEN `data-retention-prune` next runs THEN the job SHALL complete with no missing-table error
- [ ] `--status` showed exactly one pending migration, `0037`, before the apply
- [ ] A backup taken in this session exists (`readlink /mnt/user/backup/openbrain/latest`)

**Notes:**
HOST — operator-gated. Run in a session with the owner present; an unattended agent does not execute this item. Backup first: task 4. Rollback: the drop is destructive; the rows return only from the backup of task 4 (restore the table into a scratch database, then copy the rows). The table is frozen and unused. The host has no `psql`, so the migration runs from the throwaway container. Keep `POSTGRES_URL` inside the session: `--status` prints the connection string in its `target:` line. `scripts/migrate-manual.sh` applies files in order, so every later migration (Part 2, Phase 11) follows this one.

---

#### 8.2 Recreate Postgres alone
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** OA-10, OA-32, PLT-001, DA7-04 (OA-10 part)
**Depends On:** 8.1
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `OPERATOR_ACTIONS.md` (modify)

**Description:**
The running Postgres container still has Docker's 64 MB `/dev/shm`. `shm_size: 1gb` in the compose file needs a recreate that never happened, so a live `REINDEX` or a parallel migration fails. The container also predates the tracked data bind (item 4.3), the pinned image (item 5.4), and the log caps. This item recreates `postgres` alone, on the bind that holds the live data.

**Tasks:**
1. [ ] Preconditions: the rehearsal of item 6.3 passed on a dump less than 36 hours old; the `postgres` image in the compose file is the digest pinned in item 5.4 and equals the running image; `scripts/backup.sh` ran within the hour; `SELECT count(*) FROM captures` is recorded.
2. [ ] Back up `docker-compose.override.yml`, then remove its `postgres` volumes entry, so the base long-syntax bind renders.
3. [ ] Render gate, held in memory: `docker compose config --format json | jq '.services.postgres.volumes[] | select(.target=="/var/lib/postgresql/data")'` shows `type: bind`, source `/mnt/user/appdata/open-brain/pgdata`, and `create_host_path: false`, and the source equals the mount source from `docker inspect open-brain-postgres`. Stop on any difference.
4. [ ] `docker compose up -d --force-recreate --no-deps postgres`, with no `-f` flag and one service name.
5. [ ] Verify: the container is healthy; `docker inspect open-brain-postgres --format '{{.HostConfig.ShmSize}}'` prints `1073741824`; `df -h /dev/shm` inside the container shows 1.0G; the capture count equals the recorded count; `SELECT count(*) FROM hybrid_search('backup', (SELECT embedding FROM captures WHERE embedding IS NOT NULL LIMIT 1), 5)` returns a number above 0; core-api `/health` reports healthy, and `workers` logs no connection error after 2 minutes.
6. [ ] Record the result and set OA-10 to `DONE <date>`.

**Acceptance Criteria:**
- [ ] WHEN `postgres` is recreated THEN `docker inspect open-brain-postgres --format '{{.HostConfig.ShmSize}}'` SHALL print `1073741824`
- [ ] WHEN `postgres` is recreated THEN `SELECT count(*) FROM captures` SHALL equal the count recorded before the recreate
- [ ] WHEN `postgres` is recreated THEN the data mount SHALL be a bind of `/mnt/user/appdata/open-brain/pgdata`
- [ ] WHEN a `hybrid_search` call runs after the recreate THEN the call SHALL return at least one row
- [ ] WHEN the recreate completes THEN `open-brain-redis` and `open-brain-cloudflared` SHALL show the same `StartedAt` as before
- [ ] `docker inspect open-brain-postgres --format '{{range .Mounts}}{{.Type}} {{.Source}} {{end}}'` lists `bind /mnt/user/appdata/open-brain/pgdata`

**Notes:**
HOST — operator-gated. Run in a session with the owner present; an unattended agent does not execute this item. Backup first: the same-hour backup of task 1 and the override copy of task 2. Rollback: restore the override file and recreate `postgres` with the previous image ID; when the data directory is damaged, restore with `scripts/restore.sh` from the backup of task 1. One service per step. No `-f` flag: Compose auto-merges the override, and `-f docker-compose.yml` alone rendered named volumes under the old base file, which is an empty database. Never run a bare `up -d`, `--remove-orphans`, or `compose down`, and never write the render to a file. The override entry leaves before the recreate: the override's short syntax turns `create_host_path` back on, and removing the entry after the recreate would change the config hash again. A correct restore does not depend on this item (item 6.2); a live `REINDEX` and migrations do.

---

#### 8.3 Recreate Redis alone, then `cloudflared` alone
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** OA-32, INT-015, PLT-021
**Depends On:** 8.2
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `OPERATOR_ACTIONS.md` (modify)

**Description:**
The running Redis is `redis:7-alpine` with the password in its command line; the compose file names `redis:7.4-alpine` and reads the password from `env_file` (D145). The running `cloudflared` is release 2025.6.1 and takes its token from the host `.env`; the compose file names the release pinned in item 5.4 and reads the token from `.env.secrets`. Each service is recreated alone, after its secret is proven identical in both places.

**Tasks:**
1. [ ] Redis precondition: the sha256 of `REDIS_PASSWORD` in `.env.secrets` equals the sha256 of the running `requirepass`. Compare the two hashes and print neither value. Record the `redis_version` difference and the count of keys matching `bull:*:repeat*`.
2. [ ] Back up `docker-compose.override.yml`, remove its `redis` volumes entry, and run the render gate of item 8.2 for target `/data` and source `/mnt/user/appdata/open-brain/redis-data`.
3. [ ] `docker compose up -d --force-recreate --no-deps redis`. Verify: the container is healthy; the log shows the data file loaded; the scheduler key count equals the recorded count; `workers` reconnects and one `pipeline-health` run completes.
4. [ ] `cloudflared` precondition: the sha256 of `TUNNEL_TOKEN` in `.env.secrets` equals the sha256 of the token value in `.env`.
5. [ ] `docker compose up -d --force-recreate --no-deps cloudflared`. Verify: the `tunnel ready` healthcheck passes, and `curl -s -o /dev/null -w '%{http_code}' 'https://brain.troy-davis.com/api/v1/captures?limit=1'` prints `302`.
6. [ ] Record both results and set OA-32 to `DONE <date>`.

**Acceptance Criteria:**
- [ ] WHEN `redis` is recreated THEN the BullMQ scheduler key count SHALL equal the count recorded before, and `workers` SHALL complete a job
- [ ] WHEN `redis` is recreated THEN the data mount SHALL be a bind of `/mnt/user/appdata/open-brain/redis-data` and the image SHALL be `redis:7.4-alpine`
- [ ] WHEN `cloudflared` is recreated THEN the public hostname SHALL answer `302` and the `tunnel ready` healthcheck SHALL pass
- [ ] WHEN a secret hash differs THEN the recreate of that service SHALL NOT start
- [ ] `docker inspect open-brain-redis -f '{{.Config.Image}}'` prints `redis:7.4-alpine`
- [ ] `docker inspect open-brain-cloudflared -f '{{.State.Health.Status}}'` prints `healthy`

**Notes:**
HOST — operator-gated. Run in a session with the owner present; an unattended agent does not execute this item. Backup first: a backup within the hour (run `scripts/backup.sh` again when the backup of item 8.2 is older) and the override copy of task 2. Rollback for Redis: restore the override and recreate with the previous image ID. A password mismatch stops every queue, so the hash check comes first. Rollback for `cloudflared`: revert the image line and recreate; the service holds no state, and an ingress cut shows within a minute. One service per step, no `-f` flag, never a bare `up -d`, `--remove-orphans`, or `compose down`. Compare secret hashes only and print no secret. When the override file holds no entry after task 2, delete the file: an empty override can fail the render, and the backup copy stays. The Redis data file restores the BullMQ schedulers and the Composio usage counter. The Unraid appdata backup cold-stops containers at 00:00; do not run this item across midnight.

---

#### 8.4 Deploy the speech-to-text migration
**Status: PENDING**
**Model Tier: opus**
**Requirement Refs:** OA-35
**Depends On:** 8.3
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `OPERATOR_ACTIONS.md` (modify)

**Description:**
The compose file names the `speaches` image for service `faster-whisper` (PR #360); the host still runs the earlier `fedirz/faster-whisper-server` image. The first start downloads about 3 GB of model data into the new `hf_hub_cache` volume. This item pulls and recreates `faster-whisper` alone and verifies a real transcription.

**Tasks:**
1. [ ] Preconditions: `test -f /mnt/user/appdata/open-brain/config/whisper/model_aliases.json`; the image reference is the pin of item 5.4; the Docker image file has at least 5 GB free (`df -h /var/lib/docker`); the current image ID is recorded.
2. [ ] `docker compose pull faster-whisper`, then `docker compose up -d --force-recreate --no-deps faster-whisper`.
3. [ ] Wait up to 300 seconds for the health check; the model download runs on the first start.
4. [ ] Verify with a sample from `scripts/test-audio`: `curl -s -F file=@<sample> -F model=whisper-1 -F response_format=verbose_json http://127.0.0.1:10300/v1/audio/transcriptions` returns segments. Then one real voice capture reaches `complete`.
5. [ ] Record the result and set OA-35 to `DONE <date>`.

**Acceptance Criteria:**
- [ ] WHEN `faster-whisper` is recreated THEN the container SHALL report healthy within 300 seconds
- [ ] WHEN a sample from `scripts/test-audio` is posted with `response_format=verbose_json` THEN the response SHALL hold at least one segment
- [ ] WHEN a voice memo is captured after the deploy THEN the capture SHALL reach `pipeline_status = 'complete'`
- [ ] `docker inspect open-brain-faster-whisper -f '{{.Config.Image}}'` prints the pinned `speaches` reference

**Notes:**
HOST — operator-gated. Run in a session with the owner present; an unattended agent does not execute this item. Backup first: no data backup applies (the service holds a model cache); the previous image ID is recorded in task 1. Rollback: restore the previous image block (`fedirz/faster-whisper-server:0.5.0-cpu`) in the compose file and recreate the service; the old `whisper_model_cache` volume is retained for that case. A rollback leaves the host tree changed; commit the revert to `main` or deploy forward before the next `scripts/deploy.sh` run. `voice-capture` needs no recreate (`WHISPER_URL` is unchanged). The container runs as user `ubuntu`, which must be able to write `hf_hub_cache`. One service per step; never a bare `up -d`.

---

#### 8.5 Close the window
**Status: PENDING**
**Model Tier: sonnet**
**Requirement Refs:** SA7-03, OA-10, OA-27, OA-28, OA-32, OA-35
**Depends On:** 8.4
**Files Affected:**
- `LAB_NOTEBOOK.md` (modify)
- `OPERATOR_ACTIONS.md` (modify)
- `CLAUDE.md` (modify)

**Description:**
After the four steps the host must show no drift and one recorded state. This item runs the drift check on all four layers, rewrites `DEPLOYED.json` with all 13 services, closes the operator actions, and corrects the project rules that describe the superseded state.

**Tasks:**
1. [ ] As `root`: `bash scripts/check-deploy-parity.sh`. The output holds no `STALE` line, the tree is clean, the alert rules are in sync, and the exit code is 0.
2. [ ] `bash scripts/deploy.sh <sha> --tree-only` rewrites `DEPLOYED.json`. Confirm 13 services and `schema_ledger_max` `0037`.
3. [ ] Run `scripts/backup.sh` once: the manifest holds `images` for 13 containers and the ledger maximum `0037`. Run `scripts/restore-rehearsal.sh` against that backup; the rehearsal passes.
4. [ ] `OPERATOR_ACTIONS.md`: confirm OA-10, OA-28, OA-32, and OA-35 are `DONE <date>`; correct OA-27 (the cron first produced a result in item 5.5) and close the row; confirm the `ALERT_LEGACY_PUSH` row of item 5.5 is present.
5. [ ] `CLAUDE.md`: correct the deploy rules that describe the superseded state: named volumes in `main`, the 64 MB `/dev/shm` workaround as a live requirement, the OA-32 drift note, and the D131 `sed` deviation.
6. [ ] Close the notebook entry with the duration, and update the Decision Log and the Action Items.

**Acceptance Criteria:**
- [ ] WHEN `scripts/check-deploy-parity.sh` runs after the window THEN the script SHALL exit 0 and print no `STALE` line
- [ ] WHEN `DEPLOYED.json` is read THEN the file SHALL list 13 services, the deployed commit, and `schema_ledger_max` `0037`
- [ ] WHEN the test over `OPERATOR_ACTIONS.md` runs THEN the test SHALL pass with OA-10, OA-27, OA-28, OA-32, and OA-35 closed
- [ ] `pnpm --filter @open-brain/shared exec vitest run operator-actions` exits 0
- [ ] The rehearsal passes on a backup taken after the window

**Notes:**
HOST — operator-gated. Run in a session with the owner present; an unattended agent does not execute this item. Backup first: none needed; the item reads state, records `DEPLOYED.json`, and takes one more backup. Rollback: none needed. `docker image prune` is allowed again after this item. The parity cron keeps running daily at 05:15 and notifies through its state file. The `ALERT_LEGACY_PUSH` operator action falls due one week after item 5.5. Part 2 starts from this state.

---

### Phase 8 Testing Requirements

- [ ] Each recreate is preceded by its render gate and its secret-hash check
- [ ] Each step is verified on the host before the next step starts
- [ ] The rehearsal passes on a backup taken after the window
- [ ] The drift check exits 0 on all four layers

### Phase 8 Completion Checklist

- [ ] All work items complete
- [ ] Ledger at `0037`; Postgres `/dev/shm` at 1 GiB; Redis at `7.4-alpine`; `cloudflared` on the pinned release; `speaches` live
- [ ] Capture count unchanged across the window
- [ ] `DEPLOYED.json` lists 13 services
- [ ] Fix verified in the running container: `docker inspect` shows the bind sources, the image references, and the `ShmSize` named in the acceptance criteria
- [ ] OA-10, OA-27, OA-28, OA-32, and OA-35 closed in `OPERATOR_ACTIONS.md`
- [ ] CLAUDE.md and memory updated with any non-trivial learning, and the superseded deploy rules corrected
- [ ] `LAB_NOTEBOOK.md` holds every command, result, and rollback anchor of the window

### Definition of Done (Runnable)
<!-- BEGIN DOD -->

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Operator register valid | `pnpm --filter @open-brain/shared exec vitest run operator-actions` | Exit code 0 |
| Lint and types | `pnpm -r lint` | Exit code 0 |

<!-- END DOD -->

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

Every phase is Sequential. The pairs below share no file, or share the files named, and may run side by side when two sessions are available.

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Items 4.1–4.4 | Phases 2–3 | Items 4.1–4.4 are repo-only and need no earlier phase. Shared file: `pipeline-health.ts` (4.2 with 2.2, 2.6, 3.1, 3.3). Land 4.2 after 2.2 and rebase. |
| 4.5 | Phase 3 | Item 4.5 needs item 2.2 and follows item 4.4. Shared file: `jobs/skill-execution.ts` (4.5 with 3.3 and 3.5). |
| Repo work of Phases 6–7 | Phase 5 | The scripts and tests can be written before Phase 5 ends. `ci.yml` is shared with 5.2. The host steps wait for `scripts/deploy.sh` (session C). |
| 2.3, 2.4, 2.6 | Each other | Each depends on 2.2 only, and the three items share no file. |
| 3.4, 3.5, 3.6 | Each other | 3.4 and 3.5 depend on 3.3; 3.6 depends on 3.2 and 3.3. The three items share no file. |
| 1.5, 1.6 | Host items 1.1–1.4 | Only when the host items slip past 2026-12-15. Neither item needs a host result. |
| 5.3 | 5.4 | 5.3 edits scripts and documents; 5.4 edits `docker-compose.yml`, `docker-compose.test.yml`, and the offsite script. `docs/runbooks/offsite-backup.md` belongs to 5.4 only. |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy | Status |
|------|------------|--------|---------------------|--------|
| Phase 1: the re-embed script removes a job that is in flight, or the nightly sweep fires mid-run and starts a full flow with paid enrichment | Low | Low | The script skips waiting, active, and delayed jobs and can be re-run; `--limit 10` first; run outside 03:00–03:30. Embeddings are additive, so nothing needs undoing. | Open |
| Phases 2–3 and item 4.5: a defect in the alert-state logic silences a real critical alert, which is worse than noise | Med | High | Feature flag `ALERT_STATE_ENABLED`; the old direct pushes stay on for one week (`ALERT_LEGACY_PUSH`); `raiseAlert` sends on a state-store error; the backup-stale path keeps its own key and call; `nextAction` is pure and table-tested. | Open |
| Phases 4–5: `git checkout -f` on the host overwrites a host-only deviation; a config-hash change makes a later unscoped `up` recreate Postgres | Med | High | A root-only snapshot of every modified and untracked path before the checkout; each of the 72 paths classified first; rollback to `a1629e4` with the recorded image IDs; `scripts/deploy.sh` refuses an empty service list and the stateful services. | Open |
| Phases 6–7: the new rehearsal assertions fail on a correct restore and add alert noise; the offsite prune change deletes or re-uploads everything | Med | Med | A manifest without the new keys warns only; row tolerance of 1% or 20 rows; a stubbed `RCLONE_CMD` test; per-tier prune windows longer than the local retention; `--max-age 2d` kept. | Open |
| Phase 8: Postgres comes up on an empty volume; a Redis password mismatch stops every queue; a tunnel token mismatch cuts ingress | Low | High | One service per step; a same-hour backup; the bind assertion before each `up`; a sha256 comparison of each secret before its recreate; the previous image IDs recorded; the restore path proven in Phases 6–7. | Open |

---

## Unknowns Register

| ID | Unknown | Severity | Affects | Resolution Strategy | Status |
|----|---------|----------|---------|---------------------|--------|
| U1 | The full contents of the host tree's 72 dirty paths and of the host override | High | Phase 5, Item 5.5; Phase 8, Items 8.2, 8.3 | The root-only snapshot of item 5.5; classify each path as "matches `main`", "host-only by design", or "drift" before the checkout | Open |
| U2 | Whether the offsite remote refills on 2026-11-23, and whether config files have ever reached the remote | High | Phase 1, Item 1.1; Phase 7, Item 7.1 | Read the offsite log after 03:45; list the remote with `rclone lsf` | Resolved 2026-11-23 (Entries 255–256): refilled — 12 objects / 333 MiB; `/config/` objects on the remote = 0 (expected until items 6.4 and 7.1) |
| U3 | Whether a musl build of `bws` exists for the pinned version | Medium | Phase 3, Item 3.6 | The `docker build --target workers` command of item 3.6 | Resolved 2026-11-23 (Entry 258): no musl asset for 1.0.0 (404); gcompat fallback fails at runtime; pinned bws 2.1.0 native musl |
| U4 | Whether the Spark tier can be restored, and by when | Medium | Phase 1, Item 1.3; Phase 4, Item 4.5 | Owner check on the Spark host. The circuit breaker of Part 2 (item 12.3) removes the dependence on the answer. | Accepted 2026-11-23 (Entry 256): Spark offline since ≈2026-08-05; OA-36 OPEN, due 2026-12-31 |
| U5 | Vendor dates and versions: the `cloudflared` support window and a tested `speaches` tag | Medium | Phase 5, Item 5.4; Phase 8, Items 8.3, 8.4 | Read each vendor page at implementation time; none was verified offline. The `tts-1` date, the dated model default, and the edge request limit affect Part 2. | Open |
| U6 | Whether GitHub disables the scheduled workflows on about 2026-12-23, and whether re-enabling resets the timer | Medium | Phase 1, Item 1.6 | The merge of item 1.6 resets the clock regardless | Resolved 2026-11-23: merge `ae27416` reset the clock |
| U7 | Whether the `30 7 * * *` scheduler slot is free | Low | Phase 2, Item 2.4 | `scheduler-slots.test.ts`. No `const *Cron` uses the slot at `f341ca6`. | Resolved 2026-11-23: slot free; `scheduler-slots.test.ts` green with `opsDigestCron` added. |
| U8 | Whether the Docker named volumes that hold the two SQLite databases are covered by the Unraid appdata backup | Low | Phase 6, Item 6.4 | `docker volume inspect`. Item 6.4 backs the volumes up regardless. | Open |

U1 is resolved inside item 5.5, before its checkout step. U2 is resolved by item 1.1. U9 and U10 of the approved analysis affect Part 2 only.

---

## Success Metrics

- [ ] All 8 phases completed
- [ ] All acceptance criteria met
- [ ] `SELECT count(*) FROM captures WHERE embedding IS NULL AND deleted_at IS NULL` returns 0, and a search finds a capture created after 2026-08-01
- [ ] A backup newer than 26 hours exists every day; the offsite remote holds a dump newer than 48 hours and holds config files
- [ ] A bad condition that does not change produces one alert, the escalation steps, and one "resolved"; `pipeline-health` returns to green when failures stop
- [ ] `DEPLOYED.json` names the commit that runs, and the drift check exits 0 on four layers
- [ ] The weekly rehearsal asserts indexes, constraints, and the ledger on a dump less than 36 hours old; CI runs a real backup and a real restore
- [ ] The ledger stands at `0037`, Postgres has a 1 GiB `/dev/shm`, and no merged change waits for a deploy
- [ ] `main` has a merge before 2026-12-23, and no test fixture expires on 2026-12-31

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|----------------|--------|-------|-----------|
| LIVE-1 (L1, L2) | arch-review v7; investigation 01 (B4) | 1 | 1.1 |
| LIVE-2 (L5) | arch-review v7; investigation 03 (section C) | 1 | 1.2 |
| L6 | arch-review v7; investigation 05 (TH1) | 1, 4 | 1.3, 4.5 |
| DA7-08 | arch-review v7; investigation 01 (B4) | 1, 7 | 1.1, 7.1 |
| SE7-01 (one-off recovery; code fix in Part 2) | arch-review v7; investigation 03 (section C) | 1 | 1.2 |
| PE-012 | arch-review v7; investigation 03 (section C, CAP-3) | 1, 3 | 1.2, 3.1 |
| DA7-19 (captures become searchable; function fix in Part 2) | arch-review v7; investigation 03 (section C) | 1 | 1.2 |
| INT-011 (probe part) | arch-review v7; investigation 05 (TH1) | 1, 4 | 1.3, 4.5 |
| SE7-07 | arch-review v7; investigation 04 (M5) | 1, 3 | 1.4, 3.4 |
| SE7-15 (cron part) | arch-review v7; investigation 04 (M14) | 1 | 1.4 |
| QA-018 | arch-review v7; investigation 06 (CI-1) | 1 | 1.5 |
| PLT-025 (clock reset; alarm in Part 2) | arch-review v7; investigation 06 (PP-3) | 1 | 1.6 |
| QA-006 (first CI run on `main`; schedule in Part 2) | arch-review v7; investigation 06 (PP-3) | 1 | 1.6 |
| SA7-05 | arch-review v7; investigation 06 (AL-1, alerting spec) | 2 | 2.1, 2.2, 2.3, 2.4 |
| PLT-027 | arch-review v7; investigation 06 (AL-1) | 2 | 2.1, 2.2, 2.4, 2.5 |
| PLT-020 | arch-review v7; investigation 06 (AL-1, AL-3) | 2, 3 | 2.1, 3.2 |
| GitHub issue #312 (OA-25) | arch-review v7; investigation 06 (AL-1) | 2 | 2.5 |
| PE-013 | arch-review v7; investigation 06 (AL-2) | 3 | 3.1 |
| SE7-11 | arch-review v7; investigation 06 (AL-2) | 2 | 2.6 |
| SA7-11 | arch-review v7; investigation 03 (CAP-3) | 3 | 3.1 |
| SA7-10 | arch-review v7; investigation 06 (AL-3) | 3 | 3.2, 3.6 |
| RC7-02 (parser) | arch-review v7; investigation 06 (AL-3) | 3 | 3.2 |
| INT-001 | arch-review v7; investigation 04 (M4, M5) | 3 | 3.3, 3.4 |
| QA-012 (canary) | arch-review v7; investigation 04 (M4) | 3 | 3.3 |
| SA7-07 | arch-review v7; investigation 04 (M4, M8) | 3 | 3.3, 3.6 |
| SE7-17 | arch-review v7; investigation 04 (M6) | 3 | 3.5 |
| SE7-08 | arch-review v7; investigation 04 (M7) | 3 | 3.5 |
| INT-010 | arch-review v7; investigation 04 (M7) | 3 | 3.5 |
| DA7-11 (alert part) | arch-review v7; investigation 04 (M7) | 3 | 3.5 |
| SEC-008 (functional part) | arch-review v7; investigation 04 (M8) | 3 | 3.6 |
| PLT-026 | arch-review v7; investigation 04 (M8) | 3 | 3.6 |
| PLT-011 | arch-review v7; investigation 06 (AL-5) | 4 | 4.5 |
| SA7-09 | arch-review v7; investigation 02 (H1, H2) | 4 | 4.1 |
| PLT-022 | arch-review v7; investigation 02 (H1, H2) | 4 | 4.1 |
| PLT-006 | arch-review v7; investigation 02 (H2) | 4 | 4.1 |
| PLT-013 | arch-review v7; investigation 02 (H2) | 4 | 4.1 |
| OA-27 | arch-review v7; investigation 02 (H1, H12 step 7) | 4, 8 | 4.1, 8.5 |
| SA7-02 | arch-review v7; investigation 02 (H3) | 4 | 4.2 |
| PLT-015 | arch-review v7; investigation 02 (H3) | 4 | 4.2 |
| DA7-02 | arch-review v7; investigation 02 (H3) | 4 | 4.2 |
| PLT-001 | arch-review v7; investigation 02 (H4, H12 step 4) | 4, 8 | 4.3, 8.2 |
| DA7-05 | arch-review v7; investigation 02 (H4) | 4 | 4.3 |
| SA7-04 | arch-review v7; investigation 02 (H4, H7) | 4, 7 | 4.3, 7.4 |
| SA7-17 | arch-review v7; investigation 02 (H5) | 4 | 4.4 |
| PLT-014 | arch-review v7; investigation 02 (H5) | 4 | 4.4 |
| SA7-03 | arch-review v7; investigation 02 (H6, H12) | 5, 8 | 5.1, 5.2, 5.5, 8.5 |
| PLT-005 | arch-review v7; investigation 02 (H6, H12) | 5 | 5.1, 5.2, 5.5 |
| RC7-12 | arch-review v7; investigation 02 (H6) | 5 | 5.1, 5.2 |
| PLT-008 | arch-review v7; investigation 02 (H9) | 5 | 5.2 |
| INT-019 | arch-review v7; investigation 02 (H6) | 5 | 5.2 |
| PLT-016 | arch-review v7; investigation 02 (H8) | 5 | 5.3 |
| PLT-028 | arch-review v7; investigation 02 (H10) | 5 | 5.3 |
| PLT-012 | arch-review v7; investigation 02 (H10) | 5 | 5.3 |
| SA7-12 (operational parts) | arch-review v7; investigation 02 (H10) | 5 | 5.3 |
| PLT-029 | arch-review v7; investigation 02 (H11) | 5 | 5.4 |
| INT-015 | arch-review v7; investigation 05 (IMG1) | 5, 8 | 5.4, 8.3 |
| PLT-021 | arch-review v7; investigation 05 (IMG1) | 5, 8 | 5.4, 8.3 |
| PLT-024 | arch-review v7; investigation 06 (AL-6) | 5 | 5.4 |
| DA7-12 | arch-review v7; investigation 01 (B9) | 6 | 6.1 |
| DA7-03 | arch-review v7; investigation 01 (B1) | 6 | 6.2 |
| PLT-017 | arch-review v7; investigation 01 (B1) | 6 | 6.2 |
| RC7-11 (recovery part) | arch-review v7; investigation 01 (B1) | 6 | 6.2 |
| PLT-010 | arch-review v7; investigation 01 (B1) | 6 | 6.2 |
| DA7-04 | arch-review v7; investigation 01 (B2, B3) | 6, 8 | 6.3, 8.2 |
| DA7-09 | arch-review v7; investigation 01 (B2) | 6 | 6.3 |
| PLT-004 | arch-review v7; investigation 01 (B2, B8) | 6, 7 | 6.3, 7.2 |
| QA-003 | arch-review v7; investigation 01 (B2, B7, B8) | 6, 7 | 6.3, 7.2, 7.3 |
| DA7-07 | arch-review v7; investigation 01 (B6) | 6 | 6.4 |
| PLT-031 | arch-review v7; investigation 01 (B6) | 6 | 6.4 |
| PLT-030 | arch-review v7; investigation 01 (B6) | 6 | 6.4 |
| DA7-13 | arch-review v7; investigation 01 (B5) | 6 | 6.4 |
| PLT-023 | arch-review v7; investigation 01 (B5) | 6 | 6.4 |
| PLT-007 | arch-review v7; investigation 01 (B7) | 7 | 7.3 |
| PLT-002 | arch-review v7; investigation 02 (H7) | 7 | 7.4 |
| PLT-003 | arch-review v7; investigation 02 (H7) | 7 | 7.4 |
| OA-33 | arch-review v7; investigation 02 (H7) | 7 | 7.4 |
| OA-28 | arch-review v7; investigation 02 (H12 step 3) | 8 | 8.1, 8.5 |
| DA7-17 | arch-review v7; investigation 02 (H12 step 3) | 8 | 8.1 |
| OA-10 | arch-review v7; investigation 02 (H12 step 4); investigation 01 (B3) | 8 | 8.2, 8.5 |
| OA-32 | arch-review v7; investigation 02 (H12 steps 4–5) | 8 | 8.2, 8.3, 8.5 |
| OA-35 | arch-review v7; investigation 02 (H12 step 6) | 8 | 8.4, 8.5 |
| Defect: config files never reached the offsite copy | arch-review v7; investigation 01 (section C, NEW-1) | 6, 7 | 6.4, 7.1 |
| Defect: the core-api queue-clear endpoint lists 5 queues | arch-review v7; investigation 06 (section D) | 2 | 2.6 |
| Defect: the parity cron reports a git ownership refusal as a missing repository | arch-review v7; investigation 02 (section C) | 4 | 4.1 |
| Defect: the data directories inside the working tree are not gitignored | arch-review v7; investigation 02 (section C) | 5 | 5.1 |
| Defect: the "normal deploy" in `deploy.md` recreates `cloudflared` and `faster-whisper` | arch-review v7; investigation 02 (section C) | 5 | 5.3 |
| Defect: the deploy runbook writes rendered compose config to `/tmp` | arch-review v7; investigation 02 (section C) | 5 | 5.2, 5.3 |
| Defect: a restore under production memory settings drops indexes and constraints | arch-review v7; investigation 01 (section C, point 4) | 6 | 6.2 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-11-22 14:02:42*
*Source: /create-plan command*
