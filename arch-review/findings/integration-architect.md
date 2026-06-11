# Integration Architect Findings

**Reviewer:** Integration Architect
**Date:** 2026-06-10
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High

Confidence rationale: full source access to all nine packages, both Cloudflare workers, Python sidecars, and the operational rule base (CLAUDE.md); claims below are grounded in specific files/lines. Runtime behavior (homeserver, CF Tunnel routing, actual port exposure) was not probed live.

---

## Interface Inventory

### Exposed APIs

| Endpoint | Method | Contract Documented? | Versioned? | Auth? |
|----------|--------|---------------------|-----------|-------|
| `/api/v1/captures` (+`/:id`, `/:id/retry`) | GET/POST | TS types + CLAUDE.md prose (no OpenAPI) | v1 | None in-boundary; CF Tunnel perimeter; strict rate tier |
| `/api/v1/search`, `/api/v1/synthesize` | GET/POST | TS types + prose | v1 | None; strict tier |
| `/api/v1/documents` | POST | Prose (title-hash 409 rule) | v1 | None; strict tier |
| `/api/v1/entities`, `/bets`, `/sessions`, `/triggers`, `/briefs`, `/commitments`, `/skills`, `/settings`, `/stats`, `/wiki`, `/email/drafts`, `/insurance-policies`, `/activity`, `/intelligence` | CRUD | TS types; per-route Zod/manual validators | v1 | None; default tier |
| `/api/v1/voice-captures` | POST | Prose (D126 buffer-and-rebuild) | v1 | None; strict tier; proxies to voice-capture |
| `/api/v1/ingest/*` | POST | TS types | v1 | `INGEST_TRIGGER_SECRET` on sidecar legs |
| `/admin/reset-data` | POST | Prose (P04a two-step) | unversioned | Origin allowlist + 2-step token + phrase + admin tier (accepted design, not re-reported) |
| `/mcp` (8 tools + 1 resource) | Streamable HTTP | Tool schemas in code (`mcp/tools/*`) | implicit | Bearer (`MCP_BEARER_TOKEN`) |
| `/health`, `/metrics`, `/api/v1/system/health` | GET | Prose | mixed | Docker-internal by convention |
| voice-capture `:3001/api/capture` | POST (multipart) | Prose (field = `file`) | unversioned | **None — see M5** |
| Mobile-gated routes | GET/POST | TS types | v1 | Bearer (`MOBILE_API_KEY`), fail-closed, timing-safe — well built |
| Email ingress (brain@troy-davis.com) | SMTP via CF Email Worker | Worker source | n/a | Sender allowlist via `app_settings` |
| web-next `/api/*` proxy | all | `proxy.ts` (R2/ADR-0001) | v1 passthrough | Overwrites `X-Open-Brain-Caller: web-next-public` |

### Consumed Integrations

