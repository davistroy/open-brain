# Open Brain — Technical Design Document

| Document Information |                                    |
|---------------------|-------------------------------------|
| Version             | 0.5                                 |
| Status              | Draft — Architectural Review v2 Applied |
| Author              | Troy Davis / Claude                 |
| Last Updated        | 2026-03-05                          |

## Document History
| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-03-04 | Troy Davis / Claude | Initial TDD based on PRD v0.2 |
| 0.2 | 2026-03-04 | Troy Davis / Claude | All 32 open questions resolved via /ask-questions session |
| 0.3 | 2026-03-05 | Troy Davis / Claude | LiteLLM gateway, flexible embeddings, cognitive retrieval (ACT-R, RRF, triggers) |
| 0.4 | 2026-03-05 | Troy Davis / Claude | Architectural review: 10 sub-phases with test gates, fix Zod brain_views, Authorization header for MCP, check_triggers as separate job, standardized temporal scoring, UNIQUE constraints, cold start plan, operational runbook |
| 0.5 | 2026-03-05 | Troy Davis / Claude | Architectural review v2: Fixed composite score formula (multiplicative boost), extracted pipeline_log to pipeline_events table, extracted session transcript to session_messages table, removed linked_entities denormalization from captures, added DELETE captures endpoint, fixed temporal_weight default (0.0), changed BrainView type to config-driven string, clarified ai_audit_log purpose (dropped cost_estimate), added entity resolution confidence threshold (0.8), added MCP key rotation runbook, config Zod validation, scheduled skill retry policy, thread expiration UX, migration-at-startup entrypoint, Ollama CPU benchmark requirement, content_hash window configurability note, MCP in-progress capture visibility note. |

## Related Documents
| Document | Link | Relevance |
|----------|------|-----------|
| PRD | [PRD.md](PRD.md) | Product requirements v0.6, all architectural decisions |
| PRD Answers | [reference/answers-PRD-20260304-160000.json](reference/answers-PRD-20260304-160000.json) | PRD decision rationale |
| PRD Questions | [reference/questions-PRD-20260304-120000.json](reference/questions-PRD-20260304-120000.json) | PRD questions extracted |
| TDD Answers | [reference/answers-TDD-20260304-214500.json](reference/answers-TDD-20260304-214500.json) | TDD decision rationale (32 questions) |
| TDD Questions | [reference/questions-TDD-20260304-202900.json](reference/questions-TDD-20260304-202900.json) | TDD questions extracted |

---

## 1. Technical Overview

### 1.1 Purpose

This TDD provides implementation-ready technical specifications for Open Brain — a self-hosted personal AI knowledge infrastructure. It covers the complete system: API contracts, database schema (Drizzle ORM), async pipeline architecture, AI routing, Slack bot, MCP server, Docker Compose orchestration, and all supporting services.

The system runs entirely on an Unraid home server, ingests captures from Slack and voice memos, embeds them for semantic search via the external LiteLLM proxy (jetson-embeddings alias → Qwen3-Embedding-4B-Q4_K_M on Jetson), routes all LLM inference through the same external LiteLLM proxy at llm.k4jda.net, and surfaces insights through AI-powered skills (weekly briefs, governance sessions, drift detection). Search uses hybrid retrieval (full-text + vector with Reciprocal Rank Fusion) combined with ACT-R temporal decay scoring.

### 1.2 Scope

**In Scope (this document)**:
- Phase 1 (Foundation/MVP): Core API, Postgres+pgvector, Pipeline, Slack capture/query, MCP (embedded in Core API), AI router (via external LiteLLM)
- Phase 2 (Voice + Outputs): faster-whisper, voice-capture integration, weekly brief skill, notifications, email
- Phase 3 (Intelligence): Entity graph, governance sessions, bet tracking, drift detection
- Phase 4 (Polish): Web dashboard (Vite + React PWA), document ingestion, bookmarks, calendar

**Out of Scope**:
- Multi-user support, authentication system
- Mobile native apps
- Notion output skill (deferred to "Future")
- Screenshot/image capture via vision models

### 1.3 Technical Approach Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | Type-safe across all services, single runtime |
| API Framework | Hono | Lightweight, fast, excellent TypeScript support |
| ORM | Drizzle | Schema-as-code, type-safe queries, drizzle-kit for migrations |
| Database | Postgres 16 + pgvector | Proven, pgvector for semantic search, pgvector/pgvector:pg16 image |
| Package Manager | pnpm | Strict dependency isolation, disk-efficient, native workspace support |
| Monorepo | pnpm workspaces | Single repo: shared, core-api, slack-bot, workers, voice-capture |
| Dev Runtime | tsx | Run TypeScript directly with hot reload (tsx watch) |
| Production Build | tsup (esbuild) | Zero-config bundler, single .mjs per service, ESM output |
| Queue | BullMQ + Redis | Mature Node.js job queue, retries, priorities, dashboards |
| LLM Proxy | LiteLLM | Unified OpenAI-compatible API for all LLM providers, with fallback and budget |
| Embeddings | Qwen3-Embedding-4B-Q4_K_M via `jetson-embeddings` alias on LiteLLM | Runs on Jetson device, routed through llm.k4jda.net. OpenAI embeddings API. No fallback — queue and retry. Schema: vector(768) |
| Search | Hybrid (FTS + vector + RRF) + ACT-R temporal decay | Best-of-both retrieval with recency/frequency-weighted ranking |
| Transcription | faster-whisper (large-v3, CPU int8) | Local, accurate, no API cost |
| Web UI | Vite + React + Tailwind + shadcn/ui | Lightweight SPA, no SSR needed |
| Container orchestration | Docker Compose on Unraid | Simple, fits single-server deployment |
| External access | Cloudflare Tunnel (free) for brain.k4jda.net | Existing Tailscale/SWAG unchanged |

### 1.4 Phased Implementation

```
Phase 1A: Data Layer
  F02 Postgres+pgvector → F01 Core API scaffold (CRUD, health, stats)

Phase 1B: Embedding + Search
  F07 EmbeddingService (via LiteLLM jetson-embeddings) → Search endpoints (hybrid + temporal)

Phase 1C: Pipeline + LLM Gateway
  F07a LiteLLM → F08 AI Router → F03 Pipeline (embed + extract_metadata + notify)

Phase 1D: Slack Bot
  F04 Slack Capture → F05 Slack Query (intent router, thread context)

Phase 1E: MCP + External Access
  F06 MCP (embedded in Core API) → Cloudflare Tunnel

Phase 2A: Voice Pipeline
  F10 faster-whisper → F09 voice-capture integration

Phase 2B: Notifications + Output Skills
  F12 Weekly Brief → F13 Pushover → F14 Email → F11 Slack Commands

Phase 2C: Semantic Triggers
  F28 Triggers (check_triggers job + Slack commands)

Phase 3: Intelligence
  F15 Entity Graph → F16 Slack Sessions → F17 Governance Skills
  → F18 Bet Tracking → F20 Slack Voice → F21 Daily Connections → F22 Drift Monitor

Phase 4: Polish
  F19 Web Dashboard → F23 Document Ingestion → F24 Bookmarks → F25 Calendar
```

---

## 2. System Dependencies and Prerequisites

### 2.1 Infrastructure Dependencies

| Dependency | Version | Purpose | Required/Optional |
|------------|---------|---------|-------------------|
| Unraid OS | 6.x | Host OS, Docker management | Required |
| Docker Engine | 24+ | Container runtime | Required |
| Docker Compose | v2+ | Multi-container orchestration | Required |
| Postgres | 16 | Primary database | Required |
| pgvector | 0.7+ | Vector similarity search | Required |
| Redis | 7+ | Job queues (BullMQ), thread context cache | Required |
| Node.js | 22 LTS | Runtime for all TypeScript services | Required |
| LiteLLM | latest | Unified LLM proxy with routing, fallback, budget | Required |
| LiteLLM (external) | latest | Embeddings (jetson-embeddings) + all LLM inference — external shared service at llm.k4jda.net | Required |
| faster-whisper | latest | Local speech-to-text | Required (Phase 2) |
| Cloudflare Tunnel | latest | External access for brain.k4jda.net | Required (for MCP/slash commands) |
| Tailscale | existing | Remote access to Unraid services | Required (existing) |

### 2.2 External Service Dependencies

| Service | Purpose | SLA | Fallback Strategy |
|---------|---------|-----|-------------------|
| Anthropic API | Synthesis, governance (via LiteLLM) | 99.5% | OpenAI GPT-4o fallback (configured in LiteLLM) |
| OpenAI API | Fallback for synthesis (via LiteLLM) | 99.5% | Queue and retry |
| Slack API | Capture and query interface | 99.9% | Captures queue locally; retry on reconnect |
| Pushover API | iPhone push notifications | 99%+ | Log notification, deliver on recovery |
| Google Drive / OneDrive / iCloud | Document sync via rclone (Phase 4) | 99.9% | Local cache, retry sync |
| SMTP (personal email) | HTML email delivery | N/A | Queue and retry |
| Bitwarden Secrets Manager | API key retrieval at startup | N/A | Fail fast — secrets required for boot |

### 2.3 Target Hardware

| Spec | Value |
|------|-------|
| CPU | Intel Core i7-9700 (8C/8T, 3.0GHz base / 4.7GHz turbo) |
| RAM | 128GB DDR4 |
| GPU | None (CPU-only inference) |
| Storage | 32TB Unraid array (~26TB free) |
| OS | Unraid |
| Network | Gigabit LAN, Tailscale overlay |

**Container Memory Allocations**:

| Container | Memory Limit | Notes |
|-----------|-------------|-------|
| faster-whisper | 8GB | large-v3 model, CPU int8 |
| Postgres | 8GB | shared_buffers, work_mem |
| All others | Unconstrained | Lightweight, typically <512MB each |
| **Estimated total** | **~10-12GB** | Well within 128GB. Ollama not needed — embeddings and inference via external LiteLLM. |

---

## 3. API Specifications

### 3.1 API Overview

```
Base URL: http://open-brain-api:3000 (internal)
           https://brain.k4jda.net/api (external via Cloudflare Tunnel)
Authentication: None (single-user, network-secured)
Content-Type: application/json
Versioning: URL path prefix /api/v1
```

### 3.2 Endpoint Specifications

---

#### POST /api/v1/captures

**Description**: Ingest a new capture into the brain. Returns immediately after persisting the record and enqueuing pipeline processing.

**Rate Limiting**: None (single user)

**Request Body**:
```json
{
  "content": "Decision: going with T&M plus $180k cap for QSR. Tom agreed.",
  "source": "slack",
  "source_metadata": {
    "slack_ts": "1709312456.123456",
    "channel": "C0123OPEN",
    "user": "U0123TROY"
  },
  "pre_extracted": {
    "template": "decision",
    "confidence": 0.92,
    "fields": { "priority": "high" },
    "transcript_raw": "..."
  },
  "tags": ["career", "qsr"],
  "brain_views": ["career", "client"],
  "captured_at": "2026-03-04T14:30:00Z"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| content | string | Yes | — | Processed text content |
| source | string | Yes | — | One of: `slack`, `voice`, `web`, `api`, `email`, `document` |
| source_metadata | object | No | `{}` | Source-specific metadata (slack_ts, device, filename, etc.) |
| pre_extracted | object | No | `{}` | Classification from input adapter |
| tags | string[] | No | `[]` | User or auto-assigned tags |
| brain_views | string[] | No | `[]` | Brain view assignments |
| captured_at | string (ISO 8601) | No | `now()` | When the thought originally occurred |

**Response (201 Created)**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "received",
  "pipeline": "default",
  "message": "Capture received, pipeline processing started"
}
```

**Error Responses**:

| Status | Code | Description |
|--------|------|-------------|
| 400 | VALIDATION_ERROR | Missing required fields or invalid source |
| 409 | DUPLICATE_CAPTURE | Duplicate detected (slack_ts, filename, or content hash within 60s) |
| 503 | SERVICE_UNAVAILABLE | Database or Redis unreachable |

**Deduplication Logic**:
- Slack: reject if `source_metadata.slack_ts` already exists
- Voice: reject if `source_metadata.original_filename` already exists
- MCP/API: reject if content hash matches within 60-second window (SHA-256 of normalized content: trim, collapse whitespace, lowercase; stored as `content_hash` char(64) indexed column)

**Note**: The 60-second dedup window is a startup default. If real-world usage shows false
positives or false negatives, adjust via config (add `dedup_window_seconds` to pipelines.yaml).
Cross-source duplicates within the window are caught; outside the window they're intentionally
kept (captures from different sources may have different context even with identical text).

---

#### GET /api/v1/captures

**Description**: List captures with filters. Paginated.

**Query Parameters**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| limit | integer | No | 20 | Max results (1-100) |
| offset | integer | No | 0 | Pagination offset |
| source | string | No | — | Filter by source |
| type | string | No | — | Filter by extracted type (in metadata) |
| brain_view | string | No | — | Filter by brain view |
| tag | string | No | — | Filter by tag |
| after | string (ISO 8601) | No | — | Captures after this date |
| before | string (ISO 8601) | No | — | Captures before this date |
| status | string | No | — | Filter by pipeline_status |

**Response (200 OK)**:
```json
{
  "data": [
    {
      "id": "550e8400-...",
      "content": "Decision: going with T&M...",
      "source": "slack",
      "metadata": { "type": "decision", "people": ["Tom"], "topics": ["QSR", "pricing"] },
      "tags": ["career", "qsr"],
      "brain_views": ["career", "client"],
      "pipeline_status": "complete",
      "captured_at": "2026-03-04T14:30:00Z",
      "created_at": "2026-03-04T14:30:01Z"
    }
  ],
  "meta": {
    "total": 1523,
    "limit": 20,
    "offset": 0
  }
}
```

---

#### GET /api/v1/captures/:id

**Description**: Get a single capture with full detail including pipeline events and linked entities (via JOIN).

**Response (200 OK)**:
```json
{
  "id": "550e8400-...",
  "content": "Decision: going with T&M...",
  "content_raw": null,
  "source": "slack",
  "source_metadata": { "slack_ts": "1709312456.123456" },
  "metadata": { "type": "decision", "people": ["Tom"], "topics": ["QSR"] },
  "pre_extracted": {},
  "tags": ["career"],
  "brain_views": ["career", "client"],
  "linked_entities": [
    { "entity_id": "ent-123", "entity_type": "person", "relationship": "mentioned", "name": "Tom" }
  ],
  "pipeline_status": "complete",
  "pipeline_events": [
    { "stage": "embed", "status": "complete", "model": "nomic-embed-text", "duration_ms": 45, "created_at": "..." },
    { "stage": "extract_metadata", "status": "complete", "model": "llama3.1:8b", "duration_ms": 2100, "created_at": "..." },
    { "stage": "notify", "status": "complete", "duration_ms": 120, "created_at": "..." }
  ],
  "captured_at": "2026-03-04T14:30:00Z",
  "created_at": "2026-03-04T14:30:01Z",
  "updated_at": "2026-03-04T14:30:04Z"
}
```

---

#### PATCH /api/v1/captures/:id

**Description**: Update capture classification metadata. Does NOT re-trigger embedding or pipeline processing.

