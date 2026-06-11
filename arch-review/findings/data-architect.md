# Data Architect Findings

**Reviewer:** Data Architect
**Date:** 2026-06-10
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High

> Supersedes the 2026-04-18 data-architect review. Items remediated via PRs #180–#189 were verified closed and are not re-reported. Known/accepted baselines (A130, A128/A116/A117/A106/A120, no-Bearer admin reset) are not re-reported.

---

## Data Store Inventory

| Store | Technology | Data Stored | Access Pattern | Fit Assessment |
|-------|-----------|-------------|---------------|----------------|
| Postgres 16 + pgvector 0.8 (`pgvector/pgvector:pg16`) | Relational + vector(768) + FTS | Captures, embeddings, entities/graph, sessions, briefs, lab_results, insurance_policies, commitments, audit tables (28 tables) | Hybrid FTS+HNSW search via `hybrid_search()`, graph traversal via `spreading_activation()`, OLTP CRUD, append-only audit | **Strong fit.** One store covers vector, FTS, graph-lite, and OLTP — right call at 11K-capture scale. Tuned conf (shared_buffers 2GB, work_mem 64MB; max_connections 50 vs pool max 20/service across ~5 services — adequate but near ceiling) |
| Redis 7 (alpine, AOF on) | KV / queues | BullMQ jobs (14+ queues), admin reset tokens (5-min TTL), banner (30-day TTL), TTS audio cache (24h TTL), Composio monthly quota counters | Queue ops, single-key get/set | **Good fit.** AOF persistence + daily RDB copy in backup. No maxmemory set — acceptable with noeviction default for BullMQ correctness |
| Gitea git repo (open-brain-wiki) | Git/markdown | Wiki pages, storage-audit reports | Batch write from workers, clone on startup | Good fit; backed up as git bundle |
| In-process caches | Module-level JS | Autonomy level (5-min TTL in slack-bot + workers), pipeline config | Read-heavy | Fine; documented invalidation lag is by design |
| Filesystem volumes | Docker volumes / bind mounts | Ingest drop zone (`file_uploads.destination_path`), `admin_prewipe_backup` pre-wipe pg_dumps | Write-once | Adequate; pre-wipe volume has no pruning (folded into L2) |

Tool availability: psql/mysql/sqlite3/mongosh/redis-cli all unavailable in this environment — review is static (code + SQL); no live-DB verification of index usage, bloat, or row counts.

---

## Schema Assessment

The schema is well-modeled for its access patterns:

- **Captures as the hub** with `content_hash` dedup (unique index), soft delete (`deleted_at`), pipeline state-machine columns, and access-stats columns (`access_count`, `last_accessed_at`) for ACT-R decay. Indexes line up with query predicates (type/view/source/status/created_at).
- **Enum discipline is exemplary**: TEXT + CHECK constraints (migrations 0022/0024/0025/0026) with canonical TS unions and documented lockstep rules — far easier to evolve than native enums. **Exception:** `file_uploads.status` uses a native Postgres `ENUM` type (0021) — the only one in the schema; adding a status there requires `ALTER TYPE` instead of a constraint swap (L4).
- **Graph tables** (`entity_relationships`, `capture_associations`) enforce canonical pair ordering (`a < b`) via CHECK + unique index — correct undirected-edge modeling that prevents the (A,B)/(B,A) duplication class.
- **vector(768)** consistently; HNSW (m=16, ef_construction=64) on captures + triggers; expression-based GIN FTS index (no `tsv` column to keep in sync) — all appropriate.
- **briefs** (0030) stores rendered `body_html` + JSONB toc/sources, a partial unread index, and a refinement-chain self-FK — denormalization justified for a read-heavy single-user inbox.
- `ai_audit_log.session_id` is FK-less (forward-ref) and `voice_sessions.captures_created UUID[]` is an FK-less array — minor referential-integrity soft spots, acceptable at this scale.

---

## Access Pattern Analysis

