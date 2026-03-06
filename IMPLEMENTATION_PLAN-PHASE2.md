# Implementation Plan — Open Brain (Phase 2)

| Field | Value |
|-------|-------|
| Based On | docs/PRD.md v0.6, docs/TDD.md v0.5 |
| Created | 2026-03-05 |
| Phases | 9-16 (this file). Phases 1-8 in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |
| Scope | Voice Pipeline through Polish (PRD Phases 2A–4) |

---

## Phase Summary

| Phase | Title | Complexity | Files | Est. LOC | Work Items |
|-------|-------|------------|-------|----------|------------|
| 9 | Voice Pipeline | M | ~10 | ~600 | 5 |
| 10 | Notifications + Weekly Brief | L | ~14 | ~800 | 6 |
| 11 | Slack Commands + Semantic Triggers | M | ~12 | ~700 | 5 |
| 12 | Entity Graph + Resolution | L | ~10 | ~700 | 5 |
| 13 | Governance Sessions + Bet Tracking | L | ~12 | ~800 | 5 |
| 14 | Monitoring Skills | M | ~8 | ~500 | 4 |
| 15 | Web Dashboard | L | ~20 | ~1200 | 6 |
| 16 | Document Ingestion + Sources | M | ~12 | ~700 | 5 |

**Total: ~98 files, ~6,000 LOC, 41 work items**

---

<!-- BEGIN PHASES -->

## Phase 9: Voice Pipeline

**Goal**: Voice memos flow from Apple Watch → iOS Shortcut → voice-capture HTTP endpoint → faster-whisper → Core API → pipeline → Postgres.

**Dependencies**: Phase 8 (full Phase 1 complete — pipeline, search, Slack, MCP all working)

**Test Gate (PRD 2A)**: Record on Apple Watch → transcript appears as capture with correct metadata. Different audio formats (.m4a, .wav, .mp3) transcribe correctly. Retry logic handles Core API downtime. Pushover confirmation on successful capture.

---

### 9.1 faster-whisper Container — COMPLETE 2026-03-05

**Description**: Configure faster-whisper container in Docker Compose. Large-v3 model, CPU int8 compute for i7-9700 server.

**Status:** COMPLETE 2026-03-05

**Complexity**: S

**Files to Modify**:
- `docker-compose.yml` — Add faster-whisper service (fedirz/faster-whisper-server:0.4.1, pinned version, env: WHISPER__MODEL=large-v3, WHISPER__DEVICE=cpu, WHISPER__COMPUTE_TYPE=int8, 8GB memory limit, volume for model cache, healthcheck, open-brain network)

**Acceptance Criteria**:
- Container starts and preloads large-v3 model
- POST /transcribe accepts audio file, returns transcript text
- Transcribes 5-minute audio in <60 seconds on CPU
- Health check passes at /health

**Requirement Refs**: PRD F10 (faster-whisper), TDD §8.6 (faster-whisper integration), TDD §2.3 (8GB memory)

---

### 9.2 Voice-Capture Package Setup — COMPLETE 2026-03-05

**Description**: Set up packages/voice-capture/ as a TypeScript service that exposes an HTTP endpoint for receiving audio from iOS Shortcuts and processes it through faster-whisper → classification → Core API ingest.

**Status:** COMPLETE 2026-03-05

**Complexity**: M

**Files to Create**:
- `packages/voice-capture/src/server.ts` — Hono app on port 3001. POST /api/capture: accept multipart audio file. POST /health.
- `packages/voice-capture/src/services/transcription.ts` — TranscriptionService: sends audio to faster-whisper POST /v1/audio/transcriptions (OpenAI-compatible API). Returns transcript text + language + duration.
- `packages/voice-capture/src/services/classification.ts` — ClassificationService: calls AIRouterService or LiteLLM directly for capture type classification. Returns pre_extracted object (template, confidence, fields, transcript_raw).

**Acceptance Criteria**:
- HTTP endpoint accepts audio upload from iOS Shortcut
- Audio routed to faster-whisper for transcription
- Transcription result classified by AI
- Supports .m4a, .wav, .mp3, .ogg formats

**Requirement Refs**: PRD F09 (voice-capture integration), TDD §8.6 (faster-whisper API)

---

### ✅ 9.3 Voice-Capture → Core API Ingest — Completed 2026-03-05

**Description**: After transcription and classification, voice-capture posts the capture to Core API with full metadata.

**Status:** COMPLETE 2026-03-05

**Complexity**: M

**Files to Create**:
- `packages/voice-capture/src/services/ingest.ts` — IngestService: POST to Core API /api/v1/captures with content (transcript), source: 'voice', source_metadata (device: 'apple_watch', duration_seconds, original_filename), pre_extracted (template, confidence, fields, transcript_raw). Retry with exponential backoff (3 attempts) on API failure.
- `packages/voice-capture/src/services/notification.ts` — Pushover notification on successful capture (reuse pattern from existing voice-capture project). Notification includes: capture type, key topics, entity mentions.

**Acceptance Criteria**:
- Capture created in Core API with source='voice' and full metadata
- pre_extracted classification preserved alongside pipeline extraction
- Retry logic handles Core API downtime (3 attempts, exponential backoff)
- Pushover notification sent on success

**Requirement Refs**: PRD F09 (voice-capture changes), TDD §3.2 (ingest payload with pre_extracted)

---

### ✅ Completed 2026-03-05 — 9.4 Voice-Capture Docker + iOS Shortcut

**Description**: Docker Compose service for voice-capture. Document iOS Shortcut configuration.

**Status:** COMPLETE 2026-03-05

**Complexity**: S

**Files to Create/Modify**:
- `docker-compose.yml` — Add voice-capture service (build target, port 3001 optional, env: WHISPER_URL, OPEN_BRAIN_API_URL, PUSHOVER_APP_TOKEN, PUSHOVER_USER_KEY, depends on core-api + faster-whisper, open-brain network)
- `docs/ios-shortcut-setup.md` — Document: iOS Shortcut configuration for Apple Watch/iPhone → POST audio to voice-capture endpoint (via Tailscale IP or Cloudflare Tunnel)

**Acceptance Criteria**:
- voice-capture container builds and starts
- Accessible from LAN and Tailscale
- iOS Shortcut documentation is complete and actionable

**Requirement Refs**: PRD F09, TDD §16.1 (voice-capture Docker service)

---

### ✅ 9.5 Voice Pipeline Tests — Completed 2026-03-05

**Description**: Tests for voice-capture transcription, classification, and ingest flow.

**Status:** COMPLETE 2026-03-05

**Complexity**: S

