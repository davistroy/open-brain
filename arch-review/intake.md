# Intake Summary

**Target:** /home/davistroy/dev/personal/open-brain
**Date:** 2026-07-12
**Reviewer:** Review Lead (Architecture Review Team)
**Review generation:** v5 — supersedes the 2026-07-09 v4 review (v4 artifacts backed up at `~/dev/personal/open-brain-backups/arch-review-v4-20260709/`; v3 in git history)

> Method note: each domain agent must ADJUDICATE its v4 findings (fixed / still open / changed) from the backup path above before hunting for net-new findings. The only code landed since v4 is the Dependabot remediation (Entry 183, PRs #232–#234, deployed 2026-07-12) — so most v4 findings are expected to carry forward verbatim; verify rather than rediscover.

## System Description

Open Brain is a self-hosted, single-user personal AI knowledge platform (v1.6.0, first commit 2026-03-04). It ingests from voice memos (iOS Shortcut → voice-capture → faster-whisper), Slack (Socket Mode bot), documents (FastAPI extraction sidecar), email (Cloudflare Email Worker → brain@troy-davis.com), financial/utility pullers, and an Expo mobile app. Content lands in Postgres 16 + pgvector (`vector(768)`, OpenAI `text-embedding-3-large` at 768d) and is surfaced through hybrid FTS+vector search (RRF + ACT-R temporal decay + Hebbian boost + spreading activation), AI synthesis, weekly briefs, governance sessions, an embedded MCP endpoint (`/mcp`, 8 tools), and a Next.js 16 dashboard at brain.troy-davis.com (Cloudflare Tunnel). Production is **13 Docker Compose containers** on an Unraid homeserver (i7-9700, 128 GB, no GPU). Observability is delegated to a standalone shared `observability` compose project (ADR-0004, deployed 2026-07-01): shared Prometheus scrapes `core-api:3000/metrics`, workers push to `pushgateway:9091`, all services log to shared Loki via the Docker loki log-driver.

## Tech Stack

- **Languages/runtime:** TypeScript (Node 22 LTS, ESM, pnpm 9.15 workspaces — ~558 TS source files, ~98.5K LOC), Python 3.11–3.12 (voice-pipecat, file-ingestion, ingest-sidecar, ~40 ops scripts)
- **Packages:** `shared` (Drizzle schema, LLM gateway, config, logger), `core-api` (Hono + embedded MCP), `workers` (BullMQ, 25 skills, 21 cron jobs), `slack-bot` (@slack/bolt Socket Mode), `voice-capture` (Hono), `web-next` (Next.js 16 + React 19 + Cloudscape + TanStack Query — sole UI), `mobile` (Expo/RN, 11 screens), Python sidecars, plus Cloudflare edge workers (email-worker, synthetic-monitor) outside the workspace
- **Data:** Postgres 16 + pgvector (HNSW), Redis 7 (BullMQ), migrations through **0035** with generated `init-schema.sql` snapshot + two-DB CI parity diff + `schema_migrations` ledger (`migrate-manual.sh`)
- **AI:** OpenAI API primary (gpt-5.4 all aliases, text-embedding-3-large 768d); Anthropic for agent-loop skills; free local tiers t1_jetson (Qwen 3.5 4B) + t1_spark (Qwen 35B, DGX Spark); cost-tiered routing via `config/ai-routing.yaml` with budget circuit breaker ($30 soft / $50 hard)
- **CI/CD:** GitHub Actions — ci.yml (build+lint+unit, 3× pytest, ruff+pyright, init-schema parity, real-DB integration, doc-sync advisory), build-images.yml → 8 GHCR images, monthly-audit.yml. Required checks: `Integration tests (core-api + real DB)` + `build-and-test`. No CD — manual surgical deploys (`pull` + `up -d --force-recreate --no-deps <svcs>`) with a two-gate `docker compose config` diff procedure
- **Infra:** Cloudflare Tunnel ingress; Tailscale overlay; secrets exclusively in Bitwarden (`bws`) with load/verify/roundtrip-test scripts + CI redaction guards; postgres/redis run RAW binds pinned in host-only `docker-compose.override.yml` (ADR-0004 drift landmine disarmed 2026-07-01)

## Documentation Quality

Strong for a solo project (B+ per the 2026-07-12 /prime): 195KB TDD + 116KB PRD (both v0.7, stale since 2026-04-19), 4 ADRs (all Accepted), SLO.md, SECURITY.md (at docs/, not root), 12 runbooks (**deploy.md §5/§8 known-dangerous — see below**), LAB_NOTEBOOK.md (184 entries, decisions D1–D134, current through today), CLAUDE.md operational rules, OPEN_ITEMS.md (2 weeks stale), CHANGELOG (12 days behind). Gaps: no OpenAPI/API reference (Zod validators are the de-facto contract), no CONTRIBUTING.md (moot — single maintainer), README internal version contradiction (v0.6 vs v0.7 refs).

## Stated Requirements and SLOs

- Single-user; no auth/multi-tenancy by design. Origin allowlist + two-step token for destructive admin ops; rate-limit tiers with internal-caller bypass (`X-Open-Brain-Caller` + `BYPASS_CALLERS` lockstep, 17 entries); mobile Bearer tier (200 req/min per token hash).
- SLO.md: API p99 < 2.0s; search latency SLO; Prometheus rules + application-layer Pushover (no Alertmanager).
- Monthly AI budget: < $35 beyond Claude Max subscription; cost-tiered processing mandatory (T0 Python → T1 local LLM → T2 Claude CLI → T3 API).
- Pipeline retry: 5 attempts patient backoff + daily sweep. Memory ceiling 1.5 GB RSS/process.
- Backup: nightly local + daily 03:45 encrypted rclone-crypt offsite (30-day retention) + Sunday 05:30 restore rehearsal.

## Review Scope

- **In scope:** entire repository — all packages, scripts, config, compose topology, CI/CD, docs/runbooks, Cloudflare workers, migration/schema machinery; adjudication of every v4 finding plus net-new findings.
- **Out of scope:** live homeserver state (read-only review, no SSH), load testing, SAST/SCA beyond locally installed tooling, the standalone observability compose project (separate repo), the shared LiteLLM proxy.

## Pre-existing Known Issues

**v4 (2026-07-09) verdict: CONDITIONAL GO — C:1 H:13 M:49 L:49 (117 findings, 13 requires-investigation).** The four Go-conditions are ALL STILL OPEN as of this morning (verified by /prime today):

1. **PLT-C1/A134 (CRITICAL):** `docs/runbooks/deploy.md:192` overwrites then `:205` DELETES production `docker-compose.override.yml` on rollback — re-arms the ADR-0004 empty-DB landmine; §8 misattributes data to the `postgres_data` named volume. File untouched since 2026-06-30 (pre-ADR-0004).
2. **DA-1/A135 (HIGH, actively failing):** `packages/workers/src/jobs/data-retention-prune.ts:80-116` has no per-table isolation; `briefs.source_skill_log_id` FK (migration 0030, no ON DELETE) blocks the skills_log DELETE → SQLSTATE 23503 aborts the whole job. No migration 0036 exists. **Fix deadline (Sun 2026-07-12 02:00) passed unmet this morning — today's production run plausibly failed.**
3. **SEC-A1/A136 (HIGH):** voice-pipecat `docker-compose.yml:259` binds `"8765:8765"` (0.0.0.0), zero auth — any LAN socket can drive paid Deepgram+Anthropic pipelines outside the OpenAI-only budget breaker and inject captures.
4. **RC-10 (HIGH):** repo is PUBLIC with 250+ LAN/topology references (owner decision pending since Phase 10.4).

Other open v4 highs: QA-1 workers coverage dormant (73.72% < 78 floor — baseline now stale after the vitest 2→3 bump, re-measure), QA-2 ingest e2e off in CI, QA-3 web-next zero component tests, SW-H2/#204 runAgent no context budget (monthly-reflection 6.5M-token blowup; Entry 180's 120s timeout was a symptom patch), PLT-H1–H4 runbook/observability/backup gaps (no backup dead-man's switch; A131 first scheduled offsite/restore runs still unverified), SEC-A2 (RI) mobile Bearer auth architecturally unreachable behind the proxy.ts caller-header overwrite. Second `durationMs>0` timing flake at `weekly-brief.test.ts:261` (first at `drift-monitor.test.ts:724`).

**Since v4 (Entry 183, 2026-07-12):** Dependabot remediation deployed — 3 isolated waves (transitive lockfile refresh; nodemailer 8→9; vitest 2→3 + coverage-v8 lockstep), 119→20 open alerts, 0 critical; all 5 app services recreated at `sha-31bc56c`, postgres/redis untouched. Residual: `vite` dev-scope high (A139), 29 pnpm-audit advisories (2 high, 24 moderate — all dev/transitive), 9 new grouped Dependabot PRs (#235–#243) open awaiting triage.

**Open GitHub issues (11):** #226 (fixed by #230 but never closed — v4 said close it), #217 orphan repeat-jobs on cron changes, #204 monthly-reflection context blowup, #207 hydration risks (cosmetic), #200 dashboard failures investigation, #196 mobile deferred scope, #73/#72/#71/#57/#54 (scale/hardware/voice deferrals).

**Working-tree state at review start:** LAB_NOTEBOOK Entry 184 added for this run; 3 untracked AppleDouble `._*` files (no `.gitignore` entry for `._*`); v4 arch-review artifacts being regenerated by this review.
