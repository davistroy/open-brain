# Master Implementation Plan — Open Brain v3

**Generated:** 2026-04-12
**Based On:** PRD-UNIFIED.md, IMPLEMENT_UNIFIED.md, LAB_NOTEBOOK entries 029-031, cost-tiering architecture discussion, infrastructure reconnaissance
**Status:** PLANNING
**Hardware Available:** Homeserver (i7-9700, 128GB, no GPU), Bond (Ubuntu, general purpose), Jetson Orin Nano (GPU, llama.cpp running), DGX Spark (GPU, vLLM, intermittent)

---

## Executive Summary

This plan covers everything discussed for Open Brain's evolution from a production v1.5.0 capture-and-search system into a full personal knowledge operating system with automated data source ingestion. The work spans five arcs:

1. **Infrastructure Foundation** — Wire Jetson as T1 classification endpoint, set up Bond as Claude Code CLI runner (T2 tier), complete voice validation
2. **Pipeline & Intelligence Completion** — Three-tier model routing, Slack auto-response, voice container promotion
3. **Wiki & Knowledge Architecture** — Wiki activation, OneDrive file migration, wiki construction (Karpathy pattern)
4. **Batch Data Source Pipelines** — Email, financial, Amazon, credit cards, utilities, newsletters, lab reports, insurance — all following the cost-tiered aggregation model
5. **Polish & Hardware** — Dashboard completion, email outbound, cognitive memory tuning, optional GPU upgrade

The critical insight driving everything: Troy pays for a Claude Max subscription covering Claude Code. API usage is extra. Every new feature must exhaust free tiers (Python → local LLM → Claude CLI) before touching the API. Bond/Ubuntu-VM runs `claude --print` for batch synthesis at zero marginal cost.

---

## Cost-Tiering Architecture (Mandatory for ALL Items)

| Tier | What | Cost | Where It Runs |
|------|------|------|---------------|
| T0: Python/Code | Parsing, extraction, rule-based classification, data normalization, API fetching | Free | Homeserver (workers container or Python sidecar) |
| T1: Local LLM | Simple classification, yes/no decisions, ambiguous categorization | Free | **Jetson** (Qwen 3.5 4B, 0.67s/call, `--reasoning off`) |
| T2: Claude CLI | Complex analysis, multi-document synthesis, batch reports | Free (subscription) | **Bond** (`claude --print` via SSH or job dispatch) |
| T3: API | Real-time user-facing responses only (MCP queries, Slack, voice) | $$/token | Homeserver (OpenAI API) |

**The Aggregation Rule:** Never call an LLM per-item. Collect → extract (T0) → classify (T0/T1) → aggregate → synthesize (T2) → store one capture.

**Two-Track Pipeline:**
- **Track A (real-time):** Voice, Slack, MCP, manual captures → full pipeline with API for entity extraction
- **Track B (batch):** Email, financial, documents, scraping → Python + CLI → summary capture enters full pipeline

---

## Plan Overview

| Tier | Phase | Focus | Key Deliverables | Dependencies | Est. Effort |
|------|-------|-------|------------------|--------------|-------------|
| 0 | 0A | Jetson T1 Wiring | ai-routing.yaml + gateway dispatch to Jetson | None | S (~4 files) |
| 0 | 0B | Bond T2 Setup | Claude Code on bond, job dispatch mechanism | None | Operational |
| 0 | 0C | OneDrive Sync | Check status, wait, organize | None | Operational |
| 0 | 0D | Pipecat Voice Soak | 10+ conversations, latency measurement | None | Manual, 2 weeks |
| 1 | 1A | Three-Tier Model Routing | Tier config, fallback chains, validation suite | 0A | M (~8 files) |
| 1 | 1B | Slack Auto-Response | 5-signal confidence, DM mode, interactive buttons | 1A | M (~6 files) |
| 1 | 1C | Voice Container Promotion | Remove voice-capture + faster-whisper | 0D | S (~2 files) |
| 2 | 2A | Wiki Infrastructure Activation | Verify workers, Wiki.tsx polish | Deployed | S (~3 files) |
| 2 | 2B | OneDrive File Migration Tooling | Python extraction, inventory DB, dedup, categorization | 0C, 2A | L (~14 files) |
| 2 | 2C | Wiki Construction | Batch orchestration, pilot + full ingestion via T2 | 2B | M (~5 files) |
| 3 | 3A | Email Inbox Processing | IMAP sync, classify, daily summary | 0B, 1A | L (~10 files) |
| 3 | 3B | Financial Monitoring | Plaid/scrape, delta computation, daily briefing | 0B | M (~8 files) |
| 3 | 3C | Amazon Purchase Tracking | Order export/scrape, monthly analysis | 0B | S (~5 files) |
| 3 | 3D | Credit Card Categorization | CSV/OFX import, monthly trends | 0B, 3B | S (~4 files) |
| 3 | 3E | Utility Bill Tracking | PDF scrape, monthly comparison | 0B | S (~3 files) |
| 3 | 3F | Newsletter Assessment | Email filter, extract claims, weekly assessment | 3A | M (~5 files) |
| 3 | 3G | Lab Report Analysis | PDF parse, longitudinal trends, deep analysis | 0B | M (~6 files) |
| 3 | 3H | Insurance Policy Analysis | PDF parse, comparison matrix, gap identification | 0B | M (~5 files) |
| 4 | 4A | Email Outbound (Himalaya) | SMTP config, auto-send + review modes | 3A | M (~4 files) |
| 4 | 4B | Dashboard & Settings Polish | System sub-tabs, Settings expansion, Voice page | Tiers 1-2 | M (~6 files) |
| 4 | 4C | Cognitive Memory Tuning | Hebbian weight tuning, consolidation monitoring, Related UI | Usage data | S (~3 files) |
| 5 | 5A | RTX PRO 2000 GPU (Optional) | Local T1 + embeddings on homeserver, eliminate API costs | Purchase | Hardware |

