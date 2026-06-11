# Intake Summary

**Target:** /home/davistroy/dev/personal/open-brain
**Date:** 2026-06-10
**Reviewer:** Review Lead (Architecture Review Team)

> Note: this supersedes the prior 2026-04-18 review (whose remediation shipped via PRs #180–#189 and the 2026-05-09 cohesive remediation). All findings files in this directory are regenerated as of 2026-06-10.

## System Description

Open Brain is a self-hosted, single-user personal AI knowledge infrastructure (v1.6.0, deployed 2026-05-09) running on an Unraid home server (Intel i7-9700, 128 GB RAM, no GPU). It ingests information from voice memos (iOS Shortcut → faster-whisper), Slack (Socket Mode bot), documents (FastAPI extraction sidecar), email (Cloudflare Email Worker → brain@troy-davis.com), financial/utility data pullers, and a mobile Expo app. Content is stored in Postgres 16 + pgvector (`vector(768)`), embedded via OpenAI `text-embedding-3-large` (768d MRL), and surfaced through hybrid FTS+vector search (RRF + ACT-R temporal decay + Hebbian boost + spreading activation), AI synthesis, weekly briefs, governance sessions, an MCP endpoint (8 tools embedded in core-api at `/mcp`), and a Next.js 16 web dashboard at brain.troy-davis.com (Cloudflare Tunnel).

## Tech Stack

- **Languages/runtime:** TypeScript (Node 22 LTS), Python (file-ingestion sidecar, ingest pullers, voice-pipecat)
- **Frameworks:** Hono (API), Drizzle ORM, BullMQ + Redis (pipeline), Next.js 16 + React 19 + Cloudscape + TanStack Query (web), Expo/React Native (mobile), @slack/bolt (Slack), Pipecat (realtime voice), FastAPI (extraction sidecar)
- **Database:** Postgres 16 + pgvector (`pgvector/pgvector:pg16`), migrations via Drizzle + drizzle-kit (0000–0030)
- **AI:** OpenAI API exclusively in production path (`gpt-5.4` inference, `text-embedding-3-large` @768d); cost-tiered routing config (`config/ai-routing.yaml`) with free local tiers (Jetson, DGX Spark) optional; Deepgram for realtime voice STT
- **Infra:** Docker Compose (17 containers, single `open-brain` network), Cloudflare Tunnel + Email Workers, observability stack (Loki via Docker loki log driver, Prometheus, Pushgateway, Grafana)
- **CI/CD:** GitHub Actions (`.github/workflows/ci.yml`) — lint/typecheck/test per package, integration tests (core-api + workers) against real DB via `docker-compose.test.yml`; branch protection on `main` requires "Integration tests (core-api + real DB)"
- **Secrets:** Bitwarden Secrets Manager (`bws` CLI); `.env.secrets` rebuilt via `scripts/load-secrets.sh`; backup script redacts secrets with regression guard
- **Monorepo:** pnpm workspaces — packages: `shared`, `core-api`, `workers`, `slack-bot`, `voice-capture`, `voice-pipecat`, `file-ingestion`, `web-next`, `mobile`

## Documentation Quality

Extensive and current: `docs/PRD.md` (v0.7, 2,014 lines), `docs/TDD.md` (v0.7, 4,513 lines), `README.md` (full architecture + container table), `CHANGELOG.md`, `LAB_NOTEBOOK.md` (162+ entries — experiment log with decision log), `OPEN_ITEMS.md` (one-page pending-work index), `USER_TEST_PLAN.md` (1,804 lines / 147 manual test cases), one ADR (`ADR-0001-web-consolidation.md`), 10 operational runbooks (`docs/runbooks/`), `docs/SECURITY.md`, deployment/setup guides. Project `CLAUDE.md` encodes ~40 verified operational rules. Archived implementation plans in `docs/archived/`.

## Stated Requirements and SLOs

- Single-user system — explicitly no auth/multi-tenancy inside the trust boundary; perimeter protection via Cloudflare Tunnel/Access, origin allowlists, rate-limit tiers, and Bearer tokens for MCP/mobile.
- Monthly AI budget: soft $30 alert, hard $50 circuit breaker; total beyond Claude Max subscription < $35/month (cost-tiered T0→T3 processing is a mandatory convention).
- Memory ceiling 1.5 GB RSS/process (user-level standard); container limits: faster-whisper 8 GB, Postgres 8 GB.
- Pipeline retry: 5 attempts, patient backoff (30s→2h) + daily sweep. No formal latency SLOs documented; search perf tuned via `hnsw.ef_search` benchmarks (LAB_NOTEBOOK Entry 108).

## Review Scope

**In scope:** entire monorepo — all 9 packages, Docker/compose infra, config YAMLs, scripts (backup/DR/secrets), CI workflows, migrations/schema, MCP surface, Cloudflare workers, observability config, docs.
**Out of scope:** live homeserver runtime state (review is static analysis of the repo), external services' internals (OpenAI, Cloudflare, Bitwarden), the separate LiteLLM proxy at llm.k4jda.net, OpenClaw integration on bond.

## Pre-existing Known Issues

Tracked in GitHub issues (10 open as of 2026-05-09) + `OPEN_ITEMS.md`:
- A130 — ESLint 9 + flat-config migration pending (`eslint-config-next` pinned)
- `scripts/init-schema.sql` missing migrations 0012/0028/0030 (drift between bootstrap schema and migration chain)
- A128/A116/A117/A106/A120 — accepted pre-existing baselines
- P23 data-gated (~2026-05-17 earliest), P24/P25 manual ops, P33 scale-gated, P34 hardware-gated
- Known accepted posture: `POST /admin/reset-data` has no Bearer auth (compensating controls: origin allowlist + two-step token + confirmation phrase + rate limit); workers coverage gate pinned at lines 78% / functions 81% floor.
- Prior full arch review (2026-04-18) findings were remediated via the post-remediation plan (PRs #180–#189); re-verify rather than re-report items already closed there.
