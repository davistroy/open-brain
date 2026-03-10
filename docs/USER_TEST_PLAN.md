# Open Brain — User Test Plan

**Version**: 1.1
**Date**: 2026-03-10
**Scope**: Full system — Slack bot + Web UI
**Environment**: Production (homeserver) — brain.k4jda.net + Slack workspace

### Execution Mode Key

| Tag | Meaning |
|-----|---------|
| `[AUTO]` | Fully automated — Claude runs this via SSH/curl or Chrome browser automation (Slack web or brain.k4jda.net) |
| `[MANUAL]` | Requires human action — cannot be automated |

**Automated coverage: ~90% of all test cases.**

The 3 test cases that remain manual-only:
1. **TC-S audio** (voice file upload via Slack) — browser automation cannot inject a real audio file through Slack's file picker
2. **TC-S-105** (LiteLLM unavailable simulation) — requires taking down a production service; too destructive to automate
3. **TC-W-031** (visual pipeline health color states) — requires engineering a degraded state to verify amber/red rendering

Everything else — including all Slack bot tests — is automated via Chrome controlling the Slack web app.

### Slack Web Automation Prerequisites

| Field | Value |
|-------|-------|
| **Slack URL** | `https://app.slack.com/client/T0AHPBS3WJK/C0AJ2P8R31C` |
| **Channel** | `#open-brain` |
| **Bot @mention** | `@Open Brain` |

---

## Table of Contents

