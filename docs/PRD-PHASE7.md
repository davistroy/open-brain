# Product Requirements Document (PRD)
# Open Brain — Phase 7: Proactive Intelligence & Multi-Model Routing

**Version**: 0.1
**Author**: Troy Davis / Claude
**Date**: 2026-04-11
**Status**: Draft
**Depends On**: PRD.md v0.8 (Phases 1-6)

---

## 1. Executive Summary

Phase 7 transforms Open Brain from a passive knowledge store into an active thinking partner. Two foundational capabilities enable this shift:

1. **Multi-Model Tiered Routing** — a five-tier model hierarchy (local Gemma 4 → DeepSeek → Haiku → Sonnet → Opus) that routes each task to the most cost-effective model capable of handling it, with automatic fallback chains.

2. **Proactive Intelligence** — scheduled and event-driven features that surface insights, detect forgotten commitments, and (eventually) draft responses — without waiting for the user to ask.

These capabilities build on the existing BullMQ pipeline, skill scheduler, entity graph, and notification infrastructure. No architectural rewrites are required.

**Estimated monthly LLM cost after migration**: ~$9 (down from ~$25 with single-model OpenAI routing).

---

## 2. Goals and Non-Goals

### Goals

- Route every LLM task to the cheapest model that produces acceptable quality
- Add automatic fallback so a local model outage degrades gracefully (not fatally)
- Deliver daily proactive summaries of captured knowledge
- Surface unresolved questions and forgotten commitments automatically
- Provide a configurable autonomy level that gates all proactive behaviors
- Lay the groundwork for Slack auto-response (shadow → DM → threaded)
- Expose a dynamic context resource via MCP for session bootstrapping

### Non-Goals

- Multi-user support or authentication (remains single-user)
- Replacing BullMQ with a different job orchestration system
- Building a custom model training or fine-tuning pipeline
- Mobile native apps
- Auto-responding in Slack channels without explicit autonomy escalation

---

## 3. Dependency Graph

```
F36 (Autonomy Levels) ─────────────────────────────────────────┐
F37 (Multi-Model Routing) ──── used by all F38-F46             │
F38 (Daily Sweep) ──── feeds ── F41 (Questions Tracker)        │
F39 (MCP Context Bootstrap)                                    │
F40 (CaptureCard Unification)  ── before F41 UI                │
F41 (Unresolved Questions) ──── needs F38 + F40                │
F42 (Slack Shadow Mode) ──── needs F36 + F37 ──┐               │
F43 (Slack DM Mode) ──── needs F42 validated ──┤               │
F44 (Slack Threaded Replies) ── needs F43 validated            │
F45 (Heartbeat Monitor)                                        │
F46 (Confidence Scoring) ──── needed by F42 ───────────────────┘
```

---

## 4. Feature Specifications

### 4.1 Feature Overview

| ID | Feature | Priority | Phase | Dependencies |
|----|---------|----------|-------|--------------|
| F36 | Configurable autonomy levels | P3 | 7A | None |
| F37 | Multi-model tiered routing | P1 | 7A | None |
| F38 | Daily proactive sweep skill | P1 | 7B | F37 |
| F39 | MCP context bootstrap resource | P2 | 7B | F37 |
| F40 | CaptureCard unification | P5 | 7B | None |
| F41 | Unresolved questions tracker | P4 | 7C | F38, F40 |
| F42 | Slack auto-response: shadow mode | P6 | 7D | F36, F37, F46 |
| F43 | Slack auto-response: DM mode | P7 | 7D | F42 validated |
| F44 | Slack auto-response: threaded replies | P9 | 7E | F43 validated, F46 tuned |
| F45 | Heartbeat integration monitor | P8 | 7C | F37 |
| F46 | Confidence scoring framework | P6 | 7D | F37 |

### 4.2 Detailed Feature Specifications

---

#### F36: Configurable Autonomy Levels

**Description**: A system-wide setting that gates how aggressively Open Brain acts on its own initiative. All proactive features (daily sweep delivery, auto-response, heartbeat alerts) check this setting before taking action. Stored in the existing `app_settings` table.

**Four Levels**:

| Level | Behavior | Use Case |
|-------|----------|----------|
| `observe` | Log findings internally. No notifications, no messages. | Initial deployment, calibration |
| `assist` | Send findings to owner via Pushover/Slack DM. Human relays. | Default operating mode |
| `advise` | Act and report. Post bot-attributed messages in channels. | Trusted, validated features |
| `partner` | Autonomous action within guardrails. Rare permission requests. | Future — requires extensive validation |

