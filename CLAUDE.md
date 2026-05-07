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
- Healthchecks use `127.0.0.1`, not `localhost` — Alpine resolves to IPv6; wget fails silently. Affects core-api, voice-capture, web-next.
- Docker Compose `ports` in override files are appended, not replaced. Set correct ports in `docker-compose.yml` directly.
- voice-capture entry is `dist/server.js` (builds from `server.ts`).
- `postgresql.conf` must set `listen_addresses = '*'` — default blocks container-to-container.
- Node 22 LTS base images (`Dockerfile` and `packages/web-next/Dockerfile` = `node:22-alpine`). CI matches (`engines: >=22`).
- **No auto-migration on startup** — after Postgres volume recreation, manually apply `scripts/init-schema.sql` + all `packages/shared/drizzle/0*.sql`. Check `\dt` in psql first.
- `CREATE TRIGGER` is not idempotent — always `DROP TRIGGER IF EXISTS <name> ON <table>` before `CREATE TRIGGER`. Affects `scripts/init-schema.sql`.
- core-api Docker image ships `postgresql-client` (for P04a pg_dump). Tests can set `ADMIN_RESET_SKIP_PGDUMP=true`; never in production compose.
- **All 13 compose services log to Loki via Docker `loki` log driver (P11a).** Driver URL parameterized by `LOKI_URL` in `.env` (default: `http://homeserver.k4jda.net:3100/loki/api/v1/push`). If Loki is unreachable, Docker falls back to `none` driver — log lines are dropped (not buffered). Plugin must be pre-installed once on the Docker host: `docker plugin install grafana/loki-docker-driver:latest --alias loki --grant-all-permissions`. `logging:` changes require `--force-recreate` to take effect (restart is not enough). Use Grafana Loki explorer with `{container_name="open-brain-<svc>"}` for cross-container log search.

**Internal HTTP callers (rate-limit) — P07**
- **Every internal service calling core-api MUST set `X-Open-Brain-Caller: <name>` AND have `internal:<name>` in `BYPASS_CALLERS`** (`packages/core-api/src/middleware/rate-limit.ts`). Missing either side = silent 429s under burst load. Current 17 bypass entries: `integration-test`, `web-ui`, `email-worker`, `financial-pipeline`, `utility-pipeline`, `ingest`, `slack-bot`, `voice-capture`, `memory-consolidation`, `workers`, `email-classify`, `email-compose-skill`, `batch-wiki-ingest`, `email-pipeline`, `ingest-onedrive`, `ingest-repair`, `newsletter-pipeline`. **`mobile-app` removed in Phase 6 (R8) — mobile clients authenticate via Bearer token (mobile-auth middleware) and are rate-limited via the `mobile` tier (200 req/min per token hash), not bypass.**
- **slack-bot `CoreApiClient.request()`** is the single choke point for all slack-bot → core-api calls — set `X-Open-Brain-Caller` once there, spread `...options.headers` AFTER the default so test helpers can still override (e.g., to `integration-test`).
- **Worker skills use `'workers'` as the shared caller value** (same container, simpler bypass entry) except `memory-consolidation` which keeps its own name (named in the arch review — finer observability for the destructive skill).
- **Next.js proxy audit rule:** `packages/web-next/proxy.ts` (Next.js 16 renamed `middleware` → `proxy`; legacy `middleware.ts`/`middleware()` still works but is deprecated) is the public boundary that overwrites `X-Open-Brain-Caller` to `web-next-public` for all `/api/*` requests proxied to core-api (R2, ADR-0001). Any change to `packages/web-next/next.config.ts` rewrites OR `proxy.ts` must preserve this overwrite — `next.config.ts` `rewrites()` and `headers()` cannot set request headers upstream; the proxy/middleware function is the only mechanism. If a new rewrite path proxies to core-api outside `/api/*`, the `config.matcher` must be widened to cover it. Defense-in-depth in `rate-limit.ts` (2026-05 Phase 2.3): `getClientKey()` calls `isInternalIp()` on the source IP and ignores `X-Open-Brain-Caller` for non-RFC1918/non-CGNAT/non-loopback origins — so even if the proxy.ts overwrite is bypassed, public callers cannot claim internal-bypass identity.

