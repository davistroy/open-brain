# Implementation Plan: OpenClaw ↔ Open Brain Integration

**Created:** 2026-04-07
**Status:** Phases 1-2 Complete, Phase 3 (user validation) in progress
**Scope:** Connect OpenClaw (bond.k4jda.net) to Open Brain (homeserver) via MCP, enabling bidirectional knowledge flow — OpenClaw queries Open Brain's knowledge base and captures insights back.

---

## Context

Open Brain is a self-hosted personal knowledge infrastructure that ingests from voice memos, Slack, documents, and email, storing captures in Postgres+pgvector with semantic search, entity extraction, and AI synthesis.

OpenClaw is an open-source personal AI assistant running on bond.k4jda.net as a systemd service (v2026.4.5). It connects to Telegram and Slack for conversational AI, with an extensible skill system.

Both systems speak MCP natively:
- **Open Brain** exposes 7 MCP tools + 1 resource at `/mcp` (Streamable HTTP, Bearer auth)
- **OpenClaw** has native MCP client support with streamable-http transport

### What Already Exists

| Component | Status | Detail |
|-----------|--------|--------|
| Open Brain MCP server | Running | 7 tools including `capture_thought`, `/mcp` route on port 3002 |
| OpenClaw MCP config | Configured | `open_brain` server entry in `openclaw.json` pointing to `100.101.61.122:3002/mcp` |
| MCP Bearer token | Matched | `OPENCLAW_OPEN_BRAIN_TOKEN` on bond = `MCP_API_KEY` on homeserver (via Bitwarden) |
| Network connectivity | Working | Tailscale IP returns 200, MagicDNS (`homeserver`) also works |
| OpenClaw skill | Missing | No skill teaches the agent when/how to use Open Brain tools |

### Architecture

```
┌─────────────────────────────┐       MCP (Streamable HTTP)       ┌──────────────────────────┐
│       OpenClaw              │ ─────────────────────────────────  │      Open Brain          │
│   bond.k4jda.net            │       Bearer token auth            │  homeserver:3002         │
│                             │                                    │                          │
│  ┌─────────────────────┐    │   search_brain ────────────────    │  7 MCP tools             │
│  │  open-brain skill   │────│─▶ list_captures                    │  1 MCP resource          │
│  │  (SKILL.md)         │    │   brain_stats                      │                          │
│  └─────────────────────┘    │   capture_thought ◀── writes ──    │  Postgres + pgvector     │
│                             │   get_entity                       │                          │
│  Telegram / Slack           │   list_entities                    │  Pipeline (BullMQ)       │
│                             │   get_weekly_brief                 │                          │
│                             │   open_brain://context (resource)  │                          │
└─────────────────────────────┘                                    └──────────────────────────┘
```

## Design Summary

**No code changes to Open Brain.** The integration is purely:
1. An OpenClaw skill file that teaches the agent when to query/capture
2. Verification that the existing MCP config and token work end-to-end

### Available MCP Tools (Open Brain → OpenClaw)

| Tool | Purpose | Direction |
|------|---------|-----------|
| `search_brain` | Semantic + FTS hybrid search across captures | Query |
| `list_captures` | Browse recent captures with filters | Query |
| `brain_stats` | Knowledge base statistics by period | Query |
| `capture_thought` | Create new captures with type/tags/view | Capture |
| `get_entity` | Look up person/org/project by name or ID | Query |
| `list_entities` | Browse entities sorted by mentions or recency | Query |
| `get_weekly_brief` | Retrieve weekly summaries | Query |
| `open_brain://context` | Real-time focus areas, key entities, open questions | Resource |

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| MCP connection fails (token/network) | Low | Low | Token verified matching; Tailscale connectivity confirmed; OpenClaw works fine without the tools |
| Agent over-captures (noise in Open Brain) | Medium | Low | Skill explicitly lists when NOT to capture; captures are soft-deletable |
| Agent fails to use tools when relevant | Medium | Low | Iterative skill refinement based on usage; skill wording follows proven ontology skill pattern |
| Rate limiting on Open Brain | None | — | MCP route bypasses rate limiter entirely |
| CORS blocking | None | — | Server-to-server; CORS only applies to browser requests |

