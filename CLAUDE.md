# Open Brain — AI Assistant Context

## Operational Rules — Learning Capture

**Apply in every session. Do not skip.**

After any non-trivial finding (container startup failure, networking quirk, pipeline/embedding surprise, Slack routing, or any fix that took more than one attempt):

1. **Update `CLAUDE.md`** — add or update a bullet in the relevant section.
2. **Update the topic memory file** — root cause + fix + what to watch for, in `~/.claude/projects/.../memory/`.
3. **Update `MEMORY.md`** — concise bullet + link so it survives compaction.

### Learning file locations

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Operational rules, always enforced |
| `memory/MEMORY.md` | Concise index, survives compaction |
| `memory/deployment-learnings.md` | Docker, infra, container startup |
| `memory/pipeline-learnings.md` | BullMQ, retry, job wiring |
| `memory/embedding-learnings.md` | Vectors, LiteLLM embedding quirks |
| `memory/integration-test-findings.md` | e2e bug patterns |

### Verified operational rules (do not repeat these mistakes)

**Docker / infra**
- Healthchecks use `127.0.0.1`, not `localhost` — Alpine resolves to IPv6; wget fails silently. Affects core-api, voice-capture, web.
- Docker Compose `ports` in override files are appended, not replaced. Set correct ports in `docker-compose.yml` directly.
- voice-capture entry is `dist/server.js` (builds from `server.ts`).
- `postgresql.conf` must set `listen_addresses = '*'` — default blocks container-to-container.
- Node 22 LTS base images (both `Dockerfile` and `packages/web/Dockerfile` = `node:22-alpine`). CI matches (`engines: >=22`).
- **No auto-migration on startup** — after Postgres volume recreation, manually apply `scripts/init-schema.sql` + all `packages/shared/drizzle/0*.sql`. Check `\dt` in psql first.
- `CREATE TRIGGER` is not idempotent — always `DROP TRIGGER IF EXISTS <name> ON <table>` before `CREATE TRIGGER`. Affects `scripts/init-schema.sql`.
- core-api Docker image ships `postgresql-client` (for P04a pg_dump). Tests can set `ADMIN_RESET_SKIP_PGDUMP=true`; never in production compose.

**API / endpoints**
- `/health` is Docker-internal only. Use `/api/v1/captures?limit=1` for external health + tunnel checks.
- `POST /api/v1/captures` returns `{id, pipeline_status, created_at}` only. Use `GET /api/v1/captures/:id` for full record.
- `POST /api/v1/documents` hashes the title (`[Document] {title}`), not file bytes — same title → 409 Conflict.
- `GET /api/v1/search` returns `{ results: [{ capture, score }] }`, not a flat captures array.
- Health API returns `'healthy'` / `'degraded'` / `'unhealthy'` (not `up`/`down`). Web UI StatusDot accepts both.
- `POST /admin/reset-data` is **two-step** (P04a): step 1 (no `confirm`) issues a 5-min single-use Redis token; step 2 requires `confirm: "WIPE ALL DATA"` + token. Every attempt (requested/executed/blocked/error) writes `admin_audit` (migration 0023). Pre-wipe `pg_dump` → `/backup/pre-wipe/<ISO>.sql` in `admin_prewipe_backup` volume. Origin: `brain.troy-davis.com` only. CF Access email header forwarded by nginx for actor attribution. **`admin_audit` is EXCLUDED from TRUNCATE list** — code-level test asserts this invariant.
- `POST /admin/reset-data` has no `adminAuth()` (web UI has no Bearer mechanism). Protection is origin allowlist + two-step token + confirmation phrase + rate limiter. Do not re-add `adminAuth()` without a web UI auth mechanism.
- **`NODE_ENV` production detection must be fail-closed** for security-sensitive checks: `if (env === 'development' || env === 'test') return true`. Unset/unknown NODE_ENV is treated as production. Applied in P04a `checkOrigin()`.
- `checkLLMProvider()` detects baseUrl ending `/v1` to avoid doubling the prefix when building `/models` URL.