**BullMQ scheduler + concurrency — P06 + P07**
- **Scheduler slot registry — ALL windows.** Before adding a new cron to `packages/workers/src/scheduler.ts`, grep for the exact cron string. Current slots: Sunday `0 3` storage-audit / `30 3` prune-associations / `0 4` memory-consolidation / `0 5` wiki-lint. Weekday morning cluster (06:00–07:15): `0 6` wiki-synthesis, `10 6` daily-connections, `20 6` cost-analysis, `30 6` morning-brief (weekdays), `45 6` capture-reminder-morning (weekdays), `0 7` budget-check, `15 7` drift-monitor. **No two repeatable jobs on same minute.**
- **BullMQ concurrency default = 2 per worker.** Override to 1 only for documented singletons with inline reason: `budget-check`, `daily-sweep`, `skill-execution` (LLM-heavy), `prune-associations`, `wiki-ingest` (git serialization). Never exceed 2 without benchmark justification.
- **When changing cron schedules, grep the OLD cron string across the entire file before committing** — JSDoc block at top of `registerScheduledJobs` and the actual `const xxxCron = ...` declaration can drift. P07 cycle-1 reviewer caught `costAnalysisCron = '10 7 * * *'` left behind while JSDoc already said `20 6 * * *`. Pattern: `grep -n '10 7 \* \* \*' scheduler.ts` → zero hits expected after rename.

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
- **`hybrid_search()` LIMIT push-down (P13 / migration 0027):** Both `fts_ranked` and `vector_ranked` CTEs use `LIMIT match_count * 4` to bound HNSW traversal and FTS scan. Without the LIMIT, Postgres materializes all embedded captures (O(N) at scale). The overquery factor 4 gives the RRF fusion step enough candidates while keeping HNSW early-stop active. Do NOT remove or increase these LIMITs without a benchmark justification.
- **`hnsw.ef_search` per-query SET LOCAL (P13):** `SearchService` issues `SET LOCAL hnsw.ef_search = N` before every `hybrid_search()` call (hybrid/vector mode only; FTS path is exempt — no HNSW). Value injected from `config/pipeline.yaml` `search.hnsw_ef_search` (default 60). Calibration: run `scripts/benchmark-search.mjs`; see LAB_NOTEBOOK Entry 108. Tuning range: 40–100.
- **`search.hnsw_ef_search` in `config/pipeline.yaml`** (`PipelineConfigSchema.search.hnsw_ef_search`, zod: `int().min(1).max(1000).default(60)`) controls the HNSW scan depth. Read at startup in `index.ts`: `configService.get('pipeline').search?.hnsw_ef_search ?? 60`. Third constructor arg of `SearchService`. Do NOT hardcode ef_search values in application code — always read from config.
- **`captures.source` has 9 valid values:** `slack`, `voice`, `api`, `document`, `mcp`, `email`, `file`, `consolidation`, `system`. Canonical TS union: `CaptureSource` (`packages/shared/src/types/capture.ts`). Zod: `CAPTURE_SOURCES`. DB CHECK: migration 0022. Semantics: `file` = document-router file refs, `consolidation` = memory-consolidation dedup, `system` = internal events (e.g., bet resolution). **Adding a source → update all four surfaces in lockstep.**
- **`captures.capture_type` has 8 valid values:** `decision`, `idea`, `observation`, `task`, `win`, `blocker`, `question`, `reflection`. Canonical TS union: `CaptureType` (`packages/shared/src/types/capture.ts`). Zod: `CAPTURE_TYPES`. DB CHECK: migration 0024. **Adding a type → update all four surfaces in lockstep.**
- **`captures.pipeline_status` has 8 valid values:** `pending`, `processing`, `extracted`, `embedded`, `chunked`, `complete`, `failed`, `deleted`. Canonical TS union: `PipelineStatus` (`packages/shared/src/types/capture.ts`). Zod: `PIPELINE_STATUSES`. DB CHECK: migration 0024. **Adding a status → update all four surfaces in lockstep.**
- **`pipeline_events.stage` has 11 valid values:** `classify`, `check_triggers`, `document-chunk`, `document-embed`, `document-parse`, `embed`, `extract`, `extract_entities`, `link_entities`, `notify`, `received`. Canonical TS union: `PipelineEventStage` (`packages/shared/src/types/pipeline-event.ts`). DB CHECK: migration 0025. **Adding a stage → update both surfaces in lockstep.**
- **`pipeline_events.status` has 3 valid values:** `started`, `success`, `failed`. Canonical TS union: `PipelineEventStatus` (`packages/shared/src/types/pipeline-event.ts`). DB CHECK: migration 0025. **Adding a status → update both surfaces in lockstep.**
- **`sessions.session_type` has 3 valid values:** `governance`, `review`, `planning`. Canonical TS union: `SessionType` (`packages/shared/src/types/session.ts`). DB CHECK: migration 0026. Route validator: `VALID_TYPES` array in `packages/core-api/src/routes/sessions.ts`. **Adding a value → update all three in lockstep.**
- **`sessions.status` has 4 valid values:** `active`, `paused`, `complete`, `abandoned`. Canonical TS union: `SessionStatus` (`packages/shared/src/types/session.ts`). DB CHECK: migration 0026. Route validator: `VALID_STATUSES` array in `packages/core-api/src/routes/sessions.ts`. **Adding a value → update all three in lockstep.**
- **`Board.tsx` declares its own local `SessionType = 'quick_check' | 'quarterly'` and `SessionStatus = 'active' | 'complete' | 'paused'`.** These are Board UI types, not API types. The Board maps UI types to API types before calling the API (e.g., `quick_check` → `governance`). Do NOT assert parity between Board.tsx types and the shared canonical types.
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

