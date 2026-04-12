# Product Requirements Document (PRD) - Unified
# Open Brain - Personal Knowledge Operating System

**Version**: 1.1 Unified
**Author**: Troy Davis / Stratfield Consulting / Claude
**Date**: 2026-04-11
**Status**: All conflicts resolved -- unified from openbrain-prd.docx (doc1), PRD-PHASE7.md (doc2), and PRD-V2.md (doc3). 52 questions answered, 13 NEEDS CLARIFICATION tags resolved.
**Repository**: https://github.com/davistroy/open-brain

---

## Source Document Key

Throughout this document, requirements and sections are tagged with their origin:

| Tag | Source |
|-----|--------|
| **(doc1)** | `openbrain-prd.docx` - "Personal Knowledge Operating System" - the OneDrive file migration and three-layer knowledge architecture vision |
| **(doc2)** | `PRD-PHASE7.md` - "Proactive Intelligence & Multi-Model Routing" - multi-tier model routing, autonomy levels, Slack auto-response |
| **(doc3)** | `PRD-V2.md` - "Open Brain v2 Architecture Expansion" - Pipecat voice, wiki layer, pipeline modernization, dual-client routing, email outbound, infrastructure skills |
| **(existing)** | Currently deployed and running in production (v1.5.0+) |
| **[RESOLVED]** | Previously flagged conflict or ambiguity, now resolved with a decision (see answers-PRD-UNIFIED-20260411.json) |

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Problem Statement](#2-problem-statement)
3. [Vision and Design Principles](#3-vision-and-design-principles)
4. [System Architecture](#4-system-architecture)
5. [Knowledge Model](#5-knowledge-model)
6. [File Ingestion Pipeline](#6-file-ingestion-pipeline)
7. [Multi-Model Routing](#7-multi-model-routing)
8. [Proactive Intelligence](#8-proactive-intelligence)
9. [Wiki Operations](#9-wiki-operations)
10. [Query System](#10-query-system)
11. [Autonomy and Governance](#11-autonomy-and-governance)
12. [User Interfaces](#12-user-interfaces)
13. [Implementation Phases](#13-implementation-phases)
14. [Cost Analysis](#14-cost-analysis)
15. [Success Criteria](#15-success-criteria)
16. [Risks and Mitigations](#16-risks-and-mitigations)
17. [Open Questions](#17-open-questions)
18. [Appendix: Feature Specifications](#18-appendix-feature-specifications)
19. [Reconciliation: Conflicts and Resolutions](#19-reconciliation-conflicts-and-resolutions)

---

## 1. Executive Summary

Open Brain is a self-hosted personal knowledge operating system that combines two complementary functions:

**1. Real-Time Knowledge Capture and Retrieval** **(existing)**

A production system (v1.5.0) that ingests information from multiple sources (voice memos, Slack, email, documents, API, MCP), processes and embeds them for semantic search, and provides rich output through AI-powered skills -- weekly briefs, career governance sessions, pattern detection, proactive sweeps, and ad-hoc synthesis. Deployed on an Unraid homeserver with 10 Docker containers, Postgres 16 + pgvector, BullMQ pipeline, and cognitive memory (Hebbian learning, spreading activation, memory consolidation).

**2. Persistent Knowledge Architecture** **(doc1)**

An expansion that transforms an unstructured collection of 10,000+ OneDrive files into a persistent, compounding, and queryable knowledge base. Inspired by Andrej Karpathy's LLM Wiki pattern, it adds three complementary cognitive layers -- associative recall (vector search), structural reasoning (entity graph), and narrative understanding (LLM-maintained wiki) -- where each layer serves a distinct cognitive function.

**3. Proactive Intelligence** **(doc2, doc3)**

Multi-model tiered routing that routes each LLM task to the most cost-effective model, configurable autonomy levels that gate all proactive behaviors, Slack auto-response progression (shadow to DM to threaded replies), and infrastructure self-management skills (backups, cost analysis, health audits).

**4. Conversational Voice and Email** **(doc3)**

Real-time multi-turn voice conversations via Pipecat (replacing one-shot transcription), outbound email composition via Himalaya CLI, and a dashboard evolution from capture/search tool to mission-control interface.

**Core Value Proposition**: One persistent, AI-accessible brain that every tool you use can read from and write to. Capture once, query from anywhere, get compounding returns as context accumulates. The LLM handles all the bookkeeping -- summarizing, cross-referencing, filing, flagging contradictions -- while the human directs the analysis and asks the right questions.

**Key Success Metrics**:

| Metric | Target | Source |
|--------|--------|--------|
| Daily active capture rate | 5+ captures/day across all inputs | existing |
| Query response time | <5 seconds for semantic search | existing |
| Weekly brief generation | Automated, every Sunday | existing |
| Zero data loss | All captures persisted with processing audit trail | existing |
| System uptime | 99%+ excluding planned maintenance | existing |
| Wiki coverage | Every file in raw/ has a source summary page within 30 days | doc1 |
| Wiki cross-referencing | <5% orphan pages after initial ingestion | doc1 |
| Monthly LLM cost | <$20 soft limit (down from ~$25) | resolved |
| Voice conversation latency | <2s round-trip (STT + LLM + TTS) | doc3 |
| Autonomous operation | 7+ days without manual intervention | doc3 |

---

## 2. Problem Statement

### 2.1 File Entropy Problem **(doc1)**

Over 35 years of professional work has produced a sprawling, unorganized corpus of documents across OneDrive: presentations, proposals, technical designs, research notes, contracts, personal documents, and project artifacts. This corpus has three fundamental problems:

1. **No accumulated knowledge.** Every search starts from scratch. There is no persistent synthesis, no cross-referencing, no record of what connects to what. RAG systems re-derive context on every query -- nothing compounds.

2. **No relationship visibility.** Documents reference each other implicitly (a proposal cites a technical design, a presentation summarizes a project charter) but these connections exist only in the author's memory. There is no traversable graph of how knowledge relates.

3. **Massive duplication and entropy.** Years of iterative drafts, email attachments, and cross-platform syncing have created extensive duplication. Multiple versions of the same document exist with no clear lineage or canonical source.

### 2.2 Capture Fragmentation Problem **(existing)**

Daily thoughts, decisions, observations, and tasks are captured across multiple tools (voice memos, Slack, email) with no unified persistence or cross-referencing. Each tool is a silo. Context is lost between tools and over time.

### 2.3 Passive Knowledge Problem **(doc2, doc3)**

The existing system is reactive -- it waits for the user to ask. It does not proactively surface insights, detect forgotten commitments, or draft responses. It uses a single expensive LLM model for all tasks regardless of complexity.

---

## 3. Vision and Design Principles

### 3.1 Core Vision **(merged)**

Open Brain functions as an externalized memory system -- a personal Memex (cf. Vannevar Bush, 1945) that makes every AI interaction smarter because it has access to everything you've thought, decided, learned, and captured. The LLM handles all the bookkeeping that makes a knowledge base actually useful over time: summarizing, cross-referencing, filing, flagging contradictions, and maintaining consistency across hundreds of interlinked pages. The human directs the analysis, asks the right questions, and curates sources. The LLM does everything else.

### 3.2 Design Principles

| # | Principle | Source |
|---|-----------|--------|
| 1 | **Knowledge compounds, not re-derives.** Synthesis happens once during ingestion and is persisted. Queries hit pre-built knowledge, not raw chunks. | doc1 |
| 2 | **Capture must be frictionless.** Zero-thought input from the tools you already have open (Slack, Apple Watch, email, phone). | existing |
| 3 | **Infrastructure you own.** All data on your hardware, no SaaS dependencies for core functionality. Full data sovereignty. | doc1, existing |
| 4 | **Three cognitive modes.** Associative recall (vector search), structural reasoning (entity graph), and narrative understanding (wiki) serve different question types. | doc1 |
| 5 | **Markdown is the substrate.** All synthesized knowledge is stored as plain Markdown files with YAML frontmatter. The most portable, future-proof, and human-readable format. | doc1 |
| 6 | **LLM-maintained, human-directed.** The LLM writes and maintains the wiki. The human curates sources, directs exploration, and asks questions. | doc1 |
| 7 | **AI-agnostic.** Multi-model routing normalizes all providers behind configurable task-to-tier mappings; swap models without code changes. | doc2, existing |
| 8 | **Pipeline-first.** Every operation (ingest, process, output) flows through configurable, async pipelines. | existing |
| 9 | **Extensible by design.** New input sources, processing stages, and output skills without touching existing code. | existing |
| 10 | **The brain compounds.** Every capture makes future queries smarter; the system's own outputs feed back in. | existing |
| 11 | **Incremental and resumable.** Every operation is idempotent. The system can be paused and resumed at any point. Partial progress is always preserved. | doc1 |
| 12 | **Composable Unix-style services.** Connected by a durable message bus, with Claude as the primary reasoning engine. Every component is independently replaceable. No framework lock-in. | doc3 |

### 3.3 The Karpathy Pattern **(doc1)**

The system follows Andrej Karpathy's LLM Wiki pattern: LLMs should incrementally build and maintain a persistent wiki rather than re-derive knowledge from raw documents on every query. Open Brain extends this pattern by adding structured relationship traversal (entity graph) and fast associative recall (vector search), creating a system that can answer questions ranging from simple document retrieval to complex cross-domain synthesis.

---

## 3.5 Users and Personas **(merged)**

| User | Context | Source |
|------|---------|--------|
| Troy (primary) | Senior technology executive. Captures thoughts via Apple Watch voice memos, Slack, email. Works across Claude Code, Claude Desktop, ChatGPT. Runs structured governance processes. Values privacy and self-hosting. Technically fluent. | existing |
| Claude Code (agent) | Connects via MCP to search brain, create captures, read/write wiki, query entities during development and consulting work. | doc3 |
| Scheduled Skills (autonomous) | BullMQ job schedulers running unattended -- weekly briefs, governance sessions, memory consolidation, wiki maintenance, drift detection, reflection. | doc3 |

**Anti-Personas:**
- **Multi-user teams** -- explicitly single-user; no auth, no multi-tenancy **(existing)**
- **Non-technical users** -- setup requires Docker, Unraid, CLI **(existing)**
- **Mobile-app-first users** -- no native mobile app; mobile via Slack and PWA **(existing)**
- **Chat-interface seekers** -- the dashboard is for observing and steering, not conversing. Slack handles text; Pipecat handles voice; claude.ai with MCP handles extended reasoning. **(doc3)**

### 3.6 User Journeys **(merged)**

| Journey | Trigger | Flow | Source |
|---------|---------|------|--------|
| Voice Capture | Thought while away from computer | Apple Watch -> iOS Shortcut -> voice-capture HTTP -> faster-whisper -> pipeline -> Pushover confirmation | existing |
| Slack Capture | Thought while at computer | Type in #open-brain -> intent router -> pipeline -> thread reply confirmation | existing |
| Slack Query | Recall something | `? QSR pricing` -> hybrid search -> ranked results in thread | existing |
| Governance Session | Structured review | `@Open Brain board quick` -> LLM-driven thread -> assessment + bet | existing |
| MCP Query | Working in Claude Code | MCP `search_brain` -> semantic search -> context incorporated | existing |
| Weekly Brief | Sunday 8 PM automated | Workers -> query captures -> LLM synthesis -> email + dashboard + brain | existing |
| Proactive Sweep | Daily 8 PM automated | Workers -> query day's captures -> summary -> Pushover (if assist+) | doc2 |
| MCP Context Bootstrap | Open Claude Code session | AI reads `open-brain://context` -> immediate context-awareness | doc2 |
| Auto-Response (full progression) | Colleague asks question in Slack | Shadow log -> DM with draft -> threaded reply (progressive autonomy) | doc2 |
| Voice Conversation | Conversational query | Pipecat WebSocket -> Deepgram STT -> Claude -> Kokoro TTS -> captures | doc3 |
| OneDrive File Ingestion | New file in OneDrive | rclone sync -> staging -> content extraction -> LLM analysis -> wiki pages -> pgvector + entities | doc1 |
| Wiki Query via Claude Code | Explore knowledge base | MCP `search_wiki` -> wiki page read -> synthesis -> filed back as synthesis page | doc1 |
| Email Draft and Send | Brain composes email | LLM drafts via `runAgent` -> email_drafts table -> Pushover -> approve -> himalaya send | doc3 |

---

## 4. System Architecture

### 4.1 Current Production Architecture **(existing)**

The following is deployed and running as of v1.5.0:

- **Runtime**: TypeScript monorepo (pnpm workspaces) -- packages: shared, core-api, slack-bot, workers, voice-capture, web
- **Framework**: Hono (API), Drizzle ORM (schema-as-code), BullMQ + Redis (pipeline)
- **Database**: Postgres 16 + pgvector (pgvector/pgvector:pg16 image), vector(768) schema
- **LLM Provider**: OpenAI API (api.openai.com/v1) for ALL AI requests -- both embeddings (`text-embedding-3-large` with `dimensions: 768`) and LLM inference (`gpt-5.4` for all aliases). API key in Bitwarden.
- **Web UI**: Vite + React + Tailwind + shadcn/ui (PWA)
- **External access**: Cloudflare Tunnel at brain.troy-davis.com, MCP at /mcp route (Streamable HTTP)
- **Slack**: @slack/bolt with socketMode: true
- **Voice**: iOS Shortcut -> voice-capture HTTP -> faster-whisper -> Core API
- **Email inbound**: Cloudflare Email Worker at brain@troy-davis.com
- **Docker networking**: Single `open-brain` network, 9 containers on Unraid

**Current Container Architecture:**

| Container | Image | Purpose | Status |
|-----------|-------|---------|--------|
| open-brain-postgres | pgvector/pgvector:pg16 | Postgres 16 + pgvector | Running |
| open-brain-redis | redis:7-alpine | BullMQ backing store | Running |
| open-brain-core-api | build: target=core-api | Hono API + MCP endpoint | Running |
| open-brain-workers | build: target=workers | BullMQ pipeline + skills | Running |
| open-brain-slack-bot | build: target=slack-bot | @slack/bolt Socket Mode | Running |
| open-brain-voice-capture | build: target=voice-capture | Voice memo HTTP endpoint | Running |
| open-brain-faster-whisper | faster-whisper image | Local STT (large-v3, CPU int8) | Running |
| open-brain-web | build: target=web | Vite + React dashboard (nginx) | Running |
| open-brain-cloudflared | cloudflare/cloudflared:latest | Cloudflare Tunnel | Running |

### 4.2 Target Architecture (v2) **(doc3, merged with doc1 and doc2)**

```
+---------------------------------------------------------------+
| Layer 6: Development Agent (Claude Code via MCP)               |
+---------------------------------------------------------------+
| Layer 5: Scheduled Intelligence (BullMQ Job Schedulers)        |
|   weekly-brief | governance | consolidation | wiki-lint |      |
|   wiki-ingest | drift-detect | reflection | daily-connections  |
|   daily-sweep | memory-consolidation | infrastructure skills   |
+---------------------------------------------------------------+
| Layer 4: Memory & Knowledge                                    |
|   +----------------------+  +------------------------------+   |
|   | Open Brain (Postgres)|  | Wiki (Git/Markdown on Gitea) |   |
|   | captures, entities,  |  | synthesized knowledge,       |   |
|   | associations, search |  | cross-refs, schema, index    |   |
|   +----------------------+  +------------------------------+   |
+---------------------------------------------------------------+
| Layer 3: Intelligence Engine                                   |
|   Ollama (homeserver) -- T0 local classification               |
|   Anthropic API -- T1 Haiku, T2 Sonnet (interim: OpenAI gpt-5.4) |
|   OpenAI API -- embeddings (text-embedding-3-large)            |
|   Deepgram -- real-time STT + TTS for Pipecat voice            |
+---------------------------------------------------------------+
| Layer 2: Interface Services                                    |
|   +----------+  +----------------+  +------------------+       |
|   | Slack Bot|  | Pipecat Voice  |  | MCP Endpoint     |       |
|   | Socket   |  | STT->LLM->TTS |  | Streamable HTTP  |       |
|   | Mode     |  | Twilio optional|  |                  |       |
|   +----------+  +----------------+  +------------------+       |
|   Email Inbound: Cloudflare Email Worker (existing)            |
|   Email Outbound: Himalaya CLI -- SMTP drafts & sending        |
+---------------------------------------------------------------+
| Layer 1: Durable Message Bus (BullMQ + Redis)                  |
|   Queues: ingest | embed | extract | wiki-ingest | voice |    |
|   email-outbound | agent-task | reflection |                   |
|   wiki-maintenance | infrastructure | notifications           |
+---------------------------------------------------------------+
```

**Target Container Architecture (v2):**

| Container | Image / Build | Purpose | Status |
|-----------|---------------|---------|--------|
| open-brain-postgres | pgvector/pgvector:pg16 | Postgres 16 + pgvector | Existing |
| open-brain-redis | redis:7-alpine | BullMQ + Pipecat session state | Existing (expanded) |
| open-brain-core-api | build: target=core-api | Hono API -- all endpoints including wiki, voice sessions, system health | Existing (expanded) |
| open-brain-workers | build: target=workers | BullMQ workers -- all pipeline + wiki + email + reflection + infrastructure jobs. Himalaya CLI installed. | Existing (expanded) |
| open-brain-slack-bot | build: target=slack-bot | @slack/bolt Socket Mode | Existing |
| open-brain-voice-pipecat | build: target=voice-pipecat | Pipecat: VAD -> STT (Deepgram) -> LLM -> TTS | NEW (replaces voice-capture + faster-whisper) |
| open-brain-web | build: target=web | Vite + React + shadcn/ui dashboard (nginx, PWA) | Existing (expanded) |
| open-brain-cloudflared | cloudflare/cloudflared:latest | Cloudflare Tunnel | Existing |
| open-brain-ollama | ollama/ollama:latest | Local CPU inference (Gemma 4 12B q4_K_M) | NEW |

**Net change:** 9 containers (same as current). The `voice-capture` and `faster-whisper` containers are replaced by a single `voice-pipecat` container, and an `ollama` container is added for local CPU inference. **(doc3, resolved)**

**Local inference**: Ollama runs on the homeserver for CPU inference (classification, brain view, intent). This is already running and avoids a DGX Spark dependency for routine tasks. The DGX Spark serves as optional overflow for large batch workloads (e.g., one-time 10K file categorization) but is not always available and is not required for daily operation. **[RESOLVED: Ollama on homeserver (CPU), DGX Spark for batch overflow.]**

**External Dependencies:**

| Dependency | Location | Purpose | Required |
|-----------|----------|---------|----------|
| Gitea | `gitea.k4jda.net` | Wiki authoritative store (git-backed markdown) | Yes (wiki features) |
| Ollama | homeserver container | Local CPU inference (T0 classification tasks) | Yes (model routing) |
| DGX Spark | `spark.k4jda.net` | Batch LLM inference (Qwen 3.5 for bulk operations) | No (optional overflow) |
| Deepgram API | `api.deepgram.com` | Real-time STT for Pipecat voice | Yes (voice features) |
| OpenAI API | `api.openai.com` | Embeddings (text-embedding-3-large) | Yes |
| Anthropic API | `api.anthropic.com` | LLM inference (Haiku + Sonnet) | Yes (target state) |
| Cloudflare Email Worker | `brain@troy-davis.com` | Inbound email capture | Yes (email features) |

### 4.3 Hardware **(existing + doc1)**

**Primary Host (Unraid homeserver):**
- CPU: Intel i7-9700 (8C/8T) -- no GPU
- RAM: 128GB DDR4
- Storage: 32TB array
- Network: Cloudflare Tunnel for external access, Tailscale for internal mesh

**Secondary Host (DGX Spark):**
- GPU: GB10
- OS: Ubuntu 24.04, aarch64
- Purpose: LLM inference (vLLM), embeddings, NER
- Access: `ssh claude@spark.k4jda.net`

**Container Memory Allocations (v2 target):**

| Container | Memory Limit |
|-----------|-------------|
| open-brain-postgres | 8GB |
| open-brain-redis | 2GB |
| open-brain-core-api | 2GB |
| open-brain-workers | 4GB |
| open-brain-slack-bot | 512MB |
| open-brain-voice-pipecat | 4GB |
| open-brain-web | 256MB |
| open-brain-cloudflared | 128MB |
| open-brain-ollama | 16GB |
| **Total** | **~37GB** (of 128GB available) |

### 4.4 Data Flow **(doc3)**

```
Voice (Pipecat)            Slack              MCP / API          Email (CF Worker)
     |                       |                    |                    |
     | real-time streaming   | Socket Mode        | HTTP               | push-based
     | session in Redis      |                    |                    |
     v                       v                    v                    v
 +-------------------------------------------------------------------+
 |                    core-api (Hono)                                  |
 |  POST /api/v1/captures                                             |
 |  POST /api/v1/voice/sessions                                       |
 |  GET  /api/v1/wiki/*                                               |
 |  GET  /api/v1/system/health                                        |
 |  POST /mcp (Streamable HTTP)                                       |
 +----------------------------+--------------------------------------+
                              |
                              v
 +-------------------------------------------------------------------+
 |                    BullMQ (Redis)                                   |
 |                                                                     |
 |  Ingest Flow (parallel DAG):                                        |
 |    +-----------+                                                    |
 |    |ingest-root| (parent -- waits for children)                     |
 |    +-----+-----+                                                    |
 |      +---+---+                                                      |
 |      v       v                                                      |
 |  +------+ +-------------+                                           |
 |  |embed | |extract-      |  (run in parallel)                       |
 |  |captur| |entities      |                                          |
 |  +---+--+ +------+------+                                           |
 |      +-----+-----+                                                  |
 |            v                                                        |
 |      +-----------+                                                  |
 |      |link-entiti| (depends on both)                                |
 |      +-----+-----+                                                  |
 |            v                                                        |
 |    +-----------------+                                              |
 |    | check-triggers +|                                              |
 |    | wiki-ingest +   | (parallel post-processing)                   |
 |    | notify          |                                              |
 |    +-----------------+                                              |
 +-------------------------------------------------------------------+
                    |
          +---------+---------+
          v                   v
  +-------------+    +--------------+
  |  Postgres   |    |  Wiki (Gitea)|
  |  captures,  |    |  markdown,   |
  |  entities,  |    |  git history |
  |  assoc.     |    |              |
  +-------------+    +--------------+
```

### 4.5 Sync Topology **(doc1)**

For the OneDrive file ingestion (doc1), the sync topology is strictly one-directional:

- **OneDrive -> Homeserver (steady-state):** 15-minute rsync from local OneDrive clone (already mirrored via Docker app on homeserver) to Open Brain corpus. No rclone to OneDrive API needed -- the OneDrive Docker app handles cloud sync, rsync handles the local copy into the staging area.
- **Homeserver -> OneDrive (intentional push only):** Runs only for deliberate structural changes (e.g., post-reorganization push). Never automated.
- **Wiki never syncs to OneDrive.** Wiki and all generated knowledge live exclusively on the homeserver. OneDrive holds working files (raw layer); homeserver holds the intelligence layer (wiki, vectors, entities).

Cloud backup of the wiki layer is handled by Gitea's own git history plus optional sync to a separate OneDrive folder treated as read-only.

---

## 5. Knowledge Model

### 5.1 Three-Layer Model (Karpathy Pattern) **(doc1, adapted for existing infrastructure)**

| Layer | Purpose | Implementation | Mutability |
|-------|---------|----------------|------------|
| **Raw Sources** | Immutable source of truth. Original files from OneDrive, voice memos, Slack messages, emails, documents. | Postgres `captures` table + Unraid file share `/mnt/user/openbrain/raw/` | Read-only (LLM never modifies originals) |
| **The Wiki** | LLM-generated, interlinked Markdown pages: summaries, entity pages, concept pages, synthesis. | Gitea wiki repo at `gitea.k4jda.net/davistroy/open-brain-wiki` | LLM-owned (writes, updates, cross-references) |
| **The Schema** | Configuration document defining wiki structure, conventions, and workflows. | `WIKI_SCHEMA.md` in wiki repo root | Co-evolved by human and LLM |

**[RESOLVED: Gitea is the authoritative wiki store.** Gitea provides git-backed versioning, commit history, and API access. Obsidian is available as an optional local browser via `git clone` for power-user graph exploration over Tailscale, but is not required for any system functionality. The wiki content format (markdown + YAML frontmatter) is identical either way.**]**

### 5.2 Extended Layers **(doc1, adapted)**

| Layer | Purpose | Implementation | Query Type |
|-------|---------|----------------|------------|
| **Vector Store** | Fast semantic retrieval -- associative recall across all captures and wiki content | Postgres pgvector (existing) | "Find me things similar to X" |
| **Entity Graph** | Structural reasoning -- typed relationships between entities, projects, concepts | Postgres `entities` + `entity_links` + `entity_relationships` tables (existing). `entity_relationships` extended with `relationship_type VARCHAR(32) DEFAULT 'related_to'` for typed edges (SUPPORTS, CONTRADICTS, SUPERSEDES, etc.) | "How does X connect to Y?" |
| **Search Index** | Keyword + semantic hybrid search over captures and wiki pages | Postgres FTS GIN index + pgvector HNSW index (existing) | "Find the page about X" |

**[RESOLVED: Keep pgvector for vector search, keep Postgres entity tables for knowledge graph.** No Qdrant or Neo4j containers. pgvector is production-proven; monitor 4 signals for potential migration: query latency >200ms, index build >30min, filter degradation, RAM pressure. Revisit at 500K+ vectors. The entity graph gains typed relationship edges via a `relationship_type` column on `entity_relationships` (migration adds `VARCHAR(32) DEFAULT 'related_to'`), enabling rich relationship types without Neo4j.**]**

### 5.3 Infrastructure Mapping **(doc1, adapted)**

| Component | Host | Implementation | Notes |
|-----------|------|----------------|-------|
| File Storage (raw + wiki) | Unraid NAS | Existing array + Gitea repo | Wiki accessed via Gitea API and dashboard |
| Vector Store | Unraid (Postgres container) | pgvector extension | HNSW index, vector(768) schema |
| Entity Graph | Unraid (Postgres container) | Drizzle ORM entities/entity_links/entity_relationships | ACT-R temporal scoring, Hebbian associations |
| Embedding Generation | OpenAI API | text-embedding-3-large, dimensions: 768 | Via api.openai.com/v1. Cost ~$2-5/month, no DGX Spark dependency. |
| LLM Inference | Anthropic API (Haiku + Sonnet) / Ollama (local) / DGX Spark (batch) | See Multi-Model Routing (Section 7) | Three-tier routing |
| Claude Code | Dev workstation | CLI + MCP | Connects to brain.troy-davis.com/mcp |
| Dashboard | Unraid (web container) | Vite + React + shadcn/ui | PWA at brain.troy-davis.com |

**[RESOLVED: Keep OpenAI text-embedding-3-large for embeddings.** Cost is negligible (~$2-5/month). Switching to local models on DGX Spark would require re-embedding all captures and introduces a dependency on DGX Spark availability. DGX Spark is used for local LLM inference tasks only, not embeddings.**]**

### 5.4 Wiki Directory Structure **(doc1, doc3)**

```
open-brain-wiki/
  WIKI_SCHEMA.md            # Conventions, page templates, workflows
  index.md                  # Catalog of all pages with one-line summaries
  log.md                    # Append-only chronological record of all operations
  overview.md               # Top-level summary of the entire wiki
  wiki/
    sources/                # One summary page per ingested source file
    entities/               # Pages for people, companies, organizations
    projects/               # Pages for projects and engagements
    domains/                # Pages for knowledge domains and practice areas
    concepts/               # Pages for frameworks, methodologies, technologies
    comparisons/            # Side-by-side analyses
    synthesis/              # Cross-cutting analyses, filed query results
    operations/             # Cost reports, storage reports (infrastructure skill outputs)
    maintenance/            # Lint reports, health checks
```

Note: `dashboards/` and `graph/` directories are not needed -- those functions are covered by the React dashboard and `operations/` respectively.

### 5.5 Wiki Page Format **(doc1)**

Every wiki page uses a consistent format with YAML frontmatter for machine-readability:

```yaml
---
title: "Page Title"
type: entity|concept|source|comparison|synthesis|overview
created: 2026-04-10
updated: 2026-04-10
source_count: 3
source_captures: [uuid-1, uuid-2, uuid-3]  # Bidirectional link to Postgres captures
tags: [consulting, ai, servicenow]
related_pages: [entities/chick-fil-a.md, concepts/triz.md]
source_removed: false  # Set to true when source file is deleted from OneDrive
---
```

`source_count` serves as a confidence proxy -- no explicit confidence score. Pages with 1 source are tentative; 5+ are well-supported. `source_captures` provides bidirectional linking between wiki pages and Postgres captures (captures also track `wiki_pages` in metadata).

Body: Markdown prose with standard markdown links for cross-references (`[link text](../entities/page.md)`). No rigid template -- the LLM adapts structure to content type.

Sources section: Every claim links back to the source page(s) it was derived from, ensuring traceability to raw files.

### 5.6 Page Types **(doc1, doc3)**

| Type | Description | Example |
|------|-------------|---------|
| Entity | Page for a person, organization, project, or system | `entities/chick-fil-a-support-now.md` |
| Concept | Page for an idea, methodology, or domain concept | `concepts/ai-judgment-skills.md` |
| Source | Summary of a specific ingested document or capture cluster | `sources/2026-04-10-pipecat-architecture-research.md` |
| Comparison | Side-by-side analysis of two or more items | `comparisons/bullmq-vs-rabbitmq.md` |
| Synthesis | Cross-cutting analysis connecting multiple entities/concepts | `synthesis/contact-center-ai-transformation-thesis.md` |
| Overview | Top-level summary of the entire wiki or a major domain | `overview.md` |

### 5.7 Special Files **(doc1)**

**index.md**: A catalog of every page organized by type, each with a link, one-line summary, and tag list. The LLM reads this first when answering queries to identify relevant pages. At moderate scale (hundreds of pages) this is sufficient for navigation without embedding-based retrieval.

**log.md**: An append-only chronological record using parseable prefixes:
```
## [2026-04-11] ingest | Q3 Sales Deck.pptx
## [2026-04-11] query | Relationship between TRIZ and automation scoring
## [2026-04-11] lint | 3 orphan pages, 2 contradictions flagged
```

---

## 6. File Ingestion Pipeline

### 6.1 OneDrive File Migration **(doc1)**

Before the wiki can be built, the raw OneDrive corpus must be cleaned and organized. Content extraction runs in a separate lightweight Python container, BullMQ-triggered via core-api (same pattern as voice-pipecat). File ingestion creates captures with `source: 'file'` and rich `source_metadata` JSONB (file path, size, MIME type, modified date, hash). Single pipeline for everything -- no separate `raw_files` table.

#### 6.1.1 File Migration

- rclone sync from OneDrive to `/mnt/user/openbrain/staging/` on Unraid
- Preserves original directory structure as metadata but stages files flat for processing

#### 6.1.2 Inventory and Hashing

- SQLite database: path, filename, extension, size, modified date, MIME type
- Two-tier hashing: xxhash on first 64KB for fast grouping, SHA-256 only on size-matched candidates for confirmation
- Content extraction for text-bearing formats (docx, pdf, pptx, xlsx, txt, md, csv)

#### 6.1.3 Duplicate Detection

| Method | Description | Action |
|--------|-------------|--------|
| Exact duplicates | Group by (size, hash_partial), confirm with full hash | Auto-resolve: keep newest, log all paths. No human review needed. |
| Near-duplicates (documents) | Text extraction + difflib.SequenceMatcher, flag pairs above 0.9 similarity | LLM-assisted triage with confidence scores. Human reviews LLM recommendations. |
| Near-duplicates (images) | Perceptual hash via imagehash library | Flag for review |

HTML report generated for human review of near-duplicate clusters. Exact duplicates are resolved automatically.

#### 6.1.4 Categorization and Taxonomy **(doc1)**

- Batch LLM classification: each unique file processed with filename, type, and first 2000 chars. Returns: category, subcategory, one-line description, tags (JSON).
- Distribution analysis of categories to propose 2-3 alternative folder taxonomies
- Human selects taxonomy; Python script reorganizes files into `/mnt/user/openbrain/raw/`
- Estimated API cost: $0 for batch (Qwen 3.5 on DGX Spark)

**[RESOLVED: Qwen 3.5 on DGX Spark for one-time batch categorization (free, fast on GPU). Gemma 4 on homeserver Ollama for ongoing incremental classification.** The batch/incremental split applies consistently across all large-scale LLM operations: Qwen 3.5 on DGX Spark for bulk, Gemma 4 on Ollama for ongoing.**]**

### 6.2 Ingestion Pipeline **(doc1, adapted for BullMQ)**

The primary operation. A new source file enters the system and the LLM integrates it into the existing knowledge base. A single ingestion may touch 10-15 wiki pages.

**Ingestion Pipeline Stages (adapted for existing BullMQ infrastructure):**

| Stage | Purpose | Queue | Implementation |
|-------|---------|-------|----------------|
| 1. Content extraction | Separate Python container extracts text from source file (python-docx, pdfplumber, python-pptx, openpyxl). Text-bearing formats now + metadata-only for images. Future: multi-modal model on DGX Spark for bulk image processing. | `ingest` | BullMQ-triggered |
| 2. Dedup check | Hash comparison against captures table content_hash | `ingest` | Inline check |
| 3. LLM analysis | Summary, entity extraction, relationship identification, category/tag assignment | `extract-entities` | Existing worker |
| 4. Wiki page creation/update | Create source summary page; update entity, concept, project pages; add cross-references | `wiki-ingest` | New BullMQ queue **(doc3)** |
| 5. Vector indexing | Generate embeddings and store in pgvector | `embed-capture` | Existing worker |
| 6. Entity graph update | Create/update entities and entity_links | `link-entities` | Existing worker |
| 7. Index and log | Append to index.md and log.md | `wiki-maintenance` | New BullMQ queue |

### 6.3 File Lifecycle Operations **(doc1)**

#### 6.3.1 New File Created

A new file appears in OneDrive. The rclone sync cron detects it and pulls it to the homeserver staging area. The full ingestion pipeline fires:
1. Extract content (text, metadata, structure)
2. LLM analysis: summary, entity extraction, relationship identification, category/tag assignment
3. Wiki page creation: source summary page in `wiki/sources/`, plus updates to entity, project, concept, and domain pages. A single new file typically touches 8-12 wiki pages.
4. Vector indexing: generate embeddings via existing embed-capture worker
5. Entity graph update: create/update entities and entity_links via existing link-entities worker
6. Index and log: append to index.md and log.md

#### 6.3.2 File Revised

An existing file is updated. The pipeline detects the change via modified timestamp or hash mismatch and runs a delta ingestion:
1. Content diff: extract new content and compare against existing source summary page
2. Source summary update: the source summary page is updated (not replaced). The LLM notes what changed and when.
3. Propagate changes: if the revision changes factual claims, the LLM propagates changes to all affected wiki pages
4. Re-embed: embeddings regenerated for all updated wiki pages

**Critical design principle**: the wiki tracks the current state of knowledge, not a changelog. If v2 changes the timeline from Q3 to Q4, the project page reflects Q4 with a note that it was updated from Q3. The raw captures preserve both versions for traceability.

#### 6.3.3 File Deleted

A file is removed from OneDrive. This requires a conservative approach:

1. **Never auto-delete wiki content.** Files get deleted for many reasons that do not mean the knowledge is wrong.
2. **Flag, don't remove.** The source summary page is marked as "source removed" in its YAML frontmatter. A log entry is appended.
3. **Lint evaluates impact.** During the next lint pass, the LLM assesses whether removing this source invalidates claims in other wiki pages.
4. **Entity relationships deactivated** but not removed, preserving structural history.
5. **Human review.** Flagged pages accumulate for periodic review.

#### 6.3.4 Steady-State Workflow **(doc1)**

In daily practice: create and edit files in OneDrive as normal. The rclone cron syncs changes to the homeserver. The ingestion pipeline processes new and changed files automatically. Periodically, browse the wiki in the dashboard, ask questions that hit the wiki via Slack or MCP, and file good answers back as synthesis pages.

**The key mental model shift**: stop thinking about files and start thinking about the wiki. The files are raw material. The wiki is where knowledge lives.

---

## 7. Multi-Model Routing

### 7.1 Current State **(existing)**

All LLM calls currently route through OpenAI API (`api.openai.com/v1`) using `gpt-5.4` for all task aliases (fast, synthesis, governance, intent). Embeddings use `text-embedding-3-large` with `dimensions: 768`. Monthly cost: ~$25.

Config (`config/ai-routing.yaml`):
```yaml
litellm_url: "https://api.openai.com/v1"
models:
  fast:
    model: "claude-sonnet-4-20250514"
    client: anthropic
    cost_per_1k_input: 0
    cost_per_1k_output: 0
  synthesis:
    model: "claude-sonnet-4-20250514"
    client: anthropic
  governance:
    model: "claude-sonnet-4-20250514"
    client: anthropic
  intent:
    model: "claude-sonnet-4-20250514"
    client: anthropic
  embedding:
    model: "text-embedding-3-large"
    client: litellm
monthly_budget:
  soft_limit_usd: 30
  hard_limit_usd: 50
```

### 7.2 Three-Tier Model Hierarchy **(resolved)**

Replace the single-model routing with a three-tier hierarchy that routes each task to the most cost-effective model. No DeepSeek for now (config ready for future addition). Target: Claude models (Haiku + Sonnet). Interim: gpt-5.4 via OpenAI until Anthropic API key obtained.

| Tier | Model | Provider | Cost (input/output per M tokens) | Run Where |
|------|-------|----------|----------------------------------|-----------|
| T0 | Gemma 4 12B (q4_K_M) | Ollama | Free | Local (homeserver CPU) |
| T1 | Claude Haiku 4.5 | Anthropic API | $0.80 / $4.00 | api.anthropic.com |
| T2 | Claude Sonnet 4.6 | Anthropic API | $3.00 / $15.00 | api.anthropic.com |

**Model validation**: 50-example validation suite built from existing captures. 90% accuracy threshold required before migration to new model tier.

### 7.3 Three-Tier Model Architecture **(resolved)**

**[RESOLVED: Three-tier routing (local Ollama + Haiku + Sonnet)** with Anthropic API key, configurable in ai-routing.yaml for future tier additions. No DeepSeek for now -- $2.70/month savings not worth added provider complexity. Config is ready for future addition. Target models are Claude (Haiku + Sonnet). Interim: gpt-5.4 via OpenAI until Anthropic API key is obtained. Anthropic API key is non-blocking -- proceed on OpenAI and switch when key is available.**]**

**`runAgent()` implementation**: Provider-agnostic with adapter pattern (~130 LOC). `LLMProvider` interface with Anthropic + OpenAI adapters. Future-proof for local/alternative providers.

**Fallback logging**: Log fallback events to `ai_audit_log`, aggregate in heartbeat report. No per-event alerts.

| Tier | Model | Provider | Cost | Run Where |
|------|-------|----------|------|-----------|
| T0 (local) | Gemma 4 12B (q4_K_M) | Ollama | Free | Homeserver (CPU) |
| T1 (fast) | Claude Haiku 4.5 | Anthropic API | $0.80 / $4.00 per M tokens | api.anthropic.com |
| T2 (quality) | Claude Sonnet 4.6 | Anthropic API | $3.00 / $15.00 per M tokens | api.anthropic.com |
| Embedding | text-embedding-3-large | OpenAI API | ~$0.13/1M tokens | api.openai.com |

**Implementation requirements (doc3):**

| ID | Requirement |
|----|-------------|
| F4.1 | `createClaudeClient()` factory in `packages/shared` -- returns Anthropic SDK client configured with subscription API key |
| F4.2 | `createLiteLLMClient()` (existing) continues for non-Claude traffic through LiteLLM proxy |
| F4.3 | Task types and routing in `config/ai-routing.yaml` (existing file, expanded) |
| F4.4 | Spend tracking: every LLM call logs to `llm_usage` Postgres table. Claude calls logged with `cost_usd = 0`. |
| F4.5 | `runAgent(systemPrompt, tools, userMessage, options)` function implementing Claude tool_use loop via Anthropic SDK |
| F4.6 | Fallback behavior: if primary provider unavailable, route to fallback; if all fail, queue for BullMQ retry |
| F4.7 | Both client factories are stateless -- all state in config + Postgres |

### 7.4 Task-to-Tier Mapping **(resolved)**

| Task | Tier | Model | Rationale |
|------|------|-------|-----------|
| Intent classification | T0 | Gemma 4 (local) | Short input, structured output |
| Capture type classification | T0 | Gemma 4 (local) | 8-way classification |
| Brain view classification | T0 | Gemma 4 (local) | 5-way classification |
| Voice capture classification | T0 | Gemma 4 (local) | Same pattern as capture type |
| Confidence gating | T0 | Gemma 4 (local) | Binary yes/no assessment |
| Entity extraction | T1 | Haiku | Pattern matching, structured output |
| Entity resolution/linking | T1 | Haiku | Match against known entities |
| Capture enrichment (tags, summary) | T1 | Haiku | Bounded input, structured output |
| Unresolved question detection | T1 | Haiku | Cross-reference captures |
| Search synthesis | T1 | Haiku | Interactive latency needed |
| Daily sweep summary | T1 | Haiku | Review + summarize |
| MCP context bootstrap | T1 | Haiku | Generate markdown summary |
| Auto-response drafts | T1 | Haiku | Good writing, bounded inputs |
| Weekly briefs | T2 | Sonnet | Narrative quality, cross-week patterns |
| Daily connections | T2 | Sonnet | Nuanced co-occurrence analysis |
| Drift monitoring | T2 | Sonnet | Subtle pattern detection |
| Governance sessions | T2 | Sonnet | Complex multi-turn reasoning |
| Wiki ingest/synthesis | T2 | Sonnet | Quality matters for persistent knowledge |

### 7.5 Fallback Chains **(resolved)**

Each tier specifies a fallback tier. On failure (429, 500, timeout), automatically retry with the fallback tier (max 2 hops):

```
T0 (local Gemma 4) -> T1 (Haiku) -> T2 (Sonnet)
T1 (Haiku)         -> T2 (Sonnet)
T2 (Sonnet)        -> null (fail, queue for BullMQ retry)
```

Fallback chain activates within 5 seconds of primary tier timeout. Fallback events logged to `ai_audit_log` and aggregated in heartbeat report. No per-event alerts.

### 7.6 Embedding Model **(existing, doc2)**

Remains OpenAI `text-embedding-3-large` with `dimensions: 768`. Embeddings are NOT tiered -- quality matters too much and the cost is low (~$0.13/1M tokens). No fallback; queue and retry if API is down. **[RESOLVED: Keep OpenAI. Cost is negligible, quality is proven, switching requires re-embedding all captures.]**

### 7.7 Budget Thresholds **(resolved)**

**[RESOLVED: Soft $20 / Hard $35.** ~30% headroom above the $10-18 estimated range under three-tier routing. Covers Anthropic API (Haiku + Sonnet), OpenAI embeddings, and Deepgram STT.**]**

| Threshold | Amount |
|-----------|--------|
| Soft limit (Pushover alert) | $20/month |
| Hard limit (circuit breaker) | $35/month |

### 7.8 Config Structure (Target) **(resolved)**

`ai-routing.yaml` is the sole source of truth for model routing. Hardcoded model references in other files must be removed.

```yaml
# config/ai-routing.yaml (target -- three-tier)
model_tiers:
  t0_local:
    provider: ollama
    model: gemma4:12b-q4_K_M
    base_url: http://ollama:11434/v1
    max_completion_tokens: 256
    timeout_ms: 10000
    fallback: t1_fast
  t1_fast:
    provider: anthropic
    model: claude-haiku-4-5-20251001
    max_completion_tokens: 4096
    timeout_ms: 20000
    fallback: t2_quality
  t2_quality:
    provider: anthropic
    model: claude-sonnet-4-6
    max_completion_tokens: 8192
    timeout_ms: 30000
    fallback: null
  # DeepSeek placeholder (not active -- config ready for future addition)
  # t_deepseek:
  #   provider: deepseek
  #   model: deepseek-chat
  #   base_url: https://api.deepseek.com/v1

task_routing:
  intent_classification: t0_local
  capture_classification: t0_local
  brain_view_classification: t0_local
  voice_classification: t0_local
  confidence_gating: t0_local
  entity_extraction: t1_fast
  entity_linking: t1_fast
  capture_enrichment: t1_fast
  question_detection: t1_fast
  search_synthesis: t1_fast
  daily_sweep: t1_fast
  mcp_context: t1_fast
  auto_response_draft: t1_fast
  weekly_brief: t2_quality
  daily_connections: t2_quality
  drift_monitoring: t2_quality
  governance: t2_quality
  wiki_ingest: t2_quality
  wiki_synthesis: t2_quality

embedding:
  model: text-embedding-3-large
  provider: openai
  dimensions: 768

monthly_budget:
  soft_limit_usd: 20
  hard_limit_usd: 35
```

---

## 8. Proactive Intelligence

### 8.1 Daily Proactive Sweep Skill **(doc2)**

**Status**: Partially implemented as `daily-sweep-skill` (8 PM daily). **(existing)**

A scheduled skill that runs each evening, reviews the day's captures across all brain views by default (configurable filter available in `config/notifications.yaml` if needed), and generates a concise summary. Covers: key decisions made, new entities encountered, unresolved questions, tasks with no follow-up, and patterns against the entity graph.

**Schedule**: Daily at 8:00 PM local time (configurable via `config/notifications.yaml`)
**Model Tier**: T2 (Haiku) -- bounded input, structured summary output
**Delivery**: Gated by autonomy level (observe = log only, assist+ = Pushover + dashboard)

**Output sections**: Decisions, New Entities, Open Questions, Silent Topics, Suggested Actions.

### 8.2 MCP Context Bootstrap Resource **(doc2)**

**Status**: Implemented as `open_brain://context` resource. **(existing)**

A dynamically-generated markdown summary of the user's current context: active projects, recent entities, open questions, and focus areas from the last 7 days. Designed for Claude/ChatGPT sessions to read on startup. Cached for 5 minutes with `?fresh=true` bypass option.

**Generated Content Structure**:
```markdown
# Open Brain Context -- {date}

## Active Projects
- {project entity name} -- last mentioned {date}, {N} captures

## Key Decisions (last 7 days)
- {decision summary} -- {date}

## Open Questions
- {question text} -- asked {date}, no follow-up yet

## Recent Focus Areas
- {brain_view}: {top entities and topics}
```

### 8.3 Unresolved Questions Tracker **(doc2)**

Captures classified as `question` type that have no follow-up capture referencing the same entities within a configurable window (default 7 days) are flagged as "unresolved."

**Detection logic**: Pure SQL against `captures` + `entity_links` with time window. No LLM needed.
**API**: `GET /api/v1/captures/unresolved-questions?days=7`
**Dashboard**: Card showing count of unresolved questions with expandable list.

### 8.4 Heartbeat Integration Monitor **(doc2)**

**Status**: Implemented as `pipeline-health` skill (every 6 hours). **(existing)**

Lightweight scheduled job that checks application-level health beyond Docker healthchecks. Monitors capture flow, pipeline queue depth, Redis responsiveness, and Ollama availability.

| Check | Healthy | Degraded | Unhealthy |
|-------|---------|----------|-----------|
| Latest capture age | < 24h | < 48h | > 48h |
| Pipeline queue depth | < 50 | < 200 | > 200 |
| Failed job count | 0 | < 10 | > 10 |
| Redis ping | < 100ms | < 500ms | > 500ms or timeout |
| Ollama | Responding | Slow (>5s) | Unreachable (informational, not critical) |
| Postgres connections | < 80% max | < 95% max | > 95% max |

**Alert logic**: State-transition only (healthy -> degraded, degraded -> unhealthy). No re-alerting for persistent issues.

### 8.5 Slack Auto-Response Progression **(doc2)**

Three-phase progression for Slack auto-response:

#### Phase A: Shadow Mode (F42)

- Intent classifier detects `auto_respondable_query` in channel messages and DMs
- Monitors both channels and DMs (DM drafts require higher confidence threshold: 0.90+)
- Runs search + synthesis, logs what it would have said
- Never posts anything
- Autonomy gate: `observe` or higher (only logs)
- Graduation criteria: minimum 50 shadow responses reviewed (not time-based). Manual promotion when quality is validated.

#### Phase B: DM Mode (F43)

- When confidence exceeds threshold (default 0.75 for channels, 0.90 for DMs), sends owner a Slack DM or Pushover with draft
- Owner decides whether to copy-paste, edit, or ignore
- Autonomy gate: `assist` level
- "Post as Reply" / "Edit & Post" / "Dismiss" interactive buttons

#### Phase C: Threaded Replies (F44)

- Bot posts threaded replies directly with AI attribution
- ALL criteria must be true: confidence >= 0.85, 2+ corroborating captures, no captures older than 90 days, non-bot user, monitored channel
- No hard per-channel rate limit -- confidence threshold is the sole gate. Bot responds whenever confidence criteria are met.
- Autonomy gate: `advise` level

**Status**: Partially implemented -- shadow mode and auto-response handler exist as fire-and-forget async handlers with cached autonomy levels. Full progression (DM mode, threaded replies) is planned. **(existing)**

### 8.6 Confidence Scoring Framework **(doc2)**

Composite score (0.0 to 1.0) evaluating how confidently Open Brain can answer a detected question:

| Signal | Weight | Description |
|--------|--------|-------------|
| Top search score | 0.30 | Highest hybrid search score |
| Entity match ratio | 0.25 | Fraction of question entities found in retrieved captures |
| Capture recency | 0.20 | Age of most relevant capture (newer = higher) |
| Corroboration count | 0.15 | Number of captures supporting the answer (2+ = full) |
| Source diversity | 0.10 | Multiple sources (slack + voice + email) = higher |

**Formula**: `confidence = sum(signal_value * weight)` where each signal_value is normalized to [0, 1].

**Thresholds** (configurable via `app_settings` API, not dashboard UI initially):
- Shadow mode: log all, no threshold
- DM mode: confidence >= 0.75 (channels), >= 0.90 (DMs)
- Threaded replies: confidence >= 0.85

Confidence scoring weights are tunable via the `app_settings` API. Dashboard UI controls for weight tuning are deferred.

---

## 9. Wiki Operations

### 9.1 Wiki-Ingest Job **(doc1, doc3)**

BullMQ job triggered after entity extraction in the ingest pipeline. The LLM reads the new capture, identifies relevant existing wiki pages, and updates them. Creates new pages for new entities or concepts. A single capture may touch 5-15 wiki pages.

**Queue**: `wiki-ingest` -- rate-limited to 5 jobs/minute to control LLM costs **(doc3)**
**Model**: Sonnet (T2) for ongoing wiki-ingest quality. Bulk wiki population from 10K OneDrive files uses Qwen 3.5 on DGX Spark (domain-by-domain, overnight), with Haiku (T1) for daily incremental wiki-ingest. **(resolved)**

### 9.2 Wiki-Lint Job **(doc1, doc3)**

Periodic health check of the wiki. The LLM audits for:

1. Contradictions between pages (newer source supersedes older claim)
2. Orphan pages with no inbound links
3. Important concepts mentioned but lacking their own page
4. Missing cross-references between related pages
5. Stale information that newer sources have updated
6. Data gaps that could be filled with additional research
7. Entity graph inconsistencies (entities without wiki pages, edges without supporting sources)

**Schedule**: Weekly, Sundays 5 AM **(doc3)**
**Output**: Written to `wiki/maintenance/lint-report.md` and surfaced in dashboard
**Model**: Synthesis/Opus class **(doc3)**

### 9.3 Wiki-Synthesis Job **(doc3)**

Identifies captures from the last 24 hours not yet integrated into the wiki and queues wiki-ingest jobs for each.

**Schedule**: Daily, 6 AM **(doc3)**

### 9.4 Query Filing **(doc1, resolved)**

Critical principle: Good answers get filed back into the wiki as synthesis pages. A comparison you asked for, an analysis, a connection you discovered -- these are valuable and compound into the knowledge base rather than disappearing into chat history.

**Two filing mechanisms**: (1) User-triggered "Save to Wiki" button on synthesis answers in the dashboard for immediate filing. (2) Daily `wiki-synthesis` job reviews unfiled synthesis answers as a catch-all. Synthesis answers are persisted as captures with `type: 'synthesis'` before wiki filing.

---

## 10. Query System

### 10.1 Query Types **(doc1, mapped to existing infrastructure)**

| Query Type | Example | Strategy | Primary Layer |
|------------|---------|----------|---------------|
| Lookup | "What's the CFA project charter scope?" | index.md scan -> direct wiki page read | Wiki |
| Similarity | "Find things related to contact center automation" | pgvector semantic search -> top-k captures/pages | Vector (pgvector) |
| Traversal | "How does my TRIZ research connect to ServiceNow work?" | Entity graph traversal via spreading activation | Entity Graph (Postgres) |
| Synthesis | "Compare my automation scoring framework across engagements" | Multi-layer: vector for candidates, wiki for content, LLM for analysis | Hybrid |

### 10.2 Existing Search Implementation **(existing)**

**Hybrid search**: Full-text search (GIN index) + vector cosine similarity (pgvector HNSW) combined via Reciprocal Rank Fusion (RRF).

**ACT-R temporal decay scoring**: Composite score = semantic_similarity * (1.0 + temporal_weight * temporal_activation). Temporal activation based on access_count and last_accessed_at using ACT-R cognitive model formula.

**Cognitive memory enhancements** (v1.5.0):
- **Hebbian co-access associations**: Captures frequently accessed together get association boost in search
- **Spreading activation**: Entity graph traversal (max 2 hops, fan-out 10) via PL/pgSQL function. `include_related` parameter defaults false (API) / true (MCP).
- **Memory consolidation**: LLM-powered near-duplicate merging (cosine > 0.92, min cluster 3, 4 AM Sundays)

### 10.3 Wiki Search **(doc1, adapted, resolved)**

Initially via `index.md` scanning. When page count exceeds 200, integrate full-text search over the markdown files. Wiki pages are embedded in pgvector as `source: 'wiki'` captures for unified search -- raw captures and synthesized wiki pages are ranked together in the same hybrid search results.

**[RESOLVED: Keep existing /mcp endpoint only -- no qmd.** 15 MCP tools already built. Wiki search tools (`search_wiki`, `read_wiki_page`, `write_wiki_page`, `list_wiki_pages`) are added to the existing /mcp endpoint and core-api routes. No separate qmd MCP server needed.**]**

### 10.4 MCP Tools for Search **(existing + doc3)**

| Tool | Description | Status |
|------|-------------|--------|
| `search_brain` | Semantic search across all captures | Existing |
| `list_captures` | Browse recent captures with filters | Existing |
| `capture_thought` | Write a new capture | Existing |
| `brain_stats` | Statistics about the brain | Existing |
| `get_entity` | Get entity detail | Existing |
| `list_entities` | List known entities | Existing |
| `get_weekly_brief` | Retrieve most recent weekly brief | Existing |
| `get_capture` | Get full capture content + linked entities | Existing |
| `search_wiki` | Full-text search across wiki pages | Planned (doc3) |
| `read_wiki_page` | Read a specific wiki page | Planned (doc3) |
| `write_wiki_page` | Create or update a wiki page | Planned (doc3) |
| `list_wiki_pages` | List pages with optional type filter | Planned (doc3) |
| `draft_email` | Compose an email draft | Planned (doc3) |
| `send_email` | Send an approved email draft | Planned (doc3) |
| `search_email_captures` | Search email-type captures | Planned (doc3) |
| `get_system_health` | Get current system health metrics | Planned (doc3) |

---

## 11. Autonomy and Governance

### 11.1 Configurable Autonomy Levels **(doc2)**

**Status**: Implemented. Stored in `app_settings` table, key `autonomy_level`. **(existing)**

| Level | Behavior | Use Case |
|-------|----------|----------|
| `observe` | Log findings internally. No notifications, no messages. | Initial deployment, calibration. |
| `assist` | Send findings to owner via Pushover/Slack DM. Human relays. | **Default.** Proactive features are validated -- time to receive their notifications. |
| `advise` | Act and report. Post bot-attributed messages in channels. | Trusted, validated features |
| `partner` | Autonomous action within guardrails. Rare permission requests. | Future -- requires extensive validation |

**Integration pattern**: All proactive features import `meetsAutonomyLevel()` from `@open-brain/shared` for ordinal checks. **(existing)**

**API**:
- `GET /api/v1/settings/autonomy_level` -- returns current level
- `PUT /api/v1/settings/autonomy_level` -- update (must be one of the four levels)

**Web UI**: Toggle on Settings page with descriptions. Color-coded badge on dashboard header.

### 11.2 Board Governance Sessions **(existing)**

LLM-driven governance conversation with guardrails (not FSM):

**Quick Board Check**: 5-question structured audit, anti-vagueness gate, pulls recent captures as evidence, outputs 2-sentence assessment + 90-day falsifiable prediction (creates a bet).

**Quarterly Review**: Multi-step process, reviews all bets, evaluates captures against career problems, 5 core board roles + 2 optional growth roles interrogate the evidence, outputs comprehensive quarterly report.

**Board Roles**:

| Role | Purpose |
|------|---------|
| Accountability | Are you doing what you said you'd do? |
| Market Reality | Is the market validating your direction? |
| Avoidance | What are you avoiding and why? |
| Long-term Positioning | Where does this put you in 2-5 years? |
| Devil's Advocate | What's the strongest case against your current path? |
| Portfolio Defender (growth) | Is your time allocation optimal? |
| Opportunity Scout (growth) | What are you missing? |

### 11.3 Bet Tracking **(existing)**

Bets created from governance sessions with falsifiable criteria and due dates. Drift monitor checks bet progress. Auto-expiration alerts at 7 days before due. Resolution: user marks as correct/wrong, or auto-expired.

---

## 12. User Interfaces

### 12.1 Web Dashboard **(existing + doc3)**

**Current implementation**: Vite + React + Tailwind + shadcn/ui (PWA) at `brain.troy-davis.com`

**Existing pages**: Timeline, Search, Entity Browser, Board Governance, Weekly Briefs, Voice Memos, Document Upload, Settings (organized sections, inline cron editor, queue management, dark mode), In-app Help.

**Planned additions (doc3)**:

| Page/Component | Description | Feature |
|----------------|-------------|---------|
| System Health Strip | Persistent compact status bar across top of every page | F6 |
| Unified Activity Feed | Home page rework: merged activity streams, filterable, "since you've been away" | F7 |
| Wiki Browser | Read-only browser for wiki layer (nav tree, rendered markdown, recent changes, health tab) | F8 |
| Voice Conversations | Conversation log and transcript viewer for Pipecat sessions | F9 |
| Agent Activity Log | Log of all MCP interactions | F10 |
| Enhanced System Page | Queues, Flows, Skills, Infrastructure, MCP Activity sub-tabs | F11 |
| Email View | Inbound log, drafts/outbox, thread view | F15 |
| Settings Expansion | AI routing, voice, wiki, email, integrations sections | F12 |

**Navigation Structure (v2 target)**:
```
Home          -- unified activity feed + system health strip
Captures      -- timeline, search, detail views
Wiki          -- browser, recent changes, lint results
Voice         -- conversation log, session transcripts
Email         -- inbound log, drafts/outbox, thread view
Entities      -- graph, detail pages, merge/split
Intelligence  -- (collapsible group)
  Board       -- governance sessions
  Briefs      -- weekly briefs
System        -- queues, flows, skills, MCP activity, infra health
Settings      -- all config sections
```

### 12.2 Slack Interface **(existing)**

- **Capture**: Any message in #open-brain -> treat as capture
- **Query**: `?` prefix or `@Open Brain` mention with question
- **Commands**: `!` prefix (`!stats`, `!brief`, `!drift`, `!connections`, `!board quick`, etc.)
- **Interactive sessions**: LLM-driven governance in threads
- **Auto-response**: Shadow/DM/threaded progression (see Section 8.5)

### 12.3 MCP Endpoint **(existing)**

Embedded in Core API at `/mcp` route (Streamable HTTP). Authorization: Bearer header. 8 tools currently, expandable with wiki and email tools.

### 12.4 Voice Interface **(doc3, resolved)**

**[RESOLVED: React dashboard is the primary interface** (accessible from any device). Obsidian is an optional power-user tool for graph exploration via `git clone` of the Gitea wiki repo over Tailscale. No system functionality depends on Obsidian.**]**

**Pipecat Conversational Voice (doc3)**:
- Real-time multi-turn voice via Pipecat framework
- Pipeline: VAD (Silero) -> STT (Deepgram cloud) -> LLM (Claude SDK) -> TTS (Deepgram cloud)
- Deepgram spike: soft gate before daily use -- run full streaming spike before enabling, don't block other work. Existing voice-capture one-shot flow continues during spike.
- Session state in Redis with 30-minute TTL
- iOS Shortcut updated for WebSocket connection with fallback to one-shot transcription
- Optional Twilio SIP trunk for phone access
- At conversation end, creates captures routed through standard pipeline
- Legacy decommission: after 2 weeks of validated Pipecat operation + iOS Shortcut updated with fallback, remove voice-capture and faster-whisper containers (9 -> 8 containers temporarily, then Ollama added = 9)

### 12.5 Email Interface **(existing + doc3)**

- **Inbound**: Cloudflare Email Worker at brain@troy-davis.com (push-based, instant). Sender allowlist managed via dashboard Settings page. **(existing)**
- **Outbound**: Himalaya CLI for SMTP drafts and sending. Two modes: auto-send (skill outputs) or review-required (user approves via Slack/dashboard). **(doc3, planned)**

### 12.6 Claude Code Interface **(doc1)**

All ingestion, query, and lint operations can run through Claude Code sessions via MCP. Claude Code can search the brain, update wiki pages, create captures, and manage the knowledge base. This is the primary interaction interface for power users and development work.

---

## 13. Implementation Phases

### 13.1 Already Completed **(existing)**

| Phase | Content | Status |
|-------|---------|--------|
| Phase 1A | Data Layer -- Postgres + pgvector, Core API CRUD | Complete |
| Phase 1B | Embedding + Search -- EmbeddingService, hybrid search | Complete |
| Phase 1C | Pipeline + LLM Gateway -- BullMQ, AI Router | Complete |
| Phase 1D | Slack Bot -- capture, query, intent router | Complete |
| Phase 1E | MCP + External Access -- 8 tools, Cloudflare Tunnel | Complete |
| Phase 2A | Voice Pipeline -- faster-whisper, voice-capture, iOS Shortcut | Complete |
| Phase 2B | Notifications + Output Skills -- Pushover, email, weekly brief | Complete |
| Phase 2C | Semantic Triggers -- trigger CRUD, check_triggers pipeline | Complete |
| Phase 3 | Intelligence -- entity graph, governance, bet tracking | Complete |
| Phase 4 | Web Dashboard -- Vite + React PWA, document ingestion | Complete |
| Phase 5A | Daily Connections, Drift Monitor | Complete |
| Phase 7 (partial) | Architectural Consolidation -- shared utilities, pg-notify reconnection | Complete |
| Hardening | Rate limiting, integration tests, SQL injection fixes | Complete |
| Email Pipeline | Cloudflare Email Worker, sender allowlist, app_settings | Complete |
| Proactive Intelligence (partial) | Autonomy levels, daily sweep skill, MCP context, heartbeat, Slack auto-response (shadow) | Complete |
| Cognitive Memory | Hebbian learning, spreading activation, memory consolidation | Complete |

**Current test suite**: 1,569 unit tests + 95 regression tests passing.

### 13.2 Planned: Phase 7 Proactive Intelligence Completion **(doc2)**

| Sub-Phase | Scope | Features | Dependencies |
|-----------|-------|----------|--------------|
| 7A | Foundation | Autonomy levels (DONE) + multi-model routing | None |
| 7B | Core Proactive | Daily sweep (DONE) + MCP context (DONE) + CaptureCard (DONE) | F37 |
| 7C | Intelligence | Unresolved questions tracker + heartbeat (DONE) | F38, F40 |
| 7D | Slack Auto-Response Foundation | Confidence scoring + shadow mode (partial) + DM mode | F36, F37, F46 |
| 7E | Slack Auto-Response Graduation | Threaded replies with full guardrails | F43 validated, F46 tuned |

### 13.3 Planned: v2 Architecture Expansion **(doc3)**

| Phase | Content | Duration | Features |
|-------|---------|----------|----------|
| v2 Phase 1 | Foundation | Weeks 1-2 | Dual-client model router (F4), pipeline flows (F3.1-F3.3), system health endpoint + strip (F6) |
| v2 Phase 2 | Wiki Layer | Weeks 3-4 | Wiki Git infrastructure (F2), wiki API + MCP tools, wiki-ingest worker, wiki browser UI (F8) |
| v2 Phase 3 | Pipeline Hardening + Activity Feed | Weeks 5-6 | Rate limiting + dedup (F3.4-F3.9), OpenTelemetry (F3.10), unified activity feed (F7), MCP activity logging (F10), enhanced System page (F11) |
| v2 Phase 4 | Scheduled Intelligence + Settings | Weeks 7-8 | Wiki lint/synthesis/drift/connections/reflection skills (F5), Settings expansion (F12), Twilio integration (F1.4, optional) |
| v2 Phase 5 | Outbound Email + Infrastructure Skills | Weeks 9-10 | Himalaya integration (F13), email thread tracking, email Slack commands, email MCP tools, email dashboard (F15), infrastructure skills (F14) |
| v2 Phase 6 | Voice Conversations | Weeks 11-13 | Pipecat service (F1), voice session storage, voice conversations UI (F9), iOS Shortcut update |

### 13.4 Planned: OneDrive File Migration **(doc1)**

| Phase | Scope | Duration | Dependencies |
|-------|-------|----------|--------------|
| 0: Infrastructure | Deploy rclone config for OneDrive | 1 day | Unraid Docker, Tailscale |
| 1a: File Migration | rclone sync OneDrive to staging, build SQLite inventory | 1 session | rclone configured |
| 1b: Dedup | Duplicate detection, cluster report, human review | 1-2 sessions | Inventory complete |
| 1c: Categorization | Batch LLM classification, taxonomy proposals | 1 session + review | Dedup complete |
| 1d: Reorganization | Move files to chosen taxonomy in raw/ | 1 session | Taxonomy selected |
| 2a: Schema Design | Write WIKI_SCHEMA.md, create domain stubs | 1 session | Raw files organized |
| 2b: Pilot Ingestion | Ingest 50-100 files from one domain, iterate | 2-3 sessions | Schema defined |
| 2c: Batch Ingestion | Process remaining ~10K files domain by domain | 5-10 sessions | Pipeline validated |
| 2d: Vector + Entity | Populate pgvector and entity graph from wiki content | 2-3 sessions | Wiki populated |
| 2e: Interfaces | Configure dashboard wiki browser, test end-to-end | 1-2 sessions | All layers populated |
| 3: Ongoing | Incremental ingestion, periodic lint passes | Continuous | System operational |

### 13.5 Implementation Ordering **(resolved)**

**[RESOLVED: v2 stabilization (1 week) -> File migration (2-3 weeks) -> Phase 7 features.** Content first, then intelligence. Get the knowledge base populated before building advanced intelligence on top of it.**]**

Implementation sequence:
1. **v2 Stabilization** (1 week): Multi-model router (three-tier), pipeline hardening, health strip, system health endpoint
2. **File Migration** (2-3 weeks): OneDrive sync infrastructure, inventory/dedup, batch categorization (Qwen 3.5 on DGX Spark), file reorganization, Python extraction container
3. **Wiki Layer**: Gitea repo, wiki-ingest worker, wiki browser UI, wiki search integration
4. **Wiki Construction**: Process 10K files domain-by-domain into wiki, vector + entity population
5. **Phase 7 Completion**: Slack auto-response (DM mode, threaded replies), confidence scoring framework
6. **Scheduled Intelligence**: Wiki lint/synthesis/drift, monthly reflection
7. **Outbound Email + Infrastructure Skills**: Himalaya integration, backup/cost/health skills
8. **Voice Conversations**: Pipecat service, Deepgram spike, iOS Shortcut update (highest risk, last)

---

## 14. Cost Analysis

### 14.1 Current State **(doc2)**

Monthly cost with single-model OpenAI gpt-5.4 routing:

| Task Category | Monthly Volume | Monthly Cost |
|---------------|---------------|-------------|
| Classification (~1000 tasks) | ~1000 | ~$3 |
| Entity extraction (~500 tasks) | ~500 | ~$5 |
| Search synthesis (~300 queries) | ~300 | ~$8 |
| Skills (briefs, connections, drift) | ~30 | ~$6 |
| Governance sessions | ~5 | ~$3 |
| **Total** | | **~$25/month** |

### 14.2 Projected: Three-Tier Routing **(resolved)**

| Task Category | Tier | Monthly Cost |
|---------------|------|-------------|
| Classification | T0 (local Ollama) | $0 |
| Entity extraction | T1 (Haiku) | ~$1.50 |
| Search synthesis | T1 (Haiku) | ~$2 |
| Skills | T2 (Sonnet) | ~$4 |
| Governance | T2 (Sonnet) | ~$3 |
| Daily sweep (30/mo) | T1 (Haiku) | ~$0.30 |
| Shadow mode (~150 drafts/mo) | T1 (Haiku) | ~$0.50 |
| MCP context (~60/mo) | T1 (Haiku) | ~$0.20 |
| Embeddings | OpenAI | ~$2-5 |
| Deepgram STT + TTS | Deepgram | ~$1-3 |
| **Total** | | **~$10-18/month** |

**Net savings**: ~$7-15/month (30-60% reduction) vs current $25/month while adding proactive features. Budget: soft $20 / hard $35.

**[RESOLVED: Three-tier routing with Anthropic API billing.** Target state uses Haiku + Sonnet at per-token rates. Estimated monthly cost: $10-18/month depending on volume. Budget set at soft $20 / hard $35 with ~30% headroom. Interim: gpt-5.4 via OpenAI until Anthropic API key obtained (non-blocking).**]**

### 14.4 One-Time Costs **(doc1)**

- OneDrive file batch categorization: ~$5-10 for 10K files through Haiku
- Wiki bootstrap ingestion: variable depending on model choice and volume

---

## 15. Success Criteria

### 15.1 North Star Metric **(existing)**

**Brain utilization rate** -- percentage of days where at least one capture was ingested AND at least one query was made.

### 15.2 Combined Success Metrics

| Criterion | Target | Source |
|-----------|--------|--------|
| Daily captures | 5+ captures/day | existing |
| Weekly queries | 10+ queries/week | existing |
| Pipeline success rate | >99% | existing |
| Weekly brief generated | 100% on schedule | existing |
| Voice capture latency | <2 min (Apple Watch to confirmation) | existing |
| MCP tool usage | Growing week-over-week | existing |
| Exact duplicate count | Reduced to zero after dedup pass | doc1 |
| Wiki coverage | Every file in raw/ has a source summary page within 30 days | doc1 |
| Wiki cross-referencing | <5% orphan pages after initial ingestion | doc1 |
| Wiki graph connectivity | Connected graph in dashboard wiki view | doc1 |
| Query quality | Semantic search relevant results in top-3 for 90%+ of queries | doc1 |
| Knowledge compounding | 20+ synthesis pages after 60 days | doc1 |
| Lint maintenance cost | Lint passes in <5 minutes | doc1 |
| Incremental ingestion | Single new file in <2 minutes including all layer updates | doc1 |
| Monthly LLM cost | <$20 soft limit (three-tier routing) | resolved |
| Classification quality | Equivalent or better after model migration | doc2 |
| Fallback activation | Within 5 seconds of primary tier timeout | doc2 |
| Auto-response accuracy | Validated via shadow mode review period | doc2 |
| Voice conversation latency | <2s round-trip (STT + LLM + TTS) | doc3 |
| Dashboard home load | <3 seconds with full activity feed | doc3 |
| Autonomous operation | 7+ days without manual intervention | doc3 |
| Non-Claude monthly cost | <$10/month | doc3 |
| Zero data loss | During pipeline migration from sequential to flow | doc3 |
| Database backup | Daily, successful restore verified | doc3 |
| Cost analysis accuracy | Within 5% of actual provider invoices | doc3 |

---

## 16. Risks and Mitigations

### 16.1 Technical Risks

| Risk | Impact | Likelihood | Mitigation | Source |
|------|--------|-----------|------------|--------|
| LLM hallucination during categorization | Miscategorized files, incorrect entity extraction | Medium | Source traceability in all wiki pages; lint passes catch drift; human spot-checks | doc1 |
| Entity fragmentation | Same entity appears under multiple names | High | Dedicated entity consolidation pass; alias support; merge tool (existing) | doc1 |
| Embedding model quality | Poor semantic search results | Low | Evaluate multiple models during pilot; pgvector supports re-indexing | doc1 |
| Scale of initial ingestion | 10K files takes longer than estimated | Medium | Domain-by-domain batching; parallel processing; progress checkpointing | doc1 |
| Wiki sprawl | Too many pages, index unwieldy | Medium | Strict page creation criteria in schema; merge related content; FTS at scale | doc1 |
| Schema evolution pain | Early conventions don't scale | Medium | Design schema to be evolvable; plan refactoring pass after pilot | doc1 |
| Gemma 4 classification quality insufficient | Tasks misrouted, captures misclassified | Medium | Fallback chain to T1. Validate against 100 labeled examples before cutover. | doc2 |
| DeepSeek API reliability | Entity extraction stalls | Low | Fallback to T2 (Haiku). DeepSeek >99.5% uptime historically. | doc2 |
| Ollama container OOM on 128GB system | Container crashes, classification fails | Low | 16GB mem_limit. Gemma 4 12B q4 uses ~10GB. Monitor via heartbeat. | doc2 |
| Auto-response posts incorrect information | Reputational risk in team channels | Medium | Three-phase progression. Confidence threshold. Disclaimer. Per-channel disable. | doc2 |
| Alert fatigue from heartbeat | Owner ignores real alerts | Medium | State-transition alerting only. No re-alerting for persistent issues. | doc2 |
| Budget overrun from new features | Exceeds hard limit | Low | Circuit breaker exists. Updated thresholds. New features add ~$1/month. | doc2 |
| Deepgram cloud STT unavailable | Voice conversations fail | Low | 99.9% SLA. Faster-whisper batch fallback. Phase 0 spike validates latency. | doc3 |
| Wiki ingest LLM costs | Runaway costs from heavy ingestion | Low | Claude subscription at $0. Rate limit wiki-ingest queue. | doc3 |
| BullMQ flow migration breaks pipeline | Captures fail to process | Low | Feature flag. Run old + new pipeline in parallel during validation. | doc3 |
| Git lock contention on wiki | Concurrent wiki-ingest jobs conflict | Medium | Serialize Git operations through single BullMQ worker (concurrency=1). | doc3 |
| Himalaya binary incompatibility | Email sending fails | Low | Pin version in Dockerfile. Pre-built binaries for x86_64. | doc3 |
| Backup storage grows unbounded | Disk fills | Low | Retention policies. Storage audit skill reports weekly. | doc3 |
| Infrastructure alert noise | Pushover spam | Medium | Quiet-hours window. Batch notifications. Dashboard shows full history. | doc3 |

---

## 17. Open Questions

All questions from the initial unified draft have been resolved. Decisions are recorded in `reference/answers-PRD-UNIFIED-20260411.json` and applied inline throughout this document as **[RESOLVED]** tags.

### 17.1 From doc2 -- All Resolved

| # | Question | Decision | Status |
|---|----------|----------|--------|
| Q1 | Should confidence scoring weights be tunable from dashboard? | Tunable via `app_settings` API, not dashboard UI initially. Dashboard controls deferred. | **Resolved** |
| Q2 | Should auto-response shadow mode monitor DMs or only channels? | Channels + DMs, but DM drafts require higher confidence threshold (0.90+). | **Resolved** |
| Q3 | Should MCP context resource be cached or generated fresh? | 5-minute cache with `?fresh=true` bypass option. | **Resolved** |
| Q4 | What Gemma 4 quantization gives best quality/speed on i7-9700 CPU? | Gemma 4 12B q4_K_M on Ollama. Benchmarking still needed for fine-tuning. | **Resolved** |
| Q5 | Should fallback chain log warning or silently escalate? | Log to `ai_audit_log`, aggregate in heartbeat. No per-event alerts. | **Resolved** |

### 17.2 From Conflicts -- All Resolved

| # | Question | Decision | Status |
|---|----------|----------|--------|
| Q6 | Vector search: pgvector or Qdrant? | Keep pgvector. Revisit at 500K+ vectors. | **Resolved** |
| Q7 | Knowledge graph: Postgres or Neo4j? | Keep Postgres entities, add `relationship_type` column. | **Resolved** |
| Q8 | Wiki host: Obsidian or Gitea? | Gitea authoritative, Obsidian optional local browser. | **Resolved** |
| Q9 | Local inference: Ollama on homeserver or vLLM on DGX Spark? | Ollama on homeserver (CPU). DGX Spark for batch overflow. | **Resolved** |
| Q10 | Model routing: five-tier or dual-client? | Three-tier (local Ollama + Haiku + Sonnet), configurable. | **Resolved** |
| Q11 | Budget thresholds? | Soft $20 / Hard $35. | **Resolved** |
| Q12 | Embedding model: OpenAI or local? | Keep OpenAI text-embedding-3-large. | **Resolved** |
| Q13 | Claude Code or BullMQ workers? | Both: BullMQ for automated pipeline, Claude Code for interactive wiki work. | **Resolved** |
| Q14 | Container count target? | 9 (Pipecat replaces voice+whisper, Ollama added). | **Resolved** |
| Q15 | Search interface: qmd or existing /mcp? | Existing /mcp endpoint with wiki tools added. No qmd. | **Resolved** |

---

## 18. Appendix: Feature Specifications

### 18.1 Feature Index (All Sources)

| ID | Feature | Source | Priority | Status |
|----|---------|--------|----------|--------|
| F01 | Core API | existing | Must Have | Implemented |
| F02 | Postgres 16 + pgvector | existing | Must Have | Implemented |
| F03 | Async processing pipeline (BullMQ) | existing | Must Have | Implemented |
| F04 | Slack bot -- capture | existing | Must Have | Implemented |
| F05 | Slack bot -- query | existing | Must Have | Implemented |
| F06 | MCP endpoint | existing | Must Have | Implemented |
| F07 | EmbeddingService | existing | Must Have | Implemented |
| F08 | AI Router Service | existing | Must Have | Implemented |
| F09 | Voice-capture integration | existing | Must Have | Implemented |
| F10 | faster-whisper container | existing | Must Have | Implemented |
| F11 | Slack bot -- commands | existing | Should Have | Implemented |
| F12 | Weekly brief skill | existing | Should Have | Implemented |
| F13 | Pushover notifications | existing | Should Have | Implemented |
| F14 | Email delivery (HTML reports) | existing | Should Have | Implemented |
| F15 | Entity graph | existing | Should Have | Implemented |
| F16 | Slack interactive sessions | existing | Should Have | Implemented |
| F17 | Board governance skills | existing | Should Have | Implemented |
| F18 | Bet tracking | existing | Should Have | Implemented |
| F19 | Web dashboard | existing | Could Have | Implemented |
| F20 | Slack voice clip processing | existing | Could Have | Implemented |
| F21 | Daily connection skill | existing | Should Have | Implemented |
| F22 | Drift monitor skill | existing | Should Have | Implemented |
| F23 | Document ingestion | existing | Could Have | Implemented |
| F24 | URL/bookmark capture | existing | Should Have | Planned |
| F28 | Semantic push triggers | existing | Should Have | Implemented |
| F29 | Queue management UI | existing | Should Have | Planned |
| F30 | Trigger delete fix | existing | Must Have | Planned |
| F31 | Skill schedule editing | existing | Should Have | Planned |
| F32 | Dark mode toggle | existing | Could Have | Planned |
| F33 | Settings page reorganization | existing | Should Have | Planned |
| F34 | In-app help/documentation viewer | existing | Should Have | Planned |
| F35 | Slack channel cleanup | existing | Should Have | Planned |
| F36 | Configurable autonomy levels | doc2 | P3 | Implemented |
| F37 | Multi-model tiered routing | doc2 | P1 | Planned |
| F38 | Daily proactive sweep skill | doc2 | P1 | Implemented |
| F39 | MCP context bootstrap resource | doc2 | P2 | Implemented |
| F40 | CaptureCard unification | doc2 | P5 | Implemented |
| F41 | Unresolved questions tracker | doc2 | P4 | Planned |
| F42 | Slack auto-response: shadow mode | doc2 | P6 | Partial |
| F43 | Slack auto-response: DM mode | doc2 | P7 | Planned |
| F44 | Slack auto-response: threaded replies | doc2 | P9 | Planned |
| F45 | Heartbeat integration monitor | doc2 | P8 | Implemented |
| F46 | Confidence scoring framework | doc2 | P6 | Planned |
| v2-F1 | Pipecat conversational voice | doc3 | Must Have | Planned |
| v2-F2 | Wiki layer (Karpathy pattern) | doc3 | Must Have | Planned |
| v2-F3 | Pipeline modernization (BullMQ flows) | doc3 | Must Have | Planned |
| v2-F4 | Dual-client model routing | doc3 | Must Have | Planned |
| v2-F5 | Scheduled intelligence skills (new) | doc3 | Should Have | Planned |
| v2-F6 | Dashboard: system health strip | doc3 | Must Have | Planned |
| v2-F7 | Dashboard: unified activity feed | doc3 | Must Have | Planned |
| v2-F8 | Dashboard: wiki browser | doc3 | Must Have | Planned |
| v2-F9 | Dashboard: voice conversations view | doc3 | Should Have | Planned |
| v2-F10 | Dashboard: agent activity log | doc3 | Should Have | Planned |
| v2-F11 | Dashboard: pipeline & queue management (enhanced) | doc3 | Must Have | Planned |
| v2-F12 | Dashboard: settings expansion | doc3 | Should Have | Planned |
| v2-F13 | Email channel (outbound via Himalaya) | doc3 | Must Have | Planned |
| v2-F14 | Infrastructure skills | doc3 | Must Have | Planned |
| v2-F15 | Dashboard: email view | doc3 | Should Have | Planned |
| doc1-P1 | OneDrive file migration + dedup | doc1 | Must Have | Planned |
| doc1-P2 | Wiki construction from OneDrive files | doc1 | Must Have | Planned |

### 18.2 Feature Specifications: doc2 (F36-F46)

See PRD-PHASE7.md for detailed specifications of features F36 through F46, including:

- **F36**: Autonomy levels -- four levels (observe/assist/advise/partner), app_settings storage, dashboard toggle, `checkAutonomy()` integration pattern
- **F37**: Multi-model tiered routing -- five tiers, task-to-tier mapping, fallback chains, Ollama container, config structure
- **F38**: Daily proactive sweep -- scheduled 8 PM, structured output, Pushover delivery gated by autonomy
- **F39**: MCP context bootstrap -- `open-brain://context` resource, dynamic markdown summary, 7-day lookback
- **F40**: CaptureCard unification -- single shared component, delete local variants
- **F41**: Unresolved questions tracker -- SQL detection logic, API endpoint, dashboard widget
- **F42**: Slack shadow mode -- `auto_respondable_query` intent, `shadow_responses` table, draft logging
- **F43**: Slack DM mode -- Pushover + Slack DM delivery, interactive message buttons, confidence threshold 0.75
- **F44**: Slack threaded replies -- direct posting with attribution, confidence 0.85, per-channel rate limiting
- **F45**: Heartbeat monitor -- 6 health checks, state-transition alerting, 30-minute schedule
- **F46**: Confidence scoring -- 5 signals, weighted composite, configurable thresholds

### 18.3 Feature Specifications: doc3 (v2-F1 through v2-F15)

See PRD-V2.md for detailed specifications, including:

- **v2-F1**: Pipecat voice -- Deepgram STT, Kokoro/ElevenLabs TTS, session management, Twilio SIP
- **v2-F2**: Wiki layer -- Gitea repo, directory structure, wiki-ingest/lint/synthesis jobs, MCP tools
- **v2-F3**: Pipeline modernization -- FlowProducer DAGs, parallel stages, rate limiting, dedup, lightweight OTel trace IDs in logs (no collector infrastructure)
- **v2-F4**: Dual-client model routing -- `createClaudeClient()`, `runAgent()`, `llm_usage` table, fallback behavior
- **v2-F5**: Scheduled intelligence skills -- wiki lint, wiki synthesis, drift detection, daily connections, monthly reflection
- **v2-F6**: System health strip -- persistent status bar, SSE updates, threshold indicators
- **v2-F7**: Unified activity feed -- merged activity streams, "since you've been away" mode, SSE
- **v2-F8**: Wiki browser -- two-panel layout, markdown rendering, recent changes, health tab
- **v2-F9**: Voice conversations view -- session list, transcript viewer, linked captures
- **v2-F10**: Agent activity log -- MCP interaction logging, `mcp_activity` table
- **v2-F11**: Pipeline & queue management -- System tab with queues/flows/skills/infra sub-tabs
- **v2-F12**: Settings expansion -- AI routing, voice, wiki, email, integrations sections
- **v2-F13**: Email outbound -- Himalaya CLI, draft/approve/send workflow, Slack commands, MCP tools
- **v2-F14**: Infrastructure skills -- backups (db/wiki/redis), cost analysis, pipeline health audit, storage audit, container health, secret rotation, dedup sweep
- **v2-F15**: Email view -- inbound tab, drafts/outbox tab, thread view, quick actions

### 18.4 Database Additions (v2) **(doc3)**

New tables required for v2 features:

```sql
-- Voice conversation sessions (v2-F1)
CREATE TABLE voice_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key VARCHAR(64) UNIQUE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  turn_count INTEGER DEFAULT 0,
  transcript JSONB DEFAULT '[]'::jsonb,
  summary TEXT,
  captures_created UUID[] DEFAULT '{}',
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- LLM usage tracking (v2-F4)
CREATE TABLE llm_usage (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  task_type VARCHAR(32) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  model VARCHAR(64) NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cost_usd NUMERIC(10, 6),
  duration_ms INTEGER,
  job_id VARCHAR(128),
  metadata JSONB DEFAULT '{}'::jsonb
);

-- MCP activity log (v2-F10)
CREATE TABLE mcp_activity (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_id VARCHAR(64),
  tool_name VARCHAR(64) NOT NULL,
  parameters JSONB DEFAULT '{}'::jsonb,
  result_summary TEXT,
  duration_ms INTEGER,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Email drafts (v2-F13)
CREATE TABLE email_drafts (
  id SERIAL PRIMARY KEY,
  to_address TEXT NOT NULL,
  cc_address TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  send_mode VARCHAR(20) NOT NULL DEFAULT 'review-required',
  source VARCHAR(32),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  himalaya_message_id VARCHAR(256),
  capture_id UUID REFERENCES captures(id),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Container health history (v2-F14)
CREATE TABLE container_health (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  container_name VARCHAR(64) NOT NULL,
  healthy BOOLEAN NOT NULL,
  response_ms INTEGER,
  error TEXT,
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Backup log (v2-F14)
CREATE TABLE backup_log (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  backup_type VARCHAR(16) NOT NULL,
  file_path TEXT NOT NULL,
  size_bytes BIGINT,
  duration_seconds INTEGER,
  status VARCHAR(16) NOT NULL,
  error TEXT,
  pruned_count INTEGER DEFAULT 0
);

-- Unified activity feed (v2-F7)
CREATE TABLE activity_feed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(32) NOT NULL,
  subtype VARCHAR(64),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  summary TEXT,
  view VARCHAR(32),
  detail JSONB DEFAULT '{}'::jsonb,
  source_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_activity_feed_source_id ON activity_feed(source_id); -- Enables fast 'show all activity for this capture' queries
```

### 18.5 API Additions (v2) **(doc3)**

| Method | Path | Description | Feature |
|--------|------|-------------|---------|
| GET | `/api/v1/system/health` | System health metrics JSON | v2-F6 |
| GET | `/api/v1/system/health/stream` | SSE stream of health updates | v2-F6 |
| GET | `/api/v1/system/queues` | Queue depths and stats | v2-F11 |
| GET | `/api/v1/system/queues/stream` | SSE stream of queue updates | v2-F11 |
| GET | `/api/v1/system/flows` | Active and recent flow trees | v2-F11 |
| GET | `/api/v1/system/flows/:id` | Single flow tree with job details | v2-F11 |
| GET | `/api/v1/system/skills` | Job scheduler list with metadata | v2-F11 |
| POST | `/api/v1/system/skills/:id/run` | Trigger immediate skill run | v2-F11 |
| GET | `/api/v1/activity/feed` | Unified activity feed | v2-F7 |
| GET | `/api/v1/activity/feed/stream` | SSE stream of new activity | v2-F7 |
| GET | `/api/v1/wiki/pages` | List wiki pages with metadata | v2-F8 |
| GET | `/api/v1/wiki/pages/*path` | Get wiki page content | v2-F8 |
| GET | `/api/v1/wiki/recent-changes` | Git log of wiki modifications | v2-F8 |
| GET | `/api/v1/wiki/lint-report` | Latest lint results | v2-F8 |
| GET | `/api/v1/wiki/search` | Full-text search across wiki | v2-F8 |
| POST | `/api/v1/wiki/ingest` | Trigger manual wiki ingest | v2-F8 |
| POST | `/api/v1/wiki/lint` | Trigger manual lint pass | v2-F8 |
| GET | `/api/v1/voice/sessions` | List voice sessions | v2-F9 |
| GET | `/api/v1/voice/sessions/:id` | Get session transcript | v2-F9 |
| GET | `/api/v1/voice/sessions/active` | Get active session status | v2-F9 |
| GET | `/api/v1/mcp/activity` | MCP activity log | v2-F10 |
| GET | `/api/v1/email/drafts` | List pending email drafts | v2-F13 |
| GET | `/api/v1/email/drafts/:id` | Get draft detail | v2-F13 |
| POST | `/api/v1/email/drafts` | Create email draft | v2-F13 |
| POST | `/api/v1/email/drafts/:id/send` | Approve and send a draft | v2-F13 |
| DELETE | `/api/v1/email/drafts/:id` | Reject/discard a draft | v2-F13 |
| GET | `/api/v1/email/status` | Email channel health | v2-F13 |
| GET | `/api/v1/email/inbound` | Paginated email-type captures | v2-F15 |
| GET | `/api/v1/email/threads/:message_id` | Thread reconstruction | v2-F15 |
| GET | `/api/v1/infra/health` | Container health history | v2-F14 |
| GET | `/api/v1/infra/backups` | Backup history | v2-F14 |
| GET | `/api/v1/infra/cost-report` | Latest cost analysis data | v2-F14 |
| GET | `/api/v1/system/backups` | List recent backups | v2-F14 |
| GET | `/api/v1/system/costs` | LLM cost summary | v2-F14 |
| GET | `/api/v1/system/costs/detail` | Detailed cost breakdown | v2-F14 |

### 18.6 Configuration File Changes **(doc3)**

**New files:**

| File | Purpose | Feature |
|------|---------|---------|
| `config/voice.yaml` | Pipecat pipeline configuration | v2-F1 |
| `config/wiki.yaml` | Wiki layer settings | v2-F2 |
| `config/email.yaml` | Outbound email defaults and routing | v2-F13 |
| `config/himalaya/config.toml` | Himalaya SMTP account configuration | v2-F13 |

**Modified files:**

| File | Changes | Feature |
|------|---------|---------|
| `config/ai-routing.yaml` | Add task types, Claude SDK routing, per-model cost rates | v2-F4 |
| `config/skills.yaml` | Add wiki-lint, wiki-synthesis, drift, connections, reflection, all infrastructure skills | v2-F5, v2-F14 |
| `config/pipeline.yaml` | Restructure for flow DAG topology | v2-F3 |

### 18.7 Non-Functional Requirements

#### Performance Targets

| Metric | Target | Source |
|--------|--------|--------|
| Text capture ingest (API response) | <500ms | existing |
| Full pipeline processing (text) | <30 seconds | existing |
| Full pipeline processing (voice, direct API) | <90 seconds | existing |
| Semantic search response (hybrid + temporal) | <5 seconds | existing |
| Temporal scoring overhead | <5ms | existing |
| Synthesis query response | <30 seconds | existing |
| Weekly brief generation | <2 minutes | existing |
| MCP tool response | <5 seconds | existing |
| Web dashboard page load | <2 seconds | existing |
| Wiki-ingest single capture | <2 minutes including all wiki page updates | doc1 |
| Wiki lint pass | <5 minutes | doc1 |
| Voice round-trip latency (STT + LLM + TTS) | <2 seconds | doc3 |
| Activity feed page load | <3 seconds | doc3 |
| Pipeline ingest-to-searchable time | 30%+ reduction via parallel flows | doc3 |

#### Reliability

- All containers configured with `restart: unless-stopped` **(existing)**
- Health checks on all containers **(existing)**
- Pipeline retries with patient exponential backoff: 5 attempts per stage (30s, 2m, 10m, 30m, 2h) + daily auto-sweep **(existing)**
- Circuit breaker on external API calls (Anthropic, OpenAI) **(existing)**
- Postgres backed up via daily pg_dump (7-day local retention + weekly offsite via rclone) **(existing)**
- Fallback chains for model routing (max 2 hops) **(doc2)**
- BullMQ flow `failParentOnFailure` on critical children; wiki-ingest failures do NOT fail parent **(doc3)**
- Monitoring: Docker logs + Unraid dashboard + pipeline_events/skills_log tables + Pushover alerts **(existing)**
- Infrastructure skills for automated backup verification, health checks, cost monitoring **(doc3)**

#### Security

- No authentication layer for dashboard (single user, network-level security via Tailscale/LAN) **(existing)**
- MCP endpoint has API key authentication (`Authorization: Bearer <key>`) **(existing)**
- All API keys stored in Bitwarden Secrets Manager, loaded at startup via `bws` CLI **(existing)**
- No secrets in Docker Compose or config files **(existing)**
- Timing-safe token comparison via `timingSafeEqual()` in admin-auth and MCP auth **(existing)**
- Rate limiting with `X-Open-Brain-Caller` header for per-service buckets **(existing)**
- CORS configured for brain.troy-davis.com **(existing)**

#### Data Integrity

- Captures are soft-deletable via API. No hard delete. Recovery via direct SQL. **(existing)**
- Pipeline processing is idempotent -- reprocessing produces same results **(existing)**
- Source-level dedup: Slack via `slack_ts`, voice via filename, MCP via content hash + 60-second window **(existing)**
- Wiki never auto-deletes content based on raw file deletion (conservative approach) **(doc1)**
- Memory consolidation soft-deletes originals, retains `deleted_at` timestamp for recovery **(existing)**
- `capture_associations` uses canonical pair ordering (`capture_id_a < capture_id_b`) **(existing)**

#### Memory Constraints

Per process: 1.5 GB resident memory ceiling. Stream large files, use generators/iterators, bounded buffers.

### 18.8 Infrastructure Skills Detail **(doc3)**

#### v2-F14.1: Database Backup

- **Schedule**: Daily, 2 AM
- **Method**: `pg_dump` of the full Open Brain database to compressed file in `/mnt/backups/open-brain/`
- **Retention**: 7 daily, 4 weekly, 3 monthly. Old backups pruned automatically.
- **Notification**: Pushover on success with backup size; alert on failure.

#### v2-F14.2: Wiki Backup

- **Schedule**: Daily, 2:15 AM
- **Method**: Git bundle of the wiki repo to `/mnt/backups/open-brain-wiki/`
- **Retention**: Same as database backups
- **Note**: Redundant with Gitea's own storage, but ensures recovery if Gitea is down

#### v2-F14.3: Redis Snapshot

- **Schedule**: Daily, 2:30 AM
- **Method**: Trigger `BGSAVE`, copy RDB file to `/mnt/backups/open-brain-redis/`
- **Retention**: 7 daily / 4 weekly / 3 monthly (standardized across all backup types)

#### v2-F14.4: LLM Cost Analysis

- **Schedule**: Daily 7 AM (daily report), Monday (weekly summary), 1st of month (monthly report)
- **Method**: Query `llm_usage` table for previous day's spend. Aggregate by model and task type.
- **Alert**: If daily spend exceeds $2, include breakdown in Pushover notification
- **Output**: Monthly report stored as wiki page under `wiki/operations/cost-reports/`

#### v2-F14.5: Pipeline Health Audit

- **Schedule**: Every 6 hours
- **Checks**: Jobs stuck in active >30 min, failed jobs with no retries, queue depths >100, schedulers missing 2x interval
- **Auto-remediation**: Move stalled jobs back to waiting, alert on persistent failures

#### v2-F14.6: Storage Audit

- **Schedule**: Weekly, Sundays 3 AM
- **Reports**: Postgres database size, Redis memory, backup storage, wiki repo size, document storage, total captures count and growth rate
- **Output**: Wiki page under `wiki/operations/storage-reports/`

#### v2-F14.7: Container Health Check

- **Schedule**: Every 15 minutes
- **Method**: HTTP for health checks (hit `/health` endpoint on each container). Docker socket mount (read-only) for backup operations that need container info. Acceptable risk for homelab, documented.
- **Alert**: If any container unhealthy for 3 consecutive checks, send Pushover alert
- **Storage**: Log health history to `container_health` table for dashboard display

#### v2-F14.8: Secret Rotation Reminder

- **Schedule**: Monthly, 1st of month, 10 AM
- **Method**: Check age of secrets in Bitwarden via `bws` CLI
- **Alert**: If any API key >90 days old

#### v2-F14.9: Capture Deduplication Sweep

- **Schedule**: Weekly, Saturdays 4 AM
- **Method**: Scan for near-duplicate captures (cosine similarity >0.95) not caught by real-time dedup
- **Action**: Flag for review in dashboard (not auto-merge). Supplements existing memory consolidation (0.92 threshold).

### 18.9 Pipecat Voice Service Detail **(doc3)**

#### v2-F1 Requirements

| ID | Requirement |
|----|-------------|
| F1.1 | Pipecat pipeline: VAD (Silero) -> STT (Deepgram cloud, primary) -> LLM (Claude SDK) -> TTS (Deepgram cloud). Phase 0 spike: test Deepgram streaming latency before enabling daily use (soft gate -- don't block other work). |
| F1.2 | Session state in Redis with configurable TTL (default 30 min). Includes conversation history, session metadata, extracted captures. |
| F1.3 | iOS Shortcut updated for Pipecat WebSocket endpoint. Fallback to one-shot transcription if unavailable. |
| F1.4 | Twilio SIP trunk support (optional, configurable). Phone number connects to Pipecat. Config in `config/voice.yaml`. |
| F1.5 | At conversation end (silence timeout or "done"), create captures from conversation, routed through standard pipeline. |
| F1.6 | Full transcript stored in `voice_sessions` Postgres table (id, session_key, started_at, ended_at, duration_seconds, turn_count, transcript JSONB, summary, captures_created, metadata). |
| F1.7 | LLM has access to Open Brain search and entity lookup as tools during voice conversations. |
| F1.8 | Interrupt handling: user speaks while TTS is playing; Pipecat cancels TTS and processes new input. |
| F1.9 | Health endpoint at `/health` reporting STT status, active sessions, TTS provider availability. |

#### Voice Configuration

```yaml
# config/voice.yaml
stt:
  provider: deepgram
  model: nova-2
  fallback:
    provider: faster-whisper
    model: large-v3
    compute_type: int8
    device: cpu

tts:
  provider: deepgram  # Single vendor with STT -- low cost, low latency
  voice: aura-asteria-en

llm:
  task_type: conversation

session:
  ttl_minutes: 30
  silence_timeout_seconds: 120
  max_turns: 100

twilio:
  enabled: false
```

### 18.10 Email Outbound Detail **(doc3)**

#### v2-F13 Architecture

```
Inbound (existing -- no changes):
  Email -> Cloudflare Email Worker (brain@troy-davis.com)
    -> POST /api/v1/captures on core-api
    -> standard ingest pipeline
    -> sender allowlist via dashboard Settings page

Outbound (NEW):
  LLM composes email (via runAgent with email tools)
    -> draft stored in email_drafts table
    -> if auto-send: himalaya template send
    -> if review-required: Pushover -> user approves via Slack/dashboard -> send
    -> sent email logged as capture (type: email-outbound)
```

#### Outbound Email Requirements

| ID | Requirement |
|----|-------------|
| F13.1 | Himalaya CLI binary installed in workers container. SMTP credentials from Bitwarden. Migrate all outbound email to Himalaya -- remove nodemailer dependency entirely. Single sending mechanism. |
| F13.4 | Email thread tracking via `in_reply_to` and `references` headers in capture metadata. |
| F13.5 | Attachment handling -- draft replies can reference attachments from original inbound email. |
| F13.6 | Outbound email composition via `runAgent()` with `draft_email`, `search_brain`, `get_entity` tools. |
| F13.7 | Two send modes: `auto-send` (immediate via himalaya) or `review-required` (Pushover -> approval -> send). |
| F13.8 | Slack `/email` commands: `send`, `drafts`, `approve <id>`, `reject <id>`. |
| F13.9 | Weekly brief and monthly reflection skills gain email delivery option via Himalaya. |
| F13.10 | Routing rules in `config/email.yaml`: outbound defaults, auto-send rules. |
| F13.11 | MCP tools: `draft_email`, `send_email`, `search_email_captures`. |

#### Email Configuration

```yaml
# config/email.yaml
himalaya:
  config_path: /app/config/himalaya/config.toml
  default_account: personal

outbound:
  default_from: troy@troy-davis.com
  display_name: "Troy Davis"  # Display name on outbound emails
  signature: |
    Troy Davis
    Stratfield Consulting
    ---
    This email may have been drafted with AI assistance.
  default_mode: review-required
  auto_send_rules:
    - type: skill-output
    - match:
        to: "self"
```

### 18.11 Existing Database Schema Reference **(existing)**

The following schema is currently deployed and running:

#### captures table

```sql
create table captures (
  id uuid default gen_random_uuid() primary key,
  content text not null,
  content_raw text,
  content_hash char(64),
  embedding vector(768),
  access_count int default 0,
  last_accessed_at timestamptz,
  metadata jsonb default '{}'::jsonb,
  source text not null,                    -- slack, voice, web, api, email, document, mcp, consolidation
  source_metadata jsonb default '{}'::jsonb,
  pre_extracted jsonb default '{}'::jsonb,
  tags text[] default '{}',
  brain_views text[] default '{}'::text[],
  pipeline_status text default 'received', -- received, processing, complete, failed, partial
  captured_at timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);
```

#### entities table

```sql
create table entities (
  id uuid default gen_random_uuid() primary key,
  entity_type text not null,               -- person, project, decision, concept, bet
  name text not null,
  aliases text[] default '{}',
  metadata jsonb default '{}'::jsonb,
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
  relationship text,                       -- mentioned, decided, blocked_by, etc.
  created_at timestamptz default now()
);
```

#### capture_associations table (cognitive memory)

```sql
create table capture_associations (
  id uuid default gen_random_uuid() primary key,
  capture_id_a uuid references captures(id),
  capture_id_b uuid references captures(id),
  co_access_count int default 1,
  weight numeric(6,4) default 0.1,
  last_co_accessed_at timestamptz default now(),
  created_at timestamptz default now(),
  CONSTRAINT capture_pair_order CHECK (capture_id_a < capture_id_b),
  UNIQUE(capture_id_a, capture_id_b)
);
```

#### Other existing tables

- `pipeline_events` -- append-only processing audit trail
- `sessions` -- LLM-driven governance session state
- `session_messages` -- append-only transcript storage
- `bets` -- career governance bets with falsifiable criteria
- `skills_log` -- output skill execution history
- `semantic_triggers` -- persistent semantic patterns for push notifications
- `app_settings` -- generic key-value store (autonomy_level, email_allowlist, etc.)

#### Existing SQL functions

- `match_captures()` -- semantic search with ACT-R temporal decay scoring
- `match_captures_hybrid()` -- full-text + vector with Reciprocal Rank Fusion
- `spreading_activation()` -- entity graph traversal (max 2 hops, fan-out 10)
- `update_access_stats()` -- ACT-R access tracking for temporal scoring

### 18.12 Capture Types and Source Types **(existing)**

**Capture types** (8 types, extensible via prompt template):
`decision`, `idea`, `observation`, `task`, `win`, `blocker`, `question`, `reflection`

**Source types** (8 types):
`slack`, `voice`, `api`, `document`, `email`, `mcp`, `consolidation`, `bookmark` (planned)

**Brain views** (5 views, config-driven):
`career`, `personal`, `technical`, `work-internal`, `client`

### 18.13 Existing Scheduled Skills Reference **(existing)**

| Skill | Schedule | Description | LLM Required |
|-------|----------|-------------|--------------|
| Daily Sweep (re-queue) | Daily 3 AM | Re-queues stuck pipeline captures | No |
| Budget Check | Daily 8 AM | Monthly AI spend monitoring | No |
| Drift Monitor | Daily 8 AM | Brain-view classification drift detection | Yes |
| Pipeline Health | Every 6 hours | Queue health + capture flow monitoring | No |
| Daily Sweep Skill | Daily 8 PM | LLM-powered evening summary | Yes |
| Memory Consolidation | Sundays 4 AM | Clusters near-duplicate captures, LLM-merges | Yes |
| Capture Reminder Morning | Weekdays 7 AM | Pushover nudge to capture | No |
| Morning Brief | Weekdays 7:15 AM | Structured morning briefing from DB queries | No |
| Capture Reminder Evening | Daily 9 PM | Evening nudge with capture count | No |
| Weekly Brief | Weekly, configurable | LLM-synthesized summary across all brain views | Yes |
| Board Governance | Weekly/Quarterly | LLM-driven interactive governance sessions | Yes |
| Semantic Push Triggers | On capture | Evaluates new captures against trigger patterns | No (cosine similarity) |

### 18.14 Key Decisions from All Sources

| ID | Decision | Rationale | Source |
|----|----------|-----------|--------|
| D1 | TypeScript monorepo (pnpm workspaces) | Shared types, single build system | existing |
| D2 | Hono framework | Lightweight, Bun/Node compatible, good DX | existing |
| D3 | Drizzle ORM | Schema-as-code, type-safe queries, drizzle-kit migrations | existing |
| D4 | BullMQ + Redis for pipeline | Durable jobs, retry, repeatable, flow support | existing |
| D5 | pgvector over Qdrant | Single database, simpler ops, adequate performance | existing vs doc1 |
| D6 | Postgres entity tables over Neo4j | Already implemented, spreading activation works | existing vs doc1 |
| D7 | vector(768) schema | Matryoshka truncation, good quality/space tradeoff | existing |
| D8 | Hybrid search (FTS + vector + RRF) | Better recall than vector-only | existing |
| D9 | ACT-R temporal decay scoring | Recency + access frequency cognitive model | existing |
| D10 | MCP embedded in Core API at /mcp | No separate container, Streamable HTTP | existing |
| D11 | Socket Mode for Slack bot | No inbound port, works behind firewalls | existing |
| D12 | Cloudflare Email Worker for inbound | Push-based, instant, no polling, no additional container | existing |
| D13 | Gitea for wiki over Obsidian | Git-backed, API access, dashboard integration | doc3 vs doc1 |
| D14 | Pipecat for voice over voice-capture + faster-whisper | Multi-turn, real-time, fewer containers | doc3 |
| D15 | Deepgram cloud STT over local faster-whisper | Real-time latency, no local model loading | doc3 |
| D16 | Himalaya CLI for outbound email | Stateless Rust binary, no daemon, no container | doc3 |
| D17 | Three-tier model routing (Ollama + Haiku + Sonnet) | Configurable tiers, cost-effective, interim gpt-5.4 until Anthropic key | resolved |
| D18 | FlowProducer DAGs over sequential pipeline | Parallel stages, dependency tracking | doc3 |
| D19 | Three-tier model hierarchy (Ollama + Haiku + Sonnet) | Cost optimization + quality matching. No DeepSeek for now. | resolved |
| D20 | Ollama on homeserver (CPU) for local inference | Already running, DGX Spark for batch overflow only | resolved |
| D21 | Shadow -> DM -> threaded auto-response progression | Risk management, each phase validates next | doc2 |
| D22 | Autonomy levels over per-feature toggles | Single knob, easier to reason about | doc2 |
| D23 | OpenAI for embeddings (keep) | Proven quality, low cost, no re-embedding | doc2 |
| D24 | Confidence scoring as separate framework | Reusable across auto-response, MCP, future features | doc2 |
| D25 | Conservative file deletion (flag, don't remove) | Files deleted for many reasons; never auto-delete wiki | doc1 |
| D26 | Knowledge compounds via wiki (Karpathy pattern) | Synthesis persisted, not re-derived per query | doc1 |

### 18.15 Testing Strategy **(doc3, existing)**

| Level | Approach |
|-------|----------|
| Unit | Vitest for all modules. Current: 1,569 tests passing. Target: 80%+ coverage on new code. Key areas: Claude client factory, wiki Git operations, pipeline flow construction, activity feed aggregation, himalaya CLI wrapper, backup retention policy, confidence scoring. |
| Integration | Docker Compose test stack. Test: ingest flow DAG execution, wiki-ingest end-to-end (capture -> wiki page), voice session lifecycle, MCP tool execution, email draft -> approve -> send lifecycle, backup -> restore -> verify. Uses `X-Open-Brain-Caller: integration-test` header for rate limit bypass. Config: `vitest.config.integration.ts`. Runner: `pnpm --filter @open-brain/core-api exec vitest`. |
| Regression | 95 tests (`scripts/regression-test.mjs`). Extend with: voice conversation -> capture -> wiki integration, scheduled skill -> wiki update -> dashboard display, outbound email draft -> Slack approval -> send, infrastructure skill execution chain. |
| E2E | `scripts/e2e-phase1.sh` (8 tests), `scripts/e2e-full.sh` (37 tests). Extend for v2 scenarios. Add 3-5 file ingestion e2e tests covering major file types (PDF, DOCX, PPTX, TXT, CSV) following the existing `e2e-full.sh` pattern. |
| Performance | Benchmark: Pipecat voice latency (VAD -> STT -> Claude -> TTS round-trip), wiki-ingest throughput (captures/minute), flow DAG vs sequential pipeline execution time, pg_dump duration at current database size. |

### 18.16 Future Considerations (Out of Scope)

These items are explicitly out of scope for the unified plan but may inform future development:

- **URL/bookmark capture** (F24) -- browser bookmark import with content extraction **(existing, planned)**
- **Calendar integration** (F25) -- iCal feed sync **(existing, deferred)**
- **Screenshot/image capture** (F27) -- vision model ingestion **(existing, deferred)**
- **Multi-wiki support** -- separate wiki instances per domain **(doc3)**
- **Wiki graph visualization** -- Obsidian-style graph view in dashboard **(doc3)**
- **Collaborative wiki** -- human review/approval workflow for wiki changes **(doc3)**
- **Agent-driven research** -- system identifies knowledge gaps and searches web to fill them **(doc1)**
- **Client-facing knowledge products** -- export wiki subsets as polished deliverables **(doc1)**
- **Decay and archival** -- confidence decay on synthesis pages over time **(doc1)**
- **Thinking MCP integration** -- capture reasoning heuristics and mental models **(doc1)**
- **Multi-modal ingestion** -- image analysis, video keyframe extraction **(doc1)**
- **DGX Spark local inference integration** -- routing specific tasks to local Qwen models **(doc3)**

### 18.16 References

- Karpathy, A. (2026). LLM Wiki: A pattern for building personal knowledge bases using LLMs. GitHub Gist. **(doc1)**
- Bush, V. (1945). As We May Think. The Atlantic Monthly. **(doc1)**
- Microsoft Research (2024). GraphRAG: Unlocking LLM discovery on narrative private data. **(doc1)**
- tobi/qmd. Local search engine for Markdown files with hybrid BM25/vector search. **(doc1)**

---

## 19. Reconciliation: Conflicts and Resolutions

### 19.1 Conflict Summary -- All Resolved

All 13 conflicts have been resolved. Decisions recorded 2026-04-11 (see `reference/answers-PRD-UNIFIED-20260411.json`).

| # | Topic | Resolution | Status |
|---|-------|------------|--------|
| C1 | Vector search | **Keep pgvector.** Monitor 4 signals (latency >200ms, index build >30min, filter degradation, RAM pressure). Revisit at 500K+ vectors. | **RESOLVED** |
| C2 | Knowledge graph | **Keep Postgres entities.** Add `relationship_type VARCHAR(32) DEFAULT 'related_to'` to `entity_relationships` for typed edges. No Neo4j. | **RESOLVED** |
| C3 | Wiki host | **Gitea is authoritative store.** Obsidian as optional local browser via clone. | **RESOLVED** |
| C4 | Browse interface | **React dashboard is primary** (any device). Obsidian for power-user graph exploration. | **RESOLVED** |
| C5 | Search interface | **Existing /mcp endpoint only.** No qmd. Wiki search tools added to /mcp. | **RESOLVED** |
| C6 | API framework | **Keep Hono.** No separate Python service. File extraction uses a separate lightweight Python container, BullMQ-triggered. | **RESOLVED** |
| C7 | Orchestration | **Both.** BullMQ for automated pipeline. Claude Code for interactive wiki work via MCP. | **RESOLVED** |
| C8 | Embedding model | **Keep OpenAI text-embedding-3-large.** Cost negligible (~$2-5/month), no DGX Spark dependency. | **RESOLVED** |
| C9 | Model routing | **Three-tier** (local Ollama + Haiku + Sonnet) with Anthropic API key. No DeepSeek for now. Configurable for future additions. | **RESOLVED** |
| C10 | Local inference | **Ollama on homeserver (CPU).** DGX Spark as batch overflow. Already running, GPU upgrade planned. | **RESOLVED** |
| C11 | Budget thresholds | **Soft $20 / Hard $35.** ~30% headroom above $10-18 estimated range. | **RESOLVED** |
| C12 | Features already implemented | **Confirmed.** F36 (autonomy), F38 (daily sweep), F39 (MCP context), F40 (CaptureCard), F45 (heartbeat) are production. | **RESOLVED** |
| C13 | DeepSeek T1 | **Skip for now.** Config ready for future addition. $2.70/month savings not worth added provider complexity. | **RESOLVED** |

### 19.2 Unified Technology Stack Decision

| Component | Decision | Rationale |
|-----------|----------|-----------|
| **Database** | Postgres 16 + pgvector (existing) | Single database for captures, entities, vectors. Proven. No additional containers. |
| **Entity Graph** | Postgres entity tables + Drizzle ORM (existing) + typed relationships | Spreading activation, Hebbian associations implemented. `relationship_type` column for rich edges. |
| **Vector Search** | pgvector HNSW index (existing) | vector(768) schema, hybrid search with FTS. Revisit at 500K+ vectors. |
| **Wiki** | Gitea-backed markdown repo | Git versioning, API access, dashboard integration. Obsidian optional. |
| **Primary Interface** | React dashboard (existing) + wiki browser | PWA, responsive, full-featured. Obsidian for power-user graph exploration. |
| **Model Routing** | Three-tier (Ollama + Haiku + Sonnet) | Configurable in ai-routing.yaml. Interim: gpt-5.4 until Anthropic key. |
| **Embeddings** | OpenAI text-embedding-3-large at 768d (existing) | High quality, low cost (~$2-5/month), no re-embedding needed. |
| **Local Inference** | Ollama on homeserver (CPU) + DGX Spark (batch overflow) | Ollama for routine classification. DGX Spark for bulk operations. |
| **Voice** | Pipecat with Deepgram STT + TTS (doc3) | Replaces voice-capture + faster-whisper. Single vendor for STT + TTS. |
| **Email Outbound** | Himalaya CLI in workers container (doc3) | Stateless Rust CLI, no nodemailer. Display name: "Troy Davis", AI disclaimer in signature. |
| **Pipeline** | BullMQ FlowProducer DAGs (doc3) | Parallel stages, durable, existing Redis. Lightweight OTel trace IDs in logs. |
| **Orchestration** | BullMQ (automated) + Claude Code (interactive) | Complementary approaches for different use cases. |
| **File Extraction** | Separate lightweight Python container | BullMQ-triggered via core-api. Same pattern as voice-pipecat. |
| **Backups** | 7 daily / 4 weekly / 3 monthly | Standardized retention across all backup types (DB, wiki, Redis). |

---

## Change Log

| Date | Version | Changes |
|------|---------|---------|
| 2026-04-10 | 1.0 | Initial unified draft. Merged openbrain-prd.docx, PRD-PHASE7.md, PRD-V2.md. 15 NEEDS CLARIFICATION tags. Reconciliation section with 13 conflicts and recommended resolutions. |
| 2026-04-11 | 1.1 | All 52 questions answered and applied. 13 NEEDS CLARIFICATION tags resolved (0 remaining). Key decisions: three-tier model routing (Ollama + Haiku + Sonnet), Gitea wiki with Obsidian optional, pgvector + typed entity relationships (no Qdrant/Neo4j), Ollama on homeserver for local inference, soft $20 / hard $35 budget, implementation sequence v2 stabilize -> file migration -> Phase 7. Doc errors fixed (INTEGER -> UUID in voice_sessions and email_drafts). External Dependencies table added. Open Questions and Reconciliation sections updated to RESOLVED. |
