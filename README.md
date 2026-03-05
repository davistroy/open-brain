# Open Brain

A self-hosted, Docker-based personal AI knowledge infrastructure that ingests information from multiple sources (voice memos, Slack messages, documents, bookmarks), processes and embeds them for semantic search, and provides rich output through AI-powered skills.

## Status

**Pre-implementation** — PRD (v0.5) and TDD (v0.4) complete, architectural review applied. No code yet.

## Architecture

Runs on an Unraid home server. Key components:

| Component | Tech | Purpose |
|-----------|------|---------|
| Core API | Hono + Drizzle (TypeScript) | Central API for ingest, search, synthesis |
| Database | Postgres 16 + pgvector (pgvector/pgvector:pg16) | Storage + semantic search |
| Pipeline | BullMQ + Redis | Async processing (embed, extract metadata, classify) |
| Embeddings | Ollama (configurable model, 768d) | Local vector embeddings |
| LLM Gateway | LiteLLM Proxy | Unified API for all LLM providers |
| Transcription | faster-whisper (large-v3, CPU) | Local speech-to-text |
| Slack Bot | @slack/bolt (Socket Mode) | Capture + query + commands |
| MCP Endpoint | @modelcontextprotocol/sdk (embedded in Core API) | AI tool integration (Streamable HTTP) |
| Web UI | Vite + React + shadcn/ui | Dashboard (Phase 4) |

## Phased Rollout

10 sub-phases with explicit test gates at each step:

1. **Foundation** (5 sub-phases)
   - **1A** Data Layer — Postgres+pgvector, capture CRUD
   - **1B** Embedding + Search — Ollama, hybrid search, model benchmarking
   - **1C** Pipeline + LLM Gateway — BullMQ, LiteLLM, auto-processing
   - **1D** Slack Bot — capture + query via Slack
   - **1E** MCP + External Access — AI tool integration, Cloudflare Tunnel
2. **Voice + Outputs** (3 sub-phases)
   - **2A** Voice Pipeline — faster-whisper, Apple Watch capture
   - **2B** Notifications + Skills — weekly briefs, Pushover, email
   - **2C** Semantic Triggers — proactive memory surfacing
3. **Intelligence** — Entity graph, governance sessions, drift detection
4. **Polish** — Web dashboard, document ingestion, calendar integration

## Key Decisions

- **Embeddings**: Configurable model via Ollama (768d vectors), no fallback (consistency over availability)
- **LLM Gateway**: Self-hosted LiteLLM proxy for all LLM requests (embeddings bypass, go direct to Ollama)
- **Search**: Hybrid retrieval (vector + full-text) with Reciprocal Rank Fusion and ACT-R temporal decay
- **External access**: Cloudflare Tunnel for `brain.k4jda.net` only, existing Tailscale+SWAG unchanged
- **Web framework**: Vite + React (lightweight SPA), not Next.js
- **Schema migrations**: Drizzle ORM + drizzle-kit
- **Brain views**: 5 views (career, personal, technical, work-internal, client) with auto-classification
- **Governance**: LLM-driven conversation with guardrails, not FSM
- **Database**: Plain Postgres+pgvector, no Supabase
- **MCP**: Embedded in Core API (Streamable HTTP), no separate container
- **Voice capture**: Direct API from iPhone/Watch (no Google Drive sync)
- **Monorepo**: pnpm workspaces (shared, core-api, slack-bot, workers, voice-capture)

See [docs/PRD.md](docs/PRD.md) for complete specifications and the resolved decisions table in Section 12.

## Reference Files

| File | Purpose |
|------|---------|
| `docs/PRD.md` | Product requirements document (v0.6) |
| `docs/TDD.md` | Technical design document (v0.5) |
| `IMPLEMENTATION_PLAN.md` | Phased build plan, phases 1-8 |
| `IMPLEMENTATION_PLAN-PHASE2.md` | Phased build plan, phases 9-16 |

## License

Apache 2.0