**Request Body** (partial update — only included fields are changed):
```json
{
  "tags": ["career", "qsr"],
  "brain_views": ["career", "client"],
  "metadata_overrides": {
    "type": "decision",
    "priority": "high"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| tags | string[] | Replace tags entirely |
| brain_views | string[] | Replace brain_views entirely |
| metadata_overrides | object | Merged into existing metadata (does not replace) |

**Response (200 OK)**:
```json
{
  "id": "550e8400-...",
  "tags": ["career", "qsr"],
  "brain_views": ["career", "client"],
  "metadata": { "type": "decision", "priority": "high", "people": ["Tom"] },
  "updated_at": "2026-03-05T10:00:00Z"
}
```

**Note**: `metadata_overrides` are shallow-merged with pipeline-extracted metadata. Pipeline values are preserved unless explicitly overridden. Slack reactions (e.g., `:career:` emoji) can trigger brain_view additions via the Slack bot.

---

#### DELETE /api/v1/captures/:id

**Description**: Soft-delete a capture. Sets `deleted_at` timestamp. Capture excluded from search and list results but retained in database for recovery.

**Response (204 No Content)**

**Error Responses**:
| Status | Code | Description |
|--------|------|-------------|
| 404 | NOT_FOUND | Capture not found |

**Recovery**: Direct SQL `UPDATE captures SET deleted_at = NULL WHERE id = '...'`. No undelete API endpoint — this is an escape hatch, not a feature.

---

#### POST /api/v1/search

**Description**: Semantic search across all captures using pgvector cosine similarity.

**Request Body**:
```json
{
  "query": "QSR pricing decisions",
  "limit": 10,
  "threshold": 0.5,
  "search_mode": "hybrid",
  "temporal_weight": 0.0,
  "filters": {
    "source": "slack",
    "tags": ["career"],
    "brain_views": ["client"],
    "after": "2026-02-01T00:00:00Z",
    "before": "2026-03-05T00:00:00Z"
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| query | string | Yes | — | Natural language search query |
| limit | integer | No | 10 | Max results (1-50) |
| threshold | float | No | 0.5 | Minimum cosine similarity (0-1) |
| offset | integer | No | 0 | Pagination offset |
| search_mode | string | No | "hybrid" | One of: "hybrid" (RRF), "vector" (pure pgvector), "fts" (pure text) |
| temporal_weight | float | No | 0.0 | Weight for temporal vs semantic scoring (0.0 = pure semantic, 1.0 = pure temporal). Cold start default; ramp up per PRD Section 9.1. |
| filters.source | string | No | — | Filter by source |
| filters.tags | string[] | No | — | Filter by any matching tag |
| filters.brain_views | string[] | No | — | Filter by any matching brain view |
| filters.after | string | No | — | Captures after this date |
| filters.before | string | No | — | Captures before this date |

**Implementation**:
1. Generate embedding for `query` via LiteLLM (jetson-embeddings alias)
2. If search_mode = "hybrid": call `match_captures_hybrid()` with query embedding + raw query text
   If search_mode = "vector": call `match_captures()` with query embedding only
   If search_mode = "fts": execute FTS-only query with temporal scoring
3. Enqueue `update_access_stats` job for returned capture IDs (async, non-blocking)
4. Return ranked results

**Response (200 OK)**:
```json
{
  "results": [
    {
      "id": "550e8400-...",
      "content": "Decision: going with T&M plus $180k cap for QSR.",
      "metadata": { "type": "decision", "people": ["Tom"] },
      "source": "slack",
      "tags": ["career"],
      "similarity": 0.94,
      "temporal_score": 0.72,
      "composite_score": 0.87,
      "captured_at": "2026-03-04T14:30:00Z"
    }
  ],
  "meta": {
    "query": "QSR pricing decisions",
    "search_mode": "hybrid",
    "embedding_ms": 42,
    "search_ms": 85,
    "total_results": 3,
    "offset": 0
  }
}
```

**Performance**: Target <5 seconds total (embedding generation + hybrid search + temporal scoring).

---

#### POST /api/v1/synthesize

**Description**: Ad-hoc AI synthesis across captures. Retrieves relevant captures, assembles context within token budget, and sends to configured AI model.

**Request Body**:
```json
{
  "query": "Summarize everything about the QSR engagement",
  "max_captures": 20,
  "token_budget": 50000,
  "filters": {
    "brain_views": ["client"]
  }
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| query | string | Yes | — | Synthesis prompt |
| max_captures | integer | No | 20 | Max captures to include as context |
| token_budget | integer | No | 50000 | Max tokens for context assembly |
| filters | object | No | — | Same filter object as search |

**Implementation**:
1. Hybrid search for top `max_captures` results using `match_captures_hybrid()` (default)
2. Assemble context: sort by composite_score, include captures until `token_budget` reached (token estimate: `chars / 4` with 10% safety margin — no tokenizer dependency)
3. If context exceeds budget, truncate from bottom (lowest composite_score)
4. Send context + query to LiteLLM (model alias: `synthesis` → Claude Sonnet, fallback: GPT-4o)
5. Return synthesized response

**Response (200 OK)**:
```json
{
  "synthesis": "Based on your captures over the past month, the QSR engagement...",
  "captures_used": 15,
  "model": "claude-sonnet-4-6",
  "token_usage": {
    "input_tokens": 12500,
    "output_tokens": 850,
    "cost_estimate": 0.042
  }
}
```

**Note**: Synthesis results are ephemeral — not cached, not re-captured into the brain. Output skills (weekly brief, governance) implement their own context assembly.

---

#### GET /api/v1/stats

**Description**: Brain statistics.

**Query Parameters**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| period | string | `week` | One of: `day`, `week`, `month`, `all` |

**Response (200 OK)**:
```json
{
  "total_captures": 1523,
  "period_captures": 47,
  "by_source": { "slack": 35, "voice": 10, "api": 2 },
  "by_type": { "observation": 20, "decision": 12, "idea": 8, "task": 5, "win": 2 },
  "by_brain_view": { "career": 25, "technical": 15, "client": 7 },
  "top_topics": ["QSR", "pricing", "AI", "hiring"],
  "top_people": ["Tom", "Sarah", "Mike"],
  "entity_count": 42,
  "pipeline_health": {
    "queue_depth": 0,
    "failed_count": 2,
    "success_rate_7d": 0.993
  },
  "ai_usage": {
    "month_to_date": 18.50,
    "budget_soft": 30,
    "budget_hard": 50
  }
}
```

---

#### POST /api/v1/skills/:name/trigger

**Description**: Manually trigger an output skill.

**Path Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| name | string | Skill name: `weekly_brief`, `drift_monitor`, `daily_connections`, `board_quick_check`, `board_quarterly` |

**Request Body** (optional):
```json
{
  "config_overrides": {
    "days": 14
  }
}
```

**Response (202 Accepted)**:
```json
{
  "job_id": "skill-job-123",
  "skill": "weekly_brief",
  "status": "queued",
  "message": "Skill triggered, results will be delivered to configured targets"
}
```

---

#### POST /api/v1/sessions

**Description**: Start a new interactive governance session (Phase 3).

**Request Body**:
```json
{
  "session_type": "quick_check",
  "config": {
    "board_roles": ["strategist", "operator", "contrarian", "coach", "analyst"]
  }
}
```

**Response (201 Created)**:
```json
{
  "id": "sess-456",
  "session_type": "quick_check",
  "status": "active",
  "state": {
    "turn_count": 0,
    "max_turns": 15,
    "topics_covered": [],
    "topics_remaining": ["wins", "blockers", "risks", "priorities", "energy"],
    "last_role": null,
    "idle_timeout_minutes": 30
  },
  "prompt": "Let's start your quick check. What wins can you point to this week — specific outcomes, not activities?",
  "board_role": "coach",
  "context": { "recent_bets": [...], "recent_captures": [...] }
}
```

---

#### POST /api/v1/sessions/:id/respond

**Description**: Submit a response to the current session prompt.

**Request Body**:
```json
{
  "response": "I committed to finalizing the QSR proposal by March 1 and delivered it on Feb 28."
}
```

**Response (200 OK)**:
```json
{
  "status": "active",
  "state": {
    "turn_count": 2,
    "topics_covered": ["wins"],
    "topics_remaining": ["blockers", "risks", "priorities", "energy"],
    "last_role": "operator"
  },
  "prompt": "Good, concrete evidence. Now let's look at blockers...",
  "board_role": "operator",
  "captures_referenced": [...]
}
```

If the answer triggers anti-vagueness enforcement:
```json
{
  "status": "active",
  "state": {
    "turn_count": 2,
    "topics_covered": [],
    "topics_remaining": ["wins", "blockers", "risks", "priorities", "energy"],
    "last_role": "contrarian"
  },
  "anti_vagueness": {
    "triggered": true,
    "message": "That answer lacks concrete evidence. What specific outcomes or metrics can you point to?"
  },
  "prompt": "Let me rephrase: what specific deliverables did you complete, with dates?",
  "board_role": "contrarian"
}
```

---

#### GET /api/v1/sessions/:id

**Description**: Get full session state for resume support. Returns everything needed to reconstruct the conversation context for the LLM.

**Response (200 OK)**:
```json
{
  "id": "sess-456",
  "session_type": "quick_check",
  "status": "paused",
  "created_at": "2026-03-01T10:00:00Z",
  "paused_at": "2026-03-01T10:15:00Z",
  "config": {
    "board_roles": ["strategist", "operator", "contrarian", "coach", "analyst"],
    "max_turns": 15,
    "required_topics": ["wins", "blockers", "risks", "priorities", "energy"]
  },
  "state": {
    "turn_count": 7,
    "topics_covered": ["wins", "blockers"],
    "topics_remaining": ["risks", "priorities", "energy"],
    "last_role": "operator"
  },
  "transcript": [
    {
      "role": "bot",
      "board_role": "coach",
      "content": "Let's start with wins this week...",
      "timestamp": "2026-03-01T10:00:30Z"
    },
    {
      "role": "user",
      "content": "Closed the QSR deal finally...",
      "timestamp": "2026-03-01T10:01:15Z"
    }
  ],
  "_note": "transcript sourced from session_messages table JOIN, same shape in API response",
  "slack_thread_ts": "1709290800.000100",
  "slack_channel_id": "D01ABC123"
}
```

**Resume Flow**: Slack bot maps thread → session via `slack_thread_ts`. On resume, the full transcript is injected into the LLM system prompt so the conversation continues naturally. `state.topics_remaining` drives the guardrails.

---

#### GET /api/v1/entities

**Description**: List known entities (Phase 3). Compact response for dashboard tables and Slack output.

**Query Parameters**: `type` (person/project/decision/bet/concept), `sort_by` (recent/mentions/name), `brain_view`, `limit`, `offset`

**Response (200 OK)**:
```json
{
  "entities": [
    {
      "id": "ent-123",
      "entity_type": "person",
      "name": "Tom Smith",
      "aliases": ["Tom", "Tom at QSR Corp"],
      "mention_count": 23,
      "first_seen": "2026-01-15T...",
      "last_seen": "2026-03-02T...",
      "recent_captures_count": 5,
      "brain_views": ["client", "work-internal"]
    }
  ],
  "total": 42,
  "page": 1,
  "per_page": 20
}
```

---

#### GET /api/v1/entities/:id

**Description**: Full entity detail with linked captures and related entities via co-mention.

**Response (200 OK)**:
```json
{
  "id": "ent-123",
  "entity_type": "person",
  "name": "Tom Smith",
  "aliases": ["Tom", "Tom at QSR Corp"],
  "metadata": { "company": "QSR Corp", "role": "VP Operations" },
  "mention_count": 23,
  "first_seen": "2026-01-15T...",
  "last_seen": "2026-03-02T...",
  "linked_captures": [
    {
      "id": "cap-789",
      "summary": "Meeting with Tom about Q2 rollout plan",
      "relationship": "mentioned",
      "captured_at": "2026-03-02T...",
      "source": "slack",
      "brain_views": ["client"]
    }
  ],
  "related_entities": [
    {
      "id": "ent-456",
      "name": "QSR Q2 Rollout",
      "entity_type": "project",
      "relationship": "associated",
      "co_mention_count": 8
    }
  ]
}
```

---

#### POST /api/v1/captures/:id/retry

**Description**: Retry a failed pipeline stage.

**Query Parameters**: `stage` (optional — retry specific stage or all failed stages)

**Response (202 Accepted)**:
```json
{
  "capture_id": "550e8400-...",
  "stages_retried": ["extract_metadata"],
  "message": "Retry enqueued"
}
```

---

#### POST /api/v1/admin/config/reload

**Description**: Force reload of YAML config files (pipelines, AI routing, skills, brain views). In-flight jobs complete with their current config.

**Response (200 OK)**:
```json
{
  "reloaded": ["pipelines.yaml", "ai-routing.yaml", "skills.yaml", "brain-views.yaml", "notifications.yaml"],
  "timestamp": "2026-03-04T15:00:00Z"
}
```

---

#### POST /api/v1/triggers (Phase 2)

**Description**: Create a new semantic trigger.

**Request Body**:
```json
{
  "name": "QSR timeline",
  "query_text": "QSR timeline slipping or delay",
  "threshold": 0.72,
  "delivery_channel": "pushover",
  "cooldown_minutes": 60
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| name | string | Yes | — | User-readable trigger label |
| query_text | string | Yes | — | Natural language pattern to match |
| threshold | float | No | 0.72 | Minimum similarity to fire |
| delivery_channel | string | No | "pushover" | One of: pushover, slack, both |
| cooldown_minutes | integer | No | 60 | Minimum time between fires |

**Response (201 Created)**:
```json
{
  "id": "trig-789",
  "name": "QSR timeline",
  "query_text": "QSR timeline slipping or delay",
  "threshold": 0.72,
  "is_active": true,
  "delivery_channel": "pushover"
}
```

**Implementation**: Generate embedding for `query_text` via LiteLLM (jetson-embeddings alias) at creation time. Store trigger with pre-computed embedding.

---

#### GET /api/v1/triggers (Phase 2)

**Description**: List all triggers.

**Response (200 OK)**:
```json
{
  "triggers": [
    {
      "id": "trig-789",
      "name": "QSR timeline",
      "threshold": 0.72,
      "is_active": true,
      "fire_count": 3,
      "last_fired_at": "2026-03-04T..."
    }
  ],
  "total": 1
}
```

---

#### DELETE /api/v1/triggers/:id (Phase 2)

**Description**: Deactivate a trigger.

**Response (204 No Content)**

---

#### PATCH /api/v1/triggers/:id (Phase 2)

**Description**: Update trigger settings.

**Request Body** (partial):
```json
{ "is_active": false, "threshold": 0.8, "cooldown_minutes": 120 }
```

**Response (200 OK)**: Updated trigger object.

---

#### GET /health

**Description**: Health check endpoint. Returns status of all dependent services.

**Response (200 OK)**:
```json
{
  "status": "healthy",
  "services": {
    "postgres": { "status": "up", "latency_ms": 2 },
    "redis": { "status": "up", "latency_ms": 1 },
    "litellm": { "status": "up", "latency_ms": 12, "models_available": ["jetson-embeddings", "fast", "synthesis", "governance"] },
    "litellm": { "status": "up", "latency_ms": 5, "models_available": ["fast", "synthesis", "governance"] }
  },
  "uptime_seconds": 86400,
  "version": "0.1.0"
}
```

### 3.3 API Error Code Catalog

| Error Code | HTTP Status | Description | Resolution |
|------------|-------------|-------------|------------|
| VALIDATION_ERROR | 400 | Invalid request payload | Check required fields and types |
| DUPLICATE_CAPTURE | 409 | Capture already exists (dedup) | Ignore — capture was already ingested |
| NOT_FOUND | 404 | Resource not found | Verify ID exists |
| PIPELINE_FAILED | 500 | Pipeline processing error | Check pipeline_events, retry via API |
| SERVICE_UNAVAILABLE | 503 | Downstream service unreachable | Check health endpoint, wait for recovery |
| AI_BUDGET_EXCEEDED | 429 | Monthly AI budget hard limit reached | Wait for budget reset or adjust limits |
| EMBEDDING_UNAVAILABLE | 503 | LiteLLM/Jetson embedding unavailable | Embeddings will queue and retry via BullMQ |
| CONFIG_ERROR | 500 | YAML config parse error | Fix config file syntax |

---

## 4. Database Schema Design

### 4.1 Entity Relationship Diagram

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   captures   │────<│ entity_links │>────│   entities   │
│              │     └──────────────┘     │              │
│ id (PK)      │                          │ id (PK)      │
│ content      │     ┌──────────────┐     │ entity_type  │
│ embedding    │────<│pipeline_events│    │ name         │
│ metadata     │     │              │     │ aliases      │
│ source       │     │ id (PK)      │     └──────────────┘
│ tags[]       │     │ capture_id   │
│ brain_views[]│     │ stage        │     ┌──────────────┐
│ access_count │     │ status       │     │   sessions   │
│ last_accessed│     │ model        │     │              │
│ pipeline_*   │     │ duration_ms  │     │ id (PK)      │
│ captured_at  │     └──────────────┘     │ session_type │
└──────────────┘                          │ state        │
                     ┌──────────────┐     │ result       │────<┌──────────────┐
┌──────────────┐     │session_       │     └──────────────┘     │    bets      │
│  skills_log  │     │ messages     │                          │              │
│              │     │              │     ┌──────────────┐     │ id (PK)      │
│ id (PK)      │     │ id (PK)      │     │   triggers   │     │ session_id   │
│ skill_name   │     │ session_id   │     │   (Phase 2)  │     │ commitment   │
│ status       │     │ role         │     │              │     │ criteria     │
│ result       │     │ board_role   │     │ id (PK)      │     │ due_date     │
│ token_usage  │     │ content      │     │ name         │     └──────────────┘
└──────────────┘     └──────────────┘     │ query_text   │
                                          │ query_embed  │     ┌──────────────┐
                                          │ threshold    │     │ai_audit_log  │
                                          │ is_active    │     │              │
                                          │ fire_count   │     │ id (PK)      │
                                          │ cooldown_min │     │ provider     │
                                          └──────────────┘     │ model        │
                                                               │ tokens_in    │
                                                               │ tokens_out   │
                                                               └──────────────┘
```

### 4.2 Drizzle Schema Definitions

All schemas defined in TypeScript using Drizzle ORM. Migrations generated via `drizzle-kit generate` and applied via `drizzle-kit migrate`.

```typescript
// src/shared/schema/captures.ts
import { pgTable, uuid, text, jsonb, timestamp, index, vector } from 'drizzle-orm/pg-core';

export const captures = pgTable('captures', {
  id: uuid('id').defaultRandom().primaryKey(),

  // Content
  content: text('content').notNull(),
  contentRaw: text('content_raw'),
  contentHash: char('content_hash', { length: 64 }), // SHA-256 of normalized content (trim, collapse whitespace, lowercase) for dedup
  embedding: vector('embedding', { dimensions: 768 }), // 768d — compatible with nomic-embed-text (native) or qwen3-embedding (Matryoshka truncated)

  // Temporal tracking (ACT-R cognitive model for search relevance)
  accessCount: integer('access_count').default(0),
  lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),

  // Classification
  metadata: jsonb('metadata').default({}).$type<CaptureMetadata>(),
  source: text('source').notNull(), // slack | voice | web | api | email | document
  sourceMetadata: jsonb('source_metadata').default({}).$type<SourceMetadata>(),
  preExtracted: jsonb('pre_extracted').default({}).$type<PreExtracted>(),

  // Organization
  tags: text('tags').array().default([]),
  brainViews: text('brain_views').array().default([]),

  // Entity links via entity_links table JOIN (no denormalization needed at <100K rows)

  // Processing audit trail
  pipelineStatus: text('pipeline_status').default('received'),
    // received | processing | complete | failed | partial

  // Timestamps
  capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),

  // Soft delete
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (table) => [
  index('idx_captures_embedding').using('hnsw', table.embedding.op('vector_cosine_ops')),
  index('idx_captures_metadata').using('gin', table.metadata),
  index('idx_captures_tags').using('gin', table.tags),
  index('idx_captures_brain_views').using('gin', table.brainViews),
  // FTS index for hybrid retrieval (RRF) — requires custom SQL migration
  // index('idx_captures_fts').using('gin', sql`to_tsvector('english', content)`),
  index('idx_captures_created_at').on(table.createdAt),
  index('idx_captures_captured_at').on(table.capturedAt),
  index('idx_captures_source').on(table.source),
  index('idx_captures_pipeline_status').on(table.pipelineStatus),
  index('idx_captures_content_hash').on(table.contentHash), // Dedup lookups: matching hash within 60-second window
]);
```

```typescript
// src/shared/schema/pipeline-events.ts
// Append-only processing audit trail — replaces former JSONB pipeline_log column.
// Avoids JSONB rewrite on each stage completion; enables efficient per-stage queries.
export const pipelineEvents = pgTable('pipeline_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  captureId: uuid('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  status: text('status').notNull(), // complete | failed | skipped
  model: text('model'),
  durationMs: integer('duration_ms'),
  error: text('error'),
  retryCount: integer('retry_count').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_pipeline_events_capture').on(table.captureId),
]);
```

```typescript
// src/shared/schema/entities.ts
export const entities = pgTable('entities', {
  id: uuid('id').defaultRandom().primaryKey(),
  entityType: text('entity_type').notNull(), // person | project | decision | concept | bet
  name: text('name').notNull(),
  aliases: text('aliases').array().default([]),
  metadata: jsonb('metadata').default({}).$type<EntityMetadata>(),
  firstSeen: timestamp('first_seen', { withTimezone: true }).defaultNow(),
  lastSeen: timestamp('last_seen', { withTimezone: true }).defaultNow(),
  mentionCount: integer('mention_count').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('idx_entities_name_type').on(table.name, table.entityType),
]);

export const entityLinks = pgTable('entity_links', {
  id: uuid('id').defaultRandom().primaryKey(),
  captureId: uuid('capture_id').references(() => captures.id, { onDelete: 'cascade' }),
  entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
  relationship: text('relationship'), // mentioned | decided | blocked_by | etc.
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_entity_links_capture').on(table.captureId),
  index('idx_entity_links_entity').on(table.entityId),
]);
```

```typescript
// src/shared/schema/sessions.ts
export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionType: text('session_type').notNull(), // quick_check | quarterly | custom
  status: text('status').default('active'), // active | completed | abandoned | paused
  state: jsonb('state').notNull().$type<SessionState>(),
  // Transcript stored in session_messages table (append-only, avoids JSONB rewrite)
  config: jsonb('config').default({}).$type<SessionConfig>(),
  result: jsonb('result').$type<SessionResult>(),
  pausedAt: timestamp('paused_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
```

```typescript
// src/shared/schema/session-messages.ts
// Append-only transcript storage — replaces former JSONB transcript column on sessions.
export const sessionMessages = pgTable('session_messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  sessionId: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // system | bot | user
  boardRole: text('board_role'), // strategist | operator | contrarian | coach | analyst
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_session_messages_session').on(table.sessionId),
]);
```

```typescript
// src/shared/schema/bets.ts
export const bets = pgTable('bets', {
  id: uuid('id').defaultRandom().primaryKey(),
  commitment: text('commitment').notNull(),
  falsifiableCriteria: text('falsifiable_criteria').notNull(),
  status: text('status').default('open'), // open | correct | wrong | expired
  dueDate: date('due_date').notNull(),
  sessionId: uuid('session_id').references(() => sessions.id),
  evidence: jsonb('evidence').default([]).$type<BetEvidence[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});
```

```typescript
// src/shared/schema/skills-log.ts
export const skillsLog = pgTable('skills_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  skillName: text('skill_name').notNull(),
  triggerType: text('trigger_type').notNull(), // scheduled | manual | event
  status: text('status').default('running'), // running | completed | failed
  config: jsonb('config').$type<SkillConfig>(),
  result: jsonb('result').$type<SkillResult>(),
  capturesQueried: integer('captures_queried'),
  aiModelUsed: text('ai_model_used'),
  tokenUsage: jsonb('token_usage').$type<TokenUsage>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  error: text('error'),
});
```

```typescript
// src/shared/schema/ai-audit-log.ts
// ai_audit_log tracks application-level audit data: which task triggered which model,
// how long it took, and whether it succeeded. This is an operational audit trail.
// Cost/spend tracking is EXCLUSIVELY via LiteLLM's /spend/logs endpoint.
// Do NOT add cost fields here — LiteLLM is the single source of truth for budget.
export const aiAuditLog = pgTable('ai_audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  provider: text('provider').notNull(), // litellm | anthropic | openai | openrouter
  model: text('model').notNull(),
  taskType: text('task_type').notNull(), // embedding | metadata_extraction | synthesis | governance | intent
  tokensIn: integer('tokens_in').default(0),
  tokensOut: integer('tokens_out').default(0),
  latencyMs: integer('latency_ms'),
  success: boolean('success').default(true),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_ai_audit_log_created').on(table.createdAt),
  index('idx_ai_audit_log_provider').on(table.provider),
]);
```

```typescript
// src/shared/schema/triggers.ts (Phase 2)
export const triggers = pgTable('triggers', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),                    // User-readable label: "QSR timeline"
  queryText: text('query_text').notNull(),          // Natural language pattern
  queryEmbedding: vector('query_embedding', { dimensions: 768 }), // Pre-computed at creation
  threshold: real('threshold').default(0.72),        // Minimum similarity to fire
  deliveryChannel: text('delivery_channel').notNull().default('pushover'), // pushover | slack | both
  isActive: boolean('is_active').default(true),
  lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
  fireCount: integer('fire_count').default(0),
  cooldownMinutes: integer('cooldown_minutes').default(60),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_triggers_active').on(table.isActive),
  uniqueIndex('idx_triggers_name').on(table.name),
  // No HNSW index on trigger embeddings — max 20 triggers, brute-force cosine is fine
]);
```

### 4.3 Semantic Search Functions

Deployed as raw SQL migrations via Drizzle custom migration.

#### Vector-only search with temporal scoring

```sql
-- Custom migration: 0001_match_captures_function.sql
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
begin
  return query
  with base as (
    select
      c.id, c.content, c.metadata, c.source, c.tags, c.captured_at,
      1 - (c.embedding <=> query_embedding) as semantic_sim,
      -- ACT-R temporal activation: ln(access_count) - 0.5 * ln(hours_since_last_access)
      -- Normalized to [0,1] range
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

#### Full-text search index

```sql
-- Custom migration: 0003_fts_index.sql
CREATE INDEX idx_captures_fts ON captures USING gin(to_tsvector('english', content));
```

#### Hybrid search with Reciprocal Rank Fusion (RRF)

The primary search function. Runs vector similarity and full-text search in parallel within a single SQL CTE chain, fuses results via RRF, then applies temporal scoring.

```sql
-- Custom migration: 0004_match_captures_hybrid.sql
create or replace function match_captures_hybrid(
  query_embedding vector(768),
  query_text text,
  match_threshold float default 0.3,
  match_count int default 20,
  rrf_k int default 60,
  temporal_weight float default 0.0,  -- Start at 0.0; increase after search history builds
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
  temporal_score float,
  rrf_score float,
  composite_score float,
  captured_at timestamptz
)
language plpgsql as $$
begin
  return query
  with
  -- Arm 1: Vector similarity search (top 100 candidates)
  vector_ranked as (
    select
      c.id,
      row_number() over (order by c.embedding <=> query_embedding) as rank,
      1 - (c.embedding <=> query_embedding) as semantic_sim
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
    limit 100
  ),
  -- Arm 2: Full-text search (top 100 candidates)
  fts_ranked as (
    select
      c.id,
      row_number() over (
        order by ts_rank_cd(to_tsvector('english', c.content), plainto_tsquery('english', query_text)) desc
      ) as rank
    from captures c
    where c.deleted_at is null
      and c.pipeline_status = 'complete'
      and to_tsvector('english', c.content) @@ plainto_tsquery('english', query_text)
      and (filter_source is null or c.source = filter_source)
      and (filter_tags is null or c.tags && filter_tags)
      and (filter_brain_views is null or c.brain_views && filter_brain_views)
      and (filter_after is null or c.captured_at >= filter_after)
      and (filter_before is null or c.captured_at <= filter_before)
    limit 100
  ),
  -- RRF fusion: combine ranked lists
  fused as (
    select
      coalesce(v.id, f.id) as id,
      coalesce(v.semantic_sim, 0.0) as semantic_sim,
      coalesce(1.0 / (rrf_k + v.rank), 0.0) + coalesce(1.0 / (rrf_k + f.rank), 0.0) as rrf_score
    from vector_ranked v
    full outer join fts_ranked f on v.id = f.id
  ),
  -- Join with full capture data and apply temporal scoring
  scored as (
    select
      c.id, c.content, c.metadata, c.source, c.tags, c.captured_at,
      f.semantic_sim,
      f.rrf_score,
      case
        when c.last_accessed_at is null then 0.0
        else greatest(0.0, least(1.0,
          (ln(greatest(c.access_count, 1))
           - 0.5 * ln(greatest(extract(epoch from (now() - c.last_accessed_at)) / 3600.0, 1.0))
          ) / 5.0 + 0.5
        ))
      end as temporal_act
    from fused f
    join captures c on c.id = f.id
  )
  select
    s.id, s.content, s.metadata, s.source, s.tags,
    s.semantic_sim as similarity,
    s.temporal_act as temporal_score,
    s.rrf_score,
    s.rrf_score * (1.0 + temporal_weight * s.temporal_act) as composite_score,
    s.captured_at
  from scored s
  order by s.rrf_score * (1.0 + temporal_weight * s.temporal_act) desc
  limit match_count;
end;
$$;
```

### 4.4 Database Indexing Strategy

| Table | Index Name | Columns | Type | Rationale |
|-------|------------|---------|------|-----------|
| captures | idx_captures_embedding | embedding | HNSW (vector_cosine_ops) | Fast ANN search for semantic queries |
| captures | idx_captures_metadata | metadata | GIN | JSONB contains queries (type, people, topics) |
| captures | idx_captures_tags | tags | GIN | Array overlap queries |
| captures | idx_captures_brain_views | brain_views | GIN | Array overlap queries |
| captures | idx_captures_created_at | created_at DESC | B-tree | Recent captures listing |
| captures | idx_captures_captured_at | captured_at DESC | B-tree | Time-based queries use captured_at |
| captures | idx_captures_source | source | B-tree | Filter by source |
| captures | idx_captures_pipeline_status | pipeline_status | B-tree | Find pending/failed captures |
| captures | idx_captures_fts | `to_tsvector('english', content)` | GIN | Full-text search arm of hybrid retrieval (RRF) |
| entity_links | idx_entity_links_capture | capture_id | B-tree | Join from captures |
| entity_links | idx_entity_links_entity | entity_id | B-tree | Join from entities |
| ai_audit_log | idx_ai_audit_log_created | created_at | B-tree | Audit trail queries |

### 4.5 Migration Strategy

Drizzle ORM with `drizzle-kit`:

```bash
# Generate migration from schema changes
npx drizzle-kit generate

# Apply migrations
npx drizzle-kit migrate

# Push schema directly (development only)
npx drizzle-kit push
```

Migrations stored in `drizzle/` directory, version-controlled, applied automatically on container startup via entrypoint script.

**Custom Migrations**:

1. **`match_captures` function** — Vector search with temporal scoring (see Section 4.3)
1a. **`fts_index`** — Full-text search GIN index for hybrid retrieval
1b. **`match_captures_hybrid` function** — Hybrid search with RRF (see Section 4.3)
2. **`set_updated_at` trigger** — Automatic `updated_at` maintenance on all tables:

```sql
-- 0002_updated_at_trigger.sql
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
CREATE TRIGGER trg_captures_updated_at BEFORE UPDATE ON captures FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_entities_updated_at BEFORE UPDATE ON entities FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_sessions_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_bets_updated_at BEFORE UPDATE ON bets FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

3. **pgvector custom type** (if Drizzle lacks native vector support):

```typescript
import { customType } from 'drizzle-orm/pg-core';

const vector = customType<{ data: number[]; config: { dimensions: number } }>({
  dataType(config) {
    return `vector(${config?.dimensions ?? 768})`;
  },
});
```

Similarity queries use `sql` template literals for cosine distance (`<=>`) — pgvector operators are too specialized for the Drizzle query builder.

**Embedding Model Re-embedding Migration**:

Switching embedding models (e.g., from nomic-embed-text to Qwen3-Embedding) requires re-embedding all captures. Run as a one-time BullMQ job:

```typescript
// Migration job: re-embed all captures with new model
// 1. Query all captures with existing embeddings
// 2. For each capture: generate new embedding via LiteLLM (jetson-embeddings alias)
// 3. Batch update in groups of 50
// Estimated time on CPU:
//   nomic-embed-text (137M): ~1 capture/sec → 10K captures ≈ 3 hours
//   qwen3-embedding:0.6b: ~2 captures/sec → 10K captures ≈ 1.5 hours
//   qwen3-embedding:4b: ~0.2 captures/sec → 10K captures ≈ 14 hours
//   qwen3-embedding:8b: ~0.1 captures/sec → 10K captures ≈ 28 hours
// Consider running overnight for large re-embedding migrations with 8b model.
// If Qwen3-Embedding supports instruction prefixes, use document prefix for stored captures
// and query prefix at search time (asymmetric embedding).
//
// **CPU Performance Caveat**: The timing estimates above are theoretical. On the i7-9700 (no AVX-512),
// actual throughput may be 2-3x slower than advertised. Phase 1B MUST include a benchmark step:
//   1. Measure actual embeddings/second for each candidate model on this hardware
//   2. Test with warm model (already loaded) and cold model (first request after pull)
//   3. Record results and update these estimates with measured values
//   4. Factor into re-embedding migration planning (run overnight for 8b models)
```

---

## 5. Data Models and Types

### 5.1 TypeScript Interfaces

```typescript
// src/shared/types/capture.ts

/** Metadata extracted by the pipeline.
 *  Brain view classification is done by the LLM in the same extract_metadata prompt —
 *  no separate keyword rules. The prompt includes view definitions and examples.
 *  Manual override via Slack reaction or command. */
interface CaptureMetadata {
  type?: CaptureType;
  people?: string[];
  topics?: string[];
  action_items?: string[];
  dates?: string[];
  sentiment?: 'positive' | 'neutral' | 'negative';
  brain_views_suggested?: BrainView[]; // LLM-classified in extract_metadata prompt. Validated against brain-views.yaml config.
}

type CaptureType =
  | 'decision' | 'idea' | 'observation' | 'task'
  | 'win' | 'blocker' | 'question' | 'reflection';

/** Brain views are config-driven (brain-views.yaml), not hardcoded.
 *  Validated at runtime by CaptureService against loaded config.
 *  Default views: career, personal, technical, work-internal, client. */
type BrainView = string;

type CaptureSource = 'slack' | 'voice' | 'web' | 'api' | 'email' | 'document';

type PipelineStatus = 'received' | 'processing' | 'complete' | 'failed' | 'partial';

/** Source-specific metadata */
interface SourceMetadata {
  slack_ts?: string;
  channel?: string;
  user?: string;
  device?: string;
  duration_seconds?: number;
  original_filename?: string;
  url?: string;
}

/** Classification from input adapter (e.g., voice-capture) */
interface PreExtracted {
  template?: string;
  confidence?: number;
  fields?: Record<string, unknown>;
  transcript_raw?: string;
}

/** Pipeline execution log entry */
interface PipelineLogEntry {
  stage: string;
  status: 'complete' | 'failed' | 'skipped';
  model?: string;
  duration_ms: number;
  timestamp: string;
  error?: string;
  retry_count?: number;
}

/** Linked entity reference (populated from entity_links JOIN, not a captures column) */
interface LinkedEntity {
  entity_id: string;
  entity_type: string;
  relationship: string;
  name?: string;
}
```

```typescript
// src/shared/types/session.ts

/** LLM-driven conversation with guardrails — NOT a rigid step sequence.
 *  The LLM decides what to ask next, which board role "speaks", and when complete.
 *  Guardrails enforce max turns, required topic coverage, and idle timeout. */
interface SessionState {
  turn_count: number;
  max_turns: number; // 15 for quick_check
  topics_covered: string[];
  topics_remaining: string[]; // e.g., ['wins', 'blockers', 'risks', 'priorities', 'energy']
  last_role: string; // last board role that spoke
  idle_timeout_minutes: number; // 30 min → auto-pause
}

/** Maps to session_messages rows. Returned from GET sessions/:id via JOIN. */
interface TranscriptEntry {
  role: 'system' | 'bot' | 'user';
  board_role?: 'strategist' | 'operator' | 'contrarian' | 'coach' | 'analyst';
  content: string;
  timestamp: string;
}

interface SessionResult {
  assessment: string;
  prediction_90d?: string;
  bets_created?: string[];
  captures_referenced: string[];
  model_used: string;
}
```

```typescript
// src/shared/types/ai.ts

interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  // Cost data from LiteLLM /spend/logs, not stored in application DB.
}

