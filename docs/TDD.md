# Open Brain — Technical Design Document

| Document Information |                                    |
|---------------------|-------------------------------------|
| Version             | 0.6                                 |
| Status              | Draft — Hardening Documentation Sync |
| Author              | Troy Davis / Claude                 |
| Last Updated        | 2026-03-10                          |

## Document History
| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 0.1 | 2026-03-04 | Troy Davis / Claude | Initial TDD based on PRD v0.2 |
| 0.2 | 2026-03-04 | Troy Davis / Claude | All 32 open questions resolved via /ask-questions session |
| 0.3 | 2026-03-05 | Troy Davis / Claude | LiteLLM gateway, flexible embeddings, cognitive retrieval (ACT-R, RRF, triggers) |
| 0.4 | 2026-03-05 | Troy Davis / Claude | Architectural review: 10 sub-phases with test gates, fix Zod brain_views, Authorization header for MCP, check_triggers as separate job, standardized temporal scoring, UNIQUE constraints, cold start plan, operational runbook |
| 0.5 | 2026-03-05 | Troy Davis / Claude | Architectural review v2: Fixed composite score formula (multiplicative boost), extracted pipeline_log to pipeline_events table, extracted session transcript to session_messages table, removed linked_entities denormalization from captures, added DELETE captures endpoint, fixed temporal_weight default (0.0), changed BrainView type to config-driven string, clarified ai_audit_log purpose (dropped cost_estimate), added entity resolution confidence threshold (0.8), added MCP key rotation runbook, config Zod validation, scheduled skill retry policy, thread expiration UX, migration-at-startup entrypoint, Ollama CPU benchmark requirement, content_hash window configurability note, MCP in-progress capture visibility note. |
| 0.6 | 2026-03-10 | Troy Davis / Claude | Hardening 7.2: Replaced speculative SQL functions (match_captures, match_captures_hybrid) with actual as-built functions (hybrid_search, fts_only_search, actr_temporal_score, update_capture_embedding, vector_search, fts_search) matching init-schema.sql. Updated synthesize endpoint contract to match implementation ({query, limit} request, {response, capture_count} response). Updated all cross-references to old function names. |

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

The system runs entirely on an Unraid home server, ingests captures from Slack and voice memos, embeds them for semantic search via the external LiteLLM proxy (spark-qwen3-embedding-4b alias → Qwen3-Embedding-4B (via LiteLLM, Matryoshka-truncated to 768d)), routes all LLM inference through the same external LiteLLM proxy at llm.k4jda.net, and surfaces insights through AI-powered skills (weekly briefs, governance sessions, drift detection). Search uses hybrid retrieval (full-text + vector with Reciprocal Rank Fusion) combined with ACT-R temporal decay scoring.

### 1.2 Scope

**In Scope (this document)**:
- Phase 1 (Foundation/MVP): Core API, Postgres+pgvector, Pipeline, Slack capture/query, MCP (embedded in Core API), AI router (via external LiteLLM)
- Phase 2 (Voice + Outputs): faster-whisper, voice-capture integration, weekly brief skill, notifications, email
- Phase 3 (Intelligence): Entity graph, governance sessions, bet tracking
- Phase 4 (Polish): Web dashboard (Vite + React PWA), document ingestion
- Phase 5 (Proactive Intelligence + URL Capture): Daily connections, drift monitor, URL/bookmark capture

**Out of Scope**:
- Multi-user support, authentication system
- Mobile native apps
- Notion output skill (deferred to "Future")
- Screenshot/image capture via vision models (F27 — documented in PRD, deferred pending vision model availability on LiteLLM)

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
| Embeddings | Qwen3-Embedding-4B via `spark-qwen3-embedding-4b` alias on LiteLLM | Routed through llm.k4jda.net. OpenAI embeddings API. Matryoshka 2560d → 768d truncation in the embedding service. No fallback — queue and retry. Schema: vector(768) |
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
  F07 EmbeddingService (via LiteLLM spark-qwen3-embedding-4b) → Search endpoints (hybrid + temporal)

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
  → F18 Bet Tracking → F20 Slack Voice

Phase 4: Polish
  F19 Web Dashboard → F23 Document Ingestion

Phase 5A: Proactive Intelligence
  F21 Daily Connections → F22 Drift Monitor
  (builds on: F12 skills framework, F15 entity graph, F18 bets)

Phase 5B: URL Capture
  F24 URL/Bookmark Capture → existing pipeline
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
| LiteLLM (external) | latest | Embeddings (spark-qwen3-embedding-4b) + all LLM inference — external shared service at llm.k4jda.net | Required |
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
1. Generate embedding for `query` via LiteLLM (spark-qwen3-embedding-4b alias)
2. If search_mode = "hybrid": call `hybrid_search()` with query embedding + raw query text
   If search_mode = "vector": call `vector_search()` with query embedding only
   If search_mode = "fts": call `fts_only_search()` with query text only (no embedding required)
3. Apply `actr_temporal_score()` to results if `temporal_weight > 0`
4. Enqueue `update_access_stats` job for returned capture IDs (async, non-blocking)
5. Return ranked results

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

**Description**: Ad-hoc AI synthesis across captures. Runs a hybrid search over captures, then asks the LLM to synthesize a coherent answer grounded in those results. Falls back to FTS-only search if embedding is unavailable.

**Request Body**:
```json
{
  "query": "Summarize everything about the QSR engagement",
  "limit": 10
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| query | string | Yes | — | Synthesis prompt (1-2000 chars) |
| limit | integer | No | 10 | Max captures to include as context (1-30) |

**Implementation** (see `packages/core-api/src/routes/synthesize.ts`):
1. Validate request body via Zod schema (`synthesizeBodySchema`)
2. Run `SearchService.search(query, { limit, searchMode: 'hybrid' })` — falls back to `searchMode: 'fts'` if embedding service is unavailable
3. If no results found, return a "no captures found" message with `capture_count: 0`
4. Build context block: each capture formatted as `[n] (capture_type, brain_view, date)\ncontent`
5. Send context + query to LiteLLM via `LLMGatewayService.complete()` (model alias: `synthesis`, maxTokens: 1024, temperature: 0.2)
6. Return synthesized response

**Response (200 OK)**:
```json
{
  "response": "Based on your captures over the past month, the QSR engagement...",
  "capture_count": 15
}
```

**Response (200 OK, no results)**:
```json
{
  "response": "I couldn't find any captures in your brain that are relevant to this query. Try capturing more notes first.",
  "capture_count": 0
}
```

**Simplification rationale**: The original TDD specified `max_captures`, `token_budget`, and `filters` parameters with a detailed `{synthesis, captures_used, model, token_usage}` response. The implementation intentionally simplified this: `limit` replaces `max_captures`, token budgeting is not needed at current scale (context fits within LLM context window), filters are deferred (search already handles filtering), and the response omits model/token metadata to keep the endpoint lightweight. The Slack bot `!brain ask` command is the primary consumer.

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
| name | string | Skill name: `weekly-brief`, `pipeline-health`, `stale-captures`. Deferred: `drift-monitor`, `daily-connections` |

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

**Implementation**: Generate embedding for `query_text` via LiteLLM (spark-qwen3-embedding-4b alias) at creation time. Store trigger with pre-computed embedding.

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
    "litellm": { "status": "up", "latency_ms": 12, "models_available": ["spark-qwen3-embedding-4b", "fast", "synthesis", "governance"] },
    "litellm": { "status": "up", "latency_ms": 5, "models_available": ["fast", "synthesis", "governance"] }
  },
  "uptime_seconds": 86400,
  "version": "0.1.0"
}
```

---

#### GET /api/v1/events

> **Unplanned addition** -- implemented during Phase 4 (web dashboard) to support real-time UI updates.

**Description**: Server-Sent Events (SSE) endpoint. Streams real-time events to connected clients via Postgres LISTEN/NOTIFY. Used by the web dashboard for live updates.

