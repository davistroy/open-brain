# Solutions Architect Findings

**Reviewer:** Solutions Architect
**Date:** 2026-06-10
**Target:** /home/davistroy/dev/personal/open-brain (main @ ac42938, v1.6.0)
**Confidence:** High — documentation is extensive and current (PRD v0.7, TDD v0.7, ADR-0001, 10 runbooks, 162-entry lab notebook), and all structural claims below were verified directly against source, compose files, migrations, and configs. The only unverifiable items are live homeserver runtime state (out of scope).

> Supersedes the 2026-04-18 solutions-architect findings. Items remediated via PRs #180–#189 and the 2026-05 cohesive remediation (parallel web stacks, god-module API client, caller-header trust, doc/container-count drift) were re-verified as closed and are not re-reported.

---

## Architecture Summary

Open Brain is a single-user, self-hosted knowledge infrastructure built as a pnpm monorepo (9 packages) deployed as 17 Docker Compose containers on one Unraid host. The primary pattern is a **modular monolith API (Hono core-api) with satellite single-purpose services** (workers, slack-bot, voice-capture, voice-pipecat, file-ingestion sidecar, web-next) communicating through a shared Postgres 16 + pgvector database and BullMQ/Redis queues, with an event-driven staged ingestion pipeline (classify → embed → extract → link → triggers → notify) and config-driven behavior (YAML for routing, pipeline, skills, views). Perimeter access flows through Cloudflare Tunnel/Workers; all AI runs through OpenAI (gpt-5.4 + text-embedding-3-large @768d) behind a cost circuit breaker.

---

## Requirements Fidelity Matrix

| Requirement (PRD §7 / CLAUDE.md) | Architectural Coverage | Gap? |
|-------------|----------------------|------|
| Text capture ingest < 500ms | Hono route persists + enqueues async pipeline; returns minimal `{id, pipeline_status}` envelope | No |
| Pipeline processing < 30s w/ retries (5 attempts, 30s→2h backoff) | `config/pipeline.yaml` stages + retry array; BullMQ per-stage queues; daily sweep re-queuer (`daily-sweep`, 3am) | No |
| Hybrid search < 5s | `hybrid_search()` SQL function (RRF) with `LIMIT match_count*4` push-down (mig 0027), per-query `SET LOCAL hnsw.ef_search` from config, ACT-R decay + Hebbian boost | No |
| Monthly AI budget — soft alert / hard circuit breaker | `config/ai-routing.yaml` `hard_limit_usd: 35`; budget-check cron; per-tier mandatory cost fields; `estimateTierCostUsd()` | **Partial** — config says $35 hard; PRD/CLAUDE.md say $50 hard / $30 soft (doc–config drift, SA-6) |
| Health checks on all containers | 15 of 17 services declare compose healthchecks | **Partial** — cloudflared, prometheus, grafana, financial-ingest, utility-ingest lack healthchecks (SA-5) |
| Daily DB backup + offsite, soft-delete only | `scripts/backup.sh` (pg_dump custom format, 14d/4w/3m retention, wiki + Redis RDB, secrets-redaction regression guard); restore runbook + rehearsal cron file | No (runtime install of rehearsal cron unverified — SA-10) |
| Single-user, no in-boundary auth; perimeter via CF Tunnel + caller identity | `proxy.ts` overwrites `X-Open-Brain-Caller` at public boundary; `rate-limit.ts` `isInternalIp()` defense-in-depth; mobile Bearer tier; MCP Bearer | No |
| Reliability monitoring | Prometheus + prom-client metrics, Loki log driver, Grafana provisioned dashboards, Pushover alerts, `pipeline_events`/`skills_log` audit tables | **Partial** — PRD §7 still states "No dedicated monitoring stack" (stale, SA-6); Loki driver drops logs when Loki is down (SA-3) |
| Pipeline idempotency + dedup | Source-level dedup (slack_ts, filename, content hash + 60s window); `ON CONFLICT` upserts; idempotent DDL conventions | No |
| Cost-tiered processing T0→T3 (mandatory convention) | Tier config in `ai-routing.yaml`; Track A/B split documented; batch pipelines use Python (T0) + CLI synthesis (T2) | **Partial by design** — production routes all real-time AI to OpenAI; Jetson/Spark demoted to optional tiers in TDD §2.1 (see Decision 8) |
| Memory ceiling 1.5 GB RSS/process | compose `mem_limit` on every service (1500m/1536m app containers, 8g Postgres/whisper, 512m Redis) | No |

