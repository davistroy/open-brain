# Data Architect Findings

**Reviewer:** Data Architect
**Date:** 2026-04-18
**Target:** `C:/Users/Troy Davis/dev/personal/open-brain`
**Confidence:** High

---

## Data Store Inventory

| Store | Technology | Data Stored | Access Pattern | Fit Assessment |
|-------|-----------|-------------|----------------|----------------|
| Primary DB | Postgres 16 + pgvector (`pgvector/pgvector:pg16`) | Captures, embeddings (vector(768)), entities, entity graph, associations (Hebbian), activity_feed, audit logs, sessions, file_uploads | Hybrid FTS+vector search (RRF), spreading activation graph walk, soft-delete filtered reads, LISTEN/NOTIFY for SSE | Correct fit. Single-node deployment matches single-user design. pgvector + FTS + relational graph eliminates need for separate vector DB, graph DB, search engine — a deliberate and correct consolidation. |
| Queue | Redis (BullMQ) | Job queues (pipeline stages, skills, scheduled jobs), PWA SW cache, rate-limit counters | Append-heavy, short-lived jobs | Good fit. 5-attempt backoff (30s→2h) + daily sweep is resilient for async pipelines. |
| Filesystem | Docker bind-mounts (`/mnt/user/...`) | File ingest inbox (financial/utility), daily backup artifacts, voice audio | Cron writer, background reader | Adequate; detailed review in Ops / Infra agent. |
| External | OpenAI (text-embedding-3-large `dimensions:768`) | Embeddings only; NOT used for primary storage | Synchronous single-vector | Correct — OpenAI handles MRL natively, schema stays `vector(768)`. |

Data layer is a single-Postgres monolith. No shards, no replicas, no read replica, no write-ahead shipping. For a 1-user / ~12K-row scale this is correct; no scaling pressure is visible yet.

---

## Schema Assessment

**Overall:** Drizzle ORM definitions in `packages/shared/src/schema/` are the conceptual source of truth; hand-written SQL migrations in `packages/shared/drizzle/0001-0022.sql` are what actually runs (there is no auto-migration — `scripts/init-schema.sql` is applied manually on volume recreation). The schema is thoughtfully designed: canonical pair-ordering checks for undirected graph tables (`entity_relationships`, `capture_associations`), partial indexes on hot subsets (deleted_at, container_health.unhealthy, file_uploads.in-flight), expression-based FTS GIN on `to_tsvector('english', content)`, HNSW for vector_cosine_ops with appropriate `m=16, ef_construction=64` for current volume.

**Deliberately tolerated compromise:** CHECK constraint (migration 0022) rather than `pgEnum` for `captures.source`. The rationale in the migration comment is correct: `ALTER TYPE ADD VALUE` commits immediately and removing values requires a table rewrite. The CHECK approach is easier to iterate on in a single-user system. **The 9-value allowlist is verified correct** — matches the `CaptureSource` union in `packages/shared/src/types/capture.ts` exactly: `slack | voice | api | document | mcp | email | file | consolidation | system`.

**Schema drift found (non-trivial):**

1. **`voice_sessions.captures_created` column type mismatch.** Migration `0017_voice_sessions.sql` declares `captures_created UUID[] DEFAULT '{}'`, but Drizzle schema (`packages/shared/src/schema/supporting.ts:407`) declares it as `text('captures_created').array()`. The `init-schema.sql` file similarly declares `UUID[]`. This will cause Drizzle's inferred types to widen to `string[]`, and runtime inserts to route through text casting rather than uuid casting. Likely harmless today because the array only holds UUID strings, but it is a silent drift that bypasses the CHECK the DB would otherwise enforce when inserting a non-UUID value.

2. **`sessions.context_capture_ids` declared `text[]`** (supporting.ts:94) while the values are UUIDs. Same class of issue as #1 — weaker typing than the data warrants. Consistent with the existing pattern but worth noting.