**Headers**:
- `Content-Type: text/event-stream`
- `Cache-Control: no-cache`
- `Connection: keep-alive`
- `X-Accel-Buffering: no` (disables nginx response buffering)

**Event Types**:

| Event Name | Trigger | Payload |
|------------|---------|---------|
| `connected` | On initial connection | `{ "ts": "<ISO 8601>" }` |
| `capture_created` | New capture persisted | Capture summary object |
| `pipeline_complete` | Pipeline finishes processing | `{ "captureId": "...", "status": "complete" }` |
| `skill_complete` | Skill execution finishes | `{ "skill": "...", "duration_ms": ... }` |
| `bet_expiring` | Bet approaching due date | `{ "betId": "...", "due_date": "..." }` |

**Heartbeat**: Comment-only heartbeat (`: heartbeat <timestamp>`) every 30 seconds to keep the connection alive through reverse proxies.

**Implementation**: `packages/core-api/src/routes/events.ts` uses Hono `stream()` helper. The `PgNotify` singleton (`lib/pg-notify.ts`) manages a dedicated `pg.Client` connection that LISTENs on four Postgres channels (`capture_created`, `pipeline_complete`, `skill_complete`, `bet_expiring`). Subscribers receive parsed JSON payloads. Cleanup (unsubscribe + clear heartbeat interval) runs on client disconnect via `stream.onAbort()`.

---

#### POST /api/v1/admin/reset-data

> **Unplanned addition** -- added for development and testing workflows to reset user data without rebuilding the database.

**Description**: Truncates all user data tables. Preserves schema, migration history, and trigger configuration. Requires admin authentication (Bearer token) and an explicit confirmation body.

**Authentication**: `Authorization: Bearer <ADMIN_API_KEY>` (falls back to `MCP_BEARER_TOKEN`)

**Request Body**:
```json
{
  "confirm": "WIPE ALL DATA"
}
```

**Response (200 OK)**:
```json
{
  "cleared": [
    "captures", "pipeline_events", "entities", "entity_links",
    "entity_relationships", "sessions", "session_messages",
    "bets", "skills_log", "ai_audit_log"
  ],
  "preserved": ["triggers", "__drizzle_migrations", "schema"],
  "wiped_at": "2026-03-10T12:00:00Z"
}
```

**Error Responses**:
- `400` -- Missing or incorrect confirmation body
- `401` -- Missing or invalid admin Bearer token
- `503` -- Database not configured for this endpoint

**Implementation**: `packages/core-api/src/routes/admin.ts`. Uses a single `TRUNCATE ... CASCADE` statement. Tables are ordered to respect FK constraints. The `triggers` table is intentionally preserved (user configuration, not test data). `__drizzle_migrations` is never touched.

---

#### GET /api/v1/admin/pipeline/health

> **Unplanned addition** -- added alongside Bull Board to provide a machine-readable pipeline status endpoint.

**Description**: Returns BullMQ queue job counts for all registered queues. Used by the dashboard Settings page and monitoring scripts.

**Response (200 OK)**:
```json
{
  "queues": {
    "capture-pipeline": { "waiting": 0, "active": 1, "completed": 42, "failed": 0, "delayed": 0 },
    "skill-execution": { "waiting": 0, "active": 0, "completed": 12, "failed": 0, "delayed": 0 },
    "notification": { "waiting": 0, "active": 0, "completed": 15, "failed": 0, "delayed": 0 },
    "access-stats": { "waiting": 0, "active": 0, "completed": 100, "failed": 0, "delayed": 0 },
    "daily-sweep": { "waiting": 0, "active": 0, "completed": 3, "failed": 0, "delayed": 0 }
  },
  "overall": {
    "pending": 0,
    "processing": 1,
    "complete": 172,
    "failed": 0
  }
}
```

**Implementation**: `packages/core-api/src/routes/admin.ts`. Returns a placeholder response with zero counts when Redis connection is not configured.

---

#### POST /api/v1/documents

> **Unplanned addition** -- implemented during Phase 4 for document ingestion (PDF, DOCX, MD, TXT, HTML).

**Description**: Upload a document for ingestion into the brain. Accepts multipart form data. Creates a capture with `source: 'document'` and enqueues a document-pipeline job for async text extraction.

**Request**: `Content-Type: multipart/form-data`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| file | File | Yes | -- | PDF, DOCX, DOC, MD, TXT, or HTML file |
| brain_view | string | No | `technical` | Brain view classification |
| tags | string | No | -- | Comma-separated tag list |
| title | string | No | Derived from filename | Title override for the document |

**Supported MIME Types**: `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/msword`, `text/markdown`, `text/plain`, `text/html`

**Response (201 Created)**:
```json
{
  "capture_id": "uuid",
  "filename": "strategy-doc.pdf",
  "mime_type": "application/pdf",
  "pipeline_status": "received",
  "brain_view": "technical",
  "tags": ["strategy"]
}
```

**Implementation**: `packages/core-api/src/routes/documents.ts`. The uploaded file is saved to a temp directory (`open-brain-uploads/<id>.<ext>`) and referenced via `source_metadata.file_path`. The document-pipeline worker reads the file for text extraction. If the pipeline queue is unavailable, the capture is still created (daily sweep or manual retry can re-trigger).

---

#### Bet Tracking Endpoints

> **Unplanned addition** -- implemented during Phase 3 (Intelligence) for bet tracking from governance sessions.

**GET /api/v1/bets** -- List bets with optional filtering.

| Parameter | Type | Location | Default | Description |
|-----------|------|----------|---------|-------------|
| status | string | query | -- | Filter: `pending`, `correct`, `incorrect`, `ambiguous` |
| limit | integer | query | 20 | Page size |
| offset | integer | query | 0 | Pagination offset |

**Response (200 OK)**:
```json
{
  "items": [{ "id": "uuid", "statement": "...", "confidence": 0.8, "status": "pending" }],
  "total": 5,
  "limit": 20,
  "offset": 0
}
```

**POST /api/v1/bets** -- Create a new bet.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| statement | string | Yes | The falsifiable prediction |
| confidence | float | Yes | 0.0-1.0 confidence level |
| domain | string | No | Domain context (e.g., "QSR", "career") |
| due_date | string | No | ISO 8601 date when the bet should be evaluated |
| session_id | string | No | Link to originating governance session |

**Response (201 Created)**: Full bet object.

**GET /api/v1/bets/expiring** -- Bets due within the next N days.

| Parameter | Type | Location | Default | Description |
|-----------|------|----------|---------|-------------|
| days | integer | query | 7 | Look-ahead window |

**GET /api/v1/bets/:id** -- Get a single bet by ID.

**PATCH /api/v1/bets/:id** -- Resolve a bet.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| resolution | string | Yes | `correct`, `incorrect`, or `ambiguous` |
| evidence | string | No | Supporting evidence for the resolution |

**Implementation**: `packages/core-api/src/routes/bets.ts` with `BetService` handling persistence and validation.

---

### 3.3 API Error Code Catalog

| Error Code | HTTP Status | Description | Resolution |
|------------|-------------|-------------|------------|
| VALIDATION_ERROR | 400 | Invalid request payload | Check required fields and types |
| DUPLICATE_CAPTURE | 409 | Capture already exists (dedup) | Ignore — capture was already ingested |
| NOT_FOUND | 404 | Resource not found | Verify ID exists |
| PIPELINE_FAILED | 500 | Pipeline processing error | Check pipeline_events, retry via API |
| SERVICE_UNAVAILABLE | 503 | Downstream service unreachable | Check health endpoint, wait for recovery |
| AI_BUDGET_EXCEEDED | 429 | Monthly AI budget hard limit reached | Wait for budget reset or adjust limits |
| EMBEDDING_UNAVAILABLE | 503 | LiteLLM embedding unavailable | Embeddings will queue and retry via BullMQ |
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