**Cognitive memory / scheduler**
- **Scheduler Sunday slot registry (P06):** Before adding a new cron schedule to `packages/workers/src/scheduler.ts`, grep for the exact cron string — Postgres-style timing clashes produce silent overlaps. Current Sunday slots: `0 3 * * 0` storage-audit, `30 3 * * 0` prune-associations, `0 4 * * 0` memory-consolidation, `0 5 * * 0` wiki-lint. P06 card specified `0 3` but that slot was taken; implementer shifted to `30 3` (still staggered before consolidation). Same pattern applies to other cron slots: always audit before adding.
- **Batch-UPSERT invariant (P06):** `upsertCoAccessAssociations` in `packages/workers/src/jobs/update-access-stats.ts` uses EXACTLY 1 `db.execute(sql\`INSERT INTO capture_associations ... VALUES ${valuesClause} ON CONFLICT ... DO UPDATE\`)` call regardless of pair count. Serial per-pair `db.insert().values().onConflictDoUpdate()` calls are prohibited — 45 pairs × 45 round-trips is the original performance cliff. Weight formula preserved in ON CONFLICT: `(co_access_count + 1) * exp(-0.005 * EXTRACT(EPOCH FROM (EXCLUDED.last_co_access - capture_associations.last_co_access)) / 3600.0)`.
- **Cross-package queue instantiation (P06):** `core-api` does NOT import from `@open-brain/workers`. For queues shared across both packages (e.g., `access-stats`), `core-api` instantiates its own `new Queue<InlineType>('queue-name', { connection })` with the same name string — Redis routes by name, not by factory. Job payload type is inlined in the consumer file (e.g., `Queue<{captureIds: string[]; accessedAt: string}>`). Don't add a shared-package export just for queue types; the inline shape is small and localized.
- **Access-stats producer (P06):** HTTP search (`packages/core-api/src/routes/search.ts`, 4 sub-paths) + MCP search (`packages/core-api/src/mcp/tools/search-brain.ts`, 1 site) enqueue `access-stats` jobs on every search with `results.length >= 1`, sliced to top-10 per D26. Fire-and-forget: `.catch(err => logger.debug({err}, '...'))` — surfaces Redis issues without blocking response. Do NOT await the enqueue; do NOT consolidate to a shared helper (5 sites, all near their `return`, traceability over DRY).