| Dependency | Type | Has Timeout? | Has Retry? | Has Circuit Breaker? | Fallback? |
|------------|------|-------------|-----------|---------------------|-----------|
| OpenAI (LLM via gateway) | HTTPS | Yes — per-tier `timeout_ms` (`llm-gateway.ts`) | Yes — tier fallback chain + transient retry (`run-agent.ts`) | Yes — `checkBudget()` hard-stop | Tier fallback (e.g., `t1_jetson → t1_fast → t2_quality`) |
| OpenAI (embeddings) | HTTPS | Yes — `EMBEDDING_TIMEOUT_MS` | Via BullMQ 5-attempt patient backoff | **No — bypasses budget gate (M2)** | None by design (queue + retry) |
| OpenAI (voice classification, direct client) | HTTPS | Yes — 30s / `fast` tier | No | **No — bypasses budget gate (M2)** | `CLASSIFICATION_MODEL` env override only |
| faster-whisper | HTTP (Docker) | Yes — `TRANSCRIPTION_TIMEOUT_MS` | No (caller returns 4xx/5xx to client) | No | No |
| core-api ← voice-capture (`IngestService`) | HTTP | Yes | Yes — 3× exp backoff, 4xx non-retried | No | **No dead-letter on exhaustion (M4)** |
| core-api ← slack-bot (`CoreApiClient`) | HTTP | **No (H1)** | **No (H1)** | No | No |
| core-api ← workers skills (autonomy fetch etc.) | HTTP | Yes — `AbortSignal.timeout(15_000)` everywhere | Skill-level via BullMQ | No | Default `observe` on error — good fail-safe |
| core-api ← email worker (CF) | HTTPS | No explicit (CF platform limit) | **No — `setReject` on transient failure (M3)** | No | Bounce to sender |
| core-api ← mobile app | HTTPS | **No (L2)** | No | No | UI error states |
| voice-capture ← mobile (direct `:3001`) | **Plain HTTP, LAN** | RN default | No | No | **None (M5)** |
| ingest sidecars ← workers | HTTP | Yes — `INGEST_TIMEOUT_MS` + secret | Yes — 5-attempt patient backoff, ECONNREFUSED-tolerant | No | Daily sweep re-queue |
| Composio | HTTPS | Yes — 60s AbortSignal | No | Yes — quota meter, 95% hard stop, 75% Pushover warn | Direct-API policy per CLAUDE.md |
| Slack (Socket Mode) | WSS | Bolt-managed | Bolt-managed reconnect | n/a | n/a |
| Pushover | HTTPS | 30s (queue opts) | 3× / 5s fixed (BullMQ) | No | Loss tolerated (notifications) |
| Postgres LISTEN/NOTIFY | TCP | n/a | Yes — exp backoff 1s→30s ×5, re-LISTEN | n/a | SSE resumes |
| Gitea wiki (git) | SSH/HTTP | git defaults | wiki-ingest queue concurrency 1 | No | Lint report parse falls back gracefully (verified benign) |
| Loki log driver | Docker plugin | n/a | **No — falls back to `none`, lines dropped** (documented, feeds M7) | No | None |

## Contract Fidelity Assessment

There is **no machine-readable contract** anywhere in the system: no OpenAPI/Swagger, no AsyncAPI for the 15+ BullMQ queues, no JSON Schema exports. The de facto contract is `@open-brain/shared` TS types + Zod validators + ~40 CLAUDE.md prose rules ("`GET /api/v1/search` returns `{results: [{capture, score}]}`, not a flat array").

Fidelity evidence is mixed:

- **Good:** Enum lockstep discipline is exceptional — `captures.source` (9 values), `capture_type` (8), `pipeline_status` (8), `pipeline_events.stage` (11) each enforced across TS union + Zod + DB CHECK in lockstep, with a documented pre-flight DB audit rule. The drift-guard test enforces web ↔ shared type parity. Mobile auth and rate-limit boundaries have dedicated middleware tests.
- **Drift symptoms:** `packages/slack-bot/src/lib/core-api-client.ts` performs ad-hoc consumer-side remapping — `mention_count → capture_count`, `entity_type → type`, `items → captures` — and comments like "API uses mention_count (not capture_count)" show the client adapting to drift rather than a contract preventing it (M6). slack-bot, mobile, and web-next each maintain independent hand-written type sets for the same API; only web is drift-guarded.
- **No contract tests** (Pact or equivalent) between any consumer and core-api. Integration tests hit the real API, which partially compensates for web/core, but slack-bot and mobile consumers are validated only by unit tests against their own mocks.

For a single-user system with one author this is a deliberate, defensible trade-off — but the slack-bot remapping shims are the early-warning signal that the prose-contract approach is already paying interest.

## Resilience Pattern Coverage