### 4.2 Drizzle Schema Definitions (As-Built)

> **Updated 2026-03-10** — This section reflects the actual implemented schema in
> `packages/shared/src/schema/` (Drizzle ORM source of truth). Key divergences from
> the original TDD design are noted inline.

All schemas defined in TypeScript using Drizzle ORM. Schema files live in
`packages/shared/src/schema/` and are split into `core.ts` (captures, pipeline_events,
ai_audit_log) and `supporting.ts` (entities, entity_links, entity_relationships,
sessions, session_messages, bets, skills_log, triggers). A custom `vector` type is
defined in `types.ts`. Migrations generated via `drizzle-kit generate` and applied via
`drizzle-kit migrate`; several custom SQL migrations handle features Drizzle cannot
generate natively (HNSW indexes, FTS indexes, partial indexes, SQL functions, triggers).

```typescript
// packages/shared/src/schema/core.ts — captures
export const captures = pgTable('captures', {
  id: uuid('id').primaryKey().defaultRandom(),
  content: text('content').notNull(),
  content_hash: text('content_hash').notNull(),         // text NOT NULL (not char(64) — simpler, same purpose)
  capture_type: text('capture_type').notNull(),          // decision | idea | observation | task | win | blocker | question | reflection
  brain_view: text('brain_view').notNull(),              // Single text, NOT array — intentional simplification (one view per capture)
  source: text('source').notNull(),                      // slack | voice | api | document
  source_metadata: jsonb('source_metadata'),
  tags: text('tags').array().notNull().default("'{}'::text[]"),
  embedding: vector('embedding'),                        // vector(768) — custom type, Matryoshka-truncated from 2560d Qwen3-Embedding
  pipeline_status: text('pipeline_status').notNull().default('pending'),
    // pending | processing | extracted | embedded | chunked | complete | failed
  pipeline_attempts: integer('pipeline_attempts').notNull().default(0),
  pipeline_error: text('pipeline_error'),
  pipeline_completed_at: timestamp('pipeline_completed_at', { withTimezone: true }),
  pre_extracted: jsonb('pre_extracted'),                 // entities/topics extracted by ingestion source
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  captured_at: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),                        // soft delete
  access_count: integer('access_count').notNull().default(0),                         // ACT-R temporal decay
  last_accessed_at: timestamp('last_accessed_at', { withTimezone: true }),             // ACT-R temporal decay
}, (table) => ({
  content_hash_idx: uniqueIndex('captures_content_hash_idx').on(table.content_hash),
  capture_type_idx: index('captures_capture_type_idx').on(table.capture_type),
  brain_view_idx: index('captures_brain_view_idx').on(table.brain_view),
  source_idx: index('captures_source_idx').on(table.source),
  pipeline_status_idx: index('captures_pipeline_status_idx').on(table.pipeline_status),
  created_at_idx: index('captures_created_at_idx').on(table.created_at),
  // Custom SQL migration indexes (not expressible in Drizzle):
  //   captures_embedding_hnsw_idx  — HNSW (vector_cosine_ops, m=16, ef_construction=64)
  //   captures_content_fts_idx     — GIN on to_tsvector('english', content)
  //   captures_deleted_at_idx      — partial index WHERE deleted_at IS NULL
}));
```

**Design notes — captures divergences from original TDD:**
- `brain_view` is a single `text NOT NULL` column, not a `text[]` array. One view per capture; intentional simplification.
- `capture_type` is a dedicated column (not inside a `metadata` JSONB). The `metadata` JSONB column was removed in favor of explicit typed columns (`capture_type`, `brain_view`, `tags`).
- `content_hash` is `text NOT NULL`, not `char(64)`. No functional difference for dedup.
- `content_raw` column was not implemented.
- `pipeline_status` values: `pending | processing | extracted | embedded | chunked | complete | failed` (not `received | processing | complete | failed | partial`).
- `pipeline_attempts`, `pipeline_error`, `pipeline_completed_at` added for retry tracking.
- `source` values: `slack | voice | api | document` (not `web | email`).

```typescript
// packages/shared/src/schema/core.ts — pipeline_events
// Append-only processing audit trail per pipeline stage.
export const pipeline_events = pgTable('pipeline_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  capture_id: uuid('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),        // classify | embed | extract | link_entities | check_triggers | notify
  status: text('status').notNull(),      // started | success | failed
  duration_ms: integer('duration_ms'),
  error: text('error'),
  metadata: jsonb('metadata'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  capture_id_idx: index('pipeline_events_capture_id_idx').on(table.capture_id),
  stage_idx: index('pipeline_events_stage_idx').on(table.stage),
  created_at_idx: index('pipeline_events_created_at_idx').on(table.created_at),
}));
```

**Design notes — pipeline_events divergences:**
- `status` values: `started | success | failed` (not `complete | failed | skipped`).
- `model` and `retry_count` columns were not implemented; `metadata` JSONB column added instead.
- Additional indexes on `stage` and `created_at`.

```typescript
// packages/shared/src/schema/supporting.ts — entities
export const entities = pgTable('entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  entity_type: text('entity_type').notNull(),     // person | org | project | concept | place | tool
  canonical_name: text('canonical_name').notNull(),
  aliases: text('aliases').array().notNull().default("'{}'::text[]"),
  metadata: jsonb('metadata'),
  first_seen_at: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  name_type_idx: uniqueIndex('entities_name_type_idx').on(table.name, table.entity_type),
  entity_type_idx: index('entities_entity_type_idx').on(table.entity_type),
  canonical_name_idx: index('entities_canonical_name_idx').on(table.canonical_name),
  // Custom SQL migration indexes:
  //   entities_entity_type_lower_name_idx      — (entity_type, lower(name))
  //   entities_entity_type_lower_canonical_idx  — (entity_type, lower(canonical_name))
}));
```

**Design notes — entities divergences:**
- `entity_type` values: `person | org | project | concept | place | tool` (not `person | project | decision | concept | bet`).
- Added `canonical_name text NOT NULL` for case-normalized entity resolution.
- `first_seen_at` / `last_seen_at` instead of `first_seen` / `last_seen` (naming consistency with timestamptz convention).
- `mention_count` column was not implemented; occurrence counts are derived from `entity_links` joins.
- Additional indexes on `entity_type` and `canonical_name`.

```typescript
// packages/shared/src/schema/supporting.ts — entity_links
export const entity_links = pgTable('entity_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  entity_id: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  capture_id: uuid('capture_id').notNull().references(() => captures.id, { onDelete: 'cascade' }),
  relationship: text('relationship'),              // mentioned | authored | referenced | decided_about
  confidence: real('confidence'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  entity_id_idx: index('entity_links_entity_id_idx').on(table.entity_id),
  capture_id_idx: index('entity_links_capture_id_idx').on(table.capture_id),
  entity_capture_idx: uniqueIndex('entity_links_entity_capture_idx').on(table.entity_id, table.capture_id),
}));
```

**Design notes — entity_links divergences:**
- Both `entity_id` and `capture_id` are `NOT NULL` (original TDD had them nullable).
- Added `confidence real` column for extraction confidence scores.
- Added unique index on `(entity_id, capture_id)` to prevent duplicate links.

```typescript
// packages/shared/src/schema/supporting.ts — entity_relationships (NEW TABLE)
// Co-occurrence graph between entities. Undirected: entity_id_a < entity_id_b
// (UUID lexicographic) enforces canonical ordering. Not in original TDD — added
// during Phase 12 (entity graph relationships).
export const entity_relationships = pgTable('entity_relationships', {
  id: uuid('id').primaryKey().defaultRandom(),
  entity_id_a: uuid('entity_id_a').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  entity_id_b: uuid('entity_id_b').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  co_occurrence_count: integer('co_occurrence_count').notNull().default(1),
  weight: real('weight').notNull().default(1.0),
  last_seen_at: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  entity_pair_idx: uniqueIndex('entity_relationships_pair_idx').on(table.entity_id_a, table.entity_id_b),
  entity_id_a_idx: index('entity_relationships_entity_id_a_idx').on(table.entity_id_a),
  entity_id_b_idx: index('entity_relationships_entity_id_b_idx').on(table.entity_id_b),
  last_seen_at_idx: index('entity_relationships_last_seen_at_idx').on(table.last_seen_at),
}));
```

