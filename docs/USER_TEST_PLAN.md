# Open Brain User Test Plan

## Context

The Open Brain project has completed all 16 implementation phases (~11,100 lines of code). This test plan provides a structured, user-focused approach to validate the system end-to-end. The goal is to verify all input channels, processing pipelines, search capabilities, and AI-powered skills work correctly from a user's perspective.

---

## Prerequisites Checklist

Before testing, ensure:

- [ ] Bitwarden secrets loaded: `source ./scripts/load-secrets.sh`
- [ ] LiteLLM proxy running at `https://llm.k4jda.net` with `jetson-embeddings` alias working
- [ ] Database migrations applied: `./scripts/migrate.sh`
- [ ] All containers started: `docker compose up -d`
- [ ] Wait 30-60 seconds for services to initialize

---

## Phase 1: System Health Verification (5 min)

### 1.1 Container Health
```bash
docker compose ps
# All 9 containers should show "healthy" or "running"
```

### 1.2 Service Endpoints
```bash
# Core API
curl http://localhost:3000/health
# Expected: {"status":"ok","services":{"database":"connected","redis":"connected"}}

# Voice Capture
curl http://localhost:3001/health
# Expected: {"status":"ok"}

# faster-whisper
curl http://localhost:10300/v1/models
# Expected: JSON with model info

# Web Dashboard
curl -I http://localhost:5173
# Expected: HTTP 200

# Bull Board (Queue Monitor)
open http://localhost:3000/admin/queues
# Expected: BullMQ dashboard with capture-pipeline, document-pipeline queues
```

### 1.3 LiteLLM Connectivity
```bash
curl -X POST https://llm.k4jda.net/embeddings \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"jetson-embeddings","input":"test embedding"}'
# Expected: 768-dimensional embedding vector
```

---

## Phase 2: Capture Input Channels (15 min)

### 2.1 API Direct Capture
Create a test capture via REST API:
```bash
curl -X POST http://localhost:3000/api/v1/captures \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Testing API capture: Decided to use Drizzle ORM instead of Prisma for better TypeScript integration",
    "type": "decision",
    "brain_view": "technical",
    "source": "api-test"
  }'
# Expected: 201 Created with capture ID
# Save the ID: export CAPTURE_ID=<returned-id>
```

Verify capture stored:
```bash
curl http://localhost:3000/api/v1/captures/$CAPTURE_ID
# Expected: Full capture object with metadata
```

### 2.2 Test All 8 Capture Types
Create one capture of each type:
| Type | Test Content |
|------|-------------|
| `decision` | "Decided to deploy on Unraid instead of cloud" |
| `idea` | "What if we added calendar integration?" |
| `observation` | "LiteLLM latency averaging 200ms" |
| `task` | "Need to set up weekly brief email template" |
| `win` | "Successfully completed all 16 implementation phases" |
| `blocker` | "Waiting on Jetson device for embedding service" |
| `question` | "Should we add OAuth for MCP endpoint?" |
| `reflection` | "Building this system helped clarify my workflow patterns" |

### 2.3 Test All 5 Brain Views
Create captures for each view:
| View | Test Content |
|------|-------------|
| `career` | "Career goal: become principal engineer in 3 years" |
| `personal` | "Started morning meditation habit" |
| `technical` | "Learned about pgvector HNSW indexing" |
| `work-internal` | "Team standup moved to 10am" |
| `client` | "Client ABC requested API documentation" |

---

## Phase 3: Pipeline Processing Verification (10 min)

### 3.1 Monitor Pipeline Status
After creating captures, verify pipeline processing:
```bash
# Check capture moved to 'complete' status
curl http://localhost:3000/api/v1/captures/$CAPTURE_ID | jq '.pipeline_status'
# Expected: "complete" (may take 10-30 seconds)

# If status is 'pending' or 'processing', wait and retry
```

### 3.2 Verify Embedding Generated
```bash
curl http://localhost:3000/api/v1/captures/$CAPTURE_ID | jq '.embedding | length'
# Expected: 768 (vector dimension)
```

### 3.3 Check Pipeline Events (Audit Trail)
```bash
curl "http://localhost:3000/api/v1/captures/$CAPTURE_ID/events"
# Expected: Events for embed-capture, extract-entities, link-entities, check-triggers, notify
```

### 3.4 Monitor Queue Status
Visit http://localhost:3000/admin/queues
- Verify `capture-pipeline` queue shows completed jobs
- Check for any failed jobs and review error messages

---

## Phase 4: Search Functionality (10 min)

### 4.1 Basic Semantic Search
```bash
curl -X POST http://localhost:3000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "database decisions"}'
# Expected: Returns captures mentioning Drizzle, Postgres, database choices
```

### 4.2 Filtered Search (by brain view)
```bash
curl -X POST http://localhost:3000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "goals", "brain_view": "career"}'
# Expected: Only career-related captures
```