type AITaskType =
  | 'embedding'
  | 'metadata_extraction'
  | 'synthesis'
  | 'governance'
  | 'intent_classification'
  | 'career_signals'
  | 'weekly_brief'
  | 'drift_detection';
```

```typescript
// src/shared/types/search.ts

interface SearchOptions {
  query: string;
  limit?: number;                  // default: 10
  threshold?: number;              // default: 0.5
  searchMode?: 'hybrid' | 'vector' | 'fts';  // default: 'hybrid'
  temporalWeight?: number;         // 0.0–1.0, default: 0.0 (cold start; ramp up per PRD Section 9.1)
  filters?: SearchFilters;
}

interface SearchResult {
  id: string;
  content: string;
  metadata: CaptureMetadata;
  source: string;
  tags: string[];
  similarity: number;              // Cosine similarity score
  temporalScore: number;           // ACT-R temporal activation score
  compositeScore: number;          // Final ranking score (semantic + temporal, or RRF + temporal)
  rrfScore?: number;               // Present when search_mode = 'hybrid'
  capturedAt: string;
  linkedEntities: LinkedEntity[]; // Populated from entity_links JOIN on detail endpoint; omitted from search/list results
}
```

### 5.2 Validation Rules

Input validation using Zod schemas at the API boundary:

```typescript
// src/core-api/validation/capture.ts
import { z } from 'zod';