3. **Web UI capture-source filter is stale.** `packages/web/src/components/SearchFilters.tsx:10` hardcodes `CAPTURE_SOURCES: CaptureSource[] = ['slack', 'voice', 'api', 'document', 'mcp', 'email']` — missing `file`, `consolidation`, `system`. The **type** is correct (9 values, `packages/web/src/lib/types.ts:9`); the literal array is 6 values. Consequence: user can never filter for file-ingested, consolidated, or system-emitted captures in the UI. Matches the intake's note that "PR #97 drift-guard covers IngestSourceType + FileUploadStatus but NOT CaptureSource." Drift-guard extension is needed.

4. **`pipeline_status` is free-text** with no CHECK constraint — in contrast to `source` which now has one. Values in the codebase include `pending | processing | embedded | extracted | chunked | complete | partial | failed | deleted | received`. The variety is not a bug but it is untyped at the DB level, and `softDelete()` writes `pipeline_status='deleted'` (capture.ts:217) while other code paths may use `deleted_at IS NOT NULL` alone. The mixed signal (two deletion flags) means a row can theoretically be deleted by one and not the other.

5. **`ai_audit_log.client_used` default is `'litellm'`** (migration 0013 + schema) and the backfill writes `'litellm'` to all historical rows. LiteLLM was removed in CS5 (2026-04-17, PR #88). The column default should be updated to `'openai'` (or the current canonical client name), and a follow-up migration should rename/rewrite historic values to reflect actual provider for audit accuracy. Otherwise cost analytics broken out by client are misleading.

---

## Access Pattern Analysis

**Strong patterns:**
- Search pushes all filters into the SQL function signatures (migration 0009). No more 5x overfetch + in-memory filter pattern.
- Entity resolution uses case-insensitive functional indexes (`lower(name)`, `lower(canonical_name)` in 0004) — lookup is O(log n) rather than full scan.
- `captures_content_hash_idx` is a unique index — dedup is DB-enforced, the 60-second dedup window (capture.ts:11) is a cheap application-level pre-check.
- Pipeline events indexed by `(capture_id)`, `(stage)`, `(created_at)` — all three common query paths are covered.
- Partial indexes (`captures_deleted_at_idx WHERE deleted_at IS NULL`, `container_health_unhealthy_idx WHERE healthy=false`, `file_uploads_status WHERE status IN ('pending','processing')`) trim index size for hot-path queries.

**Inefficiencies and risks:**

1. **Search path uses `SELECT *` twice** (search.ts:245, 341) including the `embedding` column (768 floats × ~8 bytes ≈ 6KB per row). Top-20 search transfers ~120KB of vector data back to Node only to discard it — the embedding isn't used after ranking. Explicit column list excluding `embedding` would save an order of magnitude bandwidth per query. Low impact today at ~12K rows; will become the dominant query cost as captures grow past 100K.

2. **`content_hash` unique index is NOT partial.** Two legitimate captures with identical normalized content across different `brain_view`s (e.g., a personal task and a client reminder with the same text) are permanently blocked. Soft-deleting a capture does NOT free the hash. Better: `CREATE UNIQUE INDEX captures_content_hash_idx ON captures(content_hash) WHERE deleted_at IS NULL`. This lets consolidation/restoration cycles work cleanly. The existing CLAUDE.md rule ("Document upload hashes title, not file content") is a workaround but the underlying global unique is still overly strict.

3. **HNSW index covers soft-deleted rows.** Migration 0001 creates the HNSW index unconditionally on `captures.embedding`; the search function then filters `deleted_at IS NULL` in the CTE after vector matching. Soft-deleted captures consume HNSW graph memory and are probed during recall. Better: `CREATE INDEX captures_embedding_hnsw_idx ON captures USING hnsw (embedding vector_cosine_ops) WITH (m=16, ef_construction=64) WHERE deleted_at IS NULL`. Only relevant at scale, but memory consolidation (runs Sunday 4 AM, source='consolidation') increases soft-deletes over time — eventually the HNSW graph can contain significant dead weight.

4. **No `hnsw.ef_search` configuration.** TDD.md explicitly recommends starting at 40 and tuning up to 100 when recall drops. No `SET hnsw.ef_search = ...` anywhere in code or migrations. Either the pgvector default of 40 is being relied on silently, or the recall tuning was never operationalized. Fine for current scale, but the TDD guidance is not wired up.

5. **No index on `source_metadata` or `source_metadata->>'trace_id'`.** Pipeline trace IDs are stored inside the JSONB `source_metadata` (capture.ts:71) but there is no GIN or expression index on it. Any trace-driven lookup (correlating a capture through pipeline_events) falls back to a table scan. TDD.md line 1888 notes this was *planned* but the migration was not written.

6. **`email_classifications (provider, message_id)` is a non-unique index.** If the email classifier re-processes the same Graph/Gmail message (on retry, reconnect, or script re-run), duplicates are inserted silently. Should be `UNIQUE`.

7. **No indexes on `email_drafts.created_at DESC`-with-status for the review UI**, but `(status)` + `(created_at DESC)` likely scales to the single-user volume.

---

## Data Lifecycle and Governance

| Dimension | Assessment | Finding |
|-----------|-----------|---------|
| Retention policy — captures | Soft-delete only (deleted_at). Memory-consolidation skill soft-deletes originals when `source='consolidation'` merges cluster. | **No hard-purge job.** Soft-deleted rows accumulate indefinitely. At current rate (~50/day) this is decades away from being a problem, but there is no policy decision recorded. |
| Retention policy — high-cardinality append-only | `pipeline_events`, `ai_audit_log`, `mcp_activity`, `activity_feed`, `container_health`, `skills_log` | **No retention policy defined.** All grow unbounded. `container_health` in particular writes one row per container per 15 minutes = ~1,248 rows/day/13 containers ≈ 455K rows/year. `pipeline_events` writes multiple rows per capture per pipeline stage. On a 2026-04-17 audit, these would be material within 6–12 months. |
| PII handling | Voice transcripts (full JSONB), email content (captures + email_drafts.body), capture content (personal notes), email sender addresses in `app_settings.email_allowlist` | **PII is stored in plaintext.** No pgcrypto, no application-layer encryption. Justified by single-user + single-trust-boundary model, but documented nowhere in the schema. Volume backup at rest has whatever protection Unraid provides (which is ad-hoc at best). |
| Encryption at rest | None at DB layer; Unraid storage uses its own disk-level options (reviewable under Ops) | Not flagged as a security finding at single-user trust boundary, but any data escaping the trust boundary (a backup taken to a laptop, a DB dump uploaded to a cloud, etc.) carries the full PII. Daily backup writes `.env.secrets` **into the backup payload** (`backup.sh:80`). Backup protection boundary = filesystem protection of `/mnt/user/backup/openbrain/`. |
| Right to erasure / GDPR | N/A per charter (single-user) | Deliberately out of scope. However: soft-delete preserves the content and embedding; an actual "purge this" operation would require a hard-delete across captures + pipeline_events + entity_links + capture_associations + ai_audit_log. No such operation is implemented. |
| Soft delete vs hard delete | **Mostly soft.** `bet.ts:198` does hard delete (regression test cleanup only). Memory consolidation soft-deletes (preserves originals for undo). `captures.delete_at` is the canonical flag. | Two-signal deletion (pipeline_status='deleted' in `softDelete()` AND `deleted_at`) risks divergence. Search functions filter on `deleted_at IS NULL` only, making the `pipeline_status='deleted'` signal a dead field. Drop one. |
| Backup tested? | Unclear — see Backup & Recovery below. | No automated restore rehearsal test exists. |

### Voice transcript PII — specific concern

`voice_sessions.transcript` is a JSONB array of `{role, content, timestamp}` turns (`supporting.ts:405`, `0017_voice_sessions.sql:11`). Transcripts capture raw speech-to-text and assistant responses, which are typically the richest PII in the system (dates, locations, people names, medical references, financial details). They are stored without encryption, without hash, and the session row is never purged. At a 1-voice-session-per-day cadence, a year's corpus fits in a single `jq` query by anyone with DB read access. Match this against the trust model — if the trust boundary is the Unraid host, fine; if backups travel, this is the richest PII leak surface.

---

## Caching Strategy Assessment

- **TemplateCache (`packages/shared/src/services/template-cache.ts`)** — in-memory; prompt templates loaded once, rendered per call. Correct pattern for the 1.5 GB RSS ceiling; does not need TTL because templates are static.
- **Autonomy level cache (5 minutes)** — simple expiry; documented in CLAUDE.md.
- **PWA service worker** — caches Vite-hashed JS bundles. CLAUDE.md already flags the "stale SW after web rebuild" recurring issue. Not a data-architecture concern, more a deployment choreography one.
- **No Redis cache for search results or entity lookups.** Every search hits Postgres. Correct at current scale; pre-mature to add caching layer.
- **Hit rate observability** — none. No cache_hit/cache_miss metric on TemplateCache or autonomy cache. Low priority.

---

## Schema Evolution Assessment

**How hard is it to evolve the schema today?** Medium.

**What works:**
- Migrations are numbered, versioned, reviewed via PR.
- Drizzle schema + hand-written SQL split is a pragmatic choice — Drizzle can't generate partial indexes, expression indexes, or pgvector types, so raw SQL is needed. Having both is more maintenance but covers the gaps.
- `init-schema.sql` provides a single-file fresh-DB recovery path. It incorporates migrations 0001-0017 inline (a full-restore shortcut).

**What does not work:**
- **`init-schema.sql` is stale as of migration 0018.** It includes 0013-0017 inline but stops there. Migrations 0018-0022 are NOT folded in. If the Postgres volume is recreated, a new deploy has to apply 0018.sql, 0019.sql, 0020.sql, 0021.sql, 0022.sql by hand after init-schema.sql runs. This is documented in CLAUDE.md ("No auto-migration on startup") but `init-schema.sql` is also claimed there as authoritative; those two statements contradict unless you know the inline-migrations convention. Recommend: adopt a strict "init-schema.sql is the concatenation of all 0001-latest migrations" convention and regenerate on each merge, OR drop init-schema.sql entirely and require `for f in drizzle/0*.sql; do psql ... < $f; done`.
- **No idempotency test** — migrations don't have a CI job that applies them against a blank Postgres container and checks for errors. A broken migration (like the `plainplainto_tsquery` typo in 0002 that had to be fixed by 0006) isn't caught until someone runs it.
- **No migration rollback path.** Each migration is DDL-forward-only. For a single-user system, fine; but destructive migrations (column renames, type narrowings) need a rollback plan and there is no convention.
- **Drizzle meta directory** (`packages/shared/drizzle/meta/`) contains Drizzle's internal migration journal. This needs to stay in sync with the SQL migrations. A new team member running `drizzle-kit generate` would produce drift.

**What was just fixed:**
- The 0022 CHECK constraint + mandatory pre-flight audit rule (PR #101, CLAUDE.md) is exactly the right pattern. The rationale block at the top of 0022 documenting why `pgEnum` was rejected is model-quality schema documentation.

---

## Backup and Recovery

| Store | Backup Mechanism | RTO | RPO | Tested? |
|-------|------------------|-----|-----|---------|
| Postgres | `scripts/backup.sh` → daily cron 3 AM (per intake "ad-hoc VM cron 2 AM" — actual script has 3 AM). `pg_dump --format=custom --compress=6` + schema-only dump. 14 daily / 4 weekly (Sunday) / 3 monthly (1st) retention. | Not defined. Single-user tolerance high. | 24 hours. | No documented restore rehearsal. **Untested backups are schrodinger-backups.** |
| Redis | BGSAVE + `docker cp /data/dump.rdb` | Same cron as above. | 24 hours, but Redis is queue state — reset after crash is acceptable for BullMQ. | No. |
| Wiki (Gitea) | `git bundle --all` of `/tmp/open-brain-wiki` inside a running container | Same cron. | 24 hours. Redundant with Gitea's own storage. | No. |
| Config / .env | `cp` of `config/*.yaml`, `.env`, `.env.secrets`, `docker-compose.yml` into backup dir | Same cron. | 24 hours. | No. |

**Significant findings:**

1. **`.env.secrets` is copied into every backup.** `scripts/backup.sh:80` unconditionally copies `.env.secrets` to `${BACKUP_DIR}/config/dot-env-secrets`. The backup directory is `/mnt/user/backup/openbrain/` which is filesystem-protected but not encrypted. CLAUDE.md says "All secrets via Bitwarden (bws CLI) — never in .env files" as policy, but `.env.secrets` exists on disk at runtime and is then copied to backup. **Secrets are duplicated into backup artifacts that will eventually be off-site.** Verify backup destination trust boundary or redact secrets from backup payload (e.g., `bws get` at restore time instead of backing up the file).

2. **No offsite replication from the scripts in the repo.** The intake said "weekly offsite to Google Drive via rclone (30-day cloud retention)" from TDD.md. `scripts/backup.sh` does not perform rclone upload. Either it lives in a separate cron not in this repo (plausible) or the offsite is aspirational. Flag for confirmation.

3. **No restore test.** Neither the backup script nor CI exercises a `pg_restore` pass. A broken `pg_dump` (wrong permissions, missing extension, schema change that corrupts custom format) is discovered only when the restore is needed. Recommended: monthly maintenance cron includes `pg_restore --list` against the latest dump to verify readability.

4. **HNSW index is NOT preserved across pg_dump restore without care.** `pg_restore` rebuilds indexes from their DDL, which means the 768-dim HNSW has to be rebuilt on restore. At current volume this takes seconds; at 100K+ rows it takes minutes; at 1M rows, it can take tens of minutes. Document the expected restore duration.

5. **Backup retention policy violated the intake's stated policy.** Intake says "ad-hoc VM cron daily at 2 AM." The script in repo (`scripts/backup.sh`) is a 14/4/3 tiered retention — richer than "ad-hoc," if it's wired. Recommend: reconcile which is actually running on homeserver by examining `crontab -l` and update the intake.

---

## Cost-Tiered Processing — Data Layer Implications

The T0–T3 tiering is primarily an LLM-layer concern but has two data-architecture consequences:

- **`ai_audit_log` is the cost-attribution ground truth.** It logs `client_used`, `cost_usd` per call. The circuit breaker reads from this table. This is correct. But note: cost-incident recovery (the 2026-04-15 $100 Anthropic incident in MEMORY) happened because `cost_per_1k` was zero in `ai-routing.yaml`, NOT because `ai_audit_log` was broken. The audit log correctly captured zero cost because the config said zero cost. Consider: add a CHECK on `ai_audit_log.cost_usd > 0` for paid-tier models, and a daily assert job that verifies paid-tier rows have non-null cost. Cheap insurance against the same class of config bug.
- **No embedding cost tracking.** OpenAI embeddings at `text-embedding-3-large` with 768-dim output are billed by token. There is no separate audit row per embedding call visible in the schema — or the intent is for embedding calls to flow through the same `ai_audit_log` as LLM calls. Verify this is the case, because embeddings are the #1 cost line after T3 LLM.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 7 |
| Low | 5 |
| Requires Investigation | 2 |
| **Total** | **17** |

### Critical
(none)

### High
1. **Backup copies `.env.secrets` into the daily backup payload.** `scripts/backup.sh:80`. Violates the stated "never write secrets to disk" policy the moment a backup is taken off-host. Remediate by either redacting secrets from the backup, backing up a `bws`-reference stub instead, or explicitly marking backup storage as a trusted secret custodian and documenting that in the threat model.
2. **No backup restore rehearsal.** No CI or cron verifies the `pg_dump` is restorable. Recommend monthly `pg_restore --list $LATEST_DUMP` smoke test; quarterly full restore into a scratch Postgres to a recent backup.
3. **Web UI `CaptureSource` filter is stale (6 values vs 9 canonical).** `packages/web/src/components/SearchFilters.tsx:10`. User cannot filter for `file | consolidation | system` captures. Extend drift-guard from PR #97 to cover this literal.

### Medium
4. **`content_hash` unique index is not partial on `deleted_at IS NULL`** — soft-deleting does not release the hash, blocking legitimate re-captures after consolidation.
5. **HNSW index covers soft-deleted rows** — memory consolidation silently grows HNSW graph dead weight. Add `WHERE deleted_at IS NULL`.
6. **No retention policy on append-only tables** — `container_health` (~455K rows/year), `pipeline_events`, `ai_audit_log`, `mcp_activity`, `activity_feed`, `skills_log` all grow forever.
7. **`voice_sessions.transcript` PII is stored plaintext + never purged.** Richest PII surface in the system. Consider retention (e.g., soft-delete transcripts > 90 days) or field-level encryption if backups travel.
8. **Schema drift: `voice_sessions.captures_created` declared `text[]` in Drizzle, `UUID[]` in migration SQL.** Silent; types widen to `string[]`.
9. **`email_classifications (provider, message_id)` is non-unique** — re-processing creates duplicates. Make it UNIQUE.
10. **`ai_audit_log.client_used` default is stale `'litellm'`** — LiteLLM was removed in CS5 (PR #88). Update default and document provider rename semantics.

### Low
11. **Search `SELECT *` pulls `embedding` column unnecessarily** — ~6KB/row wasted bandwidth per search. Explicit column list would help at 100K+ scale.
12. **No GIN index on `source_metadata` / `source_metadata->>'trace_id'`** — trace correlation falls back to sequential scan. TDD notes this was planned but never migrated.
13. **No `hnsw.ef_search` configuration** — relies on pgvector default (40). TDD guidance (tune up to 100 when recall drops) is not operationalized.
14. **`pipeline_status` is free-text, no CHECK constraint** — 10+ distinct values in code; `softDelete()` sets `pipeline_status='deleted'` AND `deleted_at` (two signals of the same state).
15. **`init-schema.sql` stops at migration 0017** — migrations 0018-0022 must be applied separately after init. Document the convention or regenerate init-schema.sql on each merge.

### Requires Investigation
16. **Offsite backup (rclone to Google Drive, per TDD.md line 4021)** — script does not appear in `scripts/`. Confirm whether this is running via a separate cron on homeserver or is aspirational.
17. **Embedding cost tracking in `ai_audit_log`** — verify embedding calls write rows with `task_type='embed'` and populate `cost_usd`, otherwise #1 variable cost is untracked at the DB layer.

---

## Architecture-Level Observations

- **The schema design is above average for a personal project.** Canonical pair-ordering on undirected graph tables, partial indexes on hot subsets, expression indexes for case-insensitive lookup, GIN on `to_tsvector('english', ...)` rather than a denormalized tsv column — these are patterns you'd expect from a team with dedicated DB expertise, not a single operator. The quality of the 0022 migration comment block (explaining WHY pgEnum was rejected) shows mature schema thinking.
- **The data layer is under-instrumented relative to the LLM layer.** There is no `pg_stat_statements` configured anywhere in repo. `VACUUM/ANALYZE` isn't referenced. Query-cost observability gap is the cleanest next win — before optimizing any individual query, turn on pg_stat_statements and learn what's actually slow.
- **Drizzle + raw SQL migration split is load-bearing.** Nothing in CI enforces that the Drizzle schema matches the SQL migrations. The `voice_sessions.captures_created` drift found above would have been caught by a CI step that does `drizzle-kit generate` and diffs against the hand-written SQL. Recommend: add a CI job that runs drizzle introspection against a container post-migration and asserts column types match Drizzle definitions.
- **The 9th source value (`'system'`) surfacing 1 day before this review (intake note on PR #101)** is a case study for the "pre-flight audit before CHECK migrations" rule that was just added. The fact that this system caught the 9th value before the constraint was applied is a win; the fact that the ultra-plan investigation missed `bet.ts` initially is a correctable process gap. The new CLAUDE.md operational rule is well-placed.
