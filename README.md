# Open Brain

Self-hosted personal AI knowledge infrastructure running on an Unraid home server. Ingests information from voice memos (Apple Watch/iPhone), Slack, documents, email, and files; stores everything in Postgres with pgvector; provides semantic search, AI synthesis, weekly briefs, governance sessions, operational skills, and entity tracking through OpenAI embeddings plus cost-tiered LLM routing.

## Status

**v1.5.0** — Implementation complete. 25 phases + cognitive memory shipped across four implementation plans. Core infrastructure (Phases 1-16, ~11,100 LOC) shipped 2026-03-05. Intelligence features (Phases 17-20) shipped 2026-03-11. UX polish and admin tools (Phases 21-25) shipped 2026-03-12. Cognitive memory (Hebbian learning, spreading activation, memory consolidation) shipped 2026-04-09. P08–P15a: secrets reconciliation, sibling enum CHECKs, CI expansion, observability, search perf, prompt injection hardening, doc alignment shipped 2026-04-19. Cloudscape web rollout (M2/M3/M4) shipped 2026-04-21/22. Four "Could Have" / "Won't Have" features (F24, F25, F26, F27) remain deferred — see [Roadmap](#roadmap) below.

## Current Plans

- **`IMPLEMENTATION_PLAN-POST-REMEDIATION.md`** — Current remediation follow-up plan; Phase 1 complete in PR #180, Phase 2 documentation alignment complete locally
- **`IMPLEMENTATION_PLAN-ARCH-REVIEW.md`** — Architecture review remediation complete in PR #175 (R1-R12)
- **`IMPLEMENTATION_PLAN-CLOUDSCAPE-M2.md`, `M3.md`, `M4.md`** — Cloudscape rollout shipped 2026-04-21/22
- **`IMPLEMENTATION_PLAN.md`** — LLM model consolidation into ai-routing.yaml (in progress, 20/31 items complete)
- **`docs/archived/implementation-plans/`** — Historical phase plans (Phases 1-22, tech debt cleanup, waves, completed 2026-04-19)

---

## Architecture

Single `open-brain` Docker network. All services defined in `docker-compose.yml`.

| Container | Image / Build | Purpose |
|-----------|---------------|---------|
| `open-brain-postgres` | pgvector/pgvector:pg16 | Postgres 16 + pgvector (vector(768) schema) |
| `open-brain-redis` | redis:7-alpine | BullMQ job queue backing store |
| `open-brain-core-api` | build: target=core-api | Hono API — capture CRUD, search, MCP, governance, entities |
| `open-brain-workers` | build: target=workers | BullMQ workers — embed, classify, extract entities, triggers, skills |
| `open-brain-slack-bot` | build: target=slack-bot | @slack/bolt Socket Mode — capture + query + commands |
| `open-brain-voice-pipecat` | build: packages/voice-pipecat/Dockerfile | Conversational voice service — Pipecat + Deepgram + Claude |
| `open-brain-file-ingestion` | build: packages/file-ingestion/Dockerfile | FastAPI document extraction for PDF, Office, text, CSV, HTML |
| `open-brain-faster-whisper` | fedirz/faster-whisper-server:0.5.0-cpu | Speech-to-text (large-v3, CPU int8) |
| `open-brain-voice-capture` | build: target=voice-capture | HTTP endpoint for iOS Shortcut; proxies to faster-whisper |
| `open-brain-web-next` | build: packages/web-next/Dockerfile | Next.js 16 + Cloudscape design system + React 19 + TanStack Query dashboard |
| `open-brain-cloudflared` | cloudflare/cloudflared:latest | Cloudflare Tunnel — exposes brain.troy-davis.com |
| `open-brain-financial-ingest` | build: docker/ingest-sidecar/Dockerfile | Scheduled financial data ingestion sidecar |
| `open-brain-loki` | grafana/loki:latest | Central log aggregation |
| `open-brain-pushgateway` | prom/pushgateway:latest | Push metrics bridge for jobs and sidecars |
| `open-brain-prometheus` | prom/prometheus:latest | Metrics scrape and retention |
| `open-brain-grafana` | grafana/grafana:latest | Observability dashboards |
| `open-brain-utility-ingest` | build: docker/ingest-sidecar/Dockerfile | Scheduled utility data ingestion sidecar |

This table reflects the 17 service declarations in `docker-compose.yml`. `docker compose -f docker-compose.yml config --services` is temporarily blocked by tracked item A130 (`cloudflared` depends on legacy service name `web` instead of `web-next`).

**External dependencies**: OpenAI API handles embeddings via `text-embedding-3-large` (768d via `dimensions` parameter). `LLMGatewayService` routes LLM inference through `config/ai-routing.yaml` tiers: optional free local GPU endpoints (`t1_jetson`, `t1_spark`) first, paid Anthropic tiers (`t1_fast`, `t2_quality`) for tasks that need them. API keys live in Bitwarden.

### Monorepo Layout

```
packages/
  shared/          # Drizzle schema, types, DB client, utilities
  core-api/        # Hono app — routes, services, MCP endpoint
  workers/         # BullMQ jobs, pipeline stages, skills
  slack-bot/       # Slack bot (@slack/bolt, Socket Mode)
  voice-capture/   # Voice ingestion HTTP server
  voice-pipecat/   # Conversational voice service (Pipecat + Deepgram + Claude)
  file-ingestion/  # FastAPI document extraction service
  web-next/        # Next.js 16 + Cloudscape design system dashboard
  mobile/          # Expo React Native app
config/
  ai-routing.yaml  # Embedding config + LLM tier routing + budget limits
  brain-views.yaml # Five views: career/personal/technical/work-internal/client
  pipeline.yaml    # Pipeline stage definitions + retry/backoff settings
  notifications.yaml
  prompts/         # Versioned prompt templates
  cloudflare/      # Tunnel config
  postgres/        # postgresql.conf
scripts/
  load-secrets.sh         # Bitwarden Secrets Manager integration
  migrate.sh              # Drizzle migration runner
  e2e-phase1.sh           # End-to-end smoke test
  e2e-full.sh             # Full end-to-end test suite
  regression-test.mjs     # Comprehensive regression suite (91 tests)
  monthly-maintenance.sh  # Monthly maintenance: docker rebuild, logs, health, Slack report
docs/
  PRD.md           # Product requirements (v0.7.1)
  TDD.md           # Technical design (v0.7.2)
  ios-shortcut.md  # iOS Shortcut setup guide for voice capture
```

### Data Flow

```
Voice (iPhone/Watch)
  → iOS Shortcut → voice-capture :3001
    → faster-whisper (transcription)
    → core-api POST /api/v1/captures

Slack message / command
  → slack-bot (Socket Mode)
    → intent router → core-api

Document upload
  → core-api POST /api/v1/documents/ingest
    → workers: document-pipeline job

All captures hit the same pipeline:
  embed-capture → extract-entities → link-entities → check-triggers → notify
  Status flow: pending → processing → extracted → embedded

Search:
  Hybrid (default): FTS + pgvector cosine → Reciprocal Rank Fusion → ACT-R temporal decay
    → Hebbian association boost (from co-access patterns)
    → Spreading activation (entity graph traversal, optional via include_related)
  FTS-only (?search_mode=fts): bypasses embedding, works when OpenAI is unavailable

AI calls:
  embeddings → OpenAI API at https://api.openai.com/v1
    → text-embedding-3-large (768d via dimensions parameter)
  LLM inference → LLMGatewayService
    → t1_jetson / t1_spark optional free local GPU tiers
    → t1_fast / t2_quality paid Anthropic tiers when required
```

### Key Design Decisions

- **No required local LLM container** — embeddings run through OpenAI API; optional Jetson/Spark tiers reduce inference cost when available
- **vector(768)** everywhere, no fallback if OpenAI is down — queue and retry
- **Hybrid search**: FTS + vector with RRF + ACT-R temporal decay (default `temporal_weight: 0.0` at launch, ramp as history builds)
- **MCP embedded** in core-api at `/mcp` route (Streamable HTTP, `Authorization: Bearer` header)
- **Governance**: LLM-driven conversation with guardrails, not FSM
- **Brain views**: 5 views auto-classified at ingest — `career`, `personal`, `technical`, `work-internal`, `client`
- **Capture types**: 8 types — `decision`, `idea`, `observation`, `task`, `win`, `blocker`, `question`, `reflection`
- **AI budget**: soft $30/month (alert via Pushover), hard $50 (circuit breaker)
- **Pipeline retry**: 5 attempts, patient backoff (30s, 2m, 10m, 30m, 2h) + daily auto-sweep
- **Secrets**: Bitwarden Secrets Manager only — never `.env` files

---

## Roadmap

### Implemented

**Core Infrastructure (Phases 1-16, shipped 2026-03-05)**

- **Capture**: Voice memos (iOS Shortcut), Slack messages, Slack voice clips, document upload (PDF/docx/txt/md), MCP, direct API
- **Pipeline**: Async BullMQ stages — embed, classify, extract entities, link entities, check triggers, notify
- **Search**: Hybrid retrieval (FTS + pgvector cosine + RRF) with ACT-R temporal decay + Hebbian association boost + spreading activation (entity graph traversal)
- **AI Skills**: Weekly brief, board governance (quick check, quarterly), bet tracking, semantic push triggers, memory consolidation
- **Output**: Pushover notifications, HTML email delivery, Slack responses
- **Governance**: LLM-driven interactive sessions via Slack with guardrails
- **Entity Graph**: Auto-extraction, 3-tier resolution, relationship tracking
- **Web Dashboard**: Next.js 16 + Cloudscape design system + React 19 + TanStack Query — timeline, search, entities, board, briefs, voice, documents, settings
- **MCP**: Embedded Streamable HTTP endpoint at `/mcp` for Claude, ChatGPT, and other AI tools
- **Infrastructure**: Postgres 16 + pgvector, Redis, faster-whisper (CPU), Cloudflare Tunnel, SSE live updates

**Intelligence Features (Phases 17-20, shipped 2026-03-11)**

- Entity detail pages, relationship graph visualization, entity merge/split
- Advanced search filters (date range, brain view, capture type, entity)
- Capture detail view with entity links and pipeline status

**UX Polish + Admin Tools (Phases 21-25, shipped 2026-03-12)**

- Trigger delete fix and Settings page reorganization into focused sections
- Queue management UI (per-queue clear buttons for failed jobs)
- Dark mode toggle with system preference detection and localStorage persistence
- Skill schedule editing (inline cron editing with YAML write-back)
- In-app help page with tabbed markdown rendering and table of contents
- Slack channel management (listing with activity metadata, channel archiving)

**Cognitive Memory (shipped 2026-04-09)**

- **Hebbian Learning**: Captures co-accessed in search sessions form strengthening associations (`capture_associations` table). Bounded 10% search score boost from association weights. Automatic pruning of stale associations.
- **Spreading Activation**: Entity graph traversal (1-2 hops via `entity_links` + `entity_relationships`) surfaces related captures during search. Available via `include_related` param on search API and MCP `search_brain` tool.
- **Memory Consolidation**: Scheduled weekly skill (4 AM Sundays) identifies clusters of near-duplicate captures (cosine > 0.92), LLM-merges them with a safety valve, migrates entity links and associations, soft-deletes originals.

**Operational Intelligence + Cloudscape Web (shipped 2026-04-19 to 2026-04-22)**

- **Scheduled Skills**: Daily connections (6:10 AM), drift monitor (7:15 AM), morning brief, monthly reflection, capture reminders, cost analysis, container health, storage audit, secret rotation, capture dedupe, wiki synthesis/lint, email classification.
- **Web Dashboard Refresh**: Next.js 16 shell, Cloudscape design system screens, settings decomposition, Slack cleanup, capture detail, entity merge, brief actions.
- **Mobile App Blueprint**: Expo SDK 54 React Native app with 11 screens shipped via PR #172 and PR #174; remaining mobile work is tracked separately.

### Deferred Features

These PRD features were planned but not implemented. They remain candidates for future development:

| Feature | PRD Ref | Description | Notes |
|---------|---------|-------------|-------|
| URL/bookmark capture | F24 | Browser bookmark import with content extraction (readability/cheerio) | Test stubs exist; no service implementation |
| Calendar integration | F25 | iCal feed sync — creates captures from calendar events | Test stubs exist; no service implementation |
| Notion output skill | F26 | Mirror outputs (briefs, governance) to Notion | Classified as "Won't Have" in PRD |
| Screenshot/image capture | F27 | Image ingestion via vision models | Classified as "Won't Have" in PRD |

**Note**: The primary voice capture path is the iOS Shortcut to the voice-capture HTTP endpoint. Slack voice clips (F20) are also fully implemented — audio attachments in Slack are detected and routed to the voice-capture container for transcription.

---

## Quick Start

### Prerequisites

- Docker + Docker Compose
- `bws` CLI v2.0.0 at `~/bin/bws.exe` with `BWS_ACCESS_TOKEN` set
- OpenAI API key for embeddings; Anthropic API key for paid LLM tiers when configured. Model tiers and fallbacks live in `config/ai-routing.yaml`.
- Bitwarden secrets populated for the `ai-work` project (see `scripts/load-secrets.sh`)

### 1. Clone and install

```bash
git clone <repo> open-brain
cd open-brain
pnpm install
```

### 2. Load secrets from Bitwarden

Secrets are never stored in `.env` files. Load them into a `.env.secrets` file that Docker reads at startup:

```bash
# Retrieve your secrets from Bitwarden and write to .env.secrets (git-ignored)
# Required keys:
#   OPENAI_API_KEY        — OpenAI API key for embeddings
#   ANTHROPIC_API_KEY     — Anthropic API key for paid LLM tiers
#   MCP_API_KEY           — bearer token for MCP endpoint
#   POSTGRES_PASSWORD     — Postgres password (default: openbrain_dev for local)
#   SLACK_BOT_TOKEN       — xoxb-... Slack bot token
#   SLACK_APP_TOKEN       — xapp-... Slack app-level token
#   PUSHOVER_TOKEN        — Pushover application token
#   PUSHOVER_USER         — Pushover user key
#   SMTP_HOST / SMTP_USER / SMTP_PASS  — email delivery
#   CLOUDFLARE_TUNNEL_TOKEN  — Cloudflare tunnel token
source ./scripts/load-secrets.sh
```

### 3. Run database migrations

```bash
./scripts/migrate.sh
```

### 4. Start the full stack

```bash
docker compose up -d
```

The intended stack contains all 17 declared services. As of the 2026-05-06 documentation audit, A130 must be fixed first because `cloudflared.depends_on` still references the legacy `web` service instead of `web-next`. First successful run downloads the faster-whisper `large-v3` model (~3GB); allow 2–5 minutes before the voice-capture service becomes healthy.

### 5. Verify

```bash
# Core API health
curl http://localhost:3002/health

# Voice capture health
curl http://localhost:3001/health

# Web dashboard
open http://localhost:3003

# Bull Board (queue monitor)
open http://localhost:3002/api/v1/admin/queues
```

### 6. Connect Claude (MCP)

Add to your Claude MCP config:

```json
{
  "mcpServers": {
    "open-brain": {
      "url": "https://llm.troy-davis.com/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>"
      }
    }
  }
}
```

### Cloudflare Tunnel (remote access)

Configure `config/cloudflare/tunnel.yaml` with your tunnel ID and credentials, then set `CLOUDFLARE_TUNNEL_TOKEN` in Bitwarden. The `cloudflared` container starts automatically with the stack.

---

## Reference

| File | Purpose |
|------|---------|
| `CHANGELOG.md` | Version history and recent changes |
| `IMPLEMENTATION_PLAN-PHASE5.md` | Phases 17–20 (Intelligence features) — complete |
| `IMPLEMENTATION_PLAN-PHASE6.md` | Phases 21–25 (UX polish + admin tools) — complete |
| `IMPLEMENT_IMPROVED_MEMORY.md` | Cognitive memory (Hebbian, spreading activation, consolidation) — complete |
| `docs/PRD.md` | Product requirements (v0.7.1) |
| `docs/TDD.md` | Technical design (v0.7.2) |
| `docs/USER_TEST_PLAN.md` | End-to-end test plan for all phases |
| `docs/TEST_RESULTS_2026-03-09.md` | Deployment validation test results (all passing) |
| `docs/ios-shortcut.md` | iOS Shortcut setup for Apple Watch voice capture |
| `docs/setup-slack-cloudflare.md` | Slack bot and Cloudflare tunnel setup guide |
| `config/ai-routing.yaml` | Embedding config, LLM tier routing, and budget thresholds |
| `config/brain-views.yaml` | Brain view definitions |
| `config/pipeline.yaml` | Pipeline stage definitions + retry/backoff settings |
| `docs/archived/` | Completed implementation plans and historical test results |

## Hardware

Intel i7-9700 (8C/8T), 128GB DDR4, no GPU, 32TB array. Unraid OS. faster-whisper runs CPU int8 — transcription is slower than GPU but fully local. Container memory limits: faster-whisper 8GB, Postgres 8GB.

## License

Apache 2.0