---

## Dependency Graph

```
0A (Jetson) ──┐
              ├── 1A (Model Routing) ── 1B (Slack Auto-Response)
0B (Bond/T2) ─┤                    │
              │                    └── 3A (Email) ── 3F (Newsletters)
              │                                  └── 4A (Email Outbound)
              ├── 3B (Financial) ── 3D (Credit Cards)
              ├── 3C (Amazon)
              ├── 3E (Utilities)
              ├── 3G (Lab Reports)
              └── 3H (Insurance)

0C (OneDrive) ── 2B (File Migration) ── 2C (Wiki Construction)
                       │
2A (Wiki Infra) ───────┘

0D (Pipecat Soak) ── 1C (Voice Promotion)

4B (Dashboard) depends on Tiers 1-2 completion
4C (Memory Tuning) depends on accumulated usage data
5A (GPU) independent — accelerates everything when purchased
```

---

## Lab Notebook Protocol (Applies to EVERY Phase)

**LAB_NOTEBOOK.md is the permanent experiment record. These steps are BLOCKING PRECONDITIONS for every phase — not optional.**

Before starting any phase:
1. Create a LAB_NOTEBOOK.md entry with: Objective, Hypothesis (with measurable success criteria), Rollback Plan
2. Update the Decision Log table if any decisions are made
3. Update the Action Items table

After completing any phase:
4. Log results immediately — commands run, outcomes, performance numbers
5. Document failures with root cause analysis
6. Update Decision Log and Action Items
7. Mark the acceptance criterion `LAB_NOTEBOOK entry created with results` as done

Every phase's acceptance criteria includes a lab notebook line item. Do not skip it.

---

<!-- BEGIN PHASES -->

## Phase 0A: Wire Jetson as T1 Classification Endpoint

**Estimated Effort:** S (~4 files, ~100 LOC)
**Dependencies:** None — Jetson already running Qwen 3.5 4B on port 8080
**Hardware:** Jetson Orin Nano at jetson.k4jda.net

### Context

LAB_NOTEBOOK Entry 031 confirmed:
- Qwen 3.5 4B on Jetson: 0.67s per classification, 100% accuracy on all task types
- `--reasoning off` is critical (thinking mode caused all prior T0 failures)
- Endpoint: `http://jetson.k4jda.net:8080/v1` (llama.cpp OpenAI-compatible API)
- 13 days uptime as of 2026-04-12

### Work Items

#### 0A.1 Update ai-routing.yaml with T1 Endpoint

Add Jetson as the T1 tier endpoint. Update task routing to send classification tasks to T1.

**Files:** `config/ai-routing.yaml`

**Changes:**
- Add `endpoints` section with `t1_local` pointing to Jetson
- Add `task_routing` section mapping `intent`, `capture_type`, `brain_view` to T1
- Keep `fast`, `synthesis`, `governance` on T3 (API)
- Add `fallback` config: T1 failure → T3

#### 0A.2 Update LLM Gateway to Dispatch by Tier

Modify the gateway/client factory to read task routing config and dispatch to the correct endpoint.

**Files:** `packages/shared/src/services/llm-gateway.ts` or equivalent

**Changes:**
- Read `task_routing` from ConfigService
- For classification tasks, create OpenAI client pointing to Jetson endpoint
- Add `think: false` / disable reasoning in request params for T1
- Implement timeout + fallback: if Jetson doesn't respond in 5s, retry on T3
- Log tier used in `ai_audit_log` via `client_used` column

#### 0A.3 Update Classification Workers

Ensure extract-entities, intent classification, and brain view classification use the gateway's tier dispatch.

**Files:** `packages/workers/src/jobs/extract-entities.ts`, classification code paths

**Changes:**
- Use gateway dispatch instead of direct OpenAI client for classification subtasks
- Pass task type hint so gateway routes to correct tier

#### 0A.4 Validation

- Test each classification task against Jetson endpoint
- Verify fallback works when Jetson is unreachable
- Verify `ai_audit_log` records `client_used = 'jetson-t1'`

