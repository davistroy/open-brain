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
- **Web package must be self-contained for Docker build** — Vite `?raw` imports that escape `packages/web/` (e.g., `../../../../docs/`) work locally but fail in Docker where `.dockerignore` excludes `docs/` and the Dockerfile only copies `packages/web/`. User-facing content (markdown docs rendered in the UI) must live inside `packages/web/src/content/`.
- **Docker base images: Node 22 LTS** — upgraded from Node 20 (EOL April 2026). Both `Dockerfile` and `packages/web/Dockerfile` use `node:22-alpine`.
- **Shared utilities live in `@open-brain/shared`** — logger (`createLogger`/`logger`), LiteLLM client factory (`createLiteLLMClient`), PushoverService, HTTP helpers (`assertOk`/`HttpError`), and TemplateCache. Do NOT create duplicate logger/pushover/OpenAI client instances in consumer packages.
- **`createLiteLLMClient()` returns `null` when API key is empty** — callers must check for null and disable LLM features accordingly (following core-api governance engine pattern). Do not pass empty strings to `new OpenAI()`.
- **TemplateCache replaces `loadPromptTemplate()` on hot paths** — prompt templates are loaded from disk once and cached in memory. Use `TemplateCache.render()` in services, not `loadAndRenderPromptTemplate()`. The old functions still exist for backward compat but should not be used in new code.
- **Entity resolution is in `workers/src/lib/entity-resolver.ts`** — shared by both `extract-entities.ts` and `link-entities.ts`. Uses indexed SQL queries (not in-memory filtering). Do not duplicate entity resolution logic.
- **pg-notify has automatic reconnection** — exponential backoff (1s→30s, 5 attempts) when Postgres connection drops. Re-registers all LISTEN channels after reconnect. SSE events resume automatically.
- **CI uses Node 22** — matches Docker images. `package.json` engines field is `>=22`.
- **No auto-migration on startup** — if the Postgres volume is recreated, tables will be missing and all API endpoints return 500. Run `scripts/init-schema.sql` + all `packages/shared/drizzle/0*.sql` migrations manually. Check with `\dt` in psql first.
- **MCP Streamable HTTP returns SSE framing** — responses use `event: message\ndata: {json}` format. Clients must send `Accept: application/json, text/event-stream` header; parse the `data:` line for JSON.
- **Test scripts require `X-Open-Brain-Caller: integration-test` header** — rate limiter skips enforcement for this caller key. Without it, rapid test requests exhaust the 20 req/min strict tier and return 429.
- **Document upload hashes title, not file content** — `POST /api/v1/documents` creates capture with `content = "[Document] {title}"`. The `content_hash` unique index is on this string, not the file bytes. Uploading with the same title triggers 409 Conflict.
- **OpenAI gpt-5.4 uses `max_completion_tokens`** — the deprecated `max_tokens` parameter is rejected with 400. All LLM call sites must use `max_completion_tokens`.
- **No `extra_body` in OpenAI calls** — `extra_body: { chat_template_kwargs: ... }` was Qwen/vLLM-specific. OpenAI rejects unknown parameters with 400.
- **Health check URL path detection** — `checkLLMProvider()` detects if baseUrl ends with `/v1` to avoid doubling the path prefix when building the `/models` endpoint URL.
- **Voice-capture form field is `file`, not `audio`** — the iOS Shortcut must use `file` as the multipart field key. The endpoint also accepts optional `latitude`, `longitude`, `location_name`, `location_accuracy` fields for GPS location.
- **Voice-capture classification model is `gpt-5.4`** — hardcoded in `classification.ts` (not read from ai-routing.yaml). Override via `CLASSIFICATION_MODEL` env var.
- **PWA service worker caches stale JS aggressively** — after deploying web container changes, users must hard-refresh (Ctrl+Shift+R) or unregister the service worker (DevTools → Application → Service Workers → Unregister) to pick up new Vite-hashed bundles. This is a recurring issue after every web rebuild.
- **PWA cache clearing requires both SW unregister AND cache delete** — unregistering the service worker alone is not enough. Must also run `caches.keys().then(names => Promise.all(names.map(n => caches.delete(n))))` in DevTools console to clear cached JS bundles. Without this, stale Vite-hashed chunks persist.
- **Cloudflare Email Workers: set `workers_dev = false`** — email-only workers have no HTTP routes. Setting `workers_dev = true` (the default) creates a useless `*.workers.dev` subdomain. Use `workers_dev = false` in `wrangler.toml`.
- **Python `urllib` gets 403 from Cloudflare** — Cloudflare blocks Python's default user-agent. Use `curl` for testing Cloudflare-fronted endpoints.
- **`app_settings` table is a generic key-value store** — `key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ`. Used for email allowlist, reusable for future dashboard-managed settings. Migration 0010.
- **Settings API has key whitelist (`VALID_SETTINGS_KEYS`)** — prevents unbounded key creation. When adding a new setting, add the key to the `VALID_SETTINGS_KEYS` Set in `packages/core-api/src/routes/settings.ts`.
- **Email worker allowlist URL derivation** — use regex `replace(/\/captures\/?$/, '')` to derive base API URL from `CAPTURES_URL`, not string replace (fragile with trailing slashes).
- **Search API returns `results` not `captures`** — `GET /api/v1/search` returns `{ results: [{ capture, score }] }`. Frontend `searchApi.search()` maps this to the `SearchResult` type. Do not assume the API returns a flat `captures` array.
- **Rate limiter bypass uses a Set** — `BYPASS_CALLERS` Set in `rate-limit.ts` instead of chained `||` conditions. Add new bypass callers there (e.g., `email-worker`).
- **CaptureCard is a single shared component** — `packages/web/src/components/CaptureCard.tsx` used by Dashboard, Timeline, EntityDetail, and Search. Unified in PR #37.
- **Capture source types include `email` and `mcp`** — in addition to `slack`, `voice`, `api`, `document`. The Zod schema in `shared/src/schema/` validates these.
- **Skills must resolve model aliases from ai-routing.yaml** — workers skills pass `modelAlias` directly to OpenAI. With LiteLLM proxy gone, aliases like `synthesis` cause 404. The skill-execution worker must resolve via `configService.get('ai').models[alias]` before dispatching. Same pattern as `extract-entities.ts`.
- **Slack-bot loads only ai-routing.yaml, not full ConfigService** — `ConfigService.load()` requires all 4 config files (pipeline, ai, brain-views, notifications). Slack-bot only needs the intent model name. Uses lightweight `js-yaml` load with fallback to `gpt-5.4`. Config dir is now mounted (`./config:/app/config:ro`) but load is graceful if missing.
- **Autonomy levels gate all proactive features** — `app_settings` key `autonomy_level` with values: `observe` (default, notifications only), `assist` (draft + notify), `advise` (act + report), `partner` (autonomous). Check via `meetsAutonomyLevel()` from `@open-brain/shared`. Add new settings keys to `VALID_SETTINGS_KEYS` Set in settings.ts.
- **Auto-response handler is async fire-and-forget** — runs after normal Slack message routing via `.then()/.catch()`. Never blocks capture/query/command handling. Autonomy level is cached for 5 minutes to avoid per-message settings API calls.
- **`daily-sweep-skill` is distinct from `daily-sweep`** — the existing `daily-sweep` job (3 AM) silently re-queues stale captures. The new `daily-sweep-skill` (8 PM) is the LLM-powered evening summary. Different BullMQ queues and job IDs.
- **MCP resources use `server.registerResource()`** — not `server.resource()`. The `@modelcontextprotocol/sdk` v1.27.1 resource API takes `(name, uri, metadata, handler)` and handler returns `{ contents: [{ uri, text, mimeType }] }`.
- **Pipeline-health skill is now scheduled** — runs every 6 hours (cron `0 */6 * * *`) via BullMQ repeatable job. Includes capture flow check (alerts if no captures in 6 hours during active hours 7am-midnight). Capture-flow alert suppressed if already sent within 24 hours (queries `skills_log`). Was previously every 30 minutes — reduced to avoid notification spam.
- **`get_weekly_brief` reads `result` JSONB, falls back to `output_summary`** — the `result` column (JSONB) stores the full structured brief; `output_summary` (TEXT) is truncated. Always prefer `result` via `COALESCE`.
- **MCP search/list previews are truncated** — `search_brain` truncates at 500 chars, `list_captures` at 300 chars. Use `get_capture` tool to fetch full content by ID.
- **`get_capture` MCP tool returns full content + linked entities** — includes content, metadata, source_metadata, tags, and entity links via JOIN on entity_links table.
- **Pipeline-health Redis connection parses REDIS_URL** — Docker sets `REDIS_URL=redis://redis:6379` but NOT `REDIS_HOST`. The skill now parses `REDIS_URL` as fallback when creating internal Queue instances for stats queries. Without this, the skill fails with ECONNREFUSED on localhost.

