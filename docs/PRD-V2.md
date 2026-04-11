# Product Requirements Document: Open Brain v2

## Personal AI Infrastructure — Architecture Expansion

**Document Version:** 1.0
**Author:** Troy Davis / Stratfield Consulting
**Date:** April 10, 2026
**Status:** Draft
**Repository:** https://github.com/davistroy/open-brain

---

## 1. Purpose

Open Brain v1 is a self-hosted personal AI knowledge infrastructure that captures voice memos, Slack messages, and documents; stores them in Postgres with pgvector; and provides semantic search, AI synthesis, scheduled intelligence skills, and entity tracking. It has been in production since March 2026 with 25 shipped phases including cognitive memory (Hebbian learning, spreading activation, memory consolidation).

Open Brain v2 expands the architecture in four directions:

1. **Conversational voice** — replacing one-shot voice transcription with real-time, multi-turn voice conversations via Pipecat
2. **Compiled knowledge** — adding an LLM-maintained wiki layer (Karpathy pattern) that synthesizes raw captures into a persistent, compounding knowledge base
3. **Pipeline modernization** — restructuring the sequential BullMQ ingest pipeline into parallel flow DAGs and elevating BullMQ from pipeline processor to full system nervous system
4. **Dashboard evolution** — extending the existing Vite + React + shadcn/ui web dashboard from a capture/search tool into a mission-control interface with unified activity feeds, wiki browsing, voice conversation history, system health monitoring, and enhanced pipeline observability
5. **Email as a channel** — adding outbound email composition via Himalaya CLI (the brain can draft and send emails on your behalf). Inbound email capture is already handled by the existing Cloudflare Email Worker at brain@troy-davis.com.
6. **Infrastructure skills** — adding operational scheduled jobs (backups, cost analysis, health audits) alongside the existing intelligence skills, all managed through BullMQ job schedulers

The design philosophy is composable Unix-style services connected by a durable message bus, with Claude as the primary reasoning engine accessed via SDK. Every component is independently replaceable. No framework lock-in.

---

## 2. Goals

| ID | Goal | Success Metric |
|----|------|----------------|
| G1 | Enable natural, multi-turn voice conversations with the brain | Voice sessions produce captures with entity extraction and wiki integration, accessible from iPhone/Apple Watch and optionally via phone number |
| G2 | Build a compounding knowledge base that gets richer over time with near-zero maintenance cost | Wiki contains 50+ synthesized pages within 60 days of launch; lint passes show <10% orphan rate |
| G3 | Reduce pipeline latency by parallelizing independent stages | Ingest-to-searchable time drops by 30%+ via parallel embed/extract flows |
| G4 | Provide at-a-glance situational awareness of the entire system | Dashboard home page answers "what happened while I was away" within 5 seconds of loading |
| G5 | Dual-path model routing: Claude SDK (subscription) + LiteLLM proxy | Claude models called directly via Anthropic SDK (zero marginal cost, subscription-covered). Non-Claude traffic (OpenAI embeddings, DGX Spark local models) routed through LiteLLM proxy at llm.k4jda.net for cost tracking. |
| G6 | Keep total container count ≤10 on the Unraid host | No container sprawl; Pipecat replaces voice-capture + faster-whisper containers |
| G7 | Email as a first-class interface — inbound and outbound | Inbound email capture handled by existing Cloudflare Email Worker (push-based, instant). Outbound email composition and sending via Himalaya CLI. Brain can draft and send emails via Slack command or scheduled skill. |
| G8 | Autonomous infrastructure health — backups, cost monitoring, self-healing | Daily backups verified, monthly cost reports generated, stuck pipelines auto-recovered without manual intervention |

---

## 3. Non-Goals

- **Chat interface in the dashboard.** Slack handles text interaction; Pipecat handles voice; claude.ai with MCP handles extended reasoning. The dashboard is for observing and steering, not conversing.
- **Wiki editing in the dashboard.** The LLM maintains the wiki. Manual corrections happen via Obsidian or VS Code on the Git repo. The dashboard shows wiki state; it does not break LLM ownership.
- **Visual workflow/pipeline designer.** BullMQ flows are defined in TypeScript code. The dashboard visualizes execution, not design.
- **Multi-user support.** Open Brain is a single-user personal system. Authentication remains a simple bearer token.
- **Agent orchestration platform.** No Multica, no LangGraph, no multi-agent framework. Claude SDK's tool_use loop is the agent runtime. Claude Code connects via MCP.
- **Mobile-native app.** The PWA is sufficient for mobile access via Tailscale.

---

## 4. Users

| User | Context |
|------|---------|
| Troy (primary) | Interacts via voice (Pipecat/Twilio), Slack, Claude Code (MCP), and the web dashboard. Needs situational awareness, knowledge synthesis, and a system that runs autonomously between interactions. |
| Claude Code (agent) | Connects via MCP to search the brain, create captures, read/write the wiki, and query entities during development and consulting work. |
| Scheduled Skills (autonomous) | BullMQ job schedulers that run unattended — weekly briefs, governance sessions, memory consolidation, wiki maintenance, drift detection, reflection. |

---

## 5. Baseline Capabilities Carried Forward

The following v1 capabilities are assumed to be in place and are NOT re-specified in this PRD. They carry forward unchanged unless explicitly modified by a v2 feature.

### 5.0.1 Existing Capture Pipeline
- Voice memos (iOS Shortcut → voice-capture → faster-whisper → core-api)
- Slack messages and voice clips (Socket Mode → intent router → core-api)
- Document upload (PDF/docx/txt/md → core-api → document-pipeline worker)
- MCP and direct API capture
- Pipeline stages: embed-capture → extract-entities → link-entities → check-triggers → notify
- Status flow: pending → processing → complete
- Retry policy: 5 attempts, patient backoff (30s, 2m, 10m, 30m, 2h), daily auto-sweep

### 5.0.2 Existing Scheduled Skills (BullMQ Job Schedulers)
| Skill | Schedule | Description |
|-------|----------|-------------|
| Daily Sweep | Daily 3 AM | Re-queues stuck pipeline captures |
| Budget Check | Daily 8 AM | Monthly AI spend monitoring with soft/hard limits |
| Daily Connections | DISABLED | Cross-domain pattern detection (silenced for noise reduction) |
| Drift Monitor | Daily 8 AM | Brain-view classification drift detection |
| Pipeline Health | Every 6 hours | Queue health + capture flow monitoring |
| Daily Sweep Skill | Daily 8 PM | LLM-powered evening summary |
| Memory Consolidation | Sundays 4 AM | Clusters near-duplicate captures, LLM-merges them |
| Capture Reminder Morning | Weekdays 7 AM | Pushover nudge to capture (no LLM) |
| Morning Brief | Weekdays 7:15 AM | Structured morning briefing from DB queries (no LLM) |
| Capture Reminder Evening | Daily 9 PM | Evening nudge with capture count (no LLM) |
| Weekly Brief | Weekly, configurable | LLM-synthesized summary across all brain views |
| Board Governance | Weekly/Quarterly | LLM-driven interactive governance sessions |
| Semantic Push Triggers | On capture | Evaluates new captures against trigger patterns |

### 5.0.3 Existing Infrastructure
- Docker Compose stack on Unraid (9 containers)
- Postgres 16 + pgvector (vector(768) schema)
- Redis 7 (BullMQ backing store)
- Cloudflare Tunnel (brain.troy-davis.com)
- Bitwarden Secrets Manager (no .env files)
- Monthly maintenance script (`scripts/monthly-maintenance.sh`): Docker rebuild, log rotation, health checks, Slack report
- `scripts/backup.sh` — daily database backup with 14 daily / 4 weekly / 3 monthly retention (cron active)
- Budget-check skill with local `ai_audit_log` spend estimation
- Regression test suite: 95 tests (`scripts/regression-test.mjs`)
- E2E smoke tests (`scripts/e2e-phase1.sh`, `scripts/e2e-full.sh`)

### 5.0.4 Existing Dashboard (Vite + React + shadcn/ui + PWA)
- Timeline view (captures, filterable)
- Search (hybrid FTS + vector)
- Entity pages, relationship graph, entity merge/split
- Board governance sessions
- Weekly briefs
- Voice memo list
- Document upload
- Settings (organized sections, inline cron editor for skills, queue management, dark mode)
- In-app help with tabbed markdown rendering
- BullBoard at `/api/v1/admin/queues`

### 5.0.5 Existing Email & Notifications
- **Inbound email capture**: Cloudflare Email Worker at brain@troy-davis.com — push-based, instant delivery. Emails become captures routed through the full ingest pipeline. Sender allowlist managed via dashboard Settings page (stored in `app_settings` table).
- HTML email delivery for weekly briefs and governance outputs via SMTP (configured in Bitwarden: SMTP_HOST, SMTP_USER, SMTP_PASS)
- Pushover notifications for alerts and triggers

---

## 6. Architecture Overview

