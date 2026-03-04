# Product Requirements Document (PRD)
# Open Brain — Personal AI Knowledge Infrastructure

**Version**: 0.2
**Author**: Troy Davis / Claude
**Date**: 2026-03-04
**Status**: Draft — Questions Resolved

---

## 1. Executive Summary

Open Brain is a self-hosted, Docker-based personal knowledge infrastructure system that ingests information from multiple sources (voice memos, Slack messages, documents, bookmarks, calendar events), processes and embeds them for semantic search, and provides rich output through AI-powered skills — including weekly briefs, career governance sessions, pattern detection, and ad-hoc synthesis.

The system runs entirely on the user's Unraid home server (`homeserver.k4jda.net`), stores all data in a self-hosted Supabase instance (Postgres + pgvector), and is accessible through Slack (bidirectional — capture and query), an MCP server (for Claude, ChatGPT, and other AI tools), a web dashboard, email reports, and push notifications.

Open Brain replaces and consolidates two existing projects:
- **board-journal** — a Flutter mobile app for voice-first career governance with AI-powered board sessions, weekly briefs, and bet tracking
- **voice-capture** — a Python pipeline that transcribes Apple Watch voice memos and stores them in Notion

**Core Value Proposition**: One persistent, AI-accessible brain that every tool you use can read from and write to. Capture once, query from anywhere, get compounding returns as context accumulates.

**Key Success Metrics**:
- Daily active capture rate (target: 5+ captures/day across all inputs)
- Query response time (target: <5 seconds for semantic search)
- Weekly brief generation (automated, every Sunday)
- Zero data loss (all captures persisted with processing audit trail)
- System uptime on Unraid (target: 99%+ excluding planned maintenance)

---

## 2. Product Vision and Strategy

### Vision Statement
A personal knowledge system that makes every AI interaction smarter because it has access to everything you've thought, decided, learned, and captured — running on infrastructure you own, accessible from any tool, compounding in value over time.

### Mission
Build a self-hosted, extensible knowledge infrastructure with universal ingestion, configurable AI processing, and rich output capabilities — starting with voice capture and Slack, expanding to additional input sources and output skills over time.

### Strategic Alignment
- **Replaces board-journal**: The career governance functionality (weekly briefs, board sessions, bet tracking) becomes output skills rather than a standalone mobile app. A conceptual reference document captures board-journal's principles (governance philosophy, anti-vagueness criteria, board role perspectives, bet tracking model) for clean-room reimplementation — no code ported.
- **Replaces voice-capture's Notion backend**: Voice memos flow into Supabase instead of Notion, through the same proven transcription pipeline
- **Implements the Open Brain architecture** from the companion document: Postgres + pgvector + MCP, but self-hosted rather than on Supabase cloud
- **Future-proofs AI integration**: Configurable AI provider routing means no lock-in to any single model or service

### Product Principles
1. **Capture must be frictionless** — zero-thought input from the tools you already have open (Slack, Apple Watch)
2. **Infrastructure you own** — all data on your hardware, no SaaS dependencies for core functionality
3. **AI-agnostic** — swap between local (Ollama), Claude, GPT, or any provider without losing anything
4. **Pipeline-first** — every operation (ingest, process, output) flows through configurable, async pipelines
5. **Extensible by design** — new input sources, processing stages, and output skills without touching existing code
6. **The brain compounds** — every capture makes future queries smarter; the system's own outputs feed back in

### Differentiation from the Open Brain Document
The document describes a lightweight Slack → Supabase Cloud → MCP setup. This project extends that concept significantly:
- Self-hosted on Unraid (Docker) instead of Supabase cloud
- Voice input via existing voice-capture pipeline (Apple Watch → faster-whisper → pipeline)
- Async processing pipeline with configurable stages (not synchronous Edge Functions)
- Rich output skills (weekly briefs, governance sessions, pattern detection) inherited from board-journal
- Bidirectional Slack interface (capture + query + commands + interactive sessions)
- Local AI (Ollama for embeddings, faster-whisper for transcription)
- Entity graph (people, projects, decisions) on top of vector search
- Web dashboard for browsing, searching, and viewing skill outputs

---

## 3. User Personas

### Primary Persona: Troy (Solo User)

This is a single-user personal tool. The sole user is a senior technology executive and active builder who:

- Captures thoughts throughout the day via Apple Watch voice memos (commute, walking, between meetings) and Slack text (at desk)
- Works across multiple AI tools (Claude Code, Claude Desktop, ChatGPT) and needs persistent context across all of them
- Runs structured career governance processes (quarterly board reviews, bet tracking) that require synthesizing weeks of captured context
- Values privacy and infrastructure ownership — prefers self-hosted over SaaS
- Has an Unraid home server with Docker capability
- Uses Tailscale for remote access to home network services
- Is technically fluent — comfortable with Docker, terminal, config files — but wants the daily UX to be frictionless (type in Slack, talk to Apple Watch, done)

### Anti-Personas
- **Multi-user teams** — this is explicitly single-user; no auth, no multi-tenancy, no access control
- **Non-technical users** — setup requires Docker, Unraid, CLI configuration; there is no guided installer
- **Mobile-app-first users** — there is no native mobile app; mobile interaction is through Slack and PWA

---

## 4. User Journeys and Scenarios

### Journey 1: Voice Capture (Apple Watch → Brain)

**Trigger**: User has a thought while away from computer

1. Press action button on Apple Watch → iOS Shortcut records via Just Press Record
2. Audio saves to Google Drive `/VoiceCaptures/inbox/`
3. rclone container syncs to Unraid (every 3 minutes)
4. voice-capture container detects new file, creates capture record
5. Routes audio to faster-whisper container for local transcription
6. Claude/local LLM classifies content, extracts metadata
7. voice-capture calls Open Brain ingest API with transcript + classification + metadata
8. Open Brain pipeline: embed → extract entities → link relationships → evaluate triggers
9. Pushover notification to iPhone: "Captured: idea — QSR pricing, People: Tom"

**Total latency**: ~3-5 minutes (dominated by rclone sync interval)

### Journey 2: Slack Text Capture

**Trigger**: User has a thought while at computer

1. Type in `#open-brain` Slack channel: "Decision: going with T&M plus $180k cap for QSR. Tom agreed."
2. Slack bot receives message, intent router classifies as CAPTURE (default)
3. Calls Open Brain ingest API with raw text
4. Pipeline: embed → extract metadata → extract entities → link to existing Tom entity and QSR project → evaluate triggers
5. Bot replies in thread: "Captured as *decision* — QSR, pricing. People: Tom. Linked to: QSR Engagement project."

**Total latency**: <10 seconds

### Journey 3: Slack Query

**Trigger**: User wants to recall something

1. Type in Slack: `? QSR pricing`
2. Intent router classifies as QUERY
3. Core API performs semantic search across all captures
4. Returns formatted results in Slack thread with match percentages, dates, and context
5. User can reply with a number for full context, or refine the search

### Journey 4: Slack Interactive Session (Board Governance)

**Trigger**: User initiates a governance session

1. Type: `@Open Brain let's do a quick board check`
2. Bot starts a stateful FSM session in a Slack thread
3. Walks through 5-question structured audit with anti-vagueness enforcement
4. Each answer is validated, captured, and linked to active bets/projects
5. Session completes → generates assessment + 90-day prediction
6. Full session captured back into brain, report delivered to email + web dashboard

### Journey 5: AI Tool Query via MCP

**Trigger**: User is working in Claude Code or ChatGPT and needs context

1. AI tool calls MCP `search_thoughts` with query "QSR engagement status"
2. MCP server calls Core API semantic search
3. Returns relevant captures with metadata
4. AI tool incorporates context into its response — "Based on your notes, you decided on T&M with a $180k cap..."