export const createCaptureSchema = z.object({
  content: z.string().min(1).max(50000),
  source: z.enum(['slack', 'voice', 'web', 'api', 'email', 'document']),
  source_metadata: z.record(z.unknown()).optional().default({}),
  pre_extracted: z.record(z.unknown()).optional().default({}),
  tags: z.array(z.string().max(100)).optional().default([]),
  brain_views: z.array(z.string().max(50))  // Validated against brain-views.yaml config at service layer, not hardcoded
    .optional().default([]),
  captured_at: z.string().datetime().optional(),
});

export const searchSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(50).optional().default(10),
  threshold: z.number().min(0).max(1).optional().default(0.5),
  search_mode: z.enum(['hybrid', 'vector', 'fts']).optional().default('hybrid'),
  temporal_weight: z.number().min(0).max(1).optional().default(0.0), // Cold start: 0.0. Ramp up per cold start schedule (PRD Section 9.1).
  filters: z.object({
    source: z.enum(['slack', 'voice', 'web', 'api', 'email', 'document']).optional(),
    tags: z.array(z.string()).optional(),
    brain_views: z.array(z.string()).optional(),
    after: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
  }).optional().default({}),
});

export const synthesizeSchema = z.object({
  query: z.string().min(1).max(5000),
  max_captures: z.number().int().min(1).max(100).optional().default(20),
  token_budget: z.number().int().min(1000).max(200000).optional().default(50000),
  filters: z.object({
    source: z.string().optional(),
    tags: z.array(z.string()).optional(),
    brain_views: z.array(z.string()).optional(),
    after: z.string().datetime().optional(),
    before: z.string().datetime().optional(),
  }).optional().default({}),
});
```

---

## 6. Service Layer Design

### 6.1 Service Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Core API (Hono)                           │
│  Routes → Validation (Zod) → Services → Drizzle → Postgres │
└──────────────┬──────────────────────────────────────────────┘
               │
    ┌──────────┼──────────┬──────────────┬────────────────┐
    │          │          │              │                │
┌───▼───┐ ┌───▼───┐ ┌────▼────┐  ┌─────▼─────┐  ┌──────▼──────┐
│Capture│ │Search │ │Synthesis│  │  Session   │  │   Stats     │
│Service│ │Service│ │Service  │  │  Service   │  │   Service   │
└───┬───┘ └───┬───┘ └────┬────┘  └─────┬─────┘  └─────────────┘
    │         │          │              │
    │    ┌────▼────┐ ┌───▼────┐  ┌─────▼─────┐
    │    │Embedding│ │   AI   │  │ Governance │
    │    │Service  │ │ Router │  │   Engine   │
    │    └────┬────┘ └───┬────┘  └───────────┘
    │         │          │
┌───▼─────────▼──────────▼───┐
│       Pipeline Service      │
│  BullMQ → Stage Executor    │
│  embed → extract → notify   │
└─────────────────────────────┘
```

### 6.2 Service Class Specifications

```typescript
/**
 * CaptureService
 *
 * Handles capture ingestion, deduplication, and pipeline triggering.
 */
class CaptureService {
  constructor(
    private db: DrizzleClient,
    private pipelineService: PipelineService,
    private configService: ConfigService,
  ) {}

  /** Ingest a new capture. Dedup checks, persist, enqueue pipeline. */
  async create(input: CreateCaptureInput): Promise<CaptureRecord>
    // 1. Check deduplication (source-level)
    // 2. Insert capture with status 'received'
    // 3. Select pipeline based on source + brain_views
    // 4. Enqueue pipeline job in BullMQ
    // 5. Return capture record

  /** Get capture by ID with full detail */
  async getById(id: string): Promise<CaptureRecord | null>

  /** List captures with filters and pagination */
  async list(filters: CaptureFilters): Promise<PaginatedResult<CaptureRecord>>

  /** Retry failed pipeline stages for a capture */
  async retry(id: string, stage?: string): Promise<void>
}
```

```typescript
/**
 * SearchService
 *
 * Handles hybrid search (FTS + vector with RRF) and temporal scoring.
 */
class SearchService {
  constructor(
    private db: DrizzleClient,
    private embeddingService: EmbeddingService,
    private queue: Queue, // for update_access_stats jobs
  ) {}

  /** Hybrid search: embed query → match_captures_hybrid (RRF + temporal) → ranked results */
  async search(input: SearchOptions): Promise<SearchResult[]>
    // 1. Generate embedding for query via EmbeddingService (type: 'query')
    // 2. Based on search_mode:
    //    hybrid → call match_captures_hybrid() with embedding + raw text
    //    vector → call match_captures() with embedding only
    //    fts    → FTS-only query with temporal scoring
    // 3. Enqueue update_access_stats job for returned capture IDs (async, non-blocking)
    // 4. Return ranked results with similarity, temporal_score, composite_score
}
```

```typescript
/**
 * EmbeddingService
 *
 * Generates embeddings via LiteLLM (https://llm.k4jda.net) using the OpenAI embeddings API.
 * Model alias: 'jetson-embeddings' → Qwen3-Embedding-4B-Q4_K_M on Jetson device.
 * No fallback — throws EmbeddingUnavailableError if LiteLLM/Jetson is unreachable; BullMQ retries.
 * Uses same LITELLM_URL / LITELLM_API_KEY as AIRouterService (no separate OLLAMA_URL).
 */
class EmbeddingService {
  constructor(
    private litellmClient: OpenAI,  // OpenAI SDK pointed at https://llm.k4jda.net
    private configService: ConfigService,
  ) {}

  /** Generate 768-dim embedding for text.
   *  Applies Qwen3 instruction prefix for query vs document type if supported. */
  async embed(text: string, type: 'document' | 'query' = 'document'): Promise<number[]>
    // 1. Read model alias from ai-routing.yaml (embedding.model = 'jetson-embeddings')
    // 2. If model supports instruction prefixes, prepend appropriate prefix for type
    // 3. Call litellmClient.embeddings.create({ model: alias, input: text })
    // 4. Return embedding vector (Qwen3-Embedding-4B configured for 768d on LiteLLM server)
    // 5. Throws EmbeddingUnavailableError if LiteLLM is unreachable (caller/BullMQ retries)

  /** Batch embed multiple texts */
  async embedBatch(texts: string[], type: 'document' | 'query' = 'document'): Promise<number[][]>

  /** Get current embedding model info */
  async getModelInfo(): Promise<{ model: string; dimensions: number; supportsInstructions: boolean }>
}
```

```typescript
/**
 * AIRouterService
 *
 * Thin wrapper that maps task types to LiteLLM model aliases.
 * LiteLLM handles provider routing, fallback, and budget enforcement.
 * Embeddings go through EmbeddingService which also calls LiteLLM (jetson-embeddings alias).
 */
class AIRouterService {
  constructor(
    private configService: ConfigService,
    private db: DrizzleClient,       // for ai_audit_log logging
    private litellmClient: OpenAI,   // OpenAI SDK pointed at https://llm.k4jda.net
  ) {}

  /** Route a completion request via LiteLLM based on task type */
  async complete(taskType: AITaskType, prompt: string, options?: AIOptions): Promise<AIResponse>
    // 1. Look up LiteLLM model alias for taskType from ai-routing.yaml
    // 2. Call litellmClient.chat.completions.create({ model: alias, ... })
    //    LiteLLM handles: provider routing, fallback, budget enforcement
    // 3. Log usage to ai_audit_log table (from response headers/metadata)
    // 4. Return response
    // Note: Embedding tasks should NOT go through this method — use EmbeddingService directly

  /** Get current month's spending (queries LiteLLM /spend/logs endpoint) */
  async getMonthlySpend(): Promise<{ total: number; by_provider: Record<string, number> }>
}
```

```typescript
/**
 * PipelineService
 *
 * Manages async capture processing via BullMQ.
 */
class PipelineService {
  constructor(
    private queue: Queue, // BullMQ queue
    private configService: ConfigService,
  ) {}

  /** Enqueue a capture for pipeline processing */
  async enqueue(captureId: string, pipelineName: string): Promise<void>

  /** Process a pipeline job (called by BullMQ worker) */
  async process(job: Job): Promise<void>
    // 1. Re-read pipeline config from YAML (per-job reload)
    // 2. Get pipeline stage definitions
    // 3. Execute stages in order
    // 4. Update capture record after each stage
    // 5. Mark pipeline complete or failed

  /** Get pipeline queue health */
  async getHealth(): Promise<PipelineHealth>
}
```

```typescript
/**
 * ConfigService
 *
 * In-memory cache with explicit reload. Config loaded at startup, cached indefinitely.
 * Workers re-read config at each job start (YAML parse <1ms for small files).
 * Core API reloads via POST /api/v1/admin/config/reload.
 * No file watcher, no TTL.
 */
class ConfigService {
  private cache: Map<string, unknown> = new Map();

  /** Load all config files from config/ directory.
   *  Each YAML file is validated against its Zod schema on load.
   *  Invalid config → throw ConfigError (fail fast on startup, log warning on reload). */
  async loadAll(): Promise<void>
    // Parse YAML, validate against schema, cache
    // Log: config file hash + validation status

  /** Get a typed config value */
  get<T>(filename: string): T

  /** Force reload all config. Returns list of reloaded files.
   *  If validation fails: log error, keep previous cached version, return error in list. */
  async reload(): Promise<ReloadResult[]>
}

// Config Zod schemas defined per file: pipelinesConfigSchema, aiRoutingConfigSchema,
// brainViewsConfigSchema, skillsConfigSchema, notificationsConfigSchema.
// Validation ensures typos or malformed YAML don't silently break workers.
```

```typescript
/**
 * EntityResolutionService (Phase 3)
 *
 * Three-tier matching algorithm for linking mentions to existing entities:
 * 1. Exact name match → auto-link
 * 2. Alias match (entity.aliases array) → auto-link
 * 3. LLM disambiguation for fuzzy/ambiguous matches → LLM decides
 * Auto-create new entity when no candidate matches.
 * No user confirmation — merge/split via Slack commands after the fact.
 */
class EntityResolutionService {
  constructor(
    private db: DrizzleClient,
    private aiRouter: AIRouterService,
  ) {}

  /** Resolve a mention to an existing entity or create new.
   *  LLM disambiguation confidence threshold: 0.8.
   *  >= 0.8 → auto-link to existing entity
   *  < 0.8 → create new entity (avoid false merges; user can merge later via Slack command) */
  async resolve(mention: string, context: string): Promise<{ entityId: string; action: 'linked' | 'created' }>
    // 1. Exact match: SELECT FROM entities WHERE name = mention
    // 2. Alias match: SELECT FROM entities WHERE mention = ANY(aliases)
    // 3. LLM disambiguation: prompt with candidates, context
    //    Response includes confidence score (0.0-1.0)
    //    If confidence >= 0.8 → link to candidate
    //    If confidence < 0.8 → create new entity
    // 4. No candidates at all: INSERT new entity, return 'created'

  /** Merge two entities (Slack command: !entity merge Tom Tom Smith) */
  async merge(sourceId: string, targetId: string): Promise<void>

  /** Split an entity alias into a new entity */
  async split(entityId: string, alias: string): Promise<string>
}
```

