# Data Architect Findings

**Reviewer:** Data Architect
**Date:** 2026-07-12
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High

> **v5 — supersedes the 2026-07-09 v4 review.** Per the adjudication mandate, every v4 finding was re-verified against HEAD (`cd14c1f`) before net-new hunting. The only code merged since v4 is the Dependabot remediation (PRs #232–#234: hono 4.12.5→4.12.25, nodemailer 8→9, vitest 2→3 + coverage backfill + dead-code removal) — **none of it touches the data layer** (pg, drizzle-orm 0.45.2, ioredis, bullmq all unchanged in package.json and lockfile; verified via `git diff fbe7d14..HEAD`). The core-api dead-code removal (`8d3b426`: `services/sse.ts`, `services/index.ts`, `schemas/index.ts` barrels) was verified genuinely dead — the real `upload_status` pg_notify publisher lives in `packages/workers/src/jobs/ingest-process.ts:67` and the LISTEN/SSE forwarder in `core-api/src/lib/pg-notify.ts:32` are both intact. Read-only code review: no live DB queried.

---

## Prior-Review Adjudication (v4 → v5)

**Verdict: 11 of 11 findings STILL OPEN; 0 FIXED; 1 CHANGED (DA-1 urgency escalated — go-condition deadline missed). Both RIs still open.** Evidence per finding:

| v4 ID | Sev | Status | Evidence at HEAD (`cd14c1f`) |
|-------|-----|--------|------------------------------|
| **DA-1** skills_log prune FK-blocked | High | **STILL OPEN — CHANGED (escalated urgency)** | No migration 0036 exists (`packages/shared/drizzle/` ends at `0035_retention_audit.sql`). `0030_briefs.sql:25` still `source_skill_log_id UUID REFERENCES skills_log(id)` with **no ON DELETE** (confirmed `init-schema.sql:1816` — bare FK, NO ACTION). `data-retention-prune.ts:29-35` still lists `skills_log` (last), `pruneRetentionData()` (:80-118) still has **no per-entry try/catch**. The fix deadline (Sun 2026-07-12 02:00) **passed unmet this morning** — today's scheduled run is the second production run (after 2026-07-05) that plausibly failed on the skills_log DELETE (SQLSTATE 23503). See DA-1 detail below. |
| **DA-2** plaintext OAuth in app_settings, readable via unauthenticated GET | Medium | STILL OPEN | `routes/settings.ts:15-38` — single `VALID_SETTINGS_KEYS` set still includes `ms_token_cache_node`, `gmail_token_cache`, `gmail_credentials`; same set gates GET (:74-77) and PUT (:87-89). No READABLE_KEYS split, no redaction, no pgcrypto. Credentials still ride into plaintext local pg_dump backups. |
| **DA-3** container_health & other event tables unbounded | Medium | STILL OPEN | `RETENTION_POLICY` (data-retention-prune.ts:29-35) unchanged — 5 tables only. `container_health` (~1.2K rows/day), `email_classifications`, `voice_sessions`, `entity_relationships`, `retention_audit` itself still unbounded. |
| **DA-4** TTS binary cache co-tenant with BullMQ in 400 MB noeviction Redis | Medium | STILL OPEN | `routes/briefs.ts:201,257` — `getBuffer`/`setex(cacheKey, 86400, audioBuffer)` unchanged; same Redis, no size guard, compose redis flags unchanged. |
| **DA-5** HNSW post-filter recall / no iterative_scan / non-partial index / no tombstone purge | Medium | STILL OPEN | Zero `iterative_scan` hits repo-wide; `init-schema.sql:1378` HNSW index still non-partial; no hard-purge job for `deleted_at IS NOT NULL` rows (grep confirms none added). |
| **DA-6** no encryption at rest for health/insurance/credential data | Medium | STILL OPEN | Zero `pgcrypto`/field-encryption hits in packages/scripts/config. Offsite rclone-crypt remains the only encrypted copy. |
| **DA-7** dead `fts_search()` SQL function | Low | STILL OPEN | Still defined at `init-schema.sql:133`; still zero TS callers (only `fts_only_search` used). No 0036 to drop it. |
| **DA-8** array-of-ID columns / unenforced refs / text date PK | Low | STILL OPEN | No schema migrations since v4 — all cited columns unchanged. |
| **DA-9** count-only `removeOnFail` except skill-execution | Low | STILL OPEN | Grep confirms: `skill-execution.ts:32` is still the only queue with `age: 14d`; all other queues (capture-pipeline, embed-capture, ingest-process, wiki-ingest, access-stats, notification, etc.) remain count-only. |
| **DA-10** document dedup by title-hash | Low | STILL OPEN | `routes/documents.ts:228,385` — `[Document] ${title}` hash basis unchanged. |
| **DA-11** postgres `shm_size: 512mb` absent from compose | Low | STILL OPEN | Zero `shm_size` hits in any compose file. Deferral still awaiting the batched daemon-restart window. |
| **RI-A** verify prod retention_audit / failed jobs | Investigate | STILL OPEN — **now more urgent** | Live homeserver out of scope (read-only review). With today's 02:00 run past, `retention_audit` should show rows for the first 4 tables and NONE for `skills_log` on both 2026-07-05 and 2026-07-12 if DA-1 is live; BullMQ `data-retention-prune` failed set should show 2 entries. One SQL check settles it. |
| **RI-B** A131: confirm first scheduled offsite-backup + restore-rehearsal runs | Investigate | STILL OPEN | Intake confirms A131 still open; nothing in-repo can verify it. |

No net-new data-architecture findings were introduced by PRs #232–#234 (dependency-only; verified above). The finding set below therefore carries forward from v4 with DA-1 rewritten to reflect its post-deadline state.

---

## Data Store Inventory

Unchanged since v4 (no data-layer code or schema merged). Summary retained for report completeness:

| Store | Technology | Data Stored | Access Pattern | Fit Assessment |
|-------|-----------|-------------|---------------|----------------|
| Primary DB | Postgres 16 + pgvector, 8 GB limit | ~30 tables: captures (content + `vector(768)` + stored tsvector), entities/links/relationships, sessions, briefs, commitments, audit/event tables, lab_results, insurance_policies, app_settings KV | Hybrid FTS+vector SQL functions, Drizzle CRUD, raw SQL in workers | Excellent fit at ~11K captures / single user; Qdrant deferral (#73) sound. |
| Queue/cache | Redis 7.4, AOF, 400 MB `noeviction`, requirepass | BullMQ state, TTS audio cache (24h), Composio meter, admin reset tokens | BullMQ; `getBuffer`/`setex` | Good for queues; noeviction + binary-cache co-tenancy tension (DA-4). |
| Wiki | Git repo (Gitea) | Synthesized wiki pages | git push/pull | Fine; backed up as git bundle. |
| Ingest inboxes / spool | Bind dirs + `voice_spool_data` | Drop files; voice dead-letters | File-move; 30-min spool retry | Appropriate (INT-M4 write-ahead spool). |

Pooling: `createDb()` pg Pool max 20 × 2 owners = 40 vs `max_connections = 50` — adequate single-user, ~10-connection headroom.

## Schema Assessment

Unchanged from v4: enum discipline (CHECK + TS union + Zod + CI drift guards in lockstep) remains exemplary; canonical pair ordering correct; stored `content_tsvector` (0034) well-reasoned; JSONB use minimal and justified. Weaknesses unchanged: array-of-ID columns without referential integrity (DA-8), text date PK in `email_daily_summaries`, title-hash document dedup (DA-10).

## Access Pattern Analysis

Unchanged from v4 — `hybrid_search` LIMIT push-down + SET LOCAL ef_search in txn verified still in place; batch hydration, batched Hebbian UPSERT, `pgUuidArray()` at both sites, bounded monthly-reflection query all intact. The one open access-pattern gap remains **DA-5**: brain_view/type/date/deleted_at are post-filters on a non-partial HNSW index with no `hnsw.iterative_scan` configured, and soft-deleted vectors accumulate in the index forever (no tombstone hard-purge).

## Data Lifecycle and Governance

| Dimension | Assessment | Finding |
|-----------|-----------|---------|
| Retention policy | Partial — RC-4 covers 5 tables with retention_audit logging + admin_audit exclusion invariant | **DA-1 (High, escalated):** skills_log prune FK-blocked, deadline missed 2026-07-12 02:00. **DA-3 (Medium):** container_health et al. unbounded. |
| PII handling | Health (lab_results), insurance (policy numbers, raw_text), email bodies, voice transcripts. Single-user own-data: GDPR structurally moot. | **DA-2 (Medium):** OAuth material plaintext in app_settings, readable via unauthenticated `GET /api/v1/settings/:key` (shared GET/PUT whitelist), present in plaintext local backups. |
| Encryption at rest | None at DB level; local backup tree plaintext; offsite IS encrypted (rclone crypt, keys in BWS only). | **DA-6 (Medium):** explicit accept/mitigate decision still owed; pgcrypto for credential values is the minimum. |
| Right to erasure / GDPR | N/A by design; `/admin/reset-data` = audited total wipe with pre-wipe pg_dump; admin_audit survival invariant tested. | No finding. |
| Soft delete vs hard delete | Captures soft-delete only; 51 filter sites; no hard-purge job — tombstones persist forever. | Deliberate; interacts with DA-5 (folded there). |

### DA-1 (High — go-condition deadline MISSED): `skills_log` retention prune FK-blocked by `briefs.source_skill_log_id`

**Current state at HEAD (all re-verified 2026-07-12):**
- `packages/shared/drizzle/0030_briefs.sql:25` — `source_skill_log_id UUID REFERENCES skills_log(id)`, **no ON DELETE action** (default NO ACTION); confirmed in generated snapshot `scripts/init-schema.sql:1816`.
- **No migration 0036 exists** — `packages/shared/drizzle/` still ends at `0035_retention_audit.sql`.
- `packages/workers/src/jobs/data-retention-prune.ts` unchanged: `RETENTION_POLICY` (:29-35) includes `{ table: 'skills_log', days: 60 }` (last entry), and `pruneRetentionData()` (:80-118) executes a plain `DELETE ... WHERE created_at < NOW() - INTERVAL '60 days'` per table with **no per-entry try/catch** — one FK violation aborts the whole job.
- Briefs are still inserted with `source_skill_log_id` populated (weekly-brief, daily-sweep-skill, morning-brief, monthly-reflection); briefs have no retention (correctly), so referenced skills_log rows age past 60d and become undeletable.

**What changed since v4:** nothing in code — but **the fix deadline (Sunday 2026-07-12 02:00, today) passed unmet**, so the production Sunday run plausibly failed for the second time (first run 2026-07-05). The failure is bounded by lucky ordering — skills_log is last in the array and each table's DELETE + audit runs in auto-commit, so pipeline_events / ai_audit_log / activity_feed / mcp_activity still prune and their retention_audit rows commit — but `skills_log` never prunes, the job fails weekly (feeding the pipeline-health failed>5 alert), and the partial-run state (audit rows for 4 of 5 tables) is an accident of array order, not design.

**Fix (unchanged from v4, now overdue):**
1. Migration 0036: `ALTER TABLE briefs DROP CONSTRAINT briefs_source_skill_log_id_fkey; ALTER TABLE briefs ADD CONSTRAINT briefs_source_skill_log_id_fkey FOREIGN KEY (source_skill_log_id) REFERENCES skills_log(id) ON DELETE SET NULL;` — matches intent (brief survives, provenance nulls; column nullable; partial unique index tolerates NULLs). Then `regenerate-init-schema.sh` + commit both, per the Phase-5 workflow.
2. Defense-in-depth regardless of (1): per-entry try/catch in `pruneRetentionData()` so one table's failure cannot block the others, with a failure row or Pushover per table.
3. Regression test seeding a brief referencing a >60d skills_log row.
4. RI-A: check `retention_audit` (`SELECT table_name, ran_at FROM retention_audit ORDER BY ran_at`) + the `data-retention-prune` failed set to confirm both failed runs, then clear the failed jobs after deploy.

## Caching Strategy Assessment

Unchanged from v4: TTS Redis cache (24h TTL, immutable briefs — invalidation-by-TTL correct) but multi-MB MP3s co-tenant with BullMQ in 400 MB noeviction Redis (DA-4); in-process caches appropriate; TTS hit-rate at debug-log only; `removeOnFail: {age}` still applied only to skill-execution (DA-9 — verified by grep, all other queues count-only).

## Schema Evolution Assessment

Still the strongest part of the system: generated `init-schema.sql` + CI two-DB parity diff + `schema_migrations` ledger + intentional Drizzle exclusions documented at every site. Residual friction unchanged: hand-rolled idempotency discipline; `shm_size: "512mb"` still absent from compose (DA-11 — any future parallel-build migration will hit the 64 MB /dev/shm wall again unless `PGOPTIONS` workaround is remembered); dead `fts_search()` still present (DA-7) — **fold both the FK fix and the `fts_search()` drop into migration 0036** to amortize the migration overhead.

## Backup and Recovery

Unchanged from v4 (no backup-script changes merged):

| Store | Backup Mechanism | RTO | RPO | Tested? |
|-------|-----------------|-----|-----|---------|
| Postgres | `backup.sh` daily 03:00 — pg_dump + exact COUNT(*) manifest; 14d/4w/3m retention; Pushover on failure | Hours | 24h | Weekly `restore-rehearsal.sh` (Sun 05:30); manual rehearsal 2026-06-11 PASSED; **scheduled-run confirmation still pending (RI-B / A131)** |
| Redis | RDB snapshot + AOF | Minutes–hours | 24h | Included; BullMQ state re-derivable |
| Wiki | git bundle + Gitea origin | Minutes | 24h | Bundled daily |
| Offsite | rclone crypt daily 03:45, 30-day retention, `copy` not `sync` (deliberate) | Days | 48h effective | Scheduled-run verification pending (RI-B) |
| Not backed up | voice_spool_data, admin_prewipe_backup, inbox drops | — | — | Acceptable (transient/re-obtainable) |

Secrets redaction regression-guarded; per DA-2 the pg_dump payload itself still contains app_settings OAuth material, which the redaction guard cannot catch by design.

## Findings Summary

| ID | Severity | Status vs v4 | Finding |
|----|----------|--------------|---------|
| DA-1 | High | STILL OPEN — deadline missed, plausibly failing in prod today | skills_log retention prune FK-blocked by `briefs.source_skill_log_id` (NO ACTION); no migration 0036; no per-entry isolation |
| DA-2 | Medium | STILL OPEN | Plaintext OAuth credentials in app_settings, readable via unauthenticated settings GET (shared GET/PUT whitelist), in plaintext local backups |
| DA-3 | Medium | STILL OPEN | `container_health` + other event tables excluded from retention policy — unbounded growth |
| DA-4 | Medium | STILL OPEN | TTS binary cache co-tenant with BullMQ in 400 MB noeviction Redis |
| DA-5 | Medium | STILL OPEN | HNSW post-filter recall; no `iterative_scan`; non-partial index; soft-deleted vectors never purged |
| DA-6 | Medium | STILL OPEN | No encryption at rest for health/insurance/credential data on primary or local backups |
| DA-7 | Low | STILL OPEN | Dead `fts_search()` SQL function (drop in migration 0036 alongside the FK fix) |
| DA-8 | Low | STILL OPEN | Array-of-ID columns / unenforced references; text date PK in email_daily_summaries |
| DA-9 | Low | STILL OPEN | Count-only `removeOnFail` on all queues except skill-execution |
| DA-10 | Low | STILL OPEN | Document dedup by title-hash rejects revised same-title documents |
| DA-11 | Low | STILL OPEN | postgres `shm_size: 512mb` still absent from compose |
| RI-A | Investigate | STILL OPEN (urgent) | Confirm prod retention_audit gaps + 2 failed `data-retention-prune` jobs (2026-07-05, 2026-07-12) |
| RI-B | Investigate | STILL OPEN | A131: confirm first scheduled offsite-backup + restore-rehearsal runs in homeserver logs |

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 5 |
| Low | 5 |
| Requires investigation | 2 |
| **Total** | **13** |