### 6.1 Layered Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 6: Development Agent (Claude Code via MCP)                │
├─────────────────────────────────────────────────────────────────┤
│ Layer 5: Scheduled Intelligence (BullMQ Job Schedulers)         │
│   weekly-brief | governance | consolidation | wiki-lint |       │
│   wiki-ingest | drift-detect | reflection | daily-connections   │
├─────────────────────────────────────────────────────────────────┤
│ Layer 4: Memory & Knowledge                                     │
│   ┌──────────────────────┐  ┌────────────────────────────────┐  │
│   │ Open Brain (Postgres)│  │ Wiki (Git/Markdown on Gitea)   │  │
│   │ captures, entities,  │  │ synthesized knowledge,         │  │
│   │ associations, search │  │ cross-refs, schema, index, log │  │
│   └──────────────────────┘  └────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│ Layer 3: Intelligence Engine                                     │
│   Claude SDK (Anthropic API, subscription) — all Claude calls    │
│   LiteLLM proxy (llm.k4jda.net) — embeddings, local models     │
│   Deepgram — real-time STT for Pipecat voice                    │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: Interface Services                                     │
│   ┌────────────┐  ┌──────────────────┐  ┌────────────────────┐ │
│   │ Slack Bot   │  │ Pipecat Voice    │  │ MCP Endpoint       │ │
│   │ Socket Mode │  │ STT→LLM→TTS     │  │ Streamable HTTP    │ │
│   │             │  │ Twilio optional  │  │                    │ │
│   └────────────┘  └──────────────────┘  └────────────────────┘ │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │ Email Inbound: Cloudflare Email Worker (existing,        │  │
│   │   push-based) → core-api POST /captures                 │  │
│   │ Email Outbound: Himalaya CLI — SMTP drafts & sending     │  │
│   └──────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: Durable Message Bus (BullMQ + Redis)                   │
│   Queues: ingest | embed | extract | wiki-ingest | voice |      │
│   email-outbound | agent-task | reflection |                    │
│   wiki-maintenance | infrastructure | notifications            │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Container Architecture (Unraid / Docker Compose)

| Container | Image / Build | Purpose | Status |
|-----------|---------------|---------|--------|
| `open-brain-postgres` | pgvector/pgvector:pg16 | Postgres 16 + pgvector | Existing |
| `open-brain-redis` | redis:7-alpine | BullMQ + Pipecat session state | Existing (expanded role) |
| `open-brain-core-api` | build: target=core-api | Hono API — all endpoints including wiki, voice sessions, system health | Existing (expanded) |
| `open-brain-workers` | build: target=workers | BullMQ workers — all pipeline + wiki + email outbound + reflection + infrastructure jobs. Himalaya CLI binary installed for SMTP. | Existing (expanded) |
| `open-brain-slack-bot` | build: target=slack-bot | @slack/bolt Socket Mode | Existing |
| `open-brain-voice-pipecat` | build: target=voice-pipecat | Pipecat pipeline: VAD→STT (Deepgram cloud, primary; faster-whisper optional batch fallback)→LLM→TTS, Twilio SIP | NEW (replaces voice-capture + faster-whisper) |
| `open-brain-web` | build: target=web | Vite + React + shadcn/ui dashboard (nginx, PWA) | Existing (expanded) |
| `open-brain-cloudflared` | cloudflare/cloudflared:latest | Cloudflare Tunnel | Existing |

**Net change:** 8 containers (down from 9). The `voice-capture` and `faster-whisper` containers are replaced by a single `voice-pipecat` container that uses Deepgram cloud STT for real-time voice (no local model loading required). Faster-whisper remains available as an optional batch-mode fallback.

### 6.3 Data Flow

```
Voice (Pipecat)                    Slack                    MCP / API
     │                               │                         │
     │ real-time streaming            │ Socket Mode             │ HTTP
     │ session in Redis               │                         │
     ▼                               ▼                         ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │                    core-api (Hono)                               │
 │  POST /api/v1/captures                                          │
 │  POST /api/v1/voice/sessions                                    │
 │  GET  /api/v1/wiki/*                                            │
 │  GET  /api/v1/system/health                                     │
 │  POST /mcp (Streamable HTTP)                                    │
 └──────────────────────┬───────────────────────────────────────────┘
                        │
                        ▼
 ┌──────────────────────────────────────────────────────────────────┐
 │                    BullMQ (Redis)                                │
 │                                                                  │
 │  Ingest Flow (parallel DAG):                                     │
 │    ┌─────────────┐                                               │
 │    │ ingest-root │ (parent — waits for children)                 │
 │    └──────┬──────┘                                               │
 │      ┌────┴────┐                                                 │
 │      ▼         ▼                                                 │
 │  ┌────────┐ ┌──────────────┐                                     │
 │  │ embed  │ │ extract-     │  (run in parallel)                  │
 │  │capture │ │ entities     │                                     │
 │  └────┬───┘ └──────┬───────┘                                     │
 │       └──────┬─────┘                                             │
 │              ▼                                                   │
 │       ┌─────────────┐                                            │
 │       │link-entities │ (depends on both)                         │
 │       └──────┬──────┘                                            │
 │              ▼                                                   │
 │    ┌──────────────────┐                                          │
 │    │ check-triggers + │                                          │
 │    │ wiki-ingest +    │ (parallel post-processing)               │
 │    │ notify           │                                          │
 │    └──────────────────┘                                          │
 └──────────────────────────────────────────────────────────────────┘
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
     ┌──────────────┐    ┌─────────────────┐
     │  Postgres    │    │  Wiki (Gitea)   │
     │  captures,   │    │  markdown files, │
     │  entities,   │    │  git history     │
     │  associations│    │                  │
     └──────────────┘    └─────────────────┘
```

---

## 7. Feature Specifications

### F1: Pipecat Conversational Voice Service

**Priority:** Must Have
**Dependency:** None (can develop independently)

#### 7.1.1 Description

Replace the existing one-shot voice-capture → faster-whisper → text pipeline with a real-time, multi-turn conversational voice interface using the Pipecat framework. Users speak naturally and receive spoken responses; the system maintains conversation context within a session.

#### 7.1.2 Requirements

| ID | Requirement |
|----|-------------|
| F1.1 | Pipecat pipeline: VAD (Silero) → STT (Deepgram cloud, primary real-time; faster-whisper large-v3 as optional batch fallback) → LLM (Claude SDK) → TTS (configurable: Kokoro local or ElevenLabs cloud). **Phase 0 spike:** test Deepgram latency on real hardware before committing to full implementation. |
| F1.2 | Session state stored in Redis with configurable TTL (default 30 minutes). Session includes full conversation history (user + assistant turns), session metadata (start time, duration, turn count), and extracted captures. |
| F1.3 | iOS Shortcut integration: existing Shortcut updated to connect to Pipecat WebSocket endpoint instead of HTTP POST. Fallback to one-shot transcription if Pipecat is unavailable. |
| F1.4 | Twilio SIP trunk support (optional, configurable): assign a phone number that connects to Pipecat for voice interaction from any phone. Configuration stored in `config/voice.yaml`. |
| F1.5 | At conversation end (silence timeout or user says "done"), system creates one or more captures from the conversation, each routed through the standard ingest pipeline (embed, extract entities, wiki-ingest). |
| F1.6 | Full conversation transcript stored in a `voice_sessions` Postgres table with columns: id, session_key, started_at, ended_at, duration_seconds, turn_count, transcript (JSONB array of turns), captures_created (integer array of capture IDs), metadata (JSONB). |
| F1.7 | LLM has access to Open Brain search and entity lookup as tools during voice conversations, enabling "what did I capture about X last week" style queries in real time. |
| F1.8 | Interrupt handling: user can speak while TTS is playing; Pipecat cancels current TTS and processes new input. |
| F1.9 | Health endpoint at `/health` reporting STT model loaded status, active session count, and TTS provider availability. |

#### 7.1.3 Configuration

```yaml
# config/voice.yaml
stt:
  provider: deepgram  # deepgram | faster-whisper
  model: nova-2  # deepgram model; ignored if provider is faster-whisper
  # deepgram_api_key: stored in Bitwarden
  fallback:
    provider: faster-whisper
    model: large-v3
    compute_type: int8
    device: cpu

tts:
  provider: kokoro  # kokoro | elevenlabs
  voice: af_heart  # provider-specific voice ID
  # elevenlabs_api_key: stored in Bitwarden

llm:
  task_type: conversation  # routes via model router
  tools:
    - search_brain
    - get_entity
    - create_capture

session:
  ttl_minutes: 30
  silence_timeout_seconds: 120
  max_turns: 100

twilio:
  enabled: false
  # sip_trunk_sid: stored in Bitwarden
  # phone_number: +1XXXXXXXXXX
```

---

### F2: Wiki Layer (Karpathy Pattern)

**Priority:** Must Have
**Dependency:** None (can develop independently)

#### 7.2.1 Description

Add an LLM-maintained wiki as a compiled knowledge layer alongside Open Brain's operational memory. The wiki is a Git-backed collection of interlinked markdown files hosted on the existing Gitea instance (gitea.k4jda.net). The LLM writes and maintains the wiki; the user reads it and directs the analysis.

#### 7.2.2 Architecture

Three sub-layers:

- **Raw sources** — Open Brain captures, uploaded documents, and any explicitly ingested materials. Immutable.
- **The wiki** — LLM-generated markdown files. Summaries, entity pages, concept pages, comparisons, synthesis documents, overview, contradiction log. The LLM owns this layer entirely.
- **The schema** — A `WIKI_SCHEMA.md` file in the wiki repo root that defines structure, conventions, page types, and workflows. Co-evolved by user and LLM.

