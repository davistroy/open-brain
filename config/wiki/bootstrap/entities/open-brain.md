---
title: Open Brain
type: entity
created: 2026-04-15
updated: 2026-04-15
source_count: 0
tags: [open-brain, ai, project, knowledge-management]
aliases: [open brain, brain]
entity_type: project
related_pages:
  - entities/troy-davis.md
  - entities/stratfield-consulting.md
  - domains/technology.md
  - domains/projects.md
---

# Open Brain

Self-hosted personal AI knowledge infrastructure built and operated by [Troy Davis](troy-davis.md). Ingests from voice memos, Slack, documents, email; stores in Postgres with pgvector; provides semantic search, AI synthesis, weekly briefs, and governance sessions.

## Architecture

- **Runtime**: TypeScript monorepo (pnpm workspaces) with Hono framework and Drizzle ORM
- **Database**: PostgreSQL 16 + pgvector for hybrid search (FTS + vector with RRF + ACT-R temporal decay)
- **LLM**: OpenAI API (gpt-5.4) for inference; text-embedding-3-large for embeddings (768 dimensions)
- **Pipeline**: BullMQ + Redis for async processing stages
- **Web UI**: Vite + React + Tailwind + shadcn/ui
- **Deployment**: Docker Compose on Unraid homeserver, Cloudflare Tunnel for external access

## Capabilities

- Voice capture via iOS Shortcut
- Slack integration (socket mode)
- Email capture via Cloudflare Email Worker (brain@troy-davis.com)
- Document/file ingestion from OneDrive
- Semantic search with hybrid retrieval
- AI synthesis and weekly briefs
- MCP server for Claude integration
- Wiki knowledge base (this wiki)
- Proactive intelligence (autonomy levels, auto-response)
- Cognitive memory (Hebbian learning, spreading activation, consolidation)

## Infrastructure

- **Homeserver**: Intel i7-9700, 128GB DDR4, 32TB array, Unraid OS
- **DGX Spark**: Local LLM inference (Qwen 35B, free tier)
- **Jetson Orin Nano**: Classification tasks (Qwen 3.5 4B, free tier)
- **open-brain-vm**: Batch synthesis and ops scripts

## Related

- [Troy Davis](troy-davis.md) -- creator and sole user
- [Stratfield Consulting](stratfield-consulting.md) -- professional context
- [Technology](../domains/technology.md) -- technical domain
- [Projects](../domains/projects.md) -- project index

## Sources

*No captures processed yet.*
