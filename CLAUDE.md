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
- **Capture `source` column has 9 valid values** — `slack`, `voice`, `api`, `document`, `mcp`, `email`, `file`, `consolidation`, `system`. Canonical TS union: `CaptureSource` in `packages/shared/src/types/capture.ts`. Zod validator: `CAPTURE_SOURCES` in `packages/core-api/src/schemas/capture.ts`. DB-level CHECK constraint: migration `0022_captures_source_check.sql` (applied 2026-04-18). Usage notes: `'file'` = document-router file-reference captures derived from uploaded documents; `'consolidation'` = memory-consolidation skill merging near-duplicate captures; `'system'` = system-generated captures from internal events (e.g., bet resolution reflections in `packages/core-api/src/services/bet.ts`). When adding a new source, update all four surfaces in lockstep: TS union + Zod enum + CHECK migration + this bullet.
- **Skills must resolve model aliases from ai-routing.yaml** — workers skills pass `modelAlias` directly to OpenAI. With LiteLLM proxy gone, aliases like `synthesis` cause 404. The skill-execution worker must resolve via `configService.get('ai').models[alias]` before dispatching. Same pattern as `extract-entities.ts`.
- **`callClaude` removed in P02b (2026-04-18)** — all LLM skills (`memory-consolidation`, `weekly-brief`, `daily-connections`, `daily-sweep-skill`, `drift-monitor`) and `extract-entities` use `LLMGatewayService.completeByTask()` as the primary path. `litellmClient` (OpenAI SDK) is retained as the test-compat fallback only (injected by unit tests via `skill.litellmClient = mock`). `packages/shared/src/services/call-claude.ts` is deleted. Do NOT re-introduce direct Anthropic SDK calls in skills — add a new task_routing entry in `ai-routing.yaml` and route through the gateway.
- **`memory-consolidation` routes via `'search_synthesis'` task key (A71 pending)** — naming mismatch: the task key should be `'memory_consolidation'` but that routing entry does not exist in `ai-routing.yaml` yet. Using `'search_synthesis'` for now. Do not "fix" the task name in a drive-by edit — A71 tracks this and requires adding the routing entry + verifying tier mapping first. See IMPLEMENT_PHASE-P02b.md DRIFT-3.
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
- **`capture_associations` uses canonical pair ordering** — `capture_id_a < capture_id_b` CHECK constraint mirrors `entity_relationships` pattern. Always sort UUIDs before insert.
- **Hebbian co-access tracking is fire-and-forget** — wrapped in try/catch inside `update-access-stats` worker. Association failures never block the primary access count update.
- **`spreading_activation` SQL function requires migrations 0011 + 0012** — function references `capture_associations` table. Apply both migrations together.
- **Search `include_related` defaults to false (API) but true (MCP)** — API is backward compatible; MCP agents benefit from broader context by default.
- **Memory consolidation source type is `consolidation`** — merged captures use `source: 'consolidation'` to distinguish from original sources. Soft-deleted originals retain `deleted_at` timestamp for recovery.
- **Memory consolidation skill is `memory-consolidation`** (not `memory_consolidation`) — hyphenated, consistent with other skill names. Cron: `0 4 * * 0` (4 AM Sundays).
- **Mock all external service calls in tests (Pushgateway, Prometheus, etc.)** — `pushMetrics()` in pipeline-health and container-health calls `http://pushgateway:9091` via `globalThis.fetch`. In tests, DNS resolution hangs until timeout (5s). Always `vi.mock('../lib/push-metrics.js', ...)` in skill tests that use these modules. Same pattern as DB/Redis/Pushover mocking.
- **Always commit pnpm-lock.yaml after adding dependencies** — CI uses `--frozen-lockfile`. If package.json changes but lockfile doesn't, CI fails with `ERR_PNPM_OUTDATED_LOCKFILE`. Run `pnpm install` and commit the lockfile in the same commit as the package.json change.
- **Node.js punycode DEP0040 warning is cosmetic** — emitted during test runs only. Transitive dev-only dependency path: `vitest → jsdom → whatwg-url → tr46 → punycode`. No production runtime path (verified via `pnpm why --prod`). No functional impact. Awaiting upstream fix. Do not investigate further.
- **`openai_compat` tiers get per-tier cached clients** — the LLM gateway's `getClientForTier()` creates OpenAI SDK clients from the tier's `base_url` for `openai_compat` provider. `ollama` provider continues using the pre-constructed `this.ollamaClient`. This preserves test mock compatibility (tests inject mock ollama client via constructor).
- **EmbeddingService uses adaptive truncation** — first attempt at 16K chars; if OpenAI returns 400 "context length" error, halves the limit and retries (down to 2K min). Character estimation (e.g., 4 chars/token) is unreliable for dense content like JSON or minified code (~2 chars/token). Never estimate — catch and retry.
- **Composio vs. Direct API — volume and write-intensity determine the choice:**
  - **Composio for reads + low volume** — calendar events, Drive/Sheets/Notion lookups, light email triage (< 20 calls/day). Already connected: Gmail, Outlook, Drive, Sheets, Notion, Slack. Use `COMPOSIO_SEARCH_TOOLS` to discover new integrations.
  - **Direct API for writes + high volume** — email pipeline (150+ emails/day × fetch+move = 300+ calls), folder management, bulk operations, correction detection. Direct Graph API (MSAL) and Gmail API (googleapis) give full control and don't burn Composio's 20K/month free tier.
  - **Rule of thumb:** If the integration does > 50 API calls/day or needs write operations (create folders, move items, modify labels), go direct. If it's read-only and under 50 calls/day, use Composio.
  - **Exceptions:** OneDrive uses rclone (already configured). Financial APIs (SimpleFIN, Plaid) are direct by nature.