**Tech**: New key `autonomy_level` in `app_settings` table (already exists, key-value JSONB store). Add to `VALID_SETTINGS_KEYS` Set in `packages/core-api/src/routes/settings.ts`. Default: `observe`.

**API**:
- `GET /api/v1/settings/autonomy_level` — returns current level
- `PUT /api/v1/settings/autonomy_level` — update (value must be one of the four levels)

**Web UI**: Toggle on Settings page with descriptions of each level. Visual indicator (color-coded badge) on the dashboard header showing current autonomy level.

**Integration Pattern**: All proactive features import a shared `checkAutonomy(requiredLevel)` function that reads the setting and returns boolean. Features specify their minimum required level.

**Acceptance Criteria**:
- Setting persists across container restarts (stored in Postgres)
- Default is `observe` when no setting exists
- Invalid level values rejected with 400
- Dashboard displays current level with clear description
- All proactive features (F38, F42-F44, F45) check autonomy before acting

---

#### F37: Multi-Model Tiered Routing

**Description**: Replace the single-model OpenAI routing with a five-tier hierarchy that routes each task to the most cost-effective model. Each tier specifies a provider, model, configuration, and fallback tier. Tasks are mapped to tiers in `ai-routing.yaml`.

**Model Tiers**:

| Tier | Model | Provider | Cost (input/output per M tokens) | Run Where |
|------|-------|----------|----------------------------------|-----------|
| T0 | Gemma 4 12B (q4_K_M) | Ollama | Free | Local (homeserver) |
| T1 | DeepSeek Chat V3 | DeepSeek API | $0.27 / $1.10 | api.deepseek.com |
| T2 | Claude Haiku 4.5 | Anthropic API | $0.80 / $4.00 | api.anthropic.com |
| T3 | Claude Sonnet 4.6 | Anthropic API | $3.00 / $15.00 | api.anthropic.com |
| T4 | Claude Opus 4.6 | Anthropic API | $15.00 / $75.00 | api.anthropic.com |

**Task-to-Tier Mapping**:

| Task | Tier | Rationale |
|------|------|-----------|
| Intent classification | T0 | Short input, structured output, binary-ish routing |
| Capture type classification | T0 | 8-way classification from short text |
| Brain view classification | T0 | 5-way classification |
| Voice capture classification | T0 | Same pattern as capture type |
| Confidence gating (F46) | T0 | Binary yes/no assessment |
| Entity extraction | T1 | Pattern matching, structured output, moderate reasoning |
| Entity resolution/linking | T1 | Match against known entities, structured |
| Capture enrichment (tags, summary) | T1 | Bounded input, structured output |
| Unresolved question detection | T1 | Cross-reference captures, structured |
| Search synthesis | T2 | Interactive latency needed, good-enough writing |
| Daily sweep summary (F38) | T2 | Review + summarize, bounded scope |
| MCP context bootstrap (F39) | T2 | Generate markdown summary |
| Auto-response drafts (F42-F43) | T2 | Needs good writing but inputs bounded |
| Weekly briefs | T3 | Narrative quality, cross-week pattern detection |
| Daily connections | T3 | Nuanced co-occurrence analysis |
| Drift monitoring | T3 | Subtle pattern detection |
| Governance sessions | T4 | Complex multi-turn reasoning |
| Escalation from lower tiers | T4 | Fallback for quality failures |

**Config Structure** (`config/ai-routing.yaml`):

```yaml
model_tiers:
  t0_local:
    provider: ollama
    model: gemma4:12b-q4_K_M
    base_url: http://ollama:11434/v1
    max_completion_tokens: 256
    timeout_ms: 10000
    fallback: t1_cheap
  t1_cheap:
    provider: deepseek
    model: deepseek-chat
    base_url: https://api.deepseek.com/v1
    max_completion_tokens: 2048
    timeout_ms: 15000
    fallback: t2_fast
  t2_fast:
    provider: anthropic
    model: claude-haiku-4-5-20251001
    max_completion_tokens: 4096
    timeout_ms: 20000
    fallback: t3_quality
  t3_quality:
    provider: anthropic
    model: claude-sonnet-4-6
    max_completion_tokens: 8192
    timeout_ms: 30000
    fallback: t4_max
  t4_max:
    provider: anthropic
    model: claude-opus-4-6
    max_completion_tokens: 16384
    timeout_ms: 60000
    fallback: null

task_routing:
  intent_classification: t0_local
  capture_classification: t0_local
  brain_view_classification: t0_local
  voice_classification: t0_local
  confidence_gating: t0_local
  entity_extraction: t1_cheap
  entity_linking: t1_cheap
  capture_enrichment: t1_cheap
  question_detection: t1_cheap
  search_synthesis: t2_fast
  daily_sweep: t2_fast
  mcp_context: t2_fast
  auto_response_draft: t2_fast
  weekly_brief: t3_quality
  daily_connections: t3_quality
  drift_monitoring: t3_quality
  governance: t4_max

monthly_budget:
  soft_limit_usd: 15
  hard_limit_usd: 30
```