---

## Design Decision Log

### Decision 1: Modular monolith API + satellite services on a shared database
- **What it solves:** Single-user system needs many ingestion surfaces (voice, Slack, email, files, mobile, MCP) without microservice operational tax.
- **What was chosen:** One Hono core-api owning all HTTP/MCP surface and DB writes for interactive paths; separate worker container for async pipeline/skills; thin protocol adapters (slack-bot, voice-capture) that call core-api over HTTP with caller identity headers; one Postgres for relational + FTS + vector.
- **Likely rejected alternatives:** Full microservices (per-domain DBs); pure monolith (one container).
- **Assessment:** Sound
- **Rationale:** Containers map to failure domains and resource limits (whisper 8 GB isolated from API), not to organizational boundaries that don't exist. Shared DB is correct at this scale; hub-and-spoke dependency graph is clean — all four TS service packages depend only on `@open-brain/shared`, no lateral package imports.

### Decision 2: MCP embedded in core-api at `/mcp` (no separate container)
- **What it solves:** Agent access (Claude/ChatGPT) to the brain without another service to deploy, secure, and keep in sync with the API layer.
- **What was chosen:** Streamable HTTP MCP server mounted inside core-api, Bearer auth, 8 tools + 1 resource reusing the same service layer as REST routes.
- **Likely rejected alternatives:** Standalone MCP container; MCP-over-LiteLLM only.
- **Assessment:** Sound
- **Rationale:** Tools and REST share `SearchService`/`CaptureService` — one behavior surface, zero contract drift between MCP and API. Coupling MCP availability to core-api availability is irrelevant when they'd fail together anyway (same DB, same host).

### Decision 3: OpenAI-only AI with 768d MRL embeddings and no embedding fallback
- **What it solves:** Embedding-space consistency — mixed-provider embeddings silently corrupt vector search.
- **What was chosen:** `text-embedding-3-large` with API `dimensions: 768` (trained Matryoshka, not naive truncation); `vector(768)` schema; queue-and-retry on outage rather than fall back to a local model.
- **Likely rejected alternatives:** Local embedding model (no GPU on target host); 1536d (2× storage/HNSW cost); fallback chain (vector-space pollution).
- **Assessment:** Sound
- **Rationale:** "No fallback" is the architecturally literate choice — the patient retry ladder (30s→2h) plus daily sweep converts an availability problem into a latency problem, which is acceptable for ingestion. The single-provider dependency is a deliberate, documented tradeoff with a budget circuit breaker bounding the cost exposure.

### Decision 4: BullMQ staged pipeline with per-stage queues and patient backoff
- **What it solves:** Multi-stage enrichment (classify/embed/extract/link/trigger/notify) with independent failure/retry per stage and full audit (`pipeline_events`).
- **What was chosen:** Queue-per-stage in `packages/workers/src/queues/`, config-driven stage enable/timeout (`pipeline.yaml`), concurrency discipline (default 2, documented singletons at 1), cron slot registry to prevent schedule collisions.
- **Likely rejected alternatives:** Postgres-based job table (SKIP LOCKED); Temporal (operational overkill); synchronous pipeline.
- **Assessment:** Sound
- **Rationale:** Redis AOF persistence covers queue durability; `pipeline_status` on captures + daily sweep covers the residual loss window. The DB-level CHECK constraints on `pipeline_events.stage/status` (migration 0025) keep the audit trail honest.

### Decision 5: Web consolidation on web-next (ADR-0001)
- **What it solves:** Two parallel UI stacks (Vite `web` + Next.js `web-next`) with drift and double maintenance.
- **What was chosen:** Sunset `packages/web`, canonical web-next with split-by-domain typed API client (`lib/api/`, ~24 modules), `pre-web-sunset-2026-05` rollback tag + runbook.
- **Likely rejected alternatives:** Keep both (documented and rejected in the ADR); consolidate on Vite.
- **Assessment:** Sound
- **Rationale:** The ADR is a model of the genre — alternatives, costs, rollback path, and execution phases. Verified executed: `packages/web` gone, compose `web` service removed, the `depends_on` straggler fixed (d479c04). One residue: the type-drift guard that protected web↔shared died with `packages/web` and was not rebuilt for web-next/mobile (SA-1).

