# Integration Architect Findings

**Reviewer:** Integration Architect
**Date:** 2026-04-18
**Target:** `C:/Users/Troy Davis/dev/personal/open-brain`
**Confidence:** High

---

## Executive Summary

The system's seams are unusually disciplined for a single-operator personal-AI stack. Authentication, rate-limiting, retry/backoff, and audit logging are all present at the boundaries that matter. The five design invariants that define this system — (1) BYPASS_CALLERS is a tightly-curated allowlist, (2) cost-tiered LLM routing with same-provider-only agent fallback, (3) patient BullMQ retry with 5 hops + 2h tail, (4) HMAC-authenticated sidecar trigger, (5) Cloudflare tunnel terminates at nginx → core-api — are all honored in code.

That said, three integration-layer issues rise above the noise: **internal HTTP callers inconsistently set `X-Open-Brain-Caller`**, **Composio usage is unmetered against its 20K/month free-tier budget**, and **two skills still bypass the LLMGatewayService** (memory-consolidation has a fallback path to raw Anthropic SDK; weekly-brief's legacy fallback also exists). Several Medium items about timeout coverage, webhook idempotency on Cloudflare Email retries, and the lack of circuit-breakers on external HTTP calls round out the picture.

---

## Interface Inventory

### Exposed APIs

| Endpoint | Method | Contract Documented? | Versioned? | Auth? |
|----------|--------|---------------------|-----------|-------|
| `/api/v1/captures` | POST, GET | Zod schema in `schemas/capture.ts` | `/v1/` path | rate-limit only (single-user) |
| `/api/v1/captures/:id` | GET, PATCH, DELETE | Zod schema | `/v1/` | rate-limit |
| `/api/v1/search` | POST | Zod schema | `/v1/` | rate-limit (strict) |
| `/api/v1/synthesize` | POST | Zod schema | `/v1/` | rate-limit (strict) |
| `/api/v1/stats` | GET | typed response | `/v1/` | rate-limit |
| `/api/v1/skills/:name/trigger` | POST | typed | `/v1/` | rate-limit |
| `/api/v1/skills/:name/logs` | GET | typed | `/v1/` | rate-limit |
| `/api/v1/triggers`, `/triggers/test`, `/triggers/:id` | CRUD | typed | `/v1/` | rate-limit |
| `/api/v1/entities`, `/entities/:id`, `/entities/merge`, `/entities/:id/split` | CRUD + ops | typed | `/v1/` | rate-limit |
| `/api/v1/bets`, `/bets/:id`, `/bets/expiring` | CRUD | typed | `/v1/` | rate-limit |
| `/api/v1/sessions` (+ respond/pause/resume/complete/abandon) | CRUD | typed | `/v1/` | rate-limit |
| `/api/v1/settings/:key` (whitelisted) | GET, PUT | typed | `/v1/` | rate-limit |
| `/api/v1/admin/*` | ops | typed | `/v1/` | `ADMIN_API_KEY` Bearer + admin rate-limit (stricter) |
| `/api/v1/admin/reset-data` | POST | typed | `/v1/` | **no adminAuth** — JSON confirmation phrase + admin rate-limit only (intentional — web UI lacks token) |
| `/api/v1/events` | GET (SSE) | event types documented | `/v1/` | none (stream) |
| `/api/v1/email/drafts` (+ `/:id`, `/:id/send`) | CRUD | typed | `/v1/` | rate-limit |
| `/api/v1/ingest/upload`, `/ingest/list`, `/ingest/:id/process-now` | POST, GET | typed | `/v1/` | rate-limit |
| `/api/v1/voice-sessions` | CRUD | typed | `/v1/` | rate-limit |
| `/health`, `/api/v1/health` | GET | typed | partial | public (Docker healthcheck) |
| `/metrics` | GET | Prometheus exposition | — | public (assumes internal) |
| `/mcp` | POST (Streamable HTTP) | MCP SDK schema | embedded | `MCP_BEARER_TOKEN` Bearer (required, fail-closed) |
| voice-capture `/api/capture` | POST multipart | ad-hoc JSON | unversioned | public (iOS Shortcut contract) |
| sidecar `/process`, `/trigger/:src` | POST | ad-hoc JSON | unversioned | `X-Open-Brain-Caller: ingest` + Bearer HMAC |
| sidecar `/healthz`, `/health` | GET | typed | unversioned | public |
| email-worker (Cloudflare) | `email()` handler | postal-mime parsed | — | Cloudflare sender allowlist check |

Contract is implicit via TypeScript types. No generated `openapi.yaml` (intake confirms). Zod validation is thorough at the ingress; types flow through the monorepo via `@open-brain/shared` and the drift-guard test keeps `packages/web` in lockstep for three enums (but not `CaptureSource`, per intake).

### Consumed Integrations

| Dependency | Type | Has Timeout? | Has Retry? | Has Circuit Breaker? | Fallback? |
|------------|------|-------------|-----------|---------------------|-----------|
| OpenAI API (embeddings) | REST | 60s SDK | **BullMQ patient backoff** (5 attempts: 30s/2m/10m/30m/2h) | budget soft/hard limit | none (blocks pipeline if down) |
| OpenAI API (chat via openai_compat tiers) | REST | per-tier (5s–120s) | 3 same-tier retries for "loading" + 2-hop tier fallback | monthly budget check | tier chain (Jetson → Spark → Haiku → Sonnet) |
| Anthropic SDK (gateway path) | REST | per-tier 20s–30s | tier fallback | budget check (skipped for anthropic — subscription-covered) | chain |
| Anthropic SDK (runAgent legacy path, memory-consolidation fallback) | REST | SDK default | SDK default (2 retries) | **none** | **none** |
| DGX Spark vLLM (t1_spark) | openai_compat | 120s | same-tier loading retry + fallback to t1_fast | — | Haiku (paid) |
| Jetson llama.cpp (t1_jetson) | openai_compat | 5s | same-tier loading retry + fallback to t1_spark | — | Spark (free) |
| Ollama (t0_local, disabled) | openai_compat | 15s | loading retry | — | t1_jetson |
| Pushover | HTTP form-post | 10s `AbortSignal.timeout` | **none** (single attempt) — caller decides via `onError: 'throw' \| 'swallow'` | none | credentials-missing → silent skip |
| Deepgram (voice-pipecat only) | Pipecat stub | Pipecat default | Pipecat default | none | — |
| Composio MCP | Streamable HTTP | 60s | **none** (single attempt, returns null) | **no usage metering** | caller skips gracefully |
| Gitea (wiki) | simple-git over HTTPS | none explicit | simple-git default | none | clone-pulls serialized by queue concurrency=1 |
| Gmail (direct REST via googleapis stub) | REST via fetch | none explicit | **429 respects Retry-After** (hotmail-client pattern; gmail-client has GmailApiError for caller) | none | — |
| Microsoft Graph (direct REST) | REST | default | **429 respects Retry-After**, attempt-counted | none | — |
| Himalaya CLI (weekly-brief outbound email) | subprocess | process default | none | none | nodemailer → Pushover fallback chain |
| Slack Web API (SlackMessenger) | REST | `SLACK_TIMEOUT_MS` | none | none | caller logs + continues |
| Slack Bolt Socket Mode (inbound) | WebSocket | Bolt default | Bolt auto-reconnect | Bolt-managed | Socket Mode recovers after disconnect |
| Core API (from slack-bot, voice-capture, email-worker, sidecar pipelines) | REST | 15s (voice) / none (slack-bot, email-worker) | voice: 3 retries exponential; others: none | none | — |
| Ingest sidecar (trigger_server) | REST | 300s | BullMQ `ingest-process` 5-attempt custom backoff | sidecar `ProcessLock` serializes per container | — |
| Postgres (pgvector) | pg / drizzle | 3s connect for healthcheck | pg-notify: exponential backoff 1s→30s, 5 attempts | none | — |
| Redis (BullMQ) | ioredis | 3s connect | ioredis reconnection default | none | queue work stalls |
| Cloudflare Tunnel | cloudflared daemon | daemon | daemon | daemon | (if tunnel down, whole public surface down) |

---

## Contract Fidelity Assessment

- **MCP tool schemas** are declared via `server.registerTool()` calls in `packages/core-api/src/mcp/tools/`; Zod input schemas are enforced on invocation. 8 tools, 1 resource (`open_brain://context`). Response contracts match TDD §13.
- **Capture create response** (`{id, pipeline_status, created_at}`) is documented in CLAUDE.md and matches the POST handler (captures.ts:36). Slack bot's `CoreApiClient.captures_create` also assumes this shape.
- **Search API contract** (`{results: [{capture, score}]}`) is uniformly mapped by CoreApiClient (`search_query`) and web's search page — matches the CLAUDE.md note that the API returns `results` not `captures`.
- **Voice-capture `/api/capture`** contract (`file` multipart field, optional `latitude/longitude/location_name/location_accuracy`) is documented in a comment block on server.ts:40-50, matching the iOS Shortcut contract.
- **Email-worker contract** (POST to `/api/v1/captures` with `source: 'email'`, shaped `source_metadata`) matches captures' Zod schema and the source enum's `email` value.
- **No contract testing** (no Pact, no consumer tests). Given single-operator scope this is acceptable, but it means silent schema drift in `@open-brain/shared` types is caught only by the drift-guard test (which covers 2 enums, not Capture).

---

## Resilience Pattern Coverage

| Integration | Timeout | Retry | Circuit Breaker | Bulkhead | Fallback | Assessment |
|-------------|---------|-------|----------------|----------|----------|------------|
| Pipeline stages (capture-pipeline, embed, extract-entities) | N/A (BullMQ owns) | 5 attempts custom backoff 30s/2m/10m/30m/2h | daily-sweep re-enqueues stuck captures | BullMQ concurrency limits | pipeline stages are idempotent via content_hash | **Excellent** |
| OpenAI embeddings | 60s + adaptive truncation 16K→2K chars | 5 BullMQ attempts | budget check | none | none | **Good** — no fallback model, but queue absorbs outages |
| OpenAI chat (openai_compat tiers) | per-tier 5s–120s | loading retry + 2-hop fallback | budget (post-resolved) | per-tier OpenAI client pool | chain to Haiku → Sonnet | **Excellent** |
| Anthropic (gateway path) | per-tier 20s/30s | tier fallback, same-provider | budget (skipped — subscription) | SDK defaults | chain | **Good** — but anthropic subscription isn't actually "free"; Anthropic API bills per-token regardless (see Risk Register) |
| Anthropic (runAgent direct via resolveAgentClient) | per-tier 20s/30s | 1 fallback-swap-per-iteration on transient | none at loop level | SDK defaults | same-provider chain | **Good** — but not all skills use the gateway path (memory-consolidation falls back to raw SDK; see H-1) |
| MCP server | N/A (each request is stateless per `sessionIdGenerator: undefined`) | N/A | N/A | per-request McpServer instance | — | **Good** — stateless is correct for Hono; no session-bleed risk |
| Slack Bolt Socket Mode | Bolt-managed | Bolt auto-reconnect | — | — | — | **Good** — Bolt handles disconnect |
| Slack outbound (SlackMessenger) | `SLACK_TIMEOUT_MS` | none | — | — | log + continue | **Weak** — no retry on 429/500; relies on caller |
| Pushover | 10s | none (single attempt) | — | — | swallow/throw mode | **Weak** — `onError: throw` hands retry to BullMQ (OK); `onError: swallow` drops failures silently |
| Composio MCP | 60s | none | **no budget cap enforced** | — | null on failure | **Critical gap** — see H-2 |
| Voice-capture → Core API | 15s | 3 retries, exponential 1s/2s/4s; 4xx skip retry | none | — | — | **Good** |
| Cloudflare Email Worker → Core API | implicit fetch default | **Cloudflare retries `message.setReject` rejections**, but success path is fire-once | Cloudflare frontend budget | — | `message.setReject` triggers sender-side retry (not our API) | **Medium** — see M-1 |
| Sidecar trigger HTTP | 300s subprocess cap | BullMQ `ingest-process` 5 attempts patient | sidecar `/tmp/process.lock` serializes | per-source sidecar container | — | **Excellent** |
| Gitea wiki git ops | none | simple-git default (internal) | none | workers concurrency=1 | — | **Weak** — if Gitea is down and `git pull` blocks indefinitely, wiki-ingest can stall. See M-4 |
| pg-notify (SSE backbone) | N/A | automatic exponential reconnect 1s→30s, 5 attempts + LISTEN re-register | — | — | — | **Excellent** (recently added, per CLAUDE.md) |

No Opossum or resilience4j-style circuit breakers anywhere. For a single-user system this is acceptable: **the system's "circuit breaker" is the BullMQ retry window + budget hard-limit + operator monitoring via Pushover alerts**. Outbound calls that fail fast and surface to an operator are more valuable than a dedicated CB library.

---

## Idempotency Audit

State-mutating ingress surfaces and their idempotency story:

| Endpoint | Idempotency Key | Strategy | Status |
|----------|----------------|----------|--------|
| `POST /api/v1/captures` | `content_hash` (sha256 of content) | 60s dedup window + DB `UNIQUE(content_hash)` | **Good** — double-submit returns 409 Conflict |
| `POST /api/v1/documents` | `content_hash` on `"[Document] {title}"` | same | **Watch** — hash is on title string not file bytes (per CLAUDE.md); intentional, but surprising |
| Email worker → `POST /captures` | content_hash fired by core-api | if sender retransmits, Cloudflare retries the worker; deduped by hash + 60s | **Good** (accidental but correct) |
| Voice-capture → `POST /captures` | content_hash on transcription text | deduped by hash | **Good** |
| BullMQ job dedup | `jobId` (e.g., `embed_${captureId}`) | BullMQ deduplicates by jobId | **Good** — flow definition uses per-capture jobIds |
| Capture-associations insert (Hebbian) | canonical pair ordering `a<b` + `ON CONFLICT DO UPDATE` | **Good** — explicit canonical order is enforced (CLAUDE.md rule) |
| Memory-consolidation merge | tracks `original_capture_ids` in source_metadata | soft-delete with `deleted_at` enables recovery | **Good** |
| MCP tool calls | none | stateless per-request | **Acceptable** — MCP clients retry at their own layer |
| Sidecar `/process` | `/tmp/process.lock` | single-slot; rejects with 409 Busy | **Good** |
| Pushover notification | none | Pushover itself may dedupe within 60s window (their design), but we don't set a unique key | **Low risk** — intentional; over-notify is better than miss |

**Overall: strong.** Idempotency is the strongest single integration pattern in this codebase.

---

## Versioning and Evolution Assessment

- **API prefix** is `/api/v1/*`. No `/v2/` rollout mechanism (e.g., version-based routing, Accept-Version header). Would need to either duplicate routes under `/api/v2/` or add a version middleware.
- **Database migrations** via Drizzle (`packages/shared/drizzle/0001.sql`–`0021.sql` per MEMORY.md). Manual application after volume recreation (CLAUDE.md). No auto-migration.
- **`@open-brain/shared` ABI drift** is governed by:
  - drift-guard test on `packages/web` (covers 2 enums, **not** `CaptureSource`)
  - monorepo build order (shared built before dependents)
  - no semantic versioning between packages (they all move together)
- **Model-alias drift** is resolved by the `model-resolver` helper (PR #98) — any code calling OpenAI resolves `gpt-5.4` aliases before dispatch. This closed a real cross-service versioning risk.
- **MCP protocol version** is hardcoded to `'2024-11-05'` in ComposioClient; core-api MCP uses SDK-default negotiation. No migration plan if Composio upgrades its MCP protocol version.
- **AI-routing.yaml** is a versioned config file (`v3` per comment); it can be hot-reloaded via admin route. Tier additions (e.g., t1_spark added mid-April after cost incident) were handled via config PR + restart, not runtime swap.

---

## Integration Observability

- **Request logging:** Hono's `logger()` middleware logs every request; nginx logs the external hop. MCP requests additionally land in `mcp_activity` table via `McpActivityLogger` (fire-and-forget, activity-logger.ts).
- **AI call audit log:** every LLM call (gateway path) writes a row to `ai_audit_log` with task_type, model, tokens, duration, cost_usd, client_used, capture_id/session_id, and **error message on failure**. This is stronger than typical — the audit log doubles as operational traces.
- **Prometheus metrics:** core-api exposes `/metrics`; metricsMiddleware() wraps requests. workers push metrics to Pushgateway (`pushpushover → LabNotebook`).
- **SSE events** (`/api/v1/events`): pg-notify-backed real-time stream with automatic reconnect. nginx disables proxy_buffering for this location.
- **Skill run log:** `skills_log` table captures every skill execution (BaseSkill.logResult); `result` JSONB carries structured output, `output_summary` is truncated preview.
- **Gaps:**
  - No distributed tracing header propagation (no X-Request-Id or W3C traceparent). `trace_id` is set on captures' source_metadata for pipeline correlation, but doesn't propagate to external services (Composio, OpenAI, Anthropic).
  - No latency/error histograms segmented **by external dependency** in the metrics route (can't say "OpenAI p99 = X" from current metrics).
  - Composio call volume is not instrumented against the 20K/mo free-tier budget (see H-2).
  - Tier-fallback events are logged but not counted as a metric — hard to detect "t1_jetson is failing over to t1_spark too often" from dashboards.

---

## Dependency Risk Register

| Dependency | Failure Impact | No Mitigation? | Risk Level |
|------------|---------------|----------------|------------|
| Cloudflare Tunnel | Entire public surface (brain.troy-davis.com, MCP) goes dark | no redundancy, no second tunnel | **Medium** (operator-only access via Tailscale is still viable) |
| OpenAI embeddings API | Pipeline backs up (BullMQ queue grows); no degraded mode | 5-attempt backoff absorbs ~3h of outage before jobs fail; daily-sweep re-queues | **Low** (by design — no fallback, queue and retry) |
| OpenAI chat inference | Falls back to Jetson → Spark → Haiku → Sonnet per ai-routing.yaml | tier fallback chain is robust | **Low** |
| Anthropic API (for t1_fast Haiku / t2_quality Sonnet) | Final hop of the fallback chain; if down, quality-critical tasks fail | no further fallback; budget check won't stop hard failure | **Medium** — weekly-brief and governance could lose a week if Anthropic has an extended outage |
| Jetson (192.168.10.58) | t1_jetson classification fails; falls back to t1_spark | fallback in place | **Low** (but fragile if static IP changes — see the 2026-04-15 cost incident) |
| DGX Spark (spark.k4jda.net:8000) | t1_spark (the workhorse of routine tasks) fails; falls back to Haiku (**paid**) | tier fallback works, but cost-wise this is the failure mode that drove the $100 cost incident | **Medium** — the entire cost-tiering strategy pivots on Spark being up. Monitor its uptime as a first-class SLO. |
| Composio MCP | Morning-brief calendar section missing; other integrations degrade to empty | client returns null on failure; caller handles gracefully | **Medium** — graceful degradation, but no budget visibility (see H-2) |
| Gitea wiki | wiki-ingest stalls; pipeline can continue without wiki (removeDependencyOnFailure) | good | **Low** |
| Deepgram | voice-pipecat fails to transcribe; voice-capture (iOS Shortcut path) uses faster-whisper instead | `/api/capture` via faster-whisper is independent | **Low** — there are two voice paths |
| Pushover | Notifications silently dropped (swallow mode) or job retried (throw mode) | — | **Low** |
| Tailscale network | Bond/Jetson/Spark all unreachable → full LLM fallback to Anthropic | no fallback; will spike costs | **Medium** — same failure mode as Spark-down |
| Homeserver Postgres volume loss | 25 migrations required; no auto-migration | documented, but a full recovery exercise has not been drilled recently | **Medium** — operational risk, not code risk |

---

## Findings by Severity

### Critical

_None._ All hard-gate boundaries (auth on MCP, admin auth, HMAC on sidecar) are fail-closed; embedding loss queues cleanly; budget hard-limit is enforced before every paid-tier call.

### High

**H-1. Memory-consolidation skill has a fallback path to raw Anthropic SDK, bypassing gateway budget + audit.**
Location: `packages/workers/src/skills/memory-consolidation.ts:348-390`.
The gateway path is preferred (line 349), but the legacy Anthropic/OpenAI fallbacks (lines 359–389) still exist. If `this.llmGateway` is unset in some wiring path, the skill calls `callClaude(this.anthropicClient, …)` or raw OpenAI SDK directly — neither writes to `ai_audit_log`, neither checks budget, neither supports tier fallback.
Why it matters: the 2026-04-15 cost incident showed that every non-gateway path is a blind spot. Intake already lists this as a known follow-up. Recommend removing the legacy branches and making `llmGateway` a required constructor dependency; throw at construction if missing.

**H-2. Composio MCP client has no usage metering against the 20K/month free-tier quota.**
Location: `packages/shared/src/services/composio-client.ts` + `packages/workers/src/skills/morning-brief.ts:406-408`.
The client has no counter, no budget gate, no alerts. `morning-brief` runs daily; each run calls `fetchCalendarEvents` → likely 2–3 Composio tool executions per run = ~90/month. Currently safe, but if Composio usage is expanded (calendar reads, drive lookups, etc., as described in CLAUDE.md) without instrumentation, Troy won't learn he's over-quota until Composio starts rate-limiting or billing. The intake explicitly names this as a cost boundary.
Recommendation: add a per-day counter to `ComposioClient.execute()` backed by Redis (INCR `composio:calls:YYYY-MM-DD`, 31-day TTL); expose it on `/metrics` and trip a Pushover warning at 15K calls in a month.

**H-3. Internal HTTP callers inconsistently set `X-Open-Brain-Caller`, creating a two-class rate-limit story.**
Locations:
- `packages/slack-bot/src/lib/core-api-client.ts:47` — sends only `Content-Type: application/json`, no caller header.
- `packages/voice-capture/src/services/ingest.ts:58-60` — same (no caller header).
- `packages/workers/src/skills/memory-consolidation.ts:438-440` — no caller header.
- `packages/web/nginx.conf:46,73` — correctly sets `X-Open-Brain-Caller: web-ui`.
- `cloudflare/email-worker/src/index.ts:87,171` — correctly sets `X-Open-Brain-Caller: email-worker`.
- `packages/shared/src/services/ingest-router.ts:289` — correctly sets `X-Open-Brain-Caller: ingest`.
Why it matters: slack-bot, voice-capture, and consolidation POSTs land in the strict rate-limit tier as a single `default-client` bucket (or worse, share the X-Forwarded-For of their Docker bridge IP). During high activity or test runs, they can exhaust the 20-req/min strict limit and start 429ing each other. The fix is trivial (add the header in each client); the BYPASS_CALLERS pattern is already designed for this.
Recommendation: add `'X-Open-Brain-Caller': 'slack-bot'` / `'voice-capture'` / `'memory-consolidation'` in each client; add them to BYPASS_CALLERS in `rate-limit.ts`.

### Medium

**M-1. Cloudflare Email Worker → core-api has no content-level idempotency beyond content_hash; a worker retry on a 5xx response creates a duplicate conversation state.**
Location: `cloudflare/email-worker/src/index.ts:176-187`.
The worker rejects the email (`message.setReject`) only if the allowlist fetch fails or core-api returns non-2xx. Cloudflare will retry rejected messages sender-side. That means the same email can arrive twice; the second attempt will be deduped by content_hash (good), but the first attempt's `pipeline_status` may have been already updated before the retry — resulting in orphaned `pipeline_events` rows tied to two trace_ids for one real email.
Recommendation: the worker could include a stable idempotency key (e.g., the message's `Message-ID` header) in the metadata; core-api could check `source_metadata.message_id` before dedup-window + content_hash. Alternatively, accept the current minor duplication.

**M-2. No HTTP timeouts on `CoreApiClient` (slack-bot), `WikiGitService.init()`, Himalaya subprocess calls, Gmail/Graph REST calls.**
Locations:
- `packages/slack-bot/src/lib/core-api-client.ts:43` — plain `fetch(url, options)`, no `AbortSignal.timeout`.
- `packages/shared/src/services/wiki-git.ts:261,267` — `git.pull()`, `git.clone()` have no explicit timeout.
- `packages/shared/src/services/himalaya.ts` — subprocess calls (per intake).
- `packages/shared/src/services/email/gmail-client.ts:459,474` — plain fetch, no explicit AbortSignal.
Why it matters: if core-api hangs (deadlocked DB connection, slow query), slack-bot's Bolt handler blocks indefinitely. Slack requires ack() within 3s; Bolt's default timeout eventually fires, but a per-HTTP timeout is cheaper insurance.
Recommendation: standardize a 30s default timeout across all internal HTTP clients (or export a shared `fetchWithTimeout` helper from `@open-brain/shared`).

**M-3. `recordAgentCompletion` in email-compose uses fire-and-forget audit logging — if the gateway was down at audit-write time, the agent run isn't recorded at all.**
Location: `packages/workers/src/skills/email-compose.ts:366-382` and `packages/shared/src/services/llm-gateway.ts:806-843`.
The `logAudit` swallow-on-failure is correct for not breaking the success path, but it also means the budget-check's local ai_audit_log estimation could undercount agent-loop spend if Postgres had a transient hiccup during audit write. Budget is enforced at the top of `completeWithTierFallback` via `checkBudget` which queries `ai_audit_log` — an un-logged expensive agent run is invisible until the next (paid) call.
Recommendation: write the audit-log row in a BullMQ retry queue (3 attempts) rather than a plain try/catch. This is cheap insurance for expensive agent runs.

**M-4. `WikiGitService.init()` calls `git.pull('origin', 'main')` with no timeout and no circuit. If Gitea is down or slow, wiki-ingest / wiki-synthesis skills stall the BullMQ worker.**
Location: `packages/shared/src/services/wiki-git.ts:253-270`.
`removeDependencyOnFailure: true` in the flow helps — but `init()` is called at skill construction, before the flow observes a failure. A hung git clone or pull can occupy a worker indefinitely.
Recommendation: wrap `git.pull` / `git.clone` with `Promise.race` against a 60s timer. If it times out, throw a WikiGitError that BullMQ can classify as transient.

**M-5. Pushover in `'swallow'` mode drops notification failures silently; no telemetry counter.**
Location: `packages/shared/src/services/pushover.ts:121-124`.
For non-critical paths (morning-brief, pipeline-health low-priority), the default log-only behavior is fine. But a running spike of Pushover failures (network issue, API changes) would be invisible. Recommendation: add a `pushover_send_failures_total{priority=…}` Prometheus counter so Grafana can alert on sustained swallowed failures.

**M-6. MCP bearer token is checked with constant-time compare, but the same token is used for all MCP clients — there's no client differentiation.**
Location: `packages/core-api/src/mcp/auth.ts:47-53` + `packages/core-api/src/mcp/server.ts:52-56`.
The token's SHA-256 prefix is used as `clientId` for activity logging, so per-client activity is attributable only by token. If Troy hands the same token to Claude Desktop on laptop and to OpenClaw, they appear as the same `clientId`. Intake confirms that OpenClaw's `OPENCLAW_OPEN_BRAIN_TOKEN` shares the value with `MCP_API_KEY`. Not a security risk (single-operator), but it limits forensic attribution.
Recommendation: emit multiple MCP tokens (one per client) when onboarding a new MCP consumer. Keep the current env-var `MCP_BEARER_TOKEN` as a list (comma-separated) and match any.

### Low

**L-1. voice-capture `/api/capture` is un-authenticated and unversioned.**
Location: `packages/voice-capture/src/server.ts:53`.
The endpoint is exposed on port 3001 locally, and only reachable via Tailscale from iPhone (no public Cloudflare route). Not a security issue for the operator's trust boundary, but a reader will be surprised. Add a `/api/v1/capture` alias + comment justifying the lack of auth.

**L-2. Slack Bolt Socket Mode requires both `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` — the token check in `app.ts` does not assert that both are present before `new App()`.**
Location: `packages/slack-bot/src/app.ts:22`.
If either is missing, `@slack/bolt` throws at WebSocket connect time with a cryptic message. A preflight check in index.ts that fails fast with a clear error message (and mentions the Bitwarden secret names) would save time during redeploys.

**L-3. No `/version` or `/ready` endpoint distinct from `/health`.**
`/health` checks Postgres, Redis, LLM; returns 200 or 503. There's no cheap liveness probe (e.g., process is up, event loop responsive) that doesn't hit dependencies. For Docker's `start_period: 15s`, a fast probe prevents false-positive unhealthy during dependency wake-up. Intake notes `checkPostgres` uses a 3s connect timeout — if Postgres is 4s into startup, a naive healthcheck fails. Current 15s `start_period` masks this, but a distinct `/live` endpoint (just returns 200) would be cleaner.

**L-4. `/metrics` is unauthenticated and served from core-api.**
Assumed internal-only. If Cloudflare Tunnel exposes `/metrics` through nginx (it doesn't today per the tunnel config), it would be world-readable. Current design is safe, but add a comment to the tunnel.yaml + nginx.conf explicitly denying `/metrics` so future edits don't accidentally expose it.

**L-5. `MCP_API_KEY` is still accepted as a fallback env var name for `MCP_BEARER_TOKEN`.**
Location: `packages/core-api/src/mcp/auth.ts:13`.
Legacy compatibility. Intake notes OpenClaw uses `OPENCLAW_OPEN_BRAIN_TOKEN` = `MCP_API_KEY`. Not a bug — but the double env-var surface is minor tech debt. Plan a single env var name for the next operational-rules pass.

**L-6. LLM health-check probes only `/models` on OpenAI base URL — does not probe Anthropic, Jetson, or Spark.**
Location: `packages/core-api/src/routes/health.ts:68-88`.
If Spark is down but OpenAI is up, `/health` returns `healthy` while a huge swath of routine tasks is actually going to paid-tier fallback. Recommendation: extend health check to probe all configured tiers and return `degraded` if any non-critical tier is down.

### Requires Investigation

**RI-1. `LLM_SPEND_URL` environment variable is optional; when unset, budget-check relies solely on local `ai_audit_log` estimation.**
Intake confirms this. If Troy spins up an external LiteLLM proxy in the future, cost estimation could double-count (proxy + local). Flagged to verify interaction before enabling any external spend proxy.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 6 |
| Low | 6 |
| Requires Investigation | 1 |
| **Total** | **16** |

---

## Top 3 Recommendations

1. **Close the caller-header gap (H-3).** Adding `'X-Open-Brain-Caller': '<service>'` in slack-bot, voice-capture, and memory-consolidation HTTP clients, plus the matching entries in BYPASS_CALLERS, removes an accidental cross-service rate-limit interaction. Two-hour fix, eliminates a whole class of intermittent 429s.
2. **Instrument Composio usage against the 20K/month budget (H-2).** A Redis counter + Pushover warning at 15K/month prevents surprise quota hits. This is the one integration where "no visibility" meets "hard external cap" — the same failure mode that caused the 2026-04-15 cost incident on LLM tiers. The fix is generic (same pattern can extend to Pushover, Deepgram minutes, and SimpleFIN once added).
3. **Make `LLMGatewayService` a required dependency for every LLM-calling skill; remove raw-SDK fallback branches (H-1).** The gateway is the single source of truth for budget, audit log, and tier fallback. Each skill that retains a raw-SDK path is a potential blind spot. Remove the legacy paths in memory-consolidation and weekly-brief; fail fast at construction if the gateway is absent. This tightens the seam the cost-tiering strategy depends on.