#### 7.2.3 Requirements

| ID | Requirement |
|----|-------------|
| F2.1 | Wiki stored as a Git repository on Gitea at `gitea.k4jda.net/davistroy/open-brain-wiki`. All wiki operations commit changes with descriptive messages. |
| F2.2 | Wiki directory structure: `wiki/` (synthesized pages), `wiki/entities/` (entity pages), `wiki/concepts/` (concept pages), `wiki/sources/` (source summaries), `wiki/comparisons/` (comparative analyses), `wiki/synthesis/` (cross-cutting synthesis). |
| F2.3 | `index.md` — catalog of all wiki pages with one-line summaries, organized by category. Updated on every ingest. LLM reads this first when answering queries to find relevant pages. |
| F2.4 | `log.md` — append-only chronological record of all wiki operations (ingests, queries filed as pages, lint passes). Each entry prefixed with `## [YYYY-MM-DD] operation | title` for grep-ability. |
| F2.5 | `WIKI_SCHEMA.md` — defines page types, frontmatter conventions, cross-reference syntax (standard markdown links), naming conventions, and maintenance workflows. |
| F2.6 | **Wiki-ingest job** — BullMQ job triggered after entity extraction in the ingest pipeline. The LLM reads the new capture, identifies relevant existing wiki pages, and updates them. Creates new pages for new entities or concepts. A single capture may touch 5-15 wiki pages. |
| F2.7 | **Wiki-lint job** — scheduled weekly (BullMQ job scheduler). Detects: contradictions between pages, stale claims superseded by newer captures, orphan pages with no inbound links, concepts mentioned but lacking their own page, missing cross-references. Results stored in `wiki/maintenance/lint-report.md` and surfaced in dashboard. |
| F2.8 | **Wiki-synthesis job** — scheduled daily. Identifies captures from the last 24 hours not yet integrated into the wiki and queues wiki-ingest jobs for them. |
| F2.9 | Wiki pages use YAML frontmatter: `title`, `type` (entity|concept|source|comparison|synthesis), `created`, `updated`, `source_count` (number of captures contributing), `tags`. |
| F2.10 | Core-api endpoints for wiki access: `GET /api/v1/wiki/pages` (list with metadata), `GET /api/v1/wiki/pages/:path` (render page content), `GET /api/v1/wiki/recent-changes` (git log), `GET /api/v1/wiki/lint-report` (latest lint results), `POST /api/v1/wiki/ingest` (trigger manual ingest of a capture), `POST /api/v1/wiki/lint` (trigger manual lint). |
| F2.11 | MCP tools for wiki access: `search_wiki` (full-text search across wiki pages), `read_wiki_page` (read a specific page), `write_wiki_page` (create or update a page with auto-commit), `list_wiki_pages` (list pages with optional type filter). |
| F2.12 | Wiki search: initially via `index.md` scanning. When page count exceeds 200, integrate qmd or a custom FTS5 index over the markdown files. |
| F2.13 | All wiki LLM operations use the `synthesis` model alias (routed to Opus-class model) for quality. |

#### 7.2.4 Page Types

| Type | Description | Example |
|------|-------------|---------|
| Entity | Page for a person, organization, project, or system | `entities/chick-fil-a-support-now.md` |
| Concept | Page for an idea, methodology, or domain concept | `concepts/ai-judgment-skills.md` |
| Source | Summary of a specific ingested document or capture cluster | `sources/2026-04-10-pipecat-architecture-research.md` |
| Comparison | Side-by-side analysis of two or more items | `comparisons/bullmq-vs-rabbitmq.md` |
| Synthesis | Cross-cutting analysis connecting multiple entities/concepts | `synthesis/contact-center-ai-transformation-thesis.md` |
| Overview | Top-level summary of the entire wiki or a major domain | `overview.md` |

---

### F3: Pipeline Modernization (BullMQ Flows)

**Priority:** Must Have
**Dependency:** None

#### 7.3.1 Description

Restructure the existing sequential ingest pipeline (embed → extract-entities → link-entities → check-triggers → notify) into parallel BullMQ flow DAGs. Elevate BullMQ from pipeline processor to the central nervous system handling all system operations.

#### 7.3.2 Requirements

| ID | Requirement |
|----|-------------|
| F3.1 | Ingest pipeline restructured as a BullMQ flow using FlowProducer. Root job (`ingest-root`) has two parallel children: `embed-capture` and `extract-entities`. Both must complete before `link-entities` (parent of those two children) proceeds. Post-linking, `check-triggers`, `wiki-ingest`, and `notify` run as parallel children of a second-level parent. |
| F3.2 | All existing pipeline behavior preserved: status flow (pending → processing → complete), retry policy (5 attempts, patient backoff: 30s, 2m, 10m, 30m, 2h), daily auto-sweep of stuck jobs. |
| F3.3 | `failParentOnFailure` set on critical children (embed, extract). If embedding fails, the entire flow fails and retries. Wiki-ingest failure should NOT fail the parent (use `ignoreDependencyOnFailure`). |
| F3.4 | New queue: `wiki-ingest` — receives jobs after entity linking. Calls the LLM to integrate the capture into the wiki. Rate-limited to 5 jobs/minute to control LLM costs. |
| F3.5 | New queue: `wiki-maintenance` — handles lint, synthesis, and manual wiki operations. Lower priority than ingest. |
| F3.6 | New queue: `voice-conversation` — handles post-conversation processing (transcript storage, capture creation, entity extraction). |
| F3.7 | New queue: `reflection` — handles scheduled intelligence skills (drift detection, daily connections, monthly reflection). Separate queue to allow independent pause/resume. |
| F3.8 | Dynamic rate limiting on embed queue tied to non-Claude spend tracking (embeddings via LiteLLM). When monthly non-Claude spend exceeds $7 (soft limit), `worker.rateLimit()` throttles embed jobs. At $10 (hard limit), circuit breaker pauses the queue entirely. Claude calls are subscription-covered and exempt from rate limiting. |
| F3.9 | Deduplication on ingest queue using capture content hash as dedup key with 5-minute TTL. Prevents duplicate voice captures from iOS Shortcut retries. |
| F3.10 | All jobs include OpenTelemetry span attributes (job name, queue, capture ID, flow ID) for observability. |

---

### F4: Intelligence Engine (Dual-Client Model Routing)

**Priority:** Must Have
**Dependency:** None

#### 7.4.1 Description

Route LLM calls through two client paths based on provider:

- **Claude SDK** (Anthropic API) used directly for all Claude model calls. Covered by Claude Code subscription — zero marginal cost for Sonnet, Opus, and Haiku.
- **LiteLLM proxy** at llm.k4jda.net handles all non-Claude traffic: OpenAI embeddings (text-embedding-3-large) and DGX Spark local models (vLLM). Provides cost tracking via LiteLLM's spend API.

There is no single model router module. Instead, two client factories: `createClaudeClient()` for the Anthropic SDK, and the existing `createLiteLLMClient()` from `@open-brain/shared` for everything routed through LiteLLM.

**v1 overlap acknowledgment:** `config/ai-routing.yaml` already exists with task type aliases. `ConfigService` already resolves aliases to model names at init time. `createLiteLLMClient()` already exists in `@open-brain/shared`. This feature extends the existing pattern by adding the Claude SDK client path and unified usage tracking.

#### 7.4.2 Task Type Routing

| Task Type | Provider | Model | Cost |
|-----------|----------|-------|------|
| fast | Claude SDK (subscription) | Sonnet | $0 (subscription) |
| synthesis | Claude SDK (subscription) | Opus | $0 (subscription) |
| conversation | Claude SDK (subscription) | Sonnet | $0 (subscription) |
| governance | Claude SDK (subscription) | Opus | $0 (subscription) |
| intent | Claude SDK (subscription) | Haiku | $0 (subscription) |
| embedding | LiteLLM → OpenAI | text-embedding-3-large | ~$0.13/1M tokens |
| local | LiteLLM → DGX Spark vLLM | Qwen-3 | $0 (self-hosted) |

#### 7.4.3 Requirements

| ID | Requirement |
|----|-------------|
| F4.1 | `createClaudeClient()` factory in `packages/shared` — returns an Anthropic SDK client configured with the subscription API key (from Bitwarden). Used by all code paths that call Claude models. |
| F4.2 | `createLiteLLMClient()` (existing) — continues to route non-Claude traffic through LiteLLM proxy at llm.k4jda.net. Used for embeddings and DGX Spark local models. |
| F4.3 | Task types and routing defined in `config/ai-routing.yaml` (existing file, expanded): `fast` (Sonnet), `synthesis` (Opus), `conversation` (Sonnet), `governance` (Opus), `intent` (Haiku), `embedding` (text-embedding-3-large via LiteLLM), `local` (DGX Spark vLLM via LiteLLM). |
| F4.4 | Spend tracking: every LLM call (both Claude and LiteLLM) logs token usage (input, output, cache read/write) to a `llm_usage` Postgres table. Claude calls logged with `cost_usd = 0` (subscription-covered). LiteLLM calls logged with actual cost from LiteLLM spend API. Aggregated by day and model. |
| F4.5 | `runAgent(systemPrompt, tools, userMessage, options)` function that implements the Claude tool_use loop via the Anthropic SDK: send message → if tool_use in response, execute tool, append result, loop → return final text response. This is the sole agent runtime for the system. |
| F4.6 | Fallback behavior: if primary provider is unavailable (429, 500, timeout), route to fallback provider defined in config. If all providers fail, queue the job for retry via BullMQ's retry mechanism. |
| F4.7 | Both client factories are stateless — all state is in config + Postgres. Can be imported by any package in the monorepo. |

