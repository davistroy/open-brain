# Implementation Plan — Open Brain

| Field | Value |
|-------|-------|
| Based On | docs/PRD.md v0.6, docs/TDD.md v0.5 |
| Created | 2026-03-05 |
| Phases | 8 (this file) + 8 (IMPLEMENTATION_PLAN-PHASE2.md) = 16 total |
| Scope | Foundation through MCP (PRD Phases 1A–1E) |

---

## Phase Summary

| Phase | Title | Complexity | Files | Est. LOC | Work Items |
|-------|-------|------------|-------|----------|------------|
| 1 | Monorepo + Infrastructure | M | ~12 | ~400 | 5 |
| 2 | Shared Package — Schema & Types | M | ~14 | ~700 | 5 |
| 3 | Core API Scaffold | M | ~10 | ~500 | 5 |
| 4 | Capture CRUD Endpoints | M | ~10 | ~600 | 5 |
| 5 | Embedding + Search | L | ~12 | ~800 | 6 |
| 6 | Pipeline + LLM Gateway | L | ~14 | ~900 | 6 |
| 7 | Slack Bot — Capture + Query | L | ~10 | ~700 | 5 |
| 8 | MCP + External Access | M | ~8 | ~500 | 5 |

**Total: ~90 files, ~5,100 LOC, 42 work items**

---

<!-- BEGIN PHASES -->

## Phase 1: Monorepo + Infrastructure

**Goal**: Buildable monorepo with Docker infrastructure for Postgres and Redis. No application code yet — just the skeleton that everything else plugs into.

**Dependencies**: None (first phase)

**Test Gate (PRD 1A partial)**: `pnpm install` succeeds, `pnpm build` produces no errors (empty packages OK), `docker compose up postgres redis` starts healthy containers.

---

### 1.1 Root Workspace Configuration ✅ Completed 2026-03-05

**Description**: Create the pnpm workspace root with package.json, pnpm-workspace.yaml, and shared TypeScript configuration. ESM throughout.

**Complexity**: S

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `package.json` — Root workspace config (name: open-brain, private: true, scripts: build, dev, test, lint, clean)
- `pnpm-workspace.yaml` — packages: ["packages/*"]
- `tsconfig.base.json` — Shared TS config (target: ES2022, module: NodeNext, moduleResolution: NodeNext, strict: true, declaration: true, declarationMap: true, sourceMap: true, outDir: dist, rootDir: src)
- `.npmrc` — strict-peer-dependencies=true, auto-install-peers=true

**Acceptance Criteria**:
- `pnpm install` resolves with no errors
- TypeScript config extends properly from packages

**Requirement Refs**: TDD §1.3 (pnpm workspaces, ESM)

---

### 1.2 Package Scaffolds ✅ Completed 2026-03-05

**Description**: Create empty package scaffolds for all 5 workspace packages with package.json and tsconfig.json. Each package gets a minimal src/index.ts entry point.

**Complexity**: S

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `packages/shared/package.json` — @open-brain/shared (exports: ./dist/index.js, types)
- `packages/shared/tsconfig.json` — extends ../../tsconfig.base.json
- `packages/shared/src/index.ts` — empty barrel export
- `packages/core-api/package.json` — @open-brain/core-api (depends on @open-brain/shared)
- `packages/core-api/tsconfig.json`
- `packages/core-api/src/index.ts`
- `packages/slack-bot/package.json` — @open-brain/slack-bot
- `packages/slack-bot/tsconfig.json`
- `packages/slack-bot/src/index.ts`
- `packages/workers/package.json` — @open-brain/workers
- `packages/workers/tsconfig.json`
- `packages/workers/src/index.ts`
- `packages/voice-capture/package.json` — @open-brain/voice-capture
- `packages/voice-capture/tsconfig.json`
- `packages/voice-capture/src/index.ts`

**Acceptance Criteria**:
- `pnpm build` succeeds across all packages (tsup builds, empty output OK)
- Cross-package imports from @open-brain/shared resolve correctly
- Each package has scripts: build (tsup), dev (tsx watch), test (vitest)

**Requirement Refs**: PRD §6 (monorepo structure), TDD §1.3

---

### 1.3 Docker Compose — Infrastructure Services ✅ Completed 2026-03-05

**Description**: Docker Compose with Postgres (pgvector/pgvector:pg16) and Redis for Phase 1A. Other containers added in later phases. Single `open-brain` network.

**Complexity**: S

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `docker-compose.yml` — postgres (pgvector/pgvector:pg16, 8GB memory limit, healthcheck, volume, custom postgresql.conf) + redis (7-alpine, healthcheck, volume) + open-brain network
- `config/postgresql.conf` — shared_buffers=2GB, effective_cache_size=6GB, work_mem=64MB, maintenance_work_mem=512MB, max_connections=20, random_page_cost=1.1, wal_buffers=64MB, checkpoint_completion_target=0.9

**Acceptance Criteria**:
- `docker compose up -d postgres redis` starts both containers
- `docker compose exec postgres pg_isready` returns success
- `docker compose exec redis redis-cli ping` returns PONG
- Postgres has pgvector extension available (`CREATE EXTENSION IF NOT EXISTS vector;`)
- Data persisted in ./data/postgres and ./data/redis volumes

**Requirement Refs**: PRD F02, TDD §16.1, TDD §2.3 (container memory)

---

### 1.4 Dockerfile (Multi-Stage, Multi-Target) ✅ Completed 2026-03-05

**Description**: Single multi-stage Dockerfile that builds all TypeScript packages. Uses targets for each service (core-api, slack-bot, workers, voice-capture). Production builds via tsup → single .mjs per service.

**Complexity**: M

**Files to Create**:
- `Dockerfile` — Multi-stage: base (node:22-alpine + pnpm), build (install deps + tsup build), core-api target (copies dist, runs entrypoint), slack-bot target, workers target, voice-capture target. Core-api entrypoint: `npx drizzle-kit migrate && node dist/server.mjs`

**Acceptance Criteria**:
- `docker build --target core-api -t open-brain-core-api .` succeeds
- Built image runs with `node dist/server.mjs`
- Core-api entrypoint runs migrations before starting server
- Image size < 200MB (alpine + minimal deps)

**Requirement Refs**: TDD §16.1 (Docker Compose services), TDD §1.3 (tsup production build)

**Status**: COMPLETE 2026-03-05

---

### 1.5 Environment and Git Configuration ✅ Completed 2026-03-05

**Description**: .env template with Bitwarden placeholders, .gitignore updates, and startup script for secret loading.

**Complexity**: S

**Status**: COMPLETE 2026-03-05