- **No N+1 patterns found in hot paths.** `SearchService` hydrates results with one `WHERE id = ANY(uuid[])` query; spreading activation hydrates the same way; `upsertCoAccessAssociations` is a single batch UPSERT regardless of pair count (verified); the ingest N+1 fix from PR #180 stands.
- **`hybrid_search()` LIMIT push-down (0027) verified intact** — both CTEs bound at `match_count * 4`, keeping HNSW early-stop active. Per-query ef_search injected from config, not hardcoded. Good.
- **(L1) `SET hnsw.ef_search` race on pooled connections** — `packages/core-api/src/services/search.ts:225` issues a session-level `SET` as one `db.execute`, then calls `hybrid_search()` in a second `db.execute`. With `pg.Pool` (max 20), the two statements can run on *different* connections; a search may execute with default ef_search until all pooled connections have eventually been "painted" with the setting. The code comment correctly notes `SET LOCAL` is a no-op outside a transaction — the fix is to wrap `SET LOCAL` + the function call in one transaction (or pin a client via `pool.connect()`). Converges over time and all searches use the same value, so impact is nondeterministic early-life behavior only.
- **(M3) `access-stats` job retention gap** — core-api instantiates its own `new Queue('access-stats', { connection })` (`packages/core-api/src/index.ts:96`) with **no `defaultJobOptions`**, while the workers-side factory (`packages/workers/src/queues/access-stats.ts`) sets `removeOnComplete: {count: 100}` / `removeOnFail: {count: 50}` plus `attempts: 1`. BullMQ applies retention from the *producer's* job options at `add()` time — and the producers are the 5 search sites in core-api. Result: every search leaves a completed-job record in Redis forever, and jobs get default retry semantics instead of the intended single attempt. This is the failure mode the "cross-package queue instantiation" rule invites: Redis routes by queue *name*, but `defaultJobOptions` do not travel with the name. Slow leak (one hash per search), unbounded. Fix: copy the job options into the core-api Queue instantiation and add a parity test. All other queues audited carry explicit retention (10–500 kept).
- Raw SQL usage is disciplined: parameterized `sql` templates throughout; the two `sql.raw()` sites (ef_search int from zod-validated config; staleDays internal default) are not reachable from user input.
- `db.select()` (full-row) is pervasive but all hot-path uses carry `limit()`/keyed predicates; acceptable.

---

## Data Lifecycle and Governance

| Dimension | Assessment | Finding |
|-----------|-----------|---------|
| Retention policy | Partial | Hebbian associations pruned weekly (weight < 0.1 AND stale > 90d) — good. **No retention for append-only tables**: `pipeline_events` (~5–10 rows/capture), `ai_audit_log`, `activity_feed`, `mcp_activity`, `email_classifications`, plus the `admin_prewipe_backup` volume dumps. Unbounded but slow growth; storage-audit skill observes size weekly but nothing acts (L2) |
| PII handling | High-sensitivity data, perimeter-only controls | Health labs (0028), insurance policies incl. `insured_name`/`policy_number`/`raw_text` (0029), voice transcripts + GPS location (`voice_sessions.transcript`, captures `source_metadata.location`), email content, financial data — all plaintext in one DB. Acceptable for a single-user self-hosted system, but there is **no data-classification inventory** distinguishing "annoying to leak" from "regulated-equivalent" (health/financial) data (folded into M4) |
| Encryption at rest | **Absent** | No pgcrypto, no volume encryption indicated; pg_dump backups and Redis RDB are plaintext on the Unraid array. Threat-model gap is physical theft / disk RMA of a home server holding health + financial + location history (M4) |
| Right to erasure / GDPR | Incomplete by construction | Capture DELETE is soft-delete only (`deleted_at` + status `deleted`); content, embedding, and entity links remain in the live DB indefinitely and in 14 daily + 4 weekly + 3 monthly backups. No hard-purge job exists. GDPR doesn't apply (own data), but "I want this gone" currently isn't achievable without manual SQL plus ~3 months of backup expiry (L6) |
| Soft delete vs hard delete | Mostly consistent, two gaps | Read paths filter `deleted_at IS NULL` (capture service, `hybrid_search`, `fts_only_search`) — **except** `spreading_activation()` (0012) and its hydration query in `findRelatedCaptures()`, neither of which filters `deleted_at`. Soft-deleted captures — including originals destructively merged by memory-consolidation — can resurface through `include_related` search, which defaults **true** on MCP (M2). Also: the global unique index on `content_hash` means re-capturing content identical to a soft-deleted capture 409s against an invisible row; should be a partial unique index `WHERE deleted_at IS NULL` (L3) |