---

### F5: Scheduled Intelligence Skills (New)

**Priority:** Should Have
**Dependency:** F2 (Wiki Layer), F3 (Pipeline Modernization)

#### 7.5.1 Description

Add new scheduled intelligence skills beyond the existing weekly brief, governance, and memory consolidation. All skills run as BullMQ job schedulers on the `reflection` queue.

#### 7.5.2 Requirements

| ID | Requirement |
|----|-------------|
| F5.1 | **Wiki lint** — weekly, Sundays 5 AM. Runs contradiction detection, orphan detection, stale claim identification across all wiki pages. Writes `wiki/maintenance/lint-report.md`. Sends Pushover summary notification. |
| F5.2 | **Wiki synthesis** — daily, 6 AM. Identifies captures from last 24 hours not yet integrated into wiki. Queues wiki-ingest jobs for each. |
| F5.3 | **Drift detection** — weekly, Mondays 8 AM. Scans entity graph for tracked projects/bets/people that have had no new captures in 14+ days. Sends Pushover alert listing silent items. (Previously deferred as F22.) |
| F5.4 | **Daily connections** — daily, 7 AM. Uses spreading activation to find non-obvious connections between captures across different brain views (e.g., a technical observation that connects to a client insight). Files interesting connections as wiki synthesis pages. (Previously deferred as F21.) |
| F5.5 | **Monthly reflection** — monthly, 1st of month, 9 AM. Generates a comprehensive "state of Troy" synthesis across all brain views: career momentum, active projects, technical exploration, personal patterns. Filed as a wiki synthesis page and sent as HTML email. |
| F5.6 | All skill schedules editable via the existing Settings UI inline cron editor with YAML write-back to `config/skills.yaml`. |
| F5.7 | All skills store their full LLM interaction (system prompt, messages, tool calls, final output) as metadata on the BullMQ job for auditability. Viewable in the dashboard System view. |

---

### F6: Dashboard — System Health Strip

**Priority:** Must Have
**Dependency:** F3 (Pipeline Modernization)

#### 7.6.1 Description

A persistent, compact status bar displayed across the top of every dashboard page. Provides at-a-glance system health without requiring navigation to a dedicated monitoring page.

#### 7.6.2 Requirements

| ID | Requirement |
|----|-------------|
| F6.1 | Strip displays: pipeline queue depths (waiting + active counts for each queue), last successful skill run (name + relative time), voice service status (up/down + active sessions), email channel status (outbound SMTP health + pending drafts count), Redis memory usage, monthly non-Claude spend vs. budget ($X / $10), overall system status indicator (green/yellow/red). |
| F6.2 | Data refreshed via SSE from core-api `/api/v1/system/health/stream` endpoint. Updates every 10 seconds. |
| F6.3 | Indicators turn yellow at warning thresholds: queue depth > 50, non-Claude spend > $7, Redis memory > 80%, any skill not run in 2x its schedule interval. Turn red at critical: queue depth > 200, non-Claude spend > $10, Redis memory > 95%, voice service down, any container unhealthy. |
| F6.4 | Clicking any indicator navigates to the relevant detail view (System page for queues, Settings for spend, Voice for sessions). |
| F6.5 | Strip collapses to a single status dot on mobile viewport widths, expandable on tap. |
| F6.6 | Core-api endpoint: `GET /api/v1/system/health` returns JSON with all health metrics. `GET /api/v1/system/health/stream` returns SSE stream. |

---

### F7: Dashboard — Unified Activity Feed

**Priority:** Must Have
**Dependency:** F2 (Wiki Layer), F1 (Pipecat Voice)

#### 7.7.1 Description

Rework the dashboard Home page from the current timeline view into a unified activity feed that merges all system activity streams into a single, filterable, reverse-chronological view.

#### 7.7.2 Requirements

| ID | Requirement |
|----|-------------|
| F7.1 | Feed includes: new captures (all types including email-inbound/outbound), wiki page creates/updates (from git log), voice conversation summaries, email drafts sent, scheduled skill completions (with outcome), pipeline failures, entity merges/creates, infrastructure alerts (backup failures, health check failures). |
| F7.2 | Each feed item has: timestamp, type icon, title, one-line summary, and optional expandable detail. Clicking navigates to the relevant detail view. |
| F7.3 | Filter bar: filter by activity type (captures, wiki, voice, skills, system), brain view (career, personal, technical, work-internal, client), and date range. Filters persist in URL query params. |
| F7.4 | "Since you've been away" mode: on first load, highlights items since last dashboard visit (tracked via localStorage timestamp). Shows count badge: "23 new items since yesterday." |
| F7.5 | Core-api endpoint: `GET /api/v1/activity/feed` with query params for type, view, since, limit, offset. Returns unified feed items sorted by timestamp descending. |
| F7.6 | SSE endpoint: `GET /api/v1/activity/feed/stream` pushes new items in real time. Feed auto-prepends new items with a subtle animation. |

---

### F8: Dashboard — Wiki Browser

**Priority:** Must Have
**Dependency:** F2 (Wiki Layer)

#### 7.8.1 Description

A read-only browser for the wiki layer within the dashboard. Not a full editor — the LLM maintains the wiki. The browser provides navigation, search, and oversight.

#### 7.8.2 Requirements