**Acceptance Criteria:**
- [x] Classification tasks route to Jetson by default
- [x] Fallback to API works when Jetson is down
- [ ] Response times < 2s for classification (was 0.67s in benchmarks)
- [ ] `ai_audit_log` records which tier handled each request
- [x] All existing tests pass
- [x] LAB_NOTEBOOK entry created with hypothesis, results, and decisions (Entry 032)

---

## Phase 0B: Set Up Claude Code CLI Runner (T2 Tier)

**Estimated Effort:** Operational (no application code changes)
**Dependencies:** None
**Hardware Options:** Bond (bond.k4jda.net, Ubuntu 25.10, x86_64) OR new Ubuntu VM on homeserver

### Context

The T2 tier uses `claude --print` (Claude Code CLI) for batch/async LLM tasks. This is covered by the Max subscription — zero marginal cost.

### Machine Choice

| Option | Pros | Cons |
|--------|------|------|
| **Bond** (remote Ubuntu box) | Dedicated resources, no competition with Open Brain stack, already provisioned with SSH key | Network latency for SSH dispatch, separate machine to maintain |
| **Ubuntu VM on homeserver** | Zero network latency, co-located with data, simpler dispatch (local exec vs SSH) | Competes for i7-9700 CPU + 128GB RAM with the Docker stack, VM overhead |

**Recommendation:** Start with bond (simpler, isolated). If latency matters or bond is unavailable, spin up a lightweight Ubuntu VM on homeserver as alternative/backup. Both can coexist — the dispatch script can try local first, fall back to bond.

### Work Items

#### 0B.1 Install Claude Code on T2 Host

```bash
# On bond:
ssh -i ~/.ssh/id_claude_code claude@bond.k4jda.net
# Install Claude Code CLI
# Authenticate with Max subscription
# Verify: claude --print "Hello" returns a response

# OR on homeserver Ubuntu VM:
# Create Ubuntu 24.04 VM, install Claude Code, authenticate
```

#### 0B.2 Create T2 Job Dispatch Script

A simple bash script that Open Brain workers can invoke to run batch synthesis:

```bash
# t2-synthesize.sh — runs on the T2 host
# Input: prompt text via stdin or file
# Output: LLM response to stdout
claude --print --model opus "$@"
```

For remote (bond): workers SSH and pipe prompt to the script.
For local VM: workers exec directly (or SSH to localhost).

#### 0B.3 Create T2 BullMQ Worker (Optional)

For tighter integration, a BullMQ worker in the workers package that:
1. Receives a job with `tier: 't2'` and a prompt
2. Dispatches to the T2 host (SSH or local exec)
3. Returns the result to the job caller

This can be deferred — SSH script is sufficient for initial batch sources.

#### 0B.4 Verify End-to-End

- Run a test prompt from homeserver workers container to T2 host
- Verify response quality matches API
- Measure round-trip time

**Acceptance Criteria:**
- [ ] `claude --print` works on T2 host with Max subscription auth
- [ ] Homeserver can dispatch prompts to T2 host
- [ ] Round-trip time < 30s for a typical synthesis prompt
- [ ] LAB_NOTEBOOK entry created with setup steps, verification results, and latency measurements

---

## Phase 0C: Complete OneDrive Sync

**Estimated Effort:** Operational
**Dependencies:** None (in progress)

### Work Items

#### 0C.1 Check Sync Status

```bash
# Check the OneDrive Docker app status on homeserver
# Verify file count and sync progress
```

#### 0C.2 Organize Files

After sync completes:
- Identify top-level directory structure
- Categorize into domains (work, personal, technical, financial, medical, etc.)
- Identify obvious duplicates and junk
- Create a simple inventory (file count by type, size by directory)

**Acceptance Criteria:**
- [ ] Sync complete (454K files, ~208 GB)
- [ ] Directory structure documented
- [ ] Ready for Phase 2B file migration tooling
- [ ] LAB_NOTEBOOK entry created with file counts, directory structure, and categorization notes

---

## Phase 0D: Full Pipecat Voice Validation

**Estimated Effort:** Manual, 2-week soak period
**Dependencies:** None — voice-pipecat container already running

### Work Items

#### 0D.1 Conduct 10+ Voice Conversations

- Test multi-turn conversations with varied topics
- Measure round-trip latency (target: <2s)
- Note quality issues (transcription errors, response quality, TTS naturalness)

#### 0D.2 Document Results

- Latency measurements with conditions
- Quality assessment
- Go/no-go decision for container promotion (Phase 1C)

**Acceptance Criteria:**
- [ ] 10+ conversations completed
- [ ] Latency < 2s round-trip (or documented exceptions)
- [ ] Quality acceptable for daily use
- [ ] LAB_NOTEBOOK entry created with latency measurements, quality notes, and go/no-go decision

---

## Phase 1A: Three-Tier Model Routing

**Estimated Effort:** M (~8 files, ~400 LOC)
**Dependencies:** 0A (Jetson wired)