**Rollback:** Delete the skill directory. OpenClaw continues to work without Open Brain tools. No state changes, no migrations, no container restarts needed on the Open Brain side.

## Scope Boundaries

**In scope:**
- OpenClaw skill creation (`open-brain/SKILL.md`)
- MCP connectivity verification
- End-to-end validation (search + capture)

**Out of scope:**
- Code changes to Open Brain (none needed)
- Paperclip orchestration setup (separate effort)
- Voice input routing changes (intentionally excluded)
- Custom OpenClaw plugin (skill is sufficient)
- Distinguishing MCP capture origins (all show as `source: mcp`)
- OpenClaw config changes (already configured correctly)

---

## Phase 1: Skill Creation & Deployment

**Goal:** Create the Open Brain skill on bond and verify it loads.

### 1.1 Create Open Brain skill directory and SKILL.md

**Target:** `davistroy@bond:~/.openclaw/workspace/skills/open-brain/SKILL.md`

**Skill content:**

```markdown
---
name: open-brain
description: Query and capture to Troy's personal Open Brain knowledge base. Use when the user asks about past decisions, ideas, notes, entities, or weekly summaries. Capture decisions, insights, tasks, and wins from conversations.
---

# Open Brain — Personal Knowledge Base

You have access to Troy's Open Brain knowledge management system via MCP tools. It contains captured thoughts, decisions, ideas, observations, tasks, and more — organized by brain view (career, personal, technical, work-internal, client) with entity extraction and semantic search.

## When to QUERY Open Brain

Use these tools when the conversation would benefit from Troy's captured knowledge:

| Trigger | Tool | Example |
|---------|------|---------|
| Past decisions or context | `search_brain` | "What did I decide about the auth rewrite?" |
| Recent activity or captures | `list_captures` | "What have I captured this week?" |
| People, projects, organizations | `get_entity` / `list_entities` | "What do I know about Project X?" |
| Weekly summary | `get_weekly_brief` | "Give me my weekly brief" |
| Knowledge base overview | `brain_stats` | "How many captures do I have?" |
| Current focus areas | `open_brain://context` resource | Before making contextual recommendations |

**Search tips:**
- Use natural language queries with `search_brain` — it does semantic + full-text hybrid search
- Filter by `brain_view` (career, personal, technical, work-internal, client) when the domain is clear
- Filter by `source` (slack, voice, api, email, mcp) when relevant
- Use `days` parameter to scope to recent captures

## When to CAPTURE to Open Brain

Use `capture_thought` when the conversation produces something worth remembering:

| What to capture | capture_type | Example |
|----------------|--------------|---------|
| A clear decision | `decision` | "I've decided to use OAuth2 PKCE" |
| An insight or idea | `idea` | "What if we combined X with Y?" |
| Something noticed | `observation` | "The latency spikes correlate with batch jobs" |
| An action item | `task` | "I need to review the Q2 budget" |
| An achievement | `win` | "Successfully migrated 500 users" |
| A problem identified | `blocker` | "Can't proceed until the API rate limit is raised" |
| An open question | `question` | "How does the new pricing affect margins?" |
| A personal reflection | `reflection` | "This approach worked better than expected" |

**Capture tips:**
- Set `brain_view` based on domain: career, personal, technical, work-internal, client
- Add relevant `tags` as an array of strings
- Write the content as a clear, self-contained thought — it will be embedded and entity-extracted automatically
- Don't duplicate — search first if unsure whether something was already captured

## When NOT to capture

