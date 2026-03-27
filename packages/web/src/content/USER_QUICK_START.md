# Open Brain — Quick Start Guide

Get up and running with Open Brain in 5 minutes. This guide assumes your system is fully deployed and running.

---

## Access Points

| Interface | URL | What It's For |
|-----------|-----|---------------|
| **Web Dashboard** | `https://brain.troy-davis.com` | Browse, search, and manage your brain |
| **Slack Bot** | Any channel with the bot installed | Capture thoughts, search, run commands |
| **Voice (iPhone/Watch)** | iOS Shortcut → `http://<tailscale-ip>:3001` | Hands-free voice memos |
| **MCP (AI Assistant)** | `https://llm.troy-davis.com/mcp` | Let Claude query your brain directly |

---

## 1. Capture a Thought

### From the Web Dashboard
1. Go to the **Dashboard** page
2. Type your thought in the quick capture box
3. Press Enter — done. It's automatically classified and processed.

### From Slack
Just type a message in any channel with the bot:
```
Had a great call with NovaBurger — they're ready to sign the retainer at $8K/month
```
The bot captures it, classifies it (e.g., "win"), and confirms in a thread reply.

### From Your iPhone/Watch
1. Tap your **Brain Voice Memo** shortcut (or Watch complication)
2. Speak your thought
3. Tap stop — audio is transcribed and captured automatically
4. You'll get a Pushover notification with the result

---

## 2. Search Your Brain

### Web Dashboard
1. Go to the **Search** page
2. Type a natural language query: `what decisions have I made about pricing?`
3. Results appear in real time with relevance scores
4. Click any result to see full details, entities, and pipeline history

### Slack
Prefix your query with `?`:
```
? what did I decide about the QSR timeline
```
Results appear in a thread. Reply `more` for the next page, or a number to see full details.

### MCP (via Claude)
Ask Claude: *"Search my brain for thoughts about hiring"* — it calls the `search_brain` tool automatically.

---

## 3. Run a Weekly Brief

Your weekly brief runs automatically every **Sunday at 8 PM**. To run one manually:

- **Web**: Go to **Briefs** → click **Run Now**
- **Slack**: Type `!brief`

The brief summarizes your week: wins, blockers, risks, open loops, and what to focus on next.

---

## 4. Start a Governance Session

A structured conversation with an AI "board of directors" that keeps you honest about priorities.

- **Web**: Go to **Board** → click **Start Quick Check**
- **Slack**: Type `!board quick`

Answer the board's questions across 5 areas (priorities, decisions, bets, energy, outlook). When done, you get an assessment and an auto-generated bet to track.

---

## 5. Track Bets & Predictions

Record falsifiable predictions to calibrate your judgment over time.

- **Web**: Go to **Board** → scroll to **Bets** section → click **Add Bet**
- **Slack**: `!bet add 0.8 "QSR deal closes by end of Q2"`

Resolve them later: `!bet resolve <id> correct "Confirmed in Q2 report"`

---

## 6. Explore Entities

Open Brain automatically extracts people, organizations, projects, and concepts from your captures.

- **Web**: Go to **Entities** to browse, search, and see co-occurrence relationships
- **Slack**: `!entity Alice Smith` to see all captures mentioning someone

---

## 7. Set Up Semantic Triggers

Get alerted when new captures match a topic you care about:

- **Web**: Go to **Settings** → **Semantic Triggers** → **Add Trigger**
- **Slack**: `!trigger add "client risk mentions"`

When a future capture matches your trigger query, you'll get a Pushover notification.

---

## 8. Upload Documents

Ingest PDFs, Word docs, or text files into your brain:

- **Web**: Go to **Voice** page (supports audio and document upload)
- **API**: `POST /api/v1/documents` with the file as multipart/form-data

---

## Slack Command Cheat Sheet

| Command | What It Does |
|---------|-------------|
| `? <query>` | Search your brain |
| `!stats` | Brain statistics |
| `!recent 10` | Last 10 captures |
| `!brief` | Generate weekly brief |
| `!brief last` | Show latest brief |
| `!board quick` | Start governance session |
| `!board done` | End governance session |
| `!entities` | List known entities |
| `!entity <name>` | Entity detail |
| `!bet add <conf> <statement>` | Create a bet |
| `!bet list` | List all bets |
| `!connections` | Cross-domain analysis |
| `!drift` | Drift monitoring |
| `!trigger add "<query>"` | Create semantic trigger |
| `!trigger list` | List triggers |
| `!pipeline status` | Pipeline queue health |
| `!help` | Show all commands |

---

## Brain Views

Every capture is categorized into one of five views:

| View | Color | Purpose |
|------|-------|---------|
| **career** | Blue | Professional development |
| **personal** | Green | Personal life & hobbies |
| **technical** | Purple | Technical learning & architecture |
| **work-internal** | Orange | Internal work items |
| **client** | Red | Client-facing work |

Views are auto-classified from content, or you can set them manually.

---

## Capture Types

Eight types, auto-detected from your content:

`decision` · `idea` · `observation` · `task` · `win` · `blocker` · `question` · `reflection`

---

## What Happens After You Capture

Every capture goes through an async pipeline:

1. **Classify** — AI determines capture type and brain view
2. **Embed** — Creates a 768-dim vector for semantic search
3. **Extract** — Pulls out entities, topics, and tags
4. **Link Entities** — Connects to known people, orgs, and projects
5. **Check Triggers** — Fires any matching semantic triggers
6. **Notify** — Sends Pushover notification if configured

This typically completes in 30–90 seconds.

---

## Troubleshooting

| Problem | Quick Fix |
|---------|-----------|
| Can't connect to voice capture | Make sure Tailscale is active on your iPhone |
| Slack bot not responding | Check `docker compose ps` — slack-bot should be running |
| Search returns no results | Captures need 30–90s for embedding; wait and retry |
| Brief is empty | Need at least a few captures in the past 7 days |
| Pipeline stuck | Go to Settings → check pipeline health, or `!pipeline status` |

For the complete reference, see the [Detailed User Guide](./USER_GUIDE.md).
