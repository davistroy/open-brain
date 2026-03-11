# Product Requirements Document (PRD)
# Open Brain — Personal AI Knowledge Infrastructure

**Version**: 0.6
**Author**: Troy Davis / Claude
**Date**: 2026-03-05
**Status**: Draft — Architectural Review v2 Applied

---

## 1. Executive Summary

Open Brain is a self-hosted, Docker-based personal knowledge infrastructure system that ingests information from multiple sources (voice memos, Slack messages, documents, bookmarks, calendar events), processes and embeds them for semantic search, and provides rich output through AI-powered skills — including weekly briefs, career governance sessions, pattern detection, and ad-hoc synthesis.

The system runs entirely on the user's Unraid home server (`homeserver.k4jda.net`), stores all data in Postgres 16 with pgvector, and routes all AI requests through a self-hosted LiteLLM proxy for unified model management. It is accessible through Slack (bidirectional — capture and query), an MCP endpoint embedded in the Core API (for Claude, ChatGPT, and other AI tools via Streamable HTTP), a web dashboard, email reports, and push notifications.

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
- **Replaces voice-capture's Notion backend**: Voice memos flow into Postgres via the Core API instead of Notion, captured directly from iPhone/Apple Watch via iOS Shortcut → Core API
- **Implements the Open Brain architecture** from the companion document: Postgres + pgvector + MCP, fully self-hosted
- **Future-proofs AI integration**: LiteLLM proxy normalizes all LLM providers behind a single OpenAI-compatible API — no lock-in to any single model or service

### Product Principles
1. **Capture must be frictionless** — zero-thought input from the tools you already have open (Slack, Apple Watch)
2. **Infrastructure you own** — all data on your hardware, no SaaS dependencies for core functionality
3. **AI-agnostic** — LiteLLM proxy normalizes all providers (local Ollama, Claude, GPT, OpenRouter) behind a single API; swap models without code changes
4. **Pipeline-first** — every operation (ingest, process, output) flows through configurable, async pipelines
5. **Extensible by design** — new input sources, processing stages, and output skills without touching existing code
6. **The brain compounds** — every capture makes future queries smarter; the system's own outputs feed back in

### Differentiation from the Open Brain Document
The document describes a lightweight Slack → cloud Postgres → MCP setup. This project extends that concept significantly:
- Self-hosted on Unraid (Docker) with plain Postgres + pgvector
- Voice input via existing voice-capture pipeline (Apple Watch → faster-whisper → pipeline)
- Async processing pipeline with configurable stages (not synchronous Edge Functions)
- Rich output skills (weekly briefs, governance sessions, pattern detection) inherited from board-journal
- Bidirectional Slack interface (capture + query + commands + interactive sessions)
- Local AI (LiteLLM for embeddings, faster-whisper for transcription)
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

1. Press action button on Apple Watch → iOS Shortcut records audio
2. Shortcut sends audio directly to voice-capture HTTP endpoint (`POST /api/capture`)
3. voice-capture routes audio to faster-whisper container for local transcription
4. Claude/local LLM classifies content, extracts metadata
5. voice-capture calls Open Brain ingest API with transcript + classification + metadata
6. Open Brain pipeline: embed → extract entities → link relationships → evaluate triggers
7. Pushover notification to iPhone: "Captured: idea — QSR pricing, People: Tom"

**Total latency**: ~30-90 seconds (no sync delay — direct API capture)

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
2. Bot starts an LLM-driven governance session in a Slack thread
3. LLM walks through structured audit with required topics and anti-vagueness enforcement
4. Each answer is validated, captured, and linked to active bets/projects
5. Session completes → generates assessment + 90-day prediction
6. Full session captured back into brain, report delivered to email + web dashboard

### Journey 5: AI Tool Query via MCP

**Trigger**: User is working in Claude Code or ChatGPT and needs context

1. AI tool calls MCP `search_brain` with query "QSR engagement status" via Streamable HTTP
2. MCP endpoint (embedded in Core API) performs semantic search
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

### Journey 8: Proactive Memory Surfacing (Semantic Trigger)

**Trigger**: New capture matches a persistent semantic pattern

1. Troy voices "Just heard the QSR rollout might slip to Q3" on his Apple Watch
2. Voice-capture transcribes and ingests into Open Brain via pipeline
3. After embedding, the `check_triggers` pipeline stage compares the new capture against active semantic triggers
4. The capture matches Troy's "QSR timeline" trigger (similarity > threshold)
5. System runs hybrid search for related captures — finds 3 relevant captures from the past 30 days
6. Pushover notification: "New capture matches your 'QSR timeline' trigger — 3 related captures found"
7. Troy can query for full context or let it sit

**Value**: The brain proactively delivers relevant memories instead of waiting for you to ask.

---

## 5. Feature Specifications

### 5.1 Feature Overview

| ID | Feature | Priority | Phase | Status |
|----|---------|----------|-------|--------|
| F01 | Core API (ingest, query, synthesize) | Must Have | Phase 1A | Implemented |
| F02 | Postgres 16 + pgvector (self-hosted) | Must Have | Phase 1A | Implemented |
| F03 | Async processing pipeline (BullMQ + Redis) | Must Have | Phase 1C | Implemented |
| F04 | Slack bot — capture (text) | Must Have | Phase 1D | Implemented |
| F05 | Slack bot — query (semantic search) | Must Have | Phase 1D | Implemented |
| F06 | MCP endpoint (embedded in Core API, Streamable HTTP) | Must Have | Phase 1E | Implemented |
| F07 | EmbeddingService via LiteLLM (spark-qwen3-embedding-4b alias) | Must Have | Phase 1B | Implemented |
| F07a | LiteLLM proxy (unified LLM gateway) | Must Have | Phase 1C | Implemented |
| F08 | AI router service (LiteLLM-based provider routing) | Must Have | Phase 1C | Implemented |
| F09 | Voice-capture integration (adapter to ingest API) | Must Have | Phase 2A | Implemented |
| F10 | faster-whisper container (local STT) | Must Have | Phase 2A | Implemented |
| F11 | Slack bot — commands (/ob stats, /ob brief) | Should Have | Phase 2B | Implemented |
| F12 | Weekly brief output skill | Should Have | Phase 2B | Implemented |
| F13 | Pushover notifications | Should Have | Phase 2B | Implemented |
| F14 | Email delivery (HTML reports) | Should Have | Phase 2B | Implemented |
| F15 | Entity graph (people, projects, decisions) | Should Have | Phase 3 | Implemented |
| F16 | Slack bot — interactive sessions (LLM-driven governance) | Should Have | Phase 3 | Implemented |
| F17 | Board governance skills (quick check, quarterly) | Should Have | Phase 3 | Implemented |
| F18 | Bet tracking and evaluation | Should Have | Phase 3 | Implemented |
| F19 | Web dashboard (Vite + React PWA) | Could Have | Phase 4 | Implemented |
| F20 | Slack voice clip processing | Could Have | Phase 3 | Implemented |
| F21 | Daily connection/pattern detection skill | Should Have | Phase 5A | Planned |
| F22 | Drift monitor skill | Should Have | Phase 5A | Planned |
| F23 | Document ingestion (PDF, docx) | Could Have | Phase 4 | Implemented |
| F24 | URL/bookmark capture | Should Have | Phase 5B | Planned |
| F25 | Calendar integration | Could Have | Phase 4 | **DEFERRED** |
| F26 | Notion output skill (optional mirror) | Won't Have | Future | **DEFERRED** |
| F27 | Screenshot/image capture (vision model) | Could Have | Future | **DEFERRED** |
| F28 | Semantic push triggers (proactive memory surfacing) | Should Have | Phase 2C | Implemented |

### 5.2 Detailed Feature Specifications

---

#### F01: Core API

**Description**: Central API service that all clients (Slack bot, MCP endpoint, web UI, voice-capture adapter) interact with. MCP is embedded in the Core API at the `/mcp` route (Streamable HTTP transport). Provides endpoints for ingestion, querying, synthesis, skill management, and session management.

**Tech**: TypeScript, Hono framework, Drizzle ORM (schema-as-code, type-safe queries, drizzle-kit for migrations), runs as Docker container