### 6.3 Key Sequence Diagrams

**Capture Flow (Slack → Pipeline → Stored)**:

```
User          SlackBot       CoreAPI      CaptureService    BullMQ     PipelineWorker    LiteLLM(embed)  LiteLLM(llm)    Postgres
 │               │              │              │              │              │                   │               │          │
 │──message──────►│              │              │              │              │                   │               │          │
 │               │──POST /captures─►            │              │              │                   │               │          │
 │               │              │──create()────►│              │              │                   │               │          │
 │               │              │              │──dedup check──────────────────────────────────────────────────────────────►│
 │               │              │              │◄────────────no dup────────────────────────────────────────────────────────│
 │               │              │              │──INSERT capture────────────────────────────────────────────────────────────►│
 │               │              │              │──enqueue()───►│              │                   │               │          │
 │               │              │◄─201 {id}────│              │              │                   │               │          │
 │               │◄─ack─────────│              │              │              │                   │               │          │
 │               │              │              │              │──process()──►│                   │               │          │
 │               │              │              │              │              │──embed()──────────►│               │          │
 │               │              │              │              │              │◄─vector[768]───────│               │          │
 │               │              │              │              │              │──UPDATE embedding──────────────────────────────►│
 │               │              │              │              │              │──check_triggers (in-memory)────────────────────►│
 │               │              │              │              │              │──extract()────────────────────────►│           │
 │               │              │              │              │              │◄─metadata──────────────────────────│           │
 │               │              │              │              │              │──UPDATE metadata───────────────────────────────►│
 │               │              │              │              │              │──UPDATE status=complete────────────────────────►│
 │◄─thread reply─│◄────────────notify stage────│              │              │                   │               │          │
```

**Search Flow (Hybrid + Temporal)**:

```
User       SlackBot     CoreAPI    SearchService   EmbeddingService   LiteLLM    Postgres       BullMQ
 │            │            │            │                │                 │          │              │
 │──? query──►│            │            │                │                 │          │              │
 │            │──POST /search─►         │                │                 │          │              │
 │            │            │──search()─►│                │                 │          │              │
 │            │            │            │──embed(query)─►│                 │          │              │
 │            │            │            │                │──POST /embeddings──────────►│              │
 │            │            │            │                │◄─vector[768]────│           │              │
 │            │            │            │──match_captures_hybrid(vector, text)─────────►│              │
 │            │            │            │◄─ranked results (RRF + temporal)─────────────│              │
 │            │            │            │──enqueue(update_access_stats)───────────────────────────►│
 │            │◄─results───│◄───────────│                │                 │          │              │
 │◄─formatted─│            │            │                │                 │          │              │
```

---

## 7. Authentication and Authorization

### 7.1 Design: No Auth (Single-User)

Open Brain is a single-user system. There is no authentication or authorization layer for the internal API. Security is enforced at the network level:

| Access Method | Security Layer |
|---------------|---------------|
| LAN (local) | Physical network access |
| Tailscale | Authenticated mesh VPN |
| Cloudflare Tunnel | API key for MCP endpoint only |

### 7.2 MCP Server API Key

The MCP server is the only endpoint exposed externally via Cloudflare Tunnel. It requires an API key:

```
Connection URL: https://brain.k4jda.net/mcp
Authentication: Authorization: Bearer <access_key>
```

- API key stored in Bitwarden, loaded at container startup
- Key validated on every request via Authorization header
- Invalid key → 401 Unauthorized
- Key rotation: see Operational Runbook — MCP API key rotation

### 7.3 Drizzle Studio (Development)

Drizzle Studio provides a web-based database browser for development. Run via `npx drizzle-kit studio` — accessible only via LAN/Tailscale. Not deployed in production containers.

---

## 8. Third-Party Integration Details

### 8.1 Slack Integration

**Purpose**: Primary bidirectional interface — capture thoughts, query the brain, run commands.

**Library**: `@slack/bolt` — official Slack app framework. Handles Socket Mode, events, commands, and actions in one package.

**Connection**: Socket Mode via Bolt constructor option (`socketMode: true`, `appToken: SLACK_APP_TOKEN`)

**Bot Token Scopes**:
- `channels:history` — Read channel messages
- `groups:history` — Read private channel messages
- `chat:write` — Send messages and replies
- `files:read` — Access voice clip attachments
- `app_mentions:read` — Respond to @mentions

**Event Subscriptions**:
- `message.channels` — Messages in public channels
- `message.groups` — Messages in private channels
- `app_mention` — @Open Brain mentions

**Intent Router Logic**:

```typescript
function classifyIntent(message: string): 'capture' | 'query' | 'command' {
  // Prefix-based classification (always works, fallback if LLM unavailable)
  if (message.startsWith('?')) return 'query';
  if (message.startsWith('!')) return 'command';
  if (message.startsWith('@Open Brain')) return 'query';

  // LLM-based classification (via LiteLLM → intent model alias)
  // Uses intent_router_v1 prompt template
  // Falls back to prefix-only if LiteLLM is unreachable (default-to-capture)

  return 'capture'; // Default: treat as capture (prevents data loss)
}
```

**Trigger Commands** (Phase 2):
- `/ob trigger add "QSR timeline"` — create trigger with default threshold (0.72) and 60-minute cooldown
- `/ob trigger list` — list all active triggers with last-fired time and fire count
- `/ob trigger delete [name or id]` — deactivate trigger
- `/ob trigger test "QSR timeline"` — run against existing captures, show top 5 matches (no notification sent)

**Thread Context**: Redis with 1-hour TTL, keyed by Slack `thread_ts`. Enables multi-turn query refinement within a thread. Expired threads prompt a new search.

**Error Handling**:
- Slack retries: Idempotent via `slack_ts` deduplication
- Socket Mode reconnection: Automatic with exponential backoff
- Bot ignores its own messages and other bot messages

### 8.2 Embedding Service (via LiteLLM)

**Purpose**: Embedding generation for all captures, triggers, and search queries. Routes exclusively through external LiteLLM at llm.k4jda.net using the `jetson-embeddings` alias (Qwen3-Embedding-4B-Q4_K_M on Jetson device). LLM inference also routes through LiteLLM — see §8.7.

**Embedding Model**: `jetson-embeddings` alias on LiteLLM → Qwen3-Embedding-4B-Q4_K_M running on Jetson device. Configured to produce 768d vectors. Supports instruction prefixes for asymmetric query/document embedding — EmbeddingService adds appropriate prefix based on type.

**API**: OpenAI embeddings API via LiteLLM (same endpoint as LLM inference)

```typescript
// Embedding generation via LiteLLM (OpenAI SDK — same client as AIRouterService)
import OpenAI from 'openai';
const litellm = new OpenAI({ baseURL: 'https://llm.k4jda.net', apiKey: process.env.LITELLM_API_KEY });
const model = configService.get('ai-routing').embedding.model; // 'jetson-embeddings'
const response = await litellm.embeddings.create({
  model: model,
  input: captureContent,  // With instruction prefix if model supports it
});
// response.data[0].embedding → number[768]
```

**Error Handling**:
- Embeddings: NO fallback. If LiteLLM/Jetson is unreachable, captures queue in BullMQ and retry. This prevents mixing embedding models which would degrade search quality.
- LLM tasks: Routed through LiteLLM, which handles fallback to cloud providers.

### 8.3 Anthropic API Integration (via LiteLLM)

**Purpose**: Synthesis, governance sessions, career signal extraction, weekly briefs

**Authentication**: Virtual API key stored in Bitwarden. Application code never touches provider API keys directly — all requests go through the shared LiteLLM proxy at `https://llm.k4jda.net`.

**Models Used** (accessed via LiteLLM model aliases):

| Task | LiteLLM Alias | Resolves To | Estimated Cost |
|------|---------------|-------------|----------------|
| Synthesis | `synthesis` | claude-sonnet-4-6 (fallback: gpt-4o) | ~$0.03-0.10/query |
| Governance | `governance` | claude-opus-4-6 (fallback: claude-sonnet) | ~$0.15-0.50/session |
| Career signals | `synthesis` | claude-sonnet-4-6 | ~$0.01/capture |
| Weekly brief | `synthesis` | claude-sonnet-4-6 | ~$0.10/brief |

**Budget Controls** (enforced by LiteLLM):
- Soft limit: $30/month → Pushover alert (via LiteLLM webhook alerting)
- Hard limit: $50/month → Circuit breaker (LiteLLM rejects requests, app falls back to local-only)
- Expected usage: ~$15-30/month
- Spend tracking: LiteLLM `/spend/logs` endpoint (source of truth for cost). Operational audit in `ai_audit_log` table.

### 8.4 Pushover Integration

**Purpose**: iPhone push notifications

**Authentication**: App token + user key from Bitwarden

```typescript
await fetch('https://api.pushover.net/1/messages.json', {
  method: 'POST',
  body: new URLSearchParams({
    token: PUSHOVER_APP_TOKEN,
    user: PUSHOVER_USER_KEY,
    title: 'Open Brain',
    message: 'Captured: decision — QSR pricing. People: Tom',
    priority: '-1', // low priority for captures
  }),
});
```

**Priority Levels**:

| Type | Priority | Behavior |
|------|----------|----------|
| Capture confirmed | -1 (Low) | Silent, no sound |
| Weekly brief ready | 0 (Normal) | Standard notification |
| Drift alert | 0 (Normal) | Standard notification |
| Bet expiring | 1 (High) | Bypasses quiet hours |
| Pipeline failure | 1 (High) | Bypasses quiet hours |
| System health issue | 2 (Emergency) | Repeats until acknowledged |
| AI budget soft limit | 0 (Normal) | Standard notification |

### 8.5 SMTP Email Integration

**Purpose**: HTML email delivery for weekly briefs and reports

**Authentication**: SMTP credentials from Bitwarden (personal email app password)

```typescript
import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: 587,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

await transporter.sendMail({
  from: '"Open Brain" <troy@k4jda.net>',
  to: 'troy@k4jda.net',
  subject: 'Weekly Brief — Mar 2-8, 2026',
  html: renderedHtmlBrief,  // React Email (@react-email/components) — type-safe, inline-CSS output
  text: plainTextFallback,  // Auto-generated by React Email render()
});
```

### 8.6 faster-whisper Integration

**Purpose**: Local speech-to-text transcription

**API**:

```typescript
// Transcribe audio file
const formData = new FormData();
formData.append('file', audioBuffer, 'recording.m4a');

const response = await fetch('http://faster-whisper:8000/transcribe', {
  method: 'POST',
  body: formData,
});
// { text: "transcript...", language: "en", duration: 120.5 }
```

**Configuration**: `large-v3` model, CPU int8, English default

### 8.7 LiteLLM Integration

**Purpose**: Unified LLM gateway for all non-embedding AI requests. Provides model aliasing, automatic fallback, budget tracking, and request logging.

**Deployment**: External shared service at `https://llm.k4jda.net`. Managed independently of Open Brain — not a container in Open Brain's Docker Compose stack. Model aliases (fast, synthesis, governance, intent) and provider routing are configured on the external server.

**Required model aliases** (must be configured on the external LiteLLM instance):

| Alias | Target | Fallback | Timeout |
|-------|--------|----------|---------|
| `fast` | TBD (local LLM via LiteLLM) | — | 30s |
| `intent` | TBD (local LLM via LiteLLM) | — | 10s |
| `synthesis` | anthropic/claude-sonnet-4-6 | openai/gpt-4o | 60s |
| `governance` | anthropic/claude-opus-4-6 | claude-sonnet-4-6 | 120s |

**Application Connection**:

```typescript
import OpenAI from 'openai';

// All LLM calls use OpenAI SDK pointed at external LiteLLM
const litellm = new OpenAI({
  baseURL: 'https://llm.k4jda.net',
  apiKey: process.env.LITELLM_API_KEY, // Virtual key from Bitwarden: dev/open-brain/litellm-api-key
});

// Usage: model name = LiteLLM alias
const response = await litellm.chat.completions.create({
  model: 'synthesis',  // Resolves to claude-sonnet, fallback: gpt-4o
  messages: [{ role: 'user', content: prompt }],
});
```

**Health Check**: `GET https://llm.k4jda.net/health` — returns model availability status.

**Spend Tracking**: `GET https://llm.k4jda.net/spend/logs` — returns detailed per-model spend for budget monitoring.

---

### 8.8 MCP Server Tools

**Purpose**: Allow Claude Desktop, Claude Code, ChatGPT, and other MCP clients to interact with the brain

**Architecture**: Embedded in Core API as a Hono route at `/mcp`. MCP tool handlers call service classes directly — no separate container, no HTTP proxy hop.

**Protocol**: Model Context Protocol via `@modelcontextprotocol/sdk`

**Transport**: Streamable HTTP (spec-recommended, future-proof). Exposed via Cloudflare Tunnel at `brain.k4jda.net/mcp`. Claude Desktop and Claude Code connect via HTTP (Tunnel or Tailscale IP). No stdio, no SSE.

**Tools**:

```typescript
const tools = [
  {
    name: 'search_brain',
    description: 'Semantic search across all captured thoughts and knowledge',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        limit: { type: 'number', default: 10 },
        threshold: { type: 'number', default: 0.5 },
        source_filter: { type: 'string' },
        tag_filter: { type: 'array', items: { type: 'string' } },
        brain_view: { type: 'string' },
        days: { type: 'number', description: 'Only search last N days' },
      },
      required: ['query'],
    },
  },
  {
    name: 'capture_thought',
    description: 'Write a new thought/capture into the brain',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        brain_views: { type: 'array', items: { type: 'string' } },
      },
      required: ['content'],
    },
  },
  {
    name: 'list_captures',
    description: 'Browse recent captures with optional filters',
    inputSchema: { /* limit, type, topic, person, days, source */ },
  },
  {
    name: 'brain_stats',
    description: 'Get statistics about the brain',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['day', 'week', 'month', 'all'], default: 'week' },
      },
    },
  },
  {
    name: 'get_entity',
    description: 'Get detail about a known entity (person, project)',
    inputSchema: { /* name or id */ },
  },
  {
    name: 'list_entities',
    description: 'List known entities (people, projects, decisions)',
    inputSchema: { /* type_filter, sort_by */ },
  },
  {
    name: 'get_weekly_brief',
    description: 'Retrieve the most recent weekly brief',
    inputSchema: {
      type: 'object',
      properties: {
        weeks_ago: { type: 'number', default: 0 },
      },
    },
  },
];
```

**Visibility of in-progress captures**: The `search_brain` tool filters on `pipeline_status = 'complete'`,
so captures currently processing are invisible to search. The `list_captures` tool shows all statuses.
Consider adding a `processing_count` field to the `brain_stats` response so MCP users know captures
are in-flight. Not a launch blocker — add if MCP users report confusion.

---

## 9. Error Handling Strategy

### 9.1 Error Hierarchy

```typescript
// src/shared/errors.ts

class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

class ValidationError extends AppError {
  constructor(details: Record<string, string>) {
    super('VALIDATION_ERROR', 'Invalid input', 400, details);
  }
}

class NotFoundError extends AppError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} not found: ${id}`, 404);
  }
}

class DuplicateCaptureError extends AppError {
  constructor(reason: string) {
    super('DUPLICATE_CAPTURE', `Duplicate capture: ${reason}`, 409);
  }
}

class ServiceUnavailableError extends AppError {
  constructor(service: string) {
    super('SERVICE_UNAVAILABLE', `${service} is unavailable`, 503);
  }
}

class AIBudgetExceededError extends AppError {
  constructor(current: number, limit: number) {
    super('AI_BUDGET_EXCEEDED', `Monthly AI budget exceeded: $${current}/$${limit}`, 429);
  }
}
```

### 9.2 Error Response Format

All API errors return consistent JSON:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": {
      "content": "Required field missing"
    }
  }
}
```