### Decision 6: Caller-identity trust model (header + IP defense-in-depth)
- **What it solves:** Differential rate limiting between internal services, public web, and mobile without per-service auth inside a single-user trust boundary.
- **What was chosen:** `X-Open-Brain-Caller` header set by each internal service; Next.js `proxy.ts` overwrites it to `web-next-public` at the public boundary; `rate-limit.ts` ignores the header for non-internal source IPs (`isInternalIp()`); mobile gets Bearer + its own tier.
- **Likely rejected alternatives:** mTLS between containers (overkill); full auth layer (explicitly out of scope per PRD).
- **Assessment:** Sound (post-remediation)
- **Rationale:** The original header-only design was spoofable; the 2026-05 Phase 2.3 IP check closes that. Remaining fragility is procedural — 17 bypass entries maintained by convention in a Set — but the failure mode is now just 429s (fail-closed), not privilege escalation.

### Decision 7: In-database hybrid search (SQL `hybrid_search()` + pgvector HNSW) vs. external vector store
- **What it solves:** Hybrid FTS+vector retrieval with RRF fusion, temporal decay, and spreading activation over one consistent dataset.
- **What was chosen:** Postgres function with CTE LIMIT push-down (`match_count*4`, mig 0027), expression-based GIN FTS index, per-query `SET LOCAL hnsw.ef_search` sourced from config, benchmark harness (`scripts/benchmark-search.mjs`).
- **Likely rejected alternatives:** Qdrant/Weaviate sidecar (another stateful service, sync problem); Elasticsearch.
- **Assessment:** Sound
- **Rationale:** At ~11K–100K captures this is the right call; the LIMIT push-down work shows the scaling cliff was found and engineered around rather than papered over. The cognitive-memory layers (ACT-R, Hebbian, spreading activation) compose on top without a second store.

### Decision 8: Cost-tiered processing (T0→T3) as governing convention, all-OpenAI in the hot path
- **What it solves:** Bounding variable AI spend ($100+ incident, 2026-04-15) while keeping real-time UX.
- **What was chosen:** Mandatory tiering convention; batch pipelines (email, financial, files) do Python extraction + aggregated synthesis; production real-time routes to OpenAI; Jetson/Spark demoted to optional tiers; circuit breaker + mandatory per-tier cost fields enforce visibility.
- **Likely rejected alternatives:** Local-first inference (no GPU on homeserver; Jetson/Spark are network dependencies with their own availability problems).
- **Assessment:** Sound
- **Rationale:** The principle is enforced where it matters (batch aggregation, cost-field fail-fast validation, budget breaker) rather than dogmatically (real-time tiers stay on the reliable paid provider). The convention-vs-deployment gap is documented in TDD §2.1, so it is a decision, not drift.

### Decision 9: Cross-package BullMQ queues bound by name string with inlined payload types
- **What it solves:** core-api producing jobs (e.g., `access-stats`) consumed by workers without importing `@open-brain/workers`.
- **What was chosen:** core-api instantiates `new Queue<InlineType>('access-stats')`; payload shape duplicated inline; Redis routes by name.
- **Likely rejected alternatives:** Shared queue-contract module in `@open-brain/shared`.
- **Assessment:** Questionable
- **Rationale:** Preserves the clean dependency direction, but the producer/consumer payload contract is compiler-invisible — a field rename in workers compiles green in core-api and fails at job-processing time. Acceptable at 1–2 shared queues; the moment a third appears, the contract belongs in `@open-brain/shared` (see SA-4).

### Decision 10: No auto-migration on startup; manual `init-schema.sql` + sequential migration application
- **What it solves:** Avoids accidental destructive DDL on container restart against the only copy of the data.
- **What was chosen:** Operator manually applies `scripts/init-schema.sql` plus all `packages/shared/drizzle/0*.sql` after volume recreation; `scripts/migrate.sh` (drizzle-kit) exists but the documented homeserver procedure is manual psql.
- **Likely rejected alternatives:** drizzle-kit migrate on container start; migration job container.
- **Assessment:** Questionable
- **Rationale:** Caution about auto-DDL is legitimate, but the implementation created **two overlapping schema sources with no machine-checked equivalence**, and drift has already occurred (SA-2). The conservatism is right; the dual-source mechanism is not.

---

## NFR Coverage Scorecard