**Files to Create**:
- `packages/voice-capture/src/__tests__/transcription.test.ts` — Unit tests with mocked faster-whisper: successful transcription, format handling, error handling
- `packages/voice-capture/src/__tests__/ingest.test.ts` — Unit tests with mocked Core API: successful ingest, retry on failure, pre_extracted metadata preserved
- `packages/voice-capture/vitest.config.ts` — Vitest config
- `packages/voice-capture/src/__tests__/classification.test.ts` — Unit tests for ClassificationService with mocked OpenAI SDK: all 8 capture types, JSON fallback to observation, confidence clamping, request construction
- `packages/voice-capture/src/__tests__/notification.test.ts` — Unit tests for NotificationService: isConfigured, send (URL/headers/body), notifyCaptureSuccess (topics, snippets, ellipsis, priority)
- `packages/voice-capture/src/__tests__/server.test.ts` — HTTP integration tests via Hono app.request() with all 4 services mocked: health endpoint, success pipeline, missing file, unsupported format, transcription error, empty transcript, classification error, ingest retry failure

**Acceptance Criteria**:
- All tests pass (77 tests across 5 test files)
- Transcription service correctly calls faster-whisper API
- Ingest retry logic verified (3 attempts)
- Error scenarios handled (faster-whisper down, Core API down)
- ClassificationService fallback to observation on invalid LLM JSON
- NotificationService silently skips when not configured
- Full HTTP pipeline flow verified end-to-end with mocked services

**Requirement Refs**: PRD Phase 2A test gate, TDD §15.3

---

## Phase 10: Notifications + Weekly Brief

**Goal**: System proactively delivers value. Pushover notifications, email reports, and the weekly brief skill generate and deliver automatically.

**Dependencies**: Phase 9 (voice pipeline complete, system has real captures flowing)

**Test Gate (PRD 2B)**: Trigger weekly brief manually → email arrives, Pushover fires, brief captured back into brain. /ob stats returns formatted stats. Pushover priorities respected.

**Prerequisite Note**: At least 2 weeks of real captures before the weekly brief is meaningful. During testing, seed 50+ captures.

---

### ✅ 10.1 Pushover Notification Service — Completed 2026-03-05

**Description**: Pushover integration for iPhone push notifications. All priority levels. Reuse patterns from voice-capture's existing Pushover code.

**Status:** COMPLETE 2026-03-05

**Complexity**: S

**Files to Create**:
- `packages/workers/src/services/pushover.ts` — PushoverService: send(title, message, priority, url?). Priority levels: -1 (low/capture confirmed), 0 (normal/brief ready), 1 (high/bet expiring, pipeline failure), 2 (emergency/system health). Uses Pushover HTTP API. PUSHOVER_APP_TOKEN + PUSHOVER_USER_KEY from env.
- `packages/workers/src/jobs/pushover.ts` — BullMQ job handler: receives notification payload, calls PushoverService.send(). Priority 7, timeout 30s, 3 retries with 5s fixed backoff.

**Acceptance Criteria**:
- Notifications arrive on iPhone within 30 seconds
- Priority levels respected (quiet hours for low, bypass for emergency)
- Notification includes enough context to be useful
- Job retries on transient failure

**Requirement Refs**: PRD F13 (Pushover), TDD §8.4 (Pushover integration), TDD §12.2 (notification jobs)

---

### ✅ Completed 2026-03-05 — 10.2 Email Delivery Service

**Description**: SMTP email delivery for HTML reports and digests.

**Status:** COMPLETE 2026-03-05

**Complexity**: S

**Files to Create**:
- `packages/workers/src/services/email.ts` — EmailService: send(to, subject, htmlBody, textBody). Uses nodemailer with SMTP config (SMTP_HOST, SMTP_USER, SMTP_PASS from env). Includes plain text fallback.
- `packages/workers/src/jobs/email.ts` — BullMQ job handler: receives email payload, calls EmailService.send(). Priority 5, timeout 60s, 3 retries with 30s fixed backoff.
- `packages/workers/src/templates/weekly-brief.html` — HTML email template for weekly brief (mobile-friendly, simple layout)

**Acceptance Criteria**:
- Emails send via SMTP successfully
- HTML renders correctly on iPhone Mail app
- Plain text fallback included
- From address clearly identifies Open Brain

**Requirement Refs**: PRD F14 (email delivery), TDD §8.5 (SMTP integration)

---

### ✅ Completed 2026-03-05 — 10.3 Pipeline Notify Stage (Real Implementation)

**Description**: Replace the stub notify stage from Phase 6 with real notification delivery. Sends Pushover, Slack replies, or both based on capture source and pipeline config.

**Status:** COMPLETE 2026-03-05

**Complexity**: S

**Files to Modify**:
- `packages/workers/src/pipeline/stages/notify.ts` — Real implementation: based on notify targets in pipeline config, enqueue appropriate notification jobs (pushover, slack-reply). Source-aware: voice captures → Pushover, Slack captures → Slack thread reply, API captures → no notification by default.
- `packages/slack-bot/src/lib/slack-reply-service.ts` — Service for sending Slack thread replies from workers (via Slack Web API). Used by notification job handler.

**Files to Create**:
- `packages/workers/src/jobs/slack-reply.ts` — BullMQ job handler: sends Slack thread reply. Priority 7, timeout 10s, 3 retries with 2s backoff.

**Acceptance Criteria**:
- Voice captures → Pushover notification
- Slack captures → thread reply in Slack
- Pipeline config controls notification targets
- Notification failures don't block pipeline completion

**Requirement Refs**: PRD F03 (notify stage), TDD §12.2 (notification jobs)

---

### ✅ Completed 2026-03-05 — 10.4 Skill Execution Framework

**Description**: BullMQ-based skill execution framework. Skills are scheduled (cron) or triggered manually. Each skill queries captures, runs AI synthesis, and delivers results.

**Status:** COMPLETE 2026-03-05

**Complexity**: M

**Files to Create**:
- `packages/workers/src/skills/executor.ts` — SkillExecutor: runs a skill by name. Loads skill config from skills.yaml. Logs execution to skills_log table (start, config, result, captures queried, model used, tokens, duration, error). Handles retry with Pushover alert on final failure.
- `packages/workers/src/skills/scheduler.ts` — Skill scheduler: reads skills.yaml, sets up BullMQ repeatable jobs with cron expressions. weekly-brief: Sunday 8pm, drift-monitor: Monday 9am, daily-connections: daily 6pm.
- `config/skills.yaml` — Full skill configuration: weekly_brief (schedule, AI model, delivery targets, capture window), drift_monitor (schedule, thresholds), daily_connections (schedule)

**Acceptance Criteria**:
- Skills execute on schedule via BullMQ cron
- Execution logged to skills_log with timing and token usage
- Manual trigger works: POST /api/v1/skills/:name/trigger
- On final failure (3 retries): Pushover alert with error details

**Requirement Refs**: TDD §12.4 (scheduled jobs), PRD F12 (weekly brief schedule), TDD §12.2 (skill retry policy)

---

### ✅ Completed 2026-03-05 — 10.5 Weekly Brief Skill

**Description**: The first real output skill. Queries last 7 days of captures, synthesizes via AI, delivers via email + Pushover + captures back into brain.

**Status:** COMPLETE 2026-03-05

**Complexity**: L