**Implementation — Multi-Provider Client Factory**:

Replace `createLiteLLMClient()` in `@open-brain/shared` with `createModelClient(taskName: string)`:
- Reads `task_routing[taskName]` to resolve tier
- Reads tier config for provider, model, base_url
- Returns appropriate SDK client:
  - Ollama/DeepSeek: OpenAI-compatible client (existing `OpenAI` SDK with custom `baseURL`)
  - Anthropic: `@anthropic-ai/sdk` client (new dependency)
- On failure, automatically retries with `fallback` tier (max 2 fallback hops)
- Logs tier used and fallback events to `ai_audit_log`

**Infrastructure — Ollama Container**:

Add to `docker-compose.yml`:
```yaml
ollama:
  image: ollama/ollama
  container_name: ollama
  volumes:
    - ollama-models:/root/.ollama
  networks:
    - open-brain
  mem_limit: 16g
  restart: unless-stopped
  healthcheck:
    test: ["CMD", "wget", "--spider", "-q", "http://127.0.0.1:11434/api/tags"]
    interval: 30s
    timeout: 10s
    retries: 3
```

Model pull (one-time): `docker exec ollama ollama pull gemma4:12b-q4_K_M`

**Embedding Model**: Remains OpenAI `text-embedding-3-large` with `dimensions: 768`. Embeddings are not tiered — quality matters too much and the cost is low.

**Acceptance Criteria**:
- All existing LLM tasks produce equivalent or better quality output after migration
- Fallback chain activates within 5 seconds of primary tier timeout
- Fallback events logged to `ai_audit_log` with both attempted and actual tier
- Ollama container starts and serves inference within 60 seconds
- Classification tasks (T0) complete in <5 seconds on CPU
- Monthly LLM cost drops below $15 (down from ~$25)
- `ai-routing.yaml` changes take effect on ConfigService reload (no restart)
- Budget circuit breaker updated to use new thresholds

---

#### F38: Daily Proactive Sweep Skill

**Description**: A scheduled skill that runs each evening, reviews the day's captures, and generates a concise summary delivered via Pushover (or higher-touch channels depending on autonomy level). Covers: key decisions made, new entities encountered, unresolved questions, tasks with no follow-up, and patterns against the entity graph.

**Tech**: New skill class in `packages/workers/src/skills/`, new prompt template in `packages/workers/prompts/`, new entry in `config/skills.yaml`.

**Schedule**: Daily at 8:00 PM local time (configurable via `config/notifications.yaml`).

**Config** (`config/notifications.yaml`):
```yaml
daily_sweep:
  enabled: true
  cron: "0 20 * * *"
  brain_views: ["career", "work-internal", "client"]
  lookback_hours: 24
  min_captures_to_run: 1
```

**Prompt Template Inputs**:
- All captures from the last `lookback_hours`
- Entity mentions with first-seen flag
- Open questions (captures of type `question` with no follow-up — feeds F41)
- Active bets and their status

**Output**: Structured markdown with sections: Decisions, New Entities, Open Questions, Silent Topics, Suggested Actions.

**Delivery** (gated by F36 autonomy level):
- `observe`: Log to `skill_outputs` table only
- `assist` or higher: Pushover notification with summary, full output on web dashboard

**Model Tier**: T2 (Haiku) — bounded input, structured summary output.

**Acceptance Criteria**:
- Runs on schedule when at least `min_captures_to_run` captures exist in the window
- Skips gracefully (no error, no notification) when no captures in window
- Output persists in `skill_outputs` table and is viewable on web dashboard
- Pushover notification includes 2-3 sentence highlight (not full output)
- Respects autonomy level — no notification at `observe`
- Completes within 30 seconds

---

#### F39: MCP Context Bootstrap Resource

**Description**: A new MCP resource that returns a dynamically-generated markdown summary of the user's current context: active projects, recent entities, open questions, and focus areas from the last 7 days. Designed for Claude/ChatGPT sessions to read on startup, making every MCP-connected session immediately context-aware.

**Tech**: New MCP resource handler in the existing `/mcp` route in `packages/core-api/src/routes/mcp.ts`.

**MCP Resource**:

| Resource URI | Description |
|-------------|-------------|
| `open-brain://context` | Dynamic context summary (last 7 days) |
| `open-brain://context?days=N` | Context summary with configurable lookback |

**Generated Content Structure**:
```markdown
# Open Brain Context — {date}

## Active Projects
- {project entity name} — last mentioned {date}, {N} captures

## Key Decisions (last 7 days)
- {decision summary} — {date}

## Open Questions
- {question text} — asked {date}, no follow-up yet

## Recent Focus Areas
- {brain_view}: {top entities and topics}

## Recent Captures ({count} total)
- {date}: {type} — {content preview} [entities: ...]
```

**Data Sources**: Queries existing tables — `captures`, `entities`, `entity_links`, `skill_outputs`. No schema changes.

**Model Tier**: T2 (Haiku) for the summary generation. Raw data assembly is SQL-only.

**Acceptance Criteria**:
- Resource accessible via MCP `resources/read` call
- Returns valid markdown with all sections populated
- Completes within 10 seconds
- Handles empty brain gracefully (returns template with "No captures yet" sections)
- Works with Claude Desktop, Claude Code, and any MCP-compatible client
- `days` parameter defaults to 7, capped at 30

---

#### F40: CaptureCard Unification

**Description**: Consolidate the three separate CaptureCard implementations into a single shared component. Currently exists as: shared component (`components/CaptureCard.tsx`), Timeline-local variant, and EntityDetail-local variant. Each has slightly different props and rendering logic.

**Tech**: Refactor in `packages/web/src/`. No new features — extract the superset of props and behaviors into the shared component, then replace local variants with imports.

**Acceptance Criteria**:
- Single CaptureCard component in `packages/web/src/components/CaptureCard.tsx`
- All existing rendering behaviors preserved (Timeline view, EntityDetail view)
- No visual regressions on Timeline, Search, and EntityDetail pages
- Local CaptureCard files deleted
- TypeScript compiles with no new errors

---

#### F41: Unresolved Questions Tracker

**Description**: Captures classified as `question` type that have no follow-up capture referencing the same entities within a configurable window (default 7 days) are flagged as "unresolved." Surfaced in the daily sweep (F38) and in a new dashboard widget.

**Tech**: SQL query against `captures` + `entity_links` with time window. New dashboard widget in `packages/web/`. Feeds into F38's prompt template.

**Detection Query Logic**:
1. Find all captures where `capture_type = 'question'` and `captured_at > now() - interval '7 days'`
2. For each, check if any subsequent capture shares at least one entity link
3. If no shared-entity follow-up exists, flag as unresolved

**API**: `GET /api/v1/captures/unresolved-questions?days=7` — returns list of question captures with no entity-linked follow-up.

**Dashboard Widget**: Card on the dashboard home showing count of unresolved questions with expandable list. Each item links to the capture detail view.

**Model Tier**: None — this is pure SQL, no LLM needed.

**Acceptance Criteria**:
- API endpoint returns accurate unresolved questions
- Questions with follow-up captures (sharing entities) are correctly excluded
- Dashboard widget shows count and expandable list
- Widget handles zero unresolved questions gracefully
- Daily sweep (F38) includes unresolved questions in its output
- `days` parameter configurable, default 7

---

#### F42: Slack Auto-Response — Shadow Mode

**Description**: The Slack bot evaluates every channel message against the intent classifier, looking for questions from other users that Open Brain could answer. When detected, the system runs search + synthesis and logs what it *would have said* — but never posts. The owner reviews shadow logs to calibrate quality and tune confidence thresholds.

**Prerequisites**: F36 (autonomy levels), F37 (multi-model routing), F46 (confidence scoring).

**Tech**: New intent class `auto_respondable_query` in the IntentRouter. New `shadow_responses` table for logging draft responses. Extends existing Slack bot in `packages/slack-bot/`.

**Intent Classification**: Added to the existing intent classifier prompt — a channel message from another user that looks like a question Open Brain could answer (references known entities, asks about decisions, timelines, context). Classified at T0 (local Gemma 4).

**Shadow Response Pipeline**:
1. IntentRouter classifies message as `auto_respondable_query`
2. Run hybrid search against the knowledge base
3. F46 confidence scoring evaluates retrieval quality
4. Generate draft response at T2 (Haiku) with attribution
5. Log everything to `shadow_responses` table: message, draft, search scores, confidence score, entities matched, tier used