**Database / schema**
- `vector(768)` everywhere (not 1536).
- Matryoshka truncation check uses `< 768`, not `!== 768` — `raw.slice(0, 768)` runs after.
- Captures has no `tsv` column — FTS uses expression-based GIN index on `to_tsvector('english', content)`.
- Drizzle does not emit SQL `AS` for computed SELECTs — use the full expression in ORDER BY (e.g., `desc(sql\`COUNT(${entity_links.id})\`)`), not the JS alias.
- `capture_associations` uses canonical pair ordering (`capture_id_a < capture_id_b`) — sort UUIDs before insert.
- `spreading_activation` SQL function requires migrations 0011 + 0012 together.
- **`captures.source` has 9 valid values:** `slack`, `voice`, `api`, `document`, `mcp`, `email`, `file`, `consolidation`, `system`. Canonical TS union: `CaptureSource` (`packages/shared/src/types/capture.ts`). Zod: `CAPTURE_SOURCES`. DB CHECK: migration 0022. Semantics: `file` = document-router file refs, `consolidation` = memory-consolidation dedup, `system` = internal events (e.g., bet resolution). **Adding a source → update all four surfaces in lockstep.**
- `app_settings` is a generic key/value store (`key TEXT PRIMARY KEY, value JSONB`). Settings API keys whitelisted in `VALID_SETTINGS_KEYS` Set; add new keys there.
- **Pre-flight DB audit (`SELECT DISTINCT <col>`) is MANDATORY before CHECK-constraint migrations** — grep misses cold paths (bet.ts surfaced a 9th `source` value). See LAB_NOTEBOOK Entry 089.

**LLM / AI**
- **Verify `ai-routing.yaml` cost path before ANY bulk operation.** 3,230 file captures cost $100+ because entity extraction routed to Anthropic. `t1_spark` (Qwen 35B on DGX Spark, free) handles routine tasks. Jetson IP = `192.168.10.58` (static).
- **Paid-provider tiers in `ai-routing.yaml` MUST declare `cost_per_1k_input`/`cost_per_1k_output`** (anthropic, openai, openai_compat, litellm, deepseek). `ollama` exempt. **Explicit `0` is canonical** for free-but-non-ollama endpoints (Jetson, Spark) — keeps budget circuit breaker non-blind. Zero ≠ missing. `ConfigService.load()` throws fail-fast on missing fields.
- `estimateTierCostUsd()` reads from tier config (P03): `tokens × cost_per_1k / 1000`. `undefined` → 0 (ollama); explicit 0 → 0 (free tiers). `ai_audit_log.cost_usd` now reflects real Anthropic costs. Tier config is the single source of truth.
- Test fixtures with paid-provider `model_tiers` MUST include cost fields (explicit 0 OK) or `ConfigService.load()` throws. `validateTaskRouting()` runs only in `reload()`, not `load()`.
- `ModelTierEntry.cost_per_1k_*` is `number | undefined` — consumers treat undefined as 0.
- OpenAI `gpt-5.4` uses `max_completion_tokens` (not `max_tokens`, rejected 400). **No `extra_body`** (vLLM-specific, rejected 400).
- `createLiteLLMClient()` returns `null` when API key is empty — callers must check and disable LLM features (core-api governance engine pattern).
- **`callClaude` removed in P02b.** All LLM skills + `extract-entities` use `LLMGatewayService.completeByTask()`; `litellmClient` is a test-mock injection point only. Do not reintroduce direct Anthropic SDK in skills — add a `task_routing` entry instead.
- `memory-consolidation` routes via `'search_synthesis'` task key (A71 pending) — real key `'memory_consolidation'` doesn't exist in `ai-routing.yaml` yet. Do not "fix" in a drive-by edit.
- Skills must resolve model aliases from `configService.get('ai').models[alias]` before dispatching to OpenAI. Same pattern as `extract-entities.ts`.
- Classification tasks route to `t1_jetson` by default (6 tasks: intent, capture, brain_view, voice, confidence, question_detection). Fallback: `t1_jetson → t1_fast → t2_quality`.
- `openai_compat` tiers: gateway creates per-tier OpenAI SDK clients from tier `base_url`. `ollama` keeps the constructor-injected client (preserves test mock compatibility).
- `EmbeddingService` uses adaptive truncation — 16K chars, halves to 2K min on OpenAI 400 "context length". Never estimate tokens from chars (JSON/minified ≈ 2 chars/token).
- Budget-check: `LITELLM_SPEND_URL` env var queries external proxy spend API (legacy `LITELLM_URL`/`LITELLM_API_KEY` retired in CS5). When unset, skips HTTP and uses local `ai_audit_log` estimation.

