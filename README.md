# Open Brain

A self-hosted, Docker-based personal AI knowledge infrastructure that ingests information from multiple sources (voice memos, Slack messages, documents, bookmarks), processes and embeds them for semantic search, and provides rich output through AI-powered skills.

## Status

**Pre-implementation** — PRD (v0.3) and TDD (v0.2) complete, all architectural decisions resolved. No code yet.

## Architecture

Runs on an Unraid home server. Key components:

| Component | Tech | Purpose |
|-----------|------|---------|
| Core API | Hono + Drizzle (TypeScript) | Central API for ingest, search, synthesis |
| Database | Postgres 16 + pgvector (pgvector/pgvector:pg16) | Storage + semantic search |
| Pipeline | BullMQ + Redis | Async processing (embed, extract metadata, classify) |
| Embeddings | Ollama (nomic-embed-text, 768d) | Local vector embeddings |
| Transcription | faster-whisper (large-v3, CPU) | Local speech-to-text |
| Slack Bot | @slack/bolt (Socket Mode) | Capture + query + commands |
| MCP Endpoint | @modelcontextprotocol/sdk (embedded in Core API) | AI tool integration (Streamable HTTP) |
| Web UI | Vite + React + shadcn/ui | Dashboard (Phase 4) |

## Phased Rollout

1. **Foundation** — Slack capture + search + MCP (Postgres+pgvector, Ollama, Redis, Core API)
2. **Voice + Outputs** — Apple Watch voice memos, weekly briefs, notifications
3. **Intelligence** — Entity graph, governance sessions, drift detection
4. **Polish** — Web dashboard, document ingestion, calendar integration

## Key Decisions

- **Embeddings**: nomic-embed-text (768d) via Ollama, no fallback (consistency over availability)
- **External access**: Cloudflare Tunnel for `brain.k4jda.net` only, existing Tailscale+SWAG unchanged
- **Web framework**: Vite + React (lightweight SPA), not Next.js
- **Schema migrations**: Drizzle ORM + drizzle-kit
- **Brain views**: 5 views (career, personal, technical, work-internal, client) with auto-classification
- **Governance**: LLM-driven conversation with guardrails, not FSM
- **Database**: Plain Postgres+pgvector, no Supabase
- **MCP**: Embedded in Core API (Streamable HTTP), no separate container
- **Voice capture**: Direct API from iPhone/Watch (no Google Drive sync)
- **Monorepo**: pnpm workspaces (shared, core-api, slack-bot, workers, voice-capture)

See [PRD.md](PRD.md) for complete specifications and the resolved decisions table in Section 12.

## Reference Files

| File | Purpose |
|------|---------|
| `PRD.md` | Product requirements document (v0.3) |
| `TDD.md` | Technical design document (v0.2) |
| `reference/questions-PRD-*.json` | Questions extracted from PRD |
| `reference/questions-TDD-*.json` | Questions extracted from TDD |
| `reference/answers-PRD-*.json` | PRD architectural decisions record |
| `reference/answers-TDD-*.json` | TDD architectural decisions record |

## License

Apache 2.0