---

## What This Is

Self-hosted personal AI knowledge infrastructure. Ingests from voice memos, Slack, documents, email (brain@troy-davis.com via Cloudflare Email Worker); stores in Postgres+pgvector; provides semantic search, AI synthesis, weekly briefs, and governance sessions.

**Status**: v1.4.0 — All 25 phases + Phase 7 consolidation + email pipeline + web synthesis + proactive intelligence. 1,504 unit tests + 95 regression tests passing. Deployed to homeserver.

## Key Architecture Decisions

- **Runtime**: TypeScript, Hono framework, Drizzle ORM
- **Database**: Postgres 16 + pgvector (pgvector/pgvector:pg16 image, no Supabase)
- **LLM Provider**: OpenAI API (api.openai.com/v1) for ALL AI requests — both embeddings and LLM inference. No local LLM dependency. API key in Bitwarden (`open-brain-openai-api-key`), passed via `LITELLM_API_KEY` env var.
- **Embeddings**: OpenAI `text-embedding-3-large` with `dimensions: 768` API parameter. The API handles dimension reduction via trained MRL (not naive truncation). NO fallback — queue and retry if API is down.
- **LLM Inference**: Model aliases fast, synthesis, governance, intent — all `gpt-5.4` (configured in `config/ai-routing.yaml`). Uses `max_completion_tokens` (not `max_tokens`).
- **Schema**: `vector(768)` everywhere. Do not use 1536.
- **Search**: Hybrid retrieval (FTS + vector with RRF) + ACT-R temporal decay scoring. Default temporal_weight: 0.0 (cold start), ramp up as search history builds.
- **MCP Auth**: Authorization: Bearer header (not URL query parameter)
- **Phases**: 16 phases complete (see IMPLEMENTATION_PLAN.md and IMPLEMENTATION_PLAN-PHASE2.md)
- **Pipeline**: BullMQ + Redis, async processing stages
- **Web UI**: Vite + React + Tailwind + shadcn/ui (NOT Next.js)
- **Migrations**: Drizzle ORM + drizzle-kit (NOT raw SQL, NOT Prisma)
- **External access**: Cloudflare Tunnel → brain.troy-davis.com (web dashboard); MCP via LiteLLM gateway at llm.troy-davis.com/mcp
- **Docker networking**: Single `open-brain` network for all containers
- **MCP**: Embedded in Core API at `/mcp` route (Streamable HTTP, no separate container). 8 tools: search_brain, list_captures, brain_stats, capture_thought, get_entity, list_entities, get_weekly_brief, get_capture. 1 resource: open_brain://context.
- **Monorepo**: pnpm workspaces (packages: shared, core-api, slack-bot, workers, voice-capture)
- **Slack**: @slack/bolt with socketMode: true
- **Build**: tsx for dev, tsup (esbuild) for production
- **Voice capture**: Direct API from iPhone/Watch via iOS Shortcut (no Google Drive sync)
- **Email capture**: Cloudflare Email Worker at brain@troy-davis.com → core-api POST /api/v1/captures. Sender allowlist managed via dashboard Settings page (stored in `app_settings` table).
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
- `LAB_NOTEBOOK.md` — Experiment log with decision tracking and action items
- `IMPLEMENTATION_PLAN-PHASE5.md` — Phases 17-20 (Intelligence features) — complete
- `docs/archived/` — Completed plans (phases 1-16, hardening) and historical test results