**Pipeline / workers / skills**
- Entity resolver lives in `workers/src/lib/entity-resolver.ts`, shared by `extract-entities.ts` + `link-entities.ts`. Indexed SQL, not in-memory.
- Shared utilities in `@open-brain/shared`: `createLogger`/`logger`, `createLiteLLMClient`, `PushoverService`, `assertOk`/`HttpError`, `TemplateCache`, `model-resolver`. Do NOT duplicate in consumer packages.
- `TemplateCache.render()` replaces `loadPromptTemplate()` on hot paths. Old functions kept only for back-compat.
- `daily-sweep-skill` (8pm, LLM evening summary) is distinct from `daily-sweep` (3am stale-capture re-queuer). Different BullMQ queues/jobs.
- Pipeline-health runs every 6h (`cron: 0 */6 * * *`). Capture-flow check alerts if no captures in 6h during active hours (7am–midnight), suppressed 24h if already sent (queries `skills_log`). Parses `REDIS_URL` (not `REDIS_HOST`, which isn't set in Docker) for internal Queue instances.
- Auto-response handler is async fire-and-forget (`.then()/.catch()`) — never blocks capture/query/command. Autonomy level cached 5 min.
- Autonomy levels (`app_settings.autonomy_level`): `observe` (default, notifications only) / `assist` (draft + notify) / `advise` (act + report) / `partner` (autonomous). Check via `meetsAutonomyLevel(current, required)` from shared — pure sync ordinal comparison. Level fetched from `GET /api/v1/settings/autonomy_level` with a 5-min in-process module-level cache per package (slack-bot: `server.ts`, workers: `base-skill.ts`). Default on error: `observe`.
- **BaseSkill autonomy gate (P05):** `BaseSkill.execute()` checks `static minimum_autonomy` before delegating to `protected abstract run()`. Current level below declared minimum → `execute()` returns `{ status: 'gated', durationMs: 0 }` and logs at INFO. Skills without `static minimum_autonomy` run ungated — reactive pipeline skills (wiki-ingest, extract-entities, stale-captures, etc.) must never declare it. **Never override `execute()` in subclasses — implement `run()`.**
- **Proactive skills autonomy table (P05):**

| Skill | minimum_autonomy | Rationale |
|-------|-----------------|-----------|
| `email-compose` | `advise` | Auto-send email — highest-impact action |
| `memory-consolidation` | `assist` | Merges + soft-deletes captures destructively |
| `daily-sweep-skill` | `assist` | Proactive LLM summary + Pushover delivery |
| `weekly-brief` | `observe` | Informational report — safe at all levels |
| slack-bot `auto-response` | (inline check, not BaseSkill) | Event handler, not a queued skill |
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
- **`scripts/backup.sh` MUST NEVER copy `.env.secrets` (or any file with live credentials) into the backup payload.** Secrets live in Bitwarden — post-restore rebuild via `scripts/load-secrets.sh` or manual `bws secret get` loop per `deploy/.env.secrets.template`. Regression guard: `scripts/test-backup-secrets-redaction.sh` (P04b) — greps ephemeral backup tree for known secret variable names, exits 1 on any match.
- `scripts/backup.sh` honors `BACKUP_ROOT` and `APP_DIR` env overrides (P04b added, matches existing `WIKI_REPO_URL` precedent). Homeserver cron uses defaults; overrides are for test harnesses. When adding similarly test-gated shell scripts, use the `${VAR:-default}` pattern, not hard assignments.
- **Round-trip invariant (P08):** `scripts/backup.sh` strips `.env.secrets`, `scripts/load-secrets.sh` rebuilds it from BWS, `scripts/verify-secrets.sh` audits drift between BWS and the on-disk file. SHA256 mismatch (`load-secrets.sh --verify-hash`, exit 4) fires Pushover via `scripts/lib/pushover-notify.sh` (pure curl — works on a fresh box without Node). Regression guard: `scripts/test-secrets-roundtrip.sh` — 5-case fixture with mock-bws + python3 Pushover sink; exits 0 on full pass.
- **3-step lockstep for adding a new secret (P08):** any new secret in BWS must be added in the same commit to (1) `deploy/.env.secrets.template` (operator-facing inventory), (2) `scripts/lib/secrets-map.sh` (machine-readable BWS-name → ENV-var map consumed by `load-secrets.sh` + `verify-secrets.sh`), (3) the consumer code/config that reads the env var. Skipping step 2 means `load-secrets.sh` silently misses the new secret on the next reconcile — `.env.secrets` will be written without it, services start without it, failure mode is opaque. The mapping table is the single source of truth.
- **Operator runbook (P08):** after homeserver rebuild, `export BWS_ACCESS_TOKEN=...; bash scripts/load-secrets.sh --target-dir /mnt/user/appdata/open-brain` is the single command to rebuild `.env.secrets`. Verify with `bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain`. The script writes mode 0600, atomic mktemp+mv, and a `.env.secrets.sha256` sidecar. Refuses to clobber an existing file without `--force`. Use `--rehash-only` after intentional manual edits to silence subsequent `--verify-hash` alerts.
- **`load-secrets.sh` JSON parser:** prefers `jq` (canonical), falls back to `python3` if `jq` is missing. Both are universally available on Unraid (nerdpack), Ubuntu (apt), Alpine (apk). Same fallback in `verify-secrets.sh`. Do NOT remove the python3 path — Windows dev environments often lack `jq`, and the fixture (`scripts/test-secrets-roundtrip.sh`) needs it to run locally.

**Front-end / web**
- **A126 RESOLVED (Phase 8b):** `packages/web` deleted. `build-and-test` CI job is now clean. `web-next` (`packages/web-next`) is the sole UI package. All new UI work goes to `web-next`.

**Testing / CI**
- Integration tests: `pnpm --filter @open-brain/core-api exec vitest run --config vitest.config.integration.ts` (not `npx`; filename word order matters).
- **Windows local integration runner:** root `pnpm test:integration` is not reliable on PowerShell as of 2026-05-06; pnpm parsed `test:integration;` as a script name and exited 0 before tests ran. Use explicit sequence locally: `docker compose -f docker-compose.test.yml up -d --wait; pnpm --filter @open-brain/core-api test:integration; docker compose -f docker-compose.test.yml down -v`. Tracked as A129 for cross-platform script cleanup.
- All test HTTP helpers send `X-Open-Brain-Caller: integration-test` header — rate limiter bypasses this key. Without it, strict tier (20 req/min) exhausts.
- **Vitest `pool: 'forks'` requires both `minForks: 1` + `maxForks: N`** on vitest 1.6 (single-arg trips Tinypool `RangeError`). Applied in core-api + workers configs with `hookTimeout/testTimeout: 30_000` — avoids Windows ioredis/bullmq races.
- Mock external service calls in tests (Pushgateway, Prometheus) — `pushMetrics()` hits `http://pushgateway:9091` which hangs on DNS in tests (5s). Always `vi.mock('../lib/push-metrics.js', ...)`.
- **Prefer `vi.fn().mockResolvedValue(x)` over `vi.fn(async () => x)`** when the mock receives later `.mockImplementation(...)` overrides. Body-form narrows `Mock` generic to zero-arg, fails `tsc --noEmit` when overrides pass 2+ args (ioredis, fetch, etc.). Pattern recurred in P03 + P04a.
- **Workers `lint` script runs `tsc --noEmit` on BOTH src AND test files — test-file TS errors ARE CI-blocking, not ambient noise.** Before declaring TS errors "pre-existing baseline," isolate via `git stash && pnpm --filter @open-brain/workers exec tsc --noEmit && git stash pop`. If errors appear only with your changes un-stashed, they're a regression you introduced. Pattern slipped through P04b + P05 initial CI; `ea9290f` was the P05 post-hoc fix. Applies to every package with a `lint` script that includes test-file typecheck.
- **`fetch` mock signatures must match `lib.dom.d.ts` `fetch(input: string | URL | Request, init?: RequestInit)`.** Test mocks that type `url` as `string` fail TS2345 at the `.mockImplementation()` boundary. Normalize inside the mock: `const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url`.
- Always commit `pnpm-lock.yaml` with any `package.json` change — CI uses `--frozen-lockfile` (`ERR_PNPM_OUTDATED_LOCKFILE` otherwise).
- Node.js `punycode` DEP0040 warning is cosmetic (vitest → jsdom → whatwg-url → tr46 → punycode, dev-only). Do not investigate.
- JSDoc can't contain `*/` (tsup --dts parses as end-of-comment). Use expanded cron forms like `0,6,12,18` instead of `*/6` inside JSDoc.
- **Workers coverage gate (Phase 4 / PR #183):** `packages/workers/vitest.config.ts` enforces `coverage: { provider: 'v8', thresholds: { lines: 78, functions: 81 } }` pinned to the floor of measured baseline (lines 78.79%, functions 81.59% as of 2026-05-07). Raise incrementally toward 80% in follow-ups — never lower. `@vitest/coverage-v8@^1.6.1` is a workers dev dep.
- **Workers integration tests run in CI as part of the existing `integration-test` job (Phase 4 / PR #183).** `.github/workflows/ci.yml` adds a `Run workers integration tests` step after the existing core-api integration step, reusing the same `docker-compose.test.yml` services and the same `TEST_POSTGRES_URL` / `TEST_REDIS_URL` env vars. The workers step inherits the existing required-status-check gate ("Integration tests (core-api + real DB)") — no separate required check, no `continue-on-error`.
- **`eslint-config-next` MUST stay at `^15.0.0` until A130 lands (ESLint 9 + flat-config migration).** Bumping to `^16.x` ships an ESLint 9 flat-config schema; loading it under our current ESLint 8 + `.eslintrc.json` setup hits `TypeError: Converting circular structure to JSON` in `@eslint/eslintrc@2.1.4`. Do NOT bump in a drive-by. Phase 3.3 of post-remediation discovered this; tracked as A130.
- **`@types/node` is pinned to `^22.0.0` across all TS packages** (Phase 3 / PR #182). Matches the Node 22 LTS runtime. Touching this in a drive-by edit risks reintroducing the Node-25-vs-Node-22 type drift the pin solves.

**Git / GitHub**
- Verify `gh auth status` before any write operation — the client can silently switch to a read-only account, causing opaque 404s on label/milestone/issue creation. Confirm active account has push/admin on target repo.
- `gh issue create --milestone` takes the milestone TITLE (not number). Quote the full title including punctuation.
- **Branch protection on main (Phase 5b, 2026-05-05):** `required_status_checks = ["Integration tests (core-api + real DB)"]` only. `enforce_admins=false` (admin escape hatch preserved for solo recovery). `strict=false` (no merge races as single user). `required_pull_request_reviews=null` (self-review adds friction, no second-eyes benefit). `build-and-test` can now be promoted to required (A126 resolved — packages/web deleted in Phase 8b). Tighten only if the system gains additional users.

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
- **Web:** `packages/web-next` (Next.js 16 + React 19 + Cloudscape + TanStack Query) — sole UI package, canonical production ingress at brain.troy-davis.com. `packages/web` deleted in Phase 8b (ADR-0001).
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