| Integration | Timeout | Retry | Circuit Breaker | Bulkhead | Fallback | Assessment |
|-------------|---------|-------|----------------|----------|----------|------------|
| LLM gateway → OpenAI | ✅ per-tier | ✅ transient + tier-chain | ✅ budget hard-stop | BullMQ concurrency 1–2 | ✅ tier fallback | **Strong** — best boundary in the system |
| Embeddings → OpenAI | ✅ | ✅ (BullMQ 5×, 30s→2h) | ❌ budget-blind | ✅ queue | None (by design) | Adequate; see M2 |
| Pipeline stages (BullMQ) | ✅ | ✅ 5× patient backoff + daily sweep | n/a | ✅ documented concurrency caps | re-queue | **Strong** |
| slack-bot → core-api | ❌ | ❌ | ❌ | ❌ | ❌ | **Weakest internal boundary (H1)** |
| voice-capture chain | ✅ each hop | ✅ ingest leg only | ❌ | ❌ | ❌ transcript discarded on ingest exhaustion | See M4 |
| core-api voice proxy | ❌ no AbortSignal | n/a | ❌ | strict rate tier | 502 BAD_GATEWAY | See L1 |
| Email worker → core-api | ❌ (CF platform) | ❌ (SMTP reject) | ❌ | CF isolate | bounce | See M3 |
| Mobile → core-api | ❌ | ❌ | ❌ | mobile rate tier (server) | UI errors | See L2 |
| Workers skills → core-api | ✅ 15s uniform | ✅ | ❌ | ✅ | ✅ default `observe` | **Strong** |
| Composio | ✅ 60s | ❌ | ✅ quota | n/a | policy doc | Good |
| Sidecar trigger | ✅ | ✅ 5× | ❌ | concurrency 1 | sweep | Good |
| pg-notify / SSE | n/a | ✅ exp backoff ×5 | n/a | n/a | re-LISTEN | Good |

## Idempotency Audit

Overall: **strong**. The system was clearly designed with re-entrancy in mind.