### Goals

Complete the three-tier routing system so every LLM call in the system is cost-optimized:
- T1 (Jetson, free): classification, simple yes/no, sentiment
- T2 (Bond CLI, free): synthesis, analysis, reports (batch only)
- T3 (API, paid): real-time user-facing responses

### Work Items

#### 1A.1 Tier Configuration Schema

Extend `ai-routing.yaml` with full tier definitions:
- Each task type maps to a preferred tier with fallback chain
- Timeout and retry config per tier
- Cost tracking metadata

#### 1A.2 Gateway Dispatch Logic

The LLM gateway reads task type and routes to the correct tier's endpoint. Fallback chain: T1 → T3 (with T2 available for batch callers).

#### 1A.3 Fallback Chain Implementation

When T1 (Jetson) fails:
- Timeout (5s) → retry once → fall back to T3
- Log the fallback event
- Health check: if Jetson fails 3x in 5 minutes, circuit-break to T3 for 10 minutes

#### 1A.4 Validation Suite

Script that tests each task type against each tier and verifies correct routing.

**Acceptance Criteria:**
- [ ] All classification tasks route to T1 by default
- [ ] Fallback chain works end-to-end
- [ ] Circuit breaker prevents repeated Jetson failures from adding latency
- [ ] Cost savings measurable via ai_audit_log
- [ ] LAB_NOTEBOOK entry created with routing validation results, latency comparison, and cost analysis

---

## Phase 1B: Slack Auto-Response Completion

**Estimated Effort:** M (~6 files, ~600 LOC)
**Dependencies:** 1A (model routing for cost-efficient inference)

### Goals

Complete the auto-response progression: shadow → DM → threaded replies.

### Work Items

- 5-signal confidence scorer (search relevance, coverage, recency, entity match, source diversity)
- DM mode: draft response in DM to Troy for approval
- Interactive buttons: approve, edit, dismiss
- Threaded reply mode: post approved responses as thread replies
- Tune confidence threshold from shadow mode data

**Acceptance Criteria:**
- [ ] Confidence scoring uses 5 signals
- [ ] DM mode sends draft with approve/edit/dismiss buttons
- [ ] Approved responses post as threaded replies
- [ ] Shadow logs show score distribution for tuning
- [ ] LAB_NOTEBOOK entry created with confidence score distribution analysis and threshold selection rationale

---

## Phase 1C: Voice Architecture Decision

**Estimated Effort:** S (~2 files)
**Dependencies:** 0D (successful voice soak test)

### Key Discovery

**Pipecat and voice-capture are complementary, not redundant.**
- **Pipecat** = WebSocket real-time multi-turn conversation (Deepgram STT → Claude LLM → TTS). Port 8765.
- **voice-capture** = HTTP POST one-shot upload from iOS Shortcut (Whisper → classification → capture). Port 3001.

These serve different use cases and different protocols. Removing voice-capture would break the iOS Shortcut workflow unless Pipecat also supports HTTP upload or the Shortcut is rewritten for WebSocket.

**This reshapes Phase 1C from "remove legacy" to "keep both unless Pipecat gains HTTP upload."**

### Work Items

**If Pipecat CANNOT handle HTTP uploads (most likely):**
- Keep both services running — they are complementary
- Optionally: remove `faster-whisper` if Pipecat's Deepgram STT is acceptable for one-shot transcription via a thin HTTP adapter
- Update documentation to reflect two voice paths: conversation (Pipecat) and capture (voice-capture)

**If Pipecat CAN handle HTTP uploads (unlikely without code changes):**
- Remove `voice-capture` and `faster-whisper` services from docker-compose.yml
- Update iOS Shortcut to point to Pipecat's HTTP endpoint
- Stack simplifies from 12 → 10 containers

### Decision Criteria

The soak test (Phase 0D) determines Pipecat conversation quality. The HTTP upload question is separate and determined by reviewing Pipecat's API surface. If Pipecat is WebSocket-only (current state), voice-capture stays.

**Acceptance Criteria:**
- [ ] Decision documented: keep both services or consolidate
- [ ] If keeping both: documentation updated to explain two voice paths
- [ ] If consolidating: voice-capture and faster-whisper removed, iOS Shortcut updated
- [ ] LAB_NOTEBOOK entry created with decision rationale and architecture diagram

---

## Phase 2A: Wiki Infrastructure Activation

**Estimated Effort:** S (~3 files)
**Dependencies:** Already deployed (Phase 4 of IMPLEMENT_DEPLOYMENT)

### Work Items

- Verify wiki workers clone and sync with Gitea correctly (started in deployment)
- Wiki.tsx browser polish — navigation tree, page viewer, search
- Wiki-lint and wiki-synthesis workers operational
- Verify wiki-ingest pipeline stage fires on new captures

**Acceptance Criteria:**
- [ ] Wiki workers clone and sync with Gitea
- [ ] Wiki.tsx browser renders navigation tree and pages
- [ ] Wiki-ingest fires on new captures
- [ ] LAB_NOTEBOOK entry created with wiki worker verification results, page counts, any clone/sync issues