**Files to Create/Modify**:
- `.env` — All env vars with Bitwarden retrieval comments (POSTGRES_PASSWORD, LITELLM_API_KEY, Slack tokens, MCP_API_KEY, Pushover, SMTP, Cloudflare). Non-sensitive defaults (NODE_ENV, LOG_LEVEL, LITELLM_URL=https://llm.k4jda.net).
- `.gitignore` — Add: data/, dist/, .env.secrets, node_modules/, *.tsbuildinfo, .turbo/
- `scripts/load-secrets.sh` — bws CLI → .env.secrets extraction script (chmod 600)

**Acceptance Criteria**:
- `.env` contains no actual secrets, only placeholders with retrieval instructions
- `.gitignore` covers all generated/sensitive files
- `scripts/load-secrets.sh` generates .env.secrets from Bitwarden

**Requirement Refs**: PRD §7 (security), TDD §16.3, TDD §16.4 (startup sequence)

---

## Phase 2: Shared Package — Schema, Types & Utilities

**Goal**: Complete Drizzle schema for all tables, TypeScript type definitions, database client, and shared utility functions. This is the data foundation everything builds on.

**Dependencies**: Phase 1 (monorepo exists)

**Test Gate (PRD 1A partial)**: Drizzle migrations generate successfully. Schema types compile. Utility unit tests pass.

---

### 2.1 Drizzle Schema — Core Tables ✅ Completed 2026-03-05

**Description**: Drizzle ORM table definitions for captures, pipeline_events, and ai_audit_log. These are the Phase 1 tables needed for CRUD and pipeline.

**Complexity**: M

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `packages/shared/src/schema/captures.ts` — captures table with all columns (id, content, content_raw, content_hash, embedding vector(768), access_count, last_accessed_at, metadata, source, source_metadata, pre_extracted, tags, brain_views, pipeline_status, captured_at, created_at, updated_at, deleted_at) + all indexes (HNSW, GIN on metadata/tags/brain_views, FTS, created_at, source, pipeline_status, content_hash, captured_at)
- `packages/shared/src/schema/pipeline-events.ts` — pipeline_events table (id, capture_id FK cascade, stage, status, model, duration_ms, error, retry_count, created_at) + capture_id index
- `packages/shared/src/schema/ai-audit-log.ts` — ai_audit_log table (id, provider, model, task_type, tokens_in, tokens_out, latency_ms, success, error, created_at) + indexes on created_at, provider. Comment: cost tracking via LiteLLM only.

**Acceptance Criteria**:
- `npx drizzle-kit generate` produces valid SQL migration files
- Schema matches TDD §4.2 exactly (column names, types, defaults, indexes)
- vector(768) column works with pgvector extension
- FTS GIN index handled via custom SQL migration (Drizzle limitation)

**Requirement Refs**: PRD F02, TDD §4.2 (captures, pipeline_events, ai_audit_log schemas)

---

### 2.2 Drizzle Schema — Supporting Tables ✅ Completed 2026-03-05

**Description**: Remaining table schemas. These tables are created now but populated in later phases (entities in Phase 12, sessions in Phase 13, triggers in Phase 11).

**Complexity**: M

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `packages/shared/src/schema/entities.ts` — entities table (id, entity_type, name, aliases, metadata, first_seen, last_seen, mention_count, created_at, updated_at) + UNIQUE(name, entity_type). entity_links table (id, capture_id FK, entity_id FK, relationship, created_at) + indexes.
- `packages/shared/src/schema/sessions.ts` — sessions table (id, session_type, status, state, config, result, paused_at, created_at, updated_at, completed_at)
- `packages/shared/src/schema/session-messages.ts` — session_messages table (id, session_id FK cascade, role, board_role, content, created_at) + session_id index
- `packages/shared/src/schema/bets.ts` — bets table (id, commitment, falsifiable_criteria, status, due_date, session_id FK, evidence, created_at, updated_at, resolved_at)
- `packages/shared/src/schema/skills-log.ts` — skills_log table (id, skill_name, trigger_type, status, config, result, captures_queried, ai_model_used, token_usage, created_at, completed_at, error)
- `packages/shared/src/schema/triggers.ts` — triggers table (id, name, query_text, query_embedding vector(768), threshold default 0.72, delivery_channel, is_active, last_fired_at, fire_count, cooldown_minutes default 60, created_at, updated_at) + UNIQUE(name), index(is_active)

**Acceptance Criteria**:
- All tables generate valid migrations
- Foreign key relationships correct (entity_links → captures + entities, session_messages → sessions, bets → sessions)
- UNIQUE constraints on entities(name, entity_type) and triggers(name)

**Requirement Refs**: TDD §4.2 (all table definitions)

---

### 2.3 Schema Index, DB Client & Migrations ✅ Completed 2026-03-05

**Description**: Barrel export for all schemas, Drizzle database client factory, drizzle.config.ts for migration management, and the set_updated_at trigger.

**Complexity**: S

**Files to Create**:
- `packages/shared/src/schema/index.ts` — Re-export all table definitions
- `packages/shared/src/db.ts` — createDb() factory: takes DATABASE_URL, returns typed Drizzle client. Uses drizzle-orm/node-postgres (pg driver).
- `drizzle.config.ts` — Root-level config: schema path, migrations output dir, PostgreSQL connection
- `packages/shared/src/schema/migrations/0000_set_updated_at.sql` — Custom SQL migration for set_updated_at() trigger function + apply to all tables with updated_at column
- `packages/shared/src/schema/migrations/0001_fts_index.sql` — Custom SQL: `CREATE INDEX idx_captures_fts ON captures USING gin (to_tsvector('english', content));`

**Acceptance Criteria**:
- `npx drizzle-kit generate` produces migrations for all tables
- `npx drizzle-kit migrate` applies to a fresh Postgres (via docker compose)
- set_updated_at trigger fires on UPDATE (verify with test)
- FTS GIN index created successfully

**Requirement Refs**: PRD F02 (set_updated_at trigger), TDD §4.2, TDD §4.4 (indexing strategy)

**Status**: COMPLETE 2026-03-05

---

### 2.4 TypeScript Interfaces & Type Definitions ✅ Completed 2026-03-05

**Description**: All TypeScript interfaces referenced by the Drizzle schema $type annotations and used across packages.

**Complexity**: M

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `packages/shared/src/types/capture.ts` — CaptureMetadata (people, topics, type, action_items, dates, brain_views_suggested), SourceMetadata (slack_ts, device, duration_seconds, original_filename, url, channel, user), PreExtracted (template, confidence, fields, transcript_raw). CreateCaptureInput, CaptureFilters, CaptureRecord.
- `packages/shared/src/types/search.ts` — SearchOptions (query, limit, threshold, source, tags, brain_views, after, before, temporal_weight, search_mode, offset), SearchResult (id, content, metadata, source, tags, similarity, temporal_score, composite_score, captured_at)
- `packages/shared/src/types/session.ts` — SessionState (turn_count, max_turns, topics_covered, topics_remaining, last_role, idle_timeout_minutes), SessionConfig, SessionResult, TranscriptEntry (maps to session_messages rows)
- `packages/shared/src/types/ai.ts` — AITaskType enum (embedding, metadata_extraction, synthesis, governance, intent, career_signals, weekly_brief, drift_detection), AIOptions, AIResponse, TokenUsage (input_tokens, output_tokens — no cost_estimate)
- `packages/shared/src/types/config.ts` — PipelineConfig, AIRoutingConfig, BrainViewConfig, SkillConfig, NotificationConfig + Zod schemas for each
- `packages/shared/src/types/index.ts` — Barrel export

**Acceptance Criteria**:
- All types compile with strict TypeScript
- Drizzle schema $type annotations reference these interfaces
- Zod schemas validate config YAML structure (used by ConfigService in Phase 3)
- BrainView is `string` (config-driven, not hardcoded union)

**Requirement Refs**: TDD §5.1 (TypeScript interfaces), TDD §5.2 (validation rules)

---

### 2.5 Shared Utilities ✅ Completed 2026-03-05

**Description**: Utility functions used across packages: content hashing, token estimation, and common helpers.

**Complexity**: S

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `packages/shared/src/utils/content-hash.ts` — contentHash(text): normalize (trim, collapse whitespace, lowercase) → SHA-256 hex string (char(64))
- `packages/shared/src/utils/tokens.ts` — estimateTokens(text): chars/4 approximation with 10% safety margin. No tokenizer dependency.
- `packages/shared/src/utils/errors.ts` — AppError base class, NotFoundError, ValidationError, ConflictError, ServiceUnavailableError. Standard error hierarchy per TDD §9.1.
- `packages/shared/src/utils/index.ts` — Barrel export
- `packages/shared/src/index.ts` — Update barrel export to include schema, types, utils, db
- `packages/shared/src/__tests__/content-hash.test.ts` — Unit tests: same input → same hash, whitespace normalization, case normalization
- `packages/shared/src/__tests__/tokens.test.ts` — Unit tests: known text → expected token range

**Acceptance Criteria**:
- contentHash produces consistent SHA-256 for normalized text
- estimateTokens returns reasonable estimates (within 20% of tiktoken for English text)
- Error hierarchy matches TDD §9.1
- All unit tests pass via `pnpm test --filter @open-brain/shared`

**Requirement Refs**: TDD §5.2 (content_hash, token estimation), TDD §9.1 (error hierarchy)

---

## Phase 3: Core API Scaffold

**Goal**: Running Hono server with health endpoint, error handling, config service, and admin endpoints. No business logic yet — just the framework that CRUD and search plug into.

**Dependencies**: Phase 2 (shared package with schema and types)

**Test Gate**: `curl localhost:3000/health` returns service status JSON. Config loads and validates from YAML. Error responses follow standard format.

---

### 3.1 Hono Application Setup ✅ Completed 2026-03-05

**Description**: Core API entry point with Hono app, middleware stack (logger, error handler, CORS), and server startup.

**Complexity**: M

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `packages/core-api/src/server.ts` — Hono app creation, middleware registration, route mounting, server start (port 3000). Entrypoint for Docker.
- `packages/core-api/src/middleware/error-handler.ts` — Global error handler: catches AppError subclasses → standard JSON error response (code, message, details). Catches unknown errors → 500 with generic message.
- `packages/core-api/src/middleware/logger.ts` — Request/response logging middleware (method, path, status, duration_ms). Uses pino logger.
- `packages/core-api/src/lib/logger.ts` — pino logger factory with configurable level (LOG_LEVEL env var, default: info)

**Acceptance Criteria**:
- Server starts on port 3000
- Unhandled errors return standard JSON format: `{ error: { code: string, message: string, details?: any } }`
- Request logging shows method, path, status code, duration

**Requirement Refs**: TDD §3.1 (API overview), TDD §9.2 (error response format), TDD §10.1 (logging)

---

### 3.2 Health Endpoint ✅ Completed 2026-03-05

**Description**: GET /health endpoint that checks connectivity to Postgres, Redis, and LiteLLM. Returns overall status and per-service status.

**Complexity**: S

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `packages/core-api/src/routes/health.ts` — GET /health: checks Postgres (SELECT 1), Redis (PING), LiteLLM (GET https://llm.k4jda.net/health). Returns `{ status: "healthy"|"degraded"|"unhealthy", services: { postgres: "up"|"down", redis: "up"|"down", litellm: "up"|"down" }, version: string, uptime: number }`

**Acceptance Criteria**:
- Returns 200 with status "healthy" when all services are up
- Returns 200 with status "degraded" if optional services are down
- Returns 503 with status "unhealthy" if Postgres is down
- Response time < 500ms

**Requirement Refs**: PRD F01 (health endpoint), TDD §3.2 (health endpoint spec)

---

### 3.3 ConfigService with Zod Validation ✅ Completed 2026-03-05

**Description**: In-memory YAML config loader with per-file Zod validation. Loads config/ directory on startup, caches indefinitely, explicit reload via admin endpoint.

**Complexity**: M

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `packages/shared/src/services/config.ts` — ConfigService class: loadAll() parses YAML files from config/ dir, validates each against its Zod schema, caches in Map. get<T>(filename) returns typed config. reload() re-reads all files, keeps previous on validation failure, returns ReloadResult[]. Logs file hash + validation status.
- `packages/shared/src/types/config.ts` — (Update from Phase 2.4) Add Zod schemas: pipelinesConfigSchema, aiRoutingConfigSchema, brainViewsConfigSchema, skillsConfigSchema, notificationsConfigSchema
- `config/brain-views.yaml` — Default brain views: career, personal, technical, work-internal, client. Each with description and keywords.
- `config/pipelines.yaml` — Default pipeline definition (stub — full config in Phase 6)
- `config/ai-routing.yaml` — Embedding config + task model mapping (stub — full config in Phase 6)
- `config/notifications.yaml` — Notification preferences (stub — full config in Phase 10)
- `config/skills.yaml` — Skill definitions (stub — full config in Phase 10)

**Acceptance Criteria**:
- ConfigService.loadAll() loads and validates all YAML files on startup
- Invalid YAML → throw ConfigError on startup (fail fast)
- Invalid YAML on reload → log error, keep previous cached version
- get<T>('brain-views') returns typed BrainViewConfig
- Reload returns list of files with success/failure status

**Requirement Refs**: TDD §6.2 (ConfigService), TDD §17.1 (config-driven features)

---

### 3.4 Admin Endpoints ✅ Completed 2026-03-05

**Description**: Admin routes for config reload and future Bull Board mounting point.

**Complexity**: S

**Status**: COMPLETE 2026-03-05

**Files to Create**:
- `packages/core-api/src/routes/admin.ts` — POST /api/v1/admin/config/reload → calls ConfigService.reload(), returns ReloadResult[]. Placeholder route for /admin/queues (Bull Board, Phase 6).

**Acceptance Criteria**:
- POST /api/v1/admin/config/reload returns list of reloaded files with status
- Admin routes mounted at correct paths

**Requirement Refs**: TDD §6.2 (ConfigService reload), PRD F03 (Bull Board)

---

### 3.5 Core API Tests

**Description**: Unit and integration tests for the API scaffold.

**Complexity**: S

**Files to Create**:
- `packages/core-api/vitest.config.ts` — Vitest config with Testcontainers support
- `packages/core-api/src/__tests__/health.test.ts` — Health endpoint tests: healthy response, degraded when Redis down
- `packages/core-api/src/__tests__/error-handler.test.ts` — Error middleware tests: AppError → JSON, unknown error → 500
- `packages/core-api/src/__tests__/config.test.ts` — ConfigService tests: valid YAML loads, invalid YAML throws on startup, reload keeps previous on failure

**Acceptance Criteria**:
- `pnpm test --filter @open-brain/core-api` passes all tests
- Tests use Testcontainers for Postgres/Redis where needed
- Test coverage > 80% for health and error handling

**Requirement Refs**: TDD §15.1 (test coverage), TDD §15.2 (Vitest + Testcontainers)

---

## Phase 4: Capture CRUD Endpoints

**Goal**: Full capture lifecycle — create, read, list, update, soft-delete. Captures persist in Postgres but don't go through pipeline yet (pipeline_status stays 'received').

**Dependencies**: Phase 3 (Core API scaffold, ConfigService)

**Test Gate (PRD 1A)**: Insert capture via curl, read back, list with filters, PATCH tags/brain_views, DELETE soft-deletes. Vitest unit + Testcontainers integration tests pass. Captures stay at pipeline_status 'received'.

---

### 4.1 CaptureService

**Description**: Service class handling capture creation with deduplication, retrieval with pipeline_events JOIN, listing with filters, updates, and soft deletes.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/services/capture.ts` — CaptureService class:
  - create(input): content_hash dedup (SHA-256 + 60-second window), insert with status 'received', return record
  - getById(id): SELECT with LEFT JOIN pipeline_events + LEFT JOIN entity_links → entities (for detail view). Excludes soft-deleted.
  - list(filters): Paginated SELECT with filters (source, capture_type, brain_view, start_date, end_date, tags). Excludes soft-deleted. Returns { data, total, limit, offset }.
  - update(id, patch): Merge metadata_overrides, update tags/brain_views. No re-embedding.
  - softDelete(id): SET deleted_at = now()
  - getStats(): Aggregate counts by source, type, view, pipeline_status.

**Acceptance Criteria**:
- Duplicate content within 60s window → ConflictError (409)
- Soft-deleted captures excluded from list and getById
- Metadata overrides merged (not replaced) with existing metadata
- Stats return accurate counts

**Requirement Refs**: PRD F01 (capture CRUD), TDD §6.2 (CaptureService), TDD §5.2 (dedup logic)

---

### 4.2 Capture Zod Schemas

**Description**: Zod validation schemas for all capture-related API inputs.

**Complexity**: S

**Files to Create**:
- `packages/core-api/src/schemas/capture.ts` — createCaptureSchema (content: string required, source: enum, source_metadata: object optional, pre_extracted: object optional, tags: string[] optional, brain_views: string[] optional, captured_at: ISO datetime optional). updateCaptureSchema (tags, brain_views, metadata_overrides — all optional). listCapturesSchema (limit: int default 20 max 100, offset: int default 0, source, capture_type, brain_view, start_date, end_date — all optional).

**Acceptance Criteria**:
- Invalid input → 422 with field-level error details
- Valid input passes through cleanly
- brain_views validated against ConfigService loaded brain views (runtime, not hardcoded)

**Requirement Refs**: TDD §5.2 (validation rules), PRD F01 (ingest payload)

---

### 4.3 Capture Routes

**Description**: Hono route handlers for all capture endpoints. Thin layer: validate input (Zod), call CaptureService, format response.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/routes/captures.ts` —
  - POST /api/v1/captures → validate → captureService.create() → 201 { id, pipeline_status, created_at }
  - GET /api/v1/captures → validate query → captureService.list() → 200 { data, total, limit, offset }
  - GET /api/v1/captures/:id → captureService.getById() → 200 (full detail with pipeline_events, linked_entities) or 404
  - PATCH /api/v1/captures/:id → validate → captureService.update() → 200 (updated record) or 404
  - DELETE /api/v1/captures/:id → captureService.softDelete() → 204 or 404

**Acceptance Criteria**:
- All endpoints return JSON with correct status codes
- POST returns 201 with capture ID within 500ms
- GET /:id includes pipeline_events array and linked_entities (empty until Phase 6/12)
- PATCH merges metadata_overrides
- DELETE returns 204 No Content

**Requirement Refs**: PRD F01 (all endpoints), TDD §3.2 (endpoint specs)

---

### 4.4 Stats Endpoint

**Description**: GET /api/v1/stats returning brain statistics — capture counts by source, type, view, pipeline health.

**Complexity**: S

**Files to Create**:
- `packages/core-api/src/routes/stats.ts` — GET /api/v1/stats → captureService.getStats() → 200 { total_captures, captures_by_source, captures_by_type, captures_by_view, total_entities, pipeline_health: { pending, processing, failed } }

**Acceptance Criteria**:
- Returns accurate aggregate counts
- pipeline_health shows count of captures in each status
- Response < 500ms

**Requirement Refs**: PRD F01 (stats endpoint), TDD §3.2 (GET /api/v1/stats)

---

### 4.5 Capture CRUD Tests

**Description**: Comprehensive tests for capture lifecycle — unit tests for CaptureService, integration tests for endpoints.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/__tests__/capture-service.test.ts` — Unit tests: create with dedup, list with filters, update merge, soft delete exclusion, stats counts
- `packages/core-api/src/__tests__/captures-routes.test.ts` — Integration tests (Testcontainers): POST → 201, GET → 200, LIST with filters, PATCH → 200, DELETE → 204, duplicate → 409, not found → 404, invalid input → 422

**Acceptance Criteria**:
- All tests pass
- Integration tests use real Postgres via Testcontainers
- Test coverage > 85% for CaptureService and routes
- Tests verify content_hash dedup with 60-second window

**Requirement Refs**: TDD §15.3 (unit test examples), TDD §15.4 (integration tests), PRD Phase 1A test gate

---

## Phase 5: Embedding + Search

**Goal**: Semantic search works. LiteLLM routes embeddings to Jetson (Qwen3-Embedding-4B-Q4_K_M). Hybrid search (FTS + vector + RRF) with ACT-R temporal scoring returns ranked results.

**Dependencies**: Phase 4 (captures exist in database)

**Test Gate (PRD 1B)**: Insert 20-30 test captures, generate embeddings, vector search returns relevant results (>0.7 similarity), hybrid search improves recall on paraphrased queries, FTS catches exact keywords. Embedding throughput via LiteLLM documented.

---

### 5.1 EmbeddingService

**Description**: Service that generates 768-dimensional embeddings via LiteLLM (external at https://llm.k4jda.net). Uses the `jetson-embeddings` alias which routes to Qwen3-Embedding-4B-Q4_K_M on the Jetson. OpenAI-compatible embeddings API. No fallback — throws EmbeddingUnavailableError if LiteLLM/Jetson is unreachable; BullMQ retries with patient backoff.

**Complexity**: M

**Files to Create**:
- `packages/shared/src/services/embedding.ts` — EmbeddingService class:
  - constructor(litellmBaseUrl, litellmApiKey, configService)
  - Uses OpenAI SDK: `new OpenAI({ baseURL: litellmUrl, apiKey: litellmApiKey })`
  - embed(text, type: 'document'|'query'): `openai.embeddings.create({ model: 'jetson-embeddings', input: text })` → returns number[768]. Applies instruction prefix for Qwen3 query vs document type if supported.
  - embedBatch(texts, type): Sequential embed calls, returns number[][768]
  - getModelInfo(): Returns model alias, dimensions (768), source from ai-routing.yaml
  - Throws EmbeddingUnavailableError on connection failure or non-200 response
- `packages/shared/src/__tests__/embedding.test.ts` — Unit tests with mocked OpenAI client: correct API call, correct model alias, error on unavailable

**Acceptance Criteria**:
- Generates 768-dim embeddings via LiteLLM `jetson-embeddings` alias
- Model alias configurable via ai-routing.yaml (no hardcoding)
- EmbeddingUnavailableError thrown cleanly on failure (no hanging, timeout 30s)
- Same LITELLM_URL/LITELLM_API_KEY env vars as AIRouterService (no separate OLLAMA_URL)

**Requirement Refs**: TDD §6.2 (EmbeddingService), TDD §8.7 (LiteLLM integration)

---

### 5.2 SQL Search Functions

**Description**: Deploy match_captures (vector + temporal) and match_captures_hybrid (RRF) as Postgres functions via custom Drizzle migration.

**Complexity**: M

**Files to Create**:
- `packages/shared/src/schema/migrations/0002_match_captures.sql` — match_captures function: vector cosine similarity + ACT-R temporal decay (ln(access_count) - 0.5 * ln(hours_since_last_access)), multiplicative composite score: `semantic_sim * (1.0 + temporal_weight * temporal_act)`. Filters: source, tags (&&), brain_views (&&), date range, deleted_at IS NULL, pipeline_status = 'complete'. Default temporal_weight: 0.0.
- `packages/shared/src/schema/migrations/0003_match_captures_hybrid.sql` — match_captures_hybrid function: combines vector similarity (cosine) + FTS (ts_rank_cd with to_tsvector/plainto_tsquery) via Reciprocal Rank Fusion. RRF formula: score = 1/(k+rank_vector) + 1/(k+rank_fts), k=60. Same temporal boost and filters as match_captures.

**Acceptance Criteria**:
- match_captures returns results ordered by composite_score DESC
- match_captures_hybrid returns results combining vector and FTS ranks
- temporal_weight = 0.0 → pure semantic ordering (no temporal influence)
- Filters work correctly (source, tags, brain_views, date range)
- Soft-deleted and non-complete captures excluded

**Requirement Refs**: PRD F02 (match_captures function), TDD §4.3 (both search functions)

---

### 5.3 SearchService

**Description**: Service that orchestrates search: embed query → call appropriate SQL function → enqueue access stats update → return ranked results.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/services/search.ts` — SearchService class:
  - constructor(db, embeddingService, queue)
  - search(options: SearchOptions): embed query → based on search_mode: hybrid calls match_captures_hybrid, vector calls match_captures, fts calls FTS-only query. Enqueue update_access_stats job for returned IDs. Return SearchResult[] with similarity, temporal_score, composite_score.

**Acceptance Criteria**:
- Three search modes work: hybrid (default), vector, fts
- Query embedding generated via EmbeddingService
- Access stats job enqueued after search (non-blocking)
- Results include similarity and composite scores

**Requirement Refs**: TDD §6.2 (SearchService), PRD F05 (search behavior)

---

### 5.4 Search Endpoint + Zod Schema

**Description**: POST /api/v1/search endpoint with Zod validation.

**Complexity**: S

**Files to Create**:
- `packages/core-api/src/schemas/search.ts` — searchSchema: query (string, required), limit (int, default 10, max 50), threshold (float, default 0.5), source (string optional), tags (string[] optional), brain_views (string[] optional), start_date (ISO optional), end_date (ISO optional), temporal_weight (float, default 0.0), search_mode (enum: hybrid|vector|fts, default hybrid), offset (int, default 0)
- `packages/core-api/src/routes/search.ts` — POST /api/v1/search → validate → searchService.search() → 200 { results, query, total }

**Acceptance Criteria**:
- Endpoint accepts search body, returns ranked results
- Default temporal_weight is 0.0 (cold start)
- Default search_mode is hybrid
- Pagination via offset + limit

**Requirement Refs**: PRD F01 (search endpoint), TDD §3.2 (POST /api/v1/search spec)

---

### 5.5 Update Access Stats Job

**Description**: Background BullMQ job that increments access_count and sets last_accessed_at for captures returned in search results. Low priority, eventually consistent.

**Complexity**: S

**Files to Create**:
- `packages/workers/src/jobs/update-access-stats.ts` — BullMQ job handler: receives captureIds + accessedAt. Batch UPDATE: `SET access_count = access_count + 1, last_accessed_at = $1 WHERE id = ANY($2::uuid[])`. Log WARN on failure (no aggressive retry).
- `packages/workers/src/queues/access-stats.ts` — Queue definition: name 'access-stats', priority 1 (low), timeout 10s, retries 1

**Acceptance Criteria**:
- Batch update works for multiple capture IDs
- access_count increments atomically
- Job failure → WARN log, no retry storm
- Job completes in < 1 second

**Requirement Refs**: TDD §12.2a (UpdateAccessStatsJob), PRD F02 (temporal tracking)

---

### 5.6 Search Tests

**Description**: Search integration and unit tests. Embeddings go through LiteLLM (`jetson-embeddings` alias) — no local Ollama container needed in the Open Brain stack.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/__tests__/search.test.ts` — Integration tests (Testcontainers for Postgres): pre-insert captures with known embeddings → vector search returns relevant results, hybrid search improves recall, FTS catches keywords, temporal_weight affects ranking, filters work. Use pre-computed embedding vectors (no live LiteLLM call in tests).
- `packages/core-api/src/__tests__/search-service.test.ts` — Unit tests with mocked EmbeddingService: search modes, access stats enqueue

**Acceptance Criteria**:
- Search returns results with >0.7 similarity for known embedding matches
- Hybrid search outperforms vector-only on paraphrased queries
- All three search modes (hybrid, vector, fts) tested
- Tests pass without external LiteLLM dependency (embeddings mocked or pre-computed)

**Requirement Refs**: PRD Phase 1B test gate, TDD §6.2 (SearchService)

---

## Phase 6: Pipeline + LLM Gateway

**Goal**: Captures auto-process through BullMQ pipeline stages. LiteLLM routes LLM calls. AIRouter maps tasks to models. Bull Board shows queue health.

**Dependencies**: Phase 5 (embeddings work, search works)

**Test Gate (PRD 1C)**: Insert capture via API → automatically embedded, metadata extracted, pipeline_status = 'complete'. pipeline_events shows all stages with timing. Simulate LiteLLM embedding failure → capture queues, retries on recovery. LiteLLM routes aliases correctly. Bull Board accessible.

---

### 6.1 BullMQ Queue Setup

**Description**: Redis-backed BullMQ queues for capture pipeline, skill execution, notifications, access stats, and daily sweep. Queue definitions with priorities, timeouts, and retry policies.

**Complexity**: M

**Files to Create**:
- `packages/workers/src/queues/index.ts` — Queue factory: creates all queues from Redis connection. Exports: capturePipeline, skillExecution, notification, accessStats, dailySweep.
- `packages/workers/src/queues/capture-pipeline.ts` — Queue definition: priority 5, timeout 5min, 5 retries with patient backoff [30s, 2m, 10m, 30m, 2h]
- `packages/workers/src/queues/notification.ts` — Queue definition: pushover (priority 7, timeout 30s, 3 retries), email (priority 5, timeout 60s), slack-reply (priority 7, timeout 10s)
- `packages/workers/src/queues/skill-execution.ts` — Queue definition: priority 3, timeout 5min, 3 retries with exponential backoff. On final failure: Pushover alert.

**Acceptance Criteria**:
- All queues connect to Redis successfully
- Patient backoff delays: 30s, 2m, 10m, 30m, 2h
- Queue health queryable (waiting, active, completed, failed counts)

**Requirement Refs**: TDD §12.1 (queue architecture), TDD §12.2 (job definitions)

---

### 6.2 Pipeline Stage Executor

**Description**: Core pipeline execution engine. Reads pipeline config, executes stages in order, records results to pipeline_events table, handles failures per stage.

**Complexity**: L

**Files to Create**:
- `packages/workers/src/pipeline/executor.ts` — executePipeline(captureId, stages): for each stage, execute → insert pipeline_event. Embed failure blocks all subsequent stages (throw to BullMQ retry). Other stage failures → continue, mark status 'partial'. Final status: 'complete' or 'partial'.
- `packages/workers/src/pipeline/stages/embed.ts` — Embed stage: call EmbeddingService.embed(capture.content), UPDATE captures SET embedding = $1. After success, enqueue check_triggers job (Phase 11 — no-op until then).
- `packages/workers/src/pipeline/stages/extract-metadata.ts` — Extract metadata stage: call AIRouterService.complete('metadata_extraction', prompt). Parse structured JSON response (people, topics, type, action_items, dates, brain_views). UPDATE captures SET metadata = $1, brain_views = $2. If pre_extracted exists and merge_with_pre_extracted, merge fields.
- `packages/workers/src/pipeline/stages/notify.ts` — Notify stage (stub): log "notification would be sent". Real implementation in Phase 10.
- `packages/workers/src/pipeline/worker.ts` — BullMQ Worker that processes capture-pipeline jobs. Reads pipeline config from ConfigService per job. Calls executePipeline.

**Acceptance Criteria**:
- Capture goes from 'received' → 'processing' → 'complete'
- pipeline_events records each stage with timing
- Embed failure → BullMQ retries with patient backoff
- extract_metadata failure → stage marked failed, pipeline continues to notify, final status 'partial'
- Pre-extracted metadata merged when flag set

**Requirement Refs**: TDD §12.3 (pipeline stage executor), PRD F03 (pipeline stages)

---

### 6.3 AIRouterService + LiteLLM Integration

**Description**: Thin wrapper that maps task types to LiteLLM model aliases. Logs usage to ai_audit_log. LiteLLM handles provider routing, fallback, and budget.

**Complexity**: M

**Files to Create**:
- `packages/shared/src/services/ai-router.ts` — AIRouterService class:
  - constructor(configService, db, litellmBaseUrl, litellmApiKey)
  - complete(taskType, prompt, options?): lookup model alias from ai-routing.yaml → call OpenAI SDK pointed at LiteLLM → log to ai_audit_log → return response
  - getMonthlySpend(): GET LiteLLM /spend/logs endpoint — returns { total, by_model }
  - Uses OpenAI SDK (`new OpenAI({ baseURL: litellmUrl, apiKey })`) — same client as EmbeddingService
- `config/ai-routing.yaml` — Full config: embedding (model: jetson-embeddings, dimensions: 768, note: Qwen3-Embedding-4B-Q4_K_M via Jetson through LiteLLM), task_models (metadata_extraction: fast, intent_classification: intent, synthesis: synthesis, governance: governance, career_signals: synthesis, weekly_brief: synthesis, drift_detection: fast). Note: all aliases resolve on external LiteLLM at https://llm.k4jda.net. LLM provider for fast/intent/synthesis/governance is TBD — configure aliases on server before Phase 6.

**NOTE — no `config/litellm-config.yaml` in this repo**: LiteLLM is an external shared service at https://llm.k4jda.net. Its model list, provider config, and budget are managed on that server. Required aliases that must be pre-configured there before Phase 6: `jetson-embeddings` (Qwen3-Embedding-4B-Q4_K_M on Jetson), `fast` (TBD local LLM), `intent` (TBD local LLM), `synthesis` (cloud LLM TBD), `governance` (cloud LLM TBD).

**Acceptance Criteria**:
- Task type → LiteLLM alias mapping works from ai-routing.yaml config
- ai_audit_log entries created for every LLM call
- OpenAI SDK calls route through LiteLLM correctly
- Monthly spend queryable via getMonthlySpend()

**Requirement Refs**: TDD §6.2 (AIRouterService), PRD F08 (AI Router), TDD §8.7 (LiteLLM)

---

### 6.4 Pipeline Configuration Files

**Description**: Full pipeline YAML configuration and prompt templates for Phase 1 stages.

**Complexity**: S

**Files to Create**:
- `config/pipelines.yaml` — Full config: default pipeline (embed → extract_metadata → notify), voice pipeline (embed → extract_metadata with merge_with_pre_extracted → notify with pushover), career pipeline (extends default + extract_career_signals after extract_metadata)
- `config/prompts/extract_metadata_v1.txt` — System prompt for metadata extraction: extract people, topics, capture_type (decision|idea|observation|task|win|blocker|question|reflection), action_items, dates, brain_views_suggested. Output as structured JSON. {{variable}} placeholders, ---SYSTEM---/---USER--- delimiters.
- `config/prompts/intent_router_v1.txt` — System prompt for Slack intent classification: classify as CAPTURE, QUERY, COMMAND, or CONVERSATION. Return JSON with intent and confidence.

**Acceptance Criteria**:
- Pipeline YAML validates against pipelinesConfigSchema
- Prompt templates use {{content}} placeholder
- Templates have ---SYSTEM---/---USER--- delimiters

**Requirement Refs**: PRD F03 (pipeline YAML), TDD §C (prompt templates)

---

### 6.5 Bull Board + Docker Services

**Description**: Bull Board UI at /admin/queues for queue monitoring. Core API and Workers Docker Compose service definitions. LiteLLM is external at https://llm.k4jda.net — no container needed.

**Complexity**: S

**Files to Create/Modify**:
- `packages/core-api/src/routes/admin.ts` — Mount @bull-board/hono at /admin/queues. Register all queues.
- `docker-compose.yml` — Add core-api service definition (build target, ports, env_file .env.secrets, env vars for DATABASE_URL/REDIS_URL/LITELLM_URL=https://llm.k4jda.net/LITELLM_API_KEY/MCP_API_KEY, config volume, depends on postgres+redis, healthcheck). No OLLAMA_URL — embeddings and LLM inference both route through LiteLLM.
- `docker-compose.yml` — Add workers service definition (build target, env vars for DATABASE_URL/REDIS_URL/LITELLM_URL=https://llm.k4jda.net/LITELLM_API_KEY/CORE_API_URL, config volume, depends on postgres+redis)

**Acceptance Criteria**:
- Bull Board UI accessible at /admin/queues
- Core API and Workers containers build and start
- `curl https://llm.k4jda.net/health` returns healthy from within containers
- LiteLLM routes `jetson-embeddings` and inference aliases correctly

**Requirement Refs**: PRD F03 (Bull Board), PRD F07a (LiteLLM), TDD §16.1 (Docker Compose)

---

### 6.6 Pipeline Integration + Capture Auto-Processing

**Description**: Wire pipeline into capture creation — when CaptureService.create() is called, automatically enqueue pipeline job. Update CaptureService and routes to trigger pipeline.

**Complexity**: M

**Files to Modify**:
- `packages/core-api/src/services/capture.ts` — Update create(): after insert, enqueue pipeline job via PipelineService. Select pipeline based on source + brain_views (ConfigService lookup).
- `packages/core-api/src/routes/captures.ts` — Add POST /api/v1/captures/:id/retry?stage=... → retry failed pipeline stages

**Files to Create**:
- `packages/core-api/src/services/pipeline.ts` — PipelineService: enqueue(captureId, pipelineName), getHealth() returns queue stats
- `packages/core-api/src/__tests__/pipeline.test.ts` — Integration tests: create capture → pipeline auto-starts, embed succeeds → extract_metadata runs, embed fails → retries with backoff, retry endpoint works

**Acceptance Criteria**:
- POST /api/v1/captures → capture created → pipeline job enqueued → stages execute → status = 'complete'
- pipeline_events show all stages with model, duration, status
- Failed stages can be retried via API
- Pipeline health visible at /admin/queues

**Requirement Refs**: PRD Phase 1C test gate, TDD §6.2 (PipelineService)

---

### 6.7 Daily Sweep Worker

**Description**: Scheduled BullMQ job that runs at 3:00 AM daily, finds captures stuck in `received` or `processing` status, and re-enqueues them for pipeline processing. Catches transient failures (LiteLLM blip, Redis restart) that outlasted the initial retry window.

**Complexity**: S

**Files to Create**:
- `packages/workers/src/jobs/daily-sweep.ts` — DailySweepJob: queries `SELECT id FROM captures WHERE pipeline_status IN ('received', 'processing') AND created_at < NOW() - INTERVAL '1 hour'`. For each found capture, enqueue a capture-pipeline job (idempotent — BullMQ deduplicates by jobId=captureId). Log count of captures re-queued.
- `packages/workers/src/scheduler.ts` — BullMQ repeatable job setup: `dailySweepQueue.add('daily-sweep', {}, { repeat: { cron: '0 3 * * *' }, jobId: 'daily-sweep-recurring' })`. Called on worker startup.

**Acceptance Criteria**:
- Repeatable job registered at startup with cron `0 3 * * *`
- Queries captures older than 1 hour stuck in received/processing
- Re-enqueues each as a capture-pipeline job with jobId=captureId (dedup safe)
- Logs number of captures swept
- No-op when all captures are complete

**Requirement Refs**: PRD F03 (daily auto-retry sweep), TDD §2376 (daily auto-retry sweep), TDD §12.2 (daily-sweep job)

---

## Phase 7: Slack Bot — Capture + Query

**Goal**: Capture and query via Slack. Type in #open-brain → captured. `? query` → search results. Thread follow-ups work. First "it feels like a product" moment.

**Dependencies**: Phase 6 (pipeline processes captures, search works)

**Test Gate (PRD 1D)**: Text in #open-brain → thread reply confirms capture with metadata. `? QSR pricing` → ranked results. Reply with number → full detail. Duplicate slack_ts rejected. Bot ignores its own messages.

---

### 7.1 Slack Bot Setup

**Description**: @slack/bolt application with Socket Mode. Connects to Slack workspace, listens for messages in #open-brain and @mentions.

**Complexity**: M

**Files to Create**:
- `packages/slack-bot/src/app.ts` — Bolt App initialization with socketMode: true. Environment: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CORE_API_URL, REDIS_URL, LITELLM_URL.
- `packages/slack-bot/src/server.ts` — Entry point: create app, register handlers, start. Graceful shutdown.
- `packages/slack-bot/src/lib/core-api-client.ts` — HTTP client for Core API: captures.create(), captures.get(), search.query(), synthesize.query(), stats.get(). Uses fetch.
- `packages/slack-bot/src/lib/formatters.ts` — Slack message formatters: formatSearchResults (numbered list with date, type, match %, preview), formatCapture (full detail), formatStats, formatError

**Acceptance Criteria**:
- Bot connects to Slack via Socket Mode
- Receives messages from #open-brain channel
- Ignores messages from bots (prevent feedback loops)
- Handles Slack URL verification challenge

**Requirement Refs**: PRD F04 (Slack bot), TDD §8.1 (Slack integration), TDD §1.3 (@slack/bolt)

---

### 7.2 Intent Router

**Description**: Classifies incoming Slack messages as CAPTURE, QUERY, COMMAND, or CONVERSATION. Prefix-based first (always works), LLM classification layered on top.

**Complexity**: M

**Files to Create**:
- `packages/slack-bot/src/intent/router.ts` — IntentRouter class:
  - classify(text, context): prefix check first: `?` → QUERY, `!` → COMMAND, `@Open Brain` → QUERY, no prefix → CAPTURE. If prefix matched, return immediately.
  - If no prefix match, check for natural question patterns. If LiteLLM available, call intent model for ambiguous cases. If LiteLLM unavailable, fall back to prefix-only (default CAPTURE).
  - Returns: { intent: 'capture'|'query'|'command'|'conversation', confidence: number, prefix_matched: boolean }

**Acceptance Criteria**:
- `? query` → QUERY (immediate, no LLM call)
- `!stats` → COMMAND
- `@Open Brain what about...` → QUERY
- Plain text → CAPTURE (default)
- LiteLLM failure → graceful degradation to prefix-only

**Requirement Refs**: PRD F04/F05 (intent triggers), TDD §8.1 (intent classification)

---

### 7.3 Capture Handler

**Description**: Processes incoming messages classified as CAPTURE. Calls Core API to create capture, replies in thread with confirmation.

**Complexity**: S

**Files to Create**:
- `packages/slack-bot/src/handlers/capture.ts` — handleCapture(message, say):
  1. Check dedup via slack_ts (in source_metadata)
  2. Call Core API POST /api/v1/captures with content, source: 'slack', source_metadata: { slack_ts, channel, user }
  3. Wait for pipeline completion (poll or callback — simple poll with 3 attempts, 5s intervals)
  4. Reply in thread: "Captured as *{type}* — {topics}. People: {people}."
  5. Handle audio attachments → route to voice-capture HTTP endpoint

**Acceptance Criteria**:
- Text message → capture created → thread reply with extracted metadata
- Duplicate slack_ts → reply "Already captured" (no new capture)
- Audio attachments detected and routed (Phase 9 wires the endpoint)
- Error → thread reply with error message

**Requirement Refs**: PRD F04 (capture behavior), TDD §3.2 (ingest payload)

---

### 7.4 Query Handler + Thread Context

**Description**: Processes QUERY intents. Performs search, formats results, manages thread context in Redis for follow-up interactions.

**Complexity**: M

**Files to Create**:
- `packages/slack-bot/src/handlers/query.ts` — handleQuery(message, say):
  1. Extract query text (strip `?` prefix, `@Open Brain`)
  2. Check if reply in existing search thread (Redis thread context lookup by thread_ts)
  3. If follow-up: handle number selection (full detail), "more" (next page), refined query
  4. If new query: call Core API POST /api/v1/search → format results → reply in thread
  5. Store thread context in Redis (query, page, results) with 1-hour TTL
  6. If thread context expired (reply in search thread but no context): reply "This search has expired (1-hour timeout). Send a new query to search again."
- `packages/slack-bot/src/handlers/synthesis.ts` — handleSynthesis(message, say):
  1. Detect synthesis intent: "summarize", "synthesize", "what's the pattern"
  2. Call Core API POST /api/v1/synthesize
  3. Reply with synthesized response
- `packages/slack-bot/src/lib/thread-context.ts` — Redis-backed thread context: setThreadContext(threadTs, context, ttl=3600), getThreadContext(threadTs), deleteThreadContext(threadTs)

**Acceptance Criteria**:
- `? QSR pricing` → formatted search results with match percentages
- Reply with number → full capture detail
- Reply with "more" → next page of results
- Expired thread → clear message about 1-hour timeout
- Synthesis queries produce multi-paragraph AI responses
- Thread context TTL is 1 hour

**Requirement Refs**: PRD F05 (query behavior, thread context), TDD §11.3 (thread context), PRD F05 (thread expiration UX)

---

### 7.5 Slack Bot Tests + Docker

**Description**: Tests for intent router and handlers. Slack bot Docker Compose service.

**Complexity**: M

**Files to Create/Modify**:
- `docker-compose.yml` — Add slack-bot service (build target, env vars for SLACK_BOT_TOKEN, SLACK_APP_TOKEN, CORE_API_URL, REDIS_URL, LITELLM_URL=https://llm.k4jda.net, depends on core-api only — LiteLLM is external)
- `packages/slack-bot/src/__tests__/intent-router.test.ts` — Unit tests: prefix detection, LLM fallback, graceful degradation
- `packages/slack-bot/src/__tests__/capture-handler.test.ts` — Unit tests with mocked Core API: capture flow, dedup, audio routing
- `packages/slack-bot/src/__tests__/query-handler.test.ts` — Unit tests: search flow, thread context, follow-ups, expired threads, synthesis

**Acceptance Criteria**:
- All tests pass
- Intent router correctly classifies >95% of test cases
- Thread context lifecycle tested (create, read, expire)
- Slack bot container builds and starts

**Requirement Refs**: PRD Phase 1D test gate, TDD §15.3

---

## Phase 8: MCP + External Access

**Goal**: AI tools (Claude Desktop, Claude Code, ChatGPT) can query the brain via MCP. External access via Cloudflare Tunnel with API key auth.

**Dependencies**: Phase 7 (Slack bot works, full pipeline functional)

**Test Gate (PRD 1E)**: Claude Desktop connects to brain.k4jda.net/mcp. search_brain returns real captures. capture_thought creates capture through pipeline. Invalid API key → 401. All 7 MCP tools functional.

**Phase 1 Complete**: The capture → search loop works end-to-end via Slack and MCP. This is the minimum viable brain.

---

### 8.1 MCP Server Setup

**Description**: @modelcontextprotocol/sdk server embedded in Core API at /mcp route using Streamable HTTP transport.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/mcp/server.ts` — MCP server setup using @modelcontextprotocol/sdk. Create server with name "open-brain", version from package.json. Register all tools. Mount at /mcp route in Hono app using Streamable HTTP transport.
- `packages/core-api/src/mcp/auth.ts` — MCP authentication middleware: extract Bearer token from Authorization header, compare against MCP_API_KEY env var. Invalid/missing → 401 Unauthorized. Log auth attempts (hash of key, not key itself).

**Acceptance Criteria**:
- MCP server responds at /mcp
- Streamable HTTP transport works
- Valid Bearer token → access granted
- Missing/invalid token → 401

**Requirement Refs**: PRD F06 (MCP endpoint), TDD §7.2 (MCP API key), TDD §8.8 (MCP tools)

---

### 8.2 MCP Tools — Search & Browse

**Description**: search_brain, list_captures, and brain_stats MCP tools.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/mcp/tools/search-brain.ts` — search_brain tool: params (query, limit, threshold, source_filter, tag_filter, brain_view, days). Calls SearchService.search(). Returns formatted text results.
- `packages/core-api/src/mcp/tools/list-captures.ts` — list_captures tool: params (limit, type, topic, person, days, source). Calls CaptureService.list(). Returns formatted text.
- `packages/core-api/src/mcp/tools/brain-stats.ts` — brain_stats tool: params (period: week|month|all). Calls CaptureService.getStats(). Returns formatted stats text.

**Acceptance Criteria**:
- search_brain returns results within 5 seconds
- list_captures shows all statuses (not filtered to 'complete' — per TDD note)
- brain_stats returns formatted statistics
- All tools return well-formatted text (not raw JSON)

**Requirement Refs**: TDD §8.8 (MCP tool specs), PRD F06 (MCP tools table)

---

### 8.3 MCP Tools — Capture & Entity

**Description**: capture_thought, get_entity, list_entities, and get_weekly_brief MCP tools.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/mcp/tools/capture-thought.ts` — capture_thought tool: params (content, tags, brain_views). Calls CaptureService.create(). Returns confirmation with capture ID.
- `packages/core-api/src/mcp/tools/get-entity.ts` — get_entity tool: params (name or id). Queries entities table. Returns entity detail with recent linked captures.
- `packages/core-api/src/mcp/tools/list-entities.ts` — list_entities tool: params (type_filter, sort_by). Queries entities table. Returns formatted list.
- `packages/core-api/src/mcp/tools/get-weekly-brief.ts` — get_weekly_brief tool: params (weeks_ago, default 0). Queries skills_log for most recent weekly-brief. Returns brief content or "No briefs generated yet."
- `packages/core-api/src/mcp/tools/index.ts` — Register all 7 tools with MCP server

**Acceptance Criteria**:
- capture_thought creates captures that go through full pipeline
- get_entity and list_entities work (return empty until Phase 12)
- get_weekly_brief returns brief or "none yet" message
- All 7 tools registered and functional

**Requirement Refs**: TDD §8.8 (MCP tool specs), PRD F06

---

### 8.4 Cloudflare Tunnel Configuration

**Description**: Cloudflare Tunnel container routing brain.k4jda.net to Core API.

**Complexity**: S

**Files to Create/Modify**:
- `docker-compose.yml` — Add cloudflared service (cloudflare/cloudflared:latest, restart: unless-stopped, TUNNEL_TOKEN env, open-brain network, depends on core-api). Routing: brain.k4jda.net/mcp → core-api:3000/mcp, brain.k4jda.net/ → core-api:3000 (updated to web:80 in Phase 15)

**Acceptance Criteria**:
- Cloudflared container starts and connects to Cloudflare
- brain.k4jda.net/mcp routes to core-api
- HTTPS terminates at Cloudflare (tunnel handles encryption)

**Requirement Refs**: PRD F06 (Cloudflare Tunnel), TDD §16.1 (cloudflared service)

---

### 8.5 MCP Tests + End-to-End Verification

**Description**: Tests for MCP tools and full Phase 1 end-to-end verification.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/__tests__/mcp-tools.test.ts` — Unit tests: each tool returns correct format, auth middleware blocks invalid keys, search_brain calls SearchService correctly
- `packages/core-api/src/__tests__/mcp-auth.test.ts` — Auth tests: valid Bearer → 200, missing header → 401, invalid key → 401, key hash logged
- `scripts/e2e-phase1.sh` — End-to-end verification script:
  1. curl POST /api/v1/captures (create capture)
  2. Wait for pipeline completion
  3. curl POST /api/v1/search (search for capture)
  4. Verify search returns the capture
  5. Test MCP tools via curl
  6. Test health endpoint
  7. Report pass/fail for each check

**Acceptance Criteria**:
- All MCP tool tests pass
- Auth correctly blocks unauthenticated requests
- E2E script verifies full capture → pipeline → search → MCP flow
- Phase 1 test gates satisfied (all 5 sub-phases)

**Requirement Refs**: PRD Phase 1E test gate, TDD §15.5 (E2E scenarios)

---

<!-- END PHASES -->

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| 1.1 | 1.5 | Root config and env config are independent |
| 2.1 | 2.4 | Schema definitions and TypeScript interfaces can be written in parallel |
| 2.2 | 2.5 | Supporting tables and utilities are independent |
| 4.2 | 4.4 | Zod schemas and stats endpoint are independent |
| 5.1 | 5.2 | EmbeddingService and SQL functions are independent |
| 6.1 | 6.3 | Queue setup and AIRouter are independent |
| 6.4 | 6.5 | Config files and Docker/Bull Board are independent |
| 7.1 | 7.2 | Slack setup and intent router are independent |
| 8.2 | 8.3 | Search/browse tools and capture/entity tools are independent |

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LiteLLM embedding latency (Jetson) | Low | Medium | Qwen3-Embedding-4B-Q4_K_M on Jetson via llm.k4jda.net. If latency is too high, embeddings queue asynchronously — no user-facing impact. |
| pgvector HNSW index build time | Low | Low | <100K captures at launch. Default params sufficient. |
| LiteLLM proxy stability | Low | High | External shared service at llm.k4jda.net — manages all embeddings AND inference. Failure queues captures for retry (patient backoff). Daily sweep recovers any stragglers. |
| Drizzle ORM limitations with custom SQL | Medium | Low | Custom SQL migrations for search functions and FTS index. Well-documented pattern. |
| BullMQ job loss on Redis restart | Low | Medium | Redis persistence (RDB snapshots). Pipeline retries recover from lost jobs. |

## Success Metrics

| Metric | Target | Phase | Measurement |
|--------|--------|-------|-------------|
| Capture ingest latency | <500ms | 4 | API response time (POST /api/v1/captures) |
| Pipeline completion (text) | <30s | 6 | Time from ingest to pipeline_status=complete |
| Search response time | <5s | 5 | POST /api/v1/search response time |
| MCP tool response | <5s | 8 | MCP search_brain execution time |
| Test coverage | >80% | All | Vitest coverage report |
| Zero data loss | 100% | 4+ | All captures persisted with audit trail |

## Requirement Traceability

| Requirement | Source | Phase | Work Items |
|-------------|--------|-------|------------|
| Postgres 16 + pgvector | PRD F02, TDD §4 | 1, 2 | 1.3, 2.1-2.3 |
| Core API scaffold | PRD F01, TDD §3 | 3 | 3.1-3.5 |
| Capture CRUD | PRD F01, TDD §3.2 | 4 | 4.1-4.5 |
| Search (hybrid + temporal) | PRD F02/F05, TDD §4.3 | 5 | 5.1-5.6 |
| Pipeline (BullMQ) | PRD F03, TDD §12 | 6 | 6.1-6.6 |
| LiteLLM proxy | PRD F07a, TDD §8.7 | External | 6.3 (integration), 6.5 (env config) |
| AI Router | PRD F08, TDD §6.2 | 6 | 6.3 |
| LiteLLM embeddings (Jetson) | TDD §8.7, TDD §6.2 | 5, 6 | 5.1, 5.6 |
| Daily sweep recovery | PRD F03, TDD §12.2 | 6 | 6.7 |
| Slack capture | PRD F04, TDD §8.1 | 7 | 7.1-7.5 |
| Slack query | PRD F05, TDD §8.1 | 7 | 7.2, 7.4 |
| MCP endpoint | PRD F06, TDD §8.8 | 8 | 8.1-8.5 |
| Cloudflare Tunnel | PRD §6, TDD §16.1 | 8 | 8.4 |
| Config validation (Zod) | TDD §6.2 | 3 | 3.3 |
| Bull Board | PRD F03, TDD §16.1 | 6 | 6.5 |
| Content dedup | TDD §5.2 | 4 | 4.1 |
| ACT-R temporal scoring | PRD F02, TDD §4.3 | 5 | 5.2, 5.5 |

<!-- END TABLES -->

---

*Continues in [IMPLEMENTATION_PLAN-PHASE2.md](IMPLEMENTATION_PLAN-PHASE2.md) — Phases 9-16: Voice, Output Skills, Entity Graph, Governance, Web Dashboard*

*Source: /create-plan command*
