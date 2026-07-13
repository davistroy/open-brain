# Integration Architect Findings

**Reviewer:** Integration Architect
**Date:** 2026-07-12
**Target:** /home/davistroy/dev/personal/open-brain
**Confidence:** High

Confidence rationale: v5 is a verification pass over v4 (2026-07-09). Git history confirms the only merges since v4 are Dependabot remediation (PRs #232–#234: transitive lockfile refresh, nodemailer 8→9 in workers, vitest 2→3 + test backfill + core-api dead-code removal) — every v4 finding's code location was re-inspected directly rather than assumed. Runtime state (homeserver, whether `VOICE_CAPTURE_SECRET` is now set in prod) was not probed, per scope.

---

## v4 Adjudication (do-first)

Every v4 integration finding was re-verified against HEAD. **Verdict: all 11 STILL OPEN — zero fixed, zero changed in substance.** This is expected: the only merged work since v4 was dependency remediation, none of which touched the finding sites.

| v4 Finding | Verdict | Evidence at HEAD |
|-----------|---------|------------------|
| IA-M1 — voice spool 409 poison-pill / no max-age | **STILL OPEN** | `voice-capture/src/services/ingest.ts:79-83` still throws on all 4xx including 409; `transcript-spool.ts:86-89` still retains any file whose ingest throws (`'will retry next sweep'`). No `okStatuses`, no max-age discard, no alert. |
| IA-M2 — voice Bearer never left phase-1 warn-allow | **STILL OPEN** | `voice-capture/src/server.ts:19-24` warn-and-allow block unchanged; intake confirms `VOICE_CAPTURE_SECRET` still unset in prod. D132 risk acceptance still rests on an inactive control. |
| IA-M3 — no machine-readable contract; consumer drift shims | **STILL OPEN** | Zero OpenAPI/AsyncAPI/proto/GraphQL files outside node_modules (re-searched); slack-bot shims verbatim at `core-api-client.ts:174-176` (`items→captures`) and `:277-280` (`mention_count→capture_count`, `entity_type→type`). |
| IA-M4 — no outbound-dependency metrics; cross-project telemetry contracts unenforced | **STILL OPEN** | `core-api/src/routes/metrics.ts`: zero outbound series (grep `outbound` = 0). ADR-0004 contracts (scrape alias, `PUSHGATEWAY_URL`, Loki driver URL) still enforced by nothing on either side. |
| IA-M5 — orphaned BullMQ repeatable schedulers on cron changes (#217) | **STILL OPEN** | `workers/src/scheduler.ts`: zero hits for `removeRepeatable`/`getRepeatableJobs`/`upsertJobScheduler`/`removeJobScheduler`. No startup reconciliation. |
| IA-M6 — monthly-reflection aggregate agent context unbounded (#204) | **STILL OPEN** | `monthly-reflection.ts` last touched in PR #169 (pre-incident); per-tool cap `MAX_CAPTURES_PER_VIEW = 200` only, no aggregate token budget in the agent loop. |
| IA-L1 — core-api voice proxy fetch unbounded | **STILL OPEN** | `core-api/src/routes/voice-captures.ts` upstream fetch: zero `AbortSignal`/`signal` hits. |
| IA-L2 — mobile fetches have no timeout | **STILL OPEN** | `mobile/src/lib/api-client.ts` + `audio.ts`: zero `AbortSignal`/timeout hits. |
| IA-L3 — 2 workers→core-api sites lack 15s timeout | **STILL OPEN** | `base-skill.ts:16` (autonomy fetch) and `email-compose.ts:188` (draft POST): `fetch(` present, `AbortSignal` absent in both files. |
| IA-L4 — `pushMetrics` no fetch timeout, awaited by health skills | **STILL OPEN** | `workers/src/lib/push-metrics.ts`: zero `AbortSignal`/timeout hits. |
| IA-L5 — persistent provider auth failure in email-classify has no alert | **STILL OPEN** | `email-classify.ts:148-152` still error-log-and-continue only; no consecutive-failure counter or Pushover. |

### Delta verification: what DID change since v4 (all clean)

- **nodemailer 8→9 (PR #233, workers).** The only runtime consumer is `workers/src/services/email.ts` — uses the stable core API only (`createTransport({host,port,secure,auth})` + `sendMail({from,to,subject,html,text})`), fully compatible with v9 (commit notes suites green at 9.0.3). The weekly-brief delivery cascade (Himalaya → nodemailer → Pushover, `weekly-brief.ts:118-145`) is intact. **No regression.** One net-new minor observation on this path → IA-L6 below.
- **core-api dead-code removal (`8d3b426`).** Deleted `services/sse.ts` is NOT the live SSE boundary — it was an unimported `publishUploadStatus()` helper. The real event-stream path (`routes/events.ts` + `lib/pg-notify.ts` with reconnect/re-LISTEN) is untouched. **No boundary regression.**
- **CF worker `npm audit fix` (PR #232)** touched only lockfiles in `cloudflare/email-worker` + `synthetic-monitor`; `email-worker/src/index.ts` transient-handling (INT-M3 semantics) unchanged.

---

## Interface Inventory

Unchanged from v4 — reproduced in condensed form; full detail in the v4 archive (`open-brain-backups/arch-review-v4-20260709/findings/integration-architect.md`).

### Exposed APIs

| Endpoint | Method | Contract Documented? | Versioned? | Auth? |
|----------|--------|---------------------|-----------|-------|
| `/api/v1/captures` (+`/:id`, `/:id/retry`) | GET/POST/PATCH/DELETE | Zod + prose; no OpenAPI | v1 | None in-boundary; CF Tunnel perimeter; strict tier |
| `/api/v1/search`, `/synthesize`, `/documents` | GET/POST | Zod/manual + prose | v1 | None; strict tier |
| ~80 CRUD routes (entities, bets, sessions, triggers, briefs, commitments, skills, settings, stats, wiki, email/drafts, insurance, activity, intelligence, config) | CRUD | Mixed Zod/manual; TS types | v1 | None; default tier; UUID param validation |
| `/api/v1/voice-captures` | POST multipart | Prose (D126); 413 guard | v1 | None; strict tier; forwards Bearer upstream when set |
| `/api/v1/ingest/*` | POST/GET | TS types | v1 | `INGEST_TRIGGER_SECRET` fail-closed on sidecar legs |
| `/admin/reset-data`, `/admin/queues/:name/clear` | POST | Prose (P04a/SEC-04) | unversioned | Origin allowlist + two-step token + phrase; audit |
| `/mcp` (8 tools + 1 resource) | Streamable HTTP | Tool schemas in code | implicit | Bearer `MCP_BEARER_TOKEN` |
| `/health`, `/metrics`, `/api/v1/system/*` | GET | Prose | mixed | Docker-internal convention; `/metrics` scraped by external shared Prometheus (ADR-0004) |
| voice-capture `:3001/api/capture` | POST multipart | Prose | unversioned | Bearer, timing-safe — **warn-allow while secret unset (IA-M2)** |
| ingest-sidecar trigger server | POST | Docstrings | unversioned | `INGEST_TRIGGER_SECRET`, constant-time, fail-closed |
| Mobile-gated routes | GET/POST | TS types | v1 | Bearer `MOBILE_API_KEY` fail-closed; `mobile` tier (reachability question is SEC-A2, security's finding) |
| Email ingress (brain@) | SMTP via CF Email Worker | Worker source | n/a | Sender allowlist via `app_settings` |
| web-next `/api/*` proxy | all | `proxy.ts` | v1 passthrough | Overwrites `X-Open-Brain-Caller: web-next-public` + `isInternalIp()` defense-in-depth |

### Consumed Integrations

| Dependency | Type | Has Timeout? | Has Retry? | Has Circuit Breaker? | Fallback? |
|------------|------|-------------|-----------|---------------------|-----------|
| OpenAI (LLM via gateway) | HTTPS | Yes — per-tier | Yes — transient + tier chain | Yes — budget hard-stop | Tier fallback chains |
| OpenAI (embeddings) | HTTPS | Yes | BullMQ 5× patient + `moveToDelayed` budget pause | Spend recorded; gateway enforcement | None by design (queue+retry) |
| Anthropic (agent skills) | HTTPS | Yes — tiered 30/60/120s + `extended` | SDK retries | Budget via gateway path | — |
| OpenAI (voice classification) | HTTPS | Yes (30s) | No | No — documented deferral INT-M2-voice | `CLASSIFICATION_MODEL` env; `models.intent` (SA-7) |
| faster-whisper | HTTP | Yes — 120s | No | No | No |
| core-api ← voice-capture (IngestService) | HTTP | Yes — 15s | 3× exp backoff, 4xx non-retried | No | Spool + 30-min sweep — **409 poison-pill (IA-M1)** |
| core-api ← slack-bot (CoreApiClient) | HTTP | Yes — 15s | GET-only 3×, 5xx | No | 409-as-success |
| core-api ← workers skills | HTTP | Mostly 15s — 2 gaps (IA-L3) | BullMQ | No | `observe` default on autonomy-fetch error |
| core-api ← email worker (CF) | HTTPS | CF platform | Throw→CF redelivery on 5xx/network | No | 4xx bounce |
| core-api ← mobile app | HTTPS | No (IA-L2) | No | No | UI errors |
| SMTP (weekly-brief via nodemailer 9) | SMTP | **Defaults only — no explicit config (IA-L6)** | BullMQ job 3× | No | Cascade: Himalaya → nodemailer → Pushover |
| Ingest sidecars ← workers | HTTP | Yes — 5 min | BullMQ patient backoff | No | Daily sweep re-queue |
| Composio | HTTPS | Yes — 60s | No | Yes — quota meter 19K/15K | Direct-API policy |
| Gmail/Hotmail (email-classify) | REST/OAuth2 | library defaults | No | No | Per-provider isolation — no persistent-failure alert (IA-L5) |
| Slack (Socket Mode) | WSS/HTTPS | Bolt-managed | Bolt reconnect | n/a | n/a |
| Pushgateway (shared, ADR-0004) | HTTP external | No timeout (IA-L4) | No | No | Warn-and-swallow |
| Prometheus (shared) | Passive scrape | n/a | Prometheus-side | n/a | Alias contract documented, unenforced |
| Loki log driver | Docker plugin | n/a | No — silent drop on unreachable | No | None |
| Pushover | HTTPS | 30s | 3× fixed | No | Loss tolerated |
| Postgres LISTEN/NOTIFY | TCP | n/a | Exp backoff 1s→30s ×5, re-LISTEN | n/a | SSE resumes |
| Gitea wiki (git) | SSH/HTTP | git defaults | Queue concurrency 1 | No | Graceful lint fallback |

## Contract Fidelity Assessment

Unchanged from v4: no machine-readable contract anywhere; de facto contract = `@open-brain/shared` TS types + Zod validators + CLAUDE.md prose lockstep rules, with CI teeth on enum drift (all three consumer packages) but nothing on response *shapes*. slack-bot's consumer-side remapping shims persist verbatim. The Dependabot work introduced no contract changes. See IA-M3.

## Resilience Pattern Coverage

| Integration | Timeout | Retry | Circuit Breaker | Bulkhead | Fallback | Assessment |
|-------------|---------|-------|----------------|----------|----------|------------|
| LLM gateway → OpenAI/Anthropic | ✅ per-tier | ✅ transient + tier chain | ✅ budget hard-stop | BullMQ concurrency 1–2 | ✅ tier fallback | Strong |
| Embeddings → OpenAI | ✅ | ✅ 5× patient + budget pause | Gateway/budget-check | ✅ queue | None by design | Good |
| slack-bot → core-api | ✅ 15s | ✅ GET-only 3× | ❌ | ❌ | 409-absorb | Reference implementation |
| voice-capture chain | ✅ each hop | ✅ ingest leg | ❌ | ❌ | ✅ spool — 409 poison-pill (IA-M1) | Good design, one hole |
| core-api voice proxy | ❌ (IA-L1) | n/a | ❌ | strict tier + 413 pre-guard | 502 | Carried gap |
| Email worker → core-api | CF platform | ✅ CF redelivery | ❌ | CF isolate | 4xx bounce | Good |
| Mobile → core-api / voice | ❌ (IA-L2) | ❌ | ❌ | server-side mobile tier | UI errors | Carried gap |
| Workers skills → core-api | ✅ 15s except 2 (IA-L3) | ✅ BullMQ | ❌ | ✅ documented concurrency | ✅ `observe` default | Strong, minor drift |
| Workers → Pushgateway | ❌ (IA-L4) | ❌ | ❌ | awaited in 2 health skills | warn-and-swallow | Carried gap |
| Weekly-brief → SMTP | Defaults only (IA-L6) | BullMQ 3× | ❌ | singleton job | ✅ 3-tier cascade | Good, minor gap |
| Composio | ✅ 60s | ❌ | ✅ quota | n/a | policy | Good |
| Sidecar trigger | ✅ 5 min | ✅ patient backoff | ❌ | concurrency 1 | sweep | Good |
| pg-notify / SSE | n/a | ✅ ×5 | n/a | n/a | re-LISTEN | Good (verified intact after `sse.ts` dead-code removal) |

## Idempotency Audit

Unchanged and still strong: content-hash dedup + DB unique backstop; stable BullMQ jobIds (`pipeline_${captureId}`); canonical pair ordering + single batch UPSERT for Hebbian associations; single-use admin tokens; age-based re-entrant retention prune with tested `admin_audit` exclusion; `pgUuidArray()` for UUID arrays. The one re-entrancy defect remains IA-M1 — the voice spool's at-least-once delivery still meets a duplicate-intolerant consumer (409 → eternal 30-min retry loop). Email worker still has no message-id dedup (acceptable; content-hash covers exact redelivery).

## Versioning and Evolution Assessment

Posture unchanged: single `/api/v1`, coordinated monorepo deploys substitute for API versioning; evolution discipline is CLAUDE.md lockstep rules + growing CI guards. New this cycle: `.github/dependabot.yml` with grouped updates and automated security fixes — a genuine improvement to third-party contract hygiene; the three-wave remediation (transitives → nodemailer major → vitest major) was executed with per-wave verification. **Open evolution risk:** 9 Dependabot PRs (#235–#243) pending, including `@cloudflare/workers-types` 4→5 majors in both CF worker dirs — dev-type-only, but note the email-worker has no test runner (typechecked only by wrangler-on-deploy), so the v5 types' compatibility-date entrypoint model should be verified against the wrangler config before merge rather than trusted to CI. The ADR-0004 cross-project telemetry contracts (scrape alias, pushgateway URL, Loki endpoint) remain documented-but-unenforced.

## Integration Observability

Unchanged from v4 (IA-M4 still open): inbound HTTP metrics good; zero outbound-dependency series; boundary-failure diagnosis depends on Loki (silent-drop failure mode) and `pipeline_events`/`skills_log` rows. The empirical evidence stands — Gmail OAuth expiry and the weeks-silent `daily-connections` bug were both invisible to alerting; nothing merged since v4 changes that.

## Dependency Risk Register

| Dependency | Failure Impact | No Mitigation? | Risk Level |
|------------|---------------|----------------|------------|
| voice-capture `:3001` unauthenticated in prod | Any LAN device drives paid transcription+classification; classification spend outside budget recording | **Yes — Bearer built, `VOICE_CAPTURE_SECRET` still unset** (IA-M2) | **Medium — control inactive 2+ months after build** |
| Voice spool poison-pill | Duplicate-delivery entry re-POSTs every 30 min forever; spool never drains | **Yes** (IA-M1) | Medium |
| BullMQ repeatable state vs code | Cron edits orphan schedules → zombies, false alerts (proven live, Entry 180) | **Yes — no reconciliation** (IA-M5/#217) | Medium |
| Anthropic ← monthly-reflection | Monthly 400 prompt-too-long, no output | **Yes — aggregate context unbounded** (IA-M6/#204) | Medium |
| Shared observability stack | Metric/log blindness; Loki silent drop; push hang can stall health skills | Partial (IA-M4, IA-L4) | Medium |
| OpenAI API | Embedding+inference halt; backlog | Patient backoff + sweep + budget pause + tier fallback | Medium (accepted) |
| SMTP (weekly-brief) | Up to ~10 min stall on hung socket before Pushover fallback | Partial — cascade exists, defaults only (IA-L6) | Low |
| Gmail OAuth | email-classify Gmail leg silently degraded | Isolation yes; alerting no (IA-L5) | Low |
| core-api ← slack-bot / email worker | Bounded, retried correctly | Fixed (INT-H1/INT-M3) | Low |
| Composio / Slack / Pushover / Gitea / pg-notify | Bounded, documented | Adequate | Low |

## Findings Detail

All carried findings retain their v4 identifiers; full write-ups are in the v4 archive and remain accurate at HEAD. Summary + fix per finding:

**IA-M1 (Medium, STILL OPEN) — Voice spool retries forever on 409/permanent-4xx.** `ingest.ts:79-83` throws on all 4xx including 409; `transcript-spool.ts:86-89` retains and retries every 30 min indefinitely. The spool's write-ahead ordering guarantees the duplicate case exists. Fix: 409-as-success (mirror slack-bot `okStatuses: [409]`) + max-age discard with Pushover.

**IA-M2 (Medium, STILL OPEN) — Voice Bearer enforcement never left phase-1 warn-allow.** `server.ts:19-24` unchanged; secret unset in prod. Operator action, not code. The D132 risk acceptance ("Bearer is the control" for `0.0.0.0:3001`) still diverges from deployed reality — now for a third review cycle.

**IA-M3 (Medium, STILL OPEN) — No machine-readable contract; consumer drift shims persist.** Zero spec files; slack-bot shims at `core-api-client.ts:174-176, 277-280`. Minimum fix unchanged: generate OpenAPI from existing Zod via `@hono/zod-openapi`, derive the three consumers' types.

**IA-M4 (Medium, STILL OPEN) — No outbound-dependency metrics; ADR-0004 telemetry contracts unenforced.** `metrics.ts` zero outbound series. Fix unchanged: one `outbound_request_duration_seconds{dependency,outcome}` histogram at the existing client choke points + degraded-N-consecutive-runs alert.

**IA-M5 (Medium, STILL OPEN, = #217) — Orphaned BullMQ repeatable schedulers on cron changes.** No reconciliation code in `scheduler.ts`. Fix: startup reconcile desired set (from the `const *Cron` registry) against existing job schedulers, remove strays.

**IA-M6 (Medium, STILL OPEN, = #204) — monthly-reflection aggregate agent context unbounded.** File untouched since PR #169. Fix: aggregate token budget (~150K) / tool-result truncation in `run-agent.ts`.

**IA-L1 (Low, STILL OPEN) — core-api voice proxy fetch unbounded.** `routes/voice-captures.ts` — add `AbortSignal.timeout(150_000)`.

**IA-L2 (Low, STILL OPEN) — Mobile fetches have no timeout.** `mobile/src/lib/api-client.ts`, `audio.ts`.

**IA-L3 (Low, STILL OPEN) — Two workers→core-api sites lack the 15s timeout convention.** `base-skill.ts:16`, `email-compose.ts:188`.

**IA-L4 (Low, STILL OPEN) — `pushMetrics` no fetch timeout, awaited by container-health/pipeline-health.** `push-metrics.ts` — add `AbortSignal.timeout(5_000)`.

**IA-L5 (Low, STILL OPEN) — Persistent provider auth failure in email-classify has no alert.** `email-classify.ts:148-152` — add consecutive-failure counter in `skills_log` + Pushover after N runs (copy the pipeline-health suppression pattern).

**IA-L6 (Low, NEW) — SMTP transport has no explicit timeouts; relies on nodemailer defaults.** `workers/src/services/email.ts:63-71` creates the transport with no `connectionTimeout`/`greetingTimeout`/`socketTimeout`; nodemailer 9 defaults are 2 min / 30 s / 10 min. In the weekly-brief cascade (`weekly-brief.ts:118-145`) a hung-but-connected SMTP socket can stall the singleton skill up to ~10 min before falling through to Pushover — bounded, so Low, but inconsistent with the codebase's 15s-timeout convention at every other outbound boundary. Surfaced while verifying the nodemailer 8→9 upgrade (the one runtime-touched integration path since v4). Fix: pass `connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000` to `createTransport`.

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 6 |
| Low | 6 |

(Requires investigation: 0. All v4 findings adjudicated: 11 STILL OPEN, 0 FIXED, 0 CHANGED; 1 net-new Low.)

## Verified Strengths (not findings)

- The Dependabot remediation was executed cleanly from an integration standpoint: nodemailer 9 usage is confined to the stable core API in one file; the `sse.ts` deletion was genuinely dead code (live SSE boundary at `routes/events.ts`/`lib/pg-notify.ts` untouched); grouped Dependabot config improves ongoing third-party contract hygiene.
- All v4-verified strengths stand: slack-bot client as the reference internal-caller implementation; fail-closed constant-time boundary auth where enforced (mobile-auth, ingest trigger); consistently strong idempotency architecture; enum-lockstep CI enforcement on all three consumer packages.