---

## Phase 2B: OneDrive File Migration Tooling

**Estimated Effort:** L (~14 files, ~1,500 LOC)
**Dependencies:** 0C (sync complete), 2A (wiki infra ready)

### Goals

Build the Python-based extraction and categorization pipeline for 10,000+ OneDrive files.

### Work Items

#### 2B.1 Python Content Extraction Container

Lightweight Python container with:
- PDF extraction (PyMuPDF/pdfplumber)
- DOCX/PPTX extraction (python-docx, python-pptx)
- Image OCR (Tesseract, optional)
- Metadata extraction (file size, dates, MIME type)
- BullMQ-triggered via core-api (same pattern as voice-pipecat)

#### 2B.2 Inventory Database

SQLite database tracking:
- Every file: path, size, hash, MIME type, modified date, extraction status
- Dedup detection: content hash + fuzzy title matching
- Categorization: domain assignment (work, personal, technical, etc.)

#### 2B.3 Rule-Based Categorization (T0)

Python-based categorization using:
- File path patterns (e.g., `/Consulting/` → work, `/Medical/` → personal)
- File type heuristics (e.g., `.xlsx` with "budget" → financial)
- Known vendor/client name matching

#### 2B.4 Ambiguous File Classification (T1)

For files T0 can't categorize:
- Send file metadata + first 500 chars to Jetson (T1)
- Classify into domain + subcategory
- Store classification in inventory DB

#### 2B.5 Dedup Detection

- Content hash (SHA-256) for exact duplicates
- Title + size similarity for near-duplicates
- Mark duplicates in inventory; keep newest, flag others

**Acceptance Criteria:**
- [ ] Extraction handles PDF, DOCX, PPTX, TXT, images
- [ ] Inventory DB tracks all files with metadata
- [ ] T0 categorization covers 80%+ of files
- [ ] T1 handles the remaining 20%
- [ ] Dedup identifies and flags duplicates
- [ ] LAB_NOTEBOOK entry created with extraction success rates, categorization accuracy, dedup stats, and processing times

---

## Phase 2C: Wiki Construction

**Estimated Effort:** M (~5 files, ~400 LOC)
**Dependencies:** 2B (files extracted and categorized)

### Goals

Process all OneDrive files into wiki pages using Claude CLI (T2) for synthesis.

### Work Items

#### 2C.1 Batch Orchestration

- Process files domain-by-domain (work → personal → technical → etc.)
- Use Claude CLI on bond (T2) for page synthesis
- Aggregate 10-20 related files per CLI call (the aggregation rule)
- Rate: ~1,000 files/night in background batches

#### 2C.2 Pilot Ingestion (100 files)

- Pick one well-understood domain (e.g., consulting proposals)
- Run full pipeline: extract → categorize → synthesize → wiki page
- Validate quality: are pages useful? Cross-references correct?
- Tune prompts based on pilot results

#### 2C.3 Full Processing

- Process remaining ~10,000 files overnight over ~2 weeks
- Monitor quality spot-checks daily
- Wiki-lint runs automatically to catch issues

**Acceptance Criteria:**
- [ ] Pilot produces high-quality wiki pages with correct cross-references
- [ ] Full processing completes within 2 weeks
- [ ] < 5% orphan pages (cross-referencing target from PRD)
- [ ] Wiki browser shows navigable knowledge base
- [ ] LAB_NOTEBOOK entries created: pilot results (quality assessment, prompt tuning), full processing stats (pages created, orphan rate, processing time)

---

## Phase 3A: Email Inbox Processing

**Estimated Effort:** L (~10 files, ~800 LOC)
**Dependencies:** 0B (bond/T2 ready), 1A (model routing)

### Goals

Process email from hotmail + gmail inboxes: fetch, classify, summarize daily.

### Architecture (Track B — Batch)

```
IMAP fetch (T0, Python) → Parse & extract (T0) → Classify (T0 rules + T1 Jetson) 
  → Aggregate day's emails → Daily summary (T2, Claude CLI on bond) → One capture/day
```

### Work Items

#### 3A.1 IMAP Sync Service

Python service/container that:
- Connects to hotmail and gmail via IMAP
- Fetches new emails since last sync (15-minute cron)
- Extracts: sender, subject, date, body text, attachments list
- Stores in a local staging table or SQLite

#### 3A.2 Email Classification (T0)

Rule-based classification:
- **Newsletter**: known sender domains, unsubscribe links
- **Receipt/Order**: known vendor patterns, order number regex
- **Personal**: contacts list match
- **Action-required**: reply-to patterns, question marks, urgency keywords
- **Spam/Promotional**: promotional sender lists, marketing patterns

#### 3A.3 Ambiguous Email Classification (T1)

For emails T0 can't classify:
- Send subject + first 200 chars to Jetson
- Classify into category + priority

#### 3A.4 Daily Email Summary (T2)