**Files to Create**:
- `packages/workers/src/skills/weekly-brief.ts` — WeeklyBriefSkill:
  1. Query all captures from past 7 days via SearchService
  2. Group by brain_view and topics
  3. Assemble context (respect 50K token budget, truncate lowest similarity)
  4. Call AIRouterService.complete('weekly_brief', prompt) with weekly_brief_v1 template
  5. Parse structured output: headline, wins, blockers, risks, open_loops, next_week_focus, avoided_decisions, drift_alerts, connections
  6. Deliver: email (HTML), Pushover ("Your weekly brief is ready"), capture back into brain (source: 'system', capture_type: 'reflection')
  7. Log to skills_log
- `config/prompts/weekly_brief_v1.txt` — Prompt template: instructs AI to generate structured brief with all sections. Anti-fluff instructions. Max 800 words.

**Acceptance Criteria**:
- Brief generated with all 9 sections
- Output under 800 words
- Email arrives with formatted HTML
- Pushover notification sent
- Brief captured back into brain for future searchability
- Manual trigger via `/ob brief` works

**Requirement Refs**: PRD F12 (weekly brief), TDD §12.4 (weekly-brief job)

---

### ✅ Completed 2026-03-05 — 10.6 Skills API + Notification Tests

**Description**: API endpoints for skill management and tests for notification + skill framework.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/routes/skills.ts` —
  - GET /api/v1/skills → list configured skills with schedules and last run status (from skills_log)
  - POST /api/v1/skills/:name/trigger → manually trigger a skill → enqueue skill execution job
- `packages/workers/src/__tests__/pushover.test.ts` — Unit tests with mocked Pushover API
- `packages/workers/src/__tests__/email.test.ts` — Unit tests with mocked SMTP
- `packages/workers/src/__tests__/weekly-brief.test.ts` — Unit tests: capture query, context assembly, AI call, delivery, skills_log entry
- `packages/core-api/src/__tests__/skills-routes.test.ts` — Integration tests: list skills, trigger skill

**Acceptance Criteria**:
- GET /api/v1/skills returns skill list with schedules
- POST /api/v1/skills/:name/trigger enqueues execution
- All notification tests pass
- Weekly brief test verifies full flow

**Status:** COMPLETE 2026-03-05

**Requirement Refs**: PRD F01 (skills endpoints), PRD Phase 2B test gate

---

## Phase 11: Slack Commands + Semantic Triggers

**Goal**: Rich Slack command interface and proactive memory surfacing via semantic triggers.

**Dependencies**: Phase 10 (notifications and skills framework working)

**Test Gate (PRD 2B/2C)**: !stats returns formatted stats. !brief triggers brief generation. Trigger created via Slack → matching capture fires notification with cooldown. Trigger test shows top 5 matches.

---

### ✅ Completed 2026-03-05 — 11.1 Slack Command Handler

**Description**: ! prefix commands for system interaction. Dispatches to appropriate Core API endpoints.

**Status:** COMPLETE 2026-03-05

**Complexity**: M

**Files to Create**:
- `packages/slack-bot/src/handlers/command.ts` — CommandHandler: parses ! prefix commands, dispatches to Core API:
  - `!stats` → GET /api/v1/stats → format and reply
  - `!brief` → POST /api/v1/skills/weekly-brief/trigger → "Generating brief..." + result
  - `!brief last` → GET last skills_log for weekly-brief → format and reply
  - `!recent [N]` → GET /api/v1/captures?limit=N → format and reply
  - `!entities` → GET /api/v1/entities → format and reply
  - `!entity <name>` → GET /api/v1/entities?name=... → format and reply
  - `!board quick` → start quick board check (Phase 13 — stub for now)
  - `!board quarterly` → start quarterly review (Phase 13 — stub)
  - `!pipeline status` → pipeline health from Bull Board data
  - `!retry <capture_id>` → POST /api/v1/captures/:id/retry
  - `!help` → list all commands with descriptions
  - Unknown command → "Unknown command. Type !help for available commands."

**Acceptance Criteria**:
- All commands return formatted responses within 5 seconds
- !brief generation sends "generating..." first, then result
- Unknown commands return help text
- Commands work in #open-brain channel and DM

**Requirement Refs**: PRD F11 (Slack commands), TDD §8.1

---

### ✅ 11.2 Triggers Table + CRUD API — Completed 2026-03-05

**Description**: Trigger management API endpoints. Triggers table already exists from Phase 2 schema.

**Complexity**: S

**Files to Create**:
- `packages/core-api/src/services/trigger.ts` — TriggerService:
  - create(name, queryText): generate embedding for queryText via EmbeddingService, INSERT trigger with embedding, threshold 0.72, cooldown 60min
  - list(): SELECT all triggers with last_fired_at, fire_count, is_active
  - delete(nameOrId): SET is_active = false (soft deactivate)
  - test(queryText, limit=5): generate embedding, compute cosine similarity against recent captures, return top 5 matches without firing
- `packages/core-api/src/routes/triggers.ts` —
  - GET /api/v1/triggers → list all triggers
  - POST /api/v1/triggers → create trigger
  - DELETE /api/v1/triggers/:id → deactivate trigger
  - POST /api/v1/triggers/test → test trigger against existing captures

**Acceptance Criteria**:
- Triggers created with pre-computed embedding
- Max 20 active triggers enforced
- Default threshold 0.72, cooldown 60 minutes
- Test endpoint returns matches without firing

**Status:** COMPLETE 2026-03-05

**Requirement Refs**: PRD F28 (semantic triggers), TDD §4.2 (triggers schema), TDD §12.2a (check_triggers)

---

### ✅ Completed 2026-03-05 — 11.3 Check Triggers BullMQ Job

**Description**: Background job that checks new captures against active triggers. Fires notifications when similarity exceeds threshold and cooldown has elapsed.

**Complexity**: M

**Files to Create**:
- `packages/workers/src/jobs/check-triggers.ts` — CheckTriggersJob handler:
  1. Load active triggers from Redis cache (60s TTL, refresh from DB if expired)
  2. Get capture embedding from DB
  3. For each active trigger not in cooldown: compute cosine similarity
  4. If similarity >= threshold: fire trigger
  5. Firing: run match_captures_hybrid for related captures (limit 5), send notification (Pushover/Slack per delivery_channel), update trigger (lastFiredAt, fireCount++)
  6. All checks run in parallel (Promise.all)
  7. No match = no-op, complete successfully
- `packages/workers/src/pipeline/stages/embed.ts` — Update: after successful embedding, enqueue check-triggers job with captureId

**Acceptance Criteria**:
- Trigger check completes in <10ms for ≤20 triggers (in-memory comparison)
- Matching triggers fire notification within pipeline window
- Cooldown prevents spam (60 min between fires per trigger)
- Trigger cache refreshed from DB every 60 seconds
- No trigger match → job completes silently

**Status:** COMPLETE 2026-03-05

**Requirement Refs**: TDD §12.2a (CheckTriggersJob), PRD F28 (trigger behavior)

---

### ✅ Completed 2026-03-05 — 11.4 Slack Trigger Commands

**Description**: Slack commands for trigger management via ! prefix.

**Complexity**: S

**Files to Modify**:
- `packages/slack-bot/src/handlers/command.ts` — Add trigger commands:
  - `!trigger add "QSR timeline"` → POST /api/v1/triggers → confirm creation
  - `!trigger list` → GET /api/v1/triggers → format list with status, last fired, fire count
  - `!trigger delete <name>` → DELETE /api/v1/triggers/:name → confirm deactivation
  - `!trigger test "QSR timeline"` → POST /api/v1/triggers/test → show top 5 matches

**Acceptance Criteria**:
- All trigger commands work from Slack
- Trigger creation confirms with name and threshold
- Trigger list shows all active triggers with status
- Trigger test shows matches without firing

**Status:** COMPLETE 2026-03-05

**Requirement Refs**: PRD F28 (Slack trigger commands)

---

### ✅ Completed 2026-03-05 — 11.5 Commands + Triggers Tests

**Description**: Tests for Slack commands and trigger system.

**Complexity**: M

**Files to Create**:
- `packages/slack-bot/src/__tests__/command-handler.test.ts` — Unit tests: each command dispatches correctly, unknown → help, formatting
- `packages/core-api/src/__tests__/trigger-service.test.ts` — Unit tests: create trigger with embedding, list, delete, test matches
- `packages/workers/src/__tests__/check-triggers.test.ts` — Unit tests: trigger match fires notification, cooldown enforced, cache refresh, no match → no-op

**Acceptance Criteria**:
- All command dispatch tests pass
- Trigger lifecycle tests pass (create, match, fire, cooldown)
- Cache refresh behavior verified

**Status:** COMPLETE 2026-03-05

**Requirement Refs**: PRD Phase 2B/2C test gates

---

## Phase 12: Entity Graph + Resolution

**Goal**: Entities (people, projects, decisions) auto-extracted from captures and linked. Three-tier resolution with LLM disambiguation at 0.8 confidence threshold.

**Dependencies**: Phase 11 (triggers working, full Phase 2 pipeline)

**Test Gate (PRD Phase 3 partial)**: Entities auto-created from capture metadata. Entity detail shows linked captures. Duplicate detection works for common name variations. Merge/split via Slack commands.

---

### ✅ Completed 2026-03-05 — 12.1 EntityResolutionService

**Description**: Three-tier entity matching: exact name → alias → LLM disambiguation. Creates new entities when no confident match found.

**Status:** COMPLETE 2026-03-05

**Complexity**: L

**Files to Create**:
- `packages/core-api/src/services/entity-resolution.ts` — EntityResolutionService:
  - resolve(mention, context):
    1. Exact match: SELECT WHERE name = mention (case-insensitive)
    2. Alias match: SELECT WHERE mention = ANY(aliases)
    3. LLM disambiguation: prompt with candidates + context → confidence score
       - confidence >= 0.8 → link to candidate
       - confidence < 0.8 → create new entity
    4. No candidates → INSERT new entity, return 'created'
  - merge(sourceId, targetId): Move all entity_links from source to target, merge aliases, delete source
  - split(entityId, alias): Create new entity from alias, move matching entity_links

**Acceptance Criteria**:
- "Tom", "Tom Smith", "Tom at QSR" → same entity (alias or LLM match)
- Confidence < 0.8 → new entity created (no false merges)
- Merge transfers all entity_links and aliases
- Split creates independent entity with transferred links

**Requirement Refs**: TDD §6.2 (EntityResolutionService), PRD F15 (entity resolution)

---

### 12.2 Link Entities Pipeline Stage

**Description**: Pipeline stage that extracts entity mentions from capture metadata and resolves them via EntityResolutionService.

**Complexity**: M

**Files to Create**:
- `packages/workers/src/pipeline/stages/link-entities.ts` — Link entities stage:
  1. Read capture metadata.people, metadata.topics (from extract_metadata stage)
  2. For each person mention: EntityResolutionService.resolve(name, context) → entity_links INSERT
  3. For each project/topic mention: resolve as 'project' or 'concept' entity type
  4. Update entity.last_seen, entity.mention_count
- `config/pipelines.yaml` — Update: add link_entities stage after extract_metadata in default pipeline

**Acceptance Criteria**:
- Captures with people mentions → entity_links created
- Entity mention_count and last_seen updated
- New entities auto-created for first mentions
- Stage failure → log, don't block pipeline

**Requirement Refs**: PRD F03 (link_entities stage), PRD F15 (entity graph)

---

### ✅ 12.3 Entity API Endpoints — Completed 2026-03-05

**Description**: CRUD endpoints for entities and entity detail views.

**Status:** COMPLETE 2026-03-05

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/services/entity.ts` — EntityService:
  - list(filters): Paginated entities with type_filter, sort_by (mention_count, last_seen, name)
  - getById(id): Entity detail with recent linked captures (JOIN entity_links → captures)
  - getByName(name): Lookup by name (case-insensitive)
  - merge(sourceId, targetId): Delegate to EntityResolutionService.merge()
  - split(entityId, alias): Delegate to EntityResolutionService.split()