| NFR | Score (1–5) | Evidence | Gap |
|-----|-------------|----------|-----|
| Availability | 3 | `restart: unless-stopped` everywhere; 15/17 healthchecks; `depends_on: service_healthy` ordering; patient retry converts dependency outages to latency; synthetic monitor (health.troy-davis.com) | Single host, single Postgres/Redis — no redundancy (accepted for single-user); 5 services without healthchecks (SA-5); a wedged cloudflared tunnel is invisible to compose health |
| Scalability | 4 | HNSW LIMIT push-down (mig 0027); configurable `ef_search` w/ benchmark harness; BullMQ concurrency discipline; capacity planning TDD §18.5; per-container mem_limits | Vertical-only by design; first real ceiling is Postgres 8 GB limit vs. HNSW working-set growth — adequate runway at single-user volume (see Evolution) |
| Maintainability | 4 | Clean hub-and-spoke package graph; no god modules (largest source file 607 LOC); config-driven everything; canonical type unions with DB CHECK parity; exceptional docs (PRD/TDD/ADR/runbooks/lab notebook); 2,000+ tests, coverage gates | Type unions hand-mirrored into web-next + mobile with no drift guard (SA-1); dual schema sources (SA-2); lockstep rules enforced by convention/grep, not CI assertions (SA-8) |
| Observability | 4 | prom-client business + runtime metrics in core-api; Loki log driver on all 13 logged services; provisioned Grafana dashboards; Pushover alert runbooks; `pipeline_events`/`skills_log`/`ai_audit_log`/`admin_audit` DB audit trails | Loki driver silently drops logs when Loki unreachable (SA-3); no request/job correlation IDs — capture_id serves the pipeline but HTTP-layer log correlation is manual (SA-9) |
| Portability | 3 | Fully containerized, single network, all config via env + mounted YAML; secrets externalized to Bitwarden with rebuild scripts; images published to GHCR | Unraid-specific paths and cron persistence; Cloudflare-specific ingress + email path; loki Docker plugin is an undeclared host prerequisite (one-time pre-install required or all logging config fails); migration to another host is a runbook exercise, not turnkey |
| Recoverability | 4 | Daily pg_dump (custom format) w/ 14d/4w/3m retention + offsite rclone; Redis AOF; wiki repo mirrored; secrets round-trip (load/verify/test scripts, SHA sidecar, Pushover on drift); pre-wipe pg_dump on admin reset; restore runbook + rehearsal cron design | Schema bootstrap drift means a from-scratch restore depends on the operator correctly applying 33 sequential migrations over a stale snapshot (SA-2); rehearsal cron install status unverified (SA-10); no stated RTO/RPO numbers — implied RPO 24h via daily dump |

---

## Architecture Pattern Assessment