End-of-day aggregation:
- Group by category
- Count: N newsletters, N personal, N action items, N receipts
- For action-required emails: extract the specific action needed
- Send to Claude CLI on bond: "Summarize today's email activity and highlight action items"
- Store as one capture with `source: 'email-summary'`

#### 3A.5 Email Dashboard Integration

Update Email.tsx (already partially built):
- Inbound tab: show processed emails with classifications
- Summary tab: show daily summaries
- Filters: by category, date range, action status

**Acceptance Criteria:**
- [ ] IMAP fetches from both accounts reliably
- [ ] T0 classifies 80%+ of emails correctly
- [ ] Daily summary capture created by 11 PM
- [ ] Action items clearly extracted and surfaced
- [ ] Dashboard shows email activity
- [ ] LAB_NOTEBOOK entry created with classification accuracy, email volume stats, summary quality assessment, and cost per day

---

## Phase 3B: Financial Account Monitoring

**Estimated Effort:** M (~8 files, ~600 LOC)
**Dependencies:** 0B (bond/T2 ready)

### Architecture (Track B)

```
Plaid API or CSV import (T0) → Delta computation (T0, Python)
  → Daily briefing (T2, Claude CLI) → One capture/day
```

### Work Items

- Plaid API integration (or manual CSV import as fallback)
- Account connections: Schwab, Truist
- Daily delta computation: balance changes, large transactions, unusual activity
- Daily financial briefing via Claude CLI (T2)
- Alert on: balance drops > $1000, transactions > $500, unusual patterns
- Monthly trend report via Claude CLI (T2)

**Acceptance Criteria:**
- [ ] Account connections established (Plaid or CSV)
- [ ] Daily briefing capture created reliably
- [ ] Alerts trigger on thresholds
- [ ] LAB_NOTEBOOK entry created with API integration details, delta computation accuracy, alert threshold tuning, and cost per day

---

## Phase 3C: Amazon Purchase Tracking

**Estimated Effort:** S (~5 files, ~300 LOC)
**Dependencies:** 0B

### Architecture (Track B)

```
Order history export/scrape (T0) → Parse items (T0, Python)
  → Monthly analysis (T2, Claude CLI) → One capture/month
```

### Work Items

- Amazon order history export (CSV download or scraping)
- Python parsing: item name, price, category, date
- Rule-based categorization (household, electronics, books, etc.)
- Monthly analysis: spending by category, trends, unusual purchases
- Store as monthly capture

**Acceptance Criteria:**
- [ ] Order history import works reliably
- [ ] Monthly analysis capture created
- [ ] LAB_NOTEBOOK entry created with data source method, categorization accuracy, and sample output quality

---

## Phase 3D: Credit Card Categorization

**Estimated Effort:** S (~4 files, ~250 LOC)
**Dependencies:** 0B, 3B (shares Plaid infrastructure if used)

### Architecture (Track B)

```
CSV/OFX import or Plaid (T0) → Categorize (T0 lookup tables)
  → Monthly trends (T2, Claude CLI) → One capture/month
```

### Work Items

- Transaction import (CSV upload, OFX, or Plaid)
- Category lookup tables (merchant name → category mapping)
- Monthly trend analysis: spending by category, MoM changes
- Annual comparison views

**Acceptance Criteria:**
- [ ] Transaction import works from at least one source
- [ ] Monthly trend capture created
- [ ] LAB_NOTEBOOK entry created with categorization accuracy, merchant lookup table coverage, and sample trend output

---

## Phase 3E: Utility Bill Tracking

**Estimated Effort:** S (~3 files, ~200 LOC)
**Dependencies:** 0B

### Architecture (Track B)

```
PDF scrape or manual entry (T0) → Store readings (T0)
  → Monthly comparison (T2, Claude CLI) → One capture/month
```

### Work Items

- PDF bill parsing (power company, gas company formats)
- Historical data table (month, usage amount, cost)
- Monthly comparison + YoY analysis
- Alert on significant cost increases (> 20% MoM)

**Acceptance Criteria:**
- [ ] Bill parsing works for target utility formats
- [ ] Monthly comparison capture created
- [ ] LAB_NOTEBOOK entry created with parsing accuracy, sample comparison output, and alert threshold calibration

---

## Phase 3F: Financial Advisor Newsletter Assessment

**Estimated Effort:** M (~5 files, ~350 LOC)
**Dependencies:** 3A (email pipeline provides the newsletter emails)

### Architecture (Track B)

```
Email capture (existing) → Filter by advisor senders (T0)
  → Extract claims and recommendations (T0/T1) 
  → Weekly/monthly assessment (T2, Claude CLI) → Captures
```

### Work Items

- Sender filter config for known advisor newsletters
- Claim extraction: buy/sell recommendations, market predictions, risk assessments
- Track claims over time: was the prediction correct?
- Weekly assessment: summarize advisor views, cross-reference with portfolio
- Monthly scorecard: advisor accuracy tracking

