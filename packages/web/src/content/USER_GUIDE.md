# Open Brain — Detailed User Guide

Complete reference for every feature of your personal AI knowledge infrastructure. This guide assumes a fully deployed and running system.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Access Points](#2-access-points)
3. [Web Dashboard](#3-web-dashboard)
4. [Slack Bot](#4-slack-bot)
5. [Voice Capture (iPhone & Apple Watch)](#5-voice-capture-iphone--apple-watch)
6. [MCP (AI Assistant Integration)](#6-mcp-ai-assistant-integration)
7. [Captures](#7-captures)
8. [Search & Discovery](#8-search--discovery)
9. [Entities](#9-entities)
10. [Weekly Briefs](#10-weekly-briefs)
11. [Governance Sessions](#11-governance-sessions)
12. [Bets & Predictions](#12-bets--predictions)
13. [Intelligence (Connections & Drift)](#13-intelligence-connections--drift)
14. [Semantic Triggers](#14-semantic-triggers)
15. [Document Ingestion](#15-document-ingestion)
16. [Settings & Administration](#16-settings--administration)
17. [API Reference](#17-api-reference)
18. [Troubleshooting](#18-troubleshooting)

---

## 1. System Overview

Open Brain is a self-hosted personal AI knowledge system. It ingests your thoughts from multiple sources — voice memos, Slack messages, typed notes, documents — and processes them through an AI pipeline that transcribes, classifies, extracts entities, embeds for semantic search, and surfaces insights.

### Core Concepts

**Captures** — Every piece of information you put into the system is a "capture." Each capture has:
- **Content**: The text (or transcribed audio)
- **Capture type**: One of 8 types (decision, idea, observation, task, win, blocker, question, reflection)
- **Brain view**: One of 5 categories (career, personal, technical, work-internal, client)
- **Source**: Where it came from (voice, slack, api, mcp, document)
- **Tags & topics**: Auto-extracted keywords
- **Entities**: People, organizations, projects, and concepts mentioned

**Pipeline** — Every capture goes through a 6-stage async processing pipeline:
1. **Classify** — AI determines capture type and brain view
2. **Embed** — Creates a 768-dimensional vector for semantic search
3. **Extract** — Pulls out entities, topics, tags, and metadata
4. **Link Entities** — Connects extracted entities to known records (deduplication, alias matching)
5. **Check Triggers** — Evaluates semantic triggers and fires notifications
6. **Notify** — Sends Pushover push notification with capture summary

Pipeline processing typically completes in 30–90 seconds. Failed stages retry up to 5 times with patient backoff (30s, 2m, 10m, 30m, 2h). A daily sweep at 3 AM retries any remaining failures.

**Brain Views** — Five categories for organizing captures:

| View | Color | Purpose |
|------|-------|---------|
| `career` | Blue | Professional development, career strategy |
| `personal` | Green | Personal life, hobbies, health |
| `technical` | Purple | Technical learning, architecture, tools |
| `work-internal` | Orange | Internal work items, operations |
| `client` | Red | Client-facing work, deliverables |

**Capture Types** — Eight types, auto-classified from content:

| Type | When to Use |
|------|-------------|
| `decision` | A choice you made or need to make |
| `idea` | Something to explore or consider |
| `observation` | A fact, insight, or thing you noticed |
| `task` | Something to do |
| `win` | An accomplishment or positive outcome |
| `blocker` | Something preventing progress |
| `question` | Something you need to answer |
| `reflection` | Thinking about how things are going |

---

## 2. Access Points

### Web Dashboard
- **URL**: `https://brain.troy-davis.com`
- **Access**: Direct via Cloudflare Tunnel (no VPN needed)
- **Best for**: Browsing, searching, detailed exploration, administration

### Slack Bot
- **Access**: Any Slack channel where the bot is installed
- **Connection**: Socket Mode (always on, no webhooks)
- **Best for**: Quick captures during work, searching on the go, commands

### Voice Capture
- **URL**: `http://<tailscale-ip>:3001/api/capture`
- **Access**: Requires Tailscale VPN connection from iPhone
- **Best for**: Hands-free capture while walking, driving, or thinking out loud

### MCP (AI Assistant)
- **URL**: Via LiteLLM at `https://llm.troy-davis.com/mcp`
- **Auth**: Bearer token in Authorization header
- **Best for**: Letting Claude or other AI assistants query and capture to your brain

### REST API
- **URL**: `https://brain.troy-davis.com/api/v1/`
- **Best for**: Automation, custom integrations, scripts

---

## 3. Web Dashboard

The web dashboard is a single-page React application with 9 main pages accessible from the sidebar (desktop) or bottom navigation (mobile).

### Dashboard (`/dashboard`)

Your home screen. Shows:

- **Quick Capture** — Text input at the top. Type a thought and press Enter to capture it immediately (auto-classified as observation, personal view).
- **Stats Cards** — Four cards showing:
  - Total capture count with pipeline completion rate
  - Pipeline health (healthy/degraded/critical) with pending/processing/failed counts
  - Captures by type (bar chart)
  - Captures by brain view (bar chart)
- **Recent Captures** — Last 10 captures with expand/collapse detail. Click "View all" to go to Timeline.

### Search (`/search`)

Full-powered semantic + full-text hybrid search.

- **Search input** — Type naturally (e.g., "what decisions about pricing"). Results appear in real time with a 400ms debounce.
- **Filters panel** (collapsible) — Filter by:
  - Brain view
  - Capture type
  - Source
  - Start date / end date
  - Hybrid search toggle (combined FTS + vector vs. vector-only)
- **Results** — Each result shows:
  - Similarity score (percentage)
  - Capture type and brain view badges
  - Content preview
  - Timestamp
- **Detail panel** — Click any result to open a side panel (desktop) or full-screen overlay (mobile) showing:
  - Full content
  - All metadata (tags, topics, entities)
  - Pipeline history (every stage with status, duration, errors)
  - Capture ID
- **Load more** — Click to fetch additional results (20 at a time)

### Timeline (`/timeline`)

Chronological view of all captures with infinite scroll.

- **Filters** — Capture type, brain view, date range
- **View chips** — 5 colored buttons to quickly filter by brain view
- **Timeline layout** — Captures grouped by date with sticky headers. Each shows:
  - Time of day
  - Brain view, capture type, and source badges
  - Content preview (3 lines)
  - Entity mentions (clickable)
  - Tags (up to 6)
- **Infinite scroll** — Loads 25 at a time as you scroll down

### Entities (`/entities`)

Browse extracted entities with relationship tracking.

- **Search** — Filter entities by name or alias
- **Type filter** — person, org, concept, decision, project
- **Sort** — "Most mentioned" or "Recent"
- **Type chips** — Quick toggle filters
- **Entity cards** — Show name, type badge, alias count, mention count, last seen date
- **Click** any entity to see its detail page

### Entity Detail (`/entities/:id`)

Deep dive into a single entity.

- **Metadata** — Name, type, aliases, mention count, first/last seen dates
- **Actions**:
  - **Merge** — Combine two entities (when you find duplicates). Enter target entity ID.
  - **Split alias** — Break an alias into its own separate entity.
- **Related entities** — Top 20 entities that co-occur in the same captures (co-occurrence graph)
- **Linked captures** — All captures mentioning this entity

### Briefs (`/briefs`)

Weekly AI-synthesized summaries.

- **Header** — Next scheduled run date, refresh button, "Run Now" button
- **Skill status** — Cron schedule, last run time/status, next run
- **Brief history** — Expandable cards for each past brief showing:
  - **Collapsed**: Run date, status badge, duration, headline preview
  - **Expanded**: Full brief with wins, blockers, risks, open loops, next week focus, avoided decisions, drift alerts, connections, model/token info

### Board (`/board`)

Governance sessions and bet tracking on a single page.

**Governance section:**
- **Start buttons** — "Start Quick Check" or "Start Quarterly Review"
- **Active session** — Chat-style interface:
  - Progress bar (turns completed / max)
  - Topics covered and remaining
  - Message bubbles with board role badges (Strategist, Operator, Contrarian, Coach, Analyst)
  - Text input + Send button
  - End session button

**Bets section:**
- **Filter** — Toggle "all" vs. "open" bets
- **Add bet form** — Statement, confidence slider (0–1), optional due date
- **Bet cards** — Statement, status badge, due date (with overdue warning), tags, resolution buttons (won/lost/cancel)

### Intelligence (`/intelligence`)

Daily AI-generated insights.

- **Connections card** — Cross-domain pattern analysis:
  - Summary text
  - Connection items with theme, confidence level, insight, domains involved
  - "Run" button to trigger manually
- **Drift monitor card** — Silent commitment detection:
  - Overall health badge (healthy/minor/significant/critical)
  - Drift items with severity, days silent, reason, suggested action
  - "Run" button to trigger manually

### Voice (`/voice`)

Upload audio files for transcription and capture.

- **Drop zone** — Drag and drop or click to select an audio file
- **Supported formats** — `.m4a`, `.wav`, `.mp3`, `.aac`, `.ogg`, `.webm`
- **Brain view selector** — Choose which view to route the capture to
- **Upload button** — Sends file for transcription
- **Result display** — Shows transcript, detected capture type, brain view, duration, language

### Settings (`/settings`)

System administration.

- **System health** — Service status (Postgres, Redis, LiteLLM) with latency, uptime, version
- **Queue health** — BullMQ queue stats (waiting, active, failed per queue)
- **Skills** — List of all scheduled skills with run history and "Run now" buttons
- **Semantic triggers** — Add, list, and delete triggers (see [Semantic Triggers](#14-semantic-triggers))
- **Danger zone** — "Wipe All Data" with confirmation modal requiring you to type `WIPE ALL DATA`

---

## 4. Slack Bot

The Slack bot is always connected via Socket Mode. No webhooks or signing secrets needed.

### Message Routing

The bot uses a 4-step intent classification strategy on every message:

1. **Prefix detection** (instant):
   - `?` → Search query
   - `!` → Command
   - `@Open Brain` → Search query
2. **Pattern matching** (heuristic):
   - Question words (what, who, when, where, why, how, etc.)
   - Sentences ending with `?`
   - Phrases like "tell me", "show me", "find", "search"
3. **LLM classification** (if still ambiguous, 5-second timeout)
4. **Default** → Capture as observation

### Capturing via Slack

**Text captures** — Any plain message without a `?` or `!` prefix is captured:
```
Had a breakthrough on the caching layer — switched to LRU with TTL and latency dropped 40%
```
Bot replies in thread:
```
✅ Captured as win in technical (ID: abc12345...)
```

**Audio captures** — Send an audio file in Slack. The bot downloads it, sends it to the voice-capture service for transcription, and creates a capture:
```
🎤 Voice captured as decision (87% confidence)
[transcription preview...]
```

**Deduplication** — If you send the same content twice, the bot detects the duplicate and won't re-capture.

### Searching via Slack

Prefix with `?`:
```
? what decisions have I made about the QSR timeline
```

Results appear in a thread with rank, capture type, match score, date, and content preview:
```
🔍 Results for "QSR timeline decisions" (7 total)

1. [decision] Mar 10 — 94% match
> Decided to compress the QSR delivery timeline by 2 weeks...
Topics: QSR, timeline, delivery
```

**Thread interactions:**
- Reply `more` or `next` → Next page of results
- Reply with a number (e.g., `3`) → Full details of that result
- Reply with new text → New search in the same thread
- Thread context expires after **1 hour** of inactivity

**Synthesis** — For queries that match synthesis patterns (e.g., `? synthesize my thoughts on product direction`), the bot generates an LLM-powered synthesis instead of listing individual results.

### Commands Reference

All commands use `!` prefix. All responses are in threads.

#### Captures & Stats

| Command | Description | Example |
|---------|-------------|---------|
| `!stats` | Total captures, breakdown by type/source/view, pipeline health | `!stats` |
| `!recent [N]` | Last N captures (default 5, max 20) | `!recent 10` |
| `!retry <id>` | Retry a failed pipeline stage | `!retry abc12345` |

#### Weekly Briefs

| Command | Description | Example |
|---------|-------------|---------|
| `!brief` | Generate a weekly brief now | `!brief` |
| `!brief last` | Show the most recent brief | `!brief last` |

#### Entities

| Command | Description | Example |
|---------|-------------|---------|
| `!entities` | List all entities with mention counts | `!entities` |
| `!entity <name>` | Detail for a specific entity + linked captures | `!entity Alice Smith` |
| `!entity merge <n1> <n2>` | Merge entity n1 into n2 | `!entity merge "Tom S." "Tom Smith"` |
| `!entity split <name> <alias>` | Split an alias into a new entity | `!entity split "Alice Smith" Alice` |

#### Semantic Triggers

| Command | Description | Example |
|---------|-------------|---------|
| `!trigger add "<query>"` | Create a new semantic trigger | `!trigger add "client risk mentions"` |
| `!trigger list` | List all active triggers | `!trigger list` |
| `!trigger delete <name>` | Deactivate a trigger | `!trigger delete "client risk mentions"` |
| `!trigger test "<query>"` | Test what captures would match | `!trigger test "client risk"` |

#### Intelligence

| Command | Description | Example |
|---------|-------------|---------|
| `!connections [days]` | Cross-domain connection analysis (default 7 days, max 90) | `!connections 14` |
| `!drift` | Drift analysis — silent bets, declining topics | `!drift` |

Both run asynchronously; results arrive via Pushover notification.

#### Governance Sessions

| Command | Description | Example |
|---------|-------------|---------|
| `!board quick` | Start a quick board check session | `!board quick` |
| `!board quarterly` | Start a quarterly review session | `!board quarterly` |
| `!board status` | List active and paused sessions | `!board status` |
| `!board resume <id>` | Resume a paused session | `!board resume abc12345` |

**In-thread session commands** (reply in the governance thread):
| Command | Description |
|---------|-------------|
| `!board pause` | Pause session (can resume within 30 days) |
| `!board done` / `!board complete` | End session and generate summary |
| `!board abandon` | Abandon session (no summary) |
| *(any text)* | Your response to the board's question |

#### Bets

| Command | Description | Example |
|---------|-------------|---------|
| `!bet list [status]` | List bets (filter: pending/correct/incorrect/ambiguous) | `!bet list pending` |
| `!bet add <conf> <statement>` | Create a bet (confidence 0.0–1.0) | `!bet add 0.8 "Deal closes by Q2"` |
| `!bet expiring [N]` | Bets due in next N days (default 7) | `!bet expiring 14` |
| `!bet resolve <id> <outcome> [evidence]` | Resolve bet | `!bet resolve abc123 correct "Confirmed"` |

#### Pipeline

| Command | Description |
|---------|-------------|
| `!pipeline status` | BullMQ queue health (waiting, active, failed per queue) |

#### Help

| Command | Description |
|---------|-------------|
| `!help` | Show all available commands |

### @Mention Behavior

Mentioning `@Open Brain` always routes to the **search/query** handler — not capture. This means:
- `@Open Brain what's my QSR strategy?` → Search query
- `@Open Brain !stats` → Command (mention stripped, `!` prefix detected)
- `@Open Brain This is a note` → Treated as a query (not captured)

To **capture** information, send a plain message without `@` mention.

---

## 5. Voice Capture (iPhone & Apple Watch)

Voice capture uses an iOS Shortcut to record audio and POST it to the voice-capture service over your Tailscale network.

### Prerequisites

- **Tailscale** installed and connected on your iPhone
- **Tailscale** running on your homeserver
- Know your homeserver's Tailscale IP (run `tailscale ip` on the server)

### Setting Up the iPhone Shortcut

1. Open **Shortcuts** app → tap **+**
2. **Action 1: Record Audio**
   - Audio Recording: Until Stopped (or set a max, e.g., 5 minutes)
3. **Action 2: Get Contents of URL**
   - URL: `http://<tailscale-ip>:3001/api/capture`
   - Method: `POST`
   - Request Body: `Form`
   - Add field → Type: `File` → Key: `audio` → Value: Recorded Audio
4. **Action 3 (optional): Get Dictionary Value**
   - Key: `message`
   - Dictionary: Contents of URL
5. **Action 4 (optional): Show Notification**
   - Title: `Brain Capture`
   - Body: Dictionary Value

### Targeting a Brain View

Append `?brain_view=` to the URL:
```
http://<tailscale-ip>:3001/api/capture?brain_view=work-internal
```
Valid values: `career`, `personal`, `technical`, `work-internal`, `client`

If omitted, defaults to `personal`.

### Apple Watch Setup

1. Open Shortcuts on Watch (or enable via Watch app on iPhone)
2. Find your shortcut → enable **Show on Apple Watch**
3. Add the **Shortcuts** complication to a watch face
4. Tap the complication → Watch mic opens → tap Done when finished

The Watch records `.m4a` audio, transfers to iPhone, and the Shortcut sends it to Open Brain. iPhone must be reachable via Tailscale at upload time.

### What Happens After Upload

1. **Transcription** — faster-whisper transcribes your audio (5–30s typically)
2. **Classification** — LLM classifies capture type and extracts topics
3. **Ingestion** — Transcript sent to core API, enters the async pipeline
4. **Notification** — Pushover push notification with capture type, topics, and entity mentions

### Supported Audio Formats

`.m4a` (iPhone/Watch default), `.wav`, `.mp3`, `.ogg`

---

## 6. MCP (AI Assistant Integration)

Open Brain exposes a Model Context Protocol (MCP) endpoint that lets AI assistants (like Claude) interact with your brain.

### Connection

- **Transport**: Streamable HTTP
- **Endpoint**: Via LiteLLM at `https://llm.troy-davis.com/mcp`
- **Auth**: `Authorization: Bearer <MCP_BEARER_TOKEN>`

### Available Tools

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `search_brain` | Semantic + FTS hybrid search | `query` (required), `limit`, `threshold`, `brain_view`, `days` |
| `list_captures` | Browse captures with filters | `limit`, `offset`, `brain_view`, `capture_type`, `source`, `date_from`, `date_to` |
| `brain_stats` | Statistics on captured knowledge | *(none required)* |
| `capture_thought` | Create a new capture | `content` (required), `capture_type`, `brain_view`, `tags` |
| `get_entity` | Look up a specific entity | `name` or `id` |
| `list_entities` | Browse entities | `type_filter`, `sort_by`, `limit`, `offset` |
| `get_weekly_brief` | Retrieve a weekly brief | `weeks_ago` (default 0) |

### Example Usage

Ask Claude: *"What have I been thinking about regarding the QSR client this week?"* — Claude calls `search_brain` with your query and returns relevant captures.

---

## 7. Captures

### Creating Captures

| Method | How |
|--------|-----|
| Web dashboard | Quick capture box on Dashboard |
| Slack | Plain message in any channel with the bot |
| Voice | iPhone/Watch shortcut |
| MCP | `capture_thought` tool |
| API | `POST /api/v1/captures` |
| Documents | `POST /api/v1/documents` |

### Capture Fields

| Field | Description |
|-------|-------------|
| `id` | UUID, auto-generated |
| `content` | The text content (1–50,000 characters) |
| `capture_type` | Auto-classified: decision, idea, observation, task, win, blocker, question, reflection |
| `brain_view` | Auto-classified: career, personal, technical, work-internal, client |
| `source` | Where it came from: voice, slack, api, mcp, document |
| `tags` | Auto-extracted keywords and topics |
| `metadata` | Source-specific data (device, duration, filename, etc.) |
| `pipeline_status` | pending → processing → complete (or partial/failed) |
| `created_at` | Timestamp |

### Pipeline Stages

Every capture is processed asynchronously through 6 stages:

| Stage | What It Does | Timeout |
|-------|-------------|---------|
| Classify | AI determines capture type and brain view | 30s |
| Embed | Creates 768-dim vector embedding for semantic search | 60s |
| Extract | Extracts entities, topics, tags from content | 30s |
| Link Entities | Matches entities to existing records, creates new ones | 30s |
| Check Triggers | Evaluates semantic trigger queries against the capture | 15s |
| Notify | Sends Pushover notification with summary | 15s |

**Retry policy**: 5 attempts with backoff at 30s, 2m, 10m, 30m, 2h. Daily sweep at 3 AM retries remaining failures.

### Updating Captures

Via API: `PATCH /api/v1/captures/:id` — You can update tags, brain_view, and metadata after creation.

### Retrying Failed Captures

- **Web**: Settings → check pipeline health for failed jobs
- **Slack**: `!retry <capture-id>`
- **API**: `POST /api/v1/captures/:id/retry`

---

## 8. Search & Discovery

### Search Modes

| Mode | How It Works | When to Use |
|------|-------------|-------------|
| **Hybrid** (default) | Combines full-text search (FTS) + vector similarity using Reciprocal Rank Fusion | General queries |
| **Vector** | Embedding similarity only | Conceptual/semantic queries |
| **FTS** | Full-text search only | Exact phrase matching |

### Temporal Decay

Search results are weighted by recency using ACT-R cognitive model scoring. Recent captures score higher. The `temporal_weight` parameter controls how much recency matters (0.0 = no decay, 1.0 = strong recency bias). Default is 0.1.

### Search via Web

1. Go to **Search** → type your query
2. Results appear in real time (400ms debounce)
3. Open the filters panel to narrow by view, type, source, or date range
4. Click any result to see full details in the side panel

### Search via Slack

```
? what decisions about hiring have I made this quarter
```

Thread interactions:
- `more` / `next` → Next page
- Number (e.g., `3`) → Full details of result #3
- New text → New search
- Thread expires after 1 hour

### Search via API

**Quick search (GET)**:
```
GET /api/v1/search?q=hiring+decisions&limit=10&brain_view=career
```

**Full search (POST)**:
```json
POST /api/v1/search
{
  "query": "hiring decisions",
  "limit": 10,
  "brain_views": ["career", "work-internal"],
  "start_date": "2026-01-01",
  "temporal_weight": 0.3,
  "search_mode": "hybrid"
}
```

### Synthesis

For deeper analysis, use the synthesis endpoint:
```json
POST /api/v1/synthesize
{
  "query": "What is my overall product strategy?",
  "limit": 20
}
```
This retrieves the top matching captures and generates an LLM-powered synthesis grounded in your actual captures.

Via Slack: `? synthesize my thoughts on product direction`

---

## 9. Entities

Open Brain automatically extracts and tracks five types of entities:

| Type | Examples | Color |
|------|----------|-------|
| `person` | Alice Smith, Bob | Sky blue |
| `org` | NovaBurger, Acme Corp | Amber |
| `concept` | caching, pricing strategy | Violet |
| `decision` | switch to LRU cache | Rose |
| `project` | QSR dashboard, Open Brain | Emerald |

### Browsing Entities

**Web** (`/entities`):
- Search by name or alias
- Filter by type
- Sort by mention count or recency
- Click an entity to see its detail page with co-occurrence relationships and linked captures

**Slack**:
- `!entities` — List all with mention counts
- `!entity Alice Smith` — Detail view

### Entity Management

**Merge** — When you find duplicates (e.g., "Tom Smith" and "Tom S."):
- Web: Entity detail → "Merge into..." → enter target entity ID
- Slack: `!entity merge "Tom S." "Tom Smith"`
- All mentions transfer to the target entity

**Split** — When an alias is actually a different person/thing:
- Web: Entity detail → "Split alias" → select alias from dropdown
- Slack: `!entity split "Alice Smith" Alice`
- Creates a new entity and moves relevant mentions

### Co-occurrence

The entity detail page shows **related entities** — other entities that frequently appear in the same captures. This surfaces implicit relationships (e.g., Alice and the QSR project always appear together).

---

## 10. Weekly Briefs

An AI-synthesized summary of your week, generated automatically every Sunday at 8 PM.

### What's in a Brief

| Section | Purpose |
|---------|---------|
| **Headline** | One sentence capturing the week's theme (max 120 chars) |
| **Wins** | Concrete accomplishments and positive outcomes |
| **Blockers** | Active impediments with what's blocked and why |
| **Risks** | Emerging concerns trending toward problems |
| **Open Loops** | Deferred decisions, unanswered questions, incomplete tasks |
| **Next Week Focus** | Highest-leverage items based on momentum + blockers (max 5) |
| **Avoided Decisions** | Choices where a decision was available but deferred |
| **Drift Alerts** | Topics that disappeared or new topics consuming disproportionate attention |
| **Connections** | Non-obvious links between captures from different domains |

### Quality Rules

Briefs follow strict anti-fluff rules:
- Max 800 words total
- Empty sections are omitted (never invented)
- No restatement of a single capture with different wording
- No generic observations ("you had a busy week")
- Every item must be specific enough that you recognize exactly what it refers to
- No filler phrases

### Automatic Schedule

Runs every **Sunday at 8 PM UTC** via BullMQ scheduled job. Delivery:
- **Pushover** notification with headline
- **Email** (HTML formatted) to configured recipient
- **Capture** — Brief saved back into your brain as a "reflection" for future search

### Manual Trigger

- **Web**: Briefs page → **Run Now**
- **Slack**: `!brief`
- **API**: `POST /api/v1/skills/weekly-brief/trigger`

Optional overrides via API:
```json
{
  "windowDays": 14,
  "tokenBudget": 75000
}
```

### Viewing Past Briefs

- **Web**: Briefs page → expand any brief card in the history
- **Slack**: `!brief last`
- **MCP**: `get_weekly_brief` tool with `weeks_ago` parameter
- **API**: `GET /api/v1/skills/weekly-brief/logs?limit=20`

---

## 11. Governance Sessions

A structured conversation with an AI "board of directors" that keeps you honest about priorities, decisions, and trajectory.

### Session Types

**Quick Board Check** — Focused check-in across 5 mandatory areas:
1. **Priorities & blockers** — What you're actually working on + the single biggest blocker
2. **Key decisions** — Concrete decisions made this week with rationale
3. **Active bets & predictions** — Approaching resolution dates, confidence changes
4. **Work-personal energy balance** — Honest assessment, not performance spin
5. **90-day outlook** — Actual trajectory, not wishful thinking

**Quarterly Review** — Longer-term reflection:
- Goals set vs. accomplished
- Patterns you're noticing
- What to carry forward vs. drop
- Quarterly focus areas

### Board Roles

The AI rotates through four specialized personas during the conversation:

| Role | Focus | Style |
|------|-------|-------|
| **Operator** (turns 1–2) | Execution, throughput, blockers | Demands specifics |
| **Strategist** (turns 3–4) | 90-day positioning, bet quality | Pattern-oriented |
| **Skeptic** (turns 5–6) | Assumptions, blind spots | Challenges everything |
| **Integrator** (turns 7+) | Cross-domain synthesis | Generates assessment |

### Anti-Vagueness Enforcement

The system pushes back on vague answers:
- "Working on it" or "making progress" (without specifics) → pushback
- Max 2 pushbacks per topic before moving on
- Prevents the session from becoming a performance review you spin

### How to Run a Session

**Via Web** (`/board`):
1. Click "Start Quick Check" or "Start Quarterly Review"
2. Read the opening prompt from the first board role
3. Type your response and click Send
4. Board responds with follow-up from the current role
5. Continue until all 5 topics are covered
6. Click "End session" for summary

**Via Slack**:
1. `!board quick` or `!board quarterly`
2. Bot posts opening in a thread
3. Reply in the thread with your answers
4. Control with `!board pause`, `!board done`, or `!board abandon`

### Session Lifecycle

| State | Description |
|-------|-------------|
| `active` | Conversation in progress |
| `paused` | Saved for later (auto-pause after 30 min idle; resume within 30 days) |
| `complete` | All topics covered, summary generated |
| `abandoned` | Discarded without summary |

### Assessment & Auto-Bet

When all 5 topics are substantively covered, the Integrator generates:
- Key findings
- Risks identified
- Honest assessment synthesis
- **A falsifiable prediction** — automatically created as a bet with confidence score and due date

This bet appears in your Bets section tagged `governance, board-check, auto-generated`.

---

## 12. Bets & Predictions

Track falsifiable predictions to calibrate your judgment over time.

### Creating Bets

- **Web**: Board page → Bets section → "Add Bet"
  - Statement (required): What you're predicting
  - Confidence (0.0–1.0): How sure you are
  - Due date (optional): When it should resolve
- **Slack**: `!bet add 0.8 "QSR deal closes by end of Q2"`
- **Auto-generated**: Governance sessions create bets automatically
- **API**: `POST /api/v1/bets`

### Managing Bets

| Action | Web | Slack |
|--------|-----|-------|
| List all | Board page → Bets section | `!bet list` |
| Filter by status | Toggle "all" / "open" | `!bet list pending` |
| Check expiring | *(visible in list)* | `!bet expiring 14` |
| Resolve | Click won/lost/cancel button | `!bet resolve <id> correct "evidence"` |

### Bet Statuses

| Status | Meaning |
|--------|---------|
| `open` (pending) | Not yet resolved |
| `won` (correct) | Prediction was right |
| `lost` (incorrect) | Prediction was wrong |
| `cancelled` (ambiguous) | Can't determine or no longer relevant |

### Drift Monitoring

The drift monitor skill (daily at 8 AM) checks for:
- Open bets approaching their due date with no recent related captures
- Bets that have gone "silent" (no mentions in recent captures)
- Alerts you via the Intelligence page and Pushover notifications

---

## 13. Intelligence (Connections & Drift)

Two AI-powered analysis skills that surface patterns and risks.

### Daily Connections

**What it does**: Analyzes recent captures across all brain views to find non-obvious cross-domain patterns. For example, a client timeline change and a technical architecture decision might both point to a capacity issue.

**Schedule**: Daily at 9 PM UTC (automatic)

**Output includes**:
- Summary of the analysis
- Connection items, each with:
  - Theme (the cross-domain pattern)
  - Confidence level (high/medium/low)
  - Insight (what the connection means)
  - Domains involved
  - Related capture count
- Meta-patterns (higher-level observations)

**Manual trigger**:
- Web: Intelligence page → Connections card → "Run"
- Slack: `!connections [days]` (default 7, max 90)
- API: `POST /api/v1/intelligence/daily-connections/trigger`

### Drift Monitor

**What it does**: Detects when important topics, commitments, or bets go silent — things you were tracking that have fallen off your radar.

**Schedule**: Daily at 8 AM UTC (automatic)

**Output includes**:
- Overall health badge (healthy/minor/significant/critical)
- Summary
- Drift items, each with:
  - Severity (red/yellow/green)
  - Item name and type
  - Days since last mention
  - Reason for concern
  - Suggested action

**Manual trigger**:
- Web: Intelligence page → Drift Monitor card → "Run"
- Slack: `!drift`
- API: `POST /api/v1/intelligence/drift-monitor/trigger`

---

## 14. Semantic Triggers

Automated alerts that fire when a new capture matches a topic you care about.

### How They Work

1. You define a trigger with a semantic query (e.g., "client risk mentions")
2. Every time a new capture is processed, the pipeline evaluates it against all active triggers
3. If the capture's embedding similarity to the trigger query exceeds the threshold, the trigger fires
4. You receive a Pushover notification (and/or Slack message, depending on delivery channel)

### Creating Triggers

**Web** (Settings → Semantic Triggers):
1. Click "Add Trigger"
2. Enter a name (e.g., "client-risk-mentions")
3. Enter a query text (the semantic query to match against)
4. Click "Add"

**Slack**:
```
!trigger add "client risk mentions"
```

**API**:
```json
POST /api/v1/triggers
{
  "name": "client-risk-mentions",
  "queryText": "client risk mentions",
  "threshold": 0.7,
  "cooldownMinutes": 60,
  "deliveryChannel": "pushover"
}
```

### Managing Triggers

| Action | Web | Slack | API |
|--------|-----|-------|-----|
| List | Settings → Triggers section | `!trigger list` | `GET /api/v1/triggers` |
| Delete | Click trash icon | `!trigger delete <name>` | `DELETE /api/v1/triggers/:id` |
| Test | *(not in UI)* | `!trigger test "query"` | `POST /api/v1/triggers/test` |

### Trigger Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `threshold` | 0.7 | Similarity score (0–1) required to fire |
| `cooldownMinutes` | 60 | Minimum time between firings |
| `deliveryChannel` | pushover | Where to send: `pushover`, `slack`, or `both` |

---

## 15. Document Ingestion

Upload documents to extract text and create captures.

### Supported Formats

| Format | Extension |
|--------|-----------|
| PDF | `.pdf` |
| Word (modern) | `.docx` |
| Word (legacy) | `.doc` |
| Markdown | `.md` |
| Plain text | `.txt` |
| HTML | `.html` |

### How to Upload

**API**:
```bash
curl -X POST https://brain.troy-davis.com/api/v1/documents \
  -F "file=@report.pdf" \
  -F "brain_view=technical" \
  -F "tags=quarterly,review" \
  -F "title=Q1 Architecture Review"
```

### Processing Flow

1. File uploaded and stored temporarily
2. Capture created with `pipeline_status: pending_extraction`
3. Document pipeline job queued
4. Text extracted from file
5. Capture updated with full extracted content
6. Standard 6-stage pipeline runs (classify, embed, extract, link, triggers, notify)

---

## 16. Settings & Administration

### System Health

The Settings page shows real-time status of all connected services:
- **Postgres** — Database connection and latency
- **Redis** — Queue backend status
- **LiteLLM** — AI gateway availability and models

### Queue Health

BullMQ queue statistics:
- `capture-pipeline` — Main capture processing
- `skill-execution` — Scheduled skills (briefs, connections, drift)
- `notification` — Push notifications
- `access-stats` — Usage tracking
- `daily-sweep` — Failed job retry

Each shows waiting, active, and failed job counts.

### Skills Management

View and manually trigger any scheduled skill:
- `weekly-brief` — Sunday 8 PM
- `daily-connections` — Daily 9 PM
- `drift-monitor` — Daily 8 AM
- `pipeline-health` — Hourly

### Data Reset

The "Wipe All Data" function in Settings → Danger Zone:

**What gets deleted**:
- All captures and embeddings
- All entities and relationships
- All governance sessions and messages
- All weekly briefs
- All AI audit logs and bets

**What's preserved**:
- Database schema
- Trigger configurations
- Skill schedules and history

Requires typing `WIPE ALL DATA` to confirm.

### Config Hot-Reload

Admins can reload YAML configuration without restarting:
```bash
POST /api/v1/admin/config/reload
```
Reloads: `ai-routing.yaml`, `brain-views.yaml`, `pipeline.yaml`, `skills.yaml`, `notifications.yaml`

---

## 17. API Reference

Base URL: `https://brain.troy-davis.com/api/v1`

### Captures

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/captures` | Create capture |
| `GET` | `/captures` | List captures (paginated, filterable) |
| `GET` | `/captures/:id` | Get single capture |
| `PATCH` | `/captures/:id` | Update tags/view/metadata |
| `DELETE` | `/captures/:id` | Soft delete |
| `POST` | `/captures/:id/retry` | Retry failed pipeline |

### Search

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/search?q=...` | Quick search (query params) |
| `POST` | `/search` | Full search (JSON body) |
| `POST` | `/synthesize` | LLM synthesis over search results |

### Entities

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/entities` | List entities |
| `GET` | `/entities/:id` | Entity detail with linked captures |
| `POST` | `/entities/:id/merge` | Merge entities |
| `POST` | `/entities/:id/split` | Split alias |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/sessions` | Create governance session |
| `GET` | `/sessions` | List sessions |
| `GET` | `/sessions/:id` | Get session with transcript |
| `POST` | `/sessions/:id/respond` | Send message |
| `POST` | `/sessions/:id/pause` | Pause session |
| `POST` | `/sessions/:id/resume` | Resume session |
| `POST` | `/sessions/:id/complete` | Complete with summary |
| `POST` | `/sessions/:id/abandon` | Abandon session |

### Bets

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/bets` | List bets |
| `POST` | `/bets` | Create bet |
| `GET` | `/bets/:id` | Get single bet |
| `PATCH` | `/bets/:id` | Resolve bet |
| `DELETE` | `/bets/:id` | Delete bet |
| `GET` | `/bets/expiring` | Bets due soon |

### Skills

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/skills` | List skills with schedules |
| `POST` | `/skills/:name/trigger` | Manually trigger skill |
| `GET` | `/skills/:name/logs` | Skill execution history |

### Intelligence

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/intelligence/summary` | Latest connections + drift |
| `GET` | `/intelligence/connections/latest` | Latest connections |
| `GET` | `/intelligence/drift/latest` | Latest drift |
| `POST` | `/intelligence/:skill/trigger` | Trigger analysis |

### Triggers

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/triggers` | List triggers |
| `POST` | `/triggers` | Create trigger |
| `DELETE` | `/triggers/:id` | Delete trigger |
| `POST` | `/triggers/test` | Test trigger query |

### Documents

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/documents` | Upload document (multipart/form-data) |

### Stats & Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/stats` | Dashboard statistics |
| `GET` | `/health` | Service health check |
| `GET` | `/events` | SSE stream for real-time updates |

### Admin

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/admin/config/reload` | Hot-reload YAML configs |
| `POST` | `/admin/reset-data` | Wipe all data (requires confirm) |
| `GET` | `/admin/pipeline/health` | Queue health details |

### Rate Limits

| Tier | Endpoints | Limit |
|------|-----------|-------|
| Strict | `/captures`, `/search`, `/synthesize` | 20 req/min |
| Admin | `/admin/*` | 5 req/min |
| Default | All other | 60 req/min |

### Pagination

List endpoints return:
```json
{
  "items": [...],
  "total": 156,
  "limit": 20,
  "offset": 0
}
```

---

## 18. Troubleshooting

### Connection Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Web dashboard won't load | Cloudflare Tunnel or core-api down | SSH to server, `docker compose ps`, check `core-api` and `cloudflared` |
| Voice capture "Could not connect" | Tailscale not active on iPhone | Open Tailscale app, ensure VPN is connected |
| Slack bot not responding | slack-bot container down | `docker compose ps`, check `slack-bot` status |
| MCP tools not available | LiteLLM or MCP route issue | Check LiteLLM logs, verify MCP config |

### Pipeline Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Capture stuck in "pending" | Redis or worker down | Check `docker compose ps` for workers container |
| Capture stuck in "processing" | Pipeline stage timeout | `!retry <id>` or wait for daily sweep at 3 AM |
| Pipeline shows "failed" | LiteLLM unavailable during processing | Check LiteLLM, then `!retry <id>` |
| Search returns no results | Embedding not yet complete | Wait 30–90s after capture, then search again |

### Search Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| No results for known content | Embedding failed or pending | Check capture's pipeline status |
| Poor relevance | Default weights may not suit query | Try adjusting `temporal_weight` or `search_mode` |
| Slow search | Large result set or LiteLLM latency | Narrow with filters, reduce `limit` |

### Voice Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| HTTP 503 from voice service | voice-capture or faster-whisper down | `docker compose ps`, check both containers |
| Transcription takes >2 minutes | faster-whisper cold start (first use) | Wait up to 5 min for model to load |
| Bad transcription quality | Background noise or low audio quality | Record in quieter environment |

### Governance & Brief Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Brief is empty | No captures in the past 7 days | Need captures to generate from |
| Session won't start | Active session already exists | `!board status` to check, complete or abandon existing |
| Session auto-paused | 30 min idle timeout | `!board resume <id>` |
| No Pushover notification | PUSHOVER_TOKEN/USER not set | Check env vars in `.env.secrets` |

### General

| Symptom | Cause | Fix |
|---------|-------|-----|
| All services down | Docker Compose not running | SSH to server, `cd` to project, `docker compose up -d` |
| Partial services down | Individual container crashed | `docker compose restart <service-name>` |
| Slow performance | Resource constraints | Check `docker stats` for memory/CPU usage |
| Data corruption | *(unlikely)* | Settings → Danger Zone → Wipe All Data (last resort) |
