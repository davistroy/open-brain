# Intake Summary — Open Brain

**Target:** `C:/Users/Troy Davis/dev/personal/open-brain` (main branch, HEAD `9443f93`, deployed to homeserver)
**Date:** 2026-04-18
**Reviewer:** Architecture Review Team (9-agent parallel review)

---

## System Description

**Open Brain** is a self-hosted personal AI knowledge infrastructure for a single user (Troy Davis). It ingests information from voice memos (iOS Shortcut), Slack messages, documents, emails (Cloudflare Email Worker → `brain@troy-davis.com`), and file-system inventories; stores captures in Postgres+pgvector with hybrid search (FTS + vector + RRF + ACT-R temporal decay + Hebbian co-access); exposes search/synthesis via MCP (Streamable HTTP at `brain.troy-davis.com/mcp`), a web dashboard, a Slack bot, and a voice conversational interface (Pipecat).

The system implements **cost-tiered processing** (T0 Python → T1 local LLM → T2 Claude Code CLI → T3 paid API) with budget caps, a **cognitive memory model** (Hebbian learning, spreading activation, memory consolidation), **proactive intelligence** (autonomy levels: observe/assist/advise/partner, auto-response, daily sweeps, weekly briefs), and **batch source pipelines** (email classification, financial account monitoring, utility-bill ingestion).

**Production status:** All 25 core phases + cognitive memory + email pipeline + web synthesis + proactive intelligence + cost-tiering refactor shipped. 13 containers live on Unraid homeserver, reachable via Cloudflare Tunnel. 2,689 unit + 91 regression tests passing. Active daily use by a single operator.

**Version:** 1.2.0 (per `package.json`)

## Tech Stack

**Languages:** TypeScript (~78K LOC across 8 packages), Python 3.12 (sidecar + voice-pipecat + file-ingestion + ~20 ops scripts), SQL (Drizzle + hand-written migrations).

**Frontend:** Vite + React + shadcn/ui + Tailwind + PWA (served via nginx in `open-brain-web` container). Deliberately NOT Next.js. Web bundle is standalone — does NOT runtime-import `@open-brain/shared`; type parity enforced via drift-guard regex tests.

**Backend:**
- **Hono** framework for `core-api` (routes + MCP at `/mcp` Streamable HTTP)
- **@slack/bolt** Socket Mode for `slack-bot`
- **BullMQ + Redis** for `workers` (pipeline jobs, skills, scheduled tasks)
- **Drizzle ORM** for schema + migrations (NOT Prisma; NOT Supabase)
- Pipecat (Python) for voice conversational interface

**Data layer:**
- **Postgres 16 + pgvector** (`pgvector/pgvector:pg16` image) — NOT Supabase
- **`vector(768)`** schema everywhere
- HNSW index for vector similarity, GIN for FTS, partial indexes for active captures
- No auto-migration on startup — manual `scripts/init-schema.sql` + `packages/shared/drizzle/0001–0022.sql` required after Postgres volume recreation

**LLM layer:**
- **OpenAI API** (`api.openai.com/v1`) for embeddings (`text-embedding-3-large` with `dimensions: 768` MRL parameter) and primary LLM (`gpt-5.4` alias for fast/synthesis/governance/intent)
- **LLMGatewayService** (`packages/shared/src/services/llm-gateway.ts`) — multi-provider abstraction (`anthropic`, `openai`, `openai_compat`, `ollama`, `litellm`, `deepseek`) with tier fallback, audit logging (`ai_audit_log`), budget circuit-breaker
- **Tier routing** via `config/ai-routing.yaml`: `t1_jetson` (Qwen 3.5 4B on Jetson Orin Nano, 0.67s/call, free) → `t1_fast` → `t1_spark` (Qwen 35B on DGX Spark, free) → `t2_quality` (Claude Sonnet 4.6 via Anthropic API) → `t2_synthesis` (Claude via CLI on dedicated VM)
- As of PR #101 (Phase 4 / CS-ι): `runAgent` multi-turn agent loops support per-iteration client resolution via `clientResolver` factory
- **API budget:** monthly soft $30 alert, hard $50 circuit-breaker
- **Claude Max subscription** ($100-200/mo) covers T2 CLI batch work; API targets $35/mo total