**MCP / Slack / voice**
- LiteLLM MCP server names can't contain `-` (use `_`); transport must be `http` (v1.81 only accepts `http`, `sse`, `stdio`).
- MCP Streamable HTTP returns SSE framing: `event: message\ndata: {json}`. Clients send `Accept: application/json, text/event-stream`; parse the `data:` line.
- MCP resources use `server.registerResource(name, uri, metadata, handler)` returning `{ contents: [{ uri, text, mimeType }] }` — not `server.resource()`.
- MCP previews truncate at 500 (`search_brain`) / 300 (`list_captures`) chars. Use `get_capture` tool for full content + linked entities.
- `get_weekly_brief` reads `result` JSONB first, falls back to `output_summary` (truncated). Always COALESCE.
- Slack `app_mention` always routes to `handleQuery`. Captures and `!commands` require plain channel messages via IntentRouter.
- `SLACK_SIGNING_SECRET` not needed for Socket Mode (only for HTTP webhooks). Only `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`.
- Slack-bot loads only `ai-routing.yaml` via lightweight `js-yaml` (not full `ConfigService`, which requires all 4 configs). Fallback model: `gpt-5.4`. Config dir mounted `./config:/app/config:ro`; load is graceful if missing.
- Voice-capture multipart field is `file` (not `audio`); also accepts optional `latitude`, `longitude`, `location_name`, `location_accuracy`.
- Voice-capture classification model is `gpt-5.4` hardcoded in `classification.ts`. Override via `CLASSIFICATION_MODEL` env.