- `packages/core-api/src/routes/entities.ts` —
  - GET /api/v1/entities → list with filters
  - GET /api/v1/entities/:id → detail with linked captures
  - POST /api/v1/entities/:id/merge → merge two entities
  - POST /api/v1/entities/:id/split → split alias to new entity

**Acceptance Criteria**:
- Entity list returns sorted results with mention counts
- Entity detail shows all linked captures, sorted by recency
- Merge and split operations work correctly
- MCP get_entity and list_entities tools now return real data

**Requirement Refs**: PRD F01 (entity endpoints), TDD §3.2 (GET /api/v1/entities)

---

### 12.4 Entity Slack Commands

**Description**: Slack commands for entity browsing and management.

**Complexity**: S

**Files to Modify**:
- `packages/slack-bot/src/handlers/command.ts` — Update entity commands (previously stubbed):
  - `!entities` → GET /api/v1/entities → formatted list with mention counts
  - `!entity <name>` → GET /api/v1/entities?name=... → detail with recent captures
  - `!entity merge <name1> <name2>` → POST merge endpoint
  - `!entity split <name> <alias>` → POST split endpoint

**Acceptance Criteria**:
- Entity commands return formatted results
- Merge/split operations confirm with details
- Entity not found → helpful error message

**Requirement Refs**: PRD F15 (entity management via Slack)

---

### 12.5 Entity Tests