### 9.3 Pipeline Error Recovery

Pipeline stages use patient exponential backoff:

| Attempt | Delay | Cumulative Wait |
|---------|-------|----------------|
| 1 | 30 seconds | 30s |
| 2 | 2 minutes | 2m 30s |
| 3 | 10 minutes | 12m 30s |
| 4 | 30 minutes | 42m 30s |
| 5 | 2 hours | 2h 42m 30s |

After 5 failures:
- Stage marked as `failed` on the capture
- Capture's pipeline_status set to `partial` (if other stages succeeded) or `failed`
- Pushover alert sent (high priority)

**Daily auto-retry sweep**: A scheduled job runs daily, finds all captures with failed stages, and retries each failed stage once. This catches transient issues (LiteLLM/Jetson unreachable, network blip) that resolved after the initial retry window.

**Manual retry**: `POST /api/v1/captures/:id/retry?stage=extract_metadata`

---

## 10. Logging and Monitoring

### 10.1 Logging Strategy

**Approach**: Lean monitoring — structured JSON logs to stdout, Docker log aggregation, plus in-database audit trails.

**Log Format** (pino):
```json
{
  "level": "info",
  "time": 1709312456789,
  "msg": "Capture ingested",
  "service": "core-api",
  "captureId": "550e8400-...",
  "source": "slack",
  "pipelineStatus": "received"
}
```

**Log Levels**:

| Level | Usage |
|-------|-------|
| ERROR | Service failures, unhandled exceptions, pipeline stage final failures |
| WARN | LiteLLM/Jetson embedding unavailability, budget soft limit, retry attempts |
| INFO | Capture ingested, pipeline complete, skill executed, search performed |
| DEBUG | Embedding generation timing, AI router decisions, config reload |

### 10.2 In-Database Audit Trails

| Table | What It Tracks |
|-------|---------------|
| `pipeline_events` table | Per-capture processing history (stage, status, model, duration) — append-only |
| `skills_log` | Skill execution history (trigger, result, token usage) |
| `ai_audit_log` | Every AI API call (provider, model, tokens, latency, success). Cost tracking via LiteLLM only. |

### 10.3 Monitoring Approach

No dedicated monitoring stack (no Prometheus, no Grafana). Instead:

| Signal | Source | Alert |
|--------|--------|-------|
| Container health | Docker healthchecks + Unraid dashboard | Unraid notification |
| Pipeline failures | `pipeline_status = 'failed'` count | Pushover (high priority) |
| AI budget | LiteLLM `/spend/logs` endpoint | Pushover at $30 soft, circuit breaker at $50 |
| LiteLLM/Jetson down | Health endpoint check | Pushover (emergency) |
| Postgres down | Health endpoint check | Pushover (emergency) |
| Queue depth | BullMQ dashboard (Bull Board) | Log warning if depth > 50 |

**Health Endpoint**: `GET /health` checks Postgres, Redis, and LiteLLM connectivity.

**Future**: Dockhand under consideration for container lifecycle management.

---

## 11. Caching Strategy

### 11.1 Cache Architecture

```
                    ┌─────────────────┐
                    │      Redis      │
                    │                 │
                    │  Thread Context │  ← Slack thread conversation state
                    │  (1-hour TTL)   │     Key: thread:{thread_ts}
                    │                 │
                    │  Config Cache   │  ← Parsed YAML configs
                    │  (until reload) │     Key: config:{filename}
                    │                 │
                    │  BullMQ Queues  │  ← Job queue state
                    │                 │
                    └─────────────────┘
```

### 11.2 Cache Key Patterns

| Pattern | Example | TTL | Invalidation |
|---------|---------|-----|--------------|
| `thread:{thread_ts}` | `thread:1709312456.123456` | 1 hour | Auto-expire |
| `config:{filename}` | `config:pipelines.yaml` | Until reload | `POST /admin/reload-config` or per-job re-read |
| `budget:{month}` | `budget:2026-03` | 5 minutes | Refreshed on AI call |
| `health:{service}` | `health:litellm` | 30 seconds | Auto-expire |

### 11.3 Thread Context Implementation

```typescript
// src/slack-bot/thread-context.ts
import Redis from 'ioredis';

const THREAD_TTL = 3600; // 1 hour

interface ThreadContext {
  lastQuery: string;
  lastResults: string[];
  searchFilters: SearchFilters;
  messageCount: number;
}

async function getThreadContext(threadTs: string): Promise<ThreadContext | null> {
  const data = await redis.get(`thread:${threadTs}`);
  return data ? JSON.parse(data) : null;
}

async function setThreadContext(threadTs: string, context: ThreadContext): Promise<void> {
  await redis.set(`thread:${threadTs}`, JSON.stringify(context), 'EX', THREAD_TTL);
}

// In Slack query handler:
// If thread context is expired (getThreadContext returns null for a reply in a search thread):
// Reply: "This search has expired (1-hour timeout). Send a new query to search again."
// Do NOT treat as a capture — the user's intent was clearly a follow-up.
```

---

## 12. Background Jobs and Queue Processing

### 12.1 Queue Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    BullMQ (Redis)                        │
│                                                          │
│  ┌──────────────────┐  ┌──────────────────┐             │
│  │  capture-pipeline │  │  skill-execution  │             │
│  │                    │  │                    │             │
│  │  Jobs:             │  │  Jobs:             │             │
│  │  - embed           │  │  - weekly_brief    │             │
│  │  - extract_metadata│  │  - drift_monitor   │             │
│  │  - classify        │  │  - daily_connections│            │
│  │  - link_entities   │  │  - board_session   │             │
│  │  - evaluate_triggers│ │                    │             │
│  │  - notify          │  │                    │             │
│  └──────────────────┘  └──────────────────┘             │
│                                                          │
│  ┌──────────────────┐  ┌──────────────────┐             │
│  │  daily-sweep      │  │  notification     │             │
│  │  (scheduled)      │  │                    │             │
│  │                    │  │  Jobs:             │             │
│  │  Retries failed   │  │  - pushover        │             │
│  │  pipeline stages  │  │  - email           │             │
│  └──────────────────┘  │  - slack_reply      │             │
│                         └──────────────────┘             │
└─────────────────────────────────────────────────────────┘
```

### 12.2 Job Definitions

| Job Name | Queue | Priority | Timeout | Retries | Backoff |
|----------|-------|----------|---------|---------|---------|
| capture-pipeline | capture-pipeline | 5 (normal) | 5 min | 5 | Patient: 30s, 2m, 10m, 30m, 2h |
| update-access-stats | access-stats | 1 (low) | 10s | 1 | — |
| check-triggers | triggers | 5 (normal) | 10s | 1 | — |
| weekly-brief | skill-execution | 3 | 5 min | 3 | Exponential: 1m, 5m, 15m. On final failure: Pushover alert (high priority). Does not silently skip. |
| drift-monitor | skill-execution | 3 | 2 min | 3 | Exponential |
| daily-connections | skill-execution | 3 | 2 min | 3 | Exponential |
| daily-sweep | daily-sweep | 1 (low) | 30 min | 1 | — |
| pushover | notification | 7 (high) | 30s | 3 | Fixed: 5s |
| email | notification | 5 | 60s | 3 | Fixed: 30s |
| slack-reply | notification | 7 (high) | 10s | 3 | Fixed: 2s |

### 12.2a New Job Types

```typescript
// Job type: update_access_stats
// Triggered by: search result return (async, non-blocking)
// Priority: low (background)
interface UpdateAccessStatsJob {
  captureIds: string[];
  accessedAt: string; // ISO 8601
}
// Handler: increment access_count, set last_accessed_at for each ID
// Batch update in single SQL: UPDATE captures SET access_count = access_count + 1,
//   last_accessed_at = $1 WHERE id = ANY($2::uuid[])
//
// Note: If two searches return overlapping capture IDs and their access stats jobs
// execute concurrently, access_count is safe (atomic increment) but last_accessed_at
// could be set to a slightly earlier timestamp by a slower job. Acceptable for single-user.
//
// Failure handling: Log WARN on failure (temporal scoring degrades silently if stats
// aren't updated). Do not retry aggressively — stats are eventually consistent.

// Job type: check_triggers (Phase 2C)
// Architecture: Separate BullMQ job, NOT an inline pipeline stage.
// Triggered by: embed stage handler enqueues this job after successful embedding.
// This decouples trigger checking from the main pipeline — trigger failures don't affect capture processing.
// Priority: normal
interface CheckTriggersJob {
  captureId: string;
}
// Handler:
//   1. Load all active triggers from Redis cache (60s TTL, refresh from DB)
//   2. Get capture embedding from DB
//   3. For each active trigger not in cooldown:
//      a. Compute similarity: 1 - (capture.embedding <=> trigger.queryEmbedding)
//      b. If similarity >= trigger.threshold: fire trigger
//   4. Firing a trigger:
//      a. Run match_captures_hybrid() for the trigger query (limit 5, related captures)
//      b. Send Pushover/Slack notification with: trigger name, new capture summary, related captures
//      c. Update trigger: lastFiredAt = now(), fireCount++
//   5. All trigger checks run in parallel (Promise.all)
//   6. No trigger match = no-op; worker completes successfully
```

### 12.3 Pipeline Stage Executor

```typescript
// src/pipeline/executor.ts

interface StageDefinition {
  name: string;
  provider?: string;
  model?: string;
  prompt_template?: string;
  merge_with_pre_extracted?: boolean;
  targets?: string[];
}

async function executePipeline(captureId: string, stages: StageDefinition[]): Promise<void> {
  const capture = await db.select().from(captures).where(eq(captures.id, captureId));

  for (const stage of stages) {
    const startTime = Date.now();
    try {
      await executeStage(capture, stage);

      // Insert pipeline event (append-only table)
      await insertPipelineEvent(captureId, {
        stage: stage.name,
        status: 'complete',
        model: stage.model,
        duration_ms: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      await insertPipelineEvent(captureId, {
        stage: stage.name,
        status: 'failed',
        duration_ms: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        error: error.message,
      });

      // Don't block subsequent independent stages
      // embed failure blocks everything (no embedding = not searchable)
      // extract_metadata failure → continue to notify
      if (stage.name === 'embed') {
        throw error; // Bubbles up to BullMQ retry
      }
    }
  }

  // Mark pipeline complete (or partial if any stage failed)
  const hasFailures = /* check pipeline_events for failed stages */;
  await updatePipelineStatus(captureId, hasFailures ? 'partial' : 'complete');
}
```

### 12.4 Scheduled Jobs

```typescript
// src/workers/scheduler.ts
import { Queue, QueueScheduler } from 'bullmq';

// Weekly brief — Sunday 8:00 PM
await skillQueue.add('weekly-brief', {}, {
  repeat: { pattern: '0 20 * * 0' }, // cron: Sunday 8 PM
});

// Drift monitor — Monday 9:00 AM
await skillQueue.add('drift-monitor', {}, {
  repeat: { pattern: '0 9 * * 1' }, // cron: Monday 9 AM
});

// Daily connections — Daily 7:00 AM
await skillQueue.add('daily-connections', {}, {
  repeat: { pattern: '0 7 * * *' }, // cron: Daily 7 AM
});

// Daily sweep (retry failed stages) — Daily 3:00 AM
await sweepQueue.add('daily-sweep', {}, {
  repeat: { pattern: '0 3 * * *' }, // cron: Daily 3 AM
});

// Scheduled skill retry policy:
// If a scheduled skill fails (e.g., weekly brief on Sunday 8pm):
//   - BullMQ retries 3x with exponential backoff (1m, 5m, 15m) — already in job definition
//   - After 3 failures: Pushover alert (high priority) with error details
//   - Skill does NOT silently skip — it either succeeds or alerts
//   - Next scheduled run proceeds normally (the cron schedule is not affected by failures)
//   - Manual trigger always available: POST /api/v1/skills/:name/trigger
```

---

## 13. Real-Time Features

### 13.1 SSE from Core API (Phase 4)

For the web dashboard, Server-Sent Events (SSE) from the Core API provide live updates. Postgres LISTEN/NOTIFY triggers SSE broadcasts when captures are inserted or updated.

**Server (Hono SSE route)**:
```typescript
// src/core-api/routes/events.ts
import { streamSSE } from 'hono/streaming';

app.get('/api/v1/events', (c) => {
  return streamSSE(c, async (stream) => {
    // Subscribe to Postgres NOTIFY channel
    const pgListener = await db.listen('capture_changes');

    pgListener.on('notification', async (msg) => {
      const payload = JSON.parse(msg.payload);
      await stream.writeSSE({
        event: payload.event, // 'capture_created' | 'pipeline_complete' | 'session_update'
        data: JSON.stringify(payload.data),
      });
    });

    stream.onAbort(() => pgListener.unlisten());
  });
});
```

**Client (React hook)**:
```typescript
// web/src/hooks/useRealtimeCaptures.ts
function useRealtimeCaptures() {
  const [captures, setCaptures] = useState<Capture[]>([]);

  useEffect(() => {
    const es = new EventSource('/api/v1/events');
    es.addEventListener('capture_created', (e) => {
      setCaptures(prev => [JSON.parse(e.data), ...prev]);
    });
    return () => es.close();
  }, []);

  return captures;
}
```

This is used for:
- Dashboard: Live capture feed
- Pipeline status: Live processing indicators
- Session updates: Governance session progress

---

## 14. Web Dashboard (Phase 4)

### 14.1 Architecture

```
┌──────────────────────────────────────────┐
│           Vite + React PWA               │
│                                          │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  │
│  │  Pages  │  │  Hooks  │  │  Store  │  │
│  │         │  │         │  │(Zustand)│  │
│  └────┬────┘  └────┬────┘  └────┬────┘  │
│       └──────────────┼──────────┘        │
│                      │                    │
│              ┌───────▼──────┐            │
│              │  API Client  │            │
│              │  (fetch)     │            │
│              └───────┬──────┘            │
│                      │                    │
└──────────────────────┼───────────────────┘
                       │
              Core API (Hono) :3000
```

**Tech Stack**:
- Vite (build tool)
- React 19
- Tailwind CSS + shadcn/ui
- vite-plugin-pwa (PWA support)
- Zustand (state management — lightweight, no boilerplate)
- EventSource (SSE) for real-time updates from Core API

**Pages**:

| Page | Route | Purpose |
|------|-------|---------|
| Dashboard | `/` | Recent captures, stats, active bets, system health |
| Search | `/search` | Semantic search with filters |
| Timeline | `/timeline` | Chronological capture browser |
| Entity Browser | `/entities` | People, projects, decisions |
| Briefs | `/briefs` | Weekly brief history |
| Board | `/board` | Governance sessions, bets |
| Voice | `/voice` | MediaRecorder-based voice capture |
| Settings | `/settings` | Pipeline config, skill schedules, AI routing |

### 14.2 PWA Configuration

```typescript
// vite.config.ts
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Open Brain',
        short_name: 'Brain',
        theme_color: '#1a1a2e',
        icons: [/* app icons */],
      },
    }),
  ],
});
```

---

## 15. Testing Strategy

### 15.1 Test Coverage Requirements

| Type | Coverage Target | Focus Areas |
|------|-----------------|-------------|
| Unit | 80% | Service classes, validation, AI router logic, pipeline stages |
| Integration | 60% | API endpoints, database queries, BullMQ jobs |
| E2E | Critical paths | Capture → search, Slack message → stored capture |

### 15.2 Test Framework

- **Test runner**: Vitest (fast, Vite-native, TypeScript-first)
- **Database**: Testcontainers (Postgres + pgvector) for integration tests
- **Mocking**: Vitest built-in mocks for LiteLLM, Slack, external APIs

### 15.3 Unit Test Examples

```typescript
// src/core-api/__tests__/capture-service.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('CaptureService', () => {
  describe('create', () => {
    it('should reject duplicate slack captures by slack_ts', async () => {
      const db = createMockDb();
      db.select.mockResolvedValue([{ id: 'existing' }]); // existing capture

      const service = new CaptureService(db, mockPipeline, mockConfig);

      await expect(
        service.create({
          content: 'duplicate message',
          source: 'slack',
          source_metadata: { slack_ts: '1709312456.123456' },
        })
      ).rejects.toThrow(DuplicateCaptureError);
    });

    it('should enqueue pipeline job after successful insert', async () => {
      const db = createMockDb();
      db.select.mockResolvedValue([]); // no duplicates
      db.insert.mockResolvedValue({ id: 'new-capture-id' });

      const mockPipeline = { enqueue: vi.fn() };
      const service = new CaptureService(db, mockPipeline, mockConfig);

      await service.create({
        content: 'new thought',
        source: 'slack',
      });

      expect(mockPipeline.enqueue).toHaveBeenCalledWith('new-capture-id', 'default');
    });
  });
});
```

```typescript
// src/ai-router/__tests__/ai-router.test.ts
describe('AIRouterService', () => {
  it('should route task type to correct LiteLLM model alias', async () => {
    const router = new AIRouterService(mockConfig, mockDb, mockLitellm);

    await router.complete('synthesis', 'summarize everything');

    expect(mockLitellm.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'synthesis' }) // LiteLLM handles provider routing
    );
  });

  it('should map metadata_extraction to fast alias', async () => {
    const router = new AIRouterService(mockConfig, mockDb, mockLitellm);

    await router.complete('metadata_extraction', 'classify this text');

    expect(mockLitellm.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'fast' })
    );
  });

  it('should log usage to ai_audit_log table after completion', async () => {
    const router = new AIRouterService(mockConfig, mockDb, mockLitellm);
    mockLitellm.chat.completions.create.mockResolvedValue({
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    await router.complete('synthesis', 'summarize');

    expect(mockDb.insert).toHaveBeenCalledWith(expect.objectContaining({
      provider: expect.any(String),
      tokensIn: 100,
      tokensOut: 50,
    }));
  });
});
```

### 15.4 Integration Test Examples

```typescript
// src/core-api/__tests__/captures-api.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GenericContainer } from 'testcontainers';