**Pipeline / workers / skills**
- Entity resolver lives in `workers/src/lib/entity-resolver.ts`, shared by `extract-entities.ts` + `link-entities.ts`. Indexed SQL, not in-memory.
- Shared utilities in `@open-brain/shared`: `createLogger`/`logger`, `createLiteLLMClient`, `PushoverService`, `assertOk`/`HttpError`, `TemplateCache`, `model-resolver`. Do NOT duplicate in consumer packages.
- `TemplateCache.render()` replaces `loadPromptTemplate()` on hot paths. Old functions kept only for back-compat.
- `daily-sweep-skill` (8pm, LLM evening summary) is distinct from `daily-sweep` (3am stale-capture re-queuer). Different BullMQ queues/jobs.
- Pipeline-health runs every 6h (`cron: 0 */6 * * *`). Capture-flow check alerts if no captures in 6h during active hours (7am–midnight), suppressed 24h if already sent (queries `skills_log`). Parses `REDIS_URL` (not `REDIS_HOST`, which isn't set in Docker) for internal Queue instances.
- Auto-response handler is async fire-and-forget (`.then()/.catch()`) — never blocks capture/query/command. Autonomy level cached 5 min.
- Autonomy levels (`app_settings.autonomy_level`): `observe` (default, notifications only) / `assist` (draft + notify) / `advise` (act + report) / `partner` (autonomous). Check via `meetsAutonomyLevel()` from shared.
- Hebbian co-access tracking is fire-and-forget (try/catch in `update-access-stats`). Association failures never block primary access updates.
- Memory-consolidation skill is hyphenated `memory-consolidation` (cron `0 4 * * 0`). Merged captures use `source: 'consolidation'`; originals soft-deleted with `deleted_at`.
- Search `include_related` defaults: **false (API, back-compat) / true (MCP, agents benefit from context).**
- pg-notify auto-reconnects (exponential backoff 1s→30s, 5 attempts). Re-registers all LISTEN channels. SSE events resume.

**Integrations / external services**
- **Composio quota meter (P03):** `ComposioClient.execute()` increments `composio:monthly_usage:YYYY-MM`. Hard stop at 19K/month (95%). Pushover warn at 15K (75%). Only active when Redis is injected via the options form (`new ComposioClient({ apiKey, redis, pushover })`). New Composio callers in workers MUST pass meter Redis + Pushover from `main.ts`.
- **Composio vs. Direct API:** reads + low volume (< 50 calls/day) → Composio. Writes, bulk ops, or > 50 calls/day → Direct (MSAL Graph, googleapis). OneDrive → rclone. Financial APIs → direct by nature.
- Cloudflare Email Workers: `workers_dev = false` — email-only workers have no HTTP routes; default creates a useless `*.workers.dev` subdomain.
- Python `urllib` gets 403 from Cloudflare (blocks default user-agent). Use `curl` for CF-fronted endpoint testing.
- Email worker derives base API URL from `CAPTURES_URL` via regex `replace(/\/captures\/?$/, '')`, not string replace.
- Rate-limiter `BYPASS_CALLERS` is a Set in `rate-limit.ts`. Add new bypass callers there (e.g., `email-worker`).

**Backup / disaster recovery**
- **`scripts/backup.sh` MUST NEVER copy `.env.secrets` (or any file with live credentials) into the backup payload.** Secrets live in Bitwarden — post-restore rebuild via `scripts/load-secrets.sh` (stub today; P08 completes) or manual `bws secret get` loop per `deploy/.env.secrets.template`. Regression guard: `scripts/test-backup-secrets-redaction.sh` (P04b) — greps ephemeral backup tree for known secret variable names, exits 1 on any match.
- `scripts/backup.sh` honors `BACKUP_ROOT` and `APP_DIR` env overrides (P04b added, matches existing `WIKI_REPO_URL` precedent). Homeserver cron uses defaults; overrides are for test harnesses. When adding similarly test-gated shell scripts, use the `${VAR:-default}` pattern, not hard assignments.

**Front-end / web**
- **PWA service worker aggressively caches Vite-hashed bundles.** After every web deploy: hard-refresh (Ctrl+Shift+R) AND in DevTools console run `caches.keys().then(names => Promise.all(names.map(n => caches.delete(n))))`. SW unregister alone is insufficient. Recurring issue after every web rebuild.
- Web package must be self-contained for Docker build. Vite `?raw` imports that escape `packages/web/` fail (`.dockerignore` excludes `docs/`). User-facing markdown must live in `packages/web/src/content/`.
- `CaptureCard` is a single shared component (`packages/web/src/components/CaptureCard.tsx`) — Dashboard, Timeline, EntityDetail, Search all use it.

**Testing / CI**
- Integration tests: `pnpm --filter @open-brain/core-api exec vitest run --config vitest.config.integration.ts` (not `npx`; filename word order matters).
- All test HTTP helpers send `X-Open-Brain-Caller: integration-test` header — rate limiter bypasses this key. Without it, strict tier (20 req/min) exhausts.
- **Vitest `pool: 'forks'` requires both `minForks: 1` + `maxForks: N`** on vitest 1.6 (single-arg trips Tinypool `RangeError`). Applied in core-api + workers configs with `hookTimeout/testTimeout: 30_000` — avoids Windows ioredis/bullmq races.
- Mock external service calls in tests (Pushgateway, Prometheus) — `pushMetrics()` hits `http://pushgateway:9091` which hangs on DNS in tests (5s). Always `vi.mock('../lib/push-metrics.js', ...)`.
- **Prefer `vi.fn().mockResolvedValue(x)` over `vi.fn(async () => x)`** when the mock receives later `.mockImplementation(...)` overrides. Body-form narrows `Mock` generic to zero-arg, fails `tsc --noEmit` when overrides pass 2+ args (ioredis, fetch, etc.). Pattern recurred in P03 + P04a.
- Always commit `pnpm-lock.yaml` with any `package.json` change — CI uses `--frozen-lockfile` (`ERR_PNPM_OUTDATED_LOCKFILE` otherwise).
- Node.js `punycode` DEP0040 warning is cosmetic (vitest → jsdom → whatwg-url → tr46 → punycode, dev-only). Do not investigate.
- JSDoc can't contain `*/` (tsup --dts parses as end-of-comment). Use expanded cron forms like `0,6,12,18` instead of `*/6` inside JSDoc.

**Git / GitHub**
- Verify `gh auth status` before any write operation — the client can silently switch to a read-only account, causing opaque 404s on label/milestone/issue creation. Confirm active account has push/admin on target repo.
- `gh issue create --milestone` takes the milestone TITLE (not number). Quote the full title including punctuation.

---

## Cost-Tiered Processing — MANDATORY

**Every new feature / pipeline / skill / data source follows this tiering. Never default to API calls.**

Troy has a Claude Max subscription covering Claude Code. API usage (Anthropic / OpenAI / Deepgram) is extra. Exhaust cheaper tiers first.

| Tier | Used for | Cost | When |
|------|----------|------|------|
| **T0: Python/code** | Parsing, extraction, regex, rule-based classification, lookup, dedup, normalization | Free | **Always first.** Deterministic work never needs an LLM. |
| **T1: Small local LLM** | Simple classification, short summaries, yes/no, sentiment | Free | When T0 can't decide. Smallest model that works (Gemma 3 4B, Phi-3 Mini). |
| **T2: Claude Code CLI** | Complex analysis, multi-doc synthesis, reasoning, reports | Free (subscription) | Batch/async, latency-insensitive. **Aggregate first, then one prompt — never per-item.** Use `claude --print`. |
| **T3: API (Anthropic/OpenAI)** | Real-time, streaming, tool_use, embeddings | $$/token | **Last resort.** Only when a human is actively waiting (MCP, Slack, voice, governance). OpenAI embeddings have no free alternative and stay here. |

### Aggregation rule

**Never call an LLM per-item when you can aggregate.** Pattern: **collect → extract (T0) → classify (T0/T1) → aggregate → synthesize (T2) → store one capture.**
- 200 emails/day → Python + 1 CLI call → 1 daily summary capture
- 50 Amazon orders/month → Python + 1 CLI call → 1 monthly capture
- 30 transactions/day → Python + 1 CLI call → 1 briefing capture

### Two-track pipeline

- **Track A (real-time):** Voice, Slack, manual, MCP → full pipeline (embed + extract entities + wiki-ingest); API OK for entity extraction (user waiting).
- **Track B (batch):** Email, financial, docs, scraping → Python (T0) + local LLM (T1) for ambiguous → aggregate → Claude CLI synthesis (T2) → synthesis output enters pipeline as one capture.

### Checklist before calling any LLM

1. Can Python do this? → Do it in Python.
2. Simple classification, short input? → Local LLM (T1).
3. Batch/async? → Claude Code CLI (T2).
4. Human actively waiting? → OK to use API (T3).
5. Calling LLM per-item? → **STOP.** Aggregate first.

### Monthly budget

| Component | Target |
|-----------|--------|
| Claude Max subscription | $100–200 (fixed) |
| Anthropic API (T3) | < $10 |
| OpenAI embeddings | < $10 |
| Deepgram voice | < $5 |
| Other APIs | < $10 |
| **Total beyond subscription** | **< $35/month** |

---

## What This Is

Self-hosted personal AI knowledge infrastructure. Ingests from voice memos, Slack, documents, email (brain@troy-davis.com via Cloudflare Email Worker); stores in Postgres+pgvector; provides semantic search, AI synthesis, weekly briefs, governance sessions.

**Status:** v1.5.0. All 25 phases + Phase 7 consolidation + email pipeline + web synthesis + proactive intelligence + cognitive memory (Hebbian, spreading activation, memory consolidation). 1,569 unit + 95 regression tests passing. Deployed.

## Key Architecture

- **Runtime:** TypeScript, Hono, Drizzle ORM. Monorepo via pnpm workspaces (packages: `shared`, `core-api`, `slack-bot`, `workers`, `voice-capture`).
- **Database:** Postgres 16 + pgvector (`pgvector/pgvector:pg16`). No Supabase. Migrations via Drizzle + drizzle-kit (not raw SQL, not Prisma).
- **LLM provider:** OpenAI API (`api.openai.com/v1`) for ALL AI — embeddings + inference. No local LLM dependency. Key in Bitwarden `open-brain-openai-api-key` → `OPENAI_API_KEY` env.
- **Embeddings:** `text-embedding-3-large` with API param `dimensions: 768` (trained MRL, not naive truncation). `vector(768)` schema. NO fallback — queue and retry if API is down.
- **Inference:** All aliases (fast, synthesis, governance, intent) → `gpt-5.4` (in `config/ai-routing.yaml`). Uses `max_completion_tokens`.
- **Search:** Hybrid FTS + vector (RRF) + ACT-R temporal decay + Hebbian boost + spreading activation (`include_related`). Default `temporal_weight` 0.0 (cold start).
- **MCP:** Embedded in Core API at `/mcp` (Streamable HTTP, no separate container). 8 tools (`search_brain`, `list_captures`, `brain_stats`, `capture_thought`, `get_entity`, `list_entities`, `get_weekly_brief`, `get_capture`) + 1 resource (`open_brain://context`). Auth: `Authorization: Bearer` header (not URL query).
- **Pipeline:** BullMQ + Redis async stages.
- **Web:** Vite + React + Tailwind + shadcn/ui (NOT Next.js).
- **External access:** Cloudflare Tunnel → `brain.troy-davis.com` (dashboard); MCP via LiteLLM gateway at `llm.troy-davis.com/mcp`.
- **Docker:** Single `open-brain` network. Build: tsx dev, tsup (esbuild) prod.
- **Slack:** `@slack/bolt` with `socketMode: true`.
- **Voice:** Direct API from iPhone/Watch via iOS Shortcut (no Drive sync).
- **Email:** Cloudflare Email Worker → core-api `POST /api/v1/captures`. Sender allowlist in `app_settings` via dashboard Settings page.
- **Governance:** LLM-driven with guardrails (not FSM).

## Target Hardware

Intel i7-9700 (8C/8T), 128 GB DDR4, no GPU, 32 TB array. Unraid OS. Container limits: faster-whisper 8 GB, Postgres 8 GB.

## Brain Views

Five views, auto-classified: `career`, `personal`, `technical`, `work-internal`, `client`.

## Capture Types

Eight: `decision`, `idea`, `observation`, `task`, `win`, `blocker`, `question`, `reflection`. Extensible via prompt template updates.

## Secrets

All API keys in Bitwarden. Never in `.env` or config files. Use `bws` CLI.

## Important Files

- `docs/PRD.md` — v0.6, architectural review v2 applied
- `docs/TDD.md` — v0.5, architectural review v2 applied
- `LAB_NOTEBOOK.md` — experiment log, decision tracking, action items
- `IMPLEMENTATION_PLAN-PHASE5.md` — phases 17-20 (Intelligence) — complete
- `docs/archived/` — phases 1-16 plans + historical test results

## Lab Notebook — MANDATORY Logging Protocol

`LAB_NOTEBOOK.md` is the permanent experiment record. Rules below are **BLOCKING PRECONDITIONS**, not suggestions. No exceptions for "quick" or "obvious" changes.

### Before acting

Before ANY system-modifying action, add an entry with:
- **Objective** — what you're trying to achieve
- **Hypothesis** — expected outcome + measurable success criteria
- **Rollback plan** — how to undo (Docker: revert image tag / `git revert` + redeploy; read-only: "N/A")

Applies to Docker deploys, container restarts, schema/config/pipeline changes, Slack routing, LiteLLM config — anything affecting the running system. **No entry → STOP, create the entry first.**

### While working

- **Log results as they happen** — each action immediately, not batched. Exact command, outcome (success/failure/unexpected), raw error output, performance numbers with units + conditions, environment context (container, service, host).
- **Analyze failures to root cause** — exact error, root cause, system insight, next approach. Consolidate repeated failures into pattern tables.
- **Document decisions with alternatives considered + trade-offs.** Update the Decision Log table at the top. When revisiting a prior decision: mark old as SUPERSEDED and reference the new entry.
- **Track what worked.** Successes establish positive patterns.
- **Before risky ops:** flush all findings + intermediate results to disk.

### After each entry

Update living sections at top of `LAB_NOTEBOOK.md`:
- **Decision Log** — new/superseded decisions
- **Action Items** — follow-ups added, completed items marked

Every entry must have **tags** (`[deploy]` `[docker]` `[pipeline]` `[slack]` `[api]` `[web]` `[database]` `[embedding]` `[config]` `[benchmark]` `[debug]` `[decision]`), **environment** (homeserver/laptop, containers affected), and **duration** when complete.

### Session boundaries

On a new session, add `--- New session: {date} — {brief context} ---` and read the Decision Log + open Action Items before starting.

### Before `git commit` (BLOCKING)

Every commit that touches application code requires a current `LAB_NOTEBOOK.md` entry covering the change, created BEFORE the first commit in the sequence. One entry can cover multiple related commits. The log IS the commit workflow — this is what prevents batching.

## Conventions

- Single-user system — no auth, no multi-tenancy.
- Config-driven: YAML for pipelines, AI routing, skills, brain views.
- Prompt templates versioned as text files (v1, v2, v3).
- Pipeline retry: 5 attempts with patient backoff (30s, 2m, 10m, 30m, 2h) + daily auto-sweep.
- Monthly AI budget: soft $30 alert, hard $50 circuit breaker.