```typescript
// packages/shared/src/schema/supporting.ts — sessions
export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  session_type: text('session_type').notNull(),    // governance | review | planning
  status: text('status').notNull().default('active'), // active | paused | complete | abandoned
  config: jsonb('config'),
  context_capture_ids: text('context_capture_ids').array().notNull().default("'{}'::text[]"),
  summary: text('summary'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completed_at: timestamp('completed_at', { withTimezone: true }),
}, (table) => ({
  session_type_idx: index('sessions_session_type_idx').on(table.session_type),
  status_idx: index('sessions_status_idx').on(table.status),
  created_at_idx: index('sessions_created_at_idx').on(table.created_at),
}));
```

**Design notes — sessions divergences:**
- `session_type` values: `governance | review | planning` (not `quick_check | quarterly | custom`).
- `status` values: `active | paused | complete | abandoned` (not `active | completed | abandoned | paused`).
- `state` JSONB column was not implemented; replaced by `context_capture_ids text[]` and `summary text`.
- `result` JSONB and `paused_at` columns were not implemented.
- Added indexes on `session_type`, `status`, and `created_at`.

```typescript
// packages/shared/src/schema/supporting.ts — session_messages
export const session_messages = pgTable('session_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  session_id: uuid('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),                    // user | assistant
  content: text('content').notNull(),
  metadata: jsonb('metadata'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  session_id_idx: index('session_messages_session_id_idx').on(table.session_id),
  created_at_idx: index('session_messages_created_at_idx').on(table.created_at),
}));
```

**Design notes — session_messages divergences:**
- `role` values: `user | assistant` (not `system | bot | user`).
- `board_role` column was not implemented; board persona is handled in conversation logic, not stored per-message.
- Added `metadata` JSONB column and `created_at` index.

```typescript
// packages/shared/src/schema/supporting.ts — bets
export const bets = pgTable('bets', {
  id: uuid('id').primaryKey().defaultRandom(),
  statement: text('statement').notNull(),
  confidence: real('confidence').notNull(),        // 0.0-1.0
  domain: text('domain'),
  resolution_date: timestamp('resolution_date', { withTimezone: true }),
  resolution: text('resolution'),                  // correct | incorrect | ambiguous | pending
  resolution_notes: text('resolution_notes'),
  session_id: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  domain_idx: index('bets_domain_idx').on(table.domain),
  resolution_idx: index('bets_resolution_idx').on(table.resolution),
  resolution_date_idx: index('bets_resolution_date_idx').on(table.resolution_date),
}));
```

**Design notes — bets divergences (substantial redesign):**
- `statement` replaces `commitment` + `falsifiable_criteria` (single text field for the prediction).
- `confidence real NOT NULL` (0.0-1.0 scale) instead of structured criteria.
- `domain text` added for categorization.
- `resolution` / `resolution_notes` / `resolution_date` replace `status` / `evidence` / `due_date` / `resolved_at`.
- `resolution_date` is `timestamptz` (not `date`).
- Session FK uses `onDelete: 'set null'` (not unconstrained).

```typescript
// packages/shared/src/schema/supporting.ts — skills_log
export const skills_log = pgTable('skills_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  skill_name: text('skill_name').notNull(),
  capture_id: uuid('capture_id').references(() => captures.id, { onDelete: 'set null' }),
  session_id: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
  input_summary: text('input_summary'),
  output_summary: text('output_summary'),
  result: jsonb('result'),
  duration_ms: integer('duration_ms'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  skill_name_idx: index('skills_log_skill_name_idx').on(table.skill_name),
  created_at_idx: index('skills_log_created_at_idx').on(table.created_at),
}));
```

**Design notes — skills_log divergences (substantial redesign):**
- Simplified to an append-only log. No `trigger_type`, `status`, `config`, `captures_queried`, `ai_model_used`, `token_usage`, `completed_at`, or `error` columns.
- Added `capture_id` and `session_id` FKs for traceability.
- Added `input_summary`, `output_summary` text columns and `result` JSONB for structured output storage.

```typescript
// packages/shared/src/schema/core.ts — ai_audit_log
// Tracks all LLM/embedding calls. Cost tracking is via LiteLLM /spend/logs (not here).
export const ai_audit_log = pgTable('ai_audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  task_type: text('task_type').notNull(),         // classify | embed | synthesize | govern | intent
  model: text('model').notNull(),
  prompt_tokens: integer('prompt_tokens'),
  completion_tokens: integer('completion_tokens'),
  total_tokens: integer('total_tokens'),
  duration_ms: integer('duration_ms'),
  capture_id: uuid('capture_id').references(() => captures.id, { onDelete: 'set null' }),
  session_id: uuid('session_id'),                 // forward ref to sessions
  error: text('error'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  task_type_idx: index('ai_audit_log_task_type_idx').on(table.task_type),
  created_at_idx: index('ai_audit_log_created_at_idx').on(table.created_at),
  capture_id_idx: index('ai_audit_log_capture_id_idx').on(table.capture_id),
}));
```

**Design notes — ai_audit_log divergences:**
- No `provider` or `success` columns. All calls go through LiteLLM so provider is implicit.
- Token columns: `prompt_tokens`, `completion_tokens`, `total_tokens` (not `tokens_in`/`tokens_out`).
- Added `capture_id` and `session_id` FK columns for traceability.

```typescript
// packages/shared/src/schema/supporting.ts — triggers
export const triggers = pgTable('triggers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  condition_text: text('condition_text').notNull(),     // Natural language condition
  embedding: vector('embedding'),                       // vector(768) for semantic matching
  threshold: real('threshold').notNull().default(0.8),
  action: text('action').notNull(),                     // notify | log | create_capture
  action_config: jsonb('action_config'),
  enabled: boolean('enabled').notNull().default(true),
  last_triggered_at: timestamp('last_triggered_at', { withTimezone: true }),
  trigger_count: integer('trigger_count').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  name_idx: uniqueIndex('triggers_name_idx').on(table.name),
  enabled_idx: index('triggers_enabled_idx').on(table.enabled),
  // Custom SQL migration: HNSW index on triggers.embedding (vector_cosine_ops, m=16, ef_construction=64)
}));
```

**Design notes — triggers divergences:**
- `condition_text` replaces `query_text`; `embedding` replaces `query_embedding`.
- `action` + `action_config` replace `delivery_channel` (more extensible action model).
- `description` column added.
- `enabled` replaces `is_active`; `last_triggered_at` replaces `last_fired_at`; `trigger_count` replaces `fire_count`.
- `cooldown_minutes` column was not implemented.
- Default `threshold` is `0.8` (not `0.72`).

#### Custom SQL Migrations (Not Expressible in Drizzle)

The following objects are created via custom SQL migration files in `packages/shared/drizzle/`:

| Migration | Object | Description |
|-----------|--------|-------------|
| 0001 | `pgvector` extension | `CREATE EXTENSION IF NOT EXISTS vector` |
| 0001 | `captures_embedding_hnsw_idx` | HNSW index on `captures.embedding` (vector_cosine_ops, m=16, ef_construction=64) |
| 0001 | `triggers_embedding_hnsw_idx` | HNSW index on `triggers.embedding` (same params) |
| 0001 | `captures_content_fts_idx` | GIN index on `to_tsvector('english', content)` |
| 0001 | `set_updated_at()` function | Trigger function that sets `updated_at = NOW()` on UPDATE |
| 0001 | `set_*_updated_at` triggers | Applied to captures, entities, sessions, bets, triggers |
| 0004 | `entities_entity_type_lower_name_idx` | Composite index `(entity_type, lower(name))` for case-insensitive lookup |
| 0004 | `entities_entity_type_lower_canonical_idx` | Composite index `(entity_type, lower(canonical_name))` |
| 0005 | `captures_deleted_at_idx` | Partial index on `deleted_at WHERE deleted_at IS NULL` |