**Schema** (`shadow_responses` table):
```sql
CREATE TABLE shadow_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_channel TEXT NOT NULL,
  slack_ts TEXT NOT NULL,
  original_message TEXT NOT NULL,
  draft_response TEXT,
  confidence_score NUMERIC(4,3),
  search_scores JSONB DEFAULT '[]',
  entities_matched JSONB DEFAULT '[]',
  model_tier TEXT,
  would_have_posted BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**Dashboard**: New "Shadow Responses" page showing recent drafts with confidence scores. Owner can review quality and adjust thresholds.

**Autonomy Gate**: Requires `observe` or higher (this feature only logs, never posts).

**Cost Estimate**: ~$2/month for intent classification on channel messages (~200/day at T0). Synthesis only triggers on detected queries (~5-10/day at T2), adding ~$1/month.

**Acceptance Criteria**:
- Intent classifier detects question-like messages from non-bot users
- Draft responses generated with attribution (citing source captures)
- All shadow responses logged with full metadata
- Zero messages posted to any Slack channel
- Dashboard page shows shadow response history with confidence scores
- Shadow mode runs for minimum 2 weeks before F43 is considered

---

#### F43: Slack Auto-Response — DM Mode

**Description**: Same pipeline as shadow mode (F42), but when confidence exceeds threshold, sends the owner a Pushover notification or Slack DM with the draft response. The owner decides whether to copy-paste it into the channel, edit it, or ignore it. Pure human-in-the-loop relay.

**Prerequisites**: F42 running with validated quality (minimum 2 weeks of shadow data).

**Autonomy Gate**: Requires `assist` level.

**Delivery**:
- Pushover notification with: channel name, question text, draft response (truncated), confidence score
- Slack DM to owner with: full draft response, link to original message, one-click "Post" button (Slack interactive message)

**Slack Interactive Message**:
```
📋 Auto-response draft (confidence: 0.87)
Channel: #team-general
Question: "When did we decide on the QSR pricing model?"

Draft: Based on a capture from March 15: you decided on T&M with a $180k cap. Tom agreed.
Sources: capture #abc123 (Mar 15), capture #def456 (Mar 12)

[Post as Reply] [Edit & Post] [Dismiss]
```

**Acceptance Criteria**:
- DM sent only when confidence score exceeds configurable threshold (default 0.75)
- "Post as Reply" creates a threaded reply attributed to the bot
- "Edit & Post" opens a modal for editing before posting
- "Dismiss" logs dismissal (useful for future threshold tuning)
- Respects autonomy level — no DMs at `observe`
- Owner interaction logged to `shadow_responses` (outcome column)

---

#### F44: Slack Auto-Response — Threaded Replies

**Description**: The bot posts threaded replies directly in channels with clear AI attribution, gated behind confidence thresholds and the `advise` autonomy level. Only fires when multiple quality signals align.

**Prerequisites**: F43 running with validated quality, F46 confidence threshold tuned from real data.

**Autonomy Gate**: Requires `advise` level.

**Posting Criteria** (ALL must be true):
- Confidence score exceeds tunable threshold (default 0.85, higher than DM mode)
- At least 2 captures corroborate the answer
- No captures in the result set are older than a configurable staleness window (default 90 days)
- Message is from a non-bot user in a monitored channel

**Response Format**:
```
🧠 Based on captured context:

{synthesis response}

Sources:
• {capture type} from {date} — "{preview}"
• {capture type} from {date} — "{preview}"