**External integrations:**
- Cloudflare Tunnel (`brain.troy-davis.com`, `mcp` endpoint)
- Cloudflare Email Worker (`brain@troy-davis.com`) with dashboard-managed sender allowlist
- Slack (Socket Mode — no signing secret, no public webhook)
- Anthropic API (agent-loop skills + Claude CLI batch synthesis)
- Deepgram (voice path, capped $5/mo)
- Pushover (notifications)
- Gitea wiki repo on homeserver (`gitea.tale-mamba.ts.net:3000`)
- Composio MCP (Gmail, Outlook, Drive, Notion, Slack — shared 20K/month free tier)
- SimpleFIN / Plaid (future — financial imports)

**Infrastructure:**
- Docker Compose single-network (`open-brain`)
- Unraid 7.2 homeserver (Intel i7-9700, 8C/8T, 128GB DDR4, no GPU, 32TB array)
- Remote hardware: DGX Spark (Qwen 35B, inference T1), Jetson Orin Nano (Qwen 3.5 4B), `open-brain-vm` KVM (Claude CLI T2 batch)
- Tailscale overlay network for inter-machine SSH
- Prometheus + Grafana + Loki (ops stack, reviewable via Phase 3 work)
- Bitwarden Secrets Manager (`bws` CLI v2.0.0) for all secrets — never in `.env` files

