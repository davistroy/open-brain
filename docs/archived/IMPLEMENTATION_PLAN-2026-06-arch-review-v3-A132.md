# IMPLEMENTATION_PLAN — Arch-Review v3 Remediation (A132)

**Generated:** 2026-06-15 via `/personal-plugin:ultra-plan`
**Source:** `arch-review/reports/executive-summary.md` + 9 domain findings files (2026-06-10 review, main @ ac42938)
**Supersedes nothing** — the prior plan (mobile SPA) was archived 2026-06-11 (`docs/archived/IMPLEMENTATION_PLAN-2026-05-09-MOBILE-SPA.md`)
**Excluded (closed 2026-06-11, Entry 164):** SE-1, RC-1, RC-2, SEC-01, SEC-03 — the immediate-action list
**Total scope:** 10 phases / 4 waves; 15 High + 41 Medium + ~30 actionable Low findings; ~9–11 focused days
**Sequencing:** Waves are strict (gates → fixes → rewrite → hygiene). Phases within a wave may proceed in parallel only where "Depends on" is empty. One PR per phase (sub-PRs allowed for large phases).
**ADRs:** `docs/adr/ADR-0002-lan-exposure-model.md` (**Accepted, amended 2026-06-30**), `docs/adr/ADR-0003-similarity-scan-knn.md` (**Accepted, implemented #225**)

> **🔄 REFRESH 2026-06-30 (`/ultra-plan --refresh`):** **WAVES 1 + 2 COMPLETE** (Phases 1–7 merged to main `9766567`). Phases 2–5 deployed to homeserver 2026-06-29 (Entry 172) with 3 host-local compose deviations; **Phases 6–7 + migration 0034 deployed 2026-06-30 (Entry 175)** — homeserver now current with main `17e17b5` (code). **Phase 8 re-scoped** by the ADR-0002 amendment (Entry 174, D131): core-api stays `0.0.0.0` by owner decision (risk-acceptance), so 8.2 no longer loopback-binds core-api. **✅ A132 COMPLETE 2026-06-30 — all 10 phases / 4 waves merged (main `9e3fb3d`) AND fully deployed** (Phases 8+9+10 + migration 0035, Entry 179). Homeserver runs current main code; 17 containers healthy, retention job registered, voice-capture mounts live, 11,261 captures intact. **Only the Deployment & Ops Backlog remains** (the batched daemon-restart window: observability loopback + postgres `shm_size` + applying the deferred third-party image pins — none blocking).

---

## Plan Summary

| Phase | Change Set | Wave | Effort | Depends on | Status |
|------|-----------|------|--------|-----------|--------|
| 1 | Activate dormant CI gates | 1 | S (~1h) | — | ✅ MERGED #219 (workers `--coverage` → D&O-4) |
| 2 | LAN perimeter — data stores & defaults | 1 | M (~½d) | — | ✅ MERGED #220 + DEPLOYED (Entry 172; core-api row amended → D131) |
| 3 | Recovery & search contract | 1 | M (~1d) | 1 (gates green) | ✅ MERGED #221 + DEPLOYED |
| 4 | Alerting SPOF & deploy pipeline | 1 | M (~½d) | — | ✅ MERGED #222 + DEPLOYED |
| 5 | Schema fidelity machine | 2 | M (~1d) | 1 | ✅ MERGED #223 + DEPLOYED |
| 6 | Integration & spend hardening | 2 | M (~1d) | 1 | ✅ MERGED #224 (no deploy needed; code-only) |
| 7 | Similarity-scan rewrite (k-NN) | 2 | L (~1–1.5d) | 5 (init-schema CI), ADR-0003 | ✅ MERGED #225 + DEPLOYED 2026-06-30 (Entry 175, migration 0034 applied) |
| 8 | Ingest edges + voice auth | 3 | M (~1d) | 2 (SEC-02, **re-scoped per D131**) | 🔶 CODE DONE (8.1/8.3/8.4/8.5/8.6, Entry 176); 8.2 deferred (D132) |
| 9 | Convention→CI + governance/doc sweep | 3 | M (~1d) | 1, 4 | ✅ CODE DONE (9.1–9.7, Entry 177) — migration 0035; PR next |
| 10 | Opportunistic Lows + RI closeouts | 4 | S–M | — | ✅ CODE DONE (10.1–10.5, Entry 178) — **A132 all 10 phases complete**; PR next |

**Migration numbers (claimed in execution order to avoid collision):** ~~0032 (Phase 3)~~ ✅ → ~~0033 (Phase 5)~~ ✅ → ~~0034 (Phase 7, PE-M2)~~ ✅ merged #225 → ~~0035 (Phase 9, RC-4 retention_audit)~~ ✅ **DONE (Entry 177, init-schema parity green).** Next free number: **0036.**

---

## Pre-Plan Gates (Constraints — from CLAUDE.md + Phase 0)

Every work item below complies with these. Three are **flagged decisions** the owner accepted by not overriding at Phase 5 (defaults stand):

| Constraint | Position | Plan compliance |
|---|---|---|
| Cost tiering (T0→T3); never default to API | MANDATORY | No new LLM calls introduced; INT-M2 only *records* existing spend |
| Lab notebook entry before any system-modifying commit | BLOCKING | Each phase opens with a LAB_NOTEBOOK entry |
| No auto-migration on startup | ACTIVE | DA-M1 ledger is a manual `schema_migrations` table (D-3), not drizzle auto-migrate |
| Protect unrecoverable work (backup before mutate) | CRITICAL | Phase 2 backs up `rclone.conf`/compose; Grafana export before any dashboard touch |
| Coverage thresholds may only rise, never fall | ACTIVE | Phase 1 measures first; raises coverage if a file slipped, never lowers a threshold |
| Memory ceiling 1.5 GB/process | ACTIVE | Phase 7 k-NN streams per-candidate (vs self-join materialization) |
| **D-1** core-api exposure | dual-bind loopback + Tailscale IP (ADR-0002) | Phase 2 |
| **D-2** voice path | Bearer on `:3001` now, tunnel later | Phase 8 |
| **D-3** migration ledger | manual `schema_migrations` table | Phase 5 |

---

## WAVE 1 — Gates First, Then the Named Cluster

### Phase 1 — Activate Dormant CI Gates (CS-2)

> Do this first: it protects every subsequent phase's PRs. Main verified green 2026-06-11.

| # | Work item | Files | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 1.1 | **Measure coverage before enabling** (resolves High-severity unknown U-1) | local run only | Run `vitest run --coverage` in workers + core-api; record actuals vs thresholds. | COMPLETE 2026-06-15 — core-api 85.57%/85.66% (pass); **workers 74.02% lines < 78 floor** (functions 82.08% pass, 4 per-file locks pass). Gap 447 lines. |
| 1.2 | **QA-H1**: add `--coverage` to test scripts | `packages/core-api/package.json` (done), `packages/workers/package.json` (deferred) | core-api `test` runs `--coverage`, gate enforced in CI. **workers DEFERRED (Part B)** — 74.02% < 78; raise coverage before enabling, never lower. | PARTIAL — core-api COMPLETE 2026-06-15; workers BLOCKED on 447-line catch-up |
| 1.3 | **QA-H2**: promote `build-and-test` to required check | branch protection (gh api) | required contexts include both `"Integration tests (core-api + real DB)"` and `build-and-test`. | COMPLETE 2026-06-15 |
| 1.4 | **QA-M3**: run INGEST_E2E in CI | `.github/workflows/ci.yml` | ~~workers integration step sets `INGEST_E2E=1`~~ — **DEFERRED**: the e2e suite needs a full stack (core-api + workers + sidecar) but `docker-compose.test.yml` only runs postgres + redis + sidecar; flipping the flag fails (no :3002). QA-M3 is a CI-infra task (stand up the full stack), not a one-liner — re-scoped as its own follow-up. | DEFERRED 2026-06-15 |
| 1.5 | **QA-M4**: secrets regression guards in CI | `.github/workflows/ci.yml` | both guard scripts run as CI steps (verified passing locally). | COMPLETE 2026-06-15 |
| 1.6 | **QA-L11**: make `validate-schema` unconditional | `.github/workflows/ci.yml` | validator runs on every PR (verified passing). | COMPLETE 2026-06-15 |
| 1.7 | **QA-L9**: fix web-next test script | `packages/web-next/package.json` | `"test": "vitest run"`. | COMPLETE 2026-06-15 |
| 1.8 | Correct CLAUDE.md gate claims | `CLAUDE.md` | gate-status corrected with measured numbers. | COMPLETE 2026-06-15 |
| 1.9 | **Bonus (QA-H2 manifest)**: fix pre-existing red main | `synthesize-routes.test.ts` (stale `limit` assertion), 11 vitest-2.x tsc errors in core-api+workers test files | suite green so build-and-test is promotable. | COMPLETE 2026-06-15 |

**DoD (runnable):** `pnpm -r test` (with coverage, green) · `gh api .../branches/main/protection` shows both contexts · draft PR proves both gates block · `.github/workflows/ci.yml` lint passes.

---

### Phase 2 — LAN Perimeter: Data Stores & Default Credentials (CS-1) · ADR-0002

> Protect-unrecoverable: `cp docker-compose.yml docker-compose.yml.bak` and export Grafana before touching it.

| # | Work item | Files | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 2.1 | **SEC-02 (data stores)**: bind to `127.0.0.1` | `docker-compose.yml` | postgres:5432, redis:6380, pushgateway:9091, prometheus:9090, loki:3100, file-ingestion:8080, faster-whisper:10300 publish on `127.0.0.1` only. web-next:3003 + grafana:3050 stay LAN. (voice-capture:3001 deferred to Phase 8.) | CODE COMPLETE 2026-06-15 (deploy pending) |
| 2.2 | **SEC-02 (core-api dual-bind)**: loopback + Tailscale | `docker-compose.yml`, `.env`, `.env.example` | core-api publishes `127.0.0.1:3002` **and** `${TAILSCALE_IP:-100.101.61.122}:3002`; OpenClaw MCP from bond.k4jda.net still reaches `100.101.61.122:3002/mcp`. | CODE COMPLETE 2026-06-15 (deploy pending) |
| 2.3 | **SEC-08**: Redis requirepass | `docker-compose.yml` + P08 lockstep | `redis-server … --requirepass ${REDIS_PASSWORD}`; new `REDIS_PASSWORD` in BWS → `.env.secrets.template` + `scripts/lib/secrets-map.sh` → `REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379` in all consumers (core-api, workers, slack-bot). | CODE COMPLETE 2026-06-15 — lockstep + fixture done (deploy pending) |
| 2.4 | **SEC-11 + PLT-L1**: fail-closed credentials | `docker-compose.yml` | `POSTGRES_PASSWORD:?…` and `GRAFANA_ADMIN_PASSWORD:?…` (remove `:-openbrain_dev` / `:-admin`); unset → compose refuses to start. | CODE COMPLETE 2026-06-15 (deploy pending) |
| 2.5 | **PE-M3**: Redis memory policy | `docker-compose.yml` | redis command adds `--maxmemory 400mb --maxmemory-policy noeviction` (enqueue fails loudly under back-pressure rather than evicting BullMQ state). | CODE COMPLETE 2026-06-15 (deploy pending) |
| 2.6 | **PLT-L2**: unify web-next resource limits | `docker-compose.yml` | single `mem_limit` source (drop the conflicting `deploy.resources.limits.memory`). | CODE COMPLETE 2026-06-15 (deploy pending) |

**DoD (runnable):** `docker compose config` valid · from a LAN host `nmap <homeserver-lan-ip>` shows only 3003/3050 of this stack · from bond `curl 100.101.61.122:3002/api/v1/captures?limit=1` (MCP bearer) succeeds · full-stack `up -d --force-recreate` all healthy · one search round-trips (Redis auth works) · `scripts/verify-secrets.sh` clean.

---

### Phase 3 — Recovery & Search Contract (CS-3)

> TDD per fix. Two atomic sub-groups: (a) ingest recovery, (b) search contract — split PRs allowed.

| # | Work item | Files | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 3.1 | **SE-2 + SE-4 (ship together)**: failed-capture retry + dedup key | `core-api/src/routes/captures.ts`, `workers/src/queues/capture-pipeline.ts` (`CapturePipelineJobData`), `workers/src/jobs/ingestion-worker.ts`, `workers/src/lib/ingest-dedup.ts` | `POST /captures/:id/retry` carries `forceRetry` in job data; worker lets `'failed'` proceed when set; dedup key includes `captureId` so a capture's own BullMQ retry is never self-classified duplicate. Test walks fail→retry→recover end-to-end. | COMPLETE 2026-06-15 (deploy pending) |
| 3.2 | **SE-3**: POST-search pagination | `core-api/src/routes/search.ts`, `core-api/src/services/search.ts` | service fetches `offset+limit`, route slices after; `total` reports true match count; page-2 (`offset=10,limit=10`) returns rows. Test for offset>0. | COMPLETE 2026-06-15 (deploy pending) |
| 3.3 | **SE-9 + SE-10 + PE-L2**: search-route cleanups (same files) | `core-api/src/routes/search.ts`, `core-api/src/services/search.ts` | GET `temporal_weight` default 0.1→0.0 (matches docs); `search_mode='vector'` sets `fts_weight=0`; hydration queries enumerate columns minus `embedding`. | COMPLETE 2026-06-15 (deploy pending) |
| 3.4 | **SE-8**: implement MCP `tag_filter` | `core-api/src/mcp/tools/search-brain.ts` | `tag_filter` post-filters results (mirrors `source_filter`); test asserts filtering. (Alternative if dropped: remove from schema — but implement preferred.) | COMPLETE 2026-06-15 (deploy pending) |
| 3.5 | **SE-6 (migration 0032)**: soft-delete leak | `packages/shared/drizzle/0032_*.sql`, `core-api/src/services/search.ts` (`findRelatedCaptures`) | `spreading_activation()` joins `captures … deleted_at IS NULL`; TS hydration adds `deleted_at IS NULL`; consolidated-away captures no longer surface via MCP `include_related`. | COMPLETE 2026-06-15 (deploy pending) |
| 3.6 | **DA-M3**: access-stats queue retention | `core-api/src/index.ts` | core-api's `access-stats` Queue gets `defaultJobOptions` matching workers (`removeOnComplete {count:100}`, `removeOnFail {count:50}`); parity test prevents future drift. | COMPLETE 2026-06-15 (deploy pending) |

**DoD (runnable):** `pnpm --filter @open-brain/workers test` + `pnpm --filter @open-brain/core-api test` (coverage green) · integration suite · migration 0032 applies on a scratch DB · manual `/retry` of a real failed capture on homeserver recovers it.

---

### Phase 4 — Alerting SPOF & Deploy Pipeline (CS-4)

| # | Work item | Files | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 4.1 | **PLT-H2**: workers-staleness alerting | `config/prometheus/alerts/pipeline.yml`, `docker-compose.yml` | Prometheus rule fires when `time() - push_time_seconds{instance="workers"} > 1500` (25 min vs 15-min cadence) + an `absent()` rule on a keystone gauge; workers + slack-bot get `node -e 0`-class healthchecks, cloudflared a `/ready` probe. | COMPLETE 2026-06-15 (deploy pending) |
| 4.2 | **PLT-H1 (+PLT-RI-2)**: web-next CI image | `.github/workflows/build-images.yml` | build-images builds + pushes `ghcr.io/davistroy/open-brain/web-next` with `API_URL` build-arg; post-merge the GHCR tag exists and is current. | COMPLETE 2026-06-15 (deploy pending) |
| 4.3 | **PLT-H3 / SA-3**: Loki driver URL + runbook | `docker-compose.yml`, `docs/runbooks/observability.md` | compose Loki default points to a host-reachable URL (not daemon-unresolvable `loki:3100`); observability.md Step 6 no longer instructs the broken value; logs appear in Loki after `--force-recreate`. | COMPLETE 2026-06-15 (deploy pending) |
| 4.4 | **PE-L5**: non-blocking log driver | `docker-compose.yml` | shared `x-logging` anchor adds `mode: non-blocking` + `max-buffer-size`; a slow Loki no longer back-pressures container stdout. | COMPLETE 2026-06-15 (deploy pending) |

**DoD (runnable):** stop workers on a test basis → Pushover staleness alert fires within the window · `docker compose pull` retrieves a fresh web-next image · `{container_name="open-brain-core-api"}` shows recent lines in Grafana Loki explorer.

---

## WAVE 2 — Schema Integrity, Resilience, the Quadratic Rewrite

### Phase 5 — Schema Fidelity Machine (CS-5) · ADR-scope D-3

| # | Work item | Files | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 5.1 | **DA-H1 / SA-2**: regenerate init-schema | `scripts/init-schema.sql` | regenerated from `pg_dump --schema-only` of a fully-migrated scratch DB; now includes `app_settings`, `spreading_activation()`, `lab_results`, `briefs` (the 4 missing objects). | COMPLETE 2026-06-15 — via self-verifying `regenerate-init-schema.sh` + shared `pgdump-normalize.sh`; 866→1898 lines, deterministic. |
| 5.2 | **DA-H1 (CI parity)**: drift becomes self-catching | `.github/workflows/ci.yml`, `scripts/validate-init-schema.sh` | CI job spins two scratch DBs (init-schema vs migration chain), diffs normalized `pg_dump` output, fails on drift. Runs unconditionally (ties to 1.6). | COMPLETE 2026-06-15 — invariant "init-schema ≡ init+migrations"; PASS on main, FAIL on injected `0034_` drift. |
| 5.3 | Fix false "source of truth" comments | `core-api/src/__tests__/integration/setup.ts`, `workers/src/__tests__/integration/setup.ts` | comments reflect that init-schema is CI-parity-checked against the chain, not a hand-maintained "through 0031" claim. | COMPLETE 2026-06-15 — docstrings fixed + `applySchema()` apply-once-then-skip (snapshot not idempotent on re-apply; single-fork serial). |
| 5.4 | **DA-M1 (D-3)**: manual migration ledger | new `schema_migrations` table, `scripts/migrate-manual.sh`, `CLAUDE.md` | `schema_migrations` records each applied `0*.sql`; `migrate-manual.sh` applies idempotently + records; preserves "no auto-migration"; homeserver backfilled to 0031+. (drizzle `meta/` left empty by design — documented.) | COMPLETE 2026-06-15 — `migrate-manual.sh` (apply/`--baseline`/`--status`/`--dry-run`); ledger orthogonal to schema (parity-neutral); idempotent on scratch DB. |
| 5.5 | **DA-L3 + DA-L5 (migration 0033)**: index correctness | `packages/shared/drizzle/0033_*.sql` | `captures_content_hash_idx` becomes partial (`WHERE deleted_at IS NULL` — soft-deleted content re-ingestable); `email_classifications` gets a UNIQUE on `(provider, message_id)` after a dedup pre-flight. | COMPLETE 2026-06-15 — `0033_schema_correctness.sql`; ALSO dropped dead pre-0009 `hybrid_search`/`fts_only_search` short overloads (regeneration exposed them; app uses only filtered forms). |

**DoD (runnable):** CI parity job red on a synthetic drift, green on main · `bash scripts/migrate-manual.sh` idempotent on a scratch DB · migration 0033 applies · `SELECT * FROM schema_migrations` shows the chain on homeserver.

---

### Phase 6 — Integration & Spend Hardening (CS-6)

| # | Work item | Files | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 6.1 | **INT-H1**: slack-bot client timeout/retry | `packages/slack-bot/src/lib/core-api-client.ts` | `request()` uses `AbortSignal.timeout(15_000)` + bounded retry (idempotent GETs only); 409 treated as success on capture-create; a wedged-core-api simulation times out at 15s instead of hanging past Slack's ack. | COMPLETE 2026-06-16 — timeout + GET-only retry + 409→success (40 client + 30 consumer tests). |
| 6.2 | **SEC-05**: prompt-injection on ingest side | `workers/src/jobs/extract-entities.ts`, `workers/src/jobs/extract-commitments.ts` | both wrap `capture.content` via `SafePromptBuilder.wrapContent()` (copy the P14b read-side pattern); no template-file changes. | COMPLETE 2026-06-16 — both extract jobs wrapped; injection phrase redacted+fenced. |
| 6.3 | **INT-M2 (Option A)**: budget-breaker coverage | `packages/shared/src/services/embedding.ts`, `packages/voice-capture/src/services/classification.ts`, gateway `recordSpend()` | EmbeddingService + voice classification call `recordSpend()` after each OpenAI call; `ai_audit_log` shows embedding/classification spend rows (closes the April-incident blind spot; no latency-adding gateway re-route). | COMPLETE 2026-06-16 (embeddings) — shared `recordSpend()`; EmbeddingService records w/ db; gateway refactored to it. **Voice DEFERRED → INT-M2-voice** (thin container has no DB/config; route via core-api at ingest). High-volume blind spot closed. |
| 6.4 | **SE-5 (resolves unknown U-2)**: embed budget delay | `workers/src/jobs/embed-capture.ts` | processor receives `job`+token; `moveToDelayed(Date.now()+PAUSE_DELAY_MS, token)` precedes `DelayedError`; unit test against pinned BullMQ 5.70 proves the job is delayed, not failed; dead `PAUSE_DELAY_MS` now used. | COMPLETE 2026-06-16 — `(job, token)` + moveToDelayed-before-throw; 6 pipeline call sites + unit test updated. |
| 6.5 | **SE-16**: workers API-URL fallback | `workers/src/skills/base-skill.ts` | WARN logged + (preferably) fail-fast at startup if `OPEN_BRAIN_API_URL` unset, instead of silent `localhost:3000` fallback that gates all skills to `observe`. | COMPLETE 2026-06-16 — `require-core-api-url.ts` (fail-closed prod / WARN dev) + main.ts startup guard; 7 tests. |
| 6.6 | **SE-15**: pg error-code classification | `core-api/src/services/capture.ts` | duplicate detection inspects pg error `code === '23505'` + constraint name, not message substring. | COMPLETE 2026-06-16 — `extractPgError()` walks the cause chain; FK/not-null propagate. |
| 6.7 | **SEC-06 + SEC-07 (resolves unknown U-3)**: dep bumps | `package.json` files, `pnpm-lock.yaml` | verify advisory ranges for drizzle-orm 0.45.1 + simple-git 3.27.0; bump to patched versions; `pnpm audit` clean; lockfile committed. | COMPLETE 2026-06-16 — drizzle-orm→^0.45.2 (moderate), simple-git→^3.36.0 (HIGH RCE; 3.35.2 was vuln); both clean. Residual vitest/shell-quote/picomatch out of scope (noted). |

**DoD (runnable):** `pnpm --filter @open-brain/slack-bot test` · workers + core-api suites green · `pnpm audit` shows no high/critical · budget table query shows embedding spend rows after a capture.

---

### Phase 7 — Similarity-Scan Rewrite to k-NN (CS-7) · ADR-0003

> Depends on Phase 5 (init-schema CI parity guards the new migration). PE-M1 lands as its own commit before the rewrite.

| # | Work item | Files | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 7.1 | **PE-M1 (prerequisite)**: ef_search in a transaction | `core-api/src/services/search.ts` | `SET LOCAL hnsw.ef_search` + `hybrid_search()` wrapped in one `db.transaction()`; deterministic ef_search on the pooled connection; corrects CLAUDE.md TD-3a claim. | COMPLETE 2026-06-30 (#225, commit `49e3393`) |
| 7.2 | **PE-H1**: shared k-NN library | new `workers/src/lib/hnsw-similarity.ts` | per-row k-NN probe (`ORDER BY embedding <=> $1 LIMIT k`, k=50, threshold filter, inside a txn with `SET LOCAL ef_search`); excludes `deleted_at`/`source='consolidation'`; emits ordered pairs. | COMPLETE 2026-06-30 — **EXPLAIN-verified the probe MUST use a scalar subquery (a MATERIALIZED CTE degrades to Seq Scan)**; `source='consolidation'` is a per-call flag (consolidation includes, dedup excludes). |
| 7.3 | **PE-H1**: cut both jobs over | `workers/src/skills/memory-consolidation-query.ts` (NOT `lib/` — plan path was wrong), `workers/src/skills/capture-dedup-sweep.ts` | both call the shared library with incremental scoping (new-since-last-run, timestamp in `app_settings`); D28 constants preserved (0.92/3/5; dedup 0.95); Union-Find unchanged. | COMPLETE 2026-06-30 — watermark advances ONLY after a provably-successful scan (`findSimilarPairs` throws on DB error → BullMQ retry); `SIMILARITY_SCAN_LEGACY=1` rollback. |
| 7.4 | **PE-H1 (validation gate)**: side-by-side | test/bench scripts | cluster output of new probe == old self-join on the **production 11K snapshot** (diff ∅); old query kept behind a flag for one weekend cycle. | COMPLETE 2026-06-30 — `scripts/validate-knn-similarity.mjs`; **UNCAPPED cluster diff ∅ both jobs** (373≡373, 345≡345) even with max-degree 147≫k=50; CAPPED diffs are immaterial cap-vs-saturation boundary artifacts. |
| 7.5 | **PE-M2 (migration 0034)**: stored tsvector | `packages/shared/drizzle/0034_*.sql`, `hybrid_search`/`fts_only_search` functions | `content_tsvector GENERATED ALWAYS … STORED` + GIN; functions use the stored column; `benchmark-search.mjs` p95 unchanged-or-better. | COMPLETE 2026-06-30 — `0034_content_tsvector.sql` (idempotent); kept OUT of Drizzle schema; init-schema regenerated, parity green. p95 check deferred to deploy (ranking-equivalent). |
| 7.6 | **PE-M5**: instrument spreading_activation | `findRelatedCaptures` hop-count log (no migration — function already returns `hop_count`) | row-count logging per hop; baseline entity-degree distribution recorded in LAB_NOTEBOOK; degree cap added **only if** data shows explosion (investigate-first). | COMPLETE 2026-06-30 — baseline: degree avg 1.77/p99 14/max 457, 0 entity_relationships → **no cap** (benign); hop-distribution debug log added. |

**DoD (runnable):** ~~synthetic 50K-corpus benchmark~~ → O(N·log N) established by the HNSW index scan vs self-join materialization (EXPLAIN) · cluster-diff ∅ against production snapshot ✅ · `node scripts/benchmark-search.mjs` p95 → deploy-time check (0034 not yet deployed) · migration 0034 applies ✅ · batch-UPSERT invariant intact ✅. **MERGED #225; deploy batches with the daemon-restart window (see Deployment & Ops Backlog).**

---

## WAVE 3 — Ingest Edges, Convention Enforcement, Governance

### Phase 8 — Ingest Edges + Voice Auth (CS-8) · completes SEC-02 (re-scoped) · D-2

> Two-phase client rollout: deploy token to clients **before** server enforcement.
>
> **🔄 Re-scoped 2026-06-30 (ADR-0002 amendment / D131):** core-api is now an accepted `0.0.0.0` LAN exposure (owner risk-acceptance), so 8.2 no longer loopback-binds core-api. SEC-02's remaining *code* surface is now just **voice-capture:3001** (gated behind 8.1's Bearer auth). The observability ports (loki/prometheus/pushgateway) still on `0.0.0.0` are an **ops task** (needs `systemctl restart docker`), moved to the Deployment & Ops Backlog — not Phase 8.