- Admin wipe controls verified as documented: two-step token + confirmation phrase + origin allowlist; `admin_audit` excluded from TRUNCATE with a code-level test; pre-wipe pg_dump to a dedicated volume. Good.
- **(L5)** `email_classifications` has an index on `(provider, message_id)` but **no unique constraint** — pipeline re-runs can insert duplicate classification rows for the same message, skewing daily summaries. Sibling tables (`lab_results`, `insurance_policies`) got idempotency keys; this one didn't.

---

## Caching Strategy Assessment

- **TTL discipline is good where Redis is used as a cache**: reset tokens 5-min single-use (atomic GETDEL), banner 30-day, TTS audio 24h keyed `tts:{brief_id}:{voice}`. Composio quota counters are monthly-keyed without TTL (12 keys/year — fine, and arguably correct to retain for history).
- **In-process autonomy cache** (5-min TTL, module-level, per package) has a documented worst-case 5-minute lag on autonomy *downgrades* — after dropping from `partner` to `observe`, a worker can still act autonomously for up to 5 minutes. Accepted by design; noted, not counted.
- **No cache hit-rate observability** — none of the caches emit metrics. Low stakes at this scale; not counted as a finding.
- **Invalidation correctness**: no shared mutable cache exists whose staleness could corrupt data; the riskiest pattern (pipeline config) is read-at-startup, invalidated by restart. Sound overall.

---

## Schema Evolution Assessment

This is the weakest area of an otherwise strong data architecture.

- **(M1) There is no migration ledger.** `packages/shared/drizzle/meta/` contains only `.keep` — no `_journal.json`, no snapshots. `scripts/migrate.sh` calls `pnpm drizzle-kit migrate`, which **requires the journal and cannot apply these migrations** — the script is effectively dead code, and the real process is the CLAUDE.md rule "manually apply init-schema.sql + all 0*.sql, check `\dt` first." Nothing records *which* migrations a given database has received. This process has already produced incidents (Entry 089 pre-flight audits, repeated init-schema drift, homeserver manual application through 0031). Fix options: restore the drizzle journal + migrations table, or adopt a minimal `schema_migrations` ledger applied by a loop script.
- **(H1) `scripts/init-schema.sql` drift is worse than documented.** The known issue says 0012/0028/0030 are missing. Verified missing: `spreading_activation()` (0012), `lab_results` (0028), `briefs` (0030) — **and also `app_settings` (0010), which is not in the known-issue list** (zero hits for "settings" in init-schema.sql; 25 CREATE TABLEs present vs 28+ expected). Compounding it: both integration-test setups bootstrap **exclusively from init-schema.sql**, and `packages/workers/src/__tests__/integration/setup.ts:62` falsely claims it is "the single source of truth (all tables through migration 0031)." Consequences: (a) CI integration tests run against a schema that diverges from production — any code path touching `app_settings`, `briefs`, `lab_results`, or `spreading_activation` is untestable in integration (search integration tests indeed pin `include_related: false`); (b) a fresh disaster bootstrap that runs only init-schema.sql silently lacks the settings store holding the email allowlist and autonomy level. Fix: regenerate init-schema.sql from `pg_dump --schema-only` of a fully-migrated DB (the daily backup already produces exactly this artifact as `schema.sql`), and add a CI parity check (apply init-schema vs apply all migrations into two scratch DBs, diff `pg_dump --schema-only` output).
- Positives: migrations are mostly idempotent (`IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` from 0023 onward, DO-block enum guard in 0021); each carries rollback notes; CHECK-constraint migrations follow the mandatory pre-flight DISTINCT audit; slot pre-assignment (0028 vs 0029) avoided a parallel-work collision. The TEXT+CHECK enum strategy keeps column evolution cheap. Migration 0001 still has non-guarded `CREATE TRIGGER`s, but in practice it is only applied to virgin databases — not counted separately.

---

## Backup and Recovery