| ID | Requirement |
|----|-------------|
| F8.1 | Two-panel layout: navigation tree on the left (mirroring wiki directory structure, collapsible), rendered markdown on the right. |
| F8.2 | Markdown rendering uses the same component as the existing Help page. Supports: headings, lists, tables, code blocks with syntax highlighting, YAML frontmatter display (subtle metadata header above content), and internal wiki links as clickable navigation. |
| F8.3 | Page metadata header shows: title, type badge, last updated (relative time), source count, tags. |
| F8.4 | "Recent Changes" tab: reverse-chronological list of wiki modifications pulled from git log. Each entry shows: date, page path, commit message (which describes the change), and diff stats (lines added/removed). |
| F8.5 | "Health" tab: displays the latest lint report. Shows counts for each issue type (contradictions, orphans, stale claims, missing pages, missing cross-refs). Each issue is clickable to navigate to the relevant page. |
| F8.6 | Search box: full-text search across wiki pages. Results show page title, type, matching snippet, and relevance score. |
| F8.7 | Action buttons (minimal): "Run Lint Now" (fires wiki-lint BullMQ job), "Re-synthesize Page" (fires wiki-ingest job for the current page's source captures). Both show a toast confirmation and the result appears when the job completes. |
| F8.8 | Lazy-loaded route chunk (`/wiki/*`) due to markdown rendering weight. |

---

### F9: Dashboard — Voice Conversations View

**Priority:** Should Have
**Dependency:** F1 (Pipecat Voice)

#### 7.9.1 Description

A conversation log and transcript viewer for Pipecat voice sessions. Think call log with full transcripts.

#### 7.9.2 Requirements

| ID | Requirement |
|----|-------------|
| F9.1 | List view: reverse-chronological list of voice sessions. Each row shows: date/time, duration, turn count, number of captures created, and a one-line summary (LLM-generated at session end). |
| F9.2 | Detail view: full conversation transcript rendered as a chat-style layout (user turns left-aligned, assistant turns right-aligned). Each turn shows the text content and timestamp. |
| F9.3 | Linked captures: sidebar or bottom section showing the captures extracted from this conversation, each clickable to navigate to capture detail. |
| F9.4 | Linked wiki pages: list of wiki pages touched as a result of this conversation's captures. |
| F9.5 | Active session indicator: if a voice session is currently active, show a pulsing indicator with session duration and turn count, updating in real time via SSE. |

---

### F10: Dashboard — Agent Activity Log

**Priority:** Should Have
**Dependency:** None (MCP endpoint already exists)

#### 7.10.1 Description

A log of all MCP interactions — when Claude Code or other MCP clients search the brain, create captures, or modify the wiki. Provides transparency into "what did the AI do with my brain."

#### 7.10.2 Requirements

| ID | Requirement |
|----|-------------|
| F10.1 | Log MCP tool calls to a `mcp_activity` Postgres table: timestamp, client_id (from auth token), tool_name, parameters (JSONB), result_summary (truncated), duration_ms. |
| F10.2 | Dashboard view: reverse-chronological list of MCP calls. Filterable by tool name and client. Expandable to show full parameters and result. |
| F10.3 | For scheduled skills that use the LLM, store the full interaction chain (system prompt, messages, tool calls) as job metadata. Viewable in an expandable "Reasoning" panel within the System view's job detail. |

---

### F11: Dashboard — Pipeline & Queue Management (Enhanced)

**Priority:** Must Have
**Dependency:** F3 (Pipeline Modernization)

#### 7.11.1 Description

Enhanced pipeline and queue management integrated into the dashboard, replacing the standalone BullBoard view.

#### 7.11.2 Requirements

| ID | Requirement |
|----|-------------|
| F11.1 | "System" tab in dashboard navigation. Sub-tabs: Queues, Flows, Skills, Infrastructure, MCP Activity. |
| F11.2 | **Queues view**: each queue shown as a card with: name, waiting/active/completed/failed counts, throughput sparkline (jobs/hour over last 24h), rate limit status. Buttons: pause/resume, clear failed, retry all failed. |
| F11.3 | **Flows view**: for active and recent BullMQ flows, render the flow tree as a vertically stacked DAG. Each node shows: job name, queue, state (color-coded: gray=waiting, blue=active, green=completed, red=failed, yellow=waiting-children). Click a node to expand job details (data, logs, timestamps, error if failed). |
| F11.4 | **Skills view**: list of all job schedulers (intelligence AND infrastructure) with: name, category badge (intelligence/infrastructure), cron expression (human-readable), next fire time, last run time, last run status, last run duration. Inline cron editor (existing capability). Run-now button for each skill. Filter by category. |
| F11.5 | **Infrastructure view**: container health status grid (green/yellow/red per container with uptime duration), latest backup status (date, size, success/fail per backup type), LLM cost summary (today, this week, this month with sparkline trend), storage usage breakdown (Postgres, Redis, backups, wiki, documents). Data from `container_health` table and infrastructure skill outputs. |
| F11.6 | **MCP Activity view**: as defined in F10. |
| F11.7 | Queue depth and failure count data available via core-api: `GET /api/v1/system/queues` (snapshot), `GET /api/v1/system/queues/stream` (SSE). |

---

### F12: Dashboard — Settings Expansion

**Priority:** Should Have
**Dependency:** F1, F2, F4

#### 7.12.1 Description

Extend the existing Settings page with new sections for AI routing, voice configuration, wiki configuration, and integration status.

#### 7.12.2 Requirements

| ID | Requirement |
|----|-------------|
| F12.1 | **AI Routing section**: displays current model routing table (task type → provider → model). Shows monthly spend by model with progress bar against budget. Rate limit status for each provider. Editable inline; writes back to `config/ai-routing.yaml`. |
| F12.2 | **Voice section**: STT provider and model selection, TTS provider and voice selection, session TTL, silence timeout. Twilio SIP trunk enable/disable with trunk SID and phone number fields. Writes to `config/voice.yaml`. |
| F12.3 | **Wiki section**: Gitea repo URL (read-only display), schema overview (rendered WIKI_SCHEMA.md), lint schedule (cron editor), auto-ingest toggle (whether new captures automatically trigger wiki-ingest or require manual trigger). |
| F12.4 | **Integrations section**: MCP endpoint URL and status (connected clients, last call time), Slack workspace info and bot status, Cloudflare tunnel status, Gitea connectivity status, email status (CF worker inbound health, Himalaya SMTP outbound health). Read-only status display, not configuration (secrets stay in Bitwarden). |
| F12.5 | **Email section**: Inbound email status (CF Email Worker, sender allowlist managed via existing Settings page). Outbound email defaults (from address, signature, default send mode). Himalaya SMTP status display. |

---

---

### F13: Email Channel (Outbound via Himalaya)

**Priority:** Must Have
**Dependency:** F3 (Pipeline Modernization)

#### 7.13.1 Description

Add outbound email composition and sending via Himalaya CLI. The brain can draft emails (via scheduled skills, Slack commands, or MCP tools) and send them through Himalaya's SMTP backend.

**Inbound email is already handled** by the existing Cloudflare Email Worker at brain@troy-davis.com. The CF worker is push-based (instant delivery), requires no polling, and already routes emails through the full ingest pipeline with sender allowlist managed via the dashboard Settings page. This feature does NOT replace the CF worker.

Himalaya is a stateless Rust CLI that outputs JSON — ideal for a BullMQ worker to shell out to. No event loop, no daemon, no additional container. The `himalaya` binary runs inside the existing workers container, configured for SMTP only.

#### 7.13.2 Architecture

```
Inbound (existing — no changes):
  Email → Cloudflare Email Worker (brain@troy-davis.com)
    → POST /api/v1/captures on core-api
    → standard ingest pipeline (embed → extract → link → notify)
    → sender allowlist via dashboard Settings page

Outbound (NEW):
  LLM composes email (via runAgent with email tools)
    → draft stored in email_drafts table
    → if auto-send: himalaya template send (pipes template via stdin)
    → if review-required: Pushover notification → user approves via Slack or dashboard → then send
    → sent email logged as capture (type: email-outbound)
```

#### 7.13.3 Requirements

| ID | Requirement |
|----|-------------|
| F13.1 | Himalaya CLI binary installed in the workers container image. Configuration file at `config/himalaya/config.toml` with SMTP credentials sourced from Bitwarden (injected at container start via `load-secrets.sh`). SMTP only — no IMAP configuration needed. |
| F13.4 | **Email thread tracking** — extends the existing CF worker pipeline. `in_reply_to` and `references` headers stored in capture metadata. When an inbound email is part of a thread, the system links it to previous email captures via the `message_id` chain. Entity extraction treats email threads as connected conversations. |
| F13.5 | **Attachment handling** — for outbound email context. When drafting a reply, the system can reference attachments from the original inbound email capture (already stored by CF worker pipeline). |
| F13.6 | **Outbound email composition** — `runAgent()` with email-specific tools: `draft_email(to, subject, body)`, `search_brain(query)` (for context), `get_entity(name)` (for contact details). Draft stored in `email_drafts` table with status `draft`. |
| F13.7 | **Outbound email sending** — two modes configured per use case: `auto-send` (draft immediately sent via `himalaya template send`) or `review-required` (Pushover notification sent; user approves via Slack `/email approve <draft_id>` or dashboard button; then sent). Sent emails logged as captures with `capture_type: 'email-outbound'`. |
| F13.8 | **Slack integration** — `/email` slash command with subcommands: `/email send <to> <subject>` (brain drafts and queues email), `/email drafts` (list pending drafts), `/email approve <id>` (approve and send a draft), `/email reject <id>` (discard draft). |
| F13.9 | **Scheduled email skills** — the weekly brief and monthly reflection skills gain an option to deliver via email in addition to Pushover. Configurable per skill in `config/skills.yaml`. Uses Himalaya for sending (replaces the existing nodemailer/SMTP path for consistency). |
| F13.10 | **Outbound routing rules** — configurable in `config/email.yaml`: outbound defaults (from address, signature), auto-send rules for skill outputs. Inbound routing rules already exist in the CF Email Worker configuration. |
| F13.11 | **MCP tools** for email: `draft_email(to, subject, body)` (create draft), `send_email(draft_id)` (send approved draft), `search_email_captures(query)` (search email-type captures). |

#### 7.13.4 Configuration

```yaml
# config/email.yaml
himalaya:
  config_path: /app/config/himalaya/config.toml
  default_account: personal  # matches [accounts.personal] in himalaya config

# Inbound email handled by Cloudflare Email Worker — no config here.
# Sender allowlist managed via dashboard Settings page (app_settings table).

outbound:
  default_from: troy@troy-davis.com
  signature: |
    Troy Davis
    Stratfield Consulting
  default_mode: review-required  # review-required | auto-send
  auto_send_rules:
    - type: skill-output  # weekly briefs, reflections auto-send
    - match:
        to: "self"  # emails to self always auto-send
```

```toml
# config/himalaya/config.toml
[accounts.personal]
email = "troy@troy-davis.com"
display-name = "Troy Davis"
default = true

# SMTP only — inbound handled by Cloudflare Email Worker
message.send.backend.type = "smtp"
message.send.backend.host = "smtp.example.com"
message.send.backend.port = 587
message.send.backend.encryption.type = "start-tls"
message.send.backend.login = "troy@troy-davis.com"
message.send.backend.auth.type = "password"
message.send.backend.auth.cmd = "cat /run/secrets/smtp_password"
```

---

### F14: Infrastructure Skills

**Priority:** Must Have
**Dependency:** F3 (Pipeline Modernization), F4 (Model Router)

#### 7.14.1 Description

Operational scheduled jobs that keep the system healthy, auditable, and cost-aware. These are distinct from intelligence skills (F5) — they manage the infrastructure itself rather than producing knowledge. All run as BullMQ job schedulers on a dedicated `infrastructure` queue.

#### 7.14.2 Requirements

| ID | Requirement |
|----|-------------|
| F14.1 | **Database backup** — daily, 2 AM. `pg_dump` of the full Open Brain database to a compressed file in `/mnt/backups/open-brain/`. Retention: 7 daily, 4 weekly, 3 monthly. Old backups pruned automatically. Pushover notification on success with backup size; alert on failure. |
| F14.2 | **Wiki backup** — daily, 2:15 AM. Git bundle of the wiki repo to `/mnt/backups/open-brain-wiki/`. Same retention policy as database backups. Redundant with Gitea's own storage, but ensures recovery even if Gitea is down. |
| F14.3 | **Redis snapshot** — daily, 2:30 AM. Trigger `BGSAVE`, copy the RDB file to `/mnt/backups/open-brain-redis/`. Retention: 7 daily. |
| F14.4 | **LLM cost analysis** — daily, 7 AM. Query `llm_usage` table for previous day's spend. Aggregate by model and task type. If daily spend exceeds $2 (configurable), include a breakdown in the Pushover notification. Weekly summary every Monday with 7-day trend. Monthly report on the 1st with full cost breakdown, projected monthly spend, and comparison to previous month. Report stored as a wiki page under `wiki/operations/cost-reports/`. |
| F14.5 | **Pipeline health audit** — every 6 hours. Check for: jobs stuck in active state for >30 minutes (likely stalled worker), failed jobs with no remaining retries, queue depths exceeding thresholds (>100 waiting), job schedulers that haven't fired within 2x their expected interval. Auto-remediation: move stalled jobs back to waiting, alert on persistent failures. |
| F14.6 | **Storage audit** — weekly, Sundays 3 AM. Report on: Postgres database size, Redis memory usage, backup storage used, wiki repo size, document storage used, total captures count and growth rate. Stored as wiki page under `wiki/operations/storage-reports/`. |
| F14.7 | **Container health check** — every 15 minutes. Hit `/health` endpoint on each container. If any container is unhealthy for 3 consecutive checks, send Pushover alert. Log health history to `container_health` table for dashboard display. |
| F14.8 | **Secret rotation reminder** — monthly, 1st of month, 10 AM. Check age of secrets in Bitwarden via `bws` CLI. Alert if any API key is >90 days old. |
| F14.9 | **Capture deduplication sweep** — weekly, Saturdays 4 AM. Scan for near-duplicate captures (cosine similarity >0.95) that weren't caught by real-time dedup. Flag for review in dashboard rather than auto-merging (supplements existing memory consolidation which uses 0.92 threshold for deliberate merging). |
| F14.10 | All infrastructure skills log their results to the `skill_runs` table (existing pattern) and appear in the dashboard System → Skills view alongside intelligence skills. Distinguished by a `category: infrastructure` tag. |

---

### F15: Dashboard — Email View

**Priority:** Should Have
**Dependency:** F13 (Email Channel)

#### 7.15.1 Description

A dashboard page for monitoring and managing email activity — inbound emails (received via Cloudflare Email Worker) that became captures, outbound drafts awaiting approval, and sent email history.

#### 7.15.2 Requirements

| ID | Requirement |
|----|-------------|
| F15.1 | **Inbound tab**: reverse-chronological list of email-type captures (delivered by CF Email Worker). Each row shows: date, from, subject, brain view assignment, entity count extracted, wiki pages touched. Click to open capture detail view (existing). Filter by brain view, date range, sender. |
| F15.2 | **Drafts/Outbox tab**: list of email drafts with status badges (draft, approved, sent, rejected). Each row shows: date created, to, subject, status, source (which skill or command created it). Pending drafts show "Approve" and "Reject" buttons. Click to expand full draft content. |
| F15.3 | **Thread view**: when an inbound email is part of a thread (linked via `in_reply_to`/`references` metadata), show the full thread as a vertically stacked conversation with alternating alignment (inbound left, outbound right). Each message links to its capture. |
| F15.4 | **Quick actions**: "Compose" button (opens a simple form: to, subject, context prompt — brain drafts the email body via LLM, creates a draft in review-required mode). No "Check Now" poll button needed — inbound email is push-based via CF worker. |
| F15.5 | Core-api endpoints: `GET /api/v1/email/inbound` (paginated list of email-type captures), `GET /api/v1/email/threads/:message_id` (thread reconstruction from capture metadata). Draft endpoints already defined in F13 API additions. |

---

## 8. API Additions

### 8.1 New Core-API Endpoints

| Method | Path | Description | Feature |
|--------|------|-------------|---------|
| GET | `/api/v1/system/health` | System health metrics JSON | F6 |
| GET | `/api/v1/system/health/stream` | SSE stream of health updates | F6 |
| GET | `/api/v1/system/queues` | Queue depths and stats | F11 |
| GET | `/api/v1/system/queues/stream` | SSE stream of queue updates | F11 |
| GET | `/api/v1/system/flows` | Active and recent flow trees | F11 |
| GET | `/api/v1/system/flows/:id` | Single flow tree with job details | F11 |
| GET | `/api/v1/system/skills` | Job scheduler list with metadata | F11 |
| POST | `/api/v1/system/skills/:id/run` | Trigger immediate skill run | F11 |
| GET | `/api/v1/activity/feed` | Unified activity feed | F7 |
| GET | `/api/v1/activity/feed/stream` | SSE stream of new activity | F7 |
| GET | `/api/v1/wiki/pages` | List wiki pages with metadata | F8 |
| GET | `/api/v1/wiki/pages/*path` | Get wiki page content | F8 |
| GET | `/api/v1/wiki/recent-changes` | Git log of wiki modifications | F8 |
| GET | `/api/v1/wiki/lint-report` | Latest lint results | F8 |
| GET | `/api/v1/wiki/search` | Full-text search across wiki | F8 |
| POST | `/api/v1/wiki/ingest` | Trigger manual wiki ingest | F8 |
| POST | `/api/v1/wiki/lint` | Trigger manual lint pass | F8 |
| GET | `/api/v1/voice/sessions` | List voice sessions | F9 |
| GET | `/api/v1/voice/sessions/:id` | Get session transcript | F9 |
| GET | `/api/v1/voice/sessions/active` | Get active session status | F9 |
| GET | `/api/v1/mcp/activity` | MCP activity log | F10 |
| GET | `/api/v1/email/drafts` | List pending email drafts | F13 |
| GET | `/api/v1/email/drafts/:id` | Get draft detail | F13 |
| POST | `/api/v1/email/drafts` | Create email draft (LLM-composed) | F13 |
| POST | `/api/v1/email/drafts/:id/send` | Approve and send a draft | F13 |
| DELETE | `/api/v1/email/drafts/:id` | Reject/discard a draft | F13 |
| GET | `/api/v1/email/status` | Email channel health (outbound SMTP connectivity, draft queue) | F13 |
| GET | `/api/v1/email/inbound` | Paginated list of email-type captures | F15 |
| GET | `/api/v1/email/threads/:message_id` | Thread reconstruction from capture metadata | F15 |
| GET | `/api/v1/infra/health` | Container health history and current status | F14 |
| GET | `/api/v1/infra/backups` | Backup history (dates, sizes, status) | F14 |
| GET | `/api/v1/infra/cost-report` | Latest cost analysis data | F14 |
| GET | `/api/v1/system/backups` | List recent backups with sizes and status | F14 |
| GET | `/api/v1/system/costs` | LLM cost summary (daily/weekly/monthly) | F14 |
| GET | `/api/v1/system/costs/detail` | Detailed cost breakdown by model and task type | F14 |

### 8.2 New MCP Tools

| Tool | Description | Feature |
|------|-------------|---------|
| `search_wiki` | Full-text search across wiki pages | F2 |
| `read_wiki_page` | Read a specific wiki page by path | F2 |
| `write_wiki_page` | Create or update a wiki page (auto-commits) | F2 |
| `list_wiki_pages` | List pages with optional type/tag filter | F2 |
| `get_system_health` | Get current system health metrics | F6 |
| `draft_email` | Compose an email draft (to, subject, body) | F13 |
| `send_email` | Send an approved email draft by ID | F13 |
| `search_email_captures` | Search captures of type email-inbound/outbound | F13 |

---

## 9. Database Additions

### 9.1 New Tables

```sql
-- Voice conversation sessions (F1)
CREATE TABLE voice_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key VARCHAR(64) UNIQUE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  turn_count INTEGER DEFAULT 0,
  transcript JSONB DEFAULT '[]'::jsonb,
  summary TEXT,
  captures_created INTEGER[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_voice_sessions_started_at ON voice_sessions(started_at DESC);

-- LLM usage tracking (F4)
CREATE TABLE llm_usage (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  task_type VARCHAR(32) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  model VARCHAR(64) NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cost_usd NUMERIC(10, 6),
  duration_ms INTEGER,
  job_id VARCHAR(128),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_llm_usage_timestamp ON llm_usage(timestamp DESC);
CREATE INDEX idx_llm_usage_task_type ON llm_usage(task_type);
CREATE INDEX idx_llm_usage_daily ON llm_usage(DATE(timestamp), provider);

-- MCP activity log (F10)
CREATE TABLE mcp_activity (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_id VARCHAR(64),
  tool_name VARCHAR(64) NOT NULL,
  parameters JSONB DEFAULT '{}'::jsonb,
  result_summary TEXT,
  duration_ms INTEGER,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_mcp_activity_timestamp ON mcp_activity(timestamp DESC);
CREATE INDEX idx_mcp_activity_tool ON mcp_activity(tool_name);

-- Email drafts (F13)
CREATE TABLE email_drafts (
  id SERIAL PRIMARY KEY,
  to_address TEXT NOT NULL,
  cc_address TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',  -- draft | approved | sent | rejected
  send_mode VARCHAR(20) NOT NULL DEFAULT 'review-required',  -- auto-send | review-required
  source VARCHAR(32),  -- skill name, slack command, mcp tool that created it
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  himalaya_message_id VARCHAR(256),
  capture_id INTEGER REFERENCES captures(id),  -- outbound email capture created after send
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_email_drafts_status ON email_drafts(status);
CREATE INDEX idx_email_drafts_created ON email_drafts(created_at DESC);

-- Container health history (F14)
CREATE TABLE container_health (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  container_name VARCHAR(64) NOT NULL,
  healthy BOOLEAN NOT NULL,
  response_ms INTEGER,
  error TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_container_health_timestamp ON container_health(timestamp DESC);
CREATE INDEX idx_container_health_container ON container_health(container_name, timestamp DESC);

-- Partial index for quick "currently unhealthy" queries
CREATE INDEX idx_container_health_unhealthy ON container_health(container_name, timestamp DESC) WHERE healthy = false;

-- Backup log (F14)
CREATE TABLE backup_log (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  backup_type VARCHAR(16) NOT NULL,  -- database | wiki | redis
  file_path TEXT NOT NULL,
  size_bytes BIGINT,
  duration_seconds INTEGER,
  status VARCHAR(16) NOT NULL,  -- success | failed
  error TEXT,
  pruned_count INTEGER DEFAULT 0
);

CREATE INDEX idx_backup_log_timestamp ON backup_log(timestamp DESC);

-- Unified activity feed (F7)
-- Application-level inserts from all sources — avoids locking and staleness issues of a materialized view.
CREATE TABLE activity_feed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(32) NOT NULL,  -- capture | voice_session | wiki_change | skill_run | mcp_call | email_draft | infra_alert
  subtype VARCHAR(64),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary TEXT,
  view VARCHAR(32),  -- brain view if applicable
  detail JSONB DEFAULT '{}'::jsonb,
  source_id UUID,  -- FK to source record (capture id, session id, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_feed_timestamp ON activity_feed(timestamp DESC);
CREATE INDEX idx_activity_feed_type ON activity_feed(type, timestamp DESC);
```

Activity feed entries are inserted by application logic from all sources (capture creation, wiki git hooks, skill completion, MCP calls, email events, infrastructure alerts). This avoids the locking and staleness issues of a materialized view.

---

## 10. Configuration Files

### 10.1 New Configuration Files

| File | Purpose | Feature |
|------|---------|---------|
| `config/voice.yaml` | Pipecat pipeline configuration | F1 |
| `config/wiki.yaml` | Wiki layer settings (repo URL, lint schedule, auto-ingest toggle) | F2 |
| `config/email.yaml` | Outbound email defaults and routing rules | F13 |
| `config/himalaya/config.toml` | Himalaya SMTP account configuration (credentials from Bitwarden) | F13 |

### 10.2 Modified Configuration Files

| File | Changes | Feature |
|------|---------|---------|
| `config/ai-routing.yaml` | Add `conversation` and `local` task types. Add Claude SDK vs LiteLLM provider routing. Add per-model cost rates for spend tracking. | F4 |
| `config/skills.yaml` | Add wiki-lint, wiki-synthesis, drift-detection, daily-connections, monthly-reflection skill definitions. Add infrastructure skills: db-backup, wiki-backup, redis-snapshot, cost-analysis, pipeline-health-audit, storage-audit, container-health-check, secret-rotation-reminder, dedup-sweep. | F5, F14 |
| `config/pipeline.yaml` | Restructure pipeline stages to reflect flow DAG topology (parallel stages, dependency declarations). | F3 |

---

## 11. Monorepo Package Changes

### 11.1 Modified Packages

| Package | Changes |
|---------|---------|
| `packages/shared` | Add: `create-claude-client.ts` (F4), `run-agent.ts` (F4), wiki Git operations utility, himalaya CLI wrapper utility (SMTP only), activity feed types. Extend existing `createLiteLLMClient()`. Add Drizzle schema for new tables (voice_sessions, llm_usage, mcp_activity, email_drafts, activity_feed, container_health). |
| `packages/core-api` | Add: wiki routes, voice session routes, system health routes, activity feed routes, email draft routes, MCP activity logging middleware, new MCP tools (wiki, email). |
| `packages/workers` | Add: `wiki-ingest` job handler, `wiki-lint` job handler, `wiki-synthesis` job handler, `drift-detection` job handler, `daily-connections` job handler, `monthly-reflection` job handler, `email-send` job handler, `db-backup` job handler, `wiki-backup` job handler, `redis-snapshot` job handler, `cost-analysis` job handler, `pipeline-health-audit` job handler, `storage-audit` job handler, `container-health-check` job handler, `dedup-sweep` job handler. Restructure ingest pipeline to use FlowProducer. Install himalaya binary in container image (SMTP only). |
| `packages/slack-bot` | Add: wiki search slash command (`/wiki <query>`), voice session status query, email slash commands (`/email send`, `/email drafts`, `/email approve`, `/email reject`). |
| `packages/web` | Add: system health strip component, unified activity feed page, wiki browser page, voice conversations page, email drafts page, agent activity log page, enhanced System page (queues, flows, skills), expanded Settings sections (AI routing, voice, wiki, email, integrations). |

### 11.2 New Package

| Package | Purpose |
|---------|---------|
| `packages/voice-pipecat` | Pipecat voice service. Contains: pipeline definition, STT/TTS provider adapters, Claude SDK integration for conversation, session management, capture extraction at session end, health endpoint. |

---

## 12. Navigation Structure

```
Home          — unified activity feed + system health strip (F6, F7)
Captures      — (existing) timeline, search, detail views
Wiki          — browser, recent changes, health/lint results (F8)
Voice         — conversation log, session transcripts (F9)
Email         — inbound log, drafts/outbox, thread view (F13)
Entities      — (existing) graph, detail pages, merge/split
Intelligence  — (group)
  Board       — (existing) governance sessions
  Briefs      — (existing) weekly briefs
System        — queues, flows, skills, MCP activity, infra health (F10, F11, F14)
Settings      — (existing + AI routing, voice, wiki, email, integrations) (F12)
```

Ten top-level items with Intelligence as a collapsible group containing Board and Briefs.

---

## 13. Implementation Phases

### Phase 1: Foundation (Weeks 1-2)

| Item | Features | Effort |
|------|----------|--------|
| Model router (dual-client) | F4 (all) | Add `createClaudeClient()` alongside existing `createLiteLLMClient()`, `runAgent()` via Claude SDK, `llm_usage` tracking table |
| Pipeline flows | F3.1-F3.3 | Restructure ingest to FlowProducer DAGs, preserve all existing behavior |
| System health endpoint | F6.6 | Core-api health/queue endpoints |
| System health strip | F6.1-F6.5 | Dashboard top strip component |

**Validation:** Existing captures ingest correctly via new flow DAGs. Dashboard shows live health strip. Claude calls route through Anthropic SDK; embeddings route through LiteLLM.

### Phase 2: Wiki Layer (Weeks 3-4)

| Item | Features | Effort |
|------|----------|--------|
| Wiki Git infrastructure | F2.1-F2.5 | Gitea repo, schema, index, log, directory structure |
| Wiki API and MCP | F2.10-F2.13 | Core-api wiki endpoints, MCP wiki tools |
| Wiki-ingest worker | F2.6 | BullMQ job handler for wiki integration |
| Wiki browser UI | F8 (all) | Dashboard wiki browser with nav tree, renderer, recent changes, health tab |

**Validation:** Manual capture triggers wiki-ingest. Wiki page created and visible in dashboard. MCP `search_wiki` returns results from Claude Code.

### Phase 3: Pipeline Hardening & Activity Feed (Weeks 5-6)

| Item | Features | Effort |
|------|----------|--------|
| Rate limiting & dedup | F3.4-F3.9 | Dynamic rate limiting on embed queue, dedup on ingest, wiki-ingest rate limit |
| OpenTelemetry | F3.10 | Span attributes on all jobs |
| Activity feed | F7 (all) | Unified feed endpoint, SSE stream, dashboard Home rework |
| MCP activity logging | F10 (all) | Logging middleware, dashboard view |
| Pipeline UI | F11 (all) | Enhanced System page with queues, flows, skills views |

**Validation:** Activity feed shows captures, wiki changes, and skill runs in a single view. Flow DAGs render in System view. MCP calls from Claude Code appear in activity log.

### Phase 4: Scheduled Intelligence & Settings (Weeks 7-8)

| Item | Features | Effort |
|------|----------|--------|
| New skills | F5.1-F5.7 | Wiki lint, wiki synthesis, drift detection, daily connections, monthly reflection |
| Settings expansion | F12 (all) | AI routing, voice, wiki, integrations sections |
| Twilio integration | F1.4 | SIP trunk support in Pipecat (optional, can defer) |

**Validation:** All scheduled skills run on schedule and produce expected outputs. Wiki lint report shows in dashboard. Drift detection sends Pushover alert. Settings edits persist to YAML.

### Phase 5: Outbound Email & Infrastructure Skills (Weeks 9-10)

| Item | Features | Effort |
|------|----------|--------|
| Himalaya integration | F13.1 | Install himalaya binary in workers container, configure SMTP via Bitwarden |
| Outbound email composition & sending | F13.6-F13.7 | LLM draft composition via `runAgent()`, draft table, review-required flow, himalaya send |
| Email thread tracking | F13.4 | Extend existing CF worker pipeline with thread linking |
| Email Slack commands | F13.8 | `/email send`, `/email drafts`, `/email approve`, `/email reject` |
| Email MCP tools | F13.11 | `draft_email`, `send_email`, `search_email_captures` |
| Email dashboard UI | F15 (all) | Email nav page: inbound log (from CF worker), drafts/outbox, thread view |
| Email Settings UI | F12.5 | Outbound defaults, routing rules display |
| Infrastructure skills -- backups | F14.1-F14.3 | Database backup (pg_dump), wiki backup (git bundle), Redis snapshot (BGSAVE), retention policies, Pushover alerts |
| Infrastructure skills -- monitoring | F14.4-F14.7 | LLM cost analysis (daily/weekly/monthly), pipeline health audit (6-hourly), storage audit (weekly), container health check (15-min) |
| Infrastructure skills -- housekeeping | F14.8-F14.9 | Secret rotation reminder, capture deduplication sweep |
| Migrate outbound email | F13.9 | Replace existing nodemailer/SMTP path with Himalaya for all outbound (briefs, governance, reflection) |

**Validation:** Draft email via Slack, approve, verify sent via Himalaya. Inbound emails from CF worker display correctly in Email dashboard view. Database backup restores successfully to test instance. Cost analysis report generates accurate daily/monthly breakdown. Container health check detects intentionally stopped container and sends Pushover alert.

### Phase 6: Voice Conversations (Weeks 11-13)

**Note:** This phase is last due to highest risk. Requires a **Phase 0 spike** (1-2 days before Phase 1) to test Deepgram latency and Pipecat integration on the target hardware. If the spike reveals blocking issues, this phase can be deferred without affecting other v2 features.

| Item | Features | Effort |
|------|----------|--------|
| Phase 0 spike | -- | Test Deepgram STT latency, Pipecat pipeline on Unraid hardware, end-to-end round-trip measurement |
| Pipecat service | F1.1-F1.9 | New container with full Pipecat pipeline (Deepgram STT), session management, capture extraction |
| Voice session storage | F1.6 | Database table, API endpoints |
| Voice conversations UI | F9 (all) | Dashboard voice view |
| iOS Shortcut update | F1.3 | Update Shortcut to connect via WebSocket |

**Validation:** Voice conversation via iOS produces captures with entity extraction. Transcript viewable in dashboard. Deepgram STT delivers <500ms latency. Fallback to one-shot transcription works.

### 13.1 Cost Model

| Component | Provider | Pricing | Monthly Estimate |
|-----------|----------|---------|-----------------|
| Claude LLM calls (all tasks) | Anthropic (subscription) | $0 (included) | $0 |
| Embeddings (text-embedding-3-large) | OpenAI via LiteLLM | $0.13/1M tokens | ~$2-5 |
| Deepgram STT (real-time voice) | Deepgram | $0.0043/min (Nova-2) | ~$1-3 |
| TTS (Kokoro local) | Self-hosted | $0 | $0 |
| Local LLM (DGX Spark) | Self-hosted vLLM | $0 | $0 |
| **Total estimated** | | | **~$3-8/month** |

This is dramatically lower than the original $30/month budget because the Claude Code subscription absorbs all LLM inference costs. The budget concern shifts from LLM spend to subscription value. Only non-Claude costs (embeddings via OpenAI, Deepgram STT) contribute to the monthly bill. LiteLLM's spend API at llm.k4jda.net tracks all non-Claude costs for monitoring.

---

## 14. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Deepgram cloud STT unavailable or latency spikes | Low | High | Deepgram has 99.9% SLA. Monitor latency in Pipecat telemetry. Faster-whisper available as batch fallback (not real-time on CPU). At low volume (~30-60 min/month), cost is negligible (~$1-3/month). Phase 0 spike validates latency before full implementation. |
| Wiki ingest LLM costs with Claude subscription | Low | Low | Claude calls are subscription-covered ($0 marginal cost). Only embedding costs apply (~$0.13/1M tokens via LiteLLM). Rate limit wiki-ingest queue (F3.4) to control embedding volume. Use Sonnet for routine updates, reserve Opus for synthesis. |
| BullMQ flow migration breaks existing pipeline | Low | High | Implement behind a feature flag. Run old sequential pipeline and new flow pipeline in parallel during Phase 1 validation. |
| Wiki grows unwieldy (>500 pages) with degraded LLM context | Low | Medium | Implement wiki search (F2.12) when page count exceeds 200. Keep index.md curated. Consider tiered context loading (index → relevant pages only). |
| Git operations on wiki create lock contention under concurrent wiki-ingest jobs | Medium | Medium | Serialize wiki Git operations through a single BullMQ worker with concurrency=1 on the wiki-maintenance queue. Wiki-ingest jobs prepare content in memory, then enqueue a wiki-commit job. |
| Himalaya binary not available or incompatible in workers container (aarch64 if ever migrated) | Low | Medium | Pin himalaya version in Dockerfile. Pre-built binaries available for x86_64 Linux. Fallback: build from source in container via Rust toolchain (adds build time but guarantees compatibility). |
| Backup storage grows unbounded | Low | Low | Retention policies enforced by backup skills (F14.1-F14.3). Storage audit skill (F14.6) reports on backup storage usage weekly. Alert if backup storage exceeds configurable threshold (default 50GB). |
| Infrastructure skills create excessive noise via Pushover | Medium | Low | All infrastructure alerts respect a configurable quiet-hours window (default 10 PM - 7 AM, alert deferred to next window). Batch multiple alerts into a single notification where possible. Dashboard shows full history regardless of notification state. |

---

## 15. Testing Strategy

| Level | Approach |
|-------|----------|
| Unit | Vitest for all new modules: Claude client factory, wiki Git operations, pipeline flow construction, activity feed aggregation, himalaya CLI wrapper (SMTP), backup retention policy logic. Target: 80%+ coverage on new code. |
| Integration | Docker Compose test stack (`docker-compose.test.yml`, existing pattern). Test: ingest flow DAG execution, wiki-ingest end-to-end (capture → wiki page), voice session lifecycle, MCP tool execution, email draft → approve → send lifecycle via Himalaya SMTP, backup → restore → verify. |
| End-to-End | Extend existing `scripts/e2e-full.sh` and `scripts/regression-test.mjs` with new scenarios: voice conversation → capture → wiki integration, scheduled skill execution → wiki update → dashboard display, outbound email draft → Slack approval → himalaya send, infrastructure skill execution chain (backup → verify → report). |
| Performance | Benchmark: Pipecat voice latency (VAD → Deepgram STT → Claude → TTS round-trip), wiki-ingest throughput (captures/minute), flow DAG execution time vs. sequential pipeline, pg_dump duration at current database size. |

---

## 16. Hardware Constraints

All services run on the existing Unraid host:

- **CPU:** Intel i7-9700 (8C/8T) — no GPU
- **RAM:** 128GB DDR4 — ample headroom
- **Storage:** 32TB array
- **STT:** Deepgram cloud for real-time Pipecat voice; faster-whisper (CPU int8) available as optional batch fallback
- **Network:** Cloudflare Tunnel for external access, Tailscale for internal mesh

Container memory allocations (updated):

| Container | Memory Limit |
|-----------|-------------|
| open-brain-postgres | 8GB |
| open-brain-redis | 2GB |
| open-brain-core-api | 2GB |
| open-brain-workers | 4GB |
| open-brain-slack-bot | 512MB |
| open-brain-voice-pipecat | 4GB (Pipecat buffers + Deepgram streaming client; no local STT model) |
| open-brain-web | 256MB |
| open-brain-cloudflared | 128MB |
| **Total** | **~21GB** (of 128GB available) |

---

## 17. Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| Voice conversations work naturally with <2s round-trip latency (Deepgram STT + Claude + Kokoro TTS) | Measured via Pipecat pipeline telemetry |
| Wiki contains synthesized knowledge across all five brain views | Manual review after 60 days of operation |
| Dashboard home page loads with full activity feed in <3 seconds | Browser performance measurement |
| System runs autonomously for 7+ days without manual intervention | Uptime monitoring via health strip |
| Non-Claude monthly costs (embeddings, Deepgram) stay under $10/month. Claude calls are subscription-covered at $0 marginal cost. | Spend tracking in llm_usage table + LiteLLM spend API |
| Zero data loss during pipeline migration from sequential to flow | Regression test suite passes 100% |
| Inbound emails create captures within seconds (push-based via CF Email Worker) | Timestamp comparison: email received vs. capture created |
| Email drafts can be composed, reviewed, and sent entirely via Slack | End-to-end test of `/email send` → `/email approve` → delivery confirmation |
| Database backups complete daily with successful restore verification | Backup skill logs in skill_runs table; monthly manual restore test |
| Cost analysis reports accurately reflect actual LLM spend within 5% | Cross-reference llm_usage aggregation against provider invoices |
| Container health check detects failures within 3 check cycles (≤45 minutes) | Intentional container stop → alert received within threshold |

---

## 18. Future Considerations (Out of Scope)

These items are explicitly out of scope for v2 but may inform future development:

- **URL/bookmark capture** (PRD v1 F24) — browser bookmark import with content extraction
- **Calendar integration** (PRD v1 F25) — iCal feed sync creating captures from calendar events
- **Screenshot/image capture** (PRD v1 F27) — image ingestion via vision models
- **DGX Spark local inference integration** — routing specific task types to local Qwen models for cost/privacy
- **Multi-wiki support** — separate wiki instances per domain (consulting, personal, technical)
- **Wiki graph visualization** — Obsidian-style graph view rendered in the dashboard
- **Collaborative wiki** — human review/approval workflow for wiki changes before commit