| # | Work item | Files | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 8.1 | **INT-M5**: voice-capture Bearer auth | `packages/voice-capture/src/server.ts`, `packages/mobile/src/lib/config.ts`, P08 lockstep for `VOICE_CAPTURE_SECRET` | `POST /api/capture` requires a timing-safe Bearer check; mobile + iOS Shortcut send it; unauthenticated LAN POST returns 401. | ✅ DONE (TDD) — fail-closed-when-set/warn-allow-when-unset; core-api proxy forwards Bearer; mobile `audio.ts`; P08 lockstep |
| 8.2 | **SEC-02 (app ports, re-scoped)**: bind voice-capture | `docker-compose.yml` | with 8.1 in place, **voice-capture:3001** binds `127.0.0.1`; this is now the last SEC-02 *app-port* close (core-api stays `0.0.0.0` per D131; observability ports → ops backlog). | ⏸️ DEFERRED (D132/Option 1 — voice-capture stays `0.0.0.0` Bearer-gated; loopback bind → Deployment & Ops backlog with the voice-tunnel work) |
| 8.3 | **INT-M3**: email-worker transient handling | `cloudflare/email-worker/src/index.ts` | 5xx/network → throw (CF retries) instead of `setReject`; only 4xx → permanent reject; inbound mail during a core-api restart is no longer bounced. | ✅ DONE — `isTransientStatus()`; allowlist-fetch + 5xx throw; TDD exception (standalone CF worker, no monorepo test infra) |
| 8.4 | **INT-M4**: voice transcript dead-letter | `packages/voice-capture/src/lib/transcript-spool.ts`, `server.ts`, compose `voice_spool_data` | classified transcript spooled to the container volume before ingest; daily job retries the spool and deletes on success; a core-api outage no longer loses a transcribed memo. | ✅ DONE (TDD) — write-ahead spool, delete-on-success; **self-contained 30-min `setInterval`** (`NODE_ENV`-gated/`unref`) replaces a cross-container "daily sweep" |
| 8.5 | **SE-13 + PE-L4**: voice input validation | `packages/voice-capture/src/server.ts`, `core-api/src/routes/voice-captures.ts` | `brain_view` validated against config before paid transcription; 413 on uploads > 50 MB. | ✅ DONE (TDD) — `lib/brain-views.ts` lightweight load + `./config:ro` mount; 413 in both voice-capture + proxy (`VOICE_MAX_UPLOAD_BYTES`) |
| 8.6 | **RC-6**: mobile token rotation | `docs/`, BWS | rotation procedure documented; `MOBILE_API_KEY` confirmed in BWS (90-day staleness alert via `secret-rotation`). | ✅ DONE — `docs/runbooks/voice-capture-auth.md`; `secret-rotation` auto-covers both secrets (scans all BWS); BWS item creation operator-deferred |

