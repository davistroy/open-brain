# Open Brain

Self-hosted personal AI knowledge infrastructure running on an Unraid home server. Ingests information from voice memos (Apple Watch/iPhone), Slack, and documents; stores everything in Postgres with pgvector; provides semantic search, AI synthesis, weekly briefs, governance sessions, and entity tracking — powered by OpenAI API (gpt-5.4 + text-embedding-3-large).

## Status

**v1.6.0** — Phase 8b web consolidation, architecture review remediation, mobile app, ops hardening, GitHub issues migration shipped 2026-05-09. See [CHANGELOG](CHANGELOG.md) for the full v1.6.0 entry.

**In progress (post-1.6.0):** Architecture Review v3 remediation (plan A132, [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)) — **Waves 1–2 complete** (Phases 1–7 merged: CI gates, LAN perimeter, recovery/search fixes, observability, schema fidelity machine, integration/spend hardening, and the O(N²)→HNSW k-NN similarity rewrite). Waves 3–4 + the batched production deploy remain. See the [Unreleased CHANGELOG](CHANGELOG.md#unreleased) section. Other pending work tracked in [GitHub issues](https://github.com/davistroy/open-brain/issues) (quick summary in [OPEN_ITEMS.md](OPEN_ITEMS.md)). Four "Could Have" / "Won't Have" features (F24, F25, F26, F27) remain deferred — see [Roadmap](#roadmap) below.

## Plans

- **GitHub issues** — single source of truth for all open work. See [OPEN_ITEMS.md](OPEN_ITEMS.md) for a one-page summary.
- **`docs/archived/`** — completed implementation plans (Phases 1–22 + tech-debt waves through 2026-04-19; Cloudscape M1–M4; arch-review; post-remediation; 2026-05-09 cohesive remediation).

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
| `open-brain-voice-capture` | build: target=voice-capture | HTTP endpoint for iOS Shortcut; proxies to faster-whisper |
| `open-brain-faster-whisper` | fedirz/faster-whisper-server:0.5.0-cpu | Speech-to-text (large-v3, CPU int8) |
| `open-brain-web-next` | build: packages/web-next/Dockerfile | Next.js 16 + Cloudscape + React 19 + TanStack Query — sole UI package; canonical ingress at brain.troy-davis.com |
| `open-brain-voice-pipecat` | build: packages/voice-pipecat | Pipecat realtime voice pipeline (VAD → Deepgram → Claude → TTS) |
| `open-brain-file-ingestion` | build: packages/file-ingestion | FastAPI sidecar — extracts text from PDF/DOCX/XLSX/PPTX/etc. for the document pipeline |
| `open-brain-financial-ingest` / `utility-ingest` | image: alpine + cron | Hourly Python pullers for financial + utility data; results POST'd to `/api/v1/captures` |
| `open-brain-loki` / `prometheus` / `pushgateway` / `grafana` | grafana images | Observability stack — Loki log aggregation (P11a), Prometheus + pushgateway metrics, Grafana dashboards |
| `open-brain-cloudflared` | cloudflare/cloudflared:latest | Cloudflare Tunnel — exposes brain.troy-davis.com |

**External dependency**: OpenAI API (`https://api.openai.com/v1`) handles ALL AI — embeddings via `text-embedding-3-large` (768d via `dimensions` parameter) and LLM inference via `gpt-5.4` (aliases: `fast`, `synthesis`, `governance`, `intent`). Configured in `config/ai-routing.yaml`. API key in Bitwarden.

### Monorepo Layout

```
packages/
  shared/          # Drizzle schema, types, DB client, utilities
  core-api/        # Hono app — routes, services, MCP endpoint
  workers/         # BullMQ jobs, pipeline stages, skills
  slack-bot/       # Slack bot (@slack/bolt, Socket Mode)
  voice-capture/   # Voice ingestion HTTP server (iOS Shortcut → faster-whisper batch path)
  voice-pipecat/   # Realtime voice pipeline (VAD → Deepgram → Claude → TTS)
  file-ingestion/  # FastAPI sidecar — text extraction for PDF/DOCX/XLSX/PPTX/etc.
  web-next/        # Next.js 16 + Cloudscape + React 19 + TanStack Query (sole UI package)
  mobile/          # Expo (React Native) mobile app — 11 screens
config/
  ai-routing.yaml  # OpenAI model aliases + budget limits
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
  PRD.md           # Product requirements (v0.6)
  TDD.md           # Technical design (v0.6)
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
  all services → OpenAI API at https://api.openai.com/v1
    → text-embedding-3-large (768d via dimensions parameter)
    → gpt-5.4 (all aliases: fast, synthesis, governance, intent)
```

### Key Design Decisions

- **No local LLM container** — embeddings and inference both run through OpenAI API; no AI in this stack
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
- **Web Dashboard**: Next.js 16 + Cloudscape + React 19 + TanStack Query — timeline, search, entities, board, briefs, voice, documents, settings (`packages/web-next`)
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
- OpenAI API key (all AI calls route directly to `https://api.openai.com/v1`; model aliases configured in `config/ai-routing.yaml`)
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
#   OPENAI_API_KEY        — OpenAI API key for all LLM + embedding calls
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

This starts all 17 containers — 13 application/data services (postgres, redis, core-api, workers, slack-bot, voice-pipecat, file-ingestion, faster-whisper, voice-capture, web-next, cloudflared, financial-ingest, utility-ingest) plus the 4-service observability stack (loki, prometheus, pushgateway, grafana). First run downloads the faster-whisper `large-v3` model (~3GB); allow 2–5 minutes before the voice-capture service becomes healthy.

### 5. Verify

```bash
# Core API health
curl http://localhost:3002/health

# Voice capture health
curl http://localhost:3001/health

# Web dashboard
open http://localhost:5173

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
| `OPEN_ITEMS.md` | One-page summary of open GitHub issues |
| `LAB_NOTEBOOK.md` | Experiment + decision log (append-only) |
| `USER_TEST_PLAN.md` | End-to-end test plan for all phases |
| `docs/PRD.md` | Product requirements (v0.7) |
| `docs/TDD.md` | Technical design (v0.7) |
| `docs/ios-shortcut.md` | iOS Shortcut setup for Apple Watch voice capture |
| `docs/setup-slack-cloudflare.md` | Slack bot and Cloudflare tunnel setup guide |
| `config/ai-routing.yaml` | OpenAI model aliases and budget thresholds |
| `config/brain-views.yaml` | Brain view definitions |
| `config/pipeline.yaml` | Pipeline stage definitions + retry/backoff settings |
| `docs/archived/` | Completed implementation plans and historical test results |

## Hardware

Intel i7-9700 (8C/8T), 128GB DDR4, no GPU, 32TB array. Unraid OS. faster-whisper runs CPU int8 — transcription is slower than GPU but fully local. Container memory limits: faster-whisper 8GB, Postgres 8GB.

## License

Apache 2.0