1. [Prerequisites & Setup](#1-prerequisites--setup)
2. [Test Data Seeding](#2-test-data-seeding)
3. [Slack Bot — Intent Classification](#3-slack-bot--intent-classification)
4. [Slack Bot — Capture Flow](#4-slack-bot--capture-flow)
5. [Slack Bot — Query Flow](#5-slack-bot--query-flow)
6. [Slack Bot — Commands: Stats & Recent](#6-slack-bot--commands-stats--recent)
7. [Slack Bot — Commands: Brief](#7-slack-bot--commands-brief)
8. [Slack Bot — Commands: Entities](#8-slack-bot--commands-entities)
9. [Slack Bot — Commands: Triggers](#9-slack-bot--commands-triggers)
10. [Slack Bot — Commands: Board (Governance)](#10-slack-bot--commands-board-governance)
11. [Slack Bot — Commands: Bets](#11-slack-bot--commands-bets)
12. [Slack Bot — Commands: Pipeline](#12-slack-bot--commands-pipeline)
13. [Slack Bot — Edge Cases & Error Handling](#13-slack-bot--edge-cases--error-handling)
14. [Web UI — Dashboard](#14-web-ui--dashboard)
15. [Web UI — Search](#15-web-ui--search)
16. [Web UI — Timeline](#16-web-ui--timeline)
17. [Web UI — Entities](#17-web-ui--entities)
18. [Web UI — Board (Governance + Bets)](#18-web-ui--board-governance--bets)
19. [Web UI — Briefs](#19-web-ui--briefs)
20. [Web UI — Settings](#20-web-ui--settings)
21. [End-to-End Cross-System Flows](#21-end-to-end-cross-system-flows)
22. [Pass/Fail Summary Checklist](#22-passfail-summary-checklist)

---

## 1. Prerequisites & Setup `[AUTO]`

### 1.1 Environment Checks

Before starting, verify all services are healthy:

```
curl https://brain.k4jda.net/api/v1/captures?limit=1
```

Expected: `200 OK` with JSON response (not an error page).

- [ ] Web dashboard loads at `https://brain.k4jda.net`
- [ ] Slack bot is online (check bot presence in your Slack workspace)
- [ ] LiteLLM gateway is reachable at `https://llm.k4jda.net`
- [ ] No containers in restart loop (`docker compose ps` on homeserver shows all healthy)

### 1.2 Test Isolation

Run **Section 20.4 (Wipe All Data)** first if the DB has existing test data, so results are deterministic. Triggers are preserved across wipes — note any pre-existing triggers before wiping.

### 1.3 Browser Setup

- Open `https://brain.k4jda.net` in a fresh browser tab (no cached state)
- Open DevTools → Console tab — keep visible to catch JS errors during testing
- Keep Network tab open to verify API calls succeed

### 1.4 Notation

| Symbol | Meaning |
|--------|---------|
| ✅ | Expected passing behavior |
| ❌ | Failure — log the actual result |
| `[INPUT]` | Exact text to type |
| `[EXPECTED]` | What you should see |

---

## 2. Test Data Seeding `[AUTO]`

These captures form the foundation for later search and entity tests. Create them via Slack before testing UI features.

### 2.1 Seed Captures via Slack

Send the following as **plain messages** (not commands) to the bot channel. Wait for the bot to acknowledge each one before sending the next.

| # | Message to Send | Expected Type | Expected View |
|---|----------------|---------------|---------------|
| 1 | `Decided to use pgvector for semantic search instead of a dedicated vector DB — simpler ops and good enough for current scale` | decision | technical |
| 2 | `Had a great call with the Chick-fil-A team today — they are very interested in the AI transformation roadmap` | observation | client |
| 3 | `Need to finish the LiteLLM proxy configuration before end of week` | task | technical |
| 4 | `Got the Stratfield Consulting contract signed — major win for Q1` | win | career |
| 5 | `Blocked on the contact center integration — waiting for API credentials from vendor` | blocker | work-internal |
| 6 | `What are the tradeoffs between event-driven and batch processing architectures?` | question | technical |
| 7 | `Reflecting on the Coca-Cola divestiture — the key lesson was that communication cadence matters more than the content` | reflection | career |
| 8 | `Idea: build a voice-first capture interface using iOS shortcuts that sends audio directly to the ingestion API` | idea | technical |

After seeding, verify the bot replied to all 8 with a capture summary. Note the capture IDs from bot replies if visible.

---

## 3. Slack Bot — Intent Classification `[AUTO — Chrome/Slack web]`

**Purpose**: Verify the IntentRouter correctly classifies messages before routing them.

### TC-S-001 — CAPTURE intent (declarative statement)

> `[INPUT]` Send: `Had a good planning session with the team, we aligned on the Q2 roadmap priorities`
> `[EXPECTED]` Bot replies with capture confirmation (type + brain view badge, no question marks)
> Pass condition: Bot does NOT ask a question; creates a capture

### TC-S-002 — QUERY intent (question)

> `[INPUT]` Send: `What decisions have I made about infrastructure recently?`
> `[EXPECTED]` Bot replies with a synthesized answer referencing stored captures, not a capture confirmation
> Pass condition: Response looks like a search result / answer, not "Captured: ..."

### TC-S-003 — COMMAND intent (! prefix)

> `[INPUT]` Send: `!help`
> `[EXPECTED]` Bot replies with the full command reference list
> Pass condition: List of commands displayed, no capture created

### TC-S-004 — CONVERSATION intent (acknowledgment)

> `[INPUT]` Send: `Thanks!`
> `[EXPECTED]` Bot sends no reply OR a brief acknowledgment — does NOT create a capture
> Pass condition: No "Captured:" message; no API call to POST /captures

### TC-S-005 — @mention routing to QUERY

> `[INPUT]` In a channel where the bot is present, @mention the bot: `@OpenBrain what have I noted about Chick-fil-A?`
> `[EXPECTED]` Bot answers the question — does NOT create a capture of the @mention text
> Pass condition: Synthesized answer returned, no capture confirmation

### TC-S-006 — @mention with ! command prefix

> `[INPUT]` `@OpenBrain !stats`
> `[EXPECTED]` Bot returns stats summary (same as `!stats` alone)
> Pass condition: Stats block displayed correctly

---

## 4. Slack Bot — Capture Flow `[AUTO — Chrome/Slack web]`

### TC-S-010 — Basic text capture with auto-classification

> `[INPUT]` `We're planning to migrate all contact center analytics to a cloud data warehouse by end of Q3`
> `[EXPECTED]`
> - Bot confirms with: capture type (likely `decision` or `task`), brain view (likely `work-internal` or `client`)
> - Short summary appears in the reply
> Pass condition: Confirmation message appears within 15 seconds; type and view make sense

### TC-S-011 — Capture polling completes (metadata enrichment)

> After TC-S-010, wait up to 30 seconds
> `[EXPECTED]` Bot reply is updated (or a second message appears) with entity extraction info OR the classification is complete
> Pass condition: No "still processing" message stuck indefinitely

### TC-S-012 — All 8 capture types get classified

Over the seeding phase (Section 2.1) or additional captures, confirm the bot has classified at least one capture of each type:
`decision`, `idea`, `observation`, `task`, `win`, `blocker`, `question`, `reflection`

> Pass condition: `!stats` shows count > 0 for multiple types

### TC-S-013 — All 5 brain views get used

> Pass condition: `!stats` shows count > 0 for at least 3 of: `career`, `personal`, `technical`, `work-internal`, `client`

### TC-S-014 — Thread reply doesn't create duplicate capture

> After creating any capture, reply in the bot's reply thread with: `That's exactly right`
> `[EXPECTED]` Bot does NOT create a second capture; thread context is maintained
> Pass condition: No second "Captured:" message; conversation handler routes it correctly

---

## 5. Slack Bot — Query Flow `[AUTO — Chrome/Slack web]`

### TC-S-020 — Basic question answered with context

> `[INPUT]` `What decisions have I made recently?`
> `[EXPECTED]` Synthesized answer grounded in stored captures; at least 1 capture referenced
> Pass condition: Response is substantive, references decision-type captures

### TC-S-021 — Query with no matching results

> After wiping (or early in testing): `What did I capture about Formula 1 racing?`
> `[EXPECTED]` Bot replies with a graceful "I don't have anything about that" or low-confidence answer — does NOT crash or 500
> Pass condition: Clean "nothing found" response

### TC-S-022 — Follow-up question in query thread

> After TC-S-020, reply in that thread: `Tell me more about the infrastructure decisions`
> `[EXPECTED]` Bot performs a new search with updated context and replies in the same thread
> Pass condition: Second answer appears in thread; context from first answer influences second

### TC-S-023 — Query triggers entity linking in response

> `[INPUT]` `What have I said about Chick-fil-A?`
> `[EXPECTED]` Bot returns the client observation from seed data
> Pass condition: "Chick-fil-A" entity is mentioned in the answer or supporting captures shown

---

## 6. Slack Bot — Commands: Stats & Recent `[AUTO — Chrome/Slack web]`

### TC-S-030 — !stats basic

> `[INPUT]` `!stats`
> `[EXPECTED]` Block showing:
> - Total captures count (should match seeded count)
> - Breakdown by source (should show "slack")
> - Breakdown by type
> - Breakdown by brain view
> - Pipeline health (pending/processing/complete/failed)

### TC-S-031 — !recent default (5)

> `[INPUT]` `!recent`
> `[EXPECTED]` List of 5 most recent captures, each with type and brain view
> Pass condition: 5 items shown in reverse chronological order

### TC-S-032 — !recent with count

> `[INPUT]` `!recent 3`
> `[EXPECTED]` Exactly 3 captures shown
> Pass condition: 3 items, most recent first

### TC-S-033 — !recent max cap

> `[INPUT]` `!recent 50`
> `[EXPECTED]` At most 20 results (enforced cap)
> Pass condition: No crash; reasonable result count returned

### TC-S-034 — !help

> `[INPUT]` `!help`
> `[EXPECTED]` Full command listing covering all major commands (`!stats`, `!recent`, `!brief`, `!entities`, `!trigger`, `!board`, `!bet`, `!pipeline`, `!help`)
> Pass condition: All major commands present in output

---

## 7. Slack Bot — Commands: Brief `[AUTO — Chrome/Slack web]`

### TC-S-040 — !brief (trigger generation)

> **Prerequisite**: At least 3+ captures in the system (from seed data)
> `[INPUT]` `!brief`
> `[EXPECTED]` Bot replies "Generating brief…" then returns a synthesized brief with:
> - Headline
> - Wins section
> - Blockers section
> - Decisions section
> - Top entities mentioned
> Pass condition: Brief content appears (may take 30–60 seconds for LLM synthesis)

### TC-S-041 — !brief with no captures

> (Only testable immediately after a data wipe)
> `[INPUT]` `!brief`
> `[EXPECTED]` Bot replies "No captures found in the last 7 days" or similar graceful message
> Pass condition: No crash, clean message

### TC-S-042 — !brief last

> After TC-S-040 succeeds, run:
> `[INPUT]` `!brief last`
> `[EXPECTED]` Bot shows the most recently generated brief (from skills_log)
> Pass condition: Brief content shown, timestamp visible, content matches TC-S-040 output

---

## 8. Slack Bot — Commands: Entities `[AUTO — Chrome/Slack web]`

### TC-S-050 — !entities (list)

> **Prerequisite**: At least a few captures processed through pipeline
> `[INPUT]` `!entities`
> `[EXPECTED]` List of extracted entities, each showing: name, type (person/org/etc.), mention count
> Pass condition: At least 1 entity shown (e.g., "Chick-fil-A", "Stratfield Consulting", "LiteLLM")

### TC-S-051 — !entity <name> (detail)

> `[INPUT]` `!entity Chick-fil-A`
> `[EXPECTED]` Entity detail block: full name, type, mention count, linked captures (up to 3–5)
> Pass condition: Entity found; linked captures listed

### TC-S-052 — !entity for unknown entity

> `[INPUT]` `!entity Nonexistent Corp XYZ123`
> `[EXPECTED]` "Entity not found" message — no crash
> Pass condition: Graceful "not found" reply

### TC-S-053 — !entity merge

> **Prerequisite**: Two entities that are the same (e.g., "CFA" and "Chick-fil-A")
> First create a capture mentioning "CFA" to get that entity:
> `Discussed CFA pilot program scope this morning`
> Then:
> `[INPUT]` `!entity merge CFA Chick-fil-A`
> `[EXPECTED]` Bot confirms merge; subsequent `!entity Chick-fil-A` shows combined mention count
> Pass condition: Merge succeeds; source entity no longer appears in `!entities` list

### TC-S-054 — !entity split

> **Prerequisite**: Entity with multiple aliases that should be separate
> `[INPUT]` `!entity split "Chick-fil-A" "CFA"`
> `[EXPECTED]` Bot confirms new entity "CFA" was split out
> Pass condition: `!entities` now shows "CFA" as a separate entry

---

## 9. Slack Bot — Commands: Triggers `[AUTO — Chrome/Slack web]`

### TC-S-060 — !trigger add

> `[INPUT]` `!trigger add "contact center AI automation"`
> `[EXPECTED]` Bot confirms trigger created with a name/ID
> Pass condition: Trigger appears in subsequent `!trigger list`

### TC-S-061 — !trigger list

> `[INPUT]` `!trigger list`
> `[EXPECTED]` List of triggers with: name, status (active/inactive), fire count, last fired timestamp
> Pass condition: At least the trigger from TC-S-060 appears

### TC-S-062 — !trigger test

> `[INPUT]` `!trigger test "contact center integration challenges"`
> `[EXPECTED]` Top matching captures returned (should match the "Blocked on contact center integration" seed capture)
> Pass condition: At least 1 relevant capture returned; no trigger fired (test mode)

### TC-S-063 — Trigger fires on new matching capture

> After TC-S-060, send a capture that should match:
> `Working through a major contact center AI integration with the vendor API team`
> `[EXPECTED]` Within ~60 seconds, bot sends a trigger-fire notification in the channel: "Trigger fired: contact center AI automation"
> Pass condition: Notification received with matching capture preview

### TC-S-064 — !trigger delete

> `[INPUT]` `!trigger delete contact center AI automation`
> `[EXPECTED]` Bot confirms deletion; trigger no longer active
> Pass condition: `!trigger list` shows trigger as inactive or removed

---

## 10. Slack Bot — Commands: Board (Governance) `[AUTO — Chrome/Slack web, with LLM wait handling]`

### TC-S-070 — !board quick (start quick check session)

> `[INPUT]` `!board quick`
> `[EXPECTED]`
> - Bot creates a new governance session
> - Replies in a new thread with opening question from the "strategist" or "operator" role
> - Session type shown as "quick check"
> Pass condition: Thread started, bot asks a substantive opening question

### TC-S-071 — Multi-turn session conversation

> In the thread from TC-S-070, reply with substantive responses to the bot's questions (3–5 exchanges):
> Example: `My main focus this week is wrapping up the Stratfield client proposal and debugging the pipeline`
> `[EXPECTED]` Bot responds as a governance board member; asks follow-up questions; different "voices" may appear (strategist, contrarian, etc.)
> Pass condition: Bot maintains context across 3+ turns without confusion

### TC-S-072 — !board pause (in thread)

> In the active session thread:
> `[INPUT]` `!board pause`
> `[EXPECTED]` Bot acknowledges pause; session status changes to "paused"; provides session ID for resumption
> Pass condition: Session paused; `!board status` shows it as paused

### TC-S-073 — !board status

> `[INPUT]` `!board status`
> `[EXPECTED]` Lists active and paused sessions with session IDs and turn counts
> Pass condition: Paused session from TC-S-072 shown in list

### TC-S-074 — !board resume

> `[INPUT]` `!board resume <session_id from TC-S-073>`
> `[EXPECTED]` Bot resumes session, provides context recap, asks next question
> Pass condition: Resumed session continues where it left off

### TC-S-075 — !board done (complete session)

> In an active session thread:
> `[INPUT]` `!board done`
> `[EXPECTED]` Bot generates a summary of the session (topics covered, action items, key decisions); session marked complete
> Pass condition: Summary is substantive; session no longer appears in `!board status`

### TC-S-076 — !board quarterly

> `[INPUT]` `!board quarterly`
> `[EXPECTED]` Starts a quarterly review session (longer-form); opening questions are more strategic/reflective
> Pass condition: Session created; distinct from "quick check" in tone/scope

### TC-S-077 — !board abandon

> Start a session with `!board quick`, then in the thread:
> `[INPUT]` `!board abandon`
> `[EXPECTED]` Session discarded; no summary generated; bot confirms
> Pass condition: Clean abandonment; session marked abandoned

---

## 11. Slack Bot — Commands: Bets `[AUTO — Chrome/Slack web]`

### TC-S-080 — !bet add

> `[INPUT]` `!bet add 0.85 Stratfield closes 2 new enterprise clients by end of Q2 2026`
> `[EXPECTED]` Bot confirms bet created with: statement, confidence (85%), due date inferred or requested
> Pass condition: Bet appears in subsequent `!bet list`

### TC-S-081 — !bet list (all)

> `[INPUT]` `!bet list`
> `[EXPECTED]` All bets listed with: statement, confidence, status (pending), due date
> Pass condition: At least TC-S-080 bet shown

### TC-S-082 — !bet list with status filter

> `[INPUT]` `!bet list pending`
> `[EXPECTED]` Only pending bets shown
> Pass condition: Correct filter applied; no resolved bets shown

### TC-S-083 — !bet expiring

> `[INPUT]` `!bet expiring 30`
> `[EXPECTED]` Bets due within 30 days listed
> Pass condition: If no bets due soon, clean "none expiring" message — no crash

### TC-S-084 — !bet resolve correct

> Using the bet ID from TC-S-080:
> `[INPUT]` `!bet resolve <id> correct`
> `[EXPECTED]` Bet updated to status "correct"; resolution captured as a reflection in the brain
> Pass condition: `!bet list` shows bet as "correct"; a new `reflection`-type capture appears

### TC-S-085 — !bet resolve incorrect with evidence

> Create another bet then:
> `[INPUT]` `!bet resolve <id> incorrect Deal fell through — client went with a competitor`
> `[EXPECTED]` Bet resolved as incorrect with evidence stored
> Pass condition: Evidence shown in bet detail

---

## 12. Slack Bot — Commands: Pipeline `[AUTO — Chrome/Slack web]`

### TC-S-090 — !pipeline status

> `[INPUT]` `!pipeline status`
> `[EXPECTED]` Queue status block showing:
> - Per-queue counts: capture-pipeline, skill-execution, notification, access-stats, daily-sweep
> - Counts: waiting, active, completed, failed
> Pass condition: All queues shown; `failed` count is 0 or explained

### TC-S-091 — !retry (requeue failed capture)

> **Prerequisite**: A capture in `failed` pipeline status (may need to deliberately corrupt one or use an existing failed one)
> `[INPUT]` `!retry <capture_id>`
> `[EXPECTED]` Bot confirms capture requeued; pipeline status resets to "pending"
> Pass condition: Capture processes successfully on retry; `!pipeline status` shows 0 new failures

---

## 13. Slack Bot — Edge Cases & Error Handling `[AUTO except TC-S-105]`

### TC-S-100 — Unknown command

> `[INPUT]` `!foobar`
> `[EXPECTED]` Bot replies with "Unknown command" and suggests `!help`
> Pass condition: No crash; helpful response

### TC-S-101 — Command with missing required argument

> `[INPUT]` `!entity merge` (no arguments)
> `[EXPECTED]` Bot replies with usage hint — not a stack trace
> Pass condition: Graceful error message

### TC-S-102 — Very long capture text

> Send a message of 500+ words (paste a paragraph multiple times)
> `[EXPECTED]` Capture created successfully; summary truncated in reply if too long
> Pass condition: No 413 or 500 error; capture stored

### TC-S-103 — Rapid successive captures

> Send 3 captures in quick succession (< 5 seconds apart)
> `[EXPECTED]` All 3 are captured without dropping or duplicating
> Pass condition: `!recent 5` shows all 3 new captures

### TC-S-104 — Message with special characters

> `[INPUT]` `Need to handle edge cases with "quotes", apostrophes, & ampersands — and em-dashes`
> `[EXPECTED]` Capture created; special characters preserved in stored content
> Pass condition: `!recent 1` shows the message without garbled characters

### TC-S-105 — LiteLLM unavailable (simulated) `[MANUAL]`

> **Cannot be automated** — requires stopping the LiteLLM service on homeserver, which is a shared production dependency.
> If you want to run this manually: `ssh root@homeserver.k4jda.net "docker stop litellm"`, send a capture, verify graceful failure, then `docker start litellm`.
> `[EXPECTED]` No silent data loss; capture exists in DB as "pending" or "failed", not lost entirely

---

## 14. Web UI — Dashboard `[AUTO — Chrome/brain.k4jda.net]`

### TC-W-010 — Page loads without errors

> Navigate to `https://brain.k4jda.net`
> `[EXPECTED]` Page renders completely; no blank sections; no console errors
> Pass condition: No red console errors; stats cards visible

### TC-W-011 — Stats cards show accurate counts

> `[EXPECTED]` After seeding from Section 2.1:
> - Total Captures: matches seed count (8+)
> - By Source: shows "slack" with correct count
> - By Type: shows breakdown across multiple types
> Pass condition: Numbers match what `!stats` reported in Slack

### TC-W-012 — Pipeline health banner `[AUTO for green state; MANUAL for amber/red]`

> `[EXPECTED]` Pipeline health shows:
> - Green state: 0 failed, 0 stuck — **automated: verifiable by reading the banner text**
> - Amber/red degraded states require engineering a real failure — **manual only**
> Pass condition (automated): Banner present; no red state on a healthy system

### TC-W-013 — Quick capture form submission

> In the Dashboard capture form:
> `[INPUT]` Type: `Testing the web capture form — quick capture from browser`
> Select type: `observation`
> Select brain view: `technical`
> Click Submit
> `[EXPECTED]`
> - Loading state appears
> - Success confirmation appears
> - Capture count increments by 1 (after refresh or live update)
> Pass condition: POST /captures succeeds; new capture appears in recent list

### TC-W-014 — Quick capture — empty submission blocked

> Leave the capture text field empty and click Submit
> `[EXPECTED]` Validation prevents submission; error shown inline
> Pass condition: No API call made; user shown "required" error

### TC-W-015 — Recent captures list refreshes

> After TC-W-013, verify the new capture appears in the recent captures section
> Pass condition: New capture is the top item in the recent list

### TC-W-016 — Navigation links work

> Click each nav link: Dashboard, Search, Timeline, Entities, Board, Briefs, Settings
> `[EXPECTED]` Each page loads without 404 or blank screen
> Pass condition: All 7 nav destinations render

---

## 15. Web UI — Search `[AUTO — Chrome/brain.k4jda.net]`

### TC-W-020 — Basic search returns results

> Navigate to Search page
> `[INPUT]` Type: `pgvector`
> `[EXPECTED]` Within 1 second (debounce): results appear including the decision capture about pgvector from seed data
> Pass condition: At least 1 result; capture content visible in result card

### TC-W-021 — Search result cards display correct fields

> For any search result:
> `[EXPECTED]` Each card shows:
> - Content snippet (truncated)
> - Capture type badge (e.g., "decision")
> - Brain view badge (e.g., "technical")
> - Relative date or timestamp
> - Relevance score (if hybrid mode)
> Pass condition: All 5 fields visible on at least one card

### TC-W-022 — Click result card opens detail modal

> Click any search result card
> `[EXPECTED]` Detail panel/modal opens showing:
> - Full capture content
> - Metadata: type, brain view, source, created_at
> - Extracted entities list (if processed)
> - Pipeline status
> Pass condition: Detail opens without page navigation; close button works

### TC-W-023 — Search with brain view filter

> In Search, apply filter: Brain View = "technical"
> `[EXPECTED]` Results limited to technical view captures
> Pass condition: No results with `career` or `personal` brain view appear; filter badge count shows 1

### TC-W-024 — Search with capture type filter

> In Search, apply filter: Capture Type = "decision"
> `[EXPECTED]` Only decision-type captures returned
> Pass condition: All results show "decision" type badge

### TC-W-025 — Search with date range filter

> Set date range to today only (start = today, end = today)
> `[EXPECTED]` Only captures from today shown
> Pass condition: Correct date filtering; older captures excluded

### TC-W-026 — Multiple filters combined

> Apply: Brain View = "technical" AND Capture Type = "decision"
> `[EXPECTED]` Only technical+decision captures shown; filter badge shows count 2
> Pass condition: Both filters applied; results correctly narrowed

### TC-W-027 — Clear filters

> After applying filters in TC-W-026, click "Clear Filters" or remove filters
> `[EXPECTED]` All results return; filter badge resets to 0
> Pass condition: Results back to full set

### TC-W-028 — Empty search query

> Clear the search input entirely
> `[EXPECTED]` Either: shows all captures (paginated) OR shows a prompt to type a query
> Pass condition: No crash; no unhandled error shown

### TC-W-029 — Search query with no results

> `[INPUT]` Type: `Formula 1 racing Silverstone Grand Prix`
> `[EXPECTED]` "No results found" message — no crash
> Pass condition: Empty state rendered gracefully

### TC-W-030 — Vector vs FTS vs Hybrid mode (if toggle visible)

> If search mode selector exists, switch between Hybrid, FTS, Vector
> `[EXPECTED]` Results may differ; no mode causes crash
> Pass condition: All 3 modes return valid responses

---

## 16. Web UI — Timeline `[AUTO — Chrome/brain.k4jda.net]`

### TC-W-040 — Timeline page loads

> Navigate to Timeline page
> `[EXPECTED]` Page renders with captures organized chronologically
> Pass condition: Captures visible; no blank page or error

### TC-W-041 — Timeline shows all seeded captures

> `[EXPECTED]` All 8+ seeded captures visible in the timeline
> Pass condition: Count matches total captures from stats

### TC-W-042 — Click capture in timeline opens detail

> Click a timeline item
> `[EXPECTED]` Capture detail opens (modal or panel)
> Pass condition: Detail shows full content and metadata

---

## 17. Web UI — Entities `[AUTO — Chrome/brain.k4jda.net]`

### TC-W-050 — Entity list loads

> Navigate to Entities page
> `[EXPECTED]` List of extracted entities with name, type, and mention count
> Pass condition: At least 1 entity shown (requires pipeline to have processed some captures)

### TC-W-051 — Entities sorted by mention count

> `[EXPECTED]` Default sort is by mention count descending
> Pass condition: Most-mentioned entity at top

### TC-W-052 — Click entity opens detail

> Click any entity
> `[EXPECTED]` Entity detail shows:
> - Entity name
> - Type (person/org/project/location/concept)
> - Total mention count
> - Linked captures list
> Pass condition: Detail renders correctly; linked captures are clickable

### TC-W-053 — Entity type filter

> If a type filter exists, filter by "organization"
> `[EXPECTED]` Only organization-type entities shown
> Pass condition: Person/project/concept entities hidden

### TC-W-054 — Merge entity (UI flow)

> Select an entity, initiate merge with another
> `[EXPECTED]`
> - Merge dialog opens
> - User selects target entity
> - Confirmation shown
> - After confirm: merged entity appears with combined mention count
> Pass condition: POST /entities/merge succeeds; entity list refreshes

### TC-W-055 — Split entity (UI flow)

> On an entity with multiple aliases:
> `[EXPECTED]`
> - Split dialog opens
> - User enters alias name to split
> - New entity created
> Pass condition: POST /entities/:id/split succeeds; new entity appears in list

---

## 18. Web UI — Board (Governance + Bets) `[AUTO — Chrome/brain.k4jda.net, with LLM wait handling]`

### TC-W-060 — Board page loads

> Navigate to Board page
> `[EXPECTED]` Page renders with two sections: Governance Sessions and Bets
> Pass condition: Both sections visible; no blank page

### TC-W-061 — Start governance session from web UI

> Click "Start Quick Check" (or equivalent button)
> `[EXPECTED]`
> - New session created
> - Bot's opening message appears in session transcript area
> - Input field available for user response
> Pass condition: Session starts; POST /sessions returns 201

### TC-W-062 — Multi-turn session in web UI

> Type a response in the session input and submit
> `[EXPECTED]`
> - User message appears in transcript
> - Bot reply appears after LLM processing (may take 5–15 seconds)
> - Conversation continues
> Pass condition: At least 2 turns complete without error

### TC-W-063 — Complete session from web UI

> Click "Complete Session" or "End Session"
> `[EXPECTED]` Summary generated and displayed; session marked complete
> Pass condition: Session summary visible; session removed from "active" list

### TC-W-064 — Bet list loads

> On Board page, scroll to Bets section
> `[EXPECTED]` All bets listed with: statement, confidence %, status badge, due date
> Pass condition: Bets from Slack testing (Section 11) appear here

### TC-W-065 — Create bet from web UI

> Click "New Bet" or equivalent
> Fill in:
> - Statement: `Open Brain reaches 500 captures by end of April 2026`
> - Confidence: 70%
> - Due date: April 30, 2026
> Submit
> `[EXPECTED]` New bet appears in list with pending status
> Pass condition: POST /bets returns 201; bet in list

### TC-W-066 — Resolve bet from web UI

> Click resolve (Won/Lost) on an open bet
> `[EXPECTED]`
> - Confirmation dialog (if any)
> - Bet status updates to correct/incorrect
> - Status badge color changes
> Pass condition: PATCH /bets/:id succeeds; list reflects new status

### TC-W-067 — Filter bets by status

> If status filter exists: show only "pending" bets
> `[EXPECTED]` Only unresolved bets shown
> Pass condition: Resolved bets hidden

---

## 19. Web UI — Briefs `[AUTO — Chrome/brain.k4jda.net, with LLM wait handling]`

### TC-W-070 — Briefs page loads

> Navigate to Briefs page
> `[EXPECTED]` Page shows skill execution history and most recent brief content (if any)
> Pass condition: Page renders; no crash

### TC-W-071 — Trigger weekly brief from UI

> Click "Generate Brief" or "Run Now" button (if present)
> `[EXPECTED]`
> - Loading state shown
> - Brief generated (may take 30–60 seconds for LLM)
> - Structured brief content displayed: headline, wins, blockers, decisions, entities
> Pass condition: Brief content appears with multiple sections

### TC-W-072 — Brief sections render structured content

> After TC-W-071 (requires captures with LLM processing complete):
> `[EXPECTED]`
> - Headline: single summary sentence
> - Wins: list (from win-type captures)
> - Blockers: list (from blocker-type captures)
> - Decisions: list (from decision-type captures)
> - Top entities: list of most-mentioned entities
> Pass condition: All 5 sections visible; content is non-empty

### TC-W-073 — Skills execution history

> On Briefs page, find the execution log section
> `[EXPECTED]` Log entries showing: timestamp, duration, output summary, status (completed/skipped)
> Pass condition: Most recent run from Section 7 tests (TC-S-040) appears

### TC-W-074 — "No captures" case (empty brief)

> On a fresh system (after wipe):
> `[EXPECTED]` Brief shows "No captures in the last 7 days" or similar graceful state
> Pass condition: No crash; clear empty state message

---

## 20. Web UI — Settings `[AUTO — Chrome/brain.k4jda.net]`

### TC-W-080 — Settings page loads

> Navigate to Settings page
> `[EXPECTED]` Page renders with multiple sections visible
> Pass condition: No blank page; sections load

### TC-W-081 — Skills list loads

> On Settings page, find the Skills section
> `[EXPECTED]` At least "weekly-brief" listed with: schedule, last run timestamp, last run status
> Pass condition: Skills appear; data matches what's in DB

### TC-W-082 — Trigger skill manually from Settings

> Click "Run Now" on weekly-brief
> `[EXPECTED]`
> - Loading state
> - Success confirmation with job_id
> - Last run timestamp updates after completion
> Pass condition: POST /skills/weekly-brief/trigger returns 202; skill runs

### TC-W-083 — Triggers list loads

> On Settings page, find the Triggers section
> `[EXPECTED]` All triggers listed with: name, query text, status (active/inactive)
> Pass condition: Trigger from TC-S-060 appears

### TC-W-084 — Create trigger from Settings UI

> Click "Add Trigger"
> `[INPUT]` Name: `QSR contract updates`, Query: `quick service restaurant contract deal signed`
> Submit
> `[EXPECTED]` New trigger appears in list
> Pass condition: POST /triggers returns 201; trigger in list with "active" status

### TC-W-085 — Toggle trigger on/off

> Click the active/inactive toggle on a trigger
> `[EXPECTED]` Status flips (active ↔ inactive); PATCH /triggers/:id called
> Pass condition: Toggle reflects immediately; DB state updated

### TC-W-086 — Delete trigger from Settings UI

> Click delete (X or trash) on a trigger
> `[EXPECTED]` Confirmation prompt (if any), then trigger removed from list
> Pass condition: DELETE /triggers/:id succeeds; trigger gone from list

### TC-W-087 — Pipeline health panel

> On Settings page, find the Pipeline Health section
> `[EXPECTED]` Queue stats displayed: capture-pipeline, skill-execution, etc. with waiting/active/completed/failed counts
> Pass condition: All 5 queues shown; failed count is 0 or matches reality

### TC-W-088 — Danger Zone — section visible

> Scroll to bottom of Settings page
> `[EXPECTED]` Red-bordered "Danger Zone" section visible with "Wipe All Data" button
> Pass condition: Section rendered; button present

### TC-W-089 — Danger Zone — modal opens correctly

> Click "Wipe All Data"
> `[EXPECTED]`
> - Modal overlay appears
> - List of what will be deleted shown
> - List of what is preserved shown
> - Text input for confirmation phrase
> Pass condition: Modal renders completely; no JS errors

### TC-W-090 — Danger Zone — confirm button disabled until phrase typed

> With modal open, try clicking "Confirm Wipe" without typing anything
> `[EXPECTED]` Button is disabled (grayed out, not clickable)
> Pass condition: No API call made; button visually disabled

### TC-W-091 — Danger Zone — wrong phrase keeps button disabled

> `[INPUT]` Type: `wipe all data` (lowercase)
> `[EXPECTED]` Button remains disabled — exact case match required (`WIPE ALL DATA`)
> Pass condition: Button stays disabled

### TC-W-092 — Danger Zone — correct phrase enables button

> `[INPUT]` Type: `WIPE ALL DATA` (exact)
> `[EXPECTED]` Confirm button becomes enabled (red, clickable)
> Pass condition: Button activates on exact match

### TC-W-093 — Danger Zone — Escape key closes modal

> With modal open, press Escape
> `[EXPECTED]` Modal closes; no wipe performed
> Pass condition: Modal dismissed; data intact

### TC-W-094 — Danger Zone — Cancel button works

> With modal open, click Cancel
> `[EXPECTED]` Modal closes; no wipe performed
> Pass condition: Same as TC-W-093

### TC-W-095 — Danger Zone — successful wipe

> With modal open, type `WIPE ALL DATA`, click "Confirm Wipe"
> `[EXPECTED]`
> - Loading state ("Wiping...")
> - Modal closes automatically on success
> - Success message appears: "Wiped N tables. The brain is empty — ready for real data."
> - Dashboard stats reset to 0
> Pass condition: POST /admin/reset-data returns 200; all user data cleared; triggers preserved

### TC-W-096 — Danger Zone — data cleared, triggers preserved

> After TC-W-095, navigate to Settings → Triggers
> `[EXPECTED]` Triggers still listed (preserved across wipe)
> Pass condition: Trigger count unchanged from before wipe

---

## 21. End-to-End Cross-System Flows `[AUTO — Chrome/Slack web + brain.k4jda.net]`

These tests verify that Slack-created data appears correctly in the Web UI and vice versa.

### TC-E2E-001 — Slack capture → Web UI Dashboard

1. Send a capture via Slack: `Just closed the Stratfield Q1 retainer — major win`
2. Wait for bot confirmation (~10 seconds)
3. Open Web UI Dashboard
> `[EXPECTED]` New capture appears in Recent Captures section; total count incremented
> Pass condition: Capture visible in both systems within 30 seconds

### TC-E2E-002 — Slack capture → Web Search

1. Send via Slack: `Evaluating LangGraph vs custom orchestration for the agentic workflow layer`
2. Wait for confirmation
3. Open Web UI Search, search for `LangGraph`
> `[EXPECTED]` Capture appears in search results
> Pass condition: Capture retrievable via semantic search

### TC-E2E-003 — Web capture → Slack query

1. Create a capture via Web UI Dashboard form: `Deployed the new vector search index — reduced query latency by 40%`
2. In Slack, ask: `What performance improvements have I made recently?`
> `[EXPECTED]` Bot's answer references the web-created capture
> Pass condition: Cross-source retrieval works; source shown as "api" not "slack"

### TC-E2E-004 — Slack !brief → Web Briefs page

1. Trigger `!brief` in Slack and wait for completion
2. Open Web UI Briefs page
> `[EXPECTED]` Same brief content visible on Briefs page; structured sections rendered
> Pass condition: result JSONB populated; Briefs UI renders sections not just raw text

### TC-E2E-005 — Entity extraction pipeline → Web Entities page

1. Send capture: `Met with Sarah Chen from Accenture about their AI transformation practice`
2. Wait 30–60 seconds for pipeline to run entity extraction
3. Open Web UI Entities page
> `[EXPECTED]` "Sarah Chen" (person) and "Accenture" (organization) appear in entity list
> Pass condition: NER pipeline ran; entities linked to capture

### TC-E2E-006 — Slack trigger → Web trigger management

1. Create trigger in Slack: `!trigger add "enterprise AI contract"`
2. Open Web UI Settings → Triggers
> `[EXPECTED]` New trigger visible in web UI with correct query text
> Pass condition: Trigger created in Slack visible and manageable from web

### TC-E2E-007 — Web trigger → fires in Slack

1. Create trigger in Web UI: Name "M&A activity", Query text "merger acquisition investment deal"
2. In Slack, send: `Interesting news — a private equity firm is looking at acquiring one of our major QSR clients`
> `[EXPECTED]` Trigger fires within ~60 seconds; Slack notification sent to channel
> Pass condition: Trigger notification appears in Slack with capture preview

### TC-E2E-008 — Bet created in Slack, resolved in Web UI

1. Create in Slack: `!bet add 0.7 Homeserver memory upgrade completed by April 15 2026`
2. Open Web UI Board → Bets section
3. Find the bet and click "Won"
> `[EXPECTED]` Bet status updates in Web UI; reflection capture created
> Pass condition: Cross-system round-trip complete

---

## 22. Pass/Fail Summary Checklist

Use this checklist to record final pass/fail status after testing.

**Automation coverage**: ~90% automated (Chrome/Slack web + Chrome/brain.k4jda.net + SSH).
Manual-only cases: TC-S audio upload, TC-S-105 (LiteLLM down), TC-W-012 amber/red state.

### Slack Bot

| Test | Mode | Description | P/F | Notes |
|------|------|-------------|-----|-------|
| TC-S-001 | AUTO | CAPTURE intent | | |
| TC-S-002 | AUTO | QUERY intent | | |
| TC-S-003 | AUTO | COMMAND intent | | |
| TC-S-004 | AUTO | CONVERSATION intent | | |
| TC-S-005 | AUTO | @mention → QUERY | | |
| TC-S-006 | AUTO | @mention + ! command | | |
| TC-S-010 | AUTO | Text capture + auto-classification | | |
| TC-S-011 | AUTO | Capture polling completes | | |
| TC-S-audio | MANUAL | Voice/audio file upload | | |
| TC-S-020 | AUTO | Query with results | | |
| TC-S-021 | AUTO | Query with no results | | |
| TC-S-022 | AUTO | Thread follow-up query | | |
| TC-S-030 | AUTO | !stats | | |
| TC-S-031 | AUTO | !recent default | | |
| TC-S-040 | AUTO | !brief generate | | |
| TC-S-042 | AUTO | !brief last | | |
| TC-S-050 | AUTO | !entities list | | |
| TC-S-051 | AUTO | !entity detail | | |
| TC-S-053 | AUTO | !entity merge | | |
| TC-S-060 | AUTO | !trigger add | | |
| TC-S-062 | AUTO | !trigger test | | |
| TC-S-063 | AUTO | Trigger fires on match | | |
| TC-S-070 | AUTO | !board quick start | | |
| TC-S-071 | AUTO | Multi-turn session | | |
| TC-S-072 | AUTO | !board pause | | |
| TC-S-074 | AUTO | !board resume | | |
| TC-S-075 | AUTO | !board done | | |
| TC-S-080 | AUTO | !bet add | | |
| TC-S-082 | AUTO | !bet list filter | | |
| TC-S-084 | AUTO | !bet resolve | | |
| TC-S-090 | AUTO | !pipeline status | | |
| TC-S-100 | AUTO | Unknown command | | |
| TC-S-105 | MANUAL | LiteLLM unavailable simulation | | |

### Web UI

| Test | Mode | Description | P/F | Notes |
|------|------|-------------|-----|-------|
| TC-W-010 | AUTO | Dashboard loads | | |
| TC-W-011 | AUTO | Stats cards accurate | | |
| TC-W-013 | AUTO | Quick capture form | | |
| TC-W-020 | AUTO | Search returns results | | |
| TC-W-022 | AUTO | Result card detail modal | | |
| TC-W-023 | AUTO | Brain view filter | | |
| TC-W-026 | AUTO | Multiple filters combined | | |
| TC-W-040 | AUTO | Timeline loads | | |
| TC-W-050 | AUTO | Entity list loads | | |
| TC-W-052 | AUTO | Entity detail | | |
| TC-W-054 | AUTO | Entity merge | | |
| TC-W-060 | AUTO | Board page loads | | |
| TC-W-061 | AUTO | Start governance session | | |
| TC-W-062 | AUTO | Multi-turn session | | |
| TC-W-065 | AUTO | Create bet | | |
| TC-W-066 | AUTO | Resolve bet | | |
| TC-W-070 | AUTO | Briefs page loads | | |
| TC-W-071 | AUTO | Trigger brief from UI | | |
| TC-W-072 | AUTO | Brief structured sections | | |
| TC-W-080 | AUTO | Settings loads | | |
| TC-W-083 | AUTO | Triggers list | | |
| TC-W-012 | AUTO/MANUAL | Pipeline health banner (green=AUTO, amber/red=MANUAL) | | |
| TC-W-087 | AUTO | Pipeline health panel | | |
| TC-W-089 | AUTO | Danger Zone modal | | |
| TC-W-091 | AUTO | Wrong phrase blocked | | |
| TC-W-092 | AUTO | Correct phrase enables | | |
| TC-W-095 | AUTO | Successful wipe | | |
| TC-W-096 | AUTO | Triggers preserved after wipe | | |

### End-to-End

| Test | Mode | Description | P/F | Notes |
|------|------|-------------|-----|-------|
| TC-E2E-001 | AUTO | Slack capture → Web Dashboard | | |
| TC-E2E-002 | AUTO | Slack capture → Web Search | | |
| TC-E2E-003 | AUTO | Web capture → Slack query | | |
| TC-E2E-004 | AUTO | !brief → Web Briefs page | | |
| TC-E2E-005 | AUTO | Entity extraction → Web Entities | | |
| TC-E2E-006 | AUTO | Slack trigger → Web UI | | |
| TC-E2E-008 | AUTO | Bet cross-system round-trip | | |

---

## Appendix A — Test Environment Verification Commands

```bash
# Container health
ssh root@homeserver.k4jda.net "docker compose -f /mnt/user/appdata/open-brain/docker-compose.yml ps"

# Core API health
curl -s https://brain.k4jda.net/api/v1/captures?limit=1 | jq .

# Direct internal health
ssh root@homeserver.k4jda.net "curl -s http://127.0.0.1:3002/health | jq ."

# Capture count
ssh root@homeserver.k4jda.net "docker exec open-brain-postgres psql -U openbrain openbrain -c 'SELECT COUNT(*) FROM captures;'"

# Check skills_log result column exists
ssh root@homeserver.k4jda.net "docker exec open-brain-postgres psql -U openbrain openbrain -c '\d skills_log'"
```

## Appendix C — Automation Execution Notes

### How automated Slack tests work

Claude uses Chrome browser automation (mcp__claude-in-chrome tools) to control the Slack web app:

1. Navigate to the Slack workspace URL and locate the bot channel
2. Use `form_input` / `find` to type messages into the message composer
3. Send via keyboard shortcut (Enter)
4. Use `read_page` / `get_page_text` to poll for the bot's reply (with retries)
5. For thread replies: click the thread, send reply, read response in thread view
6. For LLM-backed commands (!brief, !board, governance sessions): poll up to 90 seconds for response

### How automated Web UI tests work

Claude uses Chrome browser automation to control `https://brain.k4jda.net`:

1. Navigate to each page
2. Read page content and verify expected elements present
3. Fill forms, click buttons, select options
4. Use `read_network_requests` to verify API calls succeed and return expected status codes
5. Use `javascript_tool` for edge cases (e.g., verifying a button's disabled state, checking exact text match)
6. For async operations (brief generation, LLM sessions): poll `read_page` up to 90 seconds

### Timing assumptions

| Operation | Max wait |
|-----------|----------|
| Capture confirmation in Slack | 20 seconds |
| Pipeline metadata enrichment | 45 seconds |
| LLM synthesis (query/synthesize) | 60 seconds |
| !brief generation | 90 seconds |
| Governance session response | 60 seconds per turn |
| Entity extraction after capture | 45 seconds |

If any operation exceeds its max wait, the test is marked FAIL with a timeout note.

### Verification strategy

For each test, automated verification uses one or more of:
- **Text presence**: `read_page` output contains expected string
- **HTTP status**: `read_network_requests` confirms 200/201/204
- **DB state**: `ssh` → `docker exec postgres psql` query for ground truth
- **Element state**: `javascript_tool` to check disabled/enabled/visible attributes

### Slack connection details

| Field | Value |
|-------|-------|
| **Slack URL** | `https://app.slack.com/client/T0AHPBS3WJK/C0AJ2P8R31C` |
| **Channel** | `#open-brain` |
| **Bot @mention** | `@Open Brain` |

---

## Appendix B — Known Limitations to Note During Testing

- **Brief requires captures**: weekly-brief skips generation if 0 captures in the 7-day window — this is correct behavior, not a bug
- **Entity extraction latency**: NER runs asynchronously in the pipeline; entities may not appear until 10–30 seconds after capture
- **LLM synthesis latency**: `!brief`, governance sessions, and `!brain ask` queries may take 10–30 seconds — this is expected
- **Trigger cooldown**: Triggers have a default cooldown period; the same trigger won't fire twice within that window on the same content
- **Voice capture**: Requires iOS Shortcut setup — web audio recording may not be implemented; test only if Shortcut is configured
