# Changelog

All notable changes to Open Brain are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Changed
- **Switched from local Qwen to OpenAI API**: All LLM inference now uses `gpt-5.4` (via `config/ai-routing.yaml`). Embeddings use `text-embedding-3-large` with `dimensions: 768` API parameter (trained MRL, not naive truncation). Removes dependency on DGX Spark / LiteLLM proxy.
- **Docker base images upgraded to Node 22 LTS** (from Node 20, EOL April 2026).
- **CI actions upgraded**: checkout v5, setup-node v5, cache v5 (Node 24-compatible).

### Added
- **Voice capture location** (PR #33): Optional GPS coordinates on voice captures from iOS Shortcut. Parses `latitude`, `longitude`, `location_name`, `location_accuracy` form fields; validates ranges; stores in `source_metadata.location` JSONB. No schema migration.
- **CaptureDetail structured metadata display**: Replaced raw JSON dump with `SourceMetadataDisplay` component — device icon, formatted duration, language, location with MapPin + Google Maps link. Unknown keys fall back to key-value pairs.
- **5 location validation tests**: Valid coords, backward compat, partial coords (400), out-of-range (400), non-numeric (400).
- **Monthly maintenance script** (`scripts/monthly-maintenance.sh`): Runs 5 checks (docker rebuild, dependency audit, GitHub security alerts, error log scan, health check). Posts results to Slack + dashboard admin banner.
- **Monthly audit GitHub Action** (`monthly-audit.yml`): Scheduled workflow for `pnpm outdated` + Dependabot alert check, posts to Slack.
- **Admin banner API** (`POST/GET/DELETE /api/v1/admin/banner`): Redis-backed banner with 30-day TTL, displayed at top of dashboard.
- **Web UI rate-limit bypass**: nginx adds `X-Open-Brain-Caller: web-ui` header; rate limiter exempts it alongside `integration-test`.

### Fixed
- **Search broken in web UI**: `SearchFilters` sent `q` field but API expected `query`. Renamed across types, component, and tests.
- **OpenAI API compatibility**: Removed Qwen/vLLM-specific `extra_body` params (5 call sites), changed `max_tokens` to `max_completion_tokens` (7 call sites).
- **Health check 404**: Fixed double `/v1/v1/models` URL when `LITELLM_URL` ends with `/v1`.
- **nginx stale DNS**: Added `resolver 127.0.0.11` + variable upstream to prevent cached IPs after container recreation.
- **Docker web build failure**: Moved user docs into `packages/web/src/content/` to fix Vite `?raw` import boundary violation.
- **e2e test scripts**: Added rate-limit bypass header, MCP SSE response parsing, bash arithmetic fix, document title uniqueness.
- **Voice-capture classification model**: Resolved hardcoded `'fast'` alias to `'gpt-5.4'` (OpenAI rejects unknown model names).
- **iOS Shortcut docs**: Form field name was `'file'` not `'audio'`.

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

[Unreleased]: https://github.com/davistroy/open-brain/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/davistroy/open-brain/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/davistroy/open-brain/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/davistroy/open-brain/releases/tag/v1.0.0
