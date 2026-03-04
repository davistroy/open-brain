# Open Brain — AI Assistant Context

## What This Is

Self-hosted personal AI knowledge infrastructure. Ingests from voice memos, Slack, documents; stores in Postgres+pgvector; provides semantic search, AI synthesis, weekly briefs, and governance sessions.

**Status**: Pre-implementation. PRD complete (v0.2), all architectural decisions resolved. No code written yet.

## Key Architecture Decisions

- **Runtime**: TypeScript, Hono framework, Drizzle ORM
- **Database**: Postgres 16 + pgvector, self-hosted via Supabase (minimal stack: Postgres + Studio + Realtime only)
- **Embeddings**: nomic-embed-text (768d) via Ollama. NO fallback — queue and retry if Ollama is down.
- **Schema**: `vector(768)` everywhere. Do not use 1536.
- **Pipeline**: BullMQ + Redis, async processing stages
- **Web UI**: Vite + React + Tailwind + shadcn/ui (NOT Next.js)
- **Migrations**: Drizzle ORM + drizzle-kit (NOT raw SQL, NOT Prisma)
- **External access**: Cloudflare Tunnel for brain.k4jda.net only
- **Docker networking**: Two networks (supabase-internal, open-brain). Postgres bridges both.

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

- `PRD.md` — Complete requirements with all decisions resolved (Section 12)
- `answers-PRD-20260304-160000.json` — Full decision record with rationale
- `reference/questions-PRD-20260304-120000.json` — Original questions extracted

## Conventions

- Single-user system — no auth, no multi-tenancy
- Config-driven: YAML for pipelines, AI routing, skills, brain views
- Prompt templates versioned as text files (v1, v2, v3)
- Pipeline retry: 5 attempts with patient backoff (30s, 2m, 10m, 30m, 2h) + daily auto-sweep
- Monthly AI budget: soft $30 (alert), hard $50 (circuit breaker)