**DoD (runnable):** iOS Shortcut + mobile SPA + Expo app each capture successfully after the change · unauthenticated `curl` to `:3001/api/capture` → 401 · `nmap` from LAN shows `:3001` closed · oversized upload → 413.

---

### Phase 9 — Convention→CI + Governance/Doc Sweep (CS-9)

> The review's meta-finding: turn drifting conventions into machine-checked invariants.

| # | Work item | Files | Acceptance criteria | Status |
|---|-----------|-------|---------------------|--------|
| 9.1 | **SA-1**: type-union drift guards | new `packages/web-next/lib/__tests__/type-drift.test.ts`, `packages/mobile/src/lib/__tests__/type-drift.test.ts`, `CLAUDE.md` | tests pin web-next + mobile `CaptureSource`/`CaptureType`/`PipelineStatus` to `@open-brain/shared`; adding a 10th source fails CI in both; CLAUDE.md "4 surfaces"→6. | PENDING |
| 9.2 | **SA-8 + SE-12**: cron-slot test + fix overlaps | new `workers/src/__tests__/scheduler-slots.test.ts`, `workers/src/scheduler.ts` | test parses every registered cron (host crons as fixtures) and fails on a same-minute repeatable collision; shift storage-audit `0 3 * * 0`→`15 3 * * 0` and wiki-lint `0 5 * * 0`→`30 4 * * 0`; JSDoc synced. (The `0 6`/`0 7` host↔container overlaps are documented as accepted, not collisions.) | PENDING |
| 9.3 | **RC-4 (migration 0035)**: event-table retention | `packages/shared/drizzle/0035_*.sql` (`retention_audit`), new `data-retention-prune` weekly job | prunes pipeline_events 90d / ai_audit_log 180d / activity_feed 30d / mcp_activity 30d / skills_log 60d; **`admin_audit` untouched** (invariant test); deletions logged to `retention_audit`. | PENDING |
| 9.4 | **RC-5 / DA-M4 / RC-3**: data-classification doc | new `docs/PROVIDER_SETTINGS.md`, `CLAUDE.md` | vendor table (OpenAI/Anthropic/Deepgram/CF/BWS) + data-class matrix (lab_results, insurance_policies flows) + quarterly-review hook. | PENDING |
| 9.5 | **Platform/doc batch** (PLT-M2/M3/M5/M7/M9, PE-M4, doc GROUP A) | `docs/runbooks/deploy.md`, `docker-compose.yml`, `scripts/backup.sh`, `docs/PRD.md`, `CLAUDE.md`, `docs/runbooks/container-health-alert.md` | deploy.md rewritten (7 images, real services, post-compose-up step, port 3003/`/dashboard`); third-party images pinned to major versions; backup.sh sends Pushover + logs to `/var/log`; whisper `cpus: 4` (+ core-api/workers/postgres caps); PRD §7 monitoring + budget refresh; litellm removed from monitor list. | PENDING |
| 9.6 | **PLT-M1 + PE-M6/INT-M7**: alerting honesty + SLOs | `config/prometheus/alerts/*.yml`, new `docs/SLO.md`, `config/prometheus/alerts/slo.yml` | alert-rule comments corrected (no Alertmanager for one operator — Option A); `docs/SLO.md` with p99 targets; recording rule + p99 alert; (outbound-latency histograms optional, note if deferred). | PENDING |
| 9.7 | **SE-14 + SE-17**: low-risk notes/logging | `docs/runbooks/`, 3 Python scripts | runbook note that failed voice captures are unrecoverable server-side; `logger.warn` added to the 3 bare `except: pass` cleanup blocks. | PENDING |