### 4.3 Semantic Search Functions

Deployed as raw SQL migrations via Drizzle custom migration (0002, 0006, 0009). The as-built functions differ from the original TDD design: `match_captures()` / `match_captures_hybrid()` were replaced by `hybrid_search()`, `fts_only_search()`, `vector_search()`, and `fts_search()` during implementation. Key simplifications: temporal scoring is handled by a separate `actr_temporal_score()` scalar function (applied by `SearchService` in TypeScript) rather than being inlined in the search CTEs, and filter parameters are pushed into SQL WHERE clauses (migration 0009) instead of post-filtering in memory.

#### hybrid_search — Primary search function (FTS + vector with RRF)

The main search path. Runs full-text search and vector cosine similarity in parallel CTE arms, fuses results via Reciprocal Rank Fusion (k=60), and returns the top `match_count` rows. Temporal scoring is applied separately by `SearchService` using `actr_temporal_score()`.

```sql
-- Migrations: 0002 (initial), 0006 (typo fix), 0009 (add filter params)
CREATE OR REPLACE FUNCTION hybrid_search(
  query_text             text,
  query_embedding        vector(768),
  match_count            int,
  fts_weight             float DEFAULT 1.0,
  vector_weight          float DEFAULT 1.0,
  filter_brain_views     text[] DEFAULT NULL,
  filter_capture_types   text[] DEFAULT NULL,
  filter_date_from       timestamptz DEFAULT NULL,
  filter_date_to         timestamptz DEFAULT NULL
)
RETURNS TABLE (
  capture_id   uuid,
  rrf_score    float,
  fts_score    float,
  vector_score float
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  k int := 60;
BEGIN
  RETURN QUERY
  WITH fts_ranked AS (
    SELECT
      c.id AS capture_id,
      ts_rank_cd(
        to_tsvector('english', c.content),
        plainto_tsquery('english', query_text)
      )::float AS fts_score,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(
          to_tsvector('english', c.content),
          plainto_tsquery('english', query_text)
        ) DESC
      ) AS fts_rank
    FROM captures c
    WHERE
      c.embedding IS NOT NULL
      AND c.deleted_at IS NULL
      AND to_tsvector('english', c.content) @@ plainto_tsquery('english', query_text)
      AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
      AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
      AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
      AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
  ),
  vector_ranked AS (
    SELECT
      c.id AS capture_id,
      (1.0 - (c.embedding <=> query_embedding))::float AS vector_score,
      ROW_NUMBER() OVER (
        ORDER BY c.embedding <=> query_embedding ASC
      ) AS vector_rank
    FROM captures c
    WHERE
      c.embedding IS NOT NULL
      AND c.deleted_at IS NULL
      AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
      AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
      AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
      AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
  ),
  fused AS (
    SELECT
      COALESCE(f.capture_id, v.capture_id) AS capture_id,
      (
        COALESCE(fts_weight    * (1.0 / (k + COALESCE(f.fts_rank,    2147483647))), 0.0) +
        COALESCE(vector_weight * (1.0 / (k + COALESCE(v.vector_rank, 2147483647))), 0.0)
      )::float AS rrf_score,
      COALESCE(f.fts_score,    0.0)::float AS fts_score,
      COALESCE(v.vector_score, 0.0)::float AS vector_score
    FROM fts_ranked    f
    FULL OUTER JOIN vector_ranked v USING (capture_id)
  )
  SELECT
    fused.capture_id,
    fused.rrf_score,
    fused.fts_score,
    fused.vector_score
  FROM fused
  ORDER BY fused.rrf_score DESC
  LIMIT match_count;
END;
$$;
```

**Design notes:**
- Only captures with `embedding IS NOT NULL` and `deleted_at IS NULL` are searched. No `pipeline_status` filter — captures in `'embedded'` state (before entity extraction completes) are still searchable.
- `plainto_tsquery` is used for safe handling of plain-text user queries.
- Filters (brain_view, capture_type, date range) are pushed into SQL WHERE clauses so Postgres indexes do the work. The original implementation post-filtered in TypeScript after overfetching 5x rows; migration 0009 fixed this.
- Missing ranks for a lane use `2147483647` (INT_MAX) as a sentinel, giving that capture zero contribution from the missing lane.

#### fts_only_search — FTS fallback when embeddings are unavailable

Used when `search_mode = 'fts'` or when the embedding service is down. Does NOT require embeddings — searches all non-deleted captures including those without embeddings yet.

```sql
-- Migrations: 0006 (initial), 0009 (add filter params)
CREATE OR REPLACE FUNCTION fts_only_search(
  query_text             text,
  match_count            int,
  filter_brain_views     text[] DEFAULT NULL,
  filter_capture_types   text[] DEFAULT NULL,
  filter_date_from       timestamptz DEFAULT NULL,
  filter_date_to         timestamptz DEFAULT NULL
)
RETURNS TABLE (
  capture_id   uuid,
  rrf_score    float,
  fts_score    float,
  vector_score float
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  k int := 60;
BEGIN
  RETURN QUERY
  WITH fts_ranked AS (
    SELECT
      c.id AS capture_id,
      ts_rank_cd(
        to_tsvector('english', c.content),
        plainto_tsquery('english', query_text)
      )::float AS fts_score,
      ROW_NUMBER() OVER (
        ORDER BY ts_rank_cd(
          to_tsvector('english', c.content),
          plainto_tsquery('english', query_text)
        ) DESC
      ) AS fts_rank
    FROM captures c
    WHERE
      c.deleted_at IS NULL
      AND to_tsvector('english', c.content) @@ plainto_tsquery('english', query_text)
      AND (filter_brain_views IS NULL OR c.brain_view = ANY(filter_brain_views))
      AND (filter_capture_types IS NULL OR c.capture_type = ANY(filter_capture_types))
      AND (filter_date_from IS NULL OR c.captured_at >= filter_date_from)
      AND (filter_date_to IS NULL OR c.captured_at <= filter_date_to)
  )
  SELECT
    fts_ranked.capture_id,
    (1.0 / (k + fts_ranked.fts_rank))::float AS rrf_score,
    fts_ranked.fts_score,
    0.0::float AS vector_score
  FROM fts_ranked
  ORDER BY fts_ranked.fts_score DESC
  LIMIT match_count;
END;
$$;
```

**Design notes:**
- Returns the same `(capture_id, rrf_score, fts_score, vector_score)` shape as `hybrid_search()` so `SearchService` can handle both uniformly. `vector_score` is always `0.0`.
- `rrf_score` is computed as `1/(k + fts_rank)` for compatibility with the RRF scoring pattern, even though only one lane is active.

#### actr_temporal_score — ACT-R temporal decay scoring

A scalar function that applies ACT-R-inspired temporal decay to a base similarity score. Called by `SearchService` in TypeScript after retrieving search results — not inlined in the search CTEs.

```sql
-- Migration: 0002
CREATE OR REPLACE FUNCTION actr_temporal_score(
  base_score      float,
  created_at      timestamptz,
  temporal_weight float DEFAULT 0.0
)
RETURNS float
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  decay_rate    float := 0.01;
  hours_since   float;
  decay         float;
BEGIN
  IF temporal_weight = 0.0 THEN
    RETURN base_score;
  END IF;
  hours_since := GREATEST(EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0, 0.0);
  decay := EXP(-decay_rate * SQRT(hours_since));
  RETURN base_score * decay * temporal_weight + base_score * (1.0 - temporal_weight);
END;
$$;
```