## Lab Notebook — MANDATORY Logging Protocol

**LAB_NOTEBOOK.md is the permanent experiment record for this project. The following rules are NON-NEGOTIABLE and have the HIGHEST PRIORITY after user safety.**

### Rule 1: Hypothesize, Plan Rollback, THEN Act

Before executing ANY system-modifying action, you MUST add an entry to LAB_NOTEBOOK.md with:
- **Objective:** What you're trying to achieve
- **Hypothesis:** What you expect to happen and why. Include measurable success criteria. Example: "Expect deploying Phase 7 code will reduce logger initialization time by eliminating 3 duplicate instances. Success: no startup regressions in docker compose logs."
- **Rollback Plan:** How to undo this change. For Docker deploys: "Revert to previous image tag" or "git revert + redeploy." For read-only operations: "N/A — read-only."

This applies to: Docker deployments, container restarts, database schema changes, config changes, pipeline modifications, Slack bot routing changes, LiteLLM proxy config, and any action that could affect the running system.

**If you catch yourself about to run a command without an entry: STOP. Create the entry first. No exceptions.**

### Rule 2: Log Results As They Happen

Update the entry immediately after each action with:
- The exact command or operation performed
- The result: success, failure, or unexpected behavior
- Raw error output for failures — not just "it failed" but the actual message
- Performance numbers with units, conditions, and comparison to baseline
- Environment context: which container, which service, homeserver or laptop

