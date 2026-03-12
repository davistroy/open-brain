# Open Brain — AI Assistant Context

## Operational Rules — Learning Capture

**These rules apply in every session. Do not skip them.**

### When a bug, failure, or deployment issue is diagnosed and fixed

After any non-trivial finding during deployment, testing, or debugging:

1. **Update `CLAUDE.md`** (this file) — add or update a bullet in the relevant section with the operational rule. This is the always-loaded, always-enforced file.
2. **Update the memory file** — write a detailed entry in `C:\Users\Troy Davis\.claude\projects\C--Users-Troy-Davis-dev-personal-open-brain\memory\` in the appropriate topic file. Include the root cause, the fix, and what to watch for.
3. **Update `MEMORY.md`** — add a concise bullet + link to the topic file so it survives context compaction.

### What counts as a "non-trivial finding"

- Any container startup failure, crash, or silent failure with a non-obvious root cause
- Any Docker Compose or networking quirk (port conflicts, healthcheck failures, bridge behavior)
- Any LiteLLM/embedding/pipeline behavior surprise (retry logic, vector dimensions, queue wiring)
- Any Slack bot routing behavior (intent classification, @mention vs plain message handling)
- Any fix that took more than one attempt to get right

### Learning file locations

| File | Purpose | When to write |
|------|---------|---------------|
| `CLAUDE.md` (this file) | Operational rules, always enforced | Every session with new learnings |
| `memory/MEMORY.md` | Concise index, survives compaction | After each new topic file entry |
| `memory/deployment-learnings.md` | Docker, infra, container startup issues | Any deployment/container finding |
| `memory/pipeline-learnings.md` | BullMQ pipeline behavior, retry, job wiring | Pipeline/worker findings |
| `memory/embedding-learnings.md` | Vector dimensions, LiteLLM embedding quirks | Embedding/search findings |
| `memory/integration-test-findings.md` | Bug patterns from full e2e runs | Test/run bugs |

### Verified operational rules (do not repeat these mistakes)

- **Healthchecks must use `127.0.0.1`, not `localhost`** — Alpine Linux resolves `localhost` to `::1` (IPv6); `wget` cannot connect to IPv6 and healthchecks fail silently. Affects core-api, voice-capture, and web containers.
- **Docker Compose `ports` lists are appended, not replaced in override files** — `docker-compose.override.yml` with a different port mapping adds a second binding, not a replacement. Set correct ports directly in `docker-compose.yml`.
- **voice-capture entry point is `dist/server.js`, not `dist/index.js`** — the package builds from `server.ts`. Dockerfile CMD must be `node packages/voice-capture/dist/server.js`.
- **`postgresql.conf` must set `listen_addresses = '*'`** — without it, Postgres defaults to `localhost` only and blocks all container-to-container connections.
- **Matryoshka truncation check must use `< 768`, not `!== 768`** — the embedding service slices `raw.slice(0, 768)`. A `!== 768` guard would reject the full 2560-dim vector before slicing.
- **LiteLLM MCP server names cannot contain `-`** — use `_` instead (e.g., `open_brain` not `open-brain`). Hyphens cause a startup validation exception.
- **LiteLLM MCP transport must be `http`, not `streamable_http`** — v1.81 accepts only `http`, `sse`, or `stdio`. `streamable_http` causes a Pydantic validation error and crashes startup.
- **`/health` is Docker-internal only** — nginx does not proxy `/health` externally. Use `/api/v1/captures?limit=1` for external health checks and tunnel verification.
- **Slack `app_mention` events always route to `handleQuery`** — do not document @mention as a way to trigger captures or commands. Captures and `!commands` require plain channel messages routed through IntentRouter.
- **`SLACK_SIGNING_SECRET` is not needed for Socket Mode** — signing secrets are for HTTP webhook verification only. Socket Mode only needs `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`.
- **`CREATE TRIGGER` is not idempotent** — PostgreSQL has no `CREATE OR REPLACE TRIGGER`. Always add `DROP TRIGGER IF EXISTS <name> ON <table>;` before each `CREATE TRIGGER`. Affects `scripts/init-schema.sql` which is re-applied by integration tests.
- **Drizzle ORM does not emit `AS` aliases for computed SELECT columns** — `sql<number>\`COUNT(...)\`` in a `.select({mention_count: sql\`...\`})` maps only to JS property names, not SQL aliases. `ORDER BY mention_count` fails with "column does not exist". Use the full expression in ORDER BY: `desc(sql\`COUNT(${entity_links.id})\`)`.
- **Captures table has no `tsv` column** — FTS uses an expression-based GIN index on `to_tsvector('english', content)`. Inserts are immediately FTS-searchable. Do not try to update a `tsv` column.
- **`POST /api/v1/captures` returns `{id, pipeline_status, created_at}` only** — not the full capture object. Use `GET /api/v1/captures/:id` for the full record.
- **Integration tests must use `pnpm exec`, not `npx`** — `npx vitest` on the server pulls a different version that can't resolve TS configs. Use `pnpm --filter @open-brain/core-api exec vitest run --config vitest.config.integration.ts`.
- **Integration test config filename is `vitest.config.integration.ts`** — not `vitest.integration.config.ts`. The word order matters.
- **Integration tests need rate limit bypass** — all test helpers send `X-Open-Brain-Caller: integration-test` header. The rate limit middleware skips enforcement for this caller key. Without it, strict tier (20 req/min) exhausts during test runs.
- **Health API returns `'healthy'`/`'unhealthy'`, not `'up'`/`'down'`** — web UI StatusDot must accept both naming conventions. The health route uses `ServiceStatus = 'healthy' | 'degraded' | 'unhealthy'`.
- **`POST /admin/reset-data` has no adminAuth** — web UI cannot send Bearer tokens. Protected by POST method, JSON body confirmation phrase, and admin rate limiter. Do not re-add `adminAuth()` without a web UI auth mechanism.
- **PWA service worker can cache stale JS bundles** — after deploying web container changes, users may need a hard refresh (Ctrl+Shift+R) to pick up new Vite-hashed bundles.