_This is an automated response from Open Brain. It may be incomplete or outdated._
```

**Guardrails**:
- Maximum 3 auto-responses per channel per hour (prevent spam)
- Owner can disable per-channel via dashboard setting
- All responses include the disclaimer footer
- Rate limit logged and surfaced in heartbeat (F45) if frequently hit

**Acceptance Criteria**:
- Threaded replies only, never top-level messages
- Clear bot attribution with disclaimer
- All posting criteria enforced (confidence, corroboration, staleness)
- Per-channel rate limiting works
- Owner can disable per channel from dashboard
- Respects autonomy level — no posts below `advise`

---

#### F45: Heartbeat Integration Monitor

**Description**: A lightweight scheduled job that checks application-level health beyond Docker healthchecks. Monitors whether captures are flowing, the pipeline is clearing its queue, and Redis is responsive. Alerts via Pushover only when something looks wrong.

**Tech**: New BullMQ repeatable job in `packages/workers/`. Queries queue depths, latest capture timestamp, Redis ping, Ollama status.

**Schedule**: Every 30 minutes.

**Health Checks**:

| Check | Healthy | Degraded | Unhealthy |
|-------|---------|----------|-----------|
| Latest capture age | < 24h | < 48h | > 48h |
| Pipeline queue depth | < 50 | < 200 | > 200 |
| Failed job count | 0 | < 10 | > 10 |
| Redis ping | < 100ms | < 500ms | > 500ms or timeout |
| Ollama status | Responding | — | Not responding |
| Postgres connections | < 80% max | < 95% max | > 95% max |

**Alert Logic**: Only alert on state transitions (healthy → degraded, degraded → unhealthy). Do not re-alert every 30 minutes for a persistent issue. Alert when an issue resolves (unhealthy → healthy).

**Autonomy Gate**: Requires `assist` or higher for Pushover alerts. At `observe`, logs to heartbeat table only.

**Model Tier**: None — pure infrastructure checks, no LLM needed.

**Acceptance Criteria**:
- Runs every 30 minutes on schedule
- Alerts on state transitions only (no alert fatigue)
- Pushover notification includes which check(s) changed state
- Dashboard shows heartbeat history and current status
- Catches silent failures (worker running but not processing)
- Ollama check handles container not existing (pre-F37 deployment)

---

#### F46: Confidence Scoring Framework

**Description**: A scoring system that evaluates how confidently Open Brain can answer a detected question, based on retrieval quality signals. Used by F42-F44 to gate whether to draft/send/post responses.

**Composite Score** (0.0 to 1.0):

| Signal | Weight | Description |
|--------|--------|-------------|
| Top search score | 0.30 | Highest hybrid search score from retrieved captures |
| Entity match ratio | 0.25 | Fraction of question entities found in retrieved captures |
| Capture recency | 0.20 | Age of most relevant capture (newer = higher) |
| Corroboration count | 0.15 | Number of captures supporting the answer (2+ = full score) |
| Source diversity | 0.10 | Multiple sources (slack + voice + email) = higher confidence |

**Formula**: `confidence = Σ(signal_value × weight)` where each signal_value is normalized to [0, 1].

**Thresholds** (configurable in `app_settings`):
- Shadow mode (F42): log all, no threshold
- DM mode (F43): confidence ≥ 0.75
- Threaded replies (F44): confidence ≥ 0.85

**Implementation**: Standalone function in `packages/shared/src/lib/confidence.ts`. Takes search results + question entities as input, returns composite score + per-signal breakdown.

**Acceptance Criteria**:
- Score always in [0.0, 1.0] range
- Per-signal breakdown available for debugging/dashboard display
- Thresholds configurable via `app_settings` without restart
- Score logged with every shadow response (F42)
- Unit tests cover edge cases: no results (score 0), perfect match (score ~1.0), stale captures (low recency signal)

---

## 5. User Journeys

### Journey 9: Daily Proactive Sweep

**Trigger**: 8:00 PM daily, automated

1. Workers container triggers `daily_sweep` skill
2. Queries all captures from the last 24 hours
3. Cross-references against entity graph for new entities and unresolved questions
4. Feeds to Haiku (T2) with sweep prompt template
5. Generates structured summary: decisions, new entities, open questions, silent topics
6. At `assist` autonomy: Pushover notification with 2-sentence highlight
7. Full output persisted to `skill_outputs` table, viewable on dashboard

**Total latency**: <30 seconds. **Cost**: ~$0.01 per run.

### Journey 10: MCP Context-Aware Session

**Trigger**: User opens Claude Code or ChatGPT with MCP connected

1. AI tool reads `open-brain://context` MCP resource
2. Core API assembles context: recent entities, active projects, open questions, focus areas
3. Haiku (T2) generates concise markdown summary
4. AI tool receives context and incorporates it — "I see you've been focused on QSR pricing this week, with an open question about the rollout timeline..."
5. User's session is immediately context-aware without manual briefing

### Journey 11: Slack Auto-Response (Full Progression)

**Phase A — Shadow** (`observe` autonomy):
1. Colleague asks in #team-general: "When did we decide on the QSR pricing model?"
2. Intent classifier (T0 local) detects `auto_respondable_query`
3. Hybrid search finds 3 relevant captures, confidence score: 0.87
4. Haiku (T2) drafts response with attribution
5. Draft logged to `shadow_responses` — never posted
6. Owner reviews on dashboard, sees draft quality is good

**Phase B — DM** (`assist` autonomy):
7. Same question comes in. Confidence: 0.87 (above 0.75 threshold)
8. Owner receives Slack DM: draft response + "Post as Reply" button
9. Owner clicks "Post as Reply" → bot posts threaded reply in #team-general

**Phase C — Threaded** (`advise` autonomy):
10. Same question. Confidence: 0.91 (above 0.85), 3 corroborating captures, newest is 5 days old
11. Bot posts threaded reply directly: synthesis + source citations + disclaimer
12. Owner sees notification of auto-posted response