**CI/CD:**
- GitHub Actions (`.github/workflows/ci.yml`): build-and-test (TS), sidecar-test (pytest), voice-pipecat-test (pytest), file-ingestion-test (pytest), python-lint (ruff + pyright, added PR #101)
- Monthly audit workflow
- GitGuardian secret scanning
- Deployment: manual `git pull + docker compose build + docker compose up -d` on homeserver

## Documentation Quality

**Strong:**
- **CLAUDE.md** (36 KB) — extensive project-specific operational rules, conventions, verified learnings, cost-tiered processing policy, lab-notebook mandates
- **LAB_NOTEBOOK.md** (449 KB, 90 entries) — decision log, hypothesis/rollback/results for every non-trivial change
- **README.md** (14 KB) — architecture overview, data flow, container map
- **docs/PRD.md** (v0.6), **docs/TDD.md** (v0.5) — versioned requirements + design
- **docs/USER_TEST_PLAN.md** — manual test checklist
- **Multiple `IMPLEMENT_*.md` plans** — historical record of implementation waves (waves, tech-debt cleanup, LLM-gateway refactor, master plan)
- **Wiki** (Gitea-hosted) with 11 pages maintained by a wiki-ingest skill

**Gaps:**
- Some PRD/TDD versioning has minor lag (PRD v0.6 references features not yet in TDD v0.5)
- OpenAPI / typed API contract is implicit via TS types; no generated `openapi.yaml`
- No ADR (Architecture Decision Record) file format beyond LAB_NOTEBOOK's Decision Log
- `docs/archived/` holds prior plans; still-current plan drift possible

## Stated Requirements and SLOs

- **Single-user system** — no auth, no multi-tenancy, ALL auth surfaces trust the owner
- **Hardware ceiling** — 1.5 GB RSS per process hard limit (CLAUDE.md mandatory); faster-whisper 8GB, Postgres 8GB Docker memory limits
- **Cost budget** — $35/mo for everything beyond Claude Max subscription ($10 OpenAI embeddings, $10 Anthropic API, $5 Deepgram, $10 external APIs)
- **Pipeline retry** — 5 attempts with backoff 30s / 2m / 10m / 30m / 2h + daily auto-sweep at 03:00
- **Search temporal weight** — starts at 0.0 (cold), ramp up as search history builds
- **Autonomy defaults** — `observe` (notifications only) at system startup; promote manually
- No explicit RTO/RPO — best-effort resilience (manual migrations, manual deploys, daily DB backup via VM cron)

## Review Scope

**In scope:**
- All 8 monorepo packages
- Docker Compose configuration
- `config/` (AI routing, pipeline, brain views, notifications, prompts)
- `scripts/` (ops scripts, migrations, regression)
- `.github/workflows/ci.yml`
- Database schema (`packages/shared/src/schema/`, `packages/shared/drizzle/`)
- Documentation quality (README, CLAUDE.md, PRD, TDD, LAB_NOTEBOOK for policy-level decisions)
- External integrations and their trust boundaries

**Out of scope:**
- The `data/` directory (128 MB personal financial + tax data, gitignored, PII)
- The `senders.xlsx` file (PII, gitignored)
- Archived plans in `docs/archived/` (historical, superseded)
- Cross-project work in `cloudflare/` (standalone email worker + synthetic monitor)

## Pre-existing Known Issues (as of 2026-04-18)

- **CI was red on `main` for ~18 hours** until PR #101 (today) fixed two pre-existing lint breaks (`model-resolver.test.ts` missing `provider` field since PR #98; `ingest-e2e.test.ts` recursive return-type since PR #99). Surfaced because `pnpm -r lint` runs `tsc --noEmit` which includes test files, but individual-package `build` (tsup) excludes them.
- **Pre-flight DB audit in PR #101 surfaced a 9th undocumented `captures.source` value (`'system'`, 1 prod row from `bet.ts` bet resolution)** that the ultra-plan investigation missed because bet.ts is a cold path. Fixed in PR #101; new CLAUDE.md operational rule mandates pre-flight audits before CHECK migrations. Flag for reviewers: check whether other similar cold-path discoveries are lurking.
- **Web package had its own duplicated `CaptureSource` type** lagging at 6 values while canonical was 8 (now 9). PR #97 drift-guard covers `IngestSourceType` + `FileUploadStatus` but NOT `CaptureSource`. Flagged follow-up to extend drift-guard.
- **voice-pipecat pyright coverage scoped out** in PR #101 (9 errors from `redis.asyncio` stubs + Anthropic ContentBlock union narrowing). TODO comment in pyproject.toml.
- **scripts/ pyright coverage deferred** — 20 ops scripts with sparse type hints; lint coverage only.
- **Homeserver was 7 PRs behind main** until today's catch-up deploy — suggests deploy cadence is ad-hoc, not pipelined.
- **`bet` feature rarely used** — 1 prod row in 6 weeks; feature exists but is under-exercised.
- **Pipecat voice soak test (Issue #54) not yet run** — 2-week validation deferred; current voice path is iOS Shortcut HTTP one-shot (working fine).
- **Qdrant migration decision deferred** (Issue #73) until >100K embeddings; currently ~11K.
- **`memory-consolidation` + `weekly-brief` bypass LLMGatewayService** — direct Anthropic SDK calls, missing tier fallback + audit logging. Flagged follow-up PR.
- **Cross-provider agent-loop fallback** explicitly constrained to same-provider tiers (no Anthropic→OpenAI mid-loop) due to tool-use format mismatch.
- **Pre-existing Node.js `punycode` DEP0040 warning** — cosmetic, transitive dev-only dep chain (`vitest → jsdom → whatwg-url → tr46 → punycode`). No production runtime path. Do not investigate further.

## Recent Significant Changes (last 14 days)

| Date | PR | Summary |
|------|-----|---------|
| 2026-04-18 | #101 | A65-A68: import-type closure, `captures.source` CHECK, Python CI, LLMGateway for email-compose |
| 2026-04-17 | #96-#100 | Tech-debt cleanup wave: vitest forks pool, web drift-guard, shared model-resolver, sidecar pytest, stale-doc cleanup |
| 2026-04-17 | #91-#94 | Sidecar 3-bug fixes, email drafts delete |
| 2026-04-16 | #75-#76 | Phase 3 (ops/observability/wiki/email-outbound/synthetic) + Phase 4 (financial + utility pipelines, manual inbox parsers) |
| 2026-04-15 | — | OneDrive dedup + reorg (128K files → 11K ingested); **cost incident resolved**: overnight ingestion caused $100+ Anthropic charges due to wrong Jetson IP + missing cost fields + no Spark tier |
| 2026-04-13 | — | Master plan issues #51-#72 created on GitHub Projects |
| 2026-04-12 | — | LLMGatewayService migration to @open-brain/shared; T0-T3 cost tiering codified in CLAUDE.md |

## Reviewer Guidance

1. **Assume single-user context** — findings about multi-tenancy, horizontal scaling, tenant isolation are generally N/A unless they impact operator (Troy) workflow. Call out if you still think it's worth flagging.
2. **Trust boundaries are narrow** — no Bearer auth between Slack → core-api internally; rate limits are for accident prevention not security.
3. **Hardware ceiling is real** — the 1.5 GB RSS / process rule is not aspirational.
4. **Cost tiers matter** — any finding that would push batch work to T3 (paid API) instead of T0/T1/T2 is itself a finding.
5. **LAB_NOTEBOOK is truth** — decision log (D1–D68+) and entries (1-90) are the primary architectural record. Contradict them only with evidence.
6. **Pipeline is async + retry-heavy** — BullMQ with 5-attempt backoff and a daily auto-sweep re-queues stale jobs. Don't flag "missing retry" without checking the pipeline config.
