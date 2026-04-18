# Architecture Review — Executive Summary

**System:** Open Brain — Self-hosted personal AI knowledge infrastructure
**Target:** `C:/Users/Troy Davis/dev/personal/open-brain` (main @ `9443f93`, deployed to homeserver)
**Review Date:** 2026-04-18
**Review Lead:** Architecture Review Team (9 parallel specialists)
**Scope:** Full monorepo (8 TypeScript packages, ~78K LOC; Python sidecar + voice-pipecat + file-ingestion; Docker Compose stack; CI; docs; DB schema + 23 migrations). Excluded: `data/` (gitignored PII), archived plans.

---

## Review Coverage

| Domain | Confidence | Runtime | Key Tools Available | Key Tools Missing | Findings (C/H/M/L/Inv) |
|--------|-----------|--------:|---------------------|-------------------|------------------------|
| Solutions Architect | High | 521 s | — (code read only) | cloc, tokei, plantuml | **1 / 5 / 8 / 4 / 0** (18) |
| Data Architect | High | 329 s | — | psql, sqlite3, mongosh, redis-cli | **0 / 3 / 7 / 5 / 2** (17) |
| Integration Architect | High | 409 s | curl | jq, openapi-generator, spectral | **0 / 3 / 6 / 6 / 1** (16) |
| Software Engineer | High | 548 s | ruff, pyright (both clean) | cloc, eslint, lizard, radon, semgrep | **0 / 3 / 6 / 6 / 0** (15) |
| Performance Engineer | **Medium** | 195 s | — | k6, ab, wrk, hey, vegeta | **1 / 4 / 6 / 3 / 0** (14) |
| QA Architect | High | 305 s | pytest | jest, vitest (PATH), playwright, nyc | **0 / 4 / 6 / 5 / 0** (15) |
| Security Architect | Medium-High | 425 s | pip-audit (7 vulns) | semgrep, bandit, eslint, trivy, safety | **0 / 2 / 5 / 6 / 1** (14) |
| Platform Engineer | High | 262 s | docker, kubectl | terraform, helm | **0 / 3 / 6 / 3 / 0** (12) |
| Risk & Compliance | High | 384 s | git | jq | **0 / 3 / 6 / 5 / 0** (14) |
| **Totals** | — | **55 min total** | — | — | **2 / 30 / 56 / 43 / 4 (135)** |

### Coverage Notes
- **No live-runtime inspection** was performed. All 9 agents are static-analysis of the repo. Homeserver-side verification (actual RSS, pg_stat_statements, live cron, Loki ingestion, Postgres at-rest encryption, Composio call volume) would tighten several Medium findings into confirmed ones.
- **No SAST tooling** on the Windows review host (semgrep, bandit, eslint, trivy all absent). Security + Software Engineer findings rely on grep + manual inspection. **This is a review-environment gap, not a system gap.**
- **No load-testing tools** — Performance findings are structural risk identification, not measured violations. Validate with k6/wrk on homeserver before investing in mitigation.
- **Performance confidence rated Medium** — all others High or Medium-High. Performance findings should be prioritized by actual measurement before expensive remediation.

---

## Go / No-Go Recommendation

**Recommendation: CONDITIONAL GO for continued production use.**

**Rationale:** The system is already in daily production use by its single operator and shows strong engineering discipline (`0 @ts-ignore` in production, `1 as any` outside tests, consistent structured logging, solid MCP auth with timing-safe comparison, healthcheck hygiene, drift-guard tests, LAB_NOTEBOOK decision record with 90 entries). However, **2 Critical and 30 High findings cluster around a single theme — cost-tracking and budget enforcement — that already caused a $100 Anthropic overage on 2026-04-15**. The remediation there is the same mechanism that failed; without it, the incident can recur silently. Additionally, the 1.5 GB RSS rule codified in CLAUDE.md is not actually enforced at the Docker layer for most containers, meaning a single runaway process can destabilize the homeserver.

**Conditions (must remediate within 30 days):**
1. Close all Theme 1 findings (cost-tracking — see Roadmap Immediate)
2. Close Theme 2 (mem_limits on all containers)
3. Close Theme 4 (`/admin/reset-data` blast radius)
4. Close Theme 13 (`init-schema.sql` completeness — volume recreation would brick the system today)