### Journey 6: Weekly Brief (Scheduled Output)

**Trigger**: Sunday 8pm, automated

1. Workers container triggers weekly_brief skill
2. Queries all captures from the past 7 days
3. Feeds to configured AI model with brief generation prompt
4. Generates structured brief: wins, blockers, risks, open loops, focus areas, drift alerts
5. Delivers to: email (formatted HTML), web dashboard, captured back into brain
6. Pushover notification: "Your weekly brief is ready"

### Journey 7: Drift/Pattern Detection (Scheduled)

**Trigger**: Monday 9am, automated

1. Workers container triggers drift_monitor skill
2. Queries active bets, projects, and recurring topics
3. Identifies: bets approaching expiration, projects not mentioned recently, recurring frustration patterns
4. If findings exist: Pushover alert + Slack DM with summary
5. Findings captured back into brain

---

## 5. Feature Specifications

### 5.1 Feature Overview

| ID | Feature | Priority | Phase |
|----|---------|----------|-------|
| F01 | Core API (ingest, query, synthesize) | Must Have | 1 |
| F02 | Supabase self-hosted (Postgres + pgvector) | Must Have | 1 |
| F03 | Async processing pipeline (BullMQ + Redis) | Must Have | 1 |
| F04 | Slack bot — capture (text) | Must Have | 1 |
| F05 | Slack bot — query (semantic search) | Must Have | 1 |
| F06 | MCP server (search, list, capture, stats) | Must Have | 1 |
| F07 | Ollama container (local embeddings) | Must Have | 1 |
| F08 | AI router service (provider routing) | Must Have | 1 |
| F09 | Voice-capture integration (adapter to ingest API) | Must Have | 2 |
| F10 | faster-whisper container (local STT) | Must Have | 2 |
| F11 | Slack bot — commands (/ob stats, /ob brief) | Should Have | 2 |
| F12 | Weekly brief output skill | Should Have | 2 |
| F13 | Pushover notifications | Should Have | 2 |
| F14 | Email delivery (HTML reports) | Should Have | 2 |
| F15 | Entity graph (people, projects, decisions) | Should Have | 3 |
| F16 | Slack bot — interactive sessions (governance FSM) | Should Have | 3 |
| F17 | Board governance skills (quick check, quarterly) | Should Have | 3 |
| F18 | Bet tracking and evaluation | Should Have | 3 |
| F19 | Web dashboard (Vite + React PWA) | Could Have | 4 |
| F20 | Slack voice clip processing | Could Have | 3 |
| F21 | Daily connection/pattern detection skill | Could Have | 3 |
| F22 | Drift monitor skill | Could Have | 3 |
| F23 | Document ingestion (PDF, docx) | Could Have | 4 |
| F24 | URL/bookmark capture | Could Have | 4 |
| F25 | Calendar integration | Could Have | 4 |
| F26 | Notion output skill (optional mirror) | Won't Have | Future |
| F27 | Screenshot/image capture (vision model) | Won't Have | Future |

### 5.2 Detailed Feature Specifications

---

#### F01: Core API

**Description**: Central API service that all clients (Slack bot, MCP server, web UI, voice-capture adapter) interact with. Provides endpoints for ingestion, querying, synthesis, skill management, and session management.

**Tech**: TypeScript, Hono framework, Drizzle ORM (schema-as-code, type-safe queries, drizzle-kit for migrations), runs as Docker container

**Endpoints**:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/captures` | Ingest a new capture |
| GET | `/api/v1/captures` | List captures with filters (date, type, topic, person, source) |
| GET | `/api/v1/captures/:id` | Get single capture with full detail |
| POST | `/api/v1/search` | Semantic search |
| POST | `/api/v1/synthesize` | Ad-hoc AI synthesis across captures |
| GET | `/api/v1/stats` | Brain statistics |
| POST | `/api/v1/skills/:name/trigger` | Manually trigger an output skill |
| GET | `/api/v1/skills` | List configured skills and schedules |
| POST | `/api/v1/sessions` | Start a new interactive session (governance) |
| POST | `/api/v1/sessions/:id/respond` | Submit response to session prompt |
| GET | `/api/v1/sessions/:id` | Get session state |
| GET | `/api/v1/entities` | List known entities (people, projects) |
| GET | `/api/v1/entities/:id` | Entity detail with linked captures |
| GET | `/health` | Health check |

**Ingest Payload**:
```json
{
  "content": "raw text or transcript",
  "source": "slack|voice|web|api|email|document",
  "source_metadata": {
    "slack_ts": "...",
    "device": "apple_watch",
    "duration_seconds": 120,
    "original_filename": "...",
    "url": "..."
  },
  "pre_extracted": {
    "template": "task",
    "confidence": 0.92,
    "fields": { "priority": "high", "due_date": "2026-03-15" },
    "transcript_raw": "..."
  },
  "tags": ["career", "qsr"],
  "brain_views": ["career", "consulting"]
}
```

The `pre_extracted` field allows input adapters (like voice-capture) to pass their own classification results. The core pipeline still runs its own extraction but preserves both.

**Synthesize Endpoint Specification**:
- Top-N retrieval with configurable token budget: default top 20 captures, 50K token budget
- If context exceeds budget, truncate from bottom (lowest similarity scores)
- Ad-hoc synthesis results are ephemeral — not cached, not re-captured into the brain
- Output skills (weekly brief, governance) implement their own context assembly — they call `/api/v1/search` for captures and handle chunking/summarization internally before calling the AI router directly
- `captured_at` is an optional field in the ingest payload — input adapters pass original timestamp (file creation time, slack_ts). Defaults to `created_at`. All time-based queries use `captured_at`.

**Acceptance Criteria**:
- All endpoints return JSON, use standard HTTP status codes
- Ingest endpoint accepts captures and returns capture ID + status within 500ms (queues async processing)
- Search endpoint returns results within 5 seconds
- API is unauthenticated (single user, network-level security via Tailscale/LAN)
- Health endpoint returns status of all dependent services (DB, Redis, Ollama)

---

#### F02: Supabase Self-Hosted

**Description**: Minimal self-hosted Supabase stack: Postgres 16 with pgvector, Supabase Studio dashboard, and Realtime (for Phase 4 web dashboard live updates). PostgREST, GoTrue, Kong, and Storage excluded — Core API handles all data access via Hono + Drizzle, no auth needed (single-user), no file storage via Supabase.

**Deployment**: Docker Compose on Unraid, using official Supabase self-hosting guide

**Database Schema**:

**captures table** (primary storage):
```sql
create table captures (
  id uuid default gen_random_uuid() primary key,

  -- Content
  content text not null,                          -- processed/final text
  content_raw text,                               -- original raw input (before transcription, etc.)
  embedding vector(768),                          -- semantic embedding (nomic-embed-text via Ollama, 768 dimensions)

  -- Classification
  metadata jsonb default '{}'::jsonb,             -- extracted metadata (people, topics, type, action_items, dates)
  source text not null,                           -- slack, voice, web, api, email, document
  source_metadata jsonb default '{}'::jsonb,      -- source-specific details
  pre_extracted jsonb default '{}'::jsonb,        -- classification from input adapter (e.g., voice-capture templates)

  -- Organization
  tags text[] default '{}',                       -- user-assigned or auto-assigned tags
  brain_views text[] default '{}'::text[],        -- which "brain views" this belongs to

  -- Entity links (populated by entity linking stage)
  linked_entities jsonb default '[]'::jsonb,      -- [{entity_id, entity_type, relationship}]

  -- Processing audit trail
  pipeline_status text default 'received',        -- received, processing, complete, failed, partial
  pipeline_log jsonb default '[]'::jsonb,         -- [{stage, status, model_used, duration_ms, timestamp}]

  -- Timestamps
  captured_at timestamptz default now(),          -- when the thought originally occurred
  created_at timestamptz default now(),           -- when record was created
  updated_at timestamptz default now(),

  -- Soft delete
  deleted_at timestamptz
);

