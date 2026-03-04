# Open Brain — AI Assistant Context

## What This Is

Self-hosted personal AI knowledge infrastructure. Ingests from voice memos, Slack, documents; stores in Postgres+pgvector; provides semantic search, AI synthesis, weekly briefs, and governance sessions.

**Status**: Pre-implementation. PRD (v0.3) and TDD (v0.2) complete, all architectural decisions resolved. No code written yet.

## Key Architecture Decisions

- **Runtime**: TypeScript, Hono framework, Drizzle ORM
- **Database**: Postgres 16 + pgvector (pgvector/pgvector:pg16 image, no Supabase)
- **Embeddings**: nomic-embed-text (768d) via Ollama. NO fallback — queue and retry if Ollama is down.
- **Schema**: `vector(768)` everywhere. Do not use 1536.
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

- `PRD.md` — Product requirements (v0.3, all decisions resolved, Section 12)
- `TDD.md` — Technical design document (v0.2, all 32 questions resolved)
- `reference/answers-PRD-20260304-160000.json` — PRD decision record with rationale
- `reference/answers-TDD-20260304-214500.json` — TDD decision record (32 questions)
- `reference/questions-PRD-20260304-120000.json` — PRD questions extracted
- `reference/questions-TDD-20260304-202900.json` — TDD questions extracted

## Conventions

- Single-user system — no auth, no multi-tenancy
- Config-driven: YAML for pipelines, AI routing, skills, brain views
- Prompt templates versioned as text files (v1, v2, v3)
- Pipeline retry: 5 attempts with patient backoff (30s, 2m, 10m, 30m, 2h) + daily auto-sweep
- Monthly AI budget: soft $30 (alert), hard $50 (circuit breaker)