**Acceptance Criteria:**
- [ ] Advisor newsletters filtered from email stream
- [ ] Weekly assessment capture created
- [ ] LAB_NOTEBOOK entry created with claim extraction quality, advisor identification accuracy, and sample assessment output

---

## Phase 3G: Doctor Lab Report Analysis

**Estimated Effort:** M (~6 files, ~400 LOC)
**Dependencies:** 0B

### Architecture (Track B)

```
PDF upload or scan (T0) → Extract test values (T0, Python regex + table parsing)
  → Longitudinal tracking (T0) → Deep analysis (T2, Claude CLI) → One capture/visit
```

### Work Items

- Lab report PDF parsing (common lab formats: Quest, LabCorp, hospital systems)
- Extract: test name, value, reference range, units, flag (H/L/normal)
- Historical tracking: table of all values over time
- Trend detection: which values are trending up/down?
- Deep analysis via Claude CLI: "Review these lab results in context of prior results, flag concerning trends, suggest questions for doctor"
- Store as capture with `brain_view: 'personal'`

**Acceptance Criteria:**
- [ ] Lab report PDF parsing works for at least 2 lab formats
- [ ] Historical tracking table populated
- [ ] Deep analysis capture created per lab visit
- [ ] LAB_NOTEBOOK entry created with parsing accuracy, trend detection results, and sample analysis quality

---

## Phase 3H: Insurance Policy Analysis

**Estimated Effort:** M (~5 files, ~350 LOC)
**Dependencies:** 0B

### Architecture (Track B)

```
PDF upload (T0) → Extract coverage details (T0, Python)
  → Comparison matrix (T0) → Gap analysis (T2, Claude CLI) → One capture
```

### Work Items

- Insurance PDF parsing (homeowner, auto, umbrella, health, life)
- Extract: coverage type, limits, deductibles, premiums, exclusions
- Build comparison matrix across all policies
- Gap analysis via Claude CLI: "Review all insurance policies, identify coverage gaps, overlapping coverage, optimization opportunities"
- Annual review reminder skill

**Acceptance Criteria:**
- [ ] Insurance PDF parsing works for target policy types
- [ ] Comparison matrix generated
- [ ] Gap analysis capture created
- [ ] LAB_NOTEBOOK entry created with parsing accuracy, coverage extraction quality, and sample gap analysis output

---

## Phase 4A: Email Outbound via Himalaya

**Estimated Effort:** M (~4 files, ~300 LOC)
**Dependencies:** 3A (email pipeline operational)

### Work Items

- Configure email.yaml with SMTP settings
- HimalayaService already implemented — wire to email_drafts table
- Two modes: auto-send (skill outputs like weekly brief) and review-required (user approves via Pushover/dashboard)
- Draft approval flow: Pushover notification → approve/edit/reject → send

**Acceptance Criteria:**
- [ ] SMTP config working via email.yaml
- [ ] Auto-send mode delivers skill outputs
- [ ] Review mode sends Pushover with approve/reject
- [ ] LAB_NOTEBOOK entry created with SMTP setup details, delivery verification, and approval flow test results

---

## Phase 4B: Dashboard & Settings Polish

**Estimated Effort:** M (~6 files, ~700 LOC)
**Dependencies:** Tiers 1-2 substantially complete

### Work Items

- System.tsx: 5 sub-tabs (Queues, Skills, Flows, Infrastructure, MCP Activity)
- Settings.tsx: AI routing, voice, wiki, email, integrations sections
- VoiceConversations.tsx: session list, playback controls
- Related captures component (spreading activation results for each capture)
- Financial dashboard tab (if 3B-3E are built)

**Acceptance Criteria:**
- [ ] All System sub-tabs render with real data
- [ ] Settings sections expanded for all new features
- [ ] No JavaScript errors on any page
- [ ] LAB_NOTEBOOK entry created with UI verification results, screenshots of new pages, and any UX issues found

---

## Phase 4C: Cognitive Memory Tuning

**Estimated Effort:** S (~3 files)
**Dependencies:** Accumulated usage data (50+ search sessions)

### Work Items

- Tune Hebbian association boost weight based on real co-access patterns
- Monitor memory consolidation skill quality across 3+ Sunday runs
- Build "Related captures" component in CaptureDetail using spreading activation
- Adjust temporal decay weight (currently 0.0, ramp up as search history builds)

**Acceptance Criteria:**
- [ ] Hebbian weight tuned from real co-access data
- [ ] Consolidation skill quality validated across 3+ runs
- [ ] Related captures component showing useful results
- [ ] LAB_NOTEBOOK entry created with weight tuning rationale, consolidation quality examples, and temporal decay analysis

---

## Phase 5A: NVIDIA RTX PRO 2000 Blackwell (Optional)

**Estimated Effort:** Hardware purchase + operational setup
**Dependencies:** None — accelerates everything when available

### Impact