### 4.3 Filtered Search (by type)
```bash
curl -X POST http://localhost:3000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "goals", "type": "decision"}'
# Expected: Only decision-type captures
```

### 4.4 Search via Web Dashboard
1. Open http://localhost:5173
2. Use search box to query "implementation phases"
3. Verify results display with match percentages
4. Test filter dropdowns (brain view, type)

---

## Phase 5: Slack Integration (10 min)

### 5.1 Prerequisites
- Slack app installed to workspace
- Bot added to #open-brain channel (or designated test channel)
- Socket Mode connected (check container logs: `docker logs slack-bot`)

### 5.2 Capture via Slack
Post in Slack channel:
```
@openbrain Just learned about BullMQ's powerful retry mechanisms
```
- Expected: Bot reacts with checkmark emoji
- Expected: Pushover notification to phone
- Verify via API: `curl http://localhost:3000/api/v1/captures?source=slack&limit=1`

### 5.3 Query via Slack
Post in Slack channel:
```
@openbrain ? database decisions
```
- Expected: Bot responds with ranked search results
- Results should include match percentages

### 5.4 Slash Commands
Test available slash commands:
```
/brief       # Should describe weekly brief or trigger generation
/bet         # Should show bet tracking interface
```

---

## Phase 6: Voice Capture (10 min)

### 6.1 Direct Voice Endpoint Test
```bash
# Create a test audio file or use existing
curl -X POST http://localhost:3001/api/v1/voice \
  -F "audio=@test-audio.m4a" \
  -F "source=test"
# Expected: 200 OK with capture ID
```

### 6.2 iOS Shortcut Test
1. Open Shortcuts app on iPhone/Apple Watch
2. Run "Open Brain Capture" shortcut
3. Speak a test message (e.g., "This is a test voice capture about project planning")
4. Wait for Pushover notification confirming capture
5. Verify via API: `curl http://localhost:3000/api/v1/captures?source=voice&limit=1`

### 6.3 Transcription Quality Check
```bash
# Review transcribed content
curl http://localhost:3000/api/v1/captures?source=voice&limit=1 | jq '.[0].content'
# Verify transcription accuracy
```

---

## Phase 7: Document Ingestion (10 min)

### 7.1 PDF Upload
```bash
curl -X POST http://localhost:3000/api/v1/documents \
  -F "file=@test-document.pdf" \
  -F "brain_view=technical"
# Expected: 202 Accepted with job ID
```

### 7.2 DOCX Upload
```bash
curl -X POST http://localhost:3000/api/v1/documents \
  -F "file=@test-document.docx" \
  -F "brain_view=work-internal"
# Expected: 202 Accepted with job ID
```

### 7.3 Verify Document Processing
Check `document-pipeline` queue in Bull Board:
- Job should complete
- Multiple captures created (one per chunk)
- Search should return document content

---

## Phase 8: Entity Tracking (10 min)

### 8.1 View Extracted Entities
```bash
curl http://localhost:3000/api/v1/entities
# Expected: List of people, projects, organizations extracted from captures
```

### 8.2 View Entity Details
```bash
curl http://localhost:3000/api/v1/entities/<entity-id>
# Expected: Entity metadata + linked captures
```

### 8.3 Merge Duplicate Entities
```bash
curl -X POST http://localhost:3000/api/v1/entities/merge \
  -H "Content-Type: application/json" \
  -d '{"source_ids": ["entity-1", "entity-2"], "target_name": "John Smith"}'
# Expected: Entities merged, captures relinked
```

### 8.4 Web Dashboard Entity View
1. Open http://localhost:5173/entities
2. Browse entity list
3. Click entity to see linked captures
4. Verify entity timeline visualization

---

## Phase 9: AI-Powered Skills (15 min)

### 9.1 Manual Weekly Brief Generation
```bash
curl -X POST http://localhost:3000/api/v1/skills/weekly-brief/execute
# Expected: 202 Accepted, brief generation queued
```

Wait for completion, then:
```bash
curl http://localhost:3000/api/v1/briefs?limit=1
# Expected: Generated brief with wins, blockers, open loops, focus areas
```

### 9.2 View Brief in Web Dashboard
1. Open http://localhost:5173/briefs
2. Review latest weekly brief
3. Verify sections: wins, blockers, risks, focus areas

### 9.3 Governance Session
```bash
# Start a governance session
curl -X POST http://localhost:3000/api/v1/sessions \
  -H "Content-Type: application/json" \
  -d '{"type": "governance", "brain_view": "career"}'
# Expected: Session created with initial LLM message
```

Continue session interactively via Slack or API.

### 9.4 Bet Tracking
```bash
# List active bets
curl http://localhost:3000/api/v1/bets

# Create a bet manually
curl -X POST http://localhost:3000/api/v1/bets \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Complete user testing by end of March 2026",
    "due_date": "2026-03-31",
    "brain_view": "career"
  }'
```