---

## 6. Implementation Phases

### Phase 7A: Foundation (F36 + F37)

**Scope**: Autonomy levels + multi-model routing. These are prerequisites for everything else.

**Work Items**:
- 7A.1: Add `autonomy_level` to `app_settings`, API endpoints, dashboard toggle
- 7A.2: Add `@anthropic-ai/sdk` dependency to `@open-brain/shared`
- 7A.3: Implement `createModelClient(taskName)` multi-provider client factory
- 7A.4: Expand `ai-routing.yaml` with tier definitions and task routing
- 7A.5: Add Ollama container to `docker-compose.yml`, pull Gemma 4 model
- 7A.6: Migrate classification tasks (intent, capture type, brain view) to T0
- 7A.7: Migrate entity extraction/linking to T1 (DeepSeek)
- 7A.8: Migrate synthesis/skills to T2-T4 (Claude), validate quality
- 7A.9: Update budget circuit breaker for new thresholds
- 7A.10: Unit tests for client factory, fallback chain, autonomy checks

**Test Gate**: All existing 1,412 unit tests pass. Classification quality equivalent. Fallback chain tested with Ollama stopped.

### Phase 7B: Core Proactive Features (F38 + F39 + F40)

**Scope**: Daily sweep, MCP context bootstrap, CaptureCard unification.

**Work Items**:
- 7B.1: Implement daily sweep skill class + prompt template
- 7B.2: Add sweep schedule to `config/notifications.yaml`
- 7B.3: Implement MCP `open-brain://context` resource handler
- 7B.4: Unify CaptureCard components (refactor, delete local variants)
- 7B.5: Dashboard: daily sweep output viewer
- 7B.6: Unit tests for sweep skill, MCP resource, CaptureCard

**Test Gate**: Daily sweep generates coherent output. MCP resource works with Claude Desktop. No visual regressions on web dashboard.

### Phase 7C: Intelligence Features (F41 + F45)

**Scope**: Unresolved questions tracker + heartbeat monitor.

**Work Items**:
- 7C.1: Implement unresolved questions API endpoint
- 7C.2: Integrate unresolved questions into daily sweep prompt
- 7C.3: Dashboard widget for unresolved questions
- 7C.4: Implement heartbeat monitor job
- 7C.5: Heartbeat state tracking + transition-based alerting
- 7C.6: Dashboard heartbeat status display

**Test Gate**: Unresolved questions correctly identified. Heartbeat detects simulated failures. Alert transitions work (no spam).

### Phase 7D: Slack Auto-Response Foundation (F42 + F43 + F46)

**Scope**: Confidence scoring, shadow mode, DM mode.

**Work Items**:
- 7D.1: Implement confidence scoring framework
- 7D.2: Add `auto_respondable_query` intent class
- 7D.3: Create `shadow_responses` table (migration)
- 7D.4: Implement shadow response pipeline
- 7D.5: Dashboard: shadow responses viewer
- 7D.6: Implement DM mode with Slack interactive messages
- 7D.7: Unit tests for confidence scoring, shadow pipeline

**Test Gate**: Shadow mode logs accurate drafts. Confidence scores correlate with response quality (validated by owner review). DM mode delivers drafts reliably.

**Validation Period**: Minimum 2 weeks of shadow mode data before enabling DM mode. Minimum 2 weeks of DM mode before considering Phase 7E.

### Phase 7E: Slack Auto-Response Graduation (F44)

**Scope**: Threaded replies with full guardrails.

**Work Items**:
- 7E.1: Implement threaded reply posting with attribution format
- 7E.2: Per-channel rate limiting and disable controls
- 7E.3: Dashboard: per-channel auto-response settings
- 7E.4: Integration tests for posting criteria enforcement

**Test Gate**: Threaded replies meet all posting criteria. Rate limiting works. Owner can disable per channel.

---

## 7. Cost Analysis

### Current State (Single Model — OpenAI gpt-5.4)

| Task Category | Monthly Volume | Monthly Cost |
|---------------|---------------|-------------|
| Classification (~1000 tasks) | ~1000 | ~$3 |
| Entity extraction (~500 tasks) | ~500 | ~$5 |
| Search synthesis (~300 queries) | ~300 | ~$8 |
| Skills (briefs, connections, drift) | ~30 | ~$6 |
| Governance sessions | ~5 | ~$3 |
| **Total** | | **~$25/month** |

### Projected State (Multi-Tier Routing)