describe('Captures API Integration', () => {
  let pgContainer;
  let app;

  beforeAll(async () => {
    pgContainer = await new GenericContainer('pgvector/pgvector:pg16')
      .withExposedPorts(5432)
      .start();
    app = await createTestApp(pgContainer.getConnectionUri());
  });

  afterAll(async () => {
    await pgContainer.stop();
  });

  it('should create a capture and return 201', async () => {
    const response = await app.request('/api/v1/captures', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Test thought about architecture',
        source: 'api',
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.id).toBeDefined();
    expect(body.status).toBe('received');
  });

  it('should perform semantic search after pipeline completes', async () => {
    // Insert capture with pre-computed embedding
    // ...
    const response = await app.request('/api/v1/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'architecture' }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results[0].similarity).toBeGreaterThan(0.5);
  });
});
```

### 15.5 E2E Test Scenarios

| Scenario | Steps | Expected Result |
|----------|-------|-----------------|
| Slack capture → searchable | 1. Send message to #open-brain, 2. Wait for pipeline, 3. Search via API | Capture found with >0.8 similarity |
| MCP search | 1. Create captures, 2. Call search_brain via MCP, 3. Verify results | Relevant results returned |
| Pipeline retry | 1. Create capture, 2. Simulate LiteLLM/Jetson unavailability, 3. Restore LiteLLM connectivity, 4. Wait for retry | Capture eventually completes |
| Deduplication | 1. Send same slack_ts twice | Second attempt returns 409 |
| Budget circuit breaker | 1. Exhaust budget via LiteLLM, 2. Attempt synthesis | Returns 429 |
| Hybrid search recall | 1. Create capture with specific keywords, 2. Search with paraphrased query, 3. Search with exact keywords | Both find the capture (RRF fuses both arms) |
| Temporal scoring | 1. Create two similar captures, 2. Search to access one, 3. Search again | Previously-accessed capture ranks higher |
| Semantic trigger fire | 1. Create trigger "QSR timeline", 2. Ingest matching capture | Pushover fires within pipeline window |

---

## 16. Deployment

### 16.1 Docker Compose

```yaml
# docker-compose.yml

networks:
  open-brain:
    driver: bridge

services:
  # ──── Database ────

  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    ports:
      - "5432:5432"
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: open_brain
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
      - ./config/postgresql.conf:/etc/postgresql/postgresql.conf:ro
    command: postgres -c config_file=/etc/postgresql/postgresql.conf
    networks:
      - open-brain
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 8G

  # Postgres tuning (config/postgresql.conf):
  # shared_buffers = 2GB, effective_cache_size = 6GB, work_mem = 64MB,
  # maintenance_work_mem = 512MB (critical for pgvector HNSW index builds),
  # max_connections = 20, random_page_cost = 1.1 (SSD), wal_buffers = 64MB,
  # checkpoint_completion_target = 0.9
  # ──── Application Stack ────

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - ./data/redis:/data
    networks:
      - open-brain
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

  # Ollama: NOT in Open Brain stack. Embeddings (jetson-embeddings) and LLM inference both route through external LiteLLM at https://llm.k4jda.net.
  # LiteLLM is an external shared service at https://llm.k4jda.net — no container here.

  faster-whisper:
    image: fedirz/faster-whisper-server:0.4.1  # Pin version — verify API compat during Phase 2
    restart: unless-stopped
    environment:
      WHISPER__MODEL: large-v3
      WHISPER__DEVICE: cpu
      WHISPER__COMPUTE_TYPE: int8
    volumes:
      - ./data/whisper-models:/root/.cache/huggingface
    networks:
      - open-brain
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:
          memory: 8G

  core-api:
    build:
      context: .
      dockerfile: Dockerfile
      target: core-api
    # Entrypoint runs: npx drizzle-kit migrate && node dist/server.mjs
    # Migrations are automatic on container start — no manual step needed.
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file: .env.secrets  # Generated by startup script via bws CLI (gitignored, chmod 600)
    environment:
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/open_brain
      REDIS_URL: redis://redis:6379
      LITELLM_URL: https://llm.k4jda.net
      LITELLM_API_KEY: ${LITELLM_API_KEY}
      MCP_API_KEY: ${MCP_API_KEY}  # MCP embedded at /mcp route
    volumes:
      - ./config:/app/config:ro
    # Includes: Bull Board at /admin/queues (@bull-board/hono), MCP at /mcp (@modelcontextprotocol/sdk)
    networks:
      - open-brain
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  slack-bot:
    build:
      context: .
      dockerfile: Dockerfile
      target: slack-bot
    restart: unless-stopped
    environment:
      SLACK_BOT_TOKEN: ${SLACK_BOT_TOKEN}
      SLACK_APP_TOKEN: ${SLACK_APP_TOKEN}
      CORE_API_URL: http://core-api:3000
      REDIS_URL: redis://redis:6379
      LITELLM_URL: https://llm.k4jda.net      # Shared external LiteLLM proxy
      LITELLM_API_KEY: ${LITELLM_API_KEY}     # Virtual key from Bitwarden
    networks:
      - open-brain
    depends_on:
      - core-api

  # MCP server is embedded in core-api at /mcp (no separate container)

  workers:
    build:
      context: .
      dockerfile: Dockerfile
      target: workers
    restart: unless-stopped
    environment:
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/open_brain
      REDIS_URL: redis://redis:6379
      CORE_API_URL: http://core-api:3000
      LITELLM_URL: https://llm.k4jda.net
      LITELLM_API_KEY: ${LITELLM_API_KEY}
      PUSHOVER_APP_TOKEN: ${PUSHOVER_APP_TOKEN}
      PUSHOVER_USER_KEY: ${PUSHOVER_USER_KEY}
      SMTP_HOST: ${SMTP_HOST}
      SMTP_USER: ${SMTP_USER}
      SMTP_PASS: ${SMTP_PASS}
    volumes:
      - ./config:/app/config:ro
    networks:
      - open-brain
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy

  # ──── Cloudflare Tunnel ────

  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARE_TUNNEL_TOKEN}
    networks:
      - open-brain
    depends_on:
      - core-api
    # Routes: brain.k4jda.net/mcp → core-api:3000/mcp, brain.k4jda.net/ → web-ui:80 (Phase 4)

  # ──── Phase 2: Voice Capture ────

  voice-capture:
    build:
      context: .
      dockerfile: Dockerfile
      target: voice-capture  # Migrated into monorepo as packages/voice-capture/
    restart: unless-stopped
    environment:
      WHISPER_URL: http://faster-whisper:8000
      OPEN_BRAIN_API_URL: http://core-api:3000/api/v1/captures
      PUSHOVER_APP_TOKEN: ${PUSHOVER_APP_TOKEN}
      PUSHOVER_USER_KEY: ${PUSHOVER_USER_KEY}
    volumes:
      - ./data/voice-inbox:/app/inbox
    networks:
      - open-brain
    depends_on:
      - core-api
      - faster-whisper

  # rclone not needed for voice memos — Apple Watch/iPhone Shortcut posts directly to voice-capture API.
  # rclone deferred to Phase 4 for document ingestion sync (OneDrive, Google Drive, iCloud Drive).

  # ──── Phase 4: Web UI ────

  web-ui:
    build:
      context: ./web
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      - "3002:80"
    networks:
      - open-brain
    depends_on:
      - core-api
```

### 16.2 Docker Network Topology

```
open-brain (single network)
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  postgres     redis       faster-whisper                 │
│  core-api     slack-bot   workers                        │
│  voice-capture web-ui     cloudflared                    │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

- Single `open-brain` network — no Supabase, no multi-network complexity
- Only `core-api` (:3000) and `web-ui` (:3002) expose host ports — LiteLLM is external at `https://llm.k4jda.net`
- MCP embedded in core-api at `/mcp` — no separate container
- `cloudflared` routes external traffic from `brain.k4jda.net` to `core-api` (path-based: `/mcp` for MCP, `/` for Web UI in Phase 4)

### 16.3 Environment Configuration

```bash
# .env (non-sensitive — committed to repo with placeholders)

# Database
POSTGRES_PASSWORD=  # From Bitwarden: dev/open-brain/postgres

# LiteLLM (external shared proxy at https://llm.k4jda.net)
LITELLM_API_KEY=    # bws get dev/open-brain/litellm-api-key  (virtual key issued by shared LiteLLM instance)

# Slack — retrieve from Bitwarden
SLACK_BOT_TOKEN=    # bws get dev/open-brain/slack-bot-token
SLACK_APP_TOKEN=    # bws get dev/open-brain/slack-app-token

# MCP
MCP_API_KEY=        # bws get dev/open-brain/mcp-api-key

# Notifications — retrieve from Bitwarden
PUSHOVER_APP_TOKEN= # bws get dev/open-brain/pushover-app-token
PUSHOVER_USER_KEY=  # bws get dev/open-brain/pushover-user-key

# Email — retrieve from Bitwarden
SMTP_HOST=smtp.gmail.com
SMTP_USER=          # bws get dev/open-brain/smtp-user
SMTP_PASS=          # bws get dev/open-brain/smtp-pass

# Cloudflare
CLOUDFLARE_TUNNEL_TOKEN= # bws get dev/open-brain/cloudflare-tunnel-token

# Non-sensitive config
NODE_ENV=production
LOG_LEVEL=info
```

### 16.4 Startup Sequence

```bash
# 1. Retrieve secrets from Bitwarden → .env.secrets (gitignored, chmod 600)
bws secret list | jq -r '.[] | select(.key | startswith("dev/open-brain/")) | "\(.key | split("/") | last | ascii_upcase | gsub("-";"_"))=\(.value)"' > .env.secrets
chmod 600 .env.secrets

# 2. Start infrastructure
docker compose up -d postgres redis

# 3. Wait for healthy
docker compose exec postgres pg_isready

# 4. Migrations run automatically via core-api entrypoint script (no manual step needed)

# 5. Verify external LiteLLM proxy is reachable and jetson-embeddings alias works
curl https://llm.k4jda.net/health  # External shared LiteLLM — not managed by this stack

# 6. Start application stack
docker compose up -d

# 7. Verify health
curl http://localhost:3000/health
```

### 16.5 Backup Strategy

```bash
# Daily pg_dump (via cron on Unraid, 7-day local retention)
#!/bin/bash
BACKUP_DIR=/mnt/user/backups/open-brain
DATE=$(date +%Y%m%d)
docker compose exec -T postgres pg_dump -U postgres open_brain | gzip > $BACKUP_DIR/open_brain_$DATE.sql.gz
find $BACKUP_DIR -name "*.sql.gz" -mtime +7 -delete

# Weekly offsite to Google Drive via rclone (30-day cloud retention)
rclone copy $BACKUP_DIR gdrive:Backups/open-brain/ --max-age 7d
rclone delete gdrive:Backups/open-brain/ --min-age 30d
```

---

## 17. Feature Flags and Rollout Strategy

### 17.1 Approach

No feature flag service — single user, phased deployment. Features enabled by:
1. Adding containers to `docker-compose.yml`
2. Adding pipeline stages to `pipelines.yaml`
3. Adding skills to `skills.yaml`

### 17.2 Phase Rollout Checklist

**Phase 1A: Data Layer**
- [ ] Postgres (pgvector/pgvector:pg16) running, pgvector enabled, postgresql.conf tuned
- [ ] Drizzle schema applied (captures table with access_count, last_accessed_at, content_hash)
- [ ] Core API scaffold: Hono app, health endpoint, Zod validation
- [ ] Capture CRUD: POST, GET, LIST, PATCH, DELETE endpoints functional
- [ ] DELETE capture soft-deletes, excluded from search/list results
- [ ] Stats endpoint returning capture counts
- [ ] Health endpoint reporting Postgres status
- [ ] Vitest unit + Testcontainers integration tests passing

**Phase 1B: Embedding + Search**
- [ ] LiteLLM jetson-embeddings alias reachable and returning 768d vectors
- [ ] Actual embedding throughput measured and documented (update TDD Section 4.5 estimates)
- [ ] Embedding quality validated with 50+ real captures
- [ ] match_captures (vector + temporal) function deployed
- [ ] FTS GIN index created on captures.content
- [ ] match_captures_hybrid (RRF) function deployed
- [ ] Search endpoint functional (all three modes: hybrid, vector, fts)
- [ ] update_access_stats background job working

**Phase 1C: Pipeline + LLM Gateway**
- [ ] Redis running
- [ ] External LiteLLM reachable with model aliases (fast, synthesis, governance, intent) and budget configured
- [ ] AI Router routing all requests (embeddings + LLM) through external LiteLLM
- [ ] Pipeline stages: embed → extract_metadata → notify (stub)
- [ ] Pipeline retry logic: patient backoff (30s, 2m, 10m, 30m, 2h)
- [ ] Bull Board at /admin/queues functional
- [ ] Captures auto-process to pipeline_status = 'complete'

**Phase 1D: Slack Bot**
- [ ] Slack bot connected via Socket Mode
- [ ] Text capture: message → Core API → pipeline → thread reply
- [ ] Query: ? prefix → hybrid search → formatted results
- [ ] Intent router: prefix-only classification working
- [ ] Thread context: Redis TTL, follow-up interactions
- [ ] Deduplication: duplicate slack_ts rejected
- [ ] LLM intent classification added (via LiteLLM)

**Phase 1E: MCP + External Access**
- [ ] MCP embedded at /mcp with all 7 tools functional
- [ ] Authorization: Bearer header authentication working
- [ ] Cloudflare Tunnel routing brain.k4jda.net → core-api
- [ ] Claude Desktop connects and queries successfully
- [ ] Invalid API key returns 401

**Phase 2A: Voice Pipeline**
- [ ] faster-whisper container running, transcription working
- [ ] voice-capture migrated to monorepo, posting to Core API
- [ ] iOS Shortcut → voice-capture → brain pipeline functional
- [ ] Audio formats tested: .m4a, .wav, .mp3

**Phase 2B: Notifications + Output Skills**
- [ ] Pushover notifications for all priority levels
- [ ] Email delivery for weekly briefs (HTML + plain text)
- [ ] Weekly brief skill generating on schedule (Sunday 8pm)
- [ ] Slack commands: !stats, !brief, !recent, !help functional
- [ ] Brief captured back into brain for searchability