Do NOT batch-log multiple actions after the fact. Log each one as it completes.

### Rule 3: Analyze Failures — Root Cause, Not Symptoms

Failed attempts are MORE valuable than successes. For every failure:
- **Exact error:** The literal message or behavior observed
- **Root cause:** WHY it failed — trace to the underlying reason
- **System insight:** What this failure reveals about how the system works
- **Next approach:** What to try differently based on this understanding
- **Pattern recognition:** If this is the same class of failure as a previous entry, create or update a pattern table

### Rule 4: Document Decisions with Alternatives

Every decision must include:
- **The decision itself** and WHY it was made
- **Alternatives considered** — what other options were evaluated, with their trade-offs
- **Update the Decision Log table** at the top of LAB_NOTEBOOK.md

When revisiting a previous decision: update the old decision's status to SUPERSEDED and reference the new entry.

### Rule 5: Track What Worked, Not Just What Failed

Include a "What Worked" section in entries with mixed outcomes. Successes establish positive patterns — which deployment steps are reliable, which container configurations are stable.

### Rule 6: Write Before Risky Operations

Before any operation that could crash the session, corrupt state, or take a long time:
- Flush ALL current findings to LAB_NOTEBOOK.md
- Include intermediate results, even if incomplete
- Update the Decision Log and Action Items tables

### Rule 7: Maintain Living Sections

After EVERY completed entry, update the living sections at the top of LAB_NOTEBOOK.md:
- **Decision Log:** Add new decisions, update superseded ones
- **Action Items:** Add follow-ups from the entry, mark completed items

### Rule 8: Tag and Contextualize Every Entry

Every entry must have:
- **Tags:** `[deploy]` `[docker]` `[pipeline]` `[slack]` `[api]` `[web]` `[database]` `[embedding]` `[config]` `[benchmark]` `[debug]` `[decision]`
- **Environment:** Which system (homeserver/laptop), which containers affected, docker compose state
- **Duration** (when completed): how long the work took

### Rule 9: Pattern Tables for Repeated Issues

When failures share a root cause or pattern, consolidate them into a table.

### Rule 10: Session Boundaries

When starting a new session, add a session boundary marker before your first entry:

`--- New session: {date} — {brief context} ---`

Read the Decision Log and Open Action Items before starting work.

### Rule 11: Log Before You Commit

**BLOCKING PRECONDITION on `git commit`:** Before every commit that touches application code (not just docs), the LAB_NOTEBOOK.md must have a current entry covering what you're about to commit. If the entry doesn't exist yet, create it before staging files. One entry can cover multiple related commits, but the entry must be written BEFORE the first commit in that sequence, not after.

This is the rule that prevents batching. It's easy to skip a "log results" step. It's harder to skip when the log IS the commit workflow.

### Enforcement

These rules are BLOCKING PRECONDITIONS, not suggestions. The mechanical process is:
1. Create/update LAB_NOTEBOOK.md entry with Hypothesis + Rollback Plan
2. Execute the action
3. Log the result immediately
4. **Before `git commit`: verify the notebook entry exists and covers this change**
5. Update Decision Log and Action Items if applicable
6. Repeat

No exceptions for "quick" changes, "obvious" fixes, or "simple" tests.

## Conventions

- Single-user system — no auth, no multi-tenancy
- Config-driven: YAML for pipelines, AI routing, skills, brain views
- Prompt templates versioned as text files (v1, v2, v3)
- Pipeline retry: 5 attempts with patient backoff (30s, 2m, 10m, 30m, 2h) + daily auto-sweep
- Monthly AI budget: soft $30 (alert), hard $50 (circuit breaker)