| Task Category | Tier | Monthly Cost |
|---------------|------|-------------|
| Classification | T0 (local) | $0 |
| Entity extraction | T1 (DeepSeek) | ~$0.30 |
| Search synthesis | T2 (Haiku) | ~$2 |
| Skills | T3 (Sonnet) | ~$3 |
| Governance | T4 (Opus) | ~$4 |
| New: daily sweep (30/mo) | T2 (Haiku) | ~$0.30 |
| New: shadow mode (~150 drafts/mo) | T2 (Haiku) | ~$0.50 |
| New: MCP context (~60/mo) | T2 (Haiku) | ~$0.20 |
| **Total** | | **~$10/month** |

**Net savings**: ~$15/month (60% reduction) while adding three new features.

**Budget thresholds (updated)**: Soft limit $15, hard limit $30.

---

## 8. Key Decisions

| ID | Decision | Rationale | Alternatives Considered |
|----|----------|-----------|------------------------|
| D19 | Five-tier model hierarchy over single provider | Cost optimization + quality matching. Classification doesn't need Opus. | Two-tier (local + cloud), three-tier (no DeepSeek), single provider (Anthropic only) |
| D20 | Ollama for local inference (not vLLM) | Simpler setup, good CPU support, one-command model pull. No GPU on homeserver. | vLLM (better throughput but needs GPU), llama.cpp (lower-level) |
| D21 | Anthropic API over OpenAI for cloud tiers | User preference for Claude. Comparable pricing. Better reasoning at Opus tier. | Keep OpenAI (existing integration), mixed (OpenAI for some tiers) |
| D22 | Fallback chain over hard failure | Graceful degradation. Local model down shouldn't block pipeline. | Hard fail + alert (simpler but fragile), parallel dispatch (wasteful) |
| D23 | Shadow → DM → threaded progression | Risk management. Each phase validates the next. No shortcutting to public responses. | Direct to threaded (risky), DM only forever (limited value) |
| D24 | Confidence scoring as separate framework | Reusable across auto-response, MCP, and future features. Not embedded in Slack bot. | Inline in Slack bot (simpler but not reusable), LLM self-assessment (unreliable) |
| D25 | Autonomy levels over per-feature toggles | Single knob is easier to reason about and adjust. Features map to levels, not individual switches. | Per-feature on/off (granular but complex), time-based (auto-escalate) |
| D26 | Keep OpenAI for embeddings | text-embedding-3-large with MRL at 768d is high quality and cheap. Not worth tiering. | Local embeddings (FastEmbed — saves money but quality drop), Anthropic (no embedding model) |

---

## 9. Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Gemma 4 classification quality insufficient | Tasks misrouted, captures misclassified | Medium | Fallback chain to T1. Validate against 100 labeled examples before cutover. |
| DeepSeek API reliability | Entity extraction stalls | Low | Fallback to T2 (Haiku). DeepSeek has >99.5% uptime historically. |
| Ollama container OOM on 128GB system | Container crashes, classification fails | Low | 16GB mem_limit. Gemma 4 12B q4 uses ~10GB. Monitor via F45 heartbeat. |
| Auto-response posts incorrect information | Reputational risk in team channels | Medium | Three-phase progression (shadow → DM → threaded). Confidence threshold. Disclaimer. Per-channel disable. |
| Alert fatigue from heartbeat | Owner ignores real alerts | Medium | State-transition alerting only. No re-alerting for persistent issues. |
| Budget overrun from new features | Exceeds $30 hard limit | Low | Circuit breaker already exists. Updated thresholds. Daily sweep + shadow mode add ~$1/month. |

---

## 10. Open Questions

| # | Question | Impact | Status |
|---|----------|--------|--------|
| Q1 | Should the confidence scoring weights be tunable from the dashboard? | Nice-to-have. Could defer to settings YAML. | Open |
| Q2 | Should auto-response shadow mode monitor DMs or only channels? | Privacy implications for DMs. Channels only is safer. | Leaning channels-only |
| Q3 | Should MCP context resource be cached or generated fresh each time? | Performance vs. freshness. 5-minute cache is reasonable. | Open |
| Q4 | What Gemma 4 quantization gives best quality/speed on i7-9700 CPU? | q4_K_M is the assumed default. May need benchmarking. | Needs benchmarking |
| Q5 | Should the fallback chain log a warning or silently escalate? | Operator visibility vs. noise. | Leaning: log + aggregate in heartbeat |

---

## 11. Change Log

| Date | Version | Changes |
|------|---------|---------|
| 2026-04-11 | 0.1 | Initial draft. Features F36-F46. Multi-model routing, proactive intelligence, Slack auto-response track. |