**Description**: Tests for entity resolution, pipeline stage, and API endpoints.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/__tests__/entity-resolution.test.ts` — Unit tests: exact match, alias match, LLM match (confidence >= 0.8), LLM reject (confidence < 0.8), new entity creation, merge, split
- `packages/workers/src/__tests__/link-entities.test.ts` — Unit tests: people extraction, entity creation, mention_count update
- `packages/core-api/src/__tests__/entity-routes.test.ts` — Integration tests: list, detail, merge, split

**Acceptance Criteria**:
- All resolution tiers tested
- Confidence threshold (0.8) enforced
- Merge/split data integrity verified
- Pipeline stage handles missing metadata gracefully

**Requirement Refs**: TDD §15.3, PRD Phase 3 test gate (partial)

---

## Phase 13: Governance Sessions + Bet Tracking

**Goal**: LLM-driven governance sessions in Slack threads. Quick board check and quarterly review. Bets created with falsifiable criteria. Session pause/resume with 30-day expiry.

**Dependencies**: Phase 12 (entity graph enables evidence linking in governance)

**Test Gate (PRD Phase 3 partial)**: Quick check runs as Slack thread interaction in <15 minutes. Anti-vagueness gate enforced. Bets created with clear criteria. Sessions can be paused and resumed. All transcripts captured back into brain.

---

### 13.1 Session Management

**Description**: Session lifecycle management — create, respond, pause, resume, complete, abandon. Transcript stored in session_messages table.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/services/session.ts` — SessionService:
  - create(type, config): INSERT session with state (turn_count=0, max_turns, topics_remaining), return first bot message
  - respond(sessionId, userMessage): INSERT session_message (role: user), run governance engine, INSERT bot response, update state. Check idle timeout (30 min → auto-pause).
  - pause(sessionId): SET status='paused', paused_at=now()
  - resume(sessionId): Check 30-day expiry (if paused_at > 30 days → auto-expire). Replay transcript from session_messages. Resume conversation.
  - complete(sessionId): SET status='completed', completed_at, generate result. Capture session summary back into brain.
  - abandon(sessionId): SET status='abandoned'
- `packages/core-api/src/routes/sessions.ts` —
  - POST /api/v1/sessions → create session
  - POST /api/v1/sessions/:id/respond → submit response
  - GET /api/v1/sessions/:id → get session state + transcript

**Acceptance Criteria**:
- Sessions persist in Postgres with transcript in session_messages
- Pause/resume works with 30-day max pause
- Auto-expire paused sessions > 30 days
- Idle timeout (30 min) → auto-pause
- Completed sessions captured back into brain

**Requirement Refs**: PRD F16 (session management), TDD §6.2 (SessionService)

---

### 13.2 Governance Engine

**Description**: LLM-driven conversation engine with guardrails. Not an FSM — the LLM drives the conversation but with structural constraints (required topics, max turns, anti-vagueness).

**Complexity**: L

**Files to Create**:
- `packages/core-api/src/services/governance-engine.ts` — GovernanceEngine:
  - processResponse(session, userMessage):
    1. Load conversation history from session_messages
    2. Check anti-vagueness: if answer lacks concrete evidence, push back (max 2 skips per topic)
    3. Update state: mark topic covered, advance to next
    4. Query relevant captures as evidence (SearchService)
    5. Call AIRouterService.complete('governance', prompt) with board role perspective
    6. If all topics covered → generate assessment + 90-day prediction (creates bet)
    7. Return bot response with board_role attribution
  - Board roles applied per topic (rotate through perspectives)
- `packages/core-api/src/services/anti-vagueness.ts` — Anti-vagueness gate: LLM-evaluated check on user responses. Returns { passes: boolean, pushback_message?: string }. Max 2 skips per topic.
- `config/prompts/board_quick_check_v1.txt` — Quick check prompt: 5-question structured audit. Includes board role perspectives, anti-vagueness instructions, assessment generation instructions.

**Acceptance Criteria**:
- Quick check covers 5 required topics
- Anti-vagueness gate pushes back on vague answers
- Board roles attribute responses to perspectives
- Assessment includes 90-day falsifiable prediction → creates bet
- Relevant captures pulled as evidence during session

**Requirement Refs**: PRD F16-F17 (governance sessions), TDD §6.2 (GovernanceEngine)

---

### 13.3 Bet Tracking