**Design notes:**
- `decay_rate = 0.01` gives gentle decay: a capture from 1 week ago retains ~85% of its decay factor; from 1 year ago ~27%.
- `temporal_weight = 0.0` (the default) short-circuits to return `base_score` unchanged — cold-start safe.
- Formula: `result = base_score * decay * temporal_weight + base_score * (1 - temporal_weight)`. This blends pure-semantic and temporally-decayed scores. At `temporal_weight = 1.0`, the result is `base_score * decay`; at `0.0`, the result is `base_score`.

#### update_capture_embedding — Atomic embedding write

Atomically writes an embedding vector and marks the capture as `'embedded'` (intermediate pipeline status between `'processing'` and `'complete'`).

```sql
-- Migration: 0002
CREATE OR REPLACE FUNCTION update_capture_embedding(
  capture_id uuid,
  embedding  vector(768)
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE captures
  SET
    embedding       = update_capture_embedding.embedding,
    pipeline_status = 'embedded',
    updated_at      = NOW()
  WHERE id = update_capture_embedding.capture_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'capture not found: %', capture_id;
  END IF;
END;
$$;
```

#### vector_search — Pure vector similarity search

Standalone vector-only search function. Returns captures ranked by cosine similarity with a configurable threshold. Used for direct vector queries where RRF fusion is not needed.

```sql
-- Defined in init-schema.sql (consolidation of migration chain)
CREATE OR REPLACE FUNCTION vector_search(
  query_embedding vector(768),
  match_limit integer DEFAULT 20,
  similarity_threshold real DEFAULT 0.0
)
RETURNS TABLE (
  id uuid,
  content text,
  capture_type text,
  brain_view text,
  source text,
  tags text[],
  created_at timestamptz,
  captured_at timestamptz,
  similarity real
) AS $$
  SELECT c.id, c.content, c.capture_type, c.brain_view, c.source, c.tags,
    c.created_at, c.captured_at,
    (1 - (c.embedding <=> query_embedding))::real AS similarity
  FROM captures c
  WHERE c.embedding IS NOT NULL AND c.deleted_at IS NULL
    AND (1 - (c.embedding <=> query_embedding)) >= similarity_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_limit;
$$ LANGUAGE sql STABLE;
```

#### fts_search — Pure full-text search

Standalone FTS function. Returns captures ranked by `ts_rank`. Used for direct text queries where RRF fusion is not needed.

```sql
-- Defined in init-schema.sql (consolidation of migration chain)
CREATE OR REPLACE FUNCTION fts_search(
  query_text text,
  match_limit integer DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  content text,
  capture_type text,
  brain_view text,
  source text,
  tags text[],
  created_at timestamptz,
  captured_at timestamptz,
  rank real
) AS $$
  SELECT c.id, c.content, c.capture_type, c.brain_view, c.source, c.tags,
    c.created_at, c.captured_at,
    ts_rank(to_tsvector('english', c.content), plainto_tsquery('english', query_text))::real AS rank
  FROM captures c
  WHERE to_tsvector('english', c.content) @@ plainto_tsquery('english', query_text)
    AND c.deleted_at IS NULL
  ORDER BY rank DESC
  LIMIT match_limit;
$$ LANGUAGE sql STABLE;
```

#### Full-text search index

```sql
-- GIN index on captures.content for FTS
CREATE INDEX IF NOT EXISTS captures_content_fts_idx
  ON captures USING gin (to_tsvector('english', content));
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

1. **`hybrid_search` function** — FTS + vector with RRF fusion (see Section 4.3)
1a. **`fts_only_search` function** — FTS fallback when embeddings are unavailable (see Section 4.3)
1b. **`actr_temporal_score` function** — ACT-R temporal decay scoring (see Section 4.3)
1c. **`update_capture_embedding` function** — Atomic embedding write (see Section 4.3)
1d. **`vector_search` / `fts_search` functions** — Standalone search helpers (see Section 4.3)
1e. **FTS GIN index** — `captures_content_fts_idx` on `to_tsvector('english', content)`
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
// 2. For each capture: generate new embedding via LiteLLM (spark-qwen3-embedding-4b alias)
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

  /** Hybrid search: embed query → hybrid_search (RRF) + actr_temporal_score → ranked results */
  async search(input: SearchOptions): Promise<SearchResult[]>
    // 1. Generate embedding for query via EmbeddingService (type: 'query')
    // 2. Based on search_mode:
    //    hybrid → call hybrid_search() with embedding + raw text
    //    vector → call vector_search() with embedding only
    //    fts    → call fts_only_search() (no embedding required)
    // 3. Apply actr_temporal_score() if temporal_weight > 0
    // 4. Enqueue update_access_stats job for returned capture IDs (async, non-blocking)
    // 5. Return ranked results with rrf_score, fts_score, vector_score
}
```

```typescript
/**
 * EmbeddingService
 *
 * Generates embeddings via LiteLLM (https://llm.k4jda.net) using the OpenAI embeddings API.
 * Model alias: 'spark-qwen3-embedding-4b' → Qwen3-Embedding-4B (via LiteLLM, Matryoshka-truncated to 768d).
 * No fallback — throws EmbeddingUnavailableError if LiteLLM is unreachable; BullMQ retries.
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
    // 1. Read model alias from ai-routing.yaml (embedding.model = 'spark-qwen3-embedding-4b')
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
 * Embeddings go through EmbeddingService which also calls LiteLLM (spark-qwen3-embedding-4b alias).
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
 │            │            │            │──hybrid_search(text, vector)─────────────────►│              │
 │            │            │            │◄─ranked results (RRF scores)─────────────────│              │
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

**Purpose**: Embedding generation for all captures, triggers, and search queries. Routes exclusively through external LiteLLM at llm.k4jda.net using the `spark-qwen3-embedding-4b` alias. LLM inference also routes through LiteLLM — see §8.7.

**Embedding Model**: `spark-qwen3-embedding-4b` alias on LiteLLM → Qwen3-Embedding-4B (via LiteLLM, Matryoshka-truncated to 768d). Returns 2560d Matryoshka vectors, truncated to 768d in the embedding service. Supports instruction prefixes for asymmetric query/document embedding — EmbeddingService adds appropriate prefix based on type.

**API**: OpenAI embeddings API via LiteLLM (same endpoint as LLM inference)

```typescript
// Embedding generation via LiteLLM (OpenAI SDK — same client as AIRouterService)
import OpenAI from 'openai';
const litellm = new OpenAI({ baseURL: 'https://llm.k4jda.net', apiKey: process.env.LITELLM_API_KEY });
const model = configService.get('ai-routing').embedding.model; // 'spark-qwen3-embedding-4b'
const response = await litellm.embeddings.create({
  model: model,
  input: captureContent,  // With instruction prefix if model supports it
});
// response.data[0].embedding → number[768]
```

**Error Handling**:
- Embeddings: NO fallback. If LiteLLM is unreachable, captures queue in BullMQ and retry. This prevents mixing embedding models which would degrade search quality.
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

**Daily auto-retry sweep**: A scheduled job runs daily, finds all captures with failed stages, and retries each failed stage once. This catches transient issues (LiteLLM unreachable, network blip) that resolved after the initial retry window.

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
| WARN | LiteLLM embedding unavailability, budget soft limit, retry attempts |
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
| LiteLLM down | Health endpoint check | Pushover (emergency) |
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
| drift-monitor | skill-execution | 3 | 2 min | 3 | Exponential: 1m, 5m, 15m. Queries pending bets, entity frequency, governance commitments. Alerts via Pushover on severity > medium. |
| daily-connections | skill-execution | 3 | 3 min | 3 | Exponential: 1m, 5m, 15m. Queries 7-day captures, entity co-occurrence, embedding clusters. Delivers via Pushover + saves capture. |
| stale-captures | skill-execution | 3 | 2 min | 3 | Exponential. On-demand re-queue of stuck captures. Sends Pushover summary. |
| pipeline-health | skill-execution | 3 | 1 min | 3 | Exponential. Hourly BullMQ queue stats check; alerts via Pushover if thresholds exceeded. |
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
//      a. Run hybrid_search() for the trigger query (limit 5, related captures)
//      b. Send Pushover/Slack notification with: trigger name, new capture summary, related captures
//      c. Update trigger: lastFiredAt = now(), fireCount++
//   5. All trigger checks run in parallel (Promise.all)
//   6. No trigger match = no-op; worker completes successfully
```