- **Classification tasks route to `t1_jetson` by default** — `ai-routing.yaml` routes 6 classification tasks (intent, capture, brain_view, voice, confidence, question_detection) to `t1_jetson` (Qwen 3.5 4B on Jetson, 0.67s/call, free). Fallback chain: `t1_jetson → t1_fast → t2_quality`. Complex tasks (entity extraction, synthesis, governance) stay on `t1_fast` or `t2_quality`.
- **JSDoc comments must not contain `*/` sequences** — `tsup --dts` parses `*/` inside JSDoc as end-of-comment, causing DTS build failures. Use expanded cron forms (e.g., `0,6,12,18` instead of `*/6`) in JSDoc comments.
- **Budget-check uses `LITELLM_SPEND_URL` (distinct from `OPENAI_BASE_URL`)** — the legacy `LITELLM_URL` / `LITELLM_API_KEY` env var names were retired in CS5 (PR #88, 2026-04-17); code now reads `OPENAI_BASE_URL` + `OPENAI_API_KEY` directly for OpenAI API calls. Budget-check retains a separate `LITELLM_SPEND_URL` env var for querying an external LiteLLM proxy's spend API. When unset (default), skips the HTTP call and uses local `ai_audit_log` estimation only.
- **CRITICAL: Verify ai-routing.yaml cost path before ANY bulk operation** — 3,230 file captures cost $100+ because entity extraction routed to Anthropic API (Haiku) instead of Spark (free). The cost_per_1k fields were all 0, so the budget circuit breaker was blind. Always check `task_routing` in ai-routing.yaml before batch ingestion. The t1_spark tier (Qwen 35B on DGX Spark) handles all routine tasks for free.
- **Jetson Orin Nano IP is 192.168.10.58** (static, not 192.168.10.44). Updated in ai-routing.yaml 2026-04-15. Old IP caused classification fallback to paid Haiku API.
- **Verify `gh auth status` before GitHub write operations** — the `gh` client can auto-switch to a read-only account (e.g., `davistroy-cfa`) silently after a session activity, causing opaque 404 errors on label/milestone/issue creation. Always run `gh auth status` and confirm the active account has `push`/`admin` on the target repo before the first write operation in a sequence. Discovered 2026-04-18 during Entry 091.
- **`gh issue create --milestone` takes the milestone TITLE, not its number** — using the number yields "not found" even if the milestone exists. Quote the full title (including parens/colons).
- **Pre-flight DB audit is MANDATORY before CHECK-constraint migrations** — always run `SELECT DISTINCT <col> FROM <table>` on production BEFORE writing the migration SQL. Grep-based enumeration across writer files reveals hot paths but misses cold paths (e.g., rarely-fired features). Discovered 2026-04-18 during A66/CS-η when the pre-flight audit surfaced a 9th undocumented `captures.source` value (`'system'` from bet.ts, 1 prod row) that Phase 1 investigation had missed. See LAB_NOTEBOOK Entry 089.
- **Vitest `pool: 'forks'` requires both `minForks` and `maxForks`** — setting only `maxForks: N` trips Tinypool `RangeError: options.minThreads and options.maxThreads must not conflict` on vitest 1.6. Always specify `poolOptions.forks: { minForks: 1, maxForks: N }`. Discovered in Phase 1 of the 2026-04-17 tech-debt cleanup; applied to both `packages/core-api/vitest.config.ts` and `packages/workers/vitest.config.ts`.
- **Paid-provider tiers in `ai-routing.yaml` MUST declare `cost_per_1k_input`/`cost_per_1k_output`** — `ConfigService.load()` calls `validateAiRoutingConfig()` and throws fail-fast on any missing cost field for paid providers (`anthropic`, `openai`, `openai_compat`, `litellm`, `deepseek`). `ollama` is exempt (free local). Explicit `0` is the canonical pattern for "free-but-non-ollama" endpoints (Jetson `t1_jetson`, Spark `t1_spark`): it passes validation while keeping the budget circuit breaker non-blind. Zero ≠ missing. Added in P02a (PR #124, 2026-04-18).
- **`ModelTierEntry.cost_per_1k_input` is `number | undefined`** — consumers reading the field receive `undefined` for `ollama` tiers (no cost field required) and must treat it as `0` for math. Validator guarantees `undefined` never appears on paid-provider tiers. P03 will consume this field in `estimateTierCostUsd()`.
- **Test fixtures using paid-provider `model_tiers` must include cost fields** — any vitest fixture that writes a `model_tiers` block with `anthropic`/`openai`/`openai_compat`/`litellm`/`deepseek` provider must declare both `cost_per_1k_input` + `cost_per_1k_output` (explicit `0` is fine) or `ConfigService.load()` will throw. Added in P02a; 2 pre-existing fixtures were updated. `validateTaskRouting()` (legacy non-fatal warn) is no longer called from `load()` — only from `reload()` (log-and-keep semantics preserved).
- **`estimateTierCostUsd()` reads from tier config as of P03** — multiplies tokens by `tier.cost_per_1k_input` / `cost_per_1k_output` divided by 1000. Undefined fields default to 0 (ollama path). Paid-provider tier with both fields explicitly 0 also returns 0 (Jetson/Spark free endpoints). `ai_audit_log.cost_usd` now reflects real cost for Anthropic tiers. Do not re-add provider-allowlist logic — tier config is the single source of truth.
- **Composio quota meter active (P03)** — `ComposioClient.execute()` increments Redis key `composio:monthly_usage:YYYY-MM` on every call. Hard stop throws `ComposioQuotaExceededError` at 19,000 calls (95% of 20K/month free tier). Pushover warn fires at 15,000 (75%). Quota enforcement is ONLY active when Redis is injected via the constructor's options form (`new ComposioClient({ apiKey, redis, pushover })`). New Composio callers in workers MUST pass the meter Redis and Pushover from `main.ts`.
- **Prefer `vi.fn().mockResolvedValue(x)` over `vi.fn(async () => x)` for mocks that receive `.mockImplementation` overrides** — the body-form narrows the `Mock` generic to a zero-arg signature, which fails `tsc --noEmit` when later `.mockImplementation(...)` calls pass 2+ args (common for ioredis, fetch, complex async APIs). The `mockResolvedValue` form keeps `Mock<any[], unknown>`, making all implementation overrides type-compatible. This pattern surfaced TWICE in the 2026-04-19 bootstrap (P03 `composio-quota.test.ts` cycle 1 + P04a `admin-reset-two-step.test.ts` cycle 1). Codified to prevent recurrence.
- **`NODE_ENV` production detection must be fail-closed for security-sensitive checks** — `if (process.env.NODE_ENV !== 'production') return true` means "treat as dev" and silently bypasses the check if NODE_ENV is unset in a production deploy. For security guards (origin allowlist, CSRF protection, etc.), use fail-closed: `if (env === 'development' || env === 'test') return true`. Unset / unknown NODE_ENV is then treated as production. Applied in P04a's `checkOrigin()` in `packages/core-api/src/routes/admin.ts` (PR #128, 2026-04-19).
- **`/admin/reset-data` is two-step as of P04a** — step 1 POST (without `confirm`) issues a single-use 5-min Redis token; step 2 POST (with `confirm: "WIPE ALL DATA"` + `token`) executes the wipe. Single-step flow no longer works. Every attempt (requested/executed/blocked/error) writes to `admin_audit` table (migration 0023). Pre-wipe `pg_dump` snapshot lands at `/backup/pre-wipe/<ISO-timestamp>.sql` in `admin_prewipe_backup` named volume. Origin allowlist is `brain.troy-davis.com` only. CF Access email header forwarded by nginx for actor attribution.
- **`admin_audit` is EXCLUDED from `/admin/reset-data` TRUNCATE list** — the audit trail survives wipes. Do NOT add it to the TRUNCATE list in `packages/core-api/src/routes/admin.ts`. A code-level test asserts this invariant.
- **core-api image ships with `postgresql-client`** — added to Dockerfile `prod-base` stage for P04a's pg_dump subprocess. ~6MB added. Tests can skip the dump via `ADMIN_RESET_SKIP_PGDUMP=true`. Do NOT set this env var in production compose.

---

## Cost-Tiered Processing — MANDATORY Design Principle

**Every new feature, pipeline stage, skill, or data source MUST follow this tiering. Do not default to API calls.**

Troy pays for a Claude Max subscription that covers Claude Code. API usage (Anthropic, OpenAI, Deepgram) is an additional per-token expense. The system must minimize API costs by exhausting cheaper tiers first.

### Processing Tiers (in order of preference)

| Tier | What | Cost | When to Use |
|------|------|------|-------------|
| **T0: Python/Code** | Parsing, extraction, fetching, rule-based classification, structured data transforms, regex, lookup tables | Free | **Always first.** If code can do it deterministically, code does it. No LLM needed for CSV parsing, known-vendor categorization, date extraction, dedup, or data normalization. |
| **T1: Small Local LLM** | Simple classification, short summarization, yes/no decisions, sentiment scoring | Free | When T0 can't decide — ambiguous categories, natural language understanding needed, but the task is simple (short input, structured output). Use smallest model that works (Gemma 3 4B, Phi-3 Mini). |
| **T2: Claude Code CLI** | Complex analysis, multi-document synthesis, reasoning, report generation | Free (subscription) | Batch/async tasks where latency doesn't matter. Daily summaries, weekly analyses, document review, insurance comparison. Use `claude --print` mode. **Aggregate first, then one smart prompt — never call per-item.** |
| **T3: API (Anthropic/OpenAI)** | Real-time responses, streaming, structured tool_use, embeddings | $$$/token | **Last resort.** Only when a human is actively waiting for an answer: MCP tool responses, Slack queries, voice conversations, interactive governance. Embeddings (OpenAI) have no free alternative and stay here. |

### The Aggregation Rule

**Never call an LLM per-item when you can aggregate.** Examples:
- 200 emails/day → Python extracts + classifies → **1 CLI call** for daily summary → 1 capture
- 50 Amazon purchases/month → Python parses order data → **1 CLI call** for monthly analysis → 1 capture
- 30 financial transactions/day → Python computes deltas → **1 CLI call** for daily briefing → 1 capture

The pattern: **collect → extract (T0) → classify (T0/T1) → aggregate → synthesize (T2) → store as capture**

### Two-Track Pipeline

High-volume batch sources (email, financial, purchases) use a different processing track than real-time captures:

```
Track A (real-time): Voice, Slack, manual captures, MCP
  → Full pipeline (embed + extract entities + wiki-ingest)
  → API for entity extraction (user expects fast response)

Track B (batch): Email, financial data, documents, scraping
  → Python extraction + rule-based classification (T0)
  → Local LLM for ambiguous items (T1)
  → Aggregate into daily/weekly summary captures
  → Claude CLI for synthesis reports (T2, subscription-covered)
  → Only synthesis output enters full pipeline as a capture
```

### When Building New Features — Checklist

Before writing any code that calls an LLM, answer these questions:

1. **Can Python do this without an LLM?** (parsing, regex, lookup, math, API calls) → Do it in Python.
2. **Is the LLM task simple classification with short input?** → Try local LLM first (T1).
3. **Is this a batch/async task?** → Use Claude Code CLI (T2, subscription-covered).
4. **Is a human actively waiting for this response?** → OK to use API (T3).
5. **Am I calling the LLM per-item?** → Stop. Aggregate first, then one LLM call for the batch.

### Cost Targets

| Component | Monthly Budget |
|-----------|---------------|
| Claude Max subscription | $100-200 (fixed, covers Claude Code CLI) |
| Anthropic API (T3 only) | < $10 (real-time queries only) |
| OpenAI API (embeddings) | < $10 (no free alternative) |
| Deepgram (voice) | < $5 |
| External APIs (Plaid, etc.) | < $10 |
| **Total beyond subscription** | **< $35/month** |

---

## What This Is

Self-hosted personal AI knowledge infrastructure. Ingests from voice memos, Slack, documents, email (brain@troy-davis.com via Cloudflare Email Worker); stores in Postgres+pgvector; provides semantic search, AI synthesis, weekly briefs, and governance sessions.

**Status**: v1.5.0 — All 25 phases + Phase 7 consolidation + email pipeline + web synthesis + proactive intelligence + cognitive memory (Hebbian learning, spreading activation, memory consolidation). 1,569 unit tests + 95 regression tests passing. Deployed to homeserver.

## Key Architecture Decisions

- **Runtime**: TypeScript, Hono framework, Drizzle ORM
- **Database**: Postgres 16 + pgvector (pgvector/pgvector:pg16 image, no Supabase)
- **LLM Provider**: OpenAI API (api.openai.com/v1) for ALL AI requests — both embeddings and LLM inference. No local LLM dependency. API key in Bitwarden (`open-brain-openai-api-key`), passed via `OPENAI_API_KEY` env var.
- **Embeddings**: OpenAI `text-embedding-3-large` with `dimensions: 768` API parameter. The API handles dimension reduction via trained MRL (not naive truncation). NO fallback — queue and retry if API is down.
- **LLM Inference**: Model aliases fast, synthesis, governance, intent — all `gpt-5.4` (configured in `config/ai-routing.yaml`). Uses `max_completion_tokens` (not `max_tokens`).
- **Schema**: `vector(768)` everywhere. Do not use 1536.
- **Search**: Hybrid retrieval (FTS + vector with RRF) + ACT-R temporal decay scoring + Hebbian association boost + spreading activation (entity graph traversal via `include_related`). Default temporal_weight: 0.0 (cold start), ramp up as search history builds.
- **MCP Auth**: Authorization: Bearer header (not URL query parameter)
- **Phases**: 16 phases + cognitive memory complete (see IMPLEMENTATION_PLAN.md, IMPLEMENTATION_PLAN-PHASE2.md, IMPLEMENT_IMPROVED_MEMORY.md)
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