- **$549** at Micro Center (PNY NVIDIA RTX PRO 2000 Blackwell)
- 16GB GDDR7, 70W TDP, single-slot
- Run Qwen 3.5 9B for T1 on homeserver (<500ms, vs Jetson's 670ms)
- Run nomic-embed-text for local embeddings (<50ms, vs OpenAI's 200ms + $2-5/month)
- Eliminates Jetson dependency for T1 (Jetson becomes backup/edge)
- Eliminates OpenAI embedding costs ($2-5/month savings)
- Makes inline pipeline T1 classification viable without network hop
- Pure ROI: ~6 years at current spend, but removes cost anxiety for all high-volume features

### Decision Point

Revisit after Tier 3 data sources are operational and monthly costs are clearer. If API costs are trending above $20/month, the GPU pays for itself faster.

**Acceptance Criteria:**
- [ ] GPU installed and recognized by system
- [ ] Qwen 3.5 9B running with <500ms classification
- [ ] nomic-embed-text running with <50ms embedding
- [ ] OpenAI embedding calls eliminated
- [ ] LAB_NOTEBOOK entry created with installation details, benchmark results vs. prior tiers, and cost impact analysis

<!-- END PHASES -->

---

## Execution Timeline

### Immediate (This Session + Next 1-2 Sessions)

| Item | What | Who |
|------|------|-----|
| 0A | Wire Jetson T1 endpoint | Claude Code (code changes) |
| 0B | Set up bond with Claude CLI | Troy + Claude Code (operational) |
| 0D | Start Pipecat voice soak | Troy (manual, 2 weeks) |

### Near-Term (Weeks 1-4)

| Item | What | Blocked By |
|------|------|------------|
| 1A | Complete three-tier routing | 0A |
| 2A | Wiki infrastructure activation | Deployed |
| 0C | Check OneDrive sync status | In progress |
| 1B | Slack auto-response completion | 1A |
| 1C | Voice container promotion | 0D |

### Mid-Term (Weeks 4-8)

| Item | What | Blocked By |
|------|------|------------|
| 2B | OneDrive file migration tooling | 0C, 2A |
| 3A | Email inbox processing | 0B, 1A |
| 2C | Wiki construction (runs in background) | 2B |

### Longer-Term (Weeks 8+)

| Item | What | Blocked By |
|------|------|------------|
| 3B-3H | Additional data sources (one at a time) | 0B |
| 4A | Email outbound | 3A |
| 4B | Dashboard polish | Tiers 1-2 |
| 4C | Memory tuning | Usage data |
| 5A | GPU purchase | Decision point |

---

## Monthly Cost Projections

### Current (v1.5.0)

| Component | Monthly Cost |
|-----------|-------------|
| Claude Max subscription | $100-200 (fixed) |
| OpenAI API (embeddings + LLM) | ~$10-15 |
| Deepgram (voice) | ~$2-5 |
| **Total beyond subscription** | **~$12-20** |

### After Tier 0-1 Complete (Jetson T1 + Bond T2)

| Component | Monthly Cost |
|-----------|-------------|
| Claude Max subscription | $100-200 (fixed) |
| OpenAI API (embeddings only + real-time queries) | ~$5-8 |
| Deepgram (voice) | ~$2-5 |
| Jetson power | ~$2 |
| **Total beyond subscription** | **~$9-15** |

### After All Batch Sources (Tier 3 Complete)

| Component | Monthly Cost |
|-----------|-------------|
| Claude Max subscription | $100-200 (fixed) |
| OpenAI API (embeddings + real-time only) | ~$5-10 |
| Deepgram (voice) | ~$2-5 |
| Plaid API (financial) | ~$0-5 |
| Jetson power | ~$2 |
| **Total beyond subscription** | **~$9-22** |

### After GPU (Optional, Phase 5A)

| Component | Monthly Cost |
|-----------|-------------|
| Claude Max subscription | $100-200 (fixed) |
| OpenAI API (real-time queries only) | ~$3-5 |
| Deepgram (voice) | ~$2-5 |
| Plaid API | ~$0-5 |
| GPU power (70W) | ~$5 |
| **Total beyond subscription** | **~$10-20** |

---

## Success Metrics

| Metric | Target | When |
|--------|--------|------|
| T1 classification latency | < 2s via Jetson | Phase 0A |
| T2 synthesis available | Bond running `claude --print` | Phase 0B |
| API cost reduction | 30%+ from pre-tiering baseline | Phase 1A |
| Daily capture rate | 5+ across all inputs | Phase 3A+ |
| Email processing | Daily summary by 11 PM | Phase 3A |
| Wiki coverage | 90% of OneDrive files have wiki pages | Phase 2C |
| Monthly API cost | < $25 beyond subscription | All phases |
| System uptime | 99%+ excluding maintenance | Ongoing |
| Voice latency | < 2s round-trip | Phase 0D |

---

*Master plan generated 2026-04-12 by Claude Code*
*Source: PRD-UNIFIED.md, IMPLEMENT_UNIFIED.md, LAB_NOTEBOOK entries 029-031, cost-tiering discussion*