**Phase 2C: Semantic Triggers**
- [ ] Triggers table created, CRUD API functional
- [ ] check_triggers BullMQ job: fires after embed stage
- [ ] Trigger notifications via Pushover/Slack
- [ ] Slack commands: /ob trigger add/list/delete/test
- [ ] Cooldown enforcement (default 60 min)
- [ ] In-memory trigger comparison <10ms for ≤20 triggers

**Phase 3: Intelligence**
- [ ] Entity graph (entities, entity_links tables with UNIQUE constraints)
- [ ] Entity auto-extraction from captures (3-tier resolution)
- [ ] Governance sessions (sessions table, LLM-driven flow)
- [ ] Bet tracking (bets table, expiration alerts)
- [ ] Drift monitor skill
- [ ] Daily connections skill

**Phase 4: Polish**
- [ ] Web dashboard (all pages functional)
- [ ] PWA installable on iPhone
- [ ] SSE from Core API for live updates (Postgres LISTEN/NOTIFY)
- [ ] Document ingestion (PDF, docx via rclone)
- [ ] URL/bookmark capture
- [ ] Calendar integration (iCal feeds, config-driven)

---

## 18. Performance Optimization

### 18.1 Performance Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| Capture ingest API response | <500ms | API response time (async pipeline) |
| Full text pipeline | <30s | Pipeline completion time |
| Full voice pipeline (excl. rclone) | <90s | Pipeline completion time |
| Semantic search | <5s | API response time (embed query + pgvector) |
| Synthesis query | <30s | API response time (search + AI completion) |
| Weekly brief generation | <2 min | Skill execution time |
| MCP tool response | <5s | Tool execution time |
| Web dashboard page load | <2s | Time to interactive |
| Embedding generation | <2s | LiteLLM API call to Jetson |
| Metadata extraction | <5s | LLM completion time |

### 18.2 Optimization Strategies

| Area | Strategy | Details |
|------|----------|---------|
| Embedding | Single model, no fallback | Consistent vector space, no mixing |
| Search | Hybrid retrieval (FTS + vector + RRF) | Best-of-both recall; FTS catches keyword matches, vector catches paraphrases |
| Search | ACT-R temporal scoring | Recency + frequency signals computed from indexed columns (<5ms overhead) |
| Database | HNSW index for vectors | Approximate nearest neighbor, faster than IVFFlat at query time |
| Database | GIN indexes on jsonb/arrays/tsvector | Fast filtered queries on metadata, tags, brain_views, and full-text search |
| Pipeline | Async processing | API returns immediately, pipeline runs in background |
| Pipeline | Stage independence | Failed stages don't block others (except embed) |
| Search | Configurable threshold | Skip low-similarity results, reduce result set |
| Caching | Redis thread context | Avoid re-embedding for follow-up queries in same thread |
| Config | Per-job YAML reload | No restart needed for config changes |
| Web UI | Vite code splitting | Lazy load pages, minimize initial bundle |
| Web UI | PWA caching | Service worker caches static assets |

### 18.3 HNSW Index Tuning

```sql
-- Default HNSW parameters (good starting point for <100K vectors)
CREATE INDEX ON captures USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Query-time parameter (set per session for search quality vs speed)
SET hnsw.ef_search = 40; -- default, increase for better recall
```

For the expected scale (<100K captures), default HNSW parameters should be sufficient. Re-tune if:
- Search recall drops below 95% on manual testing
- Search latency exceeds 2 seconds

## 18.5 Capacity Planning

Expected scale for a single-user personal knowledge system.

| Resource | Current Estimate | Worry Threshold | Action at Threshold |
|----------|-----------------|----------------|-------------------|
| Captures | 50/day, ~18K/year | 100K total | Re-tune HNSW (increase m, ef_construction). Consider IVFFlat if HNSW build time grows. |
| Postgres disk | ~4KB/capture (1KB content + 3KB embedding) | 1GB (~250K captures) | Non-issue for 32TB array. Add table partitioning by year if queries slow. |
| Redis memory | ~100 bytes/job, ~1KB/thread context | 1GB | Non-issue. Check for orphaned BullMQ jobs if memory grows unexpectedly. |
| Jetson (external) | N/A — managed on Jetson device | N/A | If Jetson is overloaded, embeddings queue in BullMQ. Monitor via LiteLLM dashboard. |
| Embedding generation | 1/sec (137M) to 0.1/sec (8B) | >20 captures/minute sustained | Batch embedding endpoint, or queue accepts latency. Unlikely for single user. |
| LiteLLM | <100 requests/day | 1000/day | Non-issue. LiteLLM handles thousands of RPM. |
| Postgres connections | ~5 active (API + workers + bot) | 20 (max_connections) | Increase max_connections. Consider PgBouncer if services scale. |
| Backup size | ~70MB/year | 1GB | Non-issue. Compressed backups are small. |

**HNSW Index Tuning Reference**:
- Default params (`m=16, ef_construction=64`) good to ~100K vectors
- At 100K: increase to `m=24, ef_construction=128` for better recall
- `ef_search` (query-time): start at 40, increase to 100 if recall drops below 95%
- Rebuild index: `REINDEX INDEX idx_captures_embedding;` (~10 min at 100K)

---

## 19. Security Implementation

### 19.1 Security Model

Single-user system — security is network-level, not application-level.

| Layer | Control |
|-------|---------|
| Network | LAN + Tailscale (authenticated mesh VPN) |
| External access | Cloudflare Tunnel → API key for MCP only |
| Secrets | Bitwarden Secrets Manager, never in files |
| Database | Password-protected, not exposed to host network |
| Drizzle Studio | Dev-only, LAN/Tailscale access |
| Docker | Containers on internal networks, minimal port exposure |

### 19.2 Security Controls

| Control | Implementation |
|---------|---------------|
| Input validation | Zod schemas on all API inputs |
| SQL injection | Drizzle ORM parameterized queries (never raw string interpolation) |
| Secret management | Bitwarden → env vars at startup, never in config files |
| API key rotation | See Operational Runbook — MCP API key rotation |
| Container isolation | Single Docker network, minimal host port exposure |
| Data integrity | Soft delete only, immutable captures, pipeline audit trail |

### 19.3 Sensitive Data Handling

| Data Type | Storage | Handling |
|-----------|---------|----------|
| Capture content | Postgres (plaintext) | Network-secured, no at-rest encryption. Physical + network security sufficient for personal server. Offsite backups encrypted via rclone crypt. |
| API keys (Anthropic, OpenAI, etc.) | Bitwarden | Loaded as env vars, never logged |
| Slack tokens | Bitwarden | Loaded as env vars |
| Embeddings | Postgres (vector column) | Same protection as capture content |
| Pipeline events | Postgres (pipeline_events table) | May contain model names, not secrets |

### 19.4 Security Checklist

- [x] No hardcoded secrets
- [x] Parameterized queries (Drizzle ORM)
- [x] Input validation (Zod)
- [x] Network-level access control (Tailscale)
- [x] API key for external MCP access
- [x] Minimal container port exposure
- [ ] HTTPS on all external endpoints (via Cloudflare Tunnel)
- [ ] Rate limiting on MCP endpoint (not needed for single-user — API key sufficient)

---

## Appendices

### A. Glossary

| Term | Definition |
|------|-----------|
| Capture | Any piece of information ingested into the brain |
| Brain | The entire knowledge store (Postgres + pgvector) |
| Brain View | Tag-based filter grouping captures (career, personal, technical, work-internal, client) |
| Pipeline | Async processing chain: embed → extract → notify |
| Stage | Single step in a pipeline |
| Output Skill | Scheduled/triggered AI synthesis process (weekly brief, governance) |
| Entity | Known person, project, decision, bet, or concept |
| Intent Router | Slack message classifier (capture vs. query vs. command) |
| AI Router | Thin application service mapping task types to LiteLLM model aliases — both LLM inference and embeddings route through external LiteLLM |
| LiteLLM | External shared proxy at llm.k4jda.net providing unified OpenAI-compatible API for embeddings and all LLM providers |
| Hybrid Search | FTS + vector search fused via Reciprocal Rank Fusion (RRF) |
| ACT-R Temporal Decay | Cognitive model scoring captures by access recency and frequency |
| Semantic Trigger | Persistent pattern that fires notifications when new captures match semantically |
| Governance Session | Structured multi-turn career review interaction |
| Bet | 90-day falsifiable prediction from governance sessions |
| MCP | Model Context Protocol — open standard for AI tool integration |

### B. Configuration File Specs

**pipelines.yaml** — Pipeline stage definitions per source/view. See PRD Section 5.2 (F03) for full spec.

**ai-routing.yaml** — Embedding config + task-to-LiteLLM-alias mapping. See PRD Section 5.2 (F08).

**skills.yaml** — Output skill definitions, schedules, delivery targets.

**brain-views.yaml** — View definitions, auto-classification rules, pipeline routing.

**notifications.yaml** — Notification target configs, priority levels, quiet hours.

### C. Prompt Templates

| Template | Phase | Purpose |
|----------|-------|---------|
| `extract_metadata_v1.txt` | 1 | Extract people, topics, type, action_items, dates, brain_views as structured JSON |
| `intent_router_v1.txt` | 1 | Classify Slack messages as capture/query/command |
| `career_signals_v1.txt` | 2 | Extract career-relevant signals from captures |
| `extract_client_signals_v1.txt` | 2 | Client brain view pipeline processing |
| `weekly_brief_v1.txt` | 2 | Generate weekly synthesis brief |
| `synthesis_v1.txt` | 2 | Ad-hoc synthesis prompt |
| `board_quick_check_v1.txt` | 3 | 5-question governance audit |
| `board_quarterly_v1.txt` | 3 | Full quarterly review |

**Template Format**: Plain text with `{{variable}}` Mustache-style placeholders. Two-section format using `---SYSTEM---` and `---USER---` delimiters. Simple regex replacement (`template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key])`), no template engine dependency.

Example:
```
---SYSTEM---
You are a metadata extraction assistant for a personal knowledge base.
Brain views available: {{brain_views}}

---USER---
Extract metadata from this capture:

Source: {{source}}
Content: {{content}}

Return JSON with: summary, tags, brain_views, entities.
```

Templates are versioned (`v1`, `v2`, `v3`), stored in `config/prompts/`, hot-reloadable via config re-read (workers re-read per job, Core API via admin reload endpoint).

### D. Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-03-04 | Initial TDD based on PRD v0.2 | Troy Davis / Claude |
| 2026-03-04 | All 32 questions resolved, Supabase removed, MCP embedded, rclone deferred | Troy Davis / Claude |
| 2026-03-05 | v0.3: Added LiteLLM as unified LLM gateway (simplified AIRouterService). Made embedding model configurable (evaluating Qwen3-Embedding). Added cognitive retrieval: ACT-R temporal decay scoring (access_count/last_accessed_at columns), hybrid search with RRF (FTS GIN index + match_captures_hybrid function), semantic push triggers (triggers table, check_triggers pipeline stage, Slack commands). Based on MuninnDB cognitive retrieval analysis. | Troy Davis / Claude |
| 2026-03-05 | v0.4: Architectural review applied. Restructured into 10 sub-phases (1A-1E, 2A-2C, 3, 4) with explicit test gates. Fixed: Zod brain_views validation (config-driven, not hardcoded), MCP auth (Authorization header), slack-bot LiteLLM access, check_triggers as separate BullMQ job, temporal scoring standardized (multiplicative boost), entity/trigger UNIQUE constraints, entity_links ON DELETE CASCADE. Added: PATCH captures endpoint, search pagination, cold start temporal_weight (default 0.0), operational runbook, capacity planning. | Troy Davis / Claude |
| 2026-03-05 | v0.5: Architectural review v2. Fixed composite score formula (multiplicative boost in PRD), extracted pipeline_log→pipeline_events table, session transcript→session_messages table, removed linked_entities denorm from captures, added DELETE captures endpoint, fixed temporal_weight default (0.0), BrainView→config-driven string, ai_usage→ai_audit_log (dropped cost_estimate), entity resolution confidence threshold (0.8), MCP key rotation runbook, config Zod validation, scheduled skill retry policy, thread expiration UX, migration-at-startup entrypoint, Ollama CPU benchmark requirement, content_hash window configurability, MCP in-progress capture visibility note. | Troy Davis / Claude |

### E. Operational Runbook

Common failure scenarios and resolution steps.

**LiteLLM/Jetson embedding unavailable (embeddings queuing)**
1. Check LiteLLM health: `curl https://llm.k4jda.net/health`
2. Check jetson-embeddings alias: `curl -H "Authorization: Bearer $LITELLM_API_KEY" https://llm.k4jda.net/v1/models`
3. If Jetson device is down, wait for it to recover — embeddings queue in BullMQ with patient backoff
4. Captures will auto-retry via BullMQ backoff. Check Bull Board for queue depth.
5. If LiteLLM configuration issue, check LiteLLM admin panel at llm.k4jda.net

**LiteLLM can't reach LLM providers**
1. Check LiteLLM health: `curl https://llm.k4jda.net/health`
2. Check API keys configured on external LiteLLM server
3. LiteLLM auto-falls back (synthesis → gpt-4o, governance → claude-sonnet)
4. If all providers down: LLM tasks queue in BullMQ. Captures still ingested; embeddings still work (Jetson path).

**Pipeline queue depth > 100**
1. Check Bull Board at `/admin/queues`
2. Most likely cause: LiteLLM/Jetson is slow or unreachable for embeddings
3. Check LiteLLM health: `curl https://llm.k4jda.net/health`
4. If LiteLLM healthy but Jetson slow: captures are just queued, they'll process eventually
5. If persistent: check for a stuck job — remove it via Bull Board

**Embedding model swap (reconfigure on LiteLLM)**
1. Update `jetson-embeddings` alias on external LiteLLM to point to new model
2. Update `config/ai-routing.yaml` → `embedding.model` to match new alias
3. Run re-embedding job: trigger via API or custom script
4. Monitor progress via Bull Board — estimated times in Section 4.5
5. Search quality may be degraded during re-embedding (mixed embeddings)
6. Recommendation: run overnight, verify completeness the next morning

**Database restore from backup**
1. Stop application: `docker compose stop core-api slack-bot workers`
2. Restore: `gunzip -c /mnt/user/backups/open-brain/open_brain_YYYYMMDD.sql.gz | docker compose exec -T postgres psql -U postgres open_brain`
3. Run migrations: `docker compose run --rm core-api npx drizzle-kit migrate`
4. Restart: `docker compose up -d`
5. Verify: `curl http://localhost:3000/health`

**Redis data loss (BullMQ jobs lost)**
1. In-flight jobs are lost but captures are already in Postgres
2. Find captures with pipeline_status != 'complete': `SELECT id FROM captures WHERE pipeline_status IN ('received', 'processing')`
3. Re-trigger pipeline: `POST /api/v1/captures/:id/retry` for each
4. Or wait for daily sweep (3:00 AM) to auto-retry

**Monthly AI budget exceeded**
1. LiteLLM enforces hard limit — LLM requests return 429
2. Captures still ingested; embeddings may also be blocked depending on LiteLLM budget scope
3. Synthesis and governance blocked until budget resets
4. Override: update `max_budget` in LiteLLM admin on external server (llm.k4jda.net), no local restart needed

**MCP API key rotation**
1. Generate new key: `bws secret edit dev/open-brain/mcp-api-key --value "new-key-here"`
2. Regenerate .env.secrets: run the bws extraction script (Section 16.4, step 1)
3. Restart core-api: `docker compose restart core-api`
4. Verify: `curl -H "Authorization: Bearer <new-key>" https://brain.k4jda.net/mcp` (should not return 401)
5. Update MCP clients:
   - Claude Desktop: Settings → MCP Servers → brain → update key
   - Claude Code: Update MCP config in settings
   - Any other MCP clients
6. Old key is immediately invalid after restart (no grace period)
7. Startup log includes: `MCP API key loaded (hash: <first-8-chars-of-sha256>)` for verification without exposing the key.

---

## Document Resolution Log

*This document was completed on 2026-03-04 using `/finish-document`.*

**Questions Resolved:** 32 of 32
- Original backup: `TDD.backup-20260304-221000.md`