**Description**: Bet CRUD, expiration alerts, and resolution. Bets created from governance sessions with falsifiable criteria.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/services/bet.ts` — BetService:
  - create(commitment, criteria, dueDate, sessionId?): INSERT bet with status 'open'
  - list(statusFilter?): Paginated bets with optional status filter
  - resolve(betId, status, evidence?): SET status (correct|wrong), resolved_at, append evidence
  - getExpiring(daysAhead=7): SELECT bets WHERE due_date <= now() + interval AND status = 'open'
- `packages/core-api/src/routes/bets.ts` —
  - GET /api/v1/bets → list bets with optional status filter
  - POST /api/v1/bets → create bet
  - PATCH /api/v1/bets/:id → resolve bet (status + evidence)

**Acceptance Criteria**:
- Bets created with falsifiable criteria and due dates
- Expiring bets queryable (7-day lookahead)
- Resolution updates status and evidence
- Bets linked to sessions when created from governance

**Requirement Refs**: PRD F18 (bet tracking), TDD §4.2 (bets schema)

---

### 13.4 Slack Governance Integration

**Description**: Slack thread-based governance session interaction. Start, respond, pause, resume sessions via Slack.

**Complexity**: M

**Files to Modify**:
- `packages/slack-bot/src/handlers/command.ts` — Wire up governance commands:
  - `!board quick` → create session → start thread interaction
  - `!board quarterly` → create session → start thread interaction
  - `!board resume` → resume paused session in current thread
  - `!board status` → show active/paused sessions
- `packages/slack-bot/src/handlers/session.ts` — Session thread handler: detect replies in governance threads, route to SessionService.respond(), post bot response in thread with board role attribution

**Acceptance Criteria**:
- Quick check runs as complete Slack thread interaction
- Each bot response attributed to board role
- Anti-vagueness pushback appears naturally in conversation
- Session pause/resume works via commands and thread detection
- Completed session generates assessment + bet

**Requirement Refs**: PRD F16 (Slack interactive sessions), PRD Phase 3 test gate

---

### 13.5 Governance + Bet Tests

**Description**: Tests for governance engine, bet tracking, and Slack integration.

**Complexity**: M

**Files to Create**:
- `packages/core-api/src/__tests__/governance-engine.test.ts` — Unit tests: topic progression, anti-vagueness gate, assessment generation, bet creation from session
- `packages/core-api/src/__tests__/bet-service.test.ts` — Unit tests: create, list, resolve, expiring query
- `packages/slack-bot/src/__tests__/session-handler.test.ts` — Unit tests: session thread routing, board role display

**Acceptance Criteria**:
- Governance flow tests cover full session lifecycle
- Anti-vagueness gate tests verify pushback logic
- Bet lifecycle tests verify create → resolve flow

**Requirement Refs**: TDD §15.3, PRD Phase 3 test gate

---

## Phase 14: Monitoring Skills

**Goal**: Drift detection, daily connections, and bet expiration alerts. Slack voice clip handling.

**Dependencies**: Phase 13 (governance sessions and bets exist for drift monitoring)

**Test Gate (PRD Phase 3 complete)**: Drift alerts surface when projects/bets go quiet. Daily connections find cross-topic patterns. Bet expiration alerts fire at 7 days. Slack voice clips route through voice-capture.

---

### 14.1 Drift Monitor Skill

**Description**: Scheduled skill that detects when active projects, bets, or frequently-mentioned entities go quiet.

**Complexity**: M

**Files to Create**:
- `packages/workers/src/skills/drift-monitor.ts` — DriftMonitorSkill:
  1. Query active bets approaching expiration
  2. Query entities with high mention_count but no recent mentions (last_seen > 2 weeks)
  3. Query brain_views with decreasing capture frequency
  4. If findings exist: format drift report, send via Pushover + Slack DM
  5. Capture drift findings back into brain
- `config/prompts/drift_monitor_v1.txt` — Prompt for AI-assisted drift analysis

**Acceptance Criteria**:
- Detects bets approaching expiration (7-day window)
- Detects entities not mentioned recently
- Findings delivered via Pushover and Slack
- Drift findings captured back into brain

**Requirement Refs**: PRD F22 (drift monitor), TDD §12.4 (drift-monitor job)

---

### 14.2 Daily Connections Skill

**Description**: Scheduled skill that finds cross-topic patterns and unexpected connections in recent captures.

**Complexity**: M

**Files to Create**:
- `packages/workers/src/skills/daily-connections.ts` — DailyConnectionsSkill:
  1. Query captures from past 24-48 hours
  2. Group by brain_view and topic clusters
  3. Call AI to identify cross-domain connections (career ↔ technical, personal ↔ work)
  4. If interesting connections found: deliver via Pushover
  5. Capture findings back into brain
- `config/prompts/daily_connections_v1.txt` — Prompt template for connection finding

**Acceptance Criteria**:
- Identifies patterns across brain views
- Only fires when genuinely interesting connections found (not noise)
- Results captured back into brain

**Requirement Refs**: PRD F21 (daily connections), TDD §12.4

---

### 14.3 Bet Expiration Alerts

**Description**: Scheduled check for bets approaching their due date. High-priority Pushover alert.

**Complexity**: S

**Files to Create**:
- `packages/workers/src/jobs/bet-expiration.ts` — BetExpirationJob: query bets with due_date within 7 days and status='open'. For each: send Pushover (high priority) with commitment, criteria, due_date, days remaining. Auto-expire bets past due_date → status='expired'.
- `packages/workers/src/skills/scheduler.ts` — Update: add bet-expiration to daily schedule (runs at 9am)

**Acceptance Criteria**:
- Bets within 7 days of due → high priority Pushover
- Past-due bets auto-expired
- Alert includes enough context to act on

**Requirement Refs**: PRD F18 (bet expiration), PRD F13 (high priority notifications)

---

### 14.4 Slack Voice Clip Handling

**Description**: When Slack voice clips (audio attachments) are posted in #open-brain, route them to voice-capture for transcription and processing.

**Complexity**: S

**Files to Modify**:
- `packages/slack-bot/src/handlers/capture.ts` — Update: detect audio file attachments (files_shared events). Download audio from Slack (using files:read scope). POST audio to voice-capture HTTP endpoint. Wait for response. Reply in thread with transcription result.

**Acceptance Criteria**:
- Slack voice clips detected and routed to voice-capture
- Transcription appears as capture with source: 'slack', source_metadata includes original slack_ts
- Thread reply shows transcription and classification
- Non-audio files ignored

**Requirement Refs**: PRD F20 (Slack voice clip processing), PRD F04 (audio attachment routing)

---

### 14.5 AI Budget Monitoring ($30 Soft Alert)

**Description**: Scheduled daily job that checks monthly LiteLLM spend via `AIRouterService.getMonthlySpend()`. Fires a Pushover alert when spend exceeds the $30 soft threshold. The $50 hard limit is enforced by LiteLLM itself — this catches it early while there's still budget headroom.

**Complexity**: S

**Files to Create/Modify**:
- `packages/workers/src/jobs/budget-check.ts` — BudgetCheckJob: calls `GET https://llm.k4jda.net/spend/logs` with LITELLM_API_KEY. Parses current month total spend. If spend > $30 (BUDGET_SOFT_LIMIT env var, default 30): send Pushover alert (normal priority) with "AI spend is $X.XX this month ($30 soft limit)". Logs spend regardless. No alert if under threshold.
- `packages/workers/src/scheduler.ts` — Update: add budget-check to daily schedule (runs at 8:00 AM, cron: `0 8 * * *`).

**Acceptance Criteria**:
- Runs daily at 8:00 AM
- Fetches current month spend from LiteLLM `/spend/logs`
- Pushover alert fires when spend > $30 (configurable via BUDGET_SOFT_LIMIT)
- No alert when under threshold (just logs)
- BUDGET_SOFT_LIMIT defaults to 30, overridable via env var

**Requirement Refs**: PRD §AI budget ($30 soft alert, $50 hard limit), TDD §8.7 (LiteLLM spend tracking)

---

## Phase 15: Web Dashboard

**Goal**: Vite + React PWA for browsing, searching, and viewing skill outputs. Installable on iPhone home screen.

**Dependencies**: Phase 14 (all backend features complete)

**Test Gate (PRD Phase 4 partial)**: All pages functional. PWA installable. Search < 5s. Dashboard loads < 2s. Voice capture from browser works.

---

### 15.1 Web UI Project Setup

**Description**: Vite + React + TypeScript project with Tailwind CSS, shadcn/ui, and PWA support.

**Complexity**: M

**Files to Create**:
- `packages/web/package.json` — Vite + React + Tailwind + shadcn/ui + vite-plugin-pwa
- `packages/web/vite.config.ts` — Vite config: React plugin, PWA plugin, API proxy to core-api:3000 in dev, path alias @/ → src/
- `packages/web/tsconfig.json` — TypeScript config for React
- `packages/web/tailwind.config.ts` — Tailwind config with shadcn/ui preset
- `packages/web/src/main.tsx` — React entry point
- `packages/web/src/App.tsx` — Root component with React Router (lazy-loaded pages)
- `packages/web/src/lib/api.ts` — API client for Core API: typed fetch wrappers for all Core API endpoints, matching v0.6 schema
- `packages/web/src/lib/types.ts` — Frontend type definitions (import from @open-brain/shared where possible)
- `packages/web/index.html` — HTML entry
- `packages/web/src/index.css` — Tailwind directives

**Acceptance Criteria**:
- `pnpm dev --filter @open-brain/web` starts Vite dev server with HMR
- API proxy forwards /api to core-api in development
- shadcn/ui components available
- PWA manifest configured

**Requirement Refs**: PRD F19 (web dashboard tech), TDD §14.1 (architecture)

---

### 15.2 Dashboard + Stats Page

**Description**: Main dashboard page showing recent captures, brain stats, active bets, system health.

**Complexity**: M

**Files to Create**:
- `packages/web/src/pages/Dashboard.tsx` — Dashboard: recent captures list, brain stats cards (total, by source, by type), active bets summary, pipeline health indicator, upcoming skill runs
- `packages/web/src/components/CaptureCard.tsx` — Reusable capture display component
- `packages/web/src/components/StatsCards.tsx` — Stats display cards
- `packages/web/src/components/Layout.tsx` — App layout with sidebar navigation