- Routine conversation, greetings, small talk
- Raw output (logs, code dumps, command results) — capture the insight, not the data
- Things already in Open Brain (search first)
- Trivial or ephemeral information
- Unless Troy explicitly says "remember this", "save this", or "capture this"
```

**Verification:** Start a new OpenClaw session. The skill should appear in the agent's available skills list.

### 1.2 Restart OpenClaw gateway (or start new session)

OpenClaw loads skills at session start. Either:
- Start a new session via `/new` in Telegram/Slack
- Or restart the gateway: `systemctl --user restart openclaw-gateway` (as davistroy)

**Verification:** Confirm the skill appears by asking OpenClaw "what skills do you have?" or checking the session skill list.

---

## Phase 2: Connectivity Verification

**Goal:** Confirm MCP tools are callable end-to-end.

### 2.1 Test MCP connection directly

From bond, test the MCP endpoint with a raw curl:

```bash
curl -X POST http://100.101.61.122:3002/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

**Expected:** 200 response with list of 7 tools.

### 2.2 Test search tool via MCP

```bash
curl -X POST http://100.101.61.122:3002/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"brain_stats","arguments":{"period":"week"}}}'
```

**Expected:** 200 response with capture statistics.

### 2.3 Test capture tool via MCP

```bash
curl -X POST http://100.101.61.122:3002/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'Authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"capture_thought","arguments":{"content":"Integration test: OpenClaw MCP connection verified","capture_type":"observation","tags":["integration-test","openclaw"],"brain_view":"technical"}}}'
```

**Expected:** 200 response with capture ID and `pipeline_status: pending`.

**Cleanup:** Delete the test capture via Open Brain dashboard or API after verification.

---

## Phase 3: End-to-End Validation

**Goal:** Verify the full flow through OpenClaw's conversational interface.

### 3.1 Test knowledge query via Telegram/Slack

Send a message to OpenClaw that should trigger an Open Brain search:

> "What have I captured recently about pipeline health?"

**Expected:** OpenClaw calls `search_brain` or `list_captures` and returns relevant results from Open Brain.

### 3.2 Test capture-back via Telegram/Slack

Tell OpenClaw something worth capturing:

> "I've decided to integrate OpenClaw with Open Brain via MCP for bidirectional knowledge flow. Remember this decision."

**Expected:** OpenClaw calls `capture_thought` with `capture_type: decision` and confirms the capture. Verify it appears in Open Brain's dashboard at brain.troy-davis.com.

### 3.3 Test weekly brief retrieval

> "Show me my latest weekly brief"

**Expected:** OpenClaw calls `get_weekly_brief` and presents the summary.

### 3.4 Test context resource

> "What are my current focus areas?"

**Expected:** OpenClaw reads `open_brain://context` resource and summarizes active focus areas, key entities, and open questions.

---

## Verification Checklist

- [ ] Skill file exists at `~/.openclaw/workspace/skills/open-brain/SKILL.md`
- [ ] OpenClaw gateway restarted or new session started
- [ ] Skill appears in agent's available skills
- [ ] `tools/list` MCP call returns 7 tools (Phase 2.1)
- [ ] `brain_stats` returns valid statistics (Phase 2.2)
- [ ] `capture_thought` creates a capture successfully (Phase 2.3)
- [ ] Conversational search returns Open Brain results (Phase 3.1)
- [ ] Conversational capture creates an Open Brain entry (Phase 3.2)
- [ ] Weekly brief retrieval works (Phase 3.3)
- [ ] Context resource provides focus areas (Phase 3.4)

## Follow-Up Recommendations (Out of Scope)

1. **Monitor capture quality** — Are OpenClaw-originated captures getting good entity extraction and brain view classification?
2. **Distinguish MCP origins** — Consider adding `source_metadata.origin: "openclaw"` to `capture_thought` tool to differentiate from other MCP clients
3. **Skill refinement** — After 1-2 weeks of usage, review when the agent uses/doesn't use the tools and adjust skill wording
4. **Paperclip integration** — When Paperclip is set up, it could orchestrate multi-agent workflows that leverage Open Brain as shared knowledge