### 12.2b Stale Captures Skill

> **Unplanned addition** -- on-demand complement to the nightly daily-sweep job for investigating pipeline issues during the day.

**Purpose**: Finds captures stuck in `received` or `processing` pipeline status for longer than a configurable threshold and re-enqueues them to the capture-pipeline BullMQ queue. Unlike the daily-sweep (which runs silently at 3 AM), this skill sends a Pushover notification summarizing what was re-queued.

**Trigger**: `POST /api/v1/skills/stale-captures/trigger` (via SkillExecutor framework). No cron schedule -- manual/on-demand only.

**Algorithm**:
1. Query captures where `pipeline_status IN ('received', 'processing')` AND `created_at < (now - threshold)`
2. For each stale capture, re-enqueue to `capture-pipeline` queue with `jobId = captureId` (BullMQ deduplicates -- if already queued, the add is a no-op)
3. Send Pushover notification (priority 1 / high) with count, oldest capture age, and up to 3 capture IDs
4. Log execution to `skills_log` table

**Options**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| thresholdMinutes | integer | 60 | How old a capture must be before it is considered stale |

**Result**:
```typescript
interface StaleCapturesResult {
  found: number       // total stale captures detected
  requeued: number    // successfully re-enqueued
  failed: number      // re-enqueue failures (non-fatal)
  staleCaptures: StaleCapture[]
  durationMs: number
}
```

**Failure handling**: Individual re-enqueue failures, Pushover delivery failures, and skills_log write failures are all caught and logged -- the skill does not throw on partial failure.

**Implementation**: `packages/workers/src/skills/stale-captures.ts`

### 12.2c Daily Connections Skill (F21)

> **Phase 5A** -- Proactive intelligence skill that surfaces non-obvious cross-domain patterns across recent captures.

**Purpose**: Queries captures from the last N days, builds entity co-occurrence data and embedding-based clusters, then uses LLM synthesis to surface connections the user might miss. Delivered via Pushover and saved as a searchable capture.

**Trigger**: Scheduled daily at 9:00 PM via BullMQ repeatable job. Manual via `POST /api/v1/skills/daily-connections/trigger` or Slack `!connections [days]`.

**Algorithm**:
1. Query captures from last N days (default: 7), ordered by `created_at DESC`
2. Query `entity_links` to build co-occurrence matrix: which entities appear together across captures
3. Group captures by embedding similarity (cosine > 0.75) to find thematic clusters
4. Assemble context within token budget (default: 30K tokens), grouped by brain view
5. Call LLM (`synthesis` alias) with `daily_connections_v1.txt` prompt template
6. Parse JSON output into `DailyConnectionsOutput`
7. Deliver via Pushover (top 3 connections, truncated)
8. Save output as capture (`capture_type: 'reflection'`, `source: 'system'`, tags: `['connections', 'skill-output']`)
9. Log to `skills_log` with structured `result` JSONB

**Options**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| windowDays | integer | 7 | How many days of captures to analyze |
| tokenBudget | integer | 30000 | Max tokens for LLM context assembly |
| modelAlias | string | synthesis | LLM model alias for synthesis |

**Result**:
```typescript
interface DailyConnectionsOutput {
  connections: Array<{
    theme: string          // Short title for the connection
    captures: string[]     // IDs of captures involved
    brain_views: string[]  // Which views are connected
    entities: string[]     // Entities that bridge the connection
    insight: string        // Why this connection matters
    confidence: number     // 0.0-1.0 confidence in the connection
  }>
  meta: {
    captures_analyzed: number
    entities_found: number
    clusters_detected: number
    window_days: number
  }
}
```

**Failure handling**: LLM call failure propagates to BullMQ retry (3 attempts). Pushover and skills_log failures are caught and logged (non-fatal).

**Implementation**: `packages/workers/src/skills/daily-connections.ts`

### 12.2d Drift Monitor Skill (F22)

> **Phase 5A** -- Proactive intelligence skill that detects when tracked commitments, bets, or projects go quiet.

**Purpose**: Compares active bets, governance commitments, and entity mention frequency against capture recency to surface potential drift. Alerts the user to items that may need attention before they slip.

**Trigger**: Scheduled daily at 8:00 AM via BullMQ repeatable job. Manual via `POST /api/v1/skills/drift-monitor/trigger` or Slack `!drift`.

**Algorithm**:
1. Load all pending bets from `bets` table (resolution = 'pending')
2. For each bet: query captures mentioning the bet's statement/entities in the last 14 days
3. Load governance session outputs from last 30 days; extract commitments (action items, decisions)
4. For each commitment: check for follow-up captures (semantic match via `hybrid_search()`)
5. Query entity mention frequency: compare last 7 days vs. previous 7 days using `entity_links` join on `captures.created_at`
6. Flag drift items:
   - Pending bet with resolution_date within 30 days AND zero related captures in 14 days → HIGH
   - Pending bet with declining mention frequency → MEDIUM
   - Governance commitment with zero follow-up captures → MEDIUM
   - Entity mention frequency dropped >50% week-over-week → LOW
7. Call LLM (`synthesis` alias) with `drift_monitor_v1.txt` prompt template
8. Parse JSON output into `DriftMonitorOutput`
9. Deliver via Pushover only if any items have severity ≥ MEDIUM
10. Save output as capture (`capture_type: 'reflection'`, `source: 'system'`, tags: `['drift', 'skill-output']`)
11. Log to `skills_log`

**Options**:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| silenceThresholdDays | integer | 14 | Days of no activity before flagging |
| entityDeclineThreshold | number | 0.5 | Week-over-week mention frequency decline ratio |
| modelAlias | string | synthesis | LLM model alias |

**Result**:
```typescript
interface DriftMonitorOutput {
  drift_items: Array<{
    item: string           // What is drifting
    type: 'bet' | 'commitment' | 'entity' | 'project'
    last_activity: string  // ISO date of last related capture
    days_silent: number    // Days since last activity
    severity: 'high' | 'medium' | 'low'
    suggested_action: string
    related_captures: string[]  // IDs of relevant captures
  }>
  summary: string         // LLM-generated drift summary
  meta: {
    bets_checked: number
    commitments_checked: number
    entities_checked: number
    total_drift_items: number
  }
}
```

**Failure handling**: Same as daily-connections — LLM failure retried by BullMQ; delivery/logging non-fatal.

**Implementation**: `packages/workers/src/skills/drift-monitor.ts`

### 12.2e URL Content Extraction Service (F24)

> **Phase 5B** -- Lightweight URL-to-text extraction for bookmark captures.

**Purpose**: Fetches a web page by URL, extracts readable content using Mozilla Readability, and returns structured metadata for capture creation.

**Dependencies**: `@mozilla/readability` (content extraction), `linkedom` (DOM parsing without browser).

