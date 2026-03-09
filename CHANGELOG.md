# Changelog

All notable changes to Open Brain are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Changed
- Embedding model switched from `jetson-embeddings` to `spark-qwen3-embedding-4b` (Matryoshka 2560d → 768d truncation)
- All documentation and code comments updated to reflect spark model

### Fixed
- SQL typo `plainplainto_tsquery` → `plainto_tsquery` in `hybrid_search` function (migration 0006)
- `search_mode: 'fts'` parameter was accepted but silently ignored — now routes to `fts_only_search()` which bypasses embedding entirely
- Web dashboard stale source files (14 files synced to homeserver)
- Embedding service strict dimension check (`!== 768`) replaced with Matryoshka-aware check (`< 768`) with truncation

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
- Cloudflare Tunnel for `brain.k4jda.net`
- Bull Board queue monitor at `/admin/queues`
- Health endpoint with LiteLLM latency reporting
- Architecture review remediation (11 items)

### Architecture Decisions
- No Ollama container — all AI through external LiteLLM at `llm.k4jda.net`
- No embedding fallback — queue and retry preserves vector space consistency
- `vector(768)` everywhere — Matryoshka truncation from larger models
- MCP embedded in core-api (not a separate container)
- Pre-built `dist/` committed to git for Alpine Docker builds

---

[Unreleased]: https://github.com/davistroy/open-brain/compare/HEAD...main
[1.0.0]: https://github.com/davistroy/open-brain/releases/tag/v1.0.0
