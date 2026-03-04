# Open Brain

A self-hosted, Docker-based personal AI knowledge infrastructure that ingests information from multiple sources (voice memos, Slack messages, documents, bookmarks), processes and embeds them for semantic search, and provides rich output through AI-powered skills.

## Status

**Pre-implementation** — PRD complete (v0.2, all architectural decisions resolved). No code yet.

## Architecture

Runs on an Unraid home server. Key components:

| Component | Tech | Purpose |
|-----------|------|---------|
| Core API | Hono + Drizzle (TypeScript) | Central API for ingest, search, synthesis |
| Database | Postgres 16 + pgvector (Supabase self-hosted) | Storage + semantic search |
| Pipeline | BullMQ + Redis | Async processing (embed, extract metadata, classify) |
| Embeddings | Ollama (nomic-embed-text, 768d) | Local vector embeddings |
| Transcription | faster-whisper (large-v3, CPU) | Local speech-to-text |
| Slack Bot | Node.js (Socket Mode) | Capture + query + commands |
| MCP Server | @modelcontextprotocol/sdk | AI tool integration (Claude, ChatGPT) |
| Web UI | Vite + React + shadcn/ui | Dashboard (Phase 4) |

## Phased Rollout

1. **Foundation** — Slack capture + search + MCP (Supabase, Ollama, Redis, Core API)
2. **Voice + Outputs** — Apple Watch voice memos, weekly briefs, notifications
3. **Intelligence** — Entity graph, governance sessions, drift detection
4. **Polish** — Web dashboard, document ingestion, calendar integration

## Key Decisions

- **Embeddings**: nomic-embed-text (768d) via Ollama, no fallback (consistency over availability)
- **External access**: Cloudflare Tunnel for `brain.k4jda.net` only, existing Tailscale+SWAG unchanged
- **Web framework**: Vite + React (lightweight SPA), not Next.js
- **Schema migrations**: Drizzle ORM + drizzle-kit
- **Brain views**: 5 views (career, personal, technical, work-internal, client) with auto-classification
- **Governance**: Slack-native conversational redesign, not a port of board-journal FSM

See [PRD.md](PRD.md) for complete specifications and the resolved decisions table in Section 12.

## Reference Files

| File | Purpose |
|------|---------|
| `PRD.md` | Product requirements document (v0.2) |
| `reference/questions-PRD-*.json` | Questions extracted from PRD |
| `answers-PRD-*.json` | Architectural decisions record |

## License

Apache 2.0