-- Indexes
create index on captures using hnsw (embedding vector_cosine_ops);
create index on captures using gin (metadata);
create index on captures using gin (tags);
create index on captures using gin (brain_views);
create index on captures (created_at desc);
create index on captures (source);
create index on captures (pipeline_status);
```

**entities table** (knowledge graph — Phase 3):
```sql
create table entities (
  id uuid default gen_random_uuid() primary key,
  entity_type text not null,                      -- person, project, decision, concept, bet
  name text not null,
  aliases text[] default '{}',                    -- alternative names/references
  metadata jsonb default '{}'::jsonb,             -- type-specific fields
  first_seen timestamptz default now(),
  last_seen timestamptz default now(),
  mention_count int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table entity_links (
  id uuid default gen_random_uuid() primary key,
  capture_id uuid references captures(id),
  entity_id uuid references entities(id),
  relationship text,                              -- mentioned, decided, blocked_by, etc.
  created_at timestamptz default now()
);
```

**sessions table** (governance FSM — Phase 3):
```sql
create table sessions (
  id uuid default gen_random_uuid() primary key,
  session_type text not null,                     -- quick_check, quarterly, custom
  status text default 'active',                   -- active, completed, abandoned
  state jsonb not null,                           -- FSM state
  transcript jsonb default '[]'::jsonb,           -- [{role, content, timestamp}]
  config jsonb default '{}'::jsonb,               -- session-specific configuration
  result jsonb,                                   -- final output/assessment
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);
```

**bets table** (career governance — Phase 3):
```sql
create table bets (
  id uuid default gen_random_uuid() primary key,
  commitment text not null,
  falsifiable_criteria text not null,
  status text default 'open',                     -- open, correct, wrong, expired
  due_date date not null,
  session_id uuid references sessions(id),
  evidence jsonb default '[]'::jsonb,             -- [{type, description, strength, date}]
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  resolved_at timestamptz
);
```

**skills_log table** (output skill execution history):
```sql
create table skills_log (
  id uuid default gen_random_uuid() primary key,
  skill_name text not null,
  trigger_type text not null,                     -- scheduled, manual, event
  status text default 'running',                  -- running, completed, failed
  config jsonb,                                   -- skill config at time of execution
  result jsonb,                                   -- output produced
  captures_queried int,                           -- how many captures were included
  ai_model_used text,
  token_usage jsonb,                              -- {input_tokens, output_tokens, cost_estimate}
  created_at timestamptz default now(),
  completed_at timestamptz,
  error text
);
```

**Semantic search function**:
```sql
create or replace function match_captures(
  query_embedding vector(768),
  match_threshold float default 0.5,
  match_count int default 10,
  filter_source text default null,
  filter_tags text[] default null,
  filter_brain_views text[] default null,
  filter_after timestamptz default null,
  filter_before timestamptz default null
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  source text,
  tags text[],
  similarity float,
  captured_at timestamptz,
  linked_entities jsonb
)
language plpgsql as $$
begin
  return query
  select
    c.id, c.content, c.metadata, c.source, c.tags,
    1 - (c.embedding <=> query_embedding) as similarity,
    c.captured_at, c.linked_entities
  from captures c
  where c.deleted_at is null
    and c.pipeline_status = 'complete'
    and 1 - (c.embedding <=> query_embedding) > match_threshold
    and (filter_source is null or c.source = filter_source)
    and (filter_tags is null or c.tags && filter_tags)
    and (filter_brain_views is null or c.brain_views && filter_brain_views)
    and (filter_after is null or c.captured_at >= filter_after)
    and (filter_before is null or c.captured_at <= filter_before)
  order by c.embedding <=> query_embedding
  limit match_count;
end;
$$;
```

**Acceptance Criteria**:
- Supabase stack runs stable on Unraid in Docker
- Supabase Studio accessible at `supabase.k4jda.net` (or similar) via LAN/Tailscale
- pgvector extension enabled, HNSW index functional
- All tables created with indexes
- Semantic search function returns results <2 seconds for 100k+ captures

---

#### F03: Async Processing Pipeline

**Description**: Event-driven pipeline that processes captures through configurable stages. Each stage is independent, can be retried individually, and records its result on the capture record.

**Tech**: BullMQ job queues backed by Redis

**Pipeline Stages**:

| Stage | Purpose | Default AI | Skips When |
|-------|---------|-----------|------------|
| `transcribe` | Audio → text via faster-whisper | Local faster-whisper | Input is already text |
| `embed` | Generate vector embedding | Local Ollama (nomic-embed-text or similar) | — |
| `extract_metadata` | Extract people, topics, type, action_items, dates, brain_views | Configurable (default: local Ollama or Claude) | — |
| `classify` | Domain classification (career signals, etc.) | Configurable | No matching brain_view pipeline |
| `link_entities` | Match and link to known entities | Local Ollama or rule-based | Phase 3 |
| `evaluate_triggers` | Check trigger rules (drift, bet expiration, etc.) | Rule-based + AI | Phase 3 |
| `notify` | Send confirmation to source (Slack reply, Pushover) | — | — |

**Pipeline Configuration** (YAML):
```yaml
pipelines:
  default:
    stages:
      - name: embed
        provider: ollama
        model: nomic-embed-text

      - name: extract_metadata
        provider: ollama
        model: llama3.1:8b
        prompt_template: extract_metadata_v1

      - name: notify
        targets: [source_reply]

  voice:
    # voice-capture handles transcription + classification before ingest
    # so this pipeline only adds embedding and entity linking
    stages:
      - name: embed
        provider: ollama
        model: nomic-embed-text

      - name: extract_metadata
        provider: ollama
        model: llama3.1:8b
        prompt_template: extract_metadata_v1
        merge_with_pre_extracted: true

      - name: notify
        targets: [pushover]

  career:
    extends: default
    additional_stages:
      - name: extract_career_signals
        provider: claude
        model: claude-sonnet-4-6
        prompt_template: career_signals_v1
        after: extract_metadata
```

**Stage Execution**:
- Each stage reads the capture record, does its work, writes results back to the record + appends to `pipeline_log`
- Stage failure → retry with patient exponential backoff: 5 retries per stage (30s, 2m, 10m, 30m, 2h), then mark stage as failed. Pushover alert on final failure. Daily auto-retry sweep for all failed stages (one additional attempt per day). Manual retry also available via API.
- Partial completion preserved — if `embed` succeeds but `extract_metadata` fails, the embedding is kept
- Pipeline routing: based on `source` field and `brain_views` tags, the system selects which pipeline config to use

**Acceptance Criteria**:
- Pipeline processes a text capture end-to-end in <30 seconds
- Individual stage failure does not block other stages (where no dependency exists)
- Failed stages can be retried individually via API (`POST /api/v1/captures/:id/retry?stage=extract_metadata`)
- Pipeline configuration is YAML-driven; config re-read on each pipeline job start (naturally picks up changes within seconds). API reload endpoint (`POST /admin/reload-config`) available for immediate cache clear. In-flight jobs complete with the config they started with.
- `pipeline_log` on each capture shows: stage name, status, model used, duration, timestamp

---

#### F04: Slack Bot — Capture

**Description**: Receives messages in the `#open-brain` Slack channel and ingests them as captures. Default behavior for any message without a query/command prefix.

**Tech**: Slack Events API (message.channels, message.groups), Node.js container

**Behavior**:
- Any message in `#open-brain` without a recognized prefix → treat as capture
- Call Core API `POST /api/v1/captures` with content, source: "slack", source_metadata including slack_ts, channel, user
- Reply in thread with confirmation once pipeline completes (via notify stage callback to Slack)
- Ignore messages from bots (prevent feedback loops)
- Handle Slack's URL verification challenge
- Handle audio file attachments → route to voice-capture container's HTTP endpoint for consistent classification and processing (all audio follows a single path through voice-capture regardless of source)

**Slack Free Plan Constraints**:
- 90-day message history — captures are in Supabase, so Slack history loss doesn't matter for the brain
- 10 app integrations max — we only need 1 (Open Brain bot)
- No shared channels — fine for single-user
- Rate limits: 1 message per second per channel (more than sufficient)

**Required Slack App Configuration**:
- Bot Token Scopes: `channels:history`, `groups:history`, `chat:write`, `files:read` (for voice clips), `app_mentions:read` (for @mentions)
- Event Subscriptions: `message.channels`, `message.groups`, `app_mention`
- The bot will be installed to the K4JDA workspace, invited to `#open-brain` channel

**Acceptance Criteria**:
- Text message in `#open-brain` → captured in Supabase within 10 seconds
- Thread reply confirms capture with type and key metadata extracted
- Bot ignores its own messages and messages from other bots
- Graceful handling of Slack retries (idempotency via slack_ts dedup)

---

#### F05: Slack Bot — Query

**Description**: When the user asks a question (detected by prefix or intent), perform semantic search and return formatted results in Slack.

**Query Triggers**:
- `?` prefix: `? QSR pricing` → semantic search
- `@Open Brain` mention with a question: `@Open Brain what did I say about Sarah?`
- Natural question patterns (LLM-classified): "what was that thing about...", "when did I...", "who mentioned..."

**Response Format**:
```
Found 3 thoughts matching "QSR pricing":

1. [Mar 2] (decision — QSR, pricing) — 94% match
   Decision: going with T&M plus $180k cap for QSR. Tom agreed.

2. [Mar 2] (idea — QSR, pricing) — 89% match
   Thinking about the pricing model for the QSR engagement...

3. [Feb 15] (observation — QSR) — 72% match
   Tom's team seems hesitant on fixed-fee engagements...

Reply with a number for full context, or refine your search.
```

**Follow-up Interactions**:
- Reply with number → show full capture with all metadata, linked entities, related captures
- Reply with `more` → show next page of results
- Reply with refined query → new search
- `@Open Brain summarize everything about QSR` → triggers ad-hoc synthesis (calls `/api/v1/synthesize`)

**Synthesis Queries**:
When the user asks for a summary or synthesis (not just a search), the bot:
1. Performs semantic search to gather relevant captures
2. Sends captures + user's question to the configured AI model
3. Returns a synthesized response (not just raw captures)

**Acceptance Criteria**:
- Query results returned within 5 seconds
- Results formatted with date, type, match percentage, and content preview
- Follow-up interactions work in the same thread (thread context stored in Redis with 1-hour TTL, keyed by thread_ts; expired threads prompt a new search)
- Synthesis queries use the configured AI model and return coherent multi-paragraph responses
- Intent router correctly distinguishes capture vs. query >95% of the time

---

#### F06: MCP Server

**Description**: Model Context Protocol server that allows any MCP-compatible AI client (Claude Desktop, Claude Code, ChatGPT, Cursor, VS Code Copilot) to search, browse, capture, and get stats from the brain.

**Tech**: @modelcontextprotocol/sdk, Hono, runs as Docker container

**MCP Tools**:

| Tool | Description | Parameters |
|------|-------------|------------|
| `search_brain` | Semantic search across all captures | query, limit, threshold, source_filter, tag_filter, brain_view, days |
| `list_captures` | Browse recent captures with filters | limit, type, topic, person, days, source |
| `capture_thought` | Write a new capture into the brain | content, tags, brain_views |
| `brain_stats` | Statistics about the brain | period (week/month/all) |
| `get_entity` | Get detail about a known entity (person, project) | name or id |
| `list_entities` | List known entities | type_filter, sort_by |
| `get_weekly_brief` | Retrieve the most recent weekly brief | weeks_ago (default 0) |

**Access**:
- URL-based access with API key authentication (key passed as query parameter)
- Accessible via Tailscale for remote use, or LAN for local
- Connection URL format: `https://brain.k4jda.net/mcp?key=<access_key>` (via Cloudflare Tunnel — existing Tailscale + SWAG setup unchanged, Cloudflare Tunnel added only for brain.k4jda.net)

**Acceptance Criteria**:
- All tools functional and return well-formatted text results
- search_brain returns results within 5 seconds
- capture_thought creates captures that go through the full pipeline
- Works with Claude Desktop, Claude Code, and ChatGPT MCP integrations
- API key required for all requests

---

#### F07: Ollama Container

**Description**: Local LLM service for embeddings and lightweight AI tasks (metadata extraction, intent classification). Runs on Unraid in Docker.

**Models to Install**:
- `nomic-embed-text` — embedding model (768-dim vectors, fast, good quality). Selected for: local execution, zero API cost, sufficient quality for personal knowledge search. Schema uses vector(768) throughout. No embedding fallback — if Ollama is down, queue and retry.
- `llama3.1:8b` — lightweight LLM for metadata extraction, intent classification, and simple synthesis
- Optionally `llama3.1:70b` or larger for higher-quality synthesis if hardware supports it

**API**: Ollama exposes OpenAI-compatible API on port 11434

**Acceptance Criteria**:
- Ollama container starts and loads models on Unraid
- Embedding generation <1 second per capture
- Metadata extraction <5 seconds per capture
- GPU acceleration used if NVIDIA GPU available, CPU fallback otherwise
- Container auto-restarts on failure

---

#### F08: AI Router Service

**Description**: A configuration layer (not necessarily a separate container — can be a module within the Core API) that routes AI requests to the appropriate provider based on task type, configured preferences, and fallback rules.

**Configuration** (YAML):
```yaml
ai_routing:
  embedding:
    primary:
      provider: ollama
      model: nomic-embed-text
    # NO fallback for embeddings — mixing models degrades search quality.
    # If Ollama is down, captures queue and retry when it recovers.

  metadata_extraction:
    primary:
      provider: ollama
      model: llama3.1:8b
    fallback:
      provider: anthropic
      model: claude-haiku-4-5

  synthesis:
    primary:
      provider: anthropic
      model: claude-sonnet-4-6
    fallback:
      provider: openai
      model: gpt-4o

  governance:
    primary:
      provider: anthropic
      model: claude-opus-4-6
    fallback:
      provider: anthropic
      model: claude-sonnet-4-6

  intent_classification:
    primary:
      provider: ollama
      model: llama3.1:8b  # model configurable — may use qwen3.5 on Jetson Orin Nano or DGX Spark
    # no LLM fallback — degrade to prefix-only detection:
    # '?' = query, '!' = command, '@Open Brain' = query, no prefix = capture (default-to-capture prevents data loss)

providers:
  ollama:
    base_url: http://ollama:11434

  anthropic:
    api_key_env: ANTHROPIC_API_KEY

  openai:
    api_key_env: OPENAI_API_KEY

  openrouter:
    api_key_env: OPENROUTER_API_KEY
    base_url: https://openrouter.ai/api/v1
```

**Behavior**:
- All AI calls in the system go through the router
- Router selects provider based on task type
- If primary fails (timeout, error, container down), falls back automatically (except embeddings — no fallback, queue and retry to maintain vector consistency)
- Logs all AI calls: provider, model, task, tokens, latency, cost estimate
- Token usage tracked per provider per day for cost awareness
- **Monthly budget caps**: Soft limit at $30/month triggers Pushover alert. Hard limit at $50/month triggers circuit breaker — falls back to local models only. Expected normal usage: ~$15-30/month.

**Acceptance Criteria**:
- All AI calls route through the router
- Fallback triggers within 5 seconds of primary failure
- Usage logging captures all calls with token counts
- Configuration changes take effect without restart (file watch or API reload)

---

#### F10: faster-whisper Container

**Description**: Local speech-to-text service using CTranslate2-optimized Whisper models.

**Tech**: faster-whisper Python service in Docker, exposing REST API

**API**:
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/transcribe` | Accept audio file, return transcript |
| GET | `/health` | Health check |

**Configuration**:
- Model: `large-v3` (best accuracy, ~3GB download, requires ~4GB RAM or ~4GB VRAM)
- Device: `cpu` (no dedicated GPU on Unraid server — Intel i7-9700, 128GB RAM)
- Compute type: `int8` (CPU optimized)
- Language: `en` (or `auto` for auto-detection)

**Acceptance Criteria**:
- Transcribes a 5-minute audio file in <60 seconds on CPU, <15 seconds on GPU
- Returns transcript text, language detected, and duration
- Handles .m4a, .wav, .mp3, .ogg formats
- Container auto-restarts, preloads model on startup

---

#### F09: Voice-Capture Integration

**Description**: Modify the existing voice-capture project to act as an input adapter for Open Brain, replacing the Notion posting stage with an API call to the Core API.

**Changes to voice-capture**:
1. **Replace Notion posting stage** with Open Brain ingest call
   - POST to `http://open-brain-api:3000/api/v1/captures`
   - Include transcript, classification, template fields, source metadata
2. **Swap transcription backend** from OpenAI Whisper API to local faster-whisper
   - Point transcription service at `http://faster-whisper:8000/transcribe`
   - Keep OpenAI Whisper API as fallback
3. **Keep everything else**: watcher, state machine, retry logic, circuit breaker, SQLite tracking, rclone sync

**Acceptance Criteria**:
- Voice memos flow from Apple Watch → Google Drive → rclone → voice-capture → Open Brain → Supabase
- voice-capture's existing retry/circuit-breaker logic handles Open Brain API failures gracefully
- Hard cutover from Notion to Open Brain (no parallel operation). One-time Notion backfill script available as safety net for recovery if needed
- Classification results from voice-capture preserved in `pre_extracted` field
- Pushover notifications still work for capture confirmation and errors

---

#### F11: Slack Bot — Commands

**Description**: Explicit commands for system interaction beyond capture and query.

**Command Prefix**: `!` prefix in channel (baseline, always works via Socket Mode) + `/ob` slash command (enhancement, requires Cloudflare Tunnel). Prefix commands available from day one; slash commands added once tunnel is stable.

| Command | Description |
|---------|-------------|
| `/ob stats` or `!stats` | Brain statistics: capture count, captures this week, top topics, entity count |
| `/ob brief` or `!brief` | Trigger weekly brief generation immediately |
| `/ob brief last` | Show the most recent weekly brief |
| `/ob search <query>` | Explicit semantic search (same as `?` prefix) |
| `/ob recent [N]` | Show last N captures (default 10) |
| `/ob entities` | List known entities |
| `/ob entity <name>` | Show entity detail with recent captures |
| `/ob board quick` | Start a quick board check session |
| `/ob board quarterly` | Start a quarterly review session |
| `/ob pipeline status` | Show pipeline health, queue depth, failed captures |
| `/ob retry <capture_id>` | Retry a failed capture's pipeline |
| `/ob help` | Show available commands |

**Acceptance Criteria**:
- All commands return formatted responses within 5 seconds (except brief generation which may take longer and sends a "generating..." message first)
- Unknown commands return help text
- Commands work in `#open-brain` channel and in DM to the bot

---

#### F12: Weekly Brief Output Skill

**Description**: Automated weekly synthesis of all captures, delivered on schedule.

**Schedule**: Sunday 8:00 PM local time (configurable)

**Process**:
1. Query all captures from the past 7 days
2. Group by brain_view tags and topics
3. Feed to configured AI model (default: Claude Sonnet) with brief generation prompt
4. Generate structured output:
   - **Headline**: 1-2 sentence summary of the week
   - **Wins**: Up to 3 accomplishments (from captures typed as win/decision/task-completed)
   - **Blockers**: Up to 3 current obstacles
   - **Risks**: Up to 3 potential future problems
   - **Open Loops**: Up to 5 unresolved items
   - **Next Week Focus**: Top 3 priorities
   - **Avoided Decisions**: Decisions being deferred (if any)
   - **Drift Alert**: Projects/bets/people not mentioned this week that were active recently
   - **Connections**: Cross-topic patterns the AI noticed
5. Deliver to configured targets
6. Capture the brief itself back into the brain

**Delivery Targets**:
- Email: formatted HTML
- Web dashboard: rendered page
- Brain: captured back for future searchability
- Pushover: notification that brief is ready

**Acceptance Criteria**:
- Brief generated automatically every Sunday at configured time
- Brief covers all captures from the week, regardless of source
- Output under 800 words
- Drift alerts surface when active projects/bets go unmentioned
- Manual trigger via `/ob brief` also works

---

#### F13: Pushover Notifications

**Description**: Push notifications to iPhone via Pushover for alerts and confirmations.

**Notification Types**:
| Type | Priority | When |
|------|----------|------|
| Capture confirmed | Low (-1) | After voice capture processed (configurable, may want to disable for Slack captures since those get thread replies) |
| Weekly brief ready | Normal (0) | When weekly brief is generated |
| Drift alert | Normal (0) | When drift monitor detects gaps |
| Bet expiring | High (1) | When a bet is within 7 days of due date |
| Pipeline failure | High (1) | When a capture fails processing after all retries |
| System health issue | Emergency (2) | When a critical service (DB, Ollama) is unreachable |

**Tech**: Reuse Pushover integration pattern from voice-capture project

**Acceptance Criteria**:
- Notifications arrive on iPhone within 30 seconds of trigger
- Priority levels respected (quiet hours for low priority, bypass for emergency)
- Notification includes enough context to be useful without opening the app

---

#### F14: Email Delivery

**Description**: Formatted HTML email delivery for reports and digests.

**Tech**: SMTP via existing personal email account. App password + SMTP config loaded from Bitwarden at container startup. Zero cost, sufficient for single-user volume (2-5 emails/week).

**Email Types**:
- Weekly brief (HTML formatted, mobile-friendly)
- Quarterly board report (longer form, with sections and data)
- Custom skill outputs

**Acceptance Criteria**:
- Emails render correctly on iPhone Mail app
- Plain text fallback included
- From address clearly identifies Open Brain

---

#### F15: Entity Graph

**Description**: Knowledge graph layer that tracks people, projects, decisions, and concepts extracted from captures, with relationships between them.

**Entity Types**:
| Type | Key Fields | Auto-Extracted From |
|------|-----------|-------------------|
| `person` | name, aliases, role/context, last_mentioned | people field in metadata |
| `project` | name, status, related_people | topic clustering + explicit tagging |
| `decision` | description, date, outcome, linked_captures | type: decision captures |
| `bet` | commitment, criteria, due_date, status | governance sessions |
| `concept` | name, description, related_topics | topic clustering (Phase 4+) |

**Entity Resolution**:
- "Tom", "Tom Smith", "Tom at QSR Corp" → same person entity
- Resolution via: exact match, alias match, LLM-assisted disambiguation
- New entities auto-created when a name/project is first mentioned
- User can merge/split entities via Slack commands or web UI

**Acceptance Criteria**:
- Entities auto-created from capture metadata
- Entity detail shows all linked captures, sorted by recency
- "last_seen" updates on every new mention
- Duplicate detection works for common name variations

---

#### F16-F18: Governance Skills (Board Sessions, Quick Check, Bet Tracking)

**Description**: Redesign board-journal's governance system for Slack-native conversational interaction. Clean-room implementation informed by board-journal's concepts and principles (not code). A conceptual reference document will capture governance philosophy, anti-vagueness principles, board role perspectives, and bet tracking model from board-journal as a design brief. Board role personalities designed in Phase 3 alongside the conversational flow.

**Quick Board Check** (Slack thread interaction):
- 5-question structured audit
- Anti-vagueness gate: rejects answers without concrete evidence (max 2 skips)
- Pulls recent captures as evidence for discussion
- Outputs: 2-sentence honest assessment + 90-day falsifiable prediction (creates a bet)

**Quarterly Review** (Slack thread or web UI):
- Multi-step process over potentially multiple sittings
- Reviews all bets (resolve open ones), evaluates captures against career problems
- Board roles interrogate the evidence (5 core roles, 2 optional growth roles)
- Outputs: comprehensive quarterly report, new bets, updated portfolio health

**Bet Tracking**:
- Bets created from governance sessions with falsifiable criteria and due dates
- Drift monitor checks bet progress
- Auto-expiration alerts at 7 days before due
- Resolution: user marks as correct/wrong, or auto-expired

**Board Roles** (from board-journal):
| Role | Purpose |
|------|---------|
| Accountability | Are you doing what you said you'd do? |
| Market Reality | Is the market validating your direction? |
| Avoidance | What are you avoiding and why? |
| Long-term Positioning | Where does this put you in 2-5 years? |
| Devil's Advocate | What's the strongest case against your current path? |
| Portfolio Defender (growth) | Is your time allocation optimal? |
| Opportunity Scout (growth) | What are you missing? |

**Acceptance Criteria**:
- Quick check runs as a complete Slack thread interaction in <15 minutes
- Anti-vagueness gate enforced — bot pushes back on vague answers
- Bets created with clear falsifiable criteria and due dates
- Quarterly review can be paused and resumed — session state in Postgres (sessions table) + transcript replay on resume. Resume via `!board resume` or reply in original thread. Max 30-day pause, then auto-expire.
- All session transcripts and outputs captured back into the brain

---

#### F19: Web Dashboard

**Description**: Vite + React SPA (PWA) running on Unraid for browsing, searching, voice capture, and viewing skill outputs.

**Pages**:
| Page | Purpose |
|------|---------|
| Dashboard | Recent captures, brain stats, active bets, upcoming skill runs, system health |
| Search | Semantic search with filters (source, date range, tags, brain_view, entity) |
| Timeline | Chronological capture browser with grouping |
| Entity Browser | List and detail view of people, projects, decisions |
| Briefs | Weekly brief history, rendered and browsable |
| Board | Governance session history, active bets, portfolio health |
| Voice | MediaRecorder-based voice capture (record → transcribe → ingest) |
| Settings | Pipeline config viewer, skill schedules, AI routing, system status |

**Tech**: Vite + React, Tailwind CSS, shadcn/ui, vite-plugin-pwa. Pure SPA that talks to Core API — no SSR needed since Core API handles all server-side logic.

**Access**: `brain.k4jda.net` via LAN or Tailscale. No auth (single user, network-secured). PWA installable on iPhone home screen for app-like experience.

**Acceptance Criteria**:
- Responsive — works on iPhone Safari and desktop
- PWA installable
- Search results <5 seconds
- Voice capture functional from iPhone browser
- Dashboard loads <2 seconds

---

### 5.3 Feature Dependencies

```
F02 (Supabase) ──► F01 (Core API) ──► F04 (Slack Capture)
                         │              F05 (Slack Query)
F03 (Pipeline) ─────────┤              F06 (MCP Server)
                         │              F09 (Voice-Capture Integration)
F07 (Ollama) ───────────┤              F11 (Slack Commands)
                         │              F12 (Weekly Brief)
F08 (AI Router) ────────┘              F19 (Web Dashboard)

F10 (faster-whisper) ──► F09 (Voice-Capture Integration)
                         F20 (Slack Voice Clips)

F15 (Entity Graph) ──► F16-F18 (Governance)

F13 (Pushover) — independent, wire in when ready
F14 (Email) — independent, wire in when ready
```

---

## 6. Information Architecture

### System Architecture (Docker Containers)

```
                    ┌─────────────────────────────────────────┐
                    │              Unraid Server               │
                    │          homeserver.k4jda.net             │
                    │                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │  Slack   │  │  Core    │  │   MCP    │  │ Workers  │    │
│  │   Bot    │  │   API    │  │  Server  │  │(scheduled│    │
│  │          │  │  (Hono)  │  │          │  │  skills) │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       └──────────────┼────────────┘──────────────┘          │
│                      │                                       │
│              ┌───────▼────────┐  ┌───────────┐              │
│              │     Redis      │  │  Ollama   │              │
│              │   (BullMQ)     │  │ (LLM +    │              │
│              └───────┬────────┘  │ embeddings)│              │
│                      │           └───────────┘              │
│              ┌───────▼────────┐  ┌───────────┐              │
│              │   Supabase     │  │  faster-  │              │
│              │  (Postgres +   │  │  whisper  │              │
│              │   pgvector +   │  │           │              │
│              │   Studio)      │  └───────────┘              │
│              └────────────────┘                              │
│                                                              │
│  ┌──────────┐  ┌──────────┐                                 │
│  │  voice-  │  │  rclone  │                                 │
│  │ capture  │  │ (GDrive  │                                 │
│  │          │  │  sync)   │                                 │
│  └──────────┘  └──────────┘                                 │
│                                                              │
│  ┌──────────┐                                               │
│  │  Web UI  │  (Phase 4)                                    │
│  │ (Next.js)│                                               │
│  └──────────┘                                               │
└──────────────────────────────────────────────────────────────┘
```

### Docker Network Topology

Two Docker networks:
- **`supabase-internal`** — Supabase components (Postgres, Studio, Realtime). Isolated from application containers.
- **`open-brain`** — All application containers (Core API, Slack bot, MCP server, Workers, Ollama, faster-whisper, Redis, voice-capture, rclone, Web UI). Simple DNS resolution between containers (`http://ollama:11434`, `http://redis:6379`).
- **Postgres bridges both networks** — accessible from Supabase internals and Open Brain application containers.
- **Host port exposure**: Only Slack bot (for Socket Mode), MCP server (via Cloudflare Tunnel), and Web UI expose ports to the host.

### Configuration File Structure

```
open-brain/
├── docker-compose.yml              # All containers
├── .env                            # Non-sensitive config + Bitwarden placeholders
├── config/
│   ├── pipelines.yaml              # Processing pipeline definitions
│   ├── skills.yaml                 # Output skill definitions + schedules
│   ├── ai-routing.yaml             # AI provider routing configuration
│   ├── notifications.yaml          # Notification preferences + targets
│   ├── brain-views.yaml            # Brain view definitions + pipeline routing rules (5 views: career, personal, technical, work-internal, client)
│   └── prompts/                    # AI prompt templates
│       ├── extract_metadata_v1.txt    # Phase 1 — extracts people, topics, type, action_items, dates, brain_views as structured JSON
│       ├── intent_router_v1.txt       # Phase 1 — classifies Slack messages as capture/query/command
│       ├── career_signals_v1.txt      # Phase 2
│       ├── extract_client_signals_v1.txt  # Phase 2 — client brain view pipeline
│       ├── weekly_brief_v1.txt        # Phase 2
│       ├── synthesis_v1.txt           # Phase 2
│       ├── board_quick_check_v1.txt   # Phase 3
│       └── board_quarterly_v1.txt     # Phase 3
│       # Prompts are versioned (v1, v2, v3), hot-reloadable, and iterable based on real capture data
├── src/
│   ├── core-api/                   # Hono API server
│   ├── slack-bot/                  # Slack event handler + intent router
│   ├── mcp-server/                 # MCP server
│   ├── workers/                    # Scheduled skill execution
│   ├── pipeline/                   # Pipeline stage implementations
│   │   ├── stages/
│   │   │   ├── embed.ts
│   │   │   ├── extract-metadata.ts
│   │   │   ├── extract-career-signals.ts
│   │   │   ├── link-entities.ts
│   │   │   ├── evaluate-triggers.ts
│   │   │   └── notify.ts
│   │   ├── router.ts               # Pipeline selection based on source/tags
│   │   └── executor.ts             # BullMQ job processing
│   ├── ai-router/                  # AI provider abstraction
│   ├── skills/                     # Output skill implementations
│   │   ├── weekly-brief.ts
│   │   ├── board-quick-check.ts
│   │   ├── board-quarterly.ts
│   │   ├── drift-monitor.ts
│   │   └── daily-connections.ts
│   ├── entities/                   # Entity graph logic
│   ├── notifications/              # Pushover, email, Slack delivery
│   └── shared/                     # DB client, types, utils
├── web/                            # Vite + React dashboard (Phase 4)
└── docs/
    ├── PRD.md                      # This document
    ├── TDD.md                      # Technical Design Document (to be created)
    ├── DEPLOYMENT.md               # Unraid deployment guide
    └── ARCHITECTURE.md             # Architecture decisions
```

---

## 7. Non-Functional Requirements

### Performance
| Metric | Target |
|--------|--------|
| Text capture ingest (API response) | <500ms |
| Full pipeline processing (text) | <30 seconds |
| Full pipeline processing (voice, excl. rclone sync) | <90 seconds |
| Semantic search response | <5 seconds |
| Synthesis query response | <30 seconds |
| Weekly brief generation | <2 minutes |
| MCP tool response | <5 seconds |
| Web dashboard page load | <2 seconds |

### Reliability
- All containers configured with `restart: unless-stopped`
- Health checks on all containers
- Pipeline retries with patient exponential backoff (5 attempts per stage: 30s, 2m, 10m, 30m, 2h) + daily auto-retry sweep for failed stages
- Circuit breaker on external API calls (Anthropic, OpenAI)
- Monitoring: lean approach — Docker logs + Unraid dashboard + pipeline_log/skills_log tables + Pushover alerts for failures. No dedicated monitoring stack. Dockhand under consideration for future container management.
- Supabase data backed up via daily pg_dump to Unraid share (7-day local retention) + weekly offsite to Google Drive via rclone (30-day cloud retention)

### Security
- No authentication layer (single user, network-level security)
- Access restricted to LAN + Tailscale
- MCP server has API key authentication (for external access via Tailscale Funnel)
- All API keys stored in Bitwarden, loaded at container startup
- No secrets in Docker Compose or config files
- Supabase Studio password-protected (built-in)

### Data Integrity
- All captures immutable once created (soft delete, no hard delete)
- Pipeline processing is idempotent — reprocessing produces same results
- Source-level deduplication: Slack via `slack_ts`, voice-capture via filename, MCP via content hash + 60-second window. No cross-source near-duplicate detection (rare and arguably valuable to keep both perspectives).
- Processing audit trail on every capture

---

## 8. Success Metrics

### North Star Metric
**Brain utilization rate** — percentage of days where at least one capture was ingested AND at least one query was made. Indicates the system is being used for both input and retrieval, which is the compounding loop.

### Key Metrics
| Metric | Target | Measurement |
|--------|--------|-------------|
| Daily captures | 5+ | Count of captures per day |
| Weekly queries | 10+ | Count of search/synthesis queries per week |
| Query satisfaction | Qualitative | Are search results relevant? (self-assessed) |
| Pipeline success rate | >99% | Captures that complete pipeline without manual intervention |
| Weekly brief generated | 100% | Brief generated every week on schedule |
| Voice capture latency | <5 min | Time from Apple Watch recording to Pushover confirmation |
| MCP tool usage | Growing | Number of MCP queries from Claude/ChatGPT per week |

---

## 9. Release Planning

### Phase 1: Foundation (MVP)
**Goal**: Working capture + search loop via Slack and MCP

| Feature | Description |
|---------|-------------|
| F02 | Supabase self-hosted on Unraid |
| F07 | Ollama with embedding model |
| F08 | AI router (basic — Ollama for embeddings, configurable for extraction) |
| F03 | Pipeline — embed + extract_metadata stages |
| F01 | Core API — ingest, search, list, stats endpoints |
| F04 | Slack bot — text capture |
| F05 | Slack bot — semantic query |
| F06 | MCP server — search, list, capture, stats |

**Definition of Done**: Type a thought in Slack → it's embedded and searchable → query it from Slack or Claude Desktop via MCP.

### Phase 2: Voice + Outputs
**Goal**: Voice capture working, first output skill, notifications

| Feature | Description |
|---------|-------------|
| F10 | faster-whisper container |
| F09 | voice-capture integration (swap Notion for Core API, swap cloud Whisper for local) |
| F12 | Weekly brief output skill |
| F13 | Pushover notifications |
| F14 | Email delivery |
| F11 | Slack commands (/ob stats, /ob brief, etc.) |

**Definition of Done**: Apple Watch voice memos flow into the brain. Weekly brief generates automatically on Sunday. Pushover notification on capture and brief delivery.

### Phase 3: Intelligence
**Goal**: Entity graph, governance sessions, pattern detection

| Feature | Description |
|---------|-------------|
| F15 | Entity graph (auto-extraction + linking) |
| F16 | Slack interactive sessions (governance FSM) |
| F17 | Board governance skills (quick check, quarterly) |
| F18 | Bet tracking |
| F20 | Slack voice clip handling |
| F21 | Daily connection finder |
| F22 | Drift monitor |

**Definition of Done**: Entities auto-created and linked. Board quick check runs in Slack. Drift alerts surface when projects/bets go quiet.

### Phase 4: Polish
**Goal**: Web UI, document ingestion, additional input sources

| Feature | Description |
|---------|-------------|
| F19 | Web dashboard (Next.js PWA) |
| F23 | Document ingestion (PDF, docx) |
| F24 | URL/bookmark capture |
| F25 | Calendar integration |

**Definition of Done**: Full web dashboard for browsing, searching, and viewing outputs. PWA installable on iPhone.

---

## 10. Dependencies and Constraints

### Technical Dependencies
| Dependency | Required For | Risk |
|------------|-------------|------|
| Unraid server with Docker | Everything | Low — already operational |
| Tailscale | Remote access to all services | Low — already in use |
| Slack free workspace (K4JDA) | Capture + query interface | Low — already created |
| Ollama Docker image | Local embeddings + LLM | Low — well-maintained |
| faster-whisper Docker image | Local transcription | Low — multiple maintained images |
| Supabase self-hosted stack | Database + API + Studio | Medium — more complex Docker setup |
| Redis | Job queues | Low — standard Docker image |
| Anthropic API | Synthesis, governance (cloud fallback) | Low — stable, existing account |
| OpenAI API | Fallback transcription, fallback embeddings | Low — stable, existing account |
| Pushover | iPhone notifications | Low — existing account |
| Google Drive + rclone | Voice capture sync chain | Low — existing and working |
| Apple Watch + Just Press Record | Voice capture origin | Low — existing workflow |

### Assumptions
- Unraid server: Intel Core i7-9700 (8C/8T, 3.0GHz/4.7GHz turbo), 128GB DDR4 RAM, no dedicated GPU, 32TB array (~26TB free). Memory limits on heavy containers: Ollama 16GB, faster-whisper 8GB, Postgres 8GB. Lightweight containers unconstrained. Total estimated footprint ~20-25GB.
- Tailscale is configured and the server is accessible remotely
- Bitwarden Secrets Manager is accessible for API key retrieval
- The user's daily capture volume will be <50 captures/day (affects pipeline queue sizing and Ollama load)

### Constraints
- Slack free plan: 90-day message history (not a problem — data lives in Supabase)
- Slack free plan: 10 app integrations (only need 1)
- Ollama on CPU is slower — may need to batch-process if many captures arrive simultaneously
- No multi-user support — single user by design, simplifies everything

---

## 11. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Supabase self-hosting complexity | Medium | High | Follow official Docker guide; Supabase Studio provides dashboard for debugging |
| Ollama embedding quality insufficient | Low | Medium | Benchmark against cloud embeddings; fallback to OpenAI text-embedding-3-small |
| Unraid resource constraints (many containers) | Medium | Medium | Monitor with Unraid dashboard; phase rollout to spread load |
| Slack free plan limitations change | Low | Medium | Core system doesn't depend on Slack — just one input adapter |
| Pipeline stage failure cascades | Low | Medium | Circuit breakers, independent stages, retry logic |
| Embedding model dimension mismatch | ~~Medium~~ Resolved | ~~High~~ | Decided: nomic-embed-text (768d), schema uses vector(768), no fallback to different-dimension models |
| voice-capture integration breaks existing workflow | Medium | Medium | Hard cutover with Notion backfill script as safety net |
| Data loss on Unraid | Low | Critical | Regular Postgres backups to offsite storage |

---

## 12. Resolved Questions

All open questions from the initial draft have been resolved. Decisions are captured inline throughout this document and in the answers file.

| # | Question | Decision |
|---|----------|----------|
| 1 | Unraid hardware specs | Intel i7-9700, 128GB DDR4, no GPU, 32TB array (~26TB free) |
| 2 | Embedding model | nomic-embed-text (768d) via Ollama — local, no fallback |
| 3 | External access method | Hybrid: existing Tailscale + SWAG unchanged, Cloudflare Tunnel (free) added for brain.k4jda.net only |
| 4 | Email delivery | SMTP via existing personal email account |
| 5 | Slack voice clip routing | Route through voice-capture container (single audio path) |
| 6 | Backup strategy | Daily pg_dump to Unraid share (7-day local) + weekly offsite to Google Drive via rclone (30-day) |
| 7 | Notion parallel migration | No — hard cutover. One-time Notion backfill script as safety net. |
| 8 | Web UI framework | Vite + React (lightweight SPA) with Tailwind + shadcn/ui + vite-plugin-pwa |
| 9 | Slack command interface | Both: prefix commands as baseline (Socket Mode), slash commands as enhancement once Cloudflare Tunnel is stable |

**Additional decisions resolved (beyond original 9):**

| Topic | Decision |
|-------|----------|
| Brain views | 5 views: career, personal, technical, work-internal, client. Hybrid auto-classification + manual override. |
| Intent router fallback | Prefix-only: `?` = query, `!` = command, `@Open Brain` = query, no prefix = capture |
| Prompt templates | Phase 1: extract_metadata + intent_router. Others deferred. Versioned, hot-reloadable. |
| Governance FSM | Slack-native conversational redesign, not FSM port. board-journal principles preserved. |
| Board role personalities | Defer to Phase 3, designed alongside conversational flow. |
| Monitoring | Lean: Docker logs + Unraid dashboard + pipeline_log + Pushover alerts. No Prometheus/Grafana. |
| Schema migrations | Drizzle ORM + drizzle-kit. TypeScript-native, schema-as-code. |
| AI cost management | Monthly budget: soft $30 (Pushover alert), hard $50 (circuit breaker → local only). |
| Synthesis endpoint | Top-20 captures, 50K token budget. Skills handle own context assembly. |
| Container resources | Memory limits on Ollama (16GB), faster-whisper (8GB), Postgres (8GB) only. |
| Capture types | 8 types: decision, idea, observation, task, win, blocker, question, reflection. Extensible via prompt. |
| Config reloading | Re-read per job start + API reload endpoint. In-flight jobs keep their config. |
| Thread context | Redis with 1-hour TTL, keyed by thread_ts. |
| Session persistence | Postgres + transcript replay on resume. 30-day max pause. |
| Deduplication | Source-level only: slack_ts, filename, content hash + 60s window. No cross-source. |
| Docker networking | Two networks: supabase-internal + open-brain. Postgres bridges both. |
| Embedding consistency | No fallback. Queue and retry if Ollama down. |
| Pipeline error recovery | 5 retries (30s, 2m, 10m, 30m, 2h) + daily auto-retry sweep. |
| Capture timestamps | `captured_at` optional in API. Adapters pass original timestamp. |
| board-journal migration | Conceptual reference doc only — principles, not code. Clean-room implementation. |
| Supabase components | Postgres + pgvector + Studio + Realtime. Skip PostgREST, GoTrue, Kong, Storage. |

---

## 13. Glossary

| Term | Definition |
|------|-----------|
| **Capture** | Any piece of information ingested into the brain — a voice memo transcript, Slack message, document summary, bookmark, etc. |
| **Brain** | The entire Supabase database containing all captures, entities, and metadata |
| **Brain View** | A tag-based filter that groups captures into logical collections (career, consulting, personal) with optional distinct pipeline processing |
| **Pipeline** | The async processing chain that transforms a raw capture into an embedded, classified, entity-linked record |
| **Stage** | A single step in a pipeline (embed, extract_metadata, link_entities, etc.) |
| **Output Skill** | A scheduled or triggered process that queries the brain, performs AI synthesis, and delivers results (weekly brief, board session, drift alert) |
| **Entity** | A known person, project, decision, bet, or concept that appears across multiple captures |
| **Intent Router** | The component in the Slack bot that determines whether an incoming message is a capture, query, command, or conversation |
| **AI Router** | The configuration layer that routes AI requests to the appropriate provider (Ollama, Claude, GPT) based on task type |
| **Governance Session** | A structured, multi-turn interaction (FSM) for career governance — inherited from board-journal |
| **Bet** | A 90-day falsifiable prediction made during a governance session |
| **MCP** | Model Context Protocol — open standard for AI tools to interact with external data sources |

---

## 14. Change Log

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-04 | 0.1 | Initial draft based on conceptual discussion |
| 2026-03-04 | 0.2 | All 30 open questions resolved via interactive Q&A session. Key decisions: nomic-embed-text (768d) embeddings, Cloudflare Tunnel for brain.k4jda.net, Vite + React for web UI, Drizzle ORM for migrations, 5 brain views, Slack-native governance redesign, no embedding fallback, patient retry strategy with daily auto-sweep. |

---

## Document Resolution Log

*This document was completed on 2026-03-04 using `/finish-document`.*

**Questions Resolved:** 30 of 30
**Reference Files:**
- Questions: `reference/questions-PRD-20260304-120000.json`
- Answers: `answers-PRD-20260304-160000.json`
- Original backup: `PRD.backup-20260304-160000.md`