---

## Critical and High Findings Summary

**2 Critical / 30 High** — ordered by business impact (catastrophic-loss frame for a personal single-user system).

| ID | Domain | Severity | Finding | Impact | Effort |
|----|--------|----------|---------|--------|--------|
| **SOL-C1** | Solutions | **Critical** | `config/ai-routing.yaml` cost fields have no startup Zod validation; paid-provider tiers can have null `cost_per_1k_*` and the budget circuit breaker becomes blind. Exactly the 2026-04-15 $100 Anthropic incident mechanism. Mitigation is a human-dependent CLAUDE.md rule, not code. | $$$ runaway recurrence | S (~1 d) |
| **PERF-P1** | Performance | **Critical** | 9 of 12 containers lack `mem_limit` — directly violates 1.5 GB CLAUDE.md hard rule. No `--max-old-space-size` on Node containers. On a 128 GB host with runaway process risk (entity extraction, bulk embedding), one OOM can destabilize the entire stack. | Host OOM | S (~4 h) |
| SOL-H1 | Solutions | High | `estimateTierCostUsd()` in `llm-gateway.ts:38-41` hardcoded to return 0 for `openai_compat`/`litellm`/`openai` tiers → `ai_audit_log.cost_usd` perpetually 0 for those; local budget breaker effectively disabled, only optional external `LLM_SPEND_URL` provides real metering. | Same as SOL-C1 | S (~2 h) |
| SW-H1 | Software | High | `callClaude()` fallback path in 5 skills bypasses `ai_audit_log` + budget check entirely. Combined with SOL-H1, reproduces the root cause of 2026-04-15 cost incident. | $$$ runaway | S (~1 d) |
| INT-H1 | Integration | High | `memory-consolidation` + `weekly-brief` fall back to raw Anthropic/OpenAI SDK, bypassing gateway's budget + audit + tier fallback. | $$$ runaway, blind cost | M (2 d) |
| RISK-H3 | Risk | High | **Autonomy gating is false-uniform.** CLAUDE.md claims autonomy levels gate all proactive features; `meetsAutonomyLevel()` is only called in `slack-bot/src/handlers/auto-response.ts`. `email-compose` auto-send, `memory-consolidation`, `daily-sweep-skill`, `weekly-brief` run regardless of `app_settings.autonomy_level`. | Safety-model broken | M (1-2 d) |
| SEC-S01 | Security | High | **Prompt injection via capture content.** `synthesize.ts` concatenates raw capture bodies into LLM prompts with no delimiters. Any email from allowlisted sender, any document, any Slack capture becomes an instruction vector for downstream synthesis/skills. | Data exfil + autonomy abuse | M (2-3 d) |
| SEC-S04 | Security | High | `POST /admin/reset-data` is CSRF-able — no Bearer (by design, web UI can't send), only JSON confirmation phrase behind Cloudflare Access. Logged-in browser can be tricked into wiping DB. | Data destruction | S (1 d) |
| RISK-H2 | Risk | High | `/admin/reset-data` publicly tunnel-exposed; one POST TRUNCATEs captures/entities/sessions/ai_audit_log. No pre-wipe backup, no admin audit row, no staged confirmation. | Data destruction (+ recovery impossible) | S (1 d) |
| SOL-H3 | Solutions | High | `/admin/reset-data` deliberately skips `adminAuth` (documented) — same concern as SEC-S04, RISK-H2. | See above | — (dup) |
| DATA-H1 | Data | High | `backup.sh:79-81` copies `.env.secrets` into backup payload on same-host dir. One read of `/mnt/user/backup/openbrain/` = full credential exfiltration. | Credential compromise | S (~1 h) |
| RISK-H1 | Risk | High | Same `.env.secrets` in backup path — duplicate of DATA-H1 (cross-validated). | See above | — (dup) |
| DATA-H2 | Data | High | **No backup restore rehearsal.** No CI or cron validates `pg_restore` on `pg_dump` artifacts. HNSW rebuild time on restore will matter at scale. | Unrecoverable data loss | M (2 d) |
| PLAT-F3 | Platform | High | No image registry, no rollback path. Images built on homeserver from source; reverting = git-revert + multi-minute rebuild while prod is down. | Extended RTO on bad deploy | M (3-4 d) |
| PLAT-F1 | Platform | High | `scripts/load-secrets.sh` is a **stub**. `.env.secrets` populated by manual `bws secret get` copy-paste; no reconciliation with Bitwarden source of truth. | Secret drift + deploy opacity | S (~4 h) |
| PLAT-IaC | Platform | High | Prometheus/Grafana/Loki/Pushgateway/Ollama/Gitea live outside `docker-compose.yml` — deploy is imperative via `scripts/deploy-loki.sh` + standalone `docker run`. `post-compose-up.sh` re-attaches after each `compose up`. IaC coverage gap. | Ops fragility | L (1 wk) |
| SOL-H4 | Solutions | High | `scripts/init-schema.sql` stops at migration 0017 — 5 migrations missing (0018-0022). **Postgres volume recreation would leave the system broken** with no auto-migration on startup. | Catastrophic restore failure | S (~2 h) |
| SOL-H5 | Solutions | High | Systemic doc drift: `package.json` v1.2.0, `CHANGELOG.md` latest [1.2.0], `CLAUDE.md` says v1.5.0; PRD v0.6 + TDD v0.6 still describe LiteLLM proxy as central AI router (198 combined occurrences) though LiteLLM was retired in CS5 on 2026-04-17. New contributors (or future-you in 3 months) build against fiction. | Architectural confusion | M (2-3 d) |
| SOL-H2 | Solutions | High | Unauthenticated capture writes rely on Cloudflare Access as the only gate. No auth at the application layer. | Aligned with single-user model; still surfaces if CF Access is misconfigured | M (4-6 h) |
| PERF-P2 | Performance | High | **Hebbian access-stats queue has a consumer but NO producer in core-api.** Hebbian `access_count`, `last_accessed_at`, and `capture_associations` are NEVER populated. **The entire cognitive-memory layer shipped in 2026-04-09 is dormant.** | Feature not working | M (1-2 d) |
| PERF-P3 | Performance | High | `pruneStaleAssociations()` exists + tested but never scheduled. Will cause unbounded growth once PERF-P2 is fixed. | Future perf cliff | S (~2 h) |
| PERF-P4 | Performance | High | Hebbian upsert = 45 serial `INSERT…ON CONFLICT` statements per search. Needs batching. | Latency on hot path | S (~4 h) |
| PERF-P5 | Performance | High | `hybrid_search` vector CTE has no `LIMIT` push-down — scans every embedded capture with `ROW_NUMBER()` over all rows. Biggest scaling cliff as corpus grows toward 100K. | Search latency cliff at scale | M (~1 d) |
| INT-H2 | Integration | High | Composio MCP (20K/month free-tier cap) has **no usage metering**. Same failure-mode class as the 2026-04-15 LLM cost incident — external hard quota, zero visibility in code. | Silent quota blow-out | S (~4 h) |
| INT-H3 | Integration | High | Internal HTTP callers (slack-bot CoreApiClient, voice-capture IngestService, memory-consolidation) inconsistently set `X-Open-Brain-Caller` header — share `default-client` rate-limit bucket, **can 429 each other under load**. | Self-induced outages | S (~2 h) |
| QA-H1 | QA | High | Claimed test count (1,569 unit + 95 regression) ≠ actual (2,689 unit + 91 regression). README/intake drift. | Doc accuracy | XS (~30 min) |
| QA-H2 | QA | High | Integration, E2E, and regression suites are **not CI-gated** — only unit tests + sidecar pytest + python lint. `scripts/regression-test.mjs` (91 TC-IDs) runs manually. | Missed regressions reach prod | M (1-2 d) |
| QA-H3 | QA | High | `voice-pipecat` + `file-ingestion` pytest suites **not in CI** at all. | Silent test rot | S (~4 h) |
| QA-H4 | QA | High | **No config-contract test against `ai-routing.yaml`.** Exactly the gap behind the 2026-04-15 $100 cost incident (zero `cost_per_1k_*` fields). Overlaps with SOL-C1 mitigation. | Same as SOL-C1 | S (~4 h) |
| SW-H2 | Software | High | Drift-guard (PR #97) covers `IngestSourceType`+`FileUploadStatus` but not `CaptureSource` — missed the `'system'` value in this week's pre-flight audit; web `SearchFilters.tsx:10` still has stale 6-value literal array. | Future contract drift | XS (~1 h) |
| DATA-H3 | Data | High | Same finding as SW-H2 — cross-validated. Web UI filter shows 3 fewer options than DB contains. | See above | — (dup) |
| SW-H3 | Software | High | `packages/workers/src/jobs/skill-execution.ts` is 540 LOC with 20-case `switch` — replace with self-registering skill registry (clean extension when skills are added). | Future maintenance | M (1 d) |
| DATA-Schema | Data | High/Med | Three concrete Drizzle↔SQL drifts: `voice_sessions.captures_created` (text[] in Drizzle vs UUID[] in migration), `ai_audit_log.client_used` default still `'litellm'` post-CS5, `content_hash` unique index non-partial (blocks re-capture after soft-delete). | Runtime mismatches + UX bugs | S (~4 h) |
| PLAT-Mem | Platform | High | Missing `mem_limit` on core-api, workers, slack-bot, web, postgres, redis, voice-capture, cloudflared, financial-ingest, utility-ingest — only 4 services declare ceilings. Overlaps PERF-P1 (Critical) but Platform rated High because cascading risk is lower without load spike. | OOM + contention | S (~4 h) |

---

## Cross-Domain Risk Map

Findings cluster into **17 distinct themes**. The top-4 are load-bearing for the conditional-GO recommendation:

### Theme 1 — Cost-tracking is a paper tiger 🔥 **(the $100 incident pattern is still live)**
- **SOL-C1** (Critical) — no startup validation of `ai-routing.yaml` cost fields
- **SOL-H1** — `estimateTierCostUsd()` returns 0 for openai_compat/litellm/openai tiers
- **SW-H1** — `callClaude()` fallback in 5 skills bypasses `ai_audit_log`
- **INT-H1** — `memory-consolidation` + `weekly-brief` bypass gateway entirely
- **QA-H4** — no config-contract test against `ai-routing.yaml`
- **RISK-M** — no regression test for zero `cost_per_1k_*` fields
- **Risk:** Silent recurrence of the 2026-04-15 $100 Anthropic incident. The PR #101 CLAUDE.md rule ("pre-flight DB audit is MANDATORY") addresses a different gap (schema) but not this one (config). 
- **Root-cause fix:** Zod config validation at startup + widen `estimateTierCostUsd` to cover all paid providers + remove `callClaude` legacy path + add config-contract test + Composio quota meter (see Theme 2).

### Theme 2 — External quotas have no meter
- **INT-H2** — Composio 20K/month cap unmetered
- Related: Anthropic + OpenAI spend metering depends on optional `LLM_SPEND_URL`, not consistently configured
- **Risk:** Same class as the $100 incident but wearing a different hat — any external hard quota without instrumentation is a time-bomb.

### Theme 3 — Resource-ceiling enforcement is aspirational, not mechanical
- **PERF-P1** (Critical) — 9 of 12 containers lack `mem_limit`
- **PLAT-Mem** (High) — 10 services missing mem_limit (Platform counts financial-ingest/utility-ingest separately)
- **Consensus across Performance + Platform.** CLAUDE.md mandates 1.5 GB RSS/process; Docker enforces none of it.

### Theme 4 — Admin blast radius
- **SEC-S04** (High) — `/admin/reset-data` CSRF-able
- **RISK-H2** (High) — same endpoint, no pre-wipe backup, no staged confirmation, no audit row
- **SOL-H3** (High) — `/admin/reset-data` intentionally skips `adminAuth`
- **3-way consensus.** One POST destroys the DB.

### Theme 5 — Backup/recoverability gaps
- **DATA-H1** / **RISK-H1** — `.env.secrets` copied into backup payload on same host
- **DATA-H2** — no restore rehearsal
- **PLAT-F3** — no image registry, no rollback path
- **Consensus across Data + Risk + Platform.** On a credential or data loss event, the system cannot be trusted to recover cleanly.

### Theme 6 — Autonomy safety-model is incomplete (RISK-H3, unique)
CLAUDE.md claims autonomy levels gate all proactive features. Reality: `meetsAutonomyLevel()` is called in exactly ONE file (`slack-bot/src/handlers/auto-response.ts`). `email-compose` auto-send, `memory-consolidation`, `daily-sweep-skill`, `weekly-brief` all run regardless of `app_settings.autonomy_level`. Either enforce it uniformly (pass `llmGateway.checkAutonomy('proactive')` into `BaseSkill.execute()`) or reframe the docs.

### Theme 7 — Cognitive memory is dormant (PERF-P2, P3, P4, unique)
The Hebbian access-stats producer doesn't exist in core-api. The consolidation skill runs but no data populates `capture_associations` or `access_count`. The "Cognitive Memory shipped 2026-04-09" feature in README is not actually operational.

### Theme 8 — CaptureSource drift + drift-guard gap
- **SW-H2** / **DATA-H3** — web `SearchFilters.tsx:10` has stale 6-value literal despite TS union fix this week
- This is a direct recurrence of the gap that produced this week's pre-flight-audit discovery of the 9th `'system'` value.

### Theme 9 — Doc drift (SOL-H5, unique)
Version numbers, PRD/TDD, README all drift from code reality. Acute: PRD/TDD still describe LiteLLM proxy.

### Theme 10 — Search perf cliff at scale
- **PERF-P5** — `hybrid_search` vector CTE no LIMIT push-down
- **PERF-P6** — `hnsw.ef_search` never set (default 40)
- Currently ~11K embeddings; will hurt at 100K (Qdrant migration trigger threshold per MEMORY D67).

### Theme 11 — Observability stack is partial
- **PLAT-F5** — Loki log driver not wired (no `logging:` blocks in compose)
- **PLAT-Alerts** — zero Prometheus alert rules
- Stack deployed (deploy-loki.sh + post-compose-up.sh) but not ingesting and not alerting.

### Theme 12 — init-schema.sql incomplete (SOL-H4, unique)
Postgres volume loss + no auto-migrate = 5 missing migrations = non-functional system. Would require an hour of manual SQL on recovery day.

### Theme 13 — Rate-limit self-contention (INT-H3)
Internal callers share `default-client` bucket — Slack → core-api + voice-capture → core-api + memory-consolidation → core-api can 429 each other under load.

### Theme 14 — CI gating gaps (QA-H2, QA-H3)
Integration/E2E/regression suites + voice-pipecat + file-ingestion pytest are not CI-gated. The "1,569 tests passing" claim is green in CI but is missing several thousand lines of non-unit test coverage.

### Theme 15 — Prompt injection (SEC-S01, unique)
Capture content → LLM prompts with no delimiter or sanitization. Single-user risk is bounded (attacker needs email/Slack/document ingress) but the allowlist is populated by the user; a compromised allowlisted account is game-over.

### Theme 16 — Scheduled job thunderstorm (SOL-M5, unique)
19 scheduled jobs stacked around 07:00 with no concurrency limit. Daily resource-spike at a predictable time.

### Theme 17 — Secret delivery opacity (PLAT-F1)
`scripts/load-secrets.sh` is a stub; `.env.secrets` populated by manual copy-paste from Bitwarden. No reconciliation, no drift detection between BWS and the deployed env.

---

## Remediation Roadmap

### Immediate — Block any further autonomous features until addressed (Critical + top cost-leakage) — ~4 days
1. **Theme 1 cost-tracking** (SOL-C1, SOL-H1, SW-H1, INT-H1, QA-H4, RISK-M): Zod startup validation of cost fields + widen `estimateTierCostUsd` + remove `callClaude` fallback + config-contract test. **~2 days combined.** Owning domain: Solutions.
2. **Theme 3 mem_limits** (PERF-P1, PLAT-Mem): add `mem_limit` to all 10-12 Docker services per CLAUDE.md 1.5 GB rule + `--max-old-space-size` on Node containers. **~4 hours.** Owning domain: Platform.
3. **Theme 4 admin blast radius** (SEC-S04, RISK-H2, SOL-H3): add pre-wipe backup + admin audit row + staged 2-step confirmation on `/admin/reset-data` (keep public-tunnel-exposed but make it safe-by-design). **~1 day.** Owning domain: Security.
4. **Theme 12 init-schema.sql** (SOL-H4): Generate init-schema.sql from current Drizzle schema (not frozen at 0017). Wire into CI as a check: `scripts/init-schema.sql` must reflect the current schema + all applied migrations. **~2 hours.** Owning domain: Data.

### Short-term — Resolve within 30 days — ~6 days
5. **Theme 5 backup hygiene** (DATA-H1, RISK-H1, DATA-H2, PLAT-F3): redact `.env.secrets` from backup script; wire a weekly `pg_restore` rehearsal into a CI workflow or homeserver cron; stand up a minimal image registry (GitHub Container Registry is free + already authenticated). **~3 days.**
6. **Theme 6 autonomy uniform** (RISK-H3): plumb `checkAutonomy('proactive')` through `BaseSkill.execute()` so every proactive skill honours `app_settings.autonomy_level`. Add unit test per skill verifying gate behavior. **~2 days.**
7. **Theme 7 cognitive memory producer** (PERF-P2, P3, P4): wire the missing Hebbian producer in core-api search path + schedule `pruneStaleAssociations()` + batch the 45-INSERT upsert. **~2 days.**
8. **Theme 2 Composio metering** (INT-H2): Redis counter keyed per-day + Pushover alert at 15K/20K. **~4 hours.**
9. **Theme 8 drift-guard for CaptureSource** (SW-H2, DATA-H3): extend PR #97 drift-guard regex + fix web `SearchFilters.tsx:10`. **~1 hour.**
10. **Theme 13 rate-limit discipline** (INT-H3): every internal caller sets `X-Open-Brain-Caller`; nginx strips client-set version; BYPASS_CALLERS updated. **~2 hours.**

### Medium-term — Resolve within 90 days — ~2 weeks calendar
11. **Theme 10 search perf** (PERF-P5, P6): add LIMIT push-down to vector CTE; set `hnsw.ef_search` explicitly (benchmark 40/60/80 recall).
12. **Theme 11 observability** (PLAT-F5, PLAT-Alerts, PLAT-IaC): bring Loki/Grafana/Prometheus/Pushgateway into main compose; wire Docker logging driver; write alert rules for budget-breaker trips, auto-sweep failures, container OOM, queue depth.
13. **Theme 14 CI gating** (QA-H2, QA-H3): wire integration + regression + voice-pipecat + file-ingestion pytest into CI (separate job allowed — observe before required). **~1-2 days.**
14. **Theme 15 prompt injection** (SEC-S01): delimiter + sanitization wrapper on all capture→LLM prompts; consider an LLM-based content classifier for suspicious imports.
15. **Theme 17 secret delivery** (PLAT-F1): actual `load-secrets.sh` implementation that reconciles `.env.secrets` with `bws secret list` output at deploy time.
16. **Theme 9 doc drift** (SOL-H5): single `scripts/sync-docs.sh` that validates version numbers across `package.json`/`CLAUDE.md`/`README.md` match + kills LiteLLM references in PRD/TDD.

### Opportunistic (Low severity — 43 findings across domains)
- **Software:** decompose `scripts/financial-pipeline.py` god module (3,035 LOC, SW-M1); skill-execution switch → registry (SW-H3 — could be short-term).
- **Integration:** dedupe CHECK constraint + Zod + TS union into a single source of truth; unify HTTP error handling; MCP auth → per-tool scope model.
- **Data:** remove legacy `client_used: 'litellm'` default; partial-index `content_hash` for soft-delete re-capture; switch `voice_sessions.captures_created` to UUID[].
- **Platform:** CODEOWNERS (low value for single-user); dependabot.yml; non-root container users.
- **QA:** add SAST (semgrep/bandit) to CI; load/soak tests for RSS-ceiling validation.
- **Security:** dependabot (2 H already covered); lower-impact S-findings (email allowlist tightening, XSS content-type headers).
- **Risk:** provider-terms runbook (zero-retention/training-opt-out posture); admin audit table; hard-delete cron for soft-deleted captures.
- **Performance:** connection pool raised to match worker concurrency; aggregation batch sizes for access-stats.
- **Scheduled job spreading:** (SOL-M5) spread the 19 07:00 jobs across the hour.

---

## Risk Acceptance Register

Findings the operator may explicitly choose to accept given the single-user, self-hosted context:

| Finding | Domain | Severity | Acceptance Rationale | Notes |
|---------|--------|----------|---------------------|-------|
| SEC-S04 / RISK-H2 / SOL-H3 (`/admin/reset-data` design) | Sec/Risk/Sol | High | The endpoint is deliberately unauth at app layer because the web UI cannot send Bearer tokens. Cloudflare Access + confirmation phrase is the chosen control. | **Don't accept without the pre-wipe backup + audit row from Theme 4 roadmap.** The design choice can stand if the safety rail is actually there. |
| SOL-H2 (unauthenticated capture writes) | Sol | High | Single-user system. Cloudflare Access is the only line. | Accept if CF Access is monitored; reconsider if CF Access configuration ever drifts. |
| PLAT-Backup-Offsite | Plat | Medium | Homeserver-local backup only (cron on VM). | Acceptable given backups are operator-proximate; however DATA-H2 (rehearsal) and DATA-H1 (secrets redaction) must still be closed. |
| SW-M1 (`financial-pipeline.py` 3,035 LOC) | SW | Medium | Ops script, not production hot-path. | Defer decomposition until next change to financial pipeline code. |
| PERF-P5 (vector CTE no LIMIT) | Perf | High | Current corpus is 11K embeddings — hundreds of ms, not seconds. | **Time-bound acceptance** — fix when embedding count crosses 50K or when Qdrant migration is evaluated. |

---

## Domain Report Index

| Domain | File | Findings |
|--------|------|----------|
| Solutions Architect | `arch-review/findings/solutions-architect.md` | 18 |
| Data Architect | `arch-review/findings/data-architect.md` | 17 |
| Integration Architect | `arch-review/findings/integration-architect.md` | 16 |
| Software Engineer | `arch-review/findings/software-engineer.md` | 15 |
| QA Architect | `arch-review/findings/qa-architect.md` | 15 |
| Performance Engineer | `arch-review/findings/performance-engineer.md` | 14 |
| Security Architect | `arch-review/findings/security-architect.md` | 14 |
| Risk & Compliance | `arch-review/findings/risk-compliance.md` | 14 |
| Platform Engineer | `arch-review/findings/platform-engineer.md` | 12 |
| **Total** | — | **135** |

Coverage meta: `arch-review/findings/.meta.json`

---

## Closing Note

**Strong points worth preserving:**
- MCP Bearer auth (timing-safe, fail-closed, never logged)
- Bitwarden-only secret storage (no committed secrets in git history)
- `0 @ts-ignore` in production; `1 as any` outside tests
- Healthcheck discipline (`127.0.0.1` not `localhost` — CLAUDE.md rule is real)
- Drift-guard pattern is genuinely clever and worth extending (Theme 8)
- LAB_NOTEBOOK as a primary architectural record (90 entries, decision log, hypothesis/rollback for every non-trivial action)
- `BaseSkill` + `LLMSkill` inheritance eliminates boilerplate
- `@open-brain/shared` consolidation (logger, Pushover, HTTP helpers, model-resolver)
- Cost-tiered processing **policy** is well-articulated in CLAUDE.md — the gap is mechanical enforcement, not design

**The single most impactful change** this review would recommend: invest **1 focused day** in Theme 1 cost-tracking. Every mechanism that should have caught the 2026-04-15 $100 incident is still broken. Zod validation + audit log closure + config-contract test is a few hundred LOC and would prevent the next incident class before it happens.