**Acceptance Criteria**:
- Dashboard loads in < 2 seconds
- Stats update on refresh
- Responsive on iPhone and desktop
- Navigation to all other pages

**Requirement Refs**: PRD F19 (dashboard page), TDD §14.1

---

### 15.3 Search Page

**Description**: Full semantic search interface with filters, results display, and capture detail view.

**Complexity**: M

**Files to Create**:
- `packages/web/src/pages/Search.tsx` — Search page: query input, filter controls (source, date range, tags, brain_view, entity), results list with similarity scores, pagination. Click result → capture detail modal/panel.
- `packages/web/src/components/SearchFilters.tsx` — Filter controls component
- `packages/web/src/components/CaptureDetail.tsx` — Full capture detail with pipeline_events, linked_entities, metadata

**Acceptance Criteria**:
- Search results return in < 5 seconds
- Filters work (source, date, tags, brain_view)
- Capture detail shows full metadata and pipeline history
- Responsive design

**Requirement Refs**: PRD F19 (search page)

---

### 15.4 Timeline + Entity Pages

**Description**: Chronological capture browser and entity graph browser.

**Complexity**: M

**Files to Create**:
- `packages/web/src/pages/Timeline.tsx` — Chronological capture list with date grouping, infinite scroll, filter by source/type/view
- `packages/web/src/pages/Entities.tsx` — Entity list page with type filter, sort by mentions/recency
- `packages/web/src/pages/EntityDetail.tsx` — Entity detail: metadata, aliases, linked captures timeline, merge/split controls

**Acceptance Criteria**:
- Timeline groups captures by date
- Entity browser shows mention counts and relationships
- Entity detail links to related captures
- Merge/split controls call entity management API

**Requirement Refs**: PRD F19 (timeline, entity browser pages)

---

### 15.5 Briefs, Board, Voice, Settings Pages

**Description**: Remaining pages: weekly brief history, governance sessions, browser voice capture, and settings.

**Complexity**: L

**Files to Create**:
- `packages/web/src/pages/Briefs.tsx` — Weekly brief history, rendered HTML content, browsable
- `packages/web/src/pages/Board.tsx` — Governance session history, active bets table with status, bet resolution controls
- `packages/web/src/pages/Voice.tsx` — MediaRecorder-based voice capture: record → POST audio to voice-capture endpoint → show transcription result
- `packages/web/src/pages/Settings.tsx` — Pipeline config viewer (read-only YAML), skill schedules, AI routing, system health, config reload button

**Acceptance Criteria**:
- Briefs page renders HTML weekly briefs
- Board page shows bet status and allows resolution
- Voice page records and transcribes from browser
- Settings page shows system configuration

**Requirement Refs**: PRD F19 (all pages)

---

### 15.6 PWA + Docker + SSE

**Description**: PWA configuration for installability, Docker Compose service, and SSE integration for real-time updates.

**Complexity**: M

**Files to Create/Modify**:
- `packages/web/src/lib/sse.ts` — SSE client connecting to Core API /api/v1/events. Listens for: capture_created, pipeline_complete, skill_complete, bet_expiring. Updates Zustand store.
- `packages/core-api/src/routes/events.ts` — GET /api/v1/events (SSE endpoint). Uses Postgres LISTEN/NOTIFY for capture_created and pipeline_complete events. Keeps connection alive with heartbeat.
- `packages/core-api/src/lib/pg-notify.ts` — Postgres LISTEN/NOTIFY helper: subscribe to channels, emit events to SSE connections.
- `docker-compose.yml` — Add web service (build from packages/web, nginx, port 3002, service name: web, depends on core-api). Update cloudflared routing: brain.k4jda.net/ → web:80.
- `packages/web/Dockerfile` — Nginx-based: build Vite → copy to nginx, proxy /api to core-api

**Acceptance Criteria**:
- PWA installable on iPhone home screen
- SSE updates dashboard in real-time (new captures appear, pipeline status updates)
- Docker container serves static assets via nginx
- Cloudflare Tunnel routes brain.k4jda.net/ to web (nginx)

**Requirement Refs**: PRD F19 (PWA), TDD §13.1 (SSE), TDD §14.2 (PWA config), TDD §16.1 (web-ui Docker)

---

## Phase 16: Document Ingestion + Additional Sources

**Goal**: Ingest documents (PDF, docx), URLs/bookmarks, and calendar events. Expands the brain beyond voice and text.

**Dependencies**: Phase 15 (web dashboard complete, full system running)

**Test Gate (PRD Phase 4 complete)**: PDF/docx files chunked and ingested as captures. Bookmarks extracted and captured. Calendar events synced. All sources searchable.

---

### 16.1 Document Ingestion Service

**Description**: Watch configured directories for PDF and docx files, extract text, chunk into ~1000 token segments, create captures. Evaluate existing packages/workers/src/ingestion/document.ts for reuse.

**Complexity**: L

**Files to Create/Modify**:
- `packages/workers/src/ingestion/document.ts` — Evaluate and update existing code or rewrite. DocumentIngestionService: scan directories from config, extract text (pdftotext for PDF, pandoc for docx), chunk with overlap (target ~1000 tokens, 100 token overlap), create captures via Core API. Each chunk = one capture with source_metadata.parent_document_id linking chunks. content_hash dedup prevents re-ingesting unchanged files.
- `config/document-sources.yaml` — Update existing config: source directories, file types, brain_view mappings, enabled flag

**Acceptance Criteria**:
- PDF text extracted via pdftotext (poppler-utils in Docker)
- Docx text extracted via pandoc
- Long documents chunked with overlap for embedding coherence
- Chunks linked via parent_document_id in source_metadata
- Re-scan skips unchanged files (content_hash)

**Requirement Refs**: PRD F23 (document ingestion), PRD §9 Phase 4 (chunking deferred decision)

---

### 16.2 URL/Bookmark Capture

**Description**: Capture URLs/bookmarks with metadata extraction. Evaluate existing packages/workers/src/ingestion/bookmark.ts for reuse.

**Complexity**: M

**Files to Create/Modify**:
- `packages/workers/src/ingestion/bookmark.ts` — Evaluate and update existing code. BookmarkService: accept URL → fetch page → extract title + description + main content (readability/cheerio). Create capture with source='bookmark', source_metadata (url, title, domain). Content is extracted readable text (not raw HTML).
- `packages/core-api/src/routes/captures.ts` — Ensure POST /api/v1/captures handles source='bookmark' with URL in source_metadata
- `packages/slack-bot/src/handlers/capture.ts` — Detect URLs in Slack messages → route to bookmark service for enriched capture

**Acceptance Criteria**:
- URL submitted → page fetched, content extracted, capture created
- Title and description extracted from HTML meta tags
- Main content extracted (not boilerplate/nav)
- Slack messages with URLs enriched automatically

**Requirement Refs**: PRD F24 (bookmark capture)

---

### 16.3 Calendar Integration

**Description**: Sync calendar events from iCal feeds. Evaluate existing packages/workers/src/ingestion/calendar.ts for reuse.