---

## Phase 10: MCP Endpoint (10 min)

### 10.1 MCP Health Check
```bash
curl http://localhost:3000/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN"
# Expected: MCP protocol response
```

### 10.2 Claude Desktop Integration
1. Configure Claude Desktop to connect to `https://brain.k4jda.net/mcp`
2. Set Bearer token in MCP configuration
3. Test MCP tools:
   - `search`: Query captures
   - `get_capture`: Retrieve specific capture
   - `list_captures`: Browse recent captures
   - `create_capture`: Add new capture
   - `get_brief`: Retrieve weekly brief
   - `list_entities`: Browse entities

### 10.3 Read-Only vs Read-Write Mode
- Default should be read-only
- Test write operations require explicit permission

---

## Phase 11: Notifications (5 min)

### 11.1 Pushover Notification Test
```bash
# Trigger a test notification
curl -X POST http://localhost:3000/api/v1/admin/test-notification
# Expected: Pushover notification on phone
```

### 11.2 Email Notification Test
```bash
# Trigger test email (if configured)
curl -X POST http://localhost:3000/api/v1/admin/test-email
# Expected: Email received
```

---

## Phase 12: Web Dashboard Comprehensive Test (10 min)

### 12.1 Dashboard Page
- [ ] Stats cards display correctly (total captures, by view, by type)
- [ ] Recent captures list loads
- [ ] Real-time updates via SSE (create capture via API, see it appear)

### 12.2 Search Page
- [ ] Search box works
- [ ] Filters apply correctly
- [ ] Results show match percentages
- [ ] Pagination works

### 12.3 Timeline Page
- [ ] Captures display chronologically
- [ ] Filter by date range works

### 12.4 Entities Page
- [ ] Entity list loads
- [ ] Entity detail view shows linked captures
- [ ] Merge/split operations available

### 12.5 Briefs Page
- [ ] Weekly briefs list
- [ ] Brief detail view renders correctly

---

## Phase 13: Error Handling & Edge Cases (10 min)

### 13.1 Invalid Input Handling
```bash
# Empty content
curl -X POST http://localhost:3000/api/v1/captures \
  -H "Content-Type: application/json" \
  -d '{"content": "", "type": "decision"}'
# Expected: 400 Bad Request

# Invalid type
curl -X POST http://localhost:3000/api/v1/captures \
  -H "Content-Type: application/json" \
  -d '{"content": "test", "type": "invalid-type"}'
# Expected: 400 Bad Request
```

### 13.2 LiteLLM Unavailable
- Temporarily disable LiteLLM access
- Create capture
- Verify capture queued (not lost)
- Re-enable LiteLLM
- Verify pipeline completes via retry

### 13.3 Duplicate Detection
- Post same Slack message twice
- Verify duplicate is rejected

---

## Phase 14: Performance Baseline (5 min)

### 14.1 Search Latency
```bash
time curl -X POST http://localhost:3000/api/v1/search \
  -H "Content-Type: application/json" \
  -d '{"query": "test query"}'
# Expected: <5 seconds
```

### 14.2 Capture Creation Latency
```bash
time curl -X POST http://localhost:3000/api/v1/captures \
  -H "Content-Type: application/json" \
  -d '{"content": "latency test", "type": "observation"}'
# Expected: <1 second for API response (pipeline runs async)
```

---

## Test Completion Checklist

| Phase | Status | Notes |
|-------|--------|-------|
| 1. System Health | ☐ | |
| 2. Capture Input | ☐ | |
| 3. Pipeline Processing | ☐ | |
| 4. Search | ☐ | |
| 5. Slack Integration | ☐ | |
| 6. Voice Capture | ☐ | |
| 7. Document Ingestion | ☐ | |
| 8. Entity Tracking | ☐ | |
| 9. AI Skills | ☐ | |
| 10. MCP Endpoint | ☐ | |
| 11. Notifications | ☐ | |
| 12. Web Dashboard | ☐ | |
| 13. Error Handling | ☐ | |
| 14. Performance | ☐ | |

---

## Quick E2E Smoke Test (5 min)

For daily verification, run the existing E2E script:
```bash
./scripts/e2e-full.sh
```

This automates basic health + capture + search + pipeline verification.

---

## Troubleshooting

### Common Issues

1. **Pipeline stuck in 'pending'**
   - Check LiteLLM connectivity
   - Review worker logs: `docker logs workers`
   - Check Bull Board for failed jobs

2. **Slack bot not responding**
   - Verify socket mode connected: `docker logs slack-bot`
   - Check Slack app permissions

3. **Search returns no results**
   - Ensure captures have `pipeline_status: complete`
   - Verify embeddings generated (768-dim vector present)

4. **Voice capture fails**
   - Check faster-whisper logs: `docker logs faster-whisper`
   - Verify audio format compatibility (m4a, wav, mp3)