| Store | Backup Mechanism | RTO | RPO | Tested? |
|-------|-----------------|-----|-----|---------|
| Postgres | Daily 03:00 `pg_dump` custom format + schema-only dump + manifest with row counts; retention 14d/4w/3m | ~1–2h (manual restore; runbook exists) | 24h | **Yes — weekly automated restore rehearsal** (Sunday 05:30): ephemeral pgvector container, `pg_restore --exit-on-error`, row counts vs manifest ±10%, Pushover on fail. Best-in-class for a home lab |
| Redis | AOF (`--appendonly yes`) + daily BGSAVE→RDB copy with LASTSAVE polling | Minutes | ~seconds via AOF (same host); 24h for the RDB copy | Implicitly (AOF replay on restart); RDB restore not rehearsed — acceptable, queue state is reconstructible |
| Wiki | Daily git bundle (`--all`) from a container clone | Minutes | 24h | Bundle integrity implicit; Gitea origin is itself a live replica |
| Secrets | Bitwarden (source of truth); backup deliberately excludes `.env.secrets` (regression-guard script verified present); `load-secrets.sh`/`verify-secrets.sh` round-trip with SHA256 drift alerting | Minutes | n/a | Yes — `test-secrets-roundtrip.sh` 5-case fixture |

- **(H2) No offsite copy — 3-2-1 fails at the "1".** `BACKUP_ROOT=/mnt/user/backup/openbrain` lives on the **same Unraid chassis** as `postgres_data`. A repo-wide search found no rsync/restic/rclone/B2/S3 step for the openbrain backup tree (the only rclone config is OneDrive *ingest*). Fire, theft, ransomware, or simultaneous multi-disk failure destroys primary and all ~21 retained backups together. The data is explicitly irreplaceable (11K+ captures, health/financial/insurance records). Mitigation is cheap: nightly restic/rclone push of `latest/` (one pgdump + bundle) to B2/S3 or even another LAN host with separate failure domain (bond/Spark). **Requires investigation (R1):** whether host-level urBackup or other replication already covers `/mnt/user/backup` — not verifiable from the repository; if it does, downgrade H2 to Low and document it in the backup runbook.
- No WAL archiving / PITR — RPO is a hard 24h. For a capture system fed by Slack/email/voice (sources that are themselves retainable), losing up to a day is a tolerable, conscious trade; noted in the table, not counted as a separate finding.
- `wal_level = replica` is set but unused (no replica, no archive_command) — free option value, no action needed.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 2 |
| Medium | 4 |
| Low | 6 |
| Requires investigation | 1 |

**High**
- **H1** — init-schema.sql drift larger than documented: missing `app_settings` (0010) in addition to known 0012/0028/0030; integration tests bootstrap solely from this drifted file, so CI schema ≠ production schema (the "single source of truth through 0031" comment in `packages/workers/src/__tests__/integration/setup.ts:62` is false). Regenerate from `pg_dump --schema-only` and add a CI parity check.
- **H2** — Backups have no offsite copy; primary data and all retained backups share one chassis (final severity pending R1).

**Medium**
- **M1** — No migration ledger; drizzle `meta/` is empty so `scripts/migrate.sh` (`drizzle-kit migrate`) cannot work; applied-migration state per environment is tribal knowledge.
- **M2** — `spreading_activation()` (0012) and `findRelatedCaptures()` hydration do not filter `deleted_at` — soft-deleted/consolidated captures resurface via `include_related` (default true on MCP).
- **M3** — core-api's `access-stats` producer Queue lacks `defaultJobOptions`; every search leaks a completed-job record into Redis indefinitely and bypasses the intended `attempts: 1` (workers-side factory options don't apply to core-api's adds).
- **M4** — No encryption at rest for health/insurance/financial/location/voice data; pg_dump backups and RDB are plaintext on the same array; no data-classification inventory.

**Low**
- **L1** — `SET hnsw.ef_search` issued on a pooled connection separate from the `hybrid_search()` call; nondeterministic ef_search until the pool converges. Wrap in a transaction with `SET LOCAL`.
- **L2** — No retention for append-only tables (`pipeline_events`, `ai_audit_log`, `activity_feed`, `mcp_activity`, `email_classifications`) or the pre-wipe dump volume.
- **L3** — Global unique `content_hash` index blocks re-capturing content identical to a soft-deleted capture; should be partial (`WHERE deleted_at IS NULL`).
- **L4** — `file_uploads.status` is the schema's only native Postgres ENUM, breaking the TEXT+CHECK convention and complicating evolution.
- **L5** — `email_classifications` lacks a unique constraint on `(provider, message_id)`; re-runs can duplicate rows.
- **L6** — Right-to-erasure is incomplete: soft delete retains content + embedding live and in backups up to ~3 months; no hard-purge path exists.

**Requires investigation**
- **R1** — Verify whether host-level replication (urBackup or other) already copies `/mnt/user/backup/openbrain` off-chassis; determines final severity of H2.