**DoD (runnable):** drift-guard + cron-slot tests red-then-green · `data-retention-prune` dry-run shows expected counts, `admin_audit` row count unchanged · deploy.md walked end-to-end on the next deploy · `docker compose config` valid with pinned images.

---

## WAVE 4 — Opportunistic & Investigation Closeout

### Phase 10 — Residual Lows + RI Resolution

| # | Work item | Acceptance criteria | Status |
|---|-----------|---------------------|--------|
| 10.1 | **SEC-04**: `/queues/:name/clear` hardening | add `checkOrigin()` + `admin_audit` row (mirror reset-data); contrast finding closed. | PENDING |
| 10.2 | **SE-11**: array-literal escaping | brainViews/captureTypes interpolation validated/escaped; a view name with `,`/`}`/`"` no longer 500s. | PENDING |
| 10.3 | **SA-7**: voice classification model config-routed | `CLASSIFICATION_MODEL` resolved from `ai-routing.yaml` instead of hardcoded `gpt-5.4`. | PENDING |
| 10.4 | **RI closeouts** | RI-1 (`gh api .../protection` + repo visibility), R1 (urBackup coverage check — document either way), PLT-RI-1 (compose `--remove-orphans` vs profiles). | PENDING |
| 10.5 | Remaining GROUP-A doc drift | any leftover doc/code mismatches swept; LAB_NOTEBOOK doc-drift action items closed. | PENDING |