**Complexity**: M

**Files to Create/Modify**:
- `packages/workers/src/ingestion/calendar.ts` — Evaluate and update existing code. CalendarSyncService: fetch iCal feeds from config, parse events (ical.js), create captures for upcoming events with relevant context. Schedule: daily sync. Dedup via event UID + start time.
- `config/calendars.yaml` — Update existing config: calendar feeds, sync frequency, brain_view mappings
- `packages/workers/src/skills/scheduler.ts` — Add calendar-sync to daily schedule

**Acceptance Criteria**:
- iCal feeds fetched and parsed
- Calendar events created as captures (source='calendar')
- Dedup prevents duplicate event captures
- Config-driven: calendars enabled/disabled in YAML

**Requirement Refs**: PRD F25 (calendar integration)

---

### 16.4 rclone Document Sync

**Description**: rclone container for syncing documents from cloud drives (OneDrive, Google Drive, iCloud Drive) to local directories for document ingestion.

**Complexity**: S

**Files to Create/Modify**:
- `docker-compose.yml` — Add rclone service (rclone/rclone image, volume mappings, cron-based sync, open-brain network)
- `config/rclone.conf` — rclone remote configuration (template — user configures remotes)
- `scripts/rclone-sync.sh` — Sync script: pull from configured remotes to local document directories

**Acceptance Criteria**:
- rclone syncs files from cloud drives to local directories
- Document ingestion service picks up synced files
- Sync runs on schedule (configurable, default: every 6 hours)

**Requirement Refs**: PRD F23 (document ingestion via rclone)

---

### 16.5 Ingestion Tests + Phase 4 Verification

**Description**: Tests for document ingestion, bookmarks, and calendar. End-to-end verification for Phase 4.

**Complexity**: M

**Files to Create**:
- `packages/workers/src/__tests__/document-ingestion.test.ts` — Update existing tests or rewrite: PDF extraction, docx extraction, chunking with overlap, dedup, parent_document_id linking
- `packages/workers/src/__tests__/bookmark.test.ts` — Update existing tests: URL fetch, content extraction, capture creation
- `packages/workers/src/__tests__/calendar-sync.test.ts` — Update existing tests: iCal parse, event capture, dedup by UID
- `scripts/e2e-full.sh` — Full system E2E verification: all input sources (Slack, voice, MCP, API, bookmark, calendar, document), search, skills, governance, web dashboard

**Acceptance Criteria**:
- All ingestion tests pass
- E2E script verifies complete system
- All 27 features functional (F01-F25, F28, excluding F26/F27)
- Phase 4 test gates satisfied

**Requirement Refs**: PRD Phase 4 test gate, TDD §15.5 (E2E scenarios)

---

<!-- END PHASES -->

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| 9.1 | 9.2 | Docker config and package setup are independent |
| 10.1 | 10.2 | Pushover and email services are independent |
| 10.4 | 10.1, 10.2 | Skill framework and notification services are independent |
| 11.1 | 11.2 | Slack commands and trigger API are independent |
| 12.1 | 12.3 | Resolution service and API endpoints can be built in parallel |
| 13.1 | 13.3 | Session management and bet tracking are independent |
| 14.1 | 14.2, 14.3 | All monitoring skills are independent of each other |
| 15.1 | 15.6 (partial) | Project setup and Docker config are independent |
| 15.2 | 15.3 | Dashboard and search pages are independent |
| 15.4 | 15.5 | Timeline/entity pages and remaining pages are independent |
| 16.1 | 16.2, 16.3 | All ingestion sources are independent |

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| faster-whisper CPU performance | Medium | Medium | Large-v3 on CPU may be slow. int8 quantization helps. Can fallback to medium or small model if too slow. |
| Voice-capture language decision (TS vs Python) | Medium | Low | Start with TypeScript for monorepo consistency. Python fallback if TS port is problematic. |
| Weekly brief quality | Medium | Low | Prompt iteration needed. Start with simple template, refine with real data. |
| Entity resolution false merges | Medium | Medium | 0.8 confidence threshold is conservative. Merge/split commands provide escape hatch. |
| Governance session quality | Medium | Medium | LLM-driven conversation depends on prompt quality. Anti-vagueness gate prevents low-value sessions. |
| Document chunking strategy | Low | Medium | Start with fixed-size overlap. Evaluate semantic splitting if recall is poor for long documents. |
| PWA performance on iPhone Safari | Low | Low | Vite + code splitting should be fast. Test on real device early. |

## Success Metrics

| Metric | Target | Phase | Measurement |
|--------|--------|-------|-------------|
| Voice capture latency | <2 min | 9 | Apple Watch recording to Pushover confirmation |
| Weekly brief generated | 100% on schedule | 10 | skills_log for weekly-brief |
| Trigger notification latency | <30s | 11 | Time from capture to trigger notification |
| Entity auto-creation accuracy | >90% | 12 | Manual review of entity_links |
| Governance session completion | >80% | 13 | Sessions reaching 'completed' status |
| Drift alert relevance | Qualitative | 14 | Self-assessed usefulness |
| Web dashboard load time | <2s | 15 | Time to interactive |
| Document ingestion throughput | >10 docs/hour | 16 | Batch ingestion timing |

## Requirement Traceability

| Requirement | Source | Phase | Work Items |
|-------------|--------|-------|------------|
| faster-whisper | PRD F10, TDD §8.6 | 9 | 9.1 |
| Voice-capture integration | PRD F09, TDD §8.6 | 9 | 9.2-9.5 |
| Pushover notifications | PRD F13, TDD §8.4 | 10 | 10.1, 10.3 |
| Email delivery | PRD F14, TDD §8.5 | 10 | 10.2 |
| Weekly brief skill | PRD F12, TDD §12.4 | 10 | 10.4-10.6 |
| Slack commands | PRD F11, TDD §8.1 | 11 | 11.1 |
| Semantic triggers | PRD F28, TDD §12.2a | 11 | 11.2-11.5 |
| Entity graph | PRD F15, TDD §6.2 | 12 | 12.1-12.5 |
| Governance sessions | PRD F16-F17, TDD §6.2 | 13 | 13.1-13.5 |
| Bet tracking | PRD F18, TDD §4.2 | 13 | 13.3 |
| Drift monitor | PRD F22, TDD §12.4 | 14 | 14.1 |
| Daily connections | PRD F21, TDD §12.4 | 14 | 14.2 |
| Slack voice clips | PRD F20, TDD §8.1 | 14 | 14.4 |
| Web dashboard | PRD F19, TDD §14 | 15 | 15.1-15.6 |
| Document ingestion | PRD F23, TDD §6.2 | 16 | 16.1, 16.4, 16.5 |
| URL/bookmark capture | PRD F24 | 16 | 16.2 |
| Calendar integration | PRD F25 | 16 | 16.3 |

<!-- END TABLES -->

---

*This is Part 2. Part 1: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) — Phases 1-8: Foundation through MCP*

*Source: /create-plan command*