---

## What This Is

Self-hosted personal AI knowledge infrastructure. Ingests from voice memos, Slack, documents; stores in Postgres+pgvector; provides semantic search, AI synthesis, weekly briefs, and governance sessions.

**Status**: v1.2.0 — All 25 phases complete (Phases 1-16 shipped 2026-03-05, hardening PR #25 merged 2026-03-11, Phase 5 intelligence features PR #27 merged 2026-03-11, Phase 6 UX polish PR #28 merged 2026-03-12). 1,407 unit tests + 95 regression tests passing. Deployed to homeserver.

## Key Architecture Decisions

- **Runtime**: TypeScript, Hono framework, Drizzle ORM
- **Database**: Postgres 16 + pgvector (pgvector/pgvector:pg16 image, no Supabase)
- **LLM Gateway**: LiteLLM at https://llm.k4jda.net for ALL AI requests — both embeddings and LLM inference. No Ollama container in Open Brain stack.
- **Embeddings**: Qwen3-Embedding-4B via `spark-qwen3-embedding-4b` alias on LiteLLM (Spark/cloud). OpenAI embeddings API format. Returns 2560 dims — Matryoshka-truncated to 768 in embedding service. NO fallback — queue and retry if LiteLLM is down.
- **LLM Inference**: Model aliases fast, synthesis, governance, intent — all through LiteLLM (`spark-qwen3.5-35b` for all four, configured in `config/ai-routing.yaml`).
- **Schema**: `vector(768)` everywhere. Do not use 1536.
- **Search**: Hybrid retrieval (FTS + vector with RRF) + ACT-R temporal decay scoring. Default temporal_weight: 0.0 (cold start), ramp up as search history builds.
- **MCP Auth**: Authorization: Bearer header (not URL query parameter)
- **Phases**: 16 phases complete (see IMPLEMENTATION_PLAN.md and IMPLEMENTATION_PLAN-PHASE2.md)
- **Pipeline**: BullMQ + Redis, async processing stages
- **Web UI**: Vite + React + Tailwind + shadcn/ui (NOT Next.js)
- **Migrations**: Drizzle ORM + drizzle-kit (NOT raw SQL, NOT Prisma)
- **External access**: Cloudflare Tunnel → brain.troy-davis.com (web dashboard); MCP via LiteLLM gateway at llm.troy-davis.com/mcp
- **Docker networking**: Single `open-brain` network for all containers
- **MCP**: Embedded in Core API at `/mcp` route (Streamable HTTP, no separate container)
- **Monorepo**: pnpm workspaces (packages: shared, core-api, slack-bot, workers, voice-capture)
- **Slack**: @slack/bolt with socketMode: true
- **Build**: tsx for dev, tsup (esbuild) for production
- **Voice capture**: Direct API from iPhone/Watch via iOS Shortcut (no Google Drive sync)
- **Governance**: LLM-driven conversation with guardrails, not FSM

## Target Hardware

Intel i7-9700 (8C/8T), 128GB DDR4, no GPU, 32TB array. Unraid OS.
Container memory limits: faster-whisper 8GB, Postgres 8GB.

## Brain Views

Five views with auto-classification: `career`, `personal`, `technical`, `work-internal`, `client`.

## Capture Types

Eight types: `decision`, `idea`, `observation`, `task`, `win`, `blocker`, `question`, `reflection`. Extensible via prompt template updates.

## Secrets

All API keys in Bitwarden. Never in .env files or config. Use `bws` CLI to retrieve.

## Important Files

- `docs/PRD.md` — Product requirements (v0.6, architectural review v2 applied)
- `docs/TDD.md` — Technical design document (v0.5, architectural review v2 applied)
- `IMPLEMENTATION_PLAN-PHASE5.md` — Phases 17-20 (Intelligence features) — complete
- `docs/archived/` — Completed plans (phases 1-16, hardening) and historical test results

## Conventions

- Single-user system — no auth, no multi-tenancy
- Config-driven: YAML for pipelines, AI routing, skills, brain views
- Prompt templates versioned as text files (v1, v2, v3)
- Pipeline retry: 5 attempts with patient backoff (30s, 2m, 10m, 30m, 2h) + daily auto-sweep
- Monthly AI budget: soft $30 (alert), hard $50 (circuit breaker)