**DoD:** each item's verification noted inline; LAB_NOTEBOOK A132 marked closed.

---

## Risk Mitigation

| Phase | Risk | Mitigation / rollback |
|-------|------|----------------------|
| 1 | Coverage gate trips day one | 1.1 measures first; raise coverage (never lower thresholds); split a failing PR |
| 2 | Tailscale-bind boot ordering; a Redis consumer missed | post-compose-up smoke check (MCP port answers on Tailscale IP); staged restart; one-commit compose revert; `verify-secrets.sh` catches a missed consumer |
| 3 | Retry/dedup change alters ingest semantics | end-to-end fail→retry→recover test; manual retry on homeserver before declaring done |
| 5 | init-schema regeneration introduces a diff vs production | CI parity job is the guard; backfill `schema_migrations` on homeserver before relying on it |
| 7 | k-NN rewrite changes cluster membership | mandatory side-by-side diff on production snapshot; old query behind a flag for one weekend |
| 8 | Breaking iOS Shortcut/mobile capture | two-phase rollout — token to clients before server enforcement |
| 9 | Retention job deletes too much | dry-run first; `admin_audit`-untouched invariant test; per-table age bounds reviewed |

---

## Unknowns Register

| ID | Unknown | Severity | Resolve before | Resolution |
|----|---------|----------|----------------|-----------|
| U-1 | ~~Do current coverage numbers clear the configured thresholds?~~ | High | Phase 1.2 | **RESOLVED:** core-api 85.6% (pass); workers 74.02% < 78 (→ D&O-4) |
| U-2 | ~~BullMQ 5.70 bare-`DelayedError` runtime behavior~~ | Medium | Phase 6.4 | **RESOLVED:** SE-5 fix — `moveToDelayed`-before-throw, unit-tested (#224) |
| U-3 | ~~Is drizzle-orm 0.45.1 in the advisory's affected range?~~ | Medium | Phase 6.7 | **RESOLVED:** bumped drizzle-orm→0.45.2, simple-git→3.36.0 (#224) |
| U-4 | ~~spreading_activation entity-degree distribution~~ | Medium | Phase 7.6 cap decision | **RESOLVED:** avg 1.77/p99 14/max 457, 0 rels → no cap (#225, Entry 173) |
| U-5 | urBackup already replicating `/mnt/user/backup` off-chassis? | Low (offsite now exists) | Phase 10.4 | one Unraid UI check; document either way |
| U-6 | Compose `--remove-orphans` vs profiles on homeserver version | Low | Phase 10.4 | check live compose version; pin `COMPOSE_PROFILES` if needed |

---

## Scope Boundaries

**In scope:** all 15 remaining High + 41 Medium + actionable Low findings from arch-review v3.

**Explicitly excluded:**
- **Risk-Acceptance Register (8 items)** — accepted single-user posture: no in-boundary auth, `/admin/reset-data` sans Bearer, single-host/bus-factor-1, 24h RPO, no encryption-at-rest (offsite copy *is* encrypted), consumer vendor tiers, in-memory rate limiter, cost-tiering-vs-all-OpenAI. Do **not** remediate; document tradeoffs where flagged.
- **INT-M6 (OpenAPI generation from Zod)** — deferred to a later cycle; contract-quality, not risk.
- **Qdrant migration (#73)** — independently scale-gated (≥50K embeddings).
- **Already closed (Entry 164):** SE-1, RC-1, RC-2, SEC-01, SEC-03.

---

## Deployment & Ops Backlog (added by 2026-06-30 refresh)

Not in the original plan — these are operational follow-ups the homeserver deploy (Entry 172) and Phase 7 surfaced. **The first three collapse into ONE batched maintenance window** (a `systemctl restart docker` blinks ~25 host containers, so do them together).

| # | Item | Detail | Status |
|---|------|--------|--------|
| D&O-1 | **Batched daemon-restart maintenance window** | ~~(a) deploy Phases 6+7 code; (b) apply **migration 0034**~~ ✅ **DONE 2026-06-30 (Entry 175)** — non-disruptive subset deployed (backup-first `pg_dump`, path-scoped 0034 land, `sudo docker compose pull` + surgical `--force-recreate --no-deps core-api/workers/slack-bot`; **`/dev/shm`=64 MB parallel-migration gotcha** fixed via `PGOPTIONS` parallel-off). **REMAINING — needs `systemctl restart docker` (blinks ~25 host containers):** (c) loopback-bind **loki/prometheus/pushgateway** (deviation 3); (c2) add postgres `shm_size: "512mb"` so future parallel migrations/index builds don't hit the 64 MB DSM wall; (d) verify `nmap` shows observability ports filtered, MCP/search/Loki intact. **UPDATE 2026-06-30 (Entry 179): Phases 8+9+10 + migration 0035 ALSO deployed** (backup-first; compose reconciled to main + core-api `0.0.0.0` re-applied via sed — Unraid has no python3; targeted `--force-recreate --no-deps`, no `--remove-orphans` since observability is profile-gated). All app code now current. The Phase-9 third-party image pins + resource caps are declared-but-deferred (apply when those services are next recreated in the daemon-restart window). | PARTIAL (all app code + 0034 + 0035 deployed; obs-loopback + shm_size + third-party-pins remain for the daemon-restart window) |
| D&O-2 | **Upstream / document the 3 compose deviations** | (1) redis no-host-publish — **keep** (more secure; apps use docker-net `redis:6379`); (2) core-api `0.0.0.0:3002` — **ratified by D131**, make it the documented Unraid posture (vs. main's `${TAILSCALE_IP}` dual-bind — needs a host-portable compose conditional or a documented Unraid override); (3) observability loopback — fixed in D&O-1. Decide: upstream to `docker-compose.yml` (host-portable) vs. a committed `docker-compose.unraid.yml` override. | PENDING |
| D&O-3 | **QA-M3 / INGEST_E2E in CI** | Re-scoped from Phase 1.4 — needs a full-stack test compose (core-api + workers + sidecar), not a flag flip. Stand up the stack in CI, then set `INGEST_E2E=1`. | DEFERRED |
| D&O-4 | **Workers coverage Part B** | workers lines 74.02% < 78 floor (gap ~447 lines: `skill-execution.ts` 0%, `scheduler.ts` 0%, `ingest-process.ts` 0%). Raise coverage in a dedicated PR, then enable `--coverage` in the workers `test` script. **Never lower the threshold.** | DEFERRED |
| D&O-5 | **INT-M2-voice** | Route voice-capture classification spend through core-api at ingest (the thin voice container has no DB/config to call `recordSpend()` directly). Closes the last budget-breaker blind spot. | DEFERRED |
| D&O-6 | **Voice-capture loopback bind (SEC-02 8.2)** | Bind `voice-capture:3001` to `127.0.0.1` once the live iOS Shortcut + mobile clients route through a tunnel (currently they POST direct to `homeserver:3001`, Bearer-gated per D132). Pairs with standing up CF-tunnel-for-voice. Until then, the Bearer auth (8.1) is the control and the port stays LAN. | DEFERRED (D132) |

---

## Generated ADRs

| ADR | Title | Status | Phase |
|-----|-------|--------|-------|
| ADR-0002 | LAN exposure model (data stores loopback; **core-api `0.0.0.0` risk-accepted**) | **Accepted — amended 2026-06-30 (D131); dual-bind superseded** | 2 |
| ADR-0003 | Similarity-scan k-NN rewrite | **Accepted — implemented #225 (2026-06-30)** | 7 |

---

*Encoded from `/ultra-plan` Phase 2–5 analysis (2026-06-15). Execute with `/implement-plan` or `/plan-next`. Each phase: LAB_NOTEBOOK entry → branch → implement (TDD) → verify (DoD) → PR.*