**Endpoints**:

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/v1/captures` | Ingest a new capture |
| GET | `/api/v1/captures` | List captures with filters (date, type, topic, person, source) |
| GET | `/api/v1/captures/:id` | Get single capture with full detail |
| PATCH | `/api/v1/captures/:id` | Update capture tags, brain_views, or metadata overrides |
| DELETE | `/api/v1/captures/:id` | Soft-delete a capture |
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

**Search Endpoint** (`POST /api/v1/search`):
- Accepts `offset` parameter (integer, default 0) for pagination of result pages
- Combined with `limit` parameter for paged retrieval

**Synthesize Endpoint Specification**:
- Top-N retrieval with configurable token budget: default top 20 captures, 50K token budget
- If context exceeds budget, truncate from bottom (lowest similarity scores)
- Ad-hoc synthesis results are ephemeral — not cached, not re-captured into the brain
- Output skills (weekly brief, governance) implement their own context assembly — they call `/api/v1/search` for captures and handle chunking/summarization internally before calling the AI router directly
- `captured_at` is an optional field in the ingest payload — input adapters pass original timestamp (file creation time, slack_ts). Defaults to `created_at`. All time-based queries use `captured_at`.

**Capture Update Endpoint**:
- `PATCH /api/v1/captures/:id` allows updating: `tags`, `brain_views`, and a `metadata_overrides` jsonb field
- Overrides are merged (not replaced) with pipeline-extracted metadata
- Slack reactions can trigger brain_view updates (e.g., `:career:` reaction adds `career` brain view)
- Updated captures are NOT re-embedded — only classification metadata changes

**Acceptance Criteria**:
- All endpoints return JSON, use standard HTTP status codes
- Ingest endpoint accepts captures and returns capture ID + status within 500ms (queues async processing)
- Search endpoint returns results within 5 seconds
- API is unauthenticated (single user, network-level security via Tailscale/LAN)
- Health endpoint returns status of all dependent services (DB, Redis, LiteLLM)

---

#### F02: Postgres 16 + pgvector

**Description**: Plain Postgres 16 with pgvector extension for vector similarity search. Uses the `pgvector/pgvector:pg16` Docker image directly — no Supabase. Drizzle Studio serves as the dev database browser. Real-time updates for the Phase 4 web dashboard use SSE from the Core API with Postgres LISTEN/NOTIFY underneath.

**Deployment**: Docker Compose on Unraid, single `postgres` container with custom `postgresql.conf` for tuned performance (shared_buffers=2GB, effective_cache_size=6GB, work_mem=64MB, maintenance_work_mem=512MB).

**Database Schema**:

**captures table** (primary storage):
```sql
create table captures (
  id uuid default gen_random_uuid() primary key,

  -- Content
  content text not null,                          -- processed/final text
  content_raw text,                               -- original raw input (before transcription, etc.)
  content_hash char(64),                          -- SHA-256 of normalized content (trim, collapse whitespace, lowercase) for dedup
  embedding vector(768),                          -- semantic embedding (768d — compatible with nomic-embed-text native or Qwen3-Embedding Matryoshka-truncated)

  -- Temporal tracking (ACT-R cognitive model for search relevance)
  access_count int default 0,                      -- how many times this capture appeared in search results
  last_accessed_at timestamptz,                    -- when this capture was last returned in a search

  -- Classification
  metadata jsonb default '{}'::jsonb,             -- extracted metadata (people, topics, type, action_items, dates)
  source text not null,                           -- slack, voice, web, api, email, document
  source_metadata jsonb default '{}'::jsonb,      -- source-specific details
  pre_extracted jsonb default '{}'::jsonb,        -- classification from input adapter (e.g., voice-capture templates)

  -- Organization
  tags text[] default '{}',                       -- user-assigned or auto-assigned tags
  brain_views text[] default '{}'::text[],        -- which "brain views" this belongs to

  -- Entity links via entity_links table JOIN (no denormalization needed at <100K rows)

  -- Processing audit trail
  pipeline_status text default 'received',        -- received, processing, complete, failed, partial
  -- Pipeline history in pipeline_events table (append-only, avoids JSONB rewrite)

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
create index on captures using gin (to_tsvector('english', content));  -- Full-text search for hybrid retrieval (RRF)
create index on captures (created_at desc);
create index on captures (source);
create index on captures (pipeline_status);
create index on captures (content_hash);
```

**pipeline_events table** (append-only processing audit trail):
```sql
create table pipeline_events (
  id uuid default gen_random_uuid() primary key,
  capture_id uuid not null references captures(id) on delete cascade,
  stage text not null,
  status text not null,              -- complete | failed | skipped
  model text,
  duration_ms int,
  error text,
  retry_count int default 0,
  created_at timestamptz default now()
);
create index on pipeline_events (capture_id);
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

**sessions table** (LLM-driven governance — Phase 3):
```sql
create table sessions (
  id uuid default gen_random_uuid() primary key,
  session_type text not null,                     -- quick_check, quarterly, custom
  status text default 'active',                   -- active, paused, completed, abandoned
  state jsonb not null,                           -- LLM conversation state: {turn_count, max_turns, topics_covered, topics_remaining, last_role, idle_timeout_minutes}
  -- Transcript stored in session_messages table (append-only, avoids JSONB rewrite)
  config jsonb default '{}'::jsonb,               -- session-specific configuration
  result jsonb,                                   -- final output/assessment
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  completed_at timestamptz
);
```

**session_messages table** (append-only transcript storage):
```sql
create table session_messages (
  id uuid default gen_random_uuid() primary key,
  session_id uuid not null references sessions(id) on delete cascade,
  role text not null,                 -- system | bot | user
  board_role text,                    -- strategist | operator | contrarian | coach | analyst
  content text not null,
  created_at timestamptz default now()
);
create index on session_messages (session_id);
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
  token_usage jsonb,                              -- {input_tokens, output_tokens} (cost from LiteLLM /spend/logs)
  created_at timestamptz default now(),
  completed_at timestamptz,
  error text
);
```

**Semantic search function** (with ACT-R temporal decay scoring):
```sql
create or replace function match_captures(
  query_embedding vector(768),
  match_threshold float default 0.5,
  match_count int default 10,
  filter_source text default null,
  filter_tags text[] default null,
  filter_brain_views text[] default null,
  filter_after timestamptz default null,
  filter_before timestamptz default null,
  temporal_weight float default 0.0  -- 0.0 = pure semantic, 1.0 = pure temporal. Start at 0.0; increase after search history builds.
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  source text,
  tags text[],
  similarity float,
  temporal_score float,
  composite_score float,
  captured_at timestamptz
)
language plpgsql as $$
-- Multiplicative boost preserves semantic ordering when temporal_weight is low
-- and prevents high temporal scores from overriding poor semantic matches.
begin
  return query
  with base as (
    select
      c.id, c.content, c.metadata, c.source, c.tags, c.captured_at,
      1 - (c.embedding <=> query_embedding) as semantic_sim,
      -- ACT-R temporal activation: ln(access_count) - 0.5 * ln(hours_since_last_access)
      case
        when c.last_accessed_at is null then 0.0
        else greatest(0.0, least(1.0,
          (ln(greatest(c.access_count, 1))
           - 0.5 * ln(greatest(extract(epoch from (now() - c.last_accessed_at)) / 3600.0, 1.0))
          ) / 5.0 + 0.5
        ))
      end as temporal_act
    from captures c
    where c.deleted_at is null
      and c.pipeline_status = 'complete'
      and 1 - (c.embedding <=> query_embedding) > match_threshold
      and (filter_source is null or c.source = filter_source)
      and (filter_tags is null or c.tags && filter_tags)
      and (filter_brain_views is null or c.brain_views && filter_brain_views)
      and (filter_after is null or c.captured_at >= filter_after)
      and (filter_before is null or c.captured_at <= filter_before)
  )
  select
    b.id, b.content, b.metadata, b.source, b.tags,
    b.semantic_sim as similarity,
    b.temporal_act as temporal_score,
    b.semantic_sim * (1.0 + temporal_weight * b.temporal_act) as composite_score,
    b.captured_at
  from base b
  order by b.semantic_sim * (1.0 + temporal_weight * b.temporal_act) desc
  limit match_count;
end;
$$;
```

**Hybrid search function** (full-text + vector with Reciprocal Rank Fusion):

The primary search function combines pgvector cosine similarity with Postgres full-text search via RRF. This significantly improves recall for paraphrased or keyword-heavy queries. See TDD §4.3 for the full `match_captures_hybrid` function definition.

**Acceptance Criteria**:
- Postgres container runs stable on Unraid in Docker with tuned postgresql.conf
- Drizzle Studio accessible for dev database browsing
- pgvector extension enabled, HNSW index functional
- All tables created with indexes via Drizzle migrations
- Semantic search function returns results <2 seconds for 100k+ captures
- `set_updated_at()` trigger applied to all tables with `updated_at` column

---

#### F03: Async Processing Pipeline

**Description**: Event-driven pipeline that processes captures through configurable stages. Each stage is independent, can be retried individually, and records its result on the capture record.

**Tech**: BullMQ job queues backed by Redis

**Pipeline Stages**:

| Stage | Purpose | Default AI | Skips When |
|-------|---------|-----------|------------|
| `transcribe` | Audio → text via faster-whisper | Local faster-whisper | Input is already text |
| `embed` | Generate vector embedding | LiteLLM spark-qwen3-embedding-4b alias (see F07) | — |
| `check_triggers` | Match against active semantic triggers (separate BullMQ job, not inline) | Cosine similarity (in-memory) | No active triggers (Phase 2) |
| `extract_metadata` | Extract people, topics, type, action_items, dates, brain_views | Configurable (default: local via LiteLLM) | — |
| `classify` | Domain classification (career signals, etc.) | Configurable via LiteLLM | No matching brain_view pipeline |
| `link_entities` | Match and link to known entities | LiteLLM or rule-based | Phase 3 |
| `evaluate_triggers` | Check trigger rules (drift, bet expiration, etc.) | Rule-based + AI | Phase 3 |
| `notify` | Send confirmation to source (Slack reply, Pushover) | — | — |

**Pipeline Configuration** (YAML):
```yaml
pipelines:
  default:
    stages:
      - name: embed
        provider: litellm          # Embeddings route through LiteLLM (spark-qwen3-embedding-4b alias)
        model: ${EMBEDDING_MODEL}  # Configured in ai-routing.yaml (spark-qwen3-embedding-4b)

      # check_triggers runs as a separate BullMQ job after embed completes (not an inline stage)
      # Enqueued automatically by the embed stage handler — see TDD §12.2a

      - name: extract_metadata
        provider: litellm          # Routes through LiteLLM proxy
        model: fast                # LiteLLM model alias → resolves to configured model
        prompt_template: extract_metadata_v1

      - name: notify
        targets: [source_reply]

  voice:
    # voice-capture handles transcription + classification before ingest
    # so this pipeline only adds embedding and entity linking
    stages:
      - name: embed
        provider: ollama
        model: ${EMBEDDING_MODEL}

      # check_triggers: separate BullMQ job after embed (see TDD §12.2a)

      - name: extract_metadata
        provider: litellm
        model: fast
        prompt_template: extract_metadata_v1
        merge_with_pre_extracted: true

      - name: notify
        targets: [pushover]

  career:
    extends: default
    additional_stages:
      - name: extract_career_signals
        provider: litellm
        model: synthesis           # LiteLLM alias → Claude Sonnet
        prompt_template: career_signals_v1
        after: extract_metadata
```

**Stage Execution**:
- Each stage reads the capture record, does its work, writes results back to the record + inserts a row into `pipeline_events`
- Stage failure → retry with patient exponential backoff: 5 retries per stage (30s, 2m, 10m, 30m, 2h), then mark stage as failed. Pushover alert on final failure. Daily auto-retry sweep for all failed stages (one additional attempt per day). Manual retry also available via API.
- Partial completion preserved — if `embed` succeeds but `extract_metadata` fails, the embedding is kept
- Pipeline routing: based on `source` field and `brain_views` tags, the system selects which pipeline config to use

**Acceptance Criteria**:
- Pipeline processes a text capture end-to-end in <30 seconds
- Individual stage failure does not block other stages (where no dependency exists)
- Failed stages can be retried individually via API (`POST /api/v1/captures/:id/retry?stage=extract_metadata`)
- Pipeline configuration is YAML-driven; config re-read on each pipeline job start (naturally picks up changes within seconds). API reload endpoint (`POST /admin/reload-config`) available for immediate cache clear. In-flight jobs complete with the config they started with.
- `pipeline_events` rows for each capture show: stage name, status, model used, duration, timestamp

---

#### F04: Slack Bot — Capture

**Description**: Receives messages in the `#open-brain` Slack channel and ingests them as captures. Default behavior for any message without a query/command prefix.

**Tech**: `@slack/bolt` with `socketMode: true`, Node.js container

**Behavior**:
- Any message in `#open-brain` without a recognized prefix → treat as capture
- Call Core API `POST /api/v1/captures` with content, source: "slack", source_metadata including slack_ts, channel, user
- Reply in thread with confirmation once pipeline completes (via notify stage callback to Slack)
- Ignore messages from bots (prevent feedback loops)
- Handle Slack's URL verification challenge
- Handle audio file attachments → route to voice-capture container's HTTP endpoint for consistent classification and processing (all audio follows a single path through voice-capture regardless of source)

**Slack Free Plan Constraints**:
- 90-day message history — captures are in Postgres, so Slack history loss doesn't matter for the brain
- 10 app integrations max — we only need 1 (Open Brain bot)
- No shared channels — fine for single-user
- Rate limits: 1 message per second per channel (more than sufficient)

**Required Slack App Configuration**:
- Bot Token Scopes: `channels:history`, `groups:history`, `chat:write`, `files:read` (for voice clips), `app_mentions:read` (for @mentions)
- Event Subscriptions: `message.channels`, `message.groups`, `app_mention`
- The bot will be installed to the K4JDA workspace, invited to `#open-brain` channel

**Acceptance Criteria**:
- Text message in `#open-brain` → captured in Postgres within 10 seconds
- Thread reply confirms capture with type and key metadata extracted
- Bot ignores its own messages and messages from other bots
- Graceful handling of Slack retries (idempotency via slack_ts dedup)

---

#### F05: Slack Bot — Query

**Description**: When the user asks a question (detected by prefix or intent), perform hybrid search (full-text + vector with Reciprocal Rank Fusion) and return temporally-weighted results in Slack. Search results are ranked by a composite score combining semantic similarity with temporal activation (recency + access frequency via ACT-R model). Recent or frequently-accessed captures rank higher than stale ones at equal similarity.

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
- Follow-up interactions work in the same thread (thread context stored in Redis with 1-hour TTL, keyed by thread_ts; expired threads reply with: "This search has expired (1-hour timeout). Send a new query to search again." Does not silently fail or return errors.)
- Synthesis queries use the configured AI model and return coherent multi-paragraph responses
- Intent router correctly distinguishes capture vs. query >95% of the time

---

#### F06: MCP Endpoint (Embedded in Core API)

**Description**: Model Context Protocol endpoint embedded in the Core API that allows any MCP-compatible AI client (Claude Desktop, Claude Code, ChatGPT, Cursor, VS Code Copilot) to search, browse, capture, and get stats from the brain. Uses Streamable HTTP transport — no separate container, no stdio, no SSE transport.

**Tech**: @modelcontextprotocol/sdk, embedded in Core API at `/mcp` route

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
- API key authentication via Authorization header (`Authorization: Bearer <key>`)
- Accessible via Tailscale for remote use, or LAN for local
- Connection URL: `https://brain.k4jda.net/mcp` (via Cloudflare Tunnel — existing Tailscale + SWAG setup unchanged, Cloudflare Tunnel added only for brain.k4jda.net)
- Authentication: `Authorization: Bearer <access_key>` header on every request

**Acceptance Criteria**:
- All tools functional and return well-formatted text results
- search_brain returns results within 5 seconds
- capture_thought creates captures that go through the full pipeline
- Works with Claude Desktop, Claude Code, and ChatGPT MCP integrations via Streamable HTTP
- API key required for all requests
- No separate container — MCP runs within Core API process

---

#### F07: Embedding Service (via LiteLLM)

**Description**: Vector embedding generation for all captures, triggers, and search queries. Routes through external LiteLLM at `https://llm.k4jda.net` via the `spark-qwen3-embedding-4b` alias. LLM inference also routes through the same external LiteLLM — see F07a and F08.

**Embedding Model**: Qwen3-Embedding-4B (selected, configured on external LiteLLM)

The schema uses `vector(768)` throughout. Qwen3-Embedding-4B returns 2560d Matryoshka vectors, truncated to 768d in the embedding service.

**Qwen3-Embedding advantages**: Matryoshka dimensions (truncate to any power-of-2 with minimal quality loss), 32K context (significant for document ingestion in Phase 4), instruction-following support (`Instruct: ...` prefixes for asymmetric query/document embedding), and MTEB top performance at release.

**No embedding fallback** — if LiteLLM is unreachable, captures queue in BullMQ and retry when service recovers. This prevents mixing embedding models which would degrade search quality.

**API**: OpenAI embeddings API (`POST /v1/embeddings`) via LiteLLM — same client as LLM inference, using `spark-qwen3-embedding-4b` model alias.

**Acceptance Criteria**:
- `spark-qwen3-embedding-4b` alias on external LiteLLM returns 768d vectors
- Embedding generation <2 seconds per capture (network + LiteLLM inference)
- EmbeddingUnavailableError thrown on failure → BullMQ retry
- Embeddings queue gracefully when LiteLLM unreachable

---

#### F07a: LiteLLM Proxy

**Description**: External shared LLM gateway at `https://llm.k4jda.net` that provides a unified OpenAI-compatible API for all AI requests — both embeddings (spark-qwen3-embedding-4b alias → Qwen3-Embedding-4B (via LiteLLM, Matryoshka-truncated to 768d)) and all LLM inference. Managed independently of Open Brain's Docker stack. Model aliases, provider routing, fallbacks, and budget limits are configured on the external server.

**Key Capabilities**:
- **Unified API**: Single `https://llm.k4jda.net` endpoint for all AI calls (embeddings + LLM)
- **Model aliasing**: Logical names (`spark-qwen3-embedding-4b`, `fast`, `synthesis`, `governance`, `intent`) configured on external server
- **Automatic fallback**: Primary → fallback routing per model alias
- **Budget tracking**: Built-in monthly spend tracking with soft/hard limits ($30 soft alert, $50 hard limit)
- **Request logging**: All AI calls logged with tokens, latency, cost

**Required model aliases** (configured on external LiteLLM server — not managed by this project):

| Alias | Purpose | Fallback |
|-------|---------|---------|
| `spark-qwen3-embedding-4b` | Qwen3-Embedding-4B (Matryoshka 2560d → 768d) | None — queue and retry |
| `fast` | Local LLM inference (TBD) | — |
| `intent` | Intent classification (TBD) | — |
| `synthesis` | Anthropic Claude Sonnet | openai/gpt-4o |
| `governance` | Anthropic Claude Opus | claude-sonnet |

**Acceptance Criteria**:
- External LiteLLM reachable at `https://llm.k4jda.net/health`
- Model aliases resolve correctly (spark-qwen3-embedding-4b → 768d vectors, synthesis → Claude Sonnet)
- Fallback triggers automatically on provider failure
- Monthly spend tracked and hard limit enforced at $50 (configured on external server)

---

#### F08: AI Router Service

**Description**: A thin application-layer service that maps task types to LiteLLM model aliases. LiteLLM handles all AI requests — both embeddings (spark-qwen3-embedding-4b alias) and LLM inference. The AI Router in application code is responsible for: (1) mapping task types to LiteLLM model aliases, (2) routing embedding requests to the `spark-qwen3-embedding-4b` alias through the same LiteLLM client, and (3) logging usage to the `ai_audit_log` table from LiteLLM response metadata.

**Configuration** (`config/ai-routing.yaml`):
```yaml
ai_routing:
  # Embedding config — routes through LiteLLM (spark-qwen3-embedding-4b alias)
  embedding:
    provider: litellm
    model: spark-qwen3-embedding-4b    # Alias on external LiteLLM → Qwen3-Embedding-4B (Matryoshka-truncated to 768d)
    dimensions: 768             # Schema dimension — model produces 768d vectors
    # NO fallback. Queue and retry if LiteLLM is unreachable.

  # LLM task → LiteLLM model alias mapping
  # LiteLLM handles provider routing and fallback internally
  task_models:
    metadata_extraction: fast        # → TBD local LLM (via LiteLLM)
    intent_classification: intent    # → TBD local LLM (via LiteLLM); degrades to prefix-only if LiteLLM down
    synthesis: synthesis             # → anthropic/claude-sonnet (via LiteLLM, fallback: openai/gpt-4o)
    governance: governance           # → anthropic/claude-opus (via LiteLLM, fallback: claude-sonnet)
    career_signals: synthesis        # → same as synthesis
    weekly_brief: synthesis          # → same as synthesis
    drift_detection: fast            # → TBD local model

  litellm:
    base_url: https://llm.k4jda.net
    # API key stored in Bitwarden as open-brain-litellm-api-key (ai-work project)
```

**Behavior**:
- All AI calls (embeddings + LLM inference) route through external LiteLLM at llm.k4jda.net
- Task type → model alias mapping is config-driven (change aliases without touching code)
- LiteLLM handles fallback, budget tracking, and request logging natively
- Application logs usage to `ai_audit_log` table for operational audit
- **Monthly budget caps** (enforced by LiteLLM): Soft limit at $30/month triggers Pushover alert. Hard limit at $50/month triggers circuit breaker. Expected normal usage: ~$15-30/month.
- Intent classification degrades gracefully: if LiteLLM unavailable, fall back to prefix-only detection (`?` = query, `!` = command, default = capture)

**Acceptance Criteria**:
- All AI calls (embeddings + LLM) route through external LiteLLM at llm.k4jda.net
- Task-to-model mapping configurable via YAML
- Fallback triggers automatically via LiteLLM (within 5 seconds)
- Usage logging captures all calls with token counts
- Budget enforcement works (soft alert + hard circuit breaker)

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

**Description**: Migrate the existing voice-capture project into the Open Brain monorepo as `packages/voice-capture/`. Replaces the Notion posting stage with an API call to the Core API. Voice memos are captured directly from iPhone/Apple Watch via iOS Shortcut → voice-capture HTTP endpoint (no Google Drive sync, no rclone for voice).

**Changes to voice-capture**:
1. **Migrate into monorepo** as `packages/voice-capture/`
2. **Replace Notion posting stage** with Open Brain ingest call
   - POST to `http://open-brain-api:3000/api/v1/captures`
   - Include transcript, classification, template fields, source metadata
3. **Swap transcription backend** from OpenAI Whisper API to local faster-whisper
   - Point transcription service at `http://faster-whisper:8000/v1/audio/transcriptions`
   - Keep OpenAI Whisper API as fallback
4. **Expose HTTP endpoint** for direct capture from iOS Shortcut (`POST /api/capture`)
5. **Remove Google Drive/rclone dependency** for voice memos — direct API capture only
6. **Language decision**: Evaluate whether to rewrite voice-capture in TypeScript (full monorepo integration) or keep as Python service with Docker container in the monorepo. TypeScript rewrite preferred for consistency but requires porting retry/circuit-breaker logic. Decision during Phase 2A implementation planning.

**Acceptance Criteria**:
- Voice memos flow from Apple Watch → iOS Shortcut → voice-capture HTTP API → Open Brain → Postgres
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
| System health issue | Emergency (2) | When a critical service (DB, LiteLLM) is unreachable |

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
Phase 1A:
F02 (Postgres) ──► F01 (Core API — CRUD, stats, health)

Phase 1B:
F07 (EmbeddingService/LiteLLM) ──► Search endpoints + match_captures functions

Phase 1C:
F07a (LiteLLM) ──► F08 (AI Router) ──► F03 (Pipeline)

Phase 1D:
F04 (Slack Capture) ──► F05 (Slack Query)

Phase 1E:
F06 (MCP — embedded in Core API) ──► Cloudflare Tunnel

Phase 2:
F10 (faster-whisper) ──► F09 (Voice-Capture Integration)
F12 (Weekly Brief) ──► F13 (Pushover) + F14 (Email)
F11 (Slack Commands) — depends on Core API
F28 (Semantic Triggers) ──► F13 (Pushover) + Slack delivery

Phase 3:
F15 (Entity Graph) ──► F16-F18 (Governance)

Phase 5A:
F21 (Daily Connections) ──► F22 (Drift Monitor)
  Depends on: F12 (Skills framework), F15 (Entity Graph), F18 (Bets)

Phase 5B:
F24 (URL/Bookmark Capture) ──► existing pipeline
  Depends on: F01 (Core API), F03 (Pipeline)

Independent (wire in when ready):
F13 (Pushover), F14 (Email)
```

---

#### F28: Semantic Push Triggers

**Description**: Persistent semantic patterns that fire Pushover/Slack notifications when new captures match. Users define triggers via Slack commands ("anything about QSR timeline", "mentions of hiring decisions"). When a new capture is ingested and its embedding semantically matches an active trigger above the threshold, a notification is sent immediately — without the user having to search. Up to 20 active triggers supported.

**Trigger Lifecycle**:
1. User creates trigger via Slack: `/ob trigger add "QSR timeline"`
2. System generates embedding for the trigger phrase and stores it
3. On every new capture (after embed stage), the `check_triggers` pipeline stage compares the capture's embedding against all active triggers (loaded in-memory, cached in Redis with 60s TTL)
4. If similarity exceeds the trigger's threshold (default: 0.72) and cooldown period has elapsed: fire the trigger
5. Firing: run hybrid search for related captures, send notification via configured channel (Pushover/Slack/both)

**Slack Commands**:
- `/ob trigger add "QSR timeline"` — create trigger with default threshold (0.72) and 60-minute cooldown
- `/ob trigger list` — list all active triggers with last-fired time
- `/ob trigger delete [name]` — deactivate trigger
- `/ob trigger test "QSR timeline"` — run against existing captures, show top 5 matches (no notification)

**Acceptance Criteria**:
- Triggers can be created, listed, deleted via Slack commands
- Pipeline checks triggers in <10ms (in-memory comparison, no vector index needed for ≤20 triggers)
- Matching triggers fire notifications within the pipeline processing window
- Cooldown prevents spam (default 60 minutes between fires for same trigger)
- Trigger management also available via API (`/api/v1/triggers`)

---

#### F21: Daily Connection/Pattern Detection Skill

**Description**: Scheduled skill that surfaces non-obvious connections and emerging patterns across captures. Queries the last 7 days of captures, groups by brain view and entity co-occurrence, then uses LLM synthesis to identify cross-domain connections the user might not see themselves. The output is a concise "connections brief" delivered via Pushover and saved as a capture for future search.

**Tech**: Follows the WeeklyBriefSkill pattern — class-based skill with BullMQ execution, prompt template, `skills_log` audit. Reuses existing `EmbeddingService` for similarity clustering and `hybrid_search()` for related-capture retrieval.

**Algorithm**:
1. Query captures from the last N days (default: 7), grouped by brain view
2. Build entity co-occurrence matrix (which entities appear together across captures)
3. Identify capture clusters via embedding similarity (group captures with cosine similarity > 0.75)
4. Assemble context within token budget (same pattern as weekly-brief)
5. Call LLM with `daily_connections_v1.txt` prompt — instruct to find non-obvious cross-domain patterns, recurring themes, and potential blind spots
6. Parse structured JSON output (connections array with: theme, captures involved, insight, confidence)
7. Deliver via Pushover (summary) + save as capture (type: `reflection`, source: `system`)
8. Log to `skills_log` with structured result

**Schedule**: Daily at 9:00 PM (after day's captures are processed)

**Slack Command**: `!connections` — trigger on-demand, optionally with `!connections 14` for custom day window

**Acceptance Criteria**:
- Skill runs daily and produces meaningful connections (not just topic summaries)
- Cross-domain connections surfaced (e.g., a pattern from `technical` that relates to `client` work)
- Entity co-occurrence highlighted (people/projects that appear together but haven't been explicitly linked)
- Output saved as searchable capture for future retrieval
- Pushover notification includes top 3 connections with brief context
- Manual trigger via Slack or API works with custom day window

---

#### F22: Drift Monitor Skill

**Description**: Scheduled skill that detects when tracked projects, bets, or stated commitments go silent — surfacing potential drift before it becomes a problem. Compares active bets, recent governance session commitments, and entity activity against capture recency to identify topics that have gone quiet. Alerts the user to items that may need attention.

**Tech**: Same skill framework as F21 (class-based, BullMQ, prompt template). Queries bets (pending), recent governance session outputs, and entity mention frequency. Uses time-decay analysis — not just "has this been mentioned" but "is the mention frequency declining."

**Algorithm**:
1. Load all pending bets with resolution dates
2. Load governance session commitments from last 30 days (parsed from session outputs)
3. Query entity mention frequency over rolling 7-day windows (current vs. previous)
4. Flag items where:
   - Pending bet has no related captures in last 14 days
   - Entity mention frequency dropped >50% week-over-week
   - Governance commitment has zero follow-up captures
5. Call LLM with `drift_monitor_v1.txt` prompt — assess severity, suggest specific actions
6. Parse structured JSON (drift_items array with: item, type, last_activity, severity, suggested_action)
7. Deliver via Pushover (items with severity > medium) + save as capture
8. Log to `skills_log`

**Schedule**: Daily at 8:00 AM (morning awareness alert)

**Slack Command**: `!drift` — trigger on-demand drift check

**Acceptance Criteria**:
- Bets approaching resolution date with no recent activity flagged as high severity
- Entity mention frequency decline detected and reported
- Governance commitments without follow-through surfaced
- No false positives on intentionally quiet topics (uses 14-day minimum silence threshold)
- Pushover alert only fires when drift items with severity > medium exist
- Manual trigger via Slack or API works

---

#### F24: URL/Bookmark Capture

**Description**: Capture web page content by URL — extracts readable text from the page, stores it as a capture, and processes through the standard pipeline (embed, extract entities, check triggers). Entry points: Slack command, web UI, and API. Uses Mozilla Readability for content extraction (same library behind Firefox Reader View) — no headless browser needed.

**Tech**: `@mozilla/readability` + `linkedom` (DOM parser for Node.js without browser). Lightweight, fast, handles most article-style pages. Falls back to raw HTML text extraction if Readability fails.

**Capture Flow**:
1. Receive URL from any entry point (Slack `!bookmark <url>`, web UI, API)
2. Fetch page HTML via `fetch()` with 10-second timeout and user-agent header
3. Parse HTML with `linkedom`, extract with `@mozilla/readability`
4. Store extracted content as capture with:
   - `content`: Readability text output (title + body, truncated to 50K chars)
   - `capture_type`: `observation` (default, pipeline may reclassify)
   - `source`: `bookmark`
   - `source_metadata`: `{ url, title, excerpt, siteName, byline, fetchedAt }`
   - `tags`: `['bookmark']` + auto-extracted domain tag (e.g., `nytimes.com`)
5. Process through standard pipeline (embed → extract entities → check triggers)

**Entry Points**:
- **Slack**: `!bookmark <url>` or `!bookmark <url> #tag1 #tag2` — captures the URL, replies with confirmation
- **Web UI**: URL input field on Dashboard Quick Capture (toggle between text/URL mode)
- **API**: `POST /api/v1/captures` with `source: 'bookmark'` and URL in `source_metadata.url`

**Acceptance Criteria**:
- URLs from major sites (news articles, blog posts, documentation) extract readable content
- Extracted content includes title and body text, not nav/footer/ad content
- Pages that fail Readability extraction fall back to stripped HTML text
- Non-HTML responses (PDF URLs, images) return clear error message
- Duplicate URL detection: same URL within 24 hours is deduplicated via content_hash
- Slack command responds with page title and excerpt within 10 seconds
- Captured URL content is searchable via semantic search

---

#### F27: Screenshot/Image Capture (Vision Model)

> **Status: DEFERRED** — Documented for future implementation. Requires vision model configuration on LiteLLM proxy and new pipeline pre-processing stage.

**Description**: Capture images (screenshots, whiteboard photos, diagrams) by extracting text and context via a vision-capable LLM. The extracted description becomes the capture content, processed through the standard pipeline. Entry points: Slack image attachment, web UI upload, API multipart endpoint.

**Tech**: Vision model via LiteLLM (e.g., `qwen-vl` or `gpt-4o`). New `vision` model alias in `ai-routing.yaml`. Image stored in filesystem or object storage; extracted text stored in `content` field.

**Deferred Design Decisions**:
- Vision model selection (depends on LiteLLM provider availability and cost)
- Image storage strategy (filesystem vs. base64 in `source_metadata` vs. dedicated `media` table)
- Maximum image size and supported formats
- Whether to embed extracted text or the image embedding (or both)

**Acceptance Criteria** (for future implementation):
- Images from Slack auto-detected and processed (similar to audio attachment flow)
- Vision model extracts meaningful text description from screenshots and photos
- Extracted content searchable via standard semantic search
- Web UI provides image upload interface
- Non-image files rejected with clear error

---

## 6. Information Architecture

### System Architecture (Docker Containers)

```
                    ┌─────────────────────────────────────────┐
                    │              Unraid Server               │
                    │          homeserver.k4jda.net             │
                    │                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │  Slack   │  │  Core    │  │ Workers  │                  │
│  │   Bot    │  │   API    │  │(scheduled│                  │
│  │ (@slack/ │  │  (Hono)  │  │  skills) │                  │
│  │  bolt)   │  │  + MCP   │  │          │                  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
│       └──────────────┼─────────────┘                        │
│                      │                                       │
│              ┌───────▼────────┐  ┌───────────┐              │
│              │     Redis      │  │  LiteLLM  │              │
│              │   (BullMQ)     │  │  (LLM     │              │
│              └───────┬────────┘  │  gateway)  │              │
│                      │           └─────┬─────┘              │
│              ┌───────▼────────┐        │                     │
│              │   Postgres     │        ├──► Anthropic API    │
│              │  (pgvector/    │        ├──► OpenAI API       │
│              │   pgvector:    │        ├──► OpenRouter       │
│              │   pg16)        │        └──► spark-qwen3-embedding-4b│
│              └────────────────┘                              │
│                                                              │
│              ┌───────────┐                                   │
│              │  faster-  │                                   │
│              │  whisper  │                                   │
│              └───────────┘                                   │
│                                                              │
│  ┌──────────┐                                               │
│  │  voice-  │                                               │
│  │ capture  │                                               │
│  └──────────┘                                               │
│                                                              │
│  ┌──────────┐  ┌──────────┐                                 │
│  │  Web UI  │  │ rclone   │  (both Phase 4)                 │
│  │(Vite+    │  │(doc sync)│                                 │
│  │ React)   │  └──────────┘                                 │
│  └──────────┘                                               │
└──────────────────────────────────────────────────────────────┘
```

### Docker Network Topology

Single Docker network:
- **`open-brain`** — All containers (Core API, Slack bot, Workers, Postgres, faster-whisper, Redis, voice-capture, Web UI). Simple DNS resolution between containers (`http://redis:6379`, `http://postgres:5432`). LiteLLM is external at `https://llm.k4jda.net` — not in this network.
- **Host port exposure**: Core API (port 3000, also serves MCP at `/mcp` via Cloudflare Tunnel), Slack bot (Socket Mode — no inbound port needed), and Web UI (Phase 4).

### Configuration File Structure

```
open-brain/
├── docker-compose.yml              # All containers
├── .env                            # Non-sensitive config + Bitwarden placeholders
├── config/
│   ├── pipelines.yaml              # Processing pipeline definitions
│   ├── skills.yaml                 # Output skill definitions + schedules
│   ├── ai-routing.yaml             # Embedding config + task-to-LiteLLM-alias mapping
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
├── packages/                       # pnpm workspaces monorepo
│   ├── shared/                     # DB client, types, utils, Drizzle schema
│   ├── core-api/                   # Hono API server + embedded MCP endpoint
│   ├── slack-bot/                  # @slack/bolt event handler + intent router
│   ├── workers/                    # Pipeline processing + scheduled skill execution
│   ├── voice-capture/              # Voice memo HTTP endpoint + transcription adapter
│   └── web/                        # Vite + React dashboard (Phase 4)
├── pnpm-workspace.yaml
├── package.json                    # Root workspace config
├── tsconfig.base.json              # Shared TypeScript config
└── docs/
    ├── PRD.md                      # This document
    ├── TDD.md                      # Technical Design Document
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
| Full pipeline processing (voice, direct API capture) | <90 seconds |
| Semantic search response (hybrid + temporal) | <5 seconds |
| Temporal scoring overhead | <5ms |
| Synthesis query response | <30 seconds |
| Weekly brief generation | <2 minutes |
| MCP tool response | <5 seconds |
| Web dashboard page load | <2 seconds |

### Reliability
- All containers configured with `restart: unless-stopped`
- Health checks on all containers
- Pipeline retries with patient exponential backoff (5 attempts per stage: 30s, 2m, 10m, 30m, 2h) + daily auto-retry sweep for failed stages
- Circuit breaker on external API calls (Anthropic, OpenAI)
- Monitoring: lean approach — Docker logs + Unraid dashboard + pipeline_events/skills_log tables + Pushover alerts for failures. No dedicated monitoring stack. Dockhand under consideration for future container management.
- Postgres data backed up via daily pg_dump to Unraid share (7-day local retention) + weekly offsite to cloud storage via rclone (30-day cloud retention)

### Security
- No authentication layer (single user, network-level security)
- Access restricted to LAN + Tailscale
- MCP endpoint has API key authentication (for external access via Cloudflare Tunnel)
- All API keys stored in Bitwarden Secrets Manager, loaded at startup via `bws` CLI → `.env.secrets` (gitignored, chmod 600)
- No secrets in Docker Compose or config files

### Data Integrity
- Captures are soft-deletable via API (`DELETE /api/v1/captures/:id`). No hard delete. Recovery via direct SQL.
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
| Voice capture latency | <2 min | Time from Apple Watch recording to Pushover confirmation (direct API, no sync delay) |
| MCP tool usage | Growing | Number of MCP queries from Claude/ChatGPT per week |

---

## 9. Release Planning

### Build Philosophy
Smaller build/test cycles with explicit test gates at each sub-phase. Each sub-phase is independently testable and deployable. No sub-phase should take more than a focused sprint. The system grows layer by layer — confidence builds with each gate passed.

### Phase 1A: Data Layer
**Goal**: CRUD works. Captures go into Postgres and come back out.

| Feature | Description |
|---------|-------------|
| F02 | Postgres 16 + pgvector on Unraid (tuned postgresql.conf) |
| F01 (partial) | Core API scaffold — Hono, health endpoint, Zod validation |
| F01 (partial) | Capture CRUD: POST/GET/LIST/PATCH captures (no pipeline, no embedding) |
| F01 (partial) | Stats endpoint (basic counts) |

**Test Gate**:
- Insert a capture via curl, read it back, list with filters
- PATCH a capture's tags and brain_views, verify update persists
- Health endpoint reports Postgres status
- Vitest unit + Testcontainers integration tests pass
- Captures stay at `pipeline_status: 'received'` (no pipeline yet)

### Phase 1B: Embedding + Search
**Goal**: Search works. Embedding model validated with real data.

| Feature | Description |
|---------|-------------|
| F07 | EmbeddingService via LiteLLM (spark-qwen3-embedding-4b alias → Qwen3-Embedding-4B (via LiteLLM, Matryoshka-truncated to 768d)) |
| F01 (partial) | Search endpoint: POST /api/v1/search (all three modes: hybrid, vector, fts) |
| — | match_captures + match_captures_hybrid SQL functions deployed |
| — | FTS GIN index on captures.content |
| — | update_access_stats background job |

**Test Gate**:
- Insert 20-30 test captures with known content via Phase 1A API
- Generate embeddings via EmbeddingService (calls LiteLLM spark-qwen3-embedding-4b alias)
- Vector search returns relevant results (similarity > 0.7 for known matches)
- Hybrid search improves recall on paraphrased queries vs. vector-only
- FTS catches exact keyword matches that vector misses
- Actual CPU embedding throughput measured and documented (update TDD Section 4.5 estimates)
- Compare embedding model candidates with real capture data → **select embedding model**

**Key Decision Point**: Embedding model selection happens here, before pipeline automation. Benchmark with real captures, not synthetic data.

### Phase 1C: Pipeline + LLM Gateway
**Goal**: Captures auto-process. LiteLLM routes LLM calls correctly.

| Feature | Description |
|---------|-------------|
| F03 | Pipeline — BullMQ + Redis, stage executor, retry logic |
| F07a | LiteLLM proxy with model aliases and budget tracking |
| F08 | AI Router (thin LiteLLM wrapper — embeddings + LLM all through external LiteLLM) |
| — | Pipeline stages: embed → extract_metadata → notify (stub) |
| — | Bull Board at /admin/queues |

**Test Gate**:
- Insert capture via API → automatically embedded, metadata extracted, pipeline_status = 'complete'
- pipeline_events shows all stages with timing
- Simulate LiteLLM unavailability → capture queues, retries on recovery
- LiteLLM routes "fast" alias to local LLM (TBD), "synthesis" to Claude
- Bull Board shows job history and queue health
- Budget tracking shows cost for LLM calls

### Phase 1D: Slack Bot
**Goal**: Capture and query via Slack. First "it feels like a product" moment.

| Feature | Description |
|---------|-------------|
| F04 | Slack bot — text capture via @slack/bolt Socket Mode |
| F05 | Slack bot — hybrid search query (? prefix) |
| — | Intent router: prefix-only first (?, !, default=capture), LLM classification added after |
| — | Thread context in Redis (1-hour TTL, follow-up interactions) |

**Test Gate**:
- Type in #open-brain → thread reply confirms capture with extracted metadata
- `? QSR pricing` returns ranked search results with match percentages
- Reply with number → full capture detail
- Send same message twice → second is deduped (slack_ts)
- Bot ignores its own messages

### Phase 1E: MCP + External Access
**Goal**: AI tools can query the brain. External access works.

| Feature | Description |
|---------|-------------|
| F06 | MCP endpoint embedded at /mcp — all 7 tools |
| — | API key authentication (Authorization header) |
| — | Cloudflare Tunnel routing brain.k4jda.net |

**Test Gate**:
- Connect Claude Desktop to brain.k4jda.net/mcp
- search_brain returns real captures
- capture_thought creates a capture that goes through pipeline
- Invalid API key → 401 Unauthorized
- All 7 MCP tools functional

**Phase 1 Complete**: The capture → search loop works end-to-end via Slack and MCP. This is the minimum viable brain.

---

### Phase 2A: Voice Pipeline
**Goal**: Voice memos flow from Apple Watch to the brain.

| Feature | Description |
|---------|-------------|
| F10 | faster-whisper container (large-v3, CPU int8) |
| F09 | voice-capture integration (monorepo migration, Core API ingest) |

**Test Gate**:
- Record on Apple Watch → transcript appears as capture with correct metadata
- Different audio lengths and formats (.m4a, .wav, .mp3) transcribe correctly
- voice-capture retry logic handles Core API downtime gracefully
- Pushover confirmation on successful voice capture

### Phase 2B: Notifications + Output Skills
**Goal**: System proactively delivers value. First automated output.

| Feature | Description |
|---------|-------------|
| F13 | Pushover notifications (all priority levels) |
| F14 | Email delivery (HTML reports via SMTP) |
| F12 | Weekly brief output skill (scheduled Sunday 8pm) |
| F11 | Slack commands (/ob stats, /ob brief, /ob recent, etc.) |

**Test Gate**:
- Trigger weekly brief manually → email arrives, Pushover fires, brief captured back into brain
- `/ob stats` returns formatted brain statistics in Slack
- `/ob brief last` shows most recent brief
- Pushover priorities respected (low for captures, high for failures)

**Prerequisite**: At least 2 weeks of real captures before the weekly brief is meaningful.

### Phase 2C: Semantic Triggers
**Goal**: Proactive memory surfacing — the brain alerts you without being asked.

| Feature | Description |
|---------|-------------|
| F28 | Triggers table, CRUD API, check_triggers BullMQ job |
| — | Slack trigger commands (/ob trigger add/list/delete/test) |
| — | Pushover/Slack notification delivery on trigger match |

**Test Gate**:
- Create trigger via `/ob trigger add "QSR timeline"`
- Ingest matching capture → notification fires within pipeline window
- Cooldown prevents duplicate notifications (default 60 min)
- `/ob trigger test "QSR timeline"` shows top 5 matches without firing
- ≤20 active triggers, in-memory comparison completes in <10ms

**Phase 2 Complete**: Voice capture works, weekly briefs generate, semantic triggers surface relevant memories proactively.

---

### Phase 3: Intelligence
**Goal**: Entity graph, governance sessions, pattern detection.

| Feature | Description | Status |
|---------|-------------|--------|
| F15 | Entity graph (auto-extraction + linking) | Implemented |
| F16 | Slack interactive sessions (LLM-driven governance) | Implemented |
| F17 | Board governance skills (quick check, quarterly) | Implemented |
| F18 | Bet tracking | Implemented |
| F20 | Slack voice clip handling | Implemented |
| F21 | Daily connection finder | Moved to Phase 5A |
| F22 | Drift monitor | Moved to Phase 5A |

**Definition of Done**: Entities auto-created and linked. Board quick check runs in Slack. F21/F22 moved to Phase 5A.

### Phase 4: Polish
**Goal**: Web UI, document ingestion, additional input sources.

| Feature | Description | Status |
|---------|-------------|--------|
| F19 | Web dashboard (Vite + React PWA) | Implemented |
| F23 | Document ingestion (PDF, docx) | Implemented |
| F24 | URL/bookmark capture | Moved to Phase 5B |
| F25 | Calendar integration | **DEFERRED** — test stubs only, no service implementation |

**Deferred Design Decision — Document Chunking**:
The current embedding model generates a single 768-dim vector per capture. This works well for
short-form content (voice memos, Slack messages, <2K characters). For Phase 4 document ingestion
(PDF, docx), long documents will need a chunking strategy — a single embedding cannot represent
a 20-page document effectively. Options to evaluate before Phase 4: fixed-size overlapping chunks,
semantic paragraph splitting, or hierarchical embeddings. This decision is deferred until Phase 4
planning, but the `captures` schema can represent chunks natively (each chunk = one capture, linked
via `source_metadata.parent_document_id`).

**Definition of Done**: Full web dashboard for browsing, searching, and viewing outputs. PWA installable on iPhone.

### Phase 5A: Intelligence Skills
**Goal**: Proactive intelligence — daily pattern detection and drift monitoring.

| Feature | Description | Status |
|---------|-------------|--------|
| F21 | Daily connection/pattern detection skill | Planned |
| F22 | Drift monitor skill | Planned |

**Test Gate**:
- Daily connections skill runs on schedule and surfaces non-obvious cross-domain patterns
- Drift monitor flags pending bets with no recent activity
- Both skills deliver via Pushover and save output as searchable captures
- Manual trigger via Slack (`!connections`, `!drift`) and API works
- Skills log shows structured results with duration tracking

### Phase 5B: URL Capture
**Goal**: Capture web content by URL from Slack, web UI, and API.

| Feature | Description | Status |
|---------|-------------|--------|
| F24 | URL/bookmark capture (Readability extraction) | Planned |

**Test Gate**:
- `!bookmark <url>` in Slack extracts page content and creates capture
- Web UI URL input on Dashboard creates capture
- Extracted content is searchable via semantic search
- Duplicate URLs within 24 hours are deduplicated
- Non-extractable pages fall back to stripped HTML text

**Phase 5 Complete**: Brain proactively surfaces patterns and drift. Web content capturable by URL.

---

### Future: Image Capture (Deferred)

| Feature | Description | Status |
|---------|-------------|--------|
| F27 | Screenshot/image capture (vision model) | **DEFERRED** — requires vision model on LiteLLM |

### 9.1 Cold Start Plan

The system has features that require accumulated data before they become useful. Plan for this:

| Feature | Minimum Data Needed | When Useful |
|---------|-------------------|-------------|
| Semantic search | 20+ captures | Phase 1B test gate |
| Temporal scoring | 100+ searches | ~2 weeks after Phase 1D |
| Weekly brief | 1 week of captures | Phase 2B, after 2 weeks of real use |
| Drift detection | 2+ weeks of captures + entities + pending bets | Phase 5A |
| Daily connections | 50+ captures across multiple brain views | Phase 5A |
| Entity graph | 50+ captures mentioning people/projects | Phase 3 |
| Semantic triggers | Active captures flowing in | Phase 2C |

**Temporal weight ramp-up schedule** (config change, no code change):
1. Phase 1A–1C: `temporal_weight: 0.0` (no search history exists)
2. After 100 searches (~2 weeks of Phase 1D use): bump to `0.1`
3. After 500 searches (~2 months): bump to `0.2`
4. After 1000 searches: evaluate whether `0.3` improves results, adjust based on experience

**Phase 1B seed data**: Before declaring Phase 1B complete, manually enter 50+ real captures (past voice memos, Slack thoughts, decisions) to validate search quality. Don't test search with 5 captures — it tells you nothing.

---

## 10. Dependencies and Constraints

### Technical Dependencies
| Dependency | Required For | Risk |
|------------|-------------|------|
| Unraid server with Docker | Everything | Low — already operational |
| Tailscale | Remote access to all services | Low — already in use |
| Slack free workspace (K4JDA) | Capture + query interface | Low — already created |
| External LiteLLM (llm.k4jda.net) | Embeddings (spark-qwen3-embedding-4b) + all LLM inference | Low — already running, shared service |
| LiteLLM Docker image | Unified LLM proxy for all providers | Low — actively maintained, wide adoption |
| faster-whisper Docker image | Local transcription | Low — multiple maintained images |
| Postgres 16 + pgvector Docker image | Database + vector search | Low — standard Docker image (pgvector/pgvector:pg16) |
| Redis | Job queues | Low — standard Docker image |
| Anthropic API | Synthesis, governance (cloud fallback) | Low — stable, existing account |
| OpenAI API | Fallback transcription, fallback embeddings | Low — stable, existing account |
| Pushover | iPhone notifications | Low — existing account |
| rclone | Document sync from cloud drives (Phase 4) | Low — existing and working |
| Apple Watch + Just Press Record | Voice capture origin | Low — existing workflow |

### Assumptions
- Unraid server: Intel Core i7-9700 (8C/8T, 3.0GHz/4.7GHz turbo), 128GB DDR4 RAM, no dedicated GPU, 32TB array (~26TB free). Memory limits on heavy containers: faster-whisper 8GB, Postgres 8GB. Lightweight containers unconstrained. Total estimated footprint ~10-12GB (no Ollama — embeddings and LLM via external LiteLLM).
- Tailscale is configured and the server is accessible remotely
- Bitwarden Secrets Manager is accessible for API key retrieval
- The user's daily capture volume will be <50 captures/day (affects pipeline queue sizing and LiteLLM embedding load)

### Constraints
- Slack free plan: 90-day message history (not a problem — data lives in Postgres)
- Slack free plan: 10 app integrations (only need 1)
- LiteLLM embedding throughput for burst ingestion is handled gracefully by the BullMQ queue
- No multi-user support — single user by design, simplifies everything

---

## 11. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Postgres + pgvector setup | Low | Medium | Standard Docker image (pgvector/pgvector:pg16), Drizzle Studio for dev browsing, well-documented |
| Embedding model selection suboptimal | Low | Medium | Schema uses vector(768) compatible with multiple models (nomic-embed-text native, Qwen3-Embedding Matryoshka-truncated). Re-embedding script available. Benchmark with real captures before committing. |
| LiteLLM proxy as single point for LLM routing | Low | Medium | Simple container, auto-restart. Can bypass and call providers directly if needed. |
| Unraid resource constraints (many containers) | Medium | Medium | Monitor with Unraid dashboard; phase rollout to spread load |
| Slack free plan limitations change | Low | Medium | Core system doesn't depend on Slack — just one input adapter |
| Pipeline stage failure cascades | Low | Medium | Circuit breakers, independent stages, retry logic |
| Embedding model dimension mismatch | ~~Medium~~ Resolved | ~~High~~ | Schema uses vector(768). Model must produce 768d (native or Matryoshka-truncated). No fallback to different-dimension models. |
| voice-capture integration breaks existing workflow | Medium | Medium | Hard cutover with Notion backfill script as safety net |
| Data loss on Unraid | Low | Critical | Regular Postgres backups to offsite storage |

---

## 12. Resolved Questions

All open questions from the initial draft have been resolved. Decisions are captured inline throughout this document and in the answers file.

| # | Question | Decision |
|---|----------|----------|
| 1 | Unraid hardware specs | Intel i7-9700, 128GB DDR4, no GPU, 32TB array (~26TB free) |
| 2 | Embedding model | vector(768) schema. Model configurable — evaluating nomic-embed-text (768d native, 8K context) vs Qwen3-Embedding:8b (Matryoshka to 768d, 32K context, MTEB #1). No fallback. |
| 3 | External access method | Hybrid: existing Tailscale + SWAG unchanged, Cloudflare Tunnel (free) added for brain.k4jda.net only |
| 4 | Email delivery | SMTP via existing personal email account |
| 5 | Slack voice clip routing | Route through voice-capture container (single audio path) |
| 6 | Backup strategy | Daily pg_dump to Unraid share (7-day local) + weekly offsite to cloud storage via rclone (30-day) |
| 7 | Notion parallel migration | No — hard cutover. One-time Notion backfill script as safety net. |
| 8 | Web UI framework | Vite + React (lightweight SPA) with Tailwind + shadcn/ui + vite-plugin-pwa |
| 9 | Slack command interface | Both: prefix commands as baseline (Socket Mode), slash commands as enhancement once Cloudflare Tunnel is stable |

**Additional decisions resolved (beyond original 9):**

| Topic | Decision |
|-------|----------|
| Brain views | 5 views: career, personal, technical, work-internal, client. Hybrid auto-classification + manual override. |
| Intent router fallback | Prefix-only: `?` = query, `!` = command, `@Open Brain` = query, no prefix = capture |
| Prompt templates | Phase 1: extract_metadata + intent_router. Others deferred. Versioned, hot-reloadable. |
| Governance sessions | LLM-driven conversation with guardrails (max turns, required topics checklist, 30-min idle auto-pause). Not FSM. |
| Board role personalities | Defer to Phase 3, designed alongside conversational flow. |
| Monitoring | Lean: Docker logs + Unraid dashboard + pipeline_events + Pushover alerts. No Prometheus/Grafana. |
| Schema migrations | Drizzle ORM + drizzle-kit. TypeScript-native, schema-as-code. |
| AI cost management | Monthly budget: soft $30 (Pushover alert), hard $50 (circuit breaker → local only). |
| Synthesis endpoint | Top-20 captures, 50K token budget. Skills handle own context assembly. |
| Container resources | Memory limits on faster-whisper (8GB), Postgres (8GB) only. No Ollama container — embeddings via external LiteLLM. |
| Capture types | 8 types: decision, idea, observation, task, win, blocker, question, reflection. Extensible via prompt. |
| Config reloading | ConfigService: in-memory cache, explicit reload via `/api/v1/admin/config/reload`, workers re-read per job. |
| Thread context | Redis with 1-hour TTL, keyed by thread_ts. |
| Session persistence | Postgres + transcript replay on resume. 30-day max pause. |
| Deduplication | Source-level only: slack_ts, filename, content hash + 60s window. No cross-source. |
| Docker networking | Single `open-brain` network. All containers including Postgres. |
| Embedding consistency | No fallback. Queue and retry if LiteLLM unreachable. Model: Qwen3-Embedding-4B (Matryoshka-truncated to 768d) via spark-qwen3-embedding-4b alias. |
| LLM routing | LiteLLM proxy. Budget via LiteLLM. App logs task-level audit (not cost) to ai_audit_log table. |
| Search strategy | Hybrid retrieval (FTS + vector with RRF) + ACT-R temporal decay. Default temporal_weight: 0.0 at launch (cold start), ramp up as search history builds. |
| Semantic triggers | Persistent semantic patterns. Separate BullMQ job (not inline pipeline stage). Max 20 triggers, in-memory comparison. Phase 2C. |
| MCP architecture | Embedded in Core API at `/mcp` route. Streamable HTTP transport. No separate container. |
| Voice capture flow | Direct API from iPhone/Apple Watch via iOS Shortcut. No Google Drive sync, no rclone for voice. |
| Monorepo structure | pnpm workspaces: packages/shared, core-api, slack-bot, workers, voice-capture, web. |
| Build tooling | tsx for dev (hot reload), tsup (esbuild) for production (single .mjs per service, ESM). |
| Slack SDK | @slack/bolt with socketMode: true. |
| Entity resolution | Three-tier matching: exact name → alias → LLM disambiguation. |
| Content dedup | SHA-256 of normalized content, content_hash char(64) indexed column, 60-second window. |
| Token counting | chars/4 approximation with 10% safety margin. No tokenizer dependency. |
| Prompt template format | {{variable}} placeholders, ---SYSTEM---/---USER--- delimiters, regex replacement. |
| Brain view classification | LLM in extract_metadata prompt. No keyword rules. |
| BullMQ dashboard | @bull-board/hono embedded at /admin/queues in Core API. |
| Postgres tuning | Custom postgresql.conf: shared_buffers=2GB, effective_cache_size=6GB, work_mem=64MB. |
| Secret loading | Host-level bws CLI → .env.secrets (gitignored, chmod 600), Docker Compose env_file. |
| Real-time updates | SSE from Core API at /api/v1/events + Postgres LISTEN/NOTIFY. No Supabase Realtime. |
| Pipeline error recovery | 5 retries (30s, 2m, 10m, 30m, 2h) + daily auto-retry sweep. |
| Capture timestamps | `captured_at` optional in API. Adapters pass original timestamp. |
| board-journal migration | Conceptual reference doc only — principles, not code. Clean-room implementation. |
| Database | Plain Postgres 16 + pgvector (pgvector/pgvector:pg16). No Supabase. Drizzle Studio for dev. SSE for real-time. |
| Capture updates | PATCH /api/v1/captures/:id for tags, brain_views, metadata_overrides. Slack reactions trigger brain_view updates. No re-embedding. |
| Phase structure | 10 sub-phases (1A-1E, 2A-2C, 3, 4) with explicit test gates per sub-phase. Smaller build/test cycles for robustness. |
| MCP authentication | Authorization: Bearer header (not URL query parameter). Logged but not exposed in access logs. |
| Cold start plan | temporal_weight starts at 0.0, ramped up after search history builds. 50+ seed captures for Phase 1B validation. |

---

## 13. Glossary

| Term | Definition |
|------|-----------|
| **Capture** | Any piece of information ingested into the brain — a voice memo transcript, Slack message, document summary, bookmark, etc. |
| **Brain** | The entire Postgres database containing all captures, entities, and metadata |
| **Brain View** | A tag-based filter that groups captures into logical collections (career, consulting, personal) with optional distinct pipeline processing |
| **Pipeline** | The async processing chain that transforms a raw capture into an embedded, classified, entity-linked record |
| **Stage** | A single step in a pipeline (embed, extract_metadata, link_entities, etc.) |
| **Output Skill** | A scheduled or triggered process that queries the brain, performs AI synthesis, and delivers results (weekly brief, board session, drift alert) |
| **Entity** | A known person, project, decision, bet, or concept that appears across multiple captures |
| **Intent Router** | The component in the Slack bot that determines whether an incoming message is a capture, query, command, or conversation |
| **AI Router** | Thin application-layer service that maps task types to LiteLLM model aliases — all AI (embeddings + LLM) routes through external LiteLLM |
| **LiteLLM** | External shared proxy at llm.k4jda.net providing unified OpenAI-compatible API for all AI requests — embeddings (spark-qwen3-embedding-4b) and LLM inference |
| **Semantic Trigger** | A persistent semantic pattern that fires a notification when a new capture's embedding matches it above a threshold |
| **Hybrid Search** | Search strategy combining full-text search (Postgres tsvector) and vector similarity (pgvector) via Reciprocal Rank Fusion (RRF) |
| **Temporal Decay (ACT-R)** | Cognitive model that boosts search ranking for captures that are accessed recently and frequently |
| **Governance Session** | A structured, multi-turn LLM-driven conversation for career governance — inherited from board-journal principles (not FSM) |
| **Bet** | A 90-day falsifiable prediction made during a governance session |
| **MCP** | Model Context Protocol — open standard for AI tools to interact with external data sources |

---

## 14. Change Log

| Date | Version | Changes |
|------|---------|---------|
| 2026-03-04 | 0.1 | Initial draft based on conceptual discussion |
| 2026-03-04 | 0.2 | All 30 open questions resolved via interactive Q&A session. Key decisions: nomic-embed-text (768d) embeddings, Cloudflare Tunnel for brain.k4jda.net, Vite + React for web UI, Drizzle ORM for migrations, 5 brain views, Slack-native governance redesign, no embedding fallback, patient retry strategy with daily auto-sweep. |
| 2026-03-04 | 0.3 | Aligned with TDD v0.2 decisions: Removed Supabase (plain Postgres+pgvector), embedded MCP in Core API (Streamable HTTP), direct voice capture via iOS Shortcut (no Google Drive/rclone for voice), pnpm monorepo, @slack/bolt, LLM-driven governance (not FSM), single Docker network, ConfigService, content_hash dedup, SSE for real-time, bws secret loading. |
| 2026-03-05 | 0.4 | Added LiteLLM as unified LLM gateway (replaces custom AI router logic). Made embedding model configurable (evaluating Qwen3-Embedding alongside nomic-embed-text). Added cognitive retrieval: ACT-R temporal decay scoring, hybrid search with Reciprocal Rank Fusion (FTS + vector), semantic push triggers (F28). Based on analysis of MuninnDB cognitive retrieval architecture. |
| 2026-03-05 | 0.5 | Architectural review applied. Restructured into 10 sub-phases (1A-1E, 2A-2C, 3, 4) with explicit test gates. Added cold start plan and temporal weight ramp-up schedule. Added PATCH /api/v1/captures/:id for capture updates. Fixed check_triggers as separate BullMQ job (not inline pipeline stage). Moved MCP API key from URL to Authorization header. Clarified voice-capture migration scope. Default temporal_weight to 0.0 at launch. Added search pagination. |
| 2026-03-11 | 0.7 | Added Phase 5: F21 (daily connections), F22 (drift monitor), F24 (URL/bookmark capture) with full specs. F27 (image capture) documented but deferred. Updated feature overview table, release planning, dependency graph, cold start plan. |
| 2026-03-05 | 0.6 | Architectural review v2: Fixed composite score formula (multiplicative boost), extracted pipeline_log to pipeline_events table, extracted session transcript to session_messages table, removed linked_entities denormalization from captures, added DELETE captures endpoint, fixed temporal_weight default (0.0), changed BrainView type to config-driven string, clarified ai_audit_log purpose (dropped cost_estimate), added document chunking deferred decision, added entity resolution confidence threshold (0.8), added MCP key rotation runbook, added config validation (Zod), added scheduled skill retry policy, specified thread expiration UX, added migration-at-startup entrypoint, documented Ollama CPU benchmark requirement. |

---

## Document Resolution Log

*This document was completed on 2026-03-04 using `/finish-document`.*

**Questions Resolved:** 30 of 30
**Reference Files:**
- Questions: `reference/questions-PRD-20260304-120000.json`
- Answers: `reference/answers-PRD-20260304-160000.json`
- Original backup: `PRD.backup-20260304-160000.md`