- **Pattern identified:** Modular monolith API + single-purpose satellite containers, event-driven staged pipeline over BullMQ/Redis, shared Postgres as the single source of truth, config-as-contract (YAML), perimeter-security trust model.
- **Fit score:** 5
- **Rationale:** For a single-operator, single-host, multi-ingestion-surface knowledge system, this is close to the canonical right answer. It avoids both failure modes available to it: the distributed-systems tax of real microservices (no per-service DBs, no service mesh, no cross-service sagas) and the resource-coupling of a true monolith (whisper's 8 GB and pipeline LLM latency are isolated from the interactive API). The dependency graph is enforced in the right direction (everything → shared, nothing lateral). Patterns are applied with evidence (benchmarked ef_search, measured coverage floors, documented cron slot registry) rather than by fashion.
- **Specific concerns:** (1) The architecture's correctness increasingly depends on *conventions documented in CLAUDE.md* (lockstep enum updates across 4–6 surfaces, cron slot grep discipline, dual bypass-caller registration) rather than CI-enforced invariants — fine while one disciplined operator+agent maintains it, fragile to any second contributor. (2) The two overlapping schema sources (Decision 10). (3) Documentation drift is reappearing post-remediation in PRD §7 (SA-6) — the same class of rot ADR-0001 was written to kill.

---

## Structural Risk Register

| ID | Finding | Severity | Component | Recommendation |
|----|---------|----------|-----------|----------------|
| SA-1 | Canonical type unions (`CaptureType`, `CaptureSource`, `PipelineStatus`, etc.) are hand-mirrored in `packages/web-next/lib/types.ts` and `packages/mobile/src/lib/types.ts` with no automated parity check. The drift-guard test that protected this contract died with `packages/web` (Phase 8b) and was never rebuilt. CLAUDE.md's "update all four surfaces in lockstep" rule omits these two mirrors — there are six surfaces in reality. **Failure mode:** adding a 10th `source` or 9th `capture_type` passes shared/Zod/DB checks but renders as unknown values or breaks filter UIs in web-next/mobile silently, discovered only in manual testing. | Medium | `packages/web-next/lib/types.ts`, `packages/mobile/src/lib/types.ts` | Add a small vitest drift-guard in each package asserting the local union arrays deep-equal the exported `CAPTURE_SOURCES`/`CAPTURE_TYPES`/`PIPELINE_STATUSES` constants from `@open-brain/shared` (dev-dependency only — runtime decoupling preserved). Update the CLAUDE.md lockstep rules from four surfaces to six. |
| SA-2 | Dual-source schema bootstrap with confirmed drift: `scripts/init-schema.sql` (the documented restore starting point) includes migration 0031 (`commitments`) and 0029 (`insurance_policies`) but is missing `app_settings` (0010), `spreading_activation` (0012), `lab_results` (0028), and `briefs` (0030). The snapshot and the 33-migration sequence overlap with no machine-checked equivalence, and the homeserver procedure is manual psql (drizzle `migrate.sh` exists but is not the deployed path; no migration-tracking table in the manual flow). **Failure mode:** a disaster-recovery rebuild under stress applies init-schema plus a partial migration set → services start, then 500 on briefs/settings/`include_related` search, with nothing recording which migrations were applied. This compounds the system's weakest moment (full restore). | High | `scripts/init-schema.sql`, `packages/shared/drizzle/`, restore runbook | Make one source authoritative: either (a) generate `init-schema.sql` from `pg_dump --schema-only` of a fully-migrated DB in CI and diff against the committed file (drift fails the build), or (b) delete the snapshot and make `migrate.sh` (drizzle-kit, which tracks applied migrations) the only bootstrap path, referenced by the restore runbook. Option (b) is structurally better. |
| SA-3 | Loki Docker log driver fails open to `none`: if Loki is unreachable when a container starts, Docker silently drops all log lines (not buffered, no local fallback), and the loki plugin is an undeclared host prerequisite outside compose. **Failure mode:** during a network partition or Loki outage — exactly when debugging is needed — affected containers produce zero retrievable logs for the entire incident window; on a rebuilt host, forgetting the one-time plugin install breaks every service start. | Medium | `docker-compose.yml` `logging:` blocks (13 services), Docker host | Replace the driver-per-container approach with default `json-file` logging (bounded `max-size`/`max-file`) plus a Grafana Alloy/Promtail container in the stack scraping container logs and shipping to Loki. Logs survive Loki outages locally, `docker logs` works again, and the host-plugin prerequisite disappears. |
| SA-4 | Cross-package BullMQ queue contracts exist only as name strings + duplicated inline payload types (`access-stats` produced in `core-api/src/routes/search.ts` and `mcp/tools/search-brain.ts`, consumed in `workers/src/jobs/update-access-stats.ts`). Payload drift compiles clean and fails at job-processing time. Documented as intentional; acceptable at current count. | Low | core-api search routes, workers `update-access-stats` | Tolerable now. Trigger condition for fixing: a third cross-package queue, or any payload field change — at that point move queue name + payload type to `@open-brain/shared` (types only, no BullMQ import). |
| SA-5 | PRD §7 states "Health checks on all containers" but cloudflared, prometheus, grafana, financial-ingest, and utility-ingest declare none. The ingress (cloudflared) is the most consequential: a wedged tunnel process keeps `restart: unless-stopped` satisfied while all external access is down — only the synthetic monitor catches it. | Low | `docker-compose.yml` | Add healthchecks: cloudflared (metrics endpoint or `pgrep`), prometheus (`/-/healthy`), grafana (`/api/health`). For the two ingest one-shots, scope the PRD requirement to long-running services instead. |
| SA-6 | Post-remediation documentation drift recurring in PRD §7: (a) "Monitoring: lean approach … No dedicated monitoring stack" contradicts the deployed Loki/Prometheus/Grafana/Pushgateway stack (P11/P12); (b) budget limits — PRD/CLAUDE.md say soft $30 / hard $50 while `config/ai-routing.yaml` enforces `hard_limit_usd: 35`. Config is authoritative and more conservative, so no cost exposure, but the stated NFR and the enforced NFR disagree. | Low | `docs/PRD.md` §7, `CLAUDE.md`, `config/ai-routing.yaml` | One-pass PRD §7 refresh; pick the canonical budget number and align all three artifacts. Add a docs-drift item to the release checklist — this is the second occurrence of this rot class (first was the "NOT Next.js" episode resolved by ADR-0001). |
| SA-7 | voice-capture classification model is hardcoded (`gpt-5.4` in `classification.ts`, env-overridable via `CLASSIFICATION_MODEL`) instead of resolving through `ai-routing.yaml` task routing like every other LLM call site. A model migration (e.g., gpt-5.4 retirement) requires remembering this one out-of-band site. | Low | `packages/voice-capture/src/classification.ts` | Add a `voice_classification` task_routing entry and resolve via the shared model-resolver; keep the env override as escape hatch. |
| SA-8 | Scheduler correctness (no two repeatable jobs on the same cron minute; JSDoc/const parity) is enforced by grep discipline and a CLAUDE.md slot registry, not by code. A reviewer already caught one drift instance (`costAnalysisCron` JSDoc/const divergence in P07 cycle 1). | Low | `packages/workers/src/scheduler.ts` | Add a unit test that imports the registered cron expressions and asserts pairwise minute-slot uniqueness — converts the convention into a CI invariant for ~20 lines of test. |
| SA-9 | No correlation ID propagation: HTTP requests lack request IDs in structured logs; pipeline stages correlate only via `capture_id` in `pipeline_events`. Adequate for pipeline debugging, weak for tracing a single web/MCP request across core-api → queue → worker → notification. | Low | `@open-brain/shared` logger, core-api middleware | Attach a per-request id (Hono middleware) to the pino child logger and pass it through job payloads as `meta.request_id`. Low effort; no tracing infrastructure needed. |
| SA-10 | Restore-rehearsal cron (`deploy/cron/unraid-restore-rehearsal.cron`, P16) was designed and documented but its install on the homeserver was still listed as pending ops in the last recorded session notes. If never installed, the recoverability NFR rests on an unrehearsed backup. **Requires Investigation** — live host state is out of review scope. | Requires Investigation | Unraid host crontab | Verify `/boot/config/plugins/dynamix/custom.cron` contains the rehearsal entry; if absent, run the documented install steps. Check the `backup_log` table for rehearsal records. |

---

## Evolution Assessment

The architecture has comfortable runway — roughly two-plus years of plausible requirements absorb cleanly:

- **New ingestion sources** are the most likely growth axis and the best-supported one: the pattern (adapter container or Python puller → `POST /api/v1/captures` with caller header → pipeline) has been exercised eight times already (slack, voice, email, files, financial, utility, mobile, mcp). Marginal cost of source #9 is low.
- **New skills/crons** slot into the BaseSkill + scheduler framework, constrained mainly by the convention-based slot registry (SA-8).
- **Search scale:** at single-user capture rates (~5–50/day on a ~11K base), pgvector HNSW with the LIMIT push-down holds for years. The first quantitative ceiling is the Postgres 8 GB `mem_limit` versus HNSW index working set, somewhere in the mid-hundreds-of-thousands of embedded rows — distant, and TDD §18.5 already plans for it.

**The first design element that becomes a constraint is not a component — it is the convention-enforcement model.** Correct evolution currently requires an operator (or agent) who reads and obeys ~40 CLAUDE.md lockstep rules: enum changes across six surfaces, dual bypass-caller registration, cron slot greps, init-schema parity, doc refresh. Every Medium/High finding above (SA-1, SA-2, SA-3, SA-5, SA-6, SA-8) is an instance of a convention that drifted despite exceptional discipline. The highest-leverage architectural investment is converting the top five conventions into CI-enforced invariants (drift-guard tests, schema-snapshot diff, cron-slot test) — after which the structure itself imposes no rewrite-class constraint within the planning horizon. Secondarily, a second concurrent human contributor or a second deployment host would stress the single-host, convention-heavy posture before any code structure does.

---

## Findings Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 1 |
| Medium | 2 |
| Low | 6 |
| Requires Investigation | 1 |
| **Total** | **10** |
