# Changelog

All notable changes to Open Brain are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [1.6.0] — 2026-05-09

Phase 8b web consolidation, architecture review remediation, mobile app, ops hardening, GitHub issues migration.

### Added
- **React Native mobile app** (PR #172): 11 screens — captures list, capture detail, search, voice, briefs, sessions, entities, settings, add capture, loading, offline. Expo SDK 53 → 54.
- **Cloudscape M1–M4** (PRs #168–#171): Next.js 16 + React 19 + Cloudscape full UI migration — capture detail, design polish, brief actions, entity merge. `packages/web-next` is now the sole UI package.
- **Architecture review remediation R1–R12** (PR #175): 12 hardening items across security, rate limiting, observability, and type safety.
- **UUID path-param validation** (A113, PR #189): `GET/PATCH/DELETE` briefs + sessions `:id` endpoints return 400 on malformed UUID (was 500).
- **sessions `status_filter` 400** (A114, PR #189): Invalid `status_filter` query param returns 400 instead of silently dropping.
- **settings GET whitelist gate** (A110, PR #188): `GET /api/v1/settings/:key` rejects unknown keys with 404.
- **email_allowlist validator** (A111, PR #188): `PUT /api/v1/settings/email_allowlist` validates entries as valid email addresses.
- **Cross-platform `test:integration`** (A129, PR #187): `node scripts/test-integration.mjs` — compose-up → tests → compose-down with try/finally teardown. Works on bash and PowerShell.
- **Workers coverage gate** (Phase 4, PR #183): `thresholds: { lines: 78, functions: 81 }` in `packages/workers/vitest.config.ts`. Workers integration tests in CI.
- **Wiki construction** (P26, PR #60): browser UI + pipeline hardening.
- **Pyright coverage** (P27–P32, PRs #120–#121): Full pyright coverage for all Python scripts (voice-pipecat, financial, utility, email, file-management, ingestion).
- **LLM model consolidation** (PR #167): All LLM model assignments in `config/ai-routing.yaml`. No hardcoded model names in application code.
- **Lab report synthesis** (P20b, PR #159): T0 PDF extraction + T2 Claude CLI trend synthesis.
- **Insurance pipeline** (P22a/b, PRs #157–#158): T0 policy extraction + migration 0029 + gap analysis.

### Changed
- **`packages/web` deleted** (Phase 8b, ADR-0001): `packages/web-next` is the sole web UI. `brain.troy-davis.com` tunnels to `web-next`.
- **GitHub issues as authoritative tracker**: `OPEN_ITEMS.md` is now a lightweight redirect table. All pending work tracked in GitHub issues at https://github.com/davistroy/open-brain/issues.
- **Completed implementation plans archived**: `IMPLEMENTATION_PLAN-ARCH-REVIEW.md`, `-CLOUDSCAPE-M2.md`, `-CLOUDSCAPE-M3.md`, `-CLOUDSCAPE-M4.md`, `-POST-REMEDIATION.md` moved to `docs/archived/`.
- **Ops hardening** (A71/A107/A125, PRs #184–#186): `memory_consolidation` task-routing key; removed duplicate `strictLimiter` on `/captures`; `capture_associations` migration folded into `init-schema.sql`.

### Fixed
- **Stale `depends_on: web` in `cloudflared`** (d479c04): Phase 8b removed `open-brain-web` service but left `cloudflared.depends_on.web` — `docker compose config` returned invalid-project error blocking all deploys.
- **`scripts/__pycache__` tracked in git**: `deepgram-spike.cpython-314.pyc` was committed before `.gitignore` rule was added; removed with `git rm --cached`.

---

## [1.5.0] — 2026-04-19

P08–P15a: secrets reconciliation, sibling enum CHECK constraints, CI expansion, observability, search performance, prompt injection hardening, doc alignment.

### Added
- **BWS secrets reconciliation** (P08): `scripts/load-secrets.sh` — full Bitwarden Secrets Manager reconciliation, round-trip invariant, `verify-secrets.sh` drift audit, `test-secrets-roundtrip.sh` 5-case fixture.
- **Sibling enum CHECK constraints** (P09a/b/c): DB-level CHECK constraints for `capture_type` (8 values), `pipeline_status` (8 values), `pipeline_events.stage` (11 values), `pipeline_events.status` (3 values), `sessions.session_type` (3 values), `sessions.status` (4 values). Migrations 0024–0026.
- **CI integration test job** (P10a): Real Postgres + Redis in CI via `docker-compose.test.yml`; `integration-test` job in CI (observe mode, `continue-on-error: true`).
- **CI Python test jobs** (P10b): `sidecar-test`, `voice-pipecat-test`, `file-ingestion-test` jobs in CI; test counts updated in docs.
- **Loki log driver** (P11a): All 13 Docker Compose services write to Loki via `loki` log driver. `LOKI_URL` env var. Grafana Loki explorer cross-container search.
- **Prometheus alert rules + Grafana dashboards** (P11b): `config/prometheus/rules/open-brain-alerts.yml` (pipeline-stall, high-error-rate, budget-soft/hard, Composio-quota, embedding-latency). 4 Grafana dashboard panels. Budget + Composio metrics exposed by core-api.
- **Search performance cliff fix** (P13): `hybrid_search` LIMIT push-down (`match_count * 4`) on both `fts_ranked` and `vector_ranked` CTEs. `SET LOCAL hnsw.ef_search` per-query from `pipeline.yaml`. Migration 0027. `scripts/benchmark-search.mjs`.
- **SafePromptBuilder module** (P14a): `packages/shared/src/lib/prompt-builder.ts` — 14 injection patterns stripped, session-random XML-style delimiters. `docs/SECURITY.md` threat model.
- **Doc sync script + CI job** (P15a): `scripts/sync-docs.sh` validates package.json / PRD / README / CHANGELOG version agreement. `doc-sync` CI job (observe mode). Source enum corrected to 9 canonical values in PRD + TDD.

### Changed
- **Switched from local Qwen to OpenAI API** (CS1–CS5): All LLM inference now uses `gpt-5.4` (via `config/ai-routing.yaml`). Embeddings use `text-embedding-3-large` with `dimensions: 768` API parameter (trained MRL, not naive truncation). Removes dependency on DGX Spark / LiteLLM proxy.
- **Docker base images upgraded to Node 22 LTS** (from Node 20, EOL April 2026).
- **CI actions upgraded**: checkout v5, setup-node v5, cache v5 (Node 24-compatible).

### Fixed
- **Voice capture location** (PR #33): Optional GPS coordinates on voice captures from iOS Shortcut. Parses `latitude`, `longitude`, `location_name`, `location_accuracy` form fields; validates ranges; stores in `source_metadata.location` JSONB. No schema migration.
- **CaptureDetail structured metadata display**: Replaced raw JSON dump with `SourceMetadataDisplay` component — device icon, formatted duration, language, location with MapPin + Google Maps link. Unknown keys fall back to key-value pairs.
- **Search broken in web UI**: `SearchFilters` sent `q` field but API expected `query`. Renamed across types, component, and tests.
- **OpenAI API compatibility**: Removed Qwen/vLLM-specific `extra_body` params (5 call sites), changed `max_tokens` to `max_completion_tokens` (7 call sites).
- **Health check 404**: Fixed double `/v1/v1/models` URL when `LITELLM_URL` ends with `/v1`.
- **nginx stale DNS**: Added `resolver 127.0.0.11` + variable upstream to prevent cached IPs after container recreation.
- **Docker web build failure**: Moved user docs into `packages/web/src/content/` to fix Vite `?raw` import boundary violation.
- **e2e test scripts**: Added rate-limit bypass header, MCP SSE response parsing, bash arithmetic fix, document title uniqueness.
- **Voice-capture classification model**: Resolved hardcoded `'fast'` alias to `'gpt-5.4'` (OpenAI rejects unknown model names).
- **iOS Shortcut docs**: Form field name was `'file'` not `'audio'`.
- **Admin banner API** (`POST/GET/DELETE /api/v1/admin/banner`): Redis-backed banner with 30-day TTL, displayed at top of dashboard.
- **Web UI rate-limit bypass**: nginx adds `X-Open-Brain-Caller: web-ui` header; rate limiter exempts it alongside `integration-test`.

---

## [1.4.0] — 2026-04-19

Arch-review hardening (P01–P07): rate limiting, admin reset two-step, backup secrets redaction, autonomy gate, Hebbian co-access, internal traffic hygiene.

### Added
- **Mem limits + init-schema.sql** (P01): Docker Compose memory limits on all containers. Idempotent `scripts/init-schema.sql` for fresh-box provisioning.
- **callClaude removal** (P02a/b): All LLM skills use `LLMGatewayService.completeByTask()`. No direct Anthropic SDK in skill code. LiteLLM proxy dependency removed from pipeline.
- **Cost estimator + ai_audit_log** (P02c): `estimateTierCostUsd()` from tier config. `ai_audit_log.cost_usd` reflects real Anthropic costs. Budget circuit breaker live end-to-end.
- **Composio quota meter** (P03): `ComposioClient` increments `composio:monthly_usage:YYYY-MM`. Hard stop 19K/month (95%). Pushover warn at 15K (75%).
- **Admin reset two-step** (P04a): `POST /admin/reset-data` two-step (token + confirmation phrase). Pre-wipe `pg_dump`. `admin_audit` table excluded from TRUNCATE. Cloudflare Access email attribution. Origin allowlist fail-closed.
- **Backup secrets redaction** (P04b): `scripts/backup.sh` strips `.env.secrets`. Regression guard `scripts/test-backup-secrets-redaction.sh`. `BACKUP_ROOT`/`APP_DIR` env overrides.
- **Autonomy gate via BaseSkill** (P05): `BaseSkill.execute()` checks `static minimum_autonomy` before delegating to `run()`. 4 proactive skills gated (email-compose → advise; memory-consolidation + daily-sweep-skill → assist; weekly-brief → observe).
- **Hebbian co-access tracking** (P06): `update-access-stats` BullMQ job. Batch-UPSERT invariant. Spreading activation `include_related` (API default false / MCP default true). Building on migrations 0011-0012.
- **Internal traffic hygiene** (P07): 16-entry `BYPASS_CALLERS` Set in rate-limit middleware. `X-Open-Brain-Caller` header on all internal callers. nginx `proxy_set_header` explicit per location. Scheduler cron slot registry (no two jobs on same minute).
- **CaptureSource drift-guard test** (P01): Shared package test asserts `CaptureSource` union matches Zod `CAPTURE_SOURCES` array — no silent enum drift.
- **Zod config validation** (P02c): `ConfigService.load()` validates `ai-routing.yaml` at startup; fails fast on missing cost fields for paid providers.

### Changed
- Monthly audit GitHub Action added (`monthly-audit.yml`). Monthly maintenance script (`scripts/monthly-maintenance.sh`).

---

## [1.3.0] — 2026-04-01

CS1–CS5: full OpenAI API migration, Node 22 upgrade, CI modernization, shared utilities, web synthesis, email pipeline, proactive intelligence, cognitive memory.

### Added
- **OpenAI API migration** (CS1–CS5): All AI through `api.openai.com/v1`. `gpt-5.4` for all inference aliases. `text-embedding-3-large` with `dimensions: 768`. Retired `LITELLM_URL`/`LITELLM_API_KEY` env vars (now `OPENAI_BASE_URL`/`OPENAI_API_KEY`).
- **Shared utilities package** (Phase 7): `@open-brain/shared` now exports `createLogger`, `createLiteLLMClient`, `PushoverService`, `assertOk`/`HttpError`, `TemplateCache`, `model-resolver`. Removed per-package duplication.
- **Email pipeline**: Cloudflare Email Worker → core-api captures. Sender allowlist in `app_settings` via dashboard Settings page. Migration 0010.
- **Web synthesis**: Questions on search page get LLM-synthesized answer card. `POST /api/v1/synthesize`.
- **Proactive intelligence**: Autonomy levels (observe/assist/advise/partner). `daily-sweep-skill` (8pm LLM evening summary). MCP `open_brain://context` resource. Pipeline-health heartbeat monitor. Slack auto-response with confidence scoring.
- **Cognitive memory** (Hebbian, spreading activation, memory consolidation): Migrations 0011–0012. `capture_associations` table. `spreading_activation` SQL function. Memory consolidation skill (Sunday 4 AM, cosine > 0.92, min cluster 3). Source `consolidation` + soft-delete.
- **Voice capture location**: GPS coordinates on voice captures from iOS Shortcut.
- **CaptureCard unification**: Single shared component across Dashboard, Timeline, EntityDetail, Search.
- **Financial + utility pipelines** (Phase 4): External financial data ingestion, utility pipeline parsers.
- **Phase 3 ops**: Prometheus + Grafana + Loki observability stack. Gitea wiki (11 pages). Email outbound. Synthetic monitor (health.troy-davis.com).

### Changed
- Docker base images upgraded to Node 22 LTS (from Node 20, EOL April 2026).
- CI actions upgraded: checkout v5, setup-node v5, cache v5 (Node 24-compatible).
- Vitest `pool: 'forks'` with `minForks: 1` / `maxForks: 4`, `hookTimeout/testTimeout: 30_000` for Windows ioredis/bullmq race avoidance.

### Fixed
- Entity resolver: indexed SQL query (not in-memory), shared between `extract-entities` and `link-entities`.
- pg-notify auto-reconnects: exponential backoff 1s→30s, 5 attempts. Re-registers all LISTEN channels.
- Model alias resolution: all OpenAI-calling code resolves aliases from `configService.get('ai').models[alias]` at init time.
- Slack-bot lightweight `ai-routing.yaml` load (not full `ConfigService`, which requires all 4 YAML files).

---

## [1.2.0] — 2026-03-12

### Added
- **Queue management UI**: Per-queue clear buttons for failed jobs (`POST /admin/queues/:name/clear`).
- **Skill schedule editing**: Inline cron editing with YAML write-back (`PATCH /api/v1/skills/:name`).
- **In-app help page**: Tabbed markdown rendering with table of contents at `/help`.
- **Slack channel cleanup**: Channel listing with activity metadata and archive capability (`GET/POST /admin/slack/channels`).
- **Dark mode toggle**: System preference detection with `localStorage` persistence.
- **Settings page reorganization**: Focused sections for system health, skills, triggers, and danger zone.
- **Trigger delete fix**: Delete button now works on Settings page.
- 13 new regression test cases covering Phase 6 endpoints (queue management, skill schedules, Slack channels).

---

## [1.1.0] — 2026-03-11

### Added
- **DailyConnectionsSkill** (F21): Identifies recurring entity co-occurrences across captures, surfaces cross-domain relationship patterns. Scheduled daily via BullMQ.
- **DriftMonitorSkill** (F22): Detects silent bets, declining entities, and stale governance commitments. Pushover notifications for medium+ severity drift.
- **Intelligence dashboard tab**: New `/intelligence` route with ConnectionsCard, DriftCard, and SkillHistoryCard components.
- **Intelligence API**: 6 new endpoints under `/api/v1/intelligence/` (summary, connections/drift latest+history, skill trigger).
- **Slack commands**: `!connections`, `!connections detail`, `!drift`, `!drift history`.
- Prompt templates: `daily_connections_v1.txt`, `drift_monitor_v1.txt`.
- Regression test script (`scripts/regression-test.mjs`) — 83 test cases covering all API endpoints.
- Integration tests: 87 tests across captures, entities, search, and smoke suites.

### Changed
- Embedding model switched from `jetson-embeddings` to `spark-qwen3-embedding-4b` (Matryoshka 2560d → 768d truncation).
- Intelligence trigger endpoint allowlists accepted override keys per skill (prevents arbitrary data in Redis).
- Numeric skill params clamped: windowDays/tokenBudget in DailyConnections, betActivityDays/commitmentDays/entityWindowDays in DriftMonitor (max 365 days).

### Fixed
- SQL typo `plainplainto_tsquery` → `plainto_tsquery` in `hybrid_search` function (migration 0006).
- `search_mode: 'fts'` parameter was accepted but silently ignored — now routes to `fts_only_search()`.
- Web dashboard stale source files (14 files synced to homeserver).
- Embedding service strict dimension check (`!== 768`) replaced with Matryoshka-aware check (`< 768`) with truncation.
- Rate limiter: per-service buckets via `X-Open-Brain-Caller` header.
- Bull Board: `adminAuth()` middleware added.
- CORS: `brain.troy-davis.com` added to allowed origins.
- Token comparison: `timingSafeEqual()` in both admin-auth and MCP auth.
- Board "Invalid Date" on bets with null `resolution_date`.
- Health endpoint version reads from correct relative path in Docker.

### Security
- SQL injection: type-safe Drizzle queries replacing raw string interpolation in 4 modules.
- Rate limiting middleware: tiered (strict 20/min, moderate 60/min, relaxed 200/min).
- `timingSafeEqual` for all token/secret comparisons.

---

## [1.0.0] — 2026-03-05

Initial complete implementation of all 16 phases.

### Added

**Phase 1 — Foundation (Phases 1A–1E)**
- TypeScript monorepo with pnpm workspaces (`shared`, `core-api`, `workers`, `voice-capture`, `slack-bot`, `web`)
- Postgres 16 + pgvector schema with `vector(768)` embeddings
- Drizzle ORM with migration pipeline
- Hono HTTP API with capture CRUD endpoints
- BullMQ + Redis pipeline (embed-capture, extract-entities, check-triggers, notify)
- Hybrid search: FTS + vector cosine with Reciprocal Rank Fusion
- ACT-R temporal decay scoring (`temporal_weight` config knob)
- Config-driven architecture (YAML for ai-routing, brain-views, pipeline, notifications)

**Phase 2 — AI Integration (Phases 2A–2C)**
- EmbeddingService via LiteLLM proxy (OpenAI embeddings API format)
- Patient backoff retry: 5 attempts (30s, 2m, 10m, 30m, 2h) + daily sweep
- LLM gateway routing for fast/synthesis/governance/intent aliases
- Monthly AI budget: soft $30 alert, hard $50 circuit breaker

**Phase 3 — Voice Capture**
- `voice-capture` service: HTTP endpoint for iOS Shortcut → faster-whisper transcription
- Apple Watch / iPhone integration via iOS Shortcuts
- Pushover notification on successful ingest

**Phase 4 — Document Ingestion**
- PDF and DOCX ingestion via `document-pipeline` BullMQ worker
- Chunk-based processing with per-chunk capture records

**Phase 5 — Slack Bot**
- @slack/bolt Socket Mode bot
- `@openbrain <text>` — capture via mention
- `@openbrain ? <query>` — search via mention
- `/brief`, `/bet` slash commands
- Duplicate detection via content hash

**Phase 6 — Entity Tracking**
- LLM-powered entity extraction (people, projects, organizations)
- Entity merge/split operations
- Capture–entity linking

**Phase 7 — AI Skills**
- Weekly brief generation (synthesis LLM over recent captures)
- Governance sessions (LLM-driven conversation with guardrails, not FSM)
- Bet tracking (statement, confidence, due date, outcome)
- Semantic push triggers

**Phase 8 — MCP Endpoint**
- Streamable HTTP MCP at `/mcp` embedded in core-api
- `Authorization: Bearer` auth
- Tools: search, get_capture, list_captures, create_capture, get_brief, list_entities

**Phase 9–16 — Polish**
- Web dashboard (Vite + React + shadcn/ui + nginx, PWA)
- Real-time updates via SSE
- Cloudflare Tunnel for `brain.troy-davis.com`
- Bull Board queue monitor at `/admin/queues`
- Health endpoint with LiteLLM latency reporting
- Architecture review remediation (11 items)

### Architecture Decisions
- No Ollama container — all AI through external LiteLLM at `llm.k4jda.net`
- No embedding fallback — queue and retry preserves vector space consistency
- `vector(768)` everywhere — Matryoshka truncation from larger models
- MCP embedded in core-api (not a separate container)
- Builder stage in Dockerfile compiles all packages from source; `dist/` is gitignored and not committed

---

[Unreleased]: https://github.com/davistroy/open-brain/compare/v1.5.0...HEAD
[1.5.0]: https://github.com/davistroy/open-brain/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/davistroy/open-brain/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/davistroy/open-brain/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/davistroy/open-brain/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/davistroy/open-brain/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/davistroy/open-brain/releases/tag/v1.0.0
