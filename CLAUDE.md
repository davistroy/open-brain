# Open Brain — AI Assistant Context

## What This Is

Self-hosted personal AI knowledge infrastructure. Ingests from voice memos, Slack, documents; stores in Postgres+pgvector; provides semantic search, AI synthesis, weekly briefs, and governance sessions.

**Status**: Pre-implementation. PRD (v0.6) and TDD (v0.5) complete, architectural review v2 applied. No code written yet.

## Key Architecture Decisions

- **Runtime**: TypeScript, Hono framework, Drizzle ORM
- **Database**: Postgres 16 + pgvector (pgvector/pgvector:pg16 image, no Supabase)
- **LLM Gateway**: LiteLLM proxy for all LLM requests (not embeddings). Model aliases: fast, synthesis, governance, intent.
- **Embeddings**: Configurable model via Ollama (evaluating nomic-embed-text vs Qwen3-Embedding). NO fallback — queue and retry if Ollama is down.
- **Schema**: `vector(768)` everywhere. Do not use 1536.
- **Search**: Hybrid retrieval (FTS + vector with RRF) + ACT-R temporal decay scoring. Default temporal_weight: 0.0 (cold start), ramp up as search history builds.
- **MCP Auth**: Authorization: Bearer header (not URL query parameter)
- **Phases**: 10 sub-phases (1A-1E, 2A-2C, 3, 4) with explicit test gates per sub-phase
- **Pipeline**: BullMQ + Redis, async processing stages
- **Web UI**: Vite + React + Tailwind + shadcn/ui (NOT Next.js)
- **Migrations**: Drizzle ORM + drizzle-kit (NOT raw SQL, NOT Prisma)
- **External access**: Cloudflare Tunnel for brain.k4jda.net only
- **Docker networking**: Single `open-brain` network for all containers
- **MCP**: Embedded in Core API at `/mcp` route (Streamable HTTP, no separate container)
- **Monorepo**: pnpm workspaces (packages: shared, core-api, slack-bot, workers, voice-capture)
- **Slack**: @slack/bolt with socketMode: true
- **Build**: tsx for dev, tsup (esbuild) for production
- **Voice capture**: Direct API from iPhone/Watch via iOS Shortcut (no Google Drive sync)
- **Governance**: LLM-driven conversation with guardrails, not FSM

## Target Hardware

Intel i7-9700 (8C/8T), 128GB DDR4, no GPU, 32TB array. Unraid OS.
Container memory limits: Ollama 16GB, faster-whisper 8GB, Postgres 8GB.

## Brain Views

Five views with auto-classification: `career`, `personal`, `technical`, `work-internal`, `client`.

## Capture Types

Eight types: `decision`, `idea`, `observation`, `task`, `win`, `blocker`, `question`, `reflection`. Extensible via prompt template updates.

## Secrets

All API keys in Bitwarden. Never in .env files or config. Use `bws` CLI to retrieve.

## Important Files

- `docs/PRD.md` — Product requirements (v0.6, architectural review v2 applied)
- `docs/TDD.md` — Technical design document (v0.5, architectural review v2 applied)
- `IMPLEMENTATION_PLAN.md` — Phased build plan, phases 1-8
- `IMPLEMENTATION_PLAN-PHASE2.md` — Phased build plan, phases 9-16

## Conventions

- Single-user system — no auth, no multi-tenancy
- Config-driven: YAML for pipelines, AI routing, skills, brain views
- Prompt templates versioned as text files (v1, v2, v3)
- Pipeline retry: 5 attempts with patient backoff (30s, 2m, 10m, 30m, 2h) + daily auto-sweep
- Monthly AI budget: soft $30 (alert), hard $50 (circuit breaker)
