# Open Brain

Self-hosted personal AI knowledge infrastructure running on an Unraid home server. Ingests information from voice memos (Apple Watch/iPhone), Slack, and documents; stores everything in Postgres with pgvector; provides semantic search, AI synthesis, weekly briefs, governance sessions, and entity tracking — all routed through a shared LiteLLM proxy.

## Status

**Implementation complete** — all 16 phases (83 work items across ~11,100 LOC) shipped 2026-03-05.

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
| `open-brain-faster-whisper` | fedirz/faster-whisper-server:0.4.1 | Speech-to-text (large-v3, CPU int8) |
| `open-brain-web` | build: packages/web/Dockerfile | Vite + React + shadcn/ui dashboard (nginx, PWA) |
| `open-brain-cloudflared` | cloudflare/cloudflared:latest | Cloudflare Tunnel — exposes brain.k4jda.net |

**External dependency**: LiteLLM proxy at `https://llm.k4jda.net` handles ALL AI — both embeddings (`spark-qwen3-embedding-4b` alias → Qwen3-Embedding-4B, returns 2560d Matryoshka-truncated to 768d in the embedding service) and LLM inference (aliases: `fast`, `synthesis`, `governance`, `intent`). Not part of this stack.

### Monorepo Layout

```
packages/
  shared/          # Drizzle schema, types, DB client, utilities
  core-api/        # Hono app — routes, services, MCP endpoint
  workers/         # BullMQ jobs, pipeline stages, skills
  slack-bot/       # Slack bot (@slack/bolt, Socket Mode)
  voice-capture/   # Voice ingestion HTTP server
  web/             # Vite + React dashboard (nginx Docker)
config/
  ai-routing.yaml  # LiteLLM model aliases + budget limits
  brain-views.yaml # Five views: career/personal/technical/work-internal/client
  pipelines.yaml   # Pipeline stage definitions
  pipeline.yaml    # Pipeline retry/backoff settings
  notifications.yaml
  prompts/         # Versioned prompt templates
  cloudflare/      # Tunnel config
  postgres/        # postgresql.conf
scripts/
  load-secrets.sh  # Bitwarden Secrets Manager integration
  migrate.sh       # Drizzle migration runner
  e2e-phase1.sh    # End-to-end test suite (Phase 1)
  e2e-full.sh      # End-to-end test suite (all phases)
docs/
  PRD.md           # Product requirements (v0.6)
  TDD.md           # Technical design (v0.5)
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
  FTS-only (?search_mode=fts): bypasses embedding, works when LiteLLM is unavailable

AI calls:
  all services → LiteLLM at https://llm.k4jda.net
    → spark-qwen3-embedding-4b (Qwen3 2560d → truncated to 768d)
    → fast / synthesis / governance / intent (Spark Qwen3.5-35B)
```

### Key Design Decisions

- **No Ollama container** — embeddings and inference both run through external LiteLLM; no AI in this stack
- **vector(768)** everywhere, no fallback if LiteLLM is down — queue and retry
- **Hybrid search**: FTS + vector with RRF + ACT-R temporal decay (default `temporal_weight: 0.0` at launch, ramp as history builds)
- **MCP embedded** in core-api at `/mcp` route (Streamable HTTP, `Authorization: Bearer` header)
- **Governance**: LLM-driven conversation with guardrails, not FSM
- **Brain views**: 5 views auto-classified at ingest — `career`, `personal`, `technical`, `work-internal`, `client`
- **Capture types**: 8 types — `decision`, `idea`, `observation`, `task`, `win`, `blocker`, `question`, `reflection`
- **AI budget**: soft $30/month (alert via Pushover), hard $50 (circuit breaker)
- **Pipeline retry**: 5 attempts, patient backoff (30s, 2m, 10m, 30m, 2h) + daily auto-sweep
- **Secrets**: Bitwarden Secrets Manager only — never `.env` files

---

## Quick Start

### Prerequisites

- Docker + Docker Compose
- `bws` CLI v2.0.0 at `~/bin/bws.exe` with `BWS_ACCESS_TOKEN` set
- LiteLLM proxy running at `https://llm.k4jda.net` with model aliases configured
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
#   LITELLM_API_KEY       — virtual key for LiteLLM proxy
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

This starts all 9 containers. First run downloads the faster-whisper `large-v3` model (~3GB); allow 2–5 minutes before the voice-capture service becomes healthy.

### 5. Verify

```bash
# Core API health
curl http://localhost:3000/health

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
      "url": "https://brain.k4jda.net/mcp",
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
| `LEARNINGS.md` | Implementation notes and post-mortems |
| `docs/PRD.md` | Product requirements (v0.6) |
| `docs/TDD.md` | Technical design (v0.5) |
| `docs/USER_TEST_PLAN.md` | End-to-end test plan for all phases |
| `docs/TEST_RESULTS_2026-03-09.md` | Integration test results (all passing) |
| `docs/ios-shortcut.md` | iOS Shortcut setup for Apple Watch voice capture |
| `docs/setup-slack-cloudflare.md` | Slack bot and Cloudflare tunnel setup guide |
| `docs/ARCH_REMEDIATION_PLAN.md` | Architecture review remediation log (all items complete) |
| `IMPLEMENTATION_PLAN.md` | Phases 1–8 (Foundation) — all complete |
| `IMPLEMENTATION_PLAN-PHASE2.md` | Phases 9–16 (Voice through Polish) — all complete |
| `config/ai-routing.yaml` | LiteLLM model aliases and budget thresholds |
| `config/brain-views.yaml` | Brain view definitions |
| `config/pipelines.yaml` | Pipeline stage configuration |

## Hardware

Intel i7-9700 (8C/8T), 128GB DDR4, no GPU, 32TB array. Unraid OS. faster-whisper runs CPU int8 — transcription is slower than GPU but fully local. Container memory limits: faster-whisper 8GB, Postgres 8GB.

## License

Apache 2.0