**Service**:
```typescript
// packages/shared/src/services/url-extractor.ts

interface UrlExtractionResult {
  title: string
  content: string        // Readable text (Readability output)
  excerpt: string        // First ~200 chars
  siteName: string | null
  byline: string | null
  url: string
  fetchedAt: string      // ISO timestamp
}

class UrlExtractorService {
  /**
   * Fetch URL and extract readable content.
   * 1. HTTP GET with 10s timeout, User-Agent header
   * 2. Parse HTML with linkedom
   * 3. Extract with Readability
   * 4. Fallback: strip HTML tags if Readability fails
   * 5. Truncate content to 50K chars
   */
  async extract(url: string): Promise<UrlExtractionResult>
}
```

**API Integration**: `POST /api/v1/captures` accepts `source: 'bookmark'`. When `source_metadata.url` is present and `content` is empty/missing, the capture route calls `UrlExtractorService.extract(url)` to populate content before pipeline processing.

**Slack Integration**: New `!bookmark <url>` command in IntentRouter. Handler:
1. Parse URL from message text
2. Call Core API `POST /captures` with `{ source: 'bookmark', source_metadata: { url }, capture_type: 'observation', brain_view: 'technical' }`
3. Reply in thread with title, excerpt, and capture ID

**Implementation**: `packages/shared/src/services/url-extractor.ts`

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

// Drift monitor — Daily 8:00 AM (morning awareness alert)
await skillQueue.add('drift-monitor', {}, {
  repeat: { pattern: '0 8 * * *' }, // cron: Daily 8 AM
});

// Daily connections — Daily 9:00 PM (after day's captures are in)
await skillQueue.add('daily-connections', {}, {
  repeat: { pattern: '0 21 * * *' }, // cron: Daily 9 PM
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

### 13.1 SSE from Core API

> **As-built** -- the original TDD sketched a `streamSSE` / `db.listen` pattern. The actual implementation uses a `PgNotify` singleton with Hono `stream()` and multi-channel subscription. Updated below to match.

For the web dashboard, Server-Sent Events (SSE) from the Core API provide live updates. A dedicated `PgNotify` singleton maintains a persistent Postgres connection and LISTENs on multiple channels. SSE clients subscribe to the singleton and receive parsed JSON payloads for each NOTIFY event.

**Architecture**:

```
                                  ┌──────────────────────┐
  Postgres NOTIFY ──────────────> │  PgNotify singleton   │
  (capture_created,               │  (lib/pg-notify.ts)   │
   pipeline_complete,             │  - pg.Client LISTEN   │
   skill_complete,                │  - subscriber Set     │
   bet_expiring)                  └──────────┬───────────┘
                                             │ fan-out
                              ┌──────────────┼──────────────┐
                              ▼              ▼              ▼
                         SSE client 1   SSE client 2   SSE client N
                         (dashboard)    (monitoring)
```

**Server (Hono stream route)**:
```typescript
// packages/core-api/src/routes/events.ts
import { stream } from 'hono/streaming'
import { pgNotify } from '../lib/pg-notify.js'

app.get('/api/v1/events', (c) => {
  c.header('Content-Type', 'text/event-stream')
  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')
  c.header('X-Accel-Buffering', 'no')

  return stream(c, async (s) => {
    // Initial connection confirmation
    await s.write(`event: connected\ndata: {"ts":"${new Date().toISOString()}"}\n\n`)

    // Subscribe to all Postgres NOTIFY channels
    const unsub = pgNotify.subscribe(async (payload) => {
      const data = JSON.stringify(payload.data)
      await s.write(`event: ${payload.channel}\ndata: ${data}\n\n`)
    })

    // 30s heartbeat keeps connection alive through proxies
    const heartbeat = setInterval(() => s.write(`: heartbeat ${Date.now()}\n\n`), 30_000)

    s.onAbort(() => { clearInterval(heartbeat); unsub() })
    await new Promise<void>((resolve) => s.onAbort(resolve))
  })
})
```

**PgNotify singleton** (`lib/pg-notify.ts`):
- Uses a dedicated `pg.Client` (not the Drizzle pool) for LISTEN
- LISTENs on channels: `capture_created`, `pipeline_complete`, `skill_complete`, `bet_expiring`
- Fan-out to all registered subscribers via `Set<Subscriber>`
- `subscribe()` returns an unsubscribe function for cleanup
- `notify(channel, data)` sends NOTIFY from the application side (used by pipeline stages)
- `stop()` closes the client and clears all subscribers (called on graceful shutdown)

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
- Bet expiration alerts

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
| Pipeline retry | 1. Create capture, 2. Simulate LiteLLM unavailability, 3. Restore LiteLLM connectivity, 4. Wait for retry | Capture eventually completes |
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

  # Ollama: NOT in Open Brain stack. Embeddings (spark-qwen3-embedding-4b) and LLM inference both route through external LiteLLM at https://llm.k4jda.net.
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

# 5. Verify external LiteLLM proxy is reachable and spark-qwen3-embedding-4b alias works
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
- [ ] LiteLLM spark-qwen3-embedding-4b alias reachable; raw response is 2560d, truncated to 768d in the embedding service
- [ ] Actual embedding throughput measured and documented (update TDD Section 4.5 estimates)
- [ ] Embedding quality validated with 50+ real captures
- [ ] hybrid_search (RRF) function deployed
- [ ] fts_only_search (FTS fallback) function deployed
- [ ] actr_temporal_score + update_capture_embedding functions deployed
- [ ] FTS GIN index created on captures.content
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
| Embedding generation | ~700ms | LiteLLM API call (spark-qwen3-embedding-4b) |
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
| Embedding (LiteLLM) | N/A — managed via LiteLLM | N/A | If LiteLLM embedding is slow, embeddings queue in BullMQ. Monitor via LiteLLM dashboard. |
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
| 2026-03-10 | v0.6: Hardening 7.2 — Replaced speculative SQL functions with as-built implementations (hybrid_search, fts_only_search, actr_temporal_score, update_capture_embedding, vector_search, fts_search). Updated synthesize endpoint to match simplified implementation. Updated all cross-references. | Troy Davis / Claude |
| 2026-03-11 | v0.7: Phase 5 — Added technical design for F21 (daily connections skill), F22 (drift monitor skill), F24 (URL/bookmark capture). New TDD sections: 12.2c (daily connections), 12.2d (drift monitor), 12.2e (URL extraction service). Updated scope, phased implementation, job definitions, scheduled jobs. F27 (image capture) documented in PRD but deferred from TDD. | Troy Davis / Claude |

### E. Operational Runbook

Common failure scenarios and resolution steps.

**LiteLLM embedding unavailable (embeddings queuing)**
1. Check LiteLLM health: `curl https://llm.k4jda.net/health`
2. Check spark-qwen3-embedding-4b alias: `curl -H "Authorization: Bearer $LITELLM_API_KEY" https://llm.k4jda.net/v1/models`
3. Captures will auto-retry via BullMQ backoff. Check Bull Board for queue depth.
4. If LiteLLM connectivity issue, check network and LiteLLM admin panel at llm.k4jda.net
5. Once LiteLLM recovers, BullMQ will automatically process the queued embedding jobs

**LiteLLM can't reach LLM providers**
1. Check LiteLLM health: `curl https://llm.k4jda.net/health`
2. Check API keys configured on external LiteLLM server
3. LiteLLM auto-falls back (synthesis → gpt-4o, governance → claude-sonnet)
4. If all providers down: LLM tasks queue in BullMQ. Captures still ingested; embeddings queue in BullMQ until LiteLLM recovers.

**Pipeline queue depth > 100**
1. Check Bull Board at `/admin/queues`
2. Most likely cause: LiteLLM is slow or unreachable for embeddings
3. Check LiteLLM health: `curl https://llm.k4jda.net/health`
4. If LiteLLM healthy but slow: captures are just queued, they'll process eventually
5. If persistent: check for a stuck job — remove it via Bull Board

**Embedding model swap**
1. Update `embedding` model in `config/ai-routing.yaml` to switch models; no LiteLLM config change required
2. Ensure the new model alias is available on LiteLLM at llm.k4jda.net
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