- **Captures:** content-hash dedup (60s window check + DB unique-constraint backstop catching `content_hash` violations in `capture.ts`). Email re-delivery with identical content dedups correctly. Documents dedup on title hash (`[Document] {title}` → 409) — documented and intentional.
- **BullMQ:** `jobId = pipeline_${captureId}` dedups pipeline enqueues; explicit retry deliberately busts dedup with timestamp suffix. Daily-sweep re-enqueue uses `jobId = captureId` (no-op on duplicates). All repeatable jobs use stable jobIds.
- **Hebbian associations:** canonical pair ordering (`capture_id_a < capture_id_b`) + single batch `INSERT ... ON CONFLICT DO UPDATE` — safely re-entrant.
- **Admin reset:** single-use 5-min Redis token makes the destructive step non-replayable.
- **Gaps (minor):** email worker does not use `message-id` for dedup — a re-sent email with edited content creates a second capture (acceptable: that's arguably a new capture). slack-bot `captures_create` has no retry, so its idempotency is untested in practice; if H1 is fixed by adding retries, the existing content-hash 409 will correctly absorb replays — but the client must then treat 409 as success, which it currently does not (it throws on any non-2xx).

## Versioning and Evolution Assessment

- Single `/api/v1` namespace; no `/v2`, no deprecation mechanism, no `Accept-Version`. Fine for a system whose only consumers are in the same monorepo + two CF workers — coordinated deploys substitute for versioning.
- Evolution discipline lives in CLAUDE.md "lockstep" rules (4-surface enum updates, 3-step secret addition, BYPASS_CALLERS pairing). These are process controls, not technical controls — they work because one careful operator follows them, and several rules exist precisely because they were violated once (Entry 089, P07 cycle-1).
- Dependency-side evolution: OpenAI API changes are absorbed at one choke point (`openai-client.ts` / gateway) — the `max_completion_tokens` migration shows this works. MCP SDK and Next.js 16 `middleware → proxy` rename were handled with documented audit rules.
- The mobile app is the riskiest evolution surface: it is deployed out-of-band (Expo) from the server, so a server-side response-shape change can break devices in the field with no version negotiation. With one user this is an annoyance, not an outage.

## Integration Observability

- **Inbound:** good — `http_requests_total` / duration histogram by route+method+status, captures counter by source, rate-limit logging.
- **Outbound: thin (M7).** No per-dependency latency/error metrics exist for OpenAI, faster-whisper, the voice proxy, Composio, or sidecar calls. `llm_cost_total` and `budget_spent_usd` cover spend but not availability. Boundary failures are diagnosable only via Loki logs and `pipeline_events` rows — and the documented Loki-driver failure mode (silent fallback to `none`, lines dropped) means the primary failure-diagnosis channel can itself fail silently.
- **Alerting:** solid coverage of macro health — synthetic monitor (2-consecutive-failure Pushover + recovery), pipeline-health every 6h with capture-flow check, container-health, budget-check, drift-monitor, plus 10 runbooks including `integration-alert.md`. What's missing is anything that would distinguish "OpenAI is slow" from "embed worker is wedged" without log spelunking.

## Dependency Risk Register

| Dependency | Failure Impact | No Mitigation? | Risk Level |
|------------|---------------|----------------|------------|
| OpenAI API | All embedding + inference halts; pipeline backlogs | Mitigated: 5× patient backoff + sweep; tier fallback for inference | Medium (accepted: no embedding fallback by design) |
| core-api (from slack-bot) | Slack handlers hang indefinitely; ack windows expire | **Yes — no timeout/retry** | **High** |
| core-api (from email worker) | Inbound email bounced on transient failure | **Partially — bounce notifies sender, but mail content lost** | Medium |
| voice-capture LAN exposure | Unauthenticated audio→paid-LLM endpoint on home LAN | **Yes — no auth on :3001; mobile default uses it in plaintext** | Medium (home LAN, single user) |
| Budget breaker blind spots | Runaway spend via embeddings / voice classification invisible to hard-stop | **Yes — direct clients bypass `checkBudget()`** | Medium (prior $100 incident proves the failure class is real) |
| Loki driver | All container logs silently dropped while Loki down | Documented but unmitigated (no buffering) | Medium |
| Slack Socket Mode | Bot offline; captures via other channels unaffected | Bolt auto-reconnect | Low |
| Pushover | Notification loss | 3× retry; loss tolerated | Low |
| Composio | Quota exhaustion blocks calendar/notion reads | Quota meter + hard stop | Low |
| Gitea wiki | Wiki ingest stalls; queue serialized | Queue retry; non-critical path | Low |

## Findings Detail

**H1 — slack-bot `CoreApiClient.request()` has no timeout and no retry.** `packages/slack-bot/src/lib/core-api-client.ts:41-57` — bare `fetch` with no `AbortSignal`, no retry, for all ~35 API methods. Every other internal caller (workers skills: 15s AbortSignal; voice-capture: 3× backoff; even the email CF worker is platform-bounded) is hardened; this is the one internal boundary that can hang a consumer indefinitely. A wedged core-api connection blocks Bolt handlers past Slack's ack window, producing user-visible silent failures. Fix is cheap because it's the documented single choke point: `AbortSignal.timeout(15_000)` to match the workers convention, plus treating 409 as success on `captures_create` if retries are added.

**M2 — Budget circuit breaker does not cover all paid-API paths.** `checkBudget()` (`llm-gateway.ts:649`) hard-stops only calls routed through `LLMGatewayService`. `EmbeddingService` (`embedding.ts` — zero budget references) and voice-capture `classification.ts` (its own `createOpenAIClient`) hit the paid OpenAI API outside the breaker. The April 2026 incident ($100+ overnight) demonstrated that bulk paths are exactly where runaway spend happens; a bulk re-embed or a voice-upload loop today would sail past the $50 hard limit, detected only by the next 07:00 budget-check alert.

**M3 — Email worker converts transient failures into permanent bounces.** `cloudflare/email-worker/src/index.ts:99,104,185` calls `message.setReject('... — will retry')` when the allowlist fetch or capture POST fails. `setReject` issues an SMTP-time permanent rejection — most sending MTAs bounce immediately and do not retry, contradicting the comment. A 5-minute core-api restart window means inbound brain mail during it is lost (sender does get a bounce, so loss is at least visible). Alternatives: `message.forward()` to a fallback mailbox on transient failure, or queue raw mail to KV/R2 for replay.

**M4 — Voice ingest exhaustion discards the transcript.** `voice-capture/src/server.ts:189-196`: after successful (paid) transcription + classification, if `IngestService` exhausts its 3 retries the handler returns 502 and the transcript exists nowhere server-side — no dead-letter file, no local queue. The iOS Shortcut client may not retain the recording. Persisting the assembled capture payload to disk (the container already has a volume) for sweep-based replay would close the only data-loss hole in an otherwise careful pipeline.

**M5 — Mobile voice upload bypasses every boundary control.** `packages/mobile/src/lib/config.ts` defaults `voiceCaptureUrl` to `http://homeserver.k4jda.net:3001` — plaintext HTTP, direct to voice-capture, no Bearer token, no `X-Open-Brain-Caller`, no rate limit; and `voice-capture/src/server.ts` has no auth at all. This both contradicts the mobile-auth model (every other mobile call is Bearer-gated) and confirms `:3001` is LAN-reachable: any device on the home network can submit audio that triggers paid transcription+classification. Intersects the documented deferred item "CF Tunnel for voice" (mobile-app-deferred), so this is a known gap — flagged here because the interim state leaves an unauthenticated paid-action endpoint open, and routing through the existing `POST /api/v1/voice-captures` proxy (which already exists for exactly this purpose) would close it without waiting on tunnel work.

**M6 — No machine-readable contract; consumer-side drift shims accumulating.** See Contract Fidelity. Evidence: slack-bot remapping (`core-api-client.ts:79-80,182-184,192-194,207-209`), three independent hand-written type sets (slack-bot `core-api-types.ts`, mobile `src/lib`, web-next), drift-guard covering only web↔shared. Minimum viable fix: generate one OpenAPI document from the existing Zod schemas (`@hono/zod-openapi` is a drop-in for this stack) and point all three consumers' types at it.

**M7 — No outbound-dependency metrics; log channel can fail silently.** No latency/error/throughput series per external dependency (OpenAI, whisper, voice proxy, Composio, sidecars) in `metrics.ts`; diagnosis depends on Loki, whose driver drops lines when Loki is unreachable (documented P11a behavior, no buffer). A single `outbound_request_duration_seconds{dependency,outcome}` histogram wrapped around the existing client choke points would cover ~90% of boundaries.

**L1 — Voice proxy fetch unbounded.** `core-api/src/routes/voice-captures.ts:29` has no `AbortSignal`; the public request is bounded only transitively by voice-capture's internal timeouts. A hung socket (not a slow response) holds the strict-tier slot open indefinitely.

**L2 — Mobile `api-client.ts` fetch has no timeout.** `mobile/src/lib/api-client.ts:74` — RN fetch on a dead network hangs until the OS gives up; UI spinners with no deadline. Add `AbortSignal.timeout`.

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 6 |
| Low | 2 |

(Requires investigation: 0 — the suspect bare-catch blocks in `WikiService` were inspected and are benign logged fallbacks.)

## Verified Strengths (not findings)

- Prior arch-review remediations (R2 proxy overwrite, R8 mobile-tier, `isInternalIp()` defense-in-depth) confirmed present and correct in code.
- `mobile-auth.ts` is exemplary boundary auth: fail-closed on missing key (503, never bypass), timing-safe compare, hash-prefix-only logging.
- Idempotency design (content hash + DB backstop, BullMQ jobIds, canonical pair ordering, batch UPSERT, single-use admin tokens) is consistently strong.
- Composio quota meter and the LLM gateway tier-fallback + budget gate are textbook third-party containment — the gap is coverage (M2), not design.
