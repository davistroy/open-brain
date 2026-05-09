# Open Brain — User Test Plan

**Date:** 2026-05-09
**Version:** 1.0
**Scope:** Full-system manual validation of the deployed Open Brain personal AI knowledge infrastructure.
**Tester:** Troy Davis
**Target deployment:** https://brain.troy-davis.com (homeserver, 13 containers)

---

## Prerequisites

Before starting:

- [ ] All 13 Docker containers healthy on homeserver: `docker ps --filter name=open-brain` — no `Exited` or `Restarting` entries
- [ ] Postgres reachable: `docker exec open-brain-postgres psql -U openbrain -c '\dt' | wc -l` — expect 20+ tables
- [ ] Redis reachable: `docker exec open-brain-redis redis-cli ping` — expect `PONG`
- [ ] core-api responding: `curl -s https://brain.troy-davis.com/api/v1/captures?limit=1 | jq '.total'` — expect a number
- [ ] At least 10 captures exist in the system (enough to exercise search, entities, etc.)
- [ ] Slack bot is online (check `@OpenBrain` responds to DM `!ping`)
- [ ] iOS Shortcut for voice capture is installed and pointing to voice-capture service
- [ ] MCP bearer token (`MCP_API_KEY`) known — needed for MCP tool tests
- [ ] `ADMIN_KEY` env var known for config-reload test (check `.env.secrets` on homeserver)
- [ ] Browser: Chrome or Firefox at https://brain.troy-davis.com

---

## Pass/Fail Key

| Symbol | Meaning |
|--------|---------|
| `[ ]` | Not yet tested |
| `[P]` | Pass |
| `[F]` | Fail — note actual behavior |
| `[S]` | Skip — not applicable or dependency unavailable |

---

## Section 1 — Web Dashboard: Navigation & Layout

### WD-01 — Dashboard loads without error
**Steps:**
1. Open https://brain.troy-davis.com in browser
2. Observe page title, stat strip, and main content area

**Expected:** Page loads with "Good morning, Troy" heading. StatStrip shows at least 4 metrics (total captures, captures this week, open questions, pipeline status). No JS console errors.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### WD-02 — Navigation sidebar renders all sections
**Steps:**
1. On any page, locate the left sidebar
2. Verify all nav items are present: Dashboard, Search, Timeline, Captures, Entities, Board, Briefs, Intelligence, Wiki, Email, Financial, Investments, Ingest, Voice, System, Settings, Help

**Expected:** All items visible and clickable. Active item highlighted.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### WD-03 — Dashboard empty state (skip if data present)
**Steps:**
1. Only test if total_captures = 0 (fresh install)
2. Navigate to https://brain.troy-davis.com/dashboard

**Expected:** DashboardEmptyState component displayed instead of stat strip + columns.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### WD-04 — Quick Capture widget
**Steps:**
1. On Dashboard (https://brain.troy-davis.com/dashboard), locate the QuickCapture widget
2. Type a test thought: `Test capture from user test plan 2026-05-09`
3. Select capture type from dropdown (e.g., `observation`)
4. Click Submit / Capture button

**Expected:** Success confirmation. New capture appears in Recent Captures list within a few seconds. No error toast.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### WD-05 — Recent Captures widget shows latest entries
**Steps:**
1. On Dashboard, observe RecentCaptures widget
2. Confirm at least one entry shows with: content preview, date, type badge, source badge

**Expected:** Entries present, sorted newest-first. Each card is clickable.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### WD-06 — Open Questions widget
**Steps:**
1. On Dashboard, observe OpenQuestions widget (right column)
2. If questions exist: click one to navigate to its capture detail

**Expected:** Widget displays up to 4 unresolved question-type captures. Clicking navigates to `/captures/<id>`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### WD-07 — Upcoming Briefs widget
**Steps:**
1. On Dashboard, observe UpcomingBriefs widget (right column)
2. If briefs exist: click one brief title

**Expected:** Widget shows up to 3 recent briefs with title and date. Click navigates to `/briefs/<id>`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### WD-08 — Offline page
**Steps:**
1. Navigate to https://brain.troy-davis.com/offline

**Expected:** Offline/fallback page renders. No blank screen.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 2 — Captures: Create, View, Browse

### CAP-01 — Create capture via API (POST)
**Steps:**
1. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/captures -H 'Content-Type: application/json' -d '{"content":"API test capture","capture_type":"idea","brain_view":"technical","source":"api"}' | jq`

**Expected:** HTTP 201. Response body contains `id` (UUID), `pipeline_status` (e.g., `pending`), `created_at`. No `content` or `tags` in the 201 response (by design).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### CAP-02 — Get full capture by ID
**Steps:**
1. Copy the `id` from CAP-01
2. Run: `curl -s https://brain.troy-davis.com/api/v1/captures/<id> | jq`

**Expected:** Full capture object including `content`, `capture_type`, `brain_view`, `source`, `pipeline_status`, `tags`, `metadata`, `captured_at`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### CAP-03 — List captures with filters
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/captures?limit=5&capture_type=idea' | jq`

**Expected:** Response shape `{ items: [...], total: N, limit: 5, offset: 0 }`. All items have `capture_type = "idea"`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### CAP-04 — List captures with brain_view filter
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/captures?brain_view=technical&limit=5' | jq '.items | length'`

**Expected:** Returns a number (0 or more). No error.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### CAP-05 — Update capture tags via PATCH
**Steps:**
1. Use capture ID from CAP-01
2. Run: `curl -s -X PATCH https://brain.troy-davis.com/api/v1/captures/<id> -H 'Content-Type: application/json' -d '{"tags":["test","userplan"]}' | jq .tags`

**Expected:** Response contains `["test","userplan"]`. HTTP 200.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### CAP-06 — Soft-delete capture
**Steps:**
1. Create a throwaway capture (like CAP-01 with content "DELETE ME")
2. Note its ID. Run: `curl -s -o /dev/null -w "%{http_code}" -X DELETE https://brain.troy-davis.com/api/v1/captures/<id>`

**Expected:** HTTP 204 No Content. Subsequent GET for that ID returns 404 (soft-deleted).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### CAP-07 — Retry failed capture
**Steps:**
1. Find a capture with `pipeline_status = "failed"` (if any): `curl -s 'https://brain.troy-davis.com/api/v1/captures?pipeline_status=failed&limit=1' | jq '.items[0].id'`
2. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/captures/<id>/retry | jq`

**Expected:** HTTP 200. Response contains `id`, `pipeline_status`, `retried_at`. No 404 or 500.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### CAP-08 — Invalid brain_view rejected
**Steps:**
1. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/captures -H 'Content-Type: application/json' -d '{"content":"test","capture_type":"idea","brain_view":"invalid_view"}' | jq`

**Expected:** HTTP 400. Error message mentions `brain_view` or lists valid values.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### CAP-09 — Captures list page in UI (Timeline)
**Steps:**
1. Navigate to https://brain.troy-davis.com/timeline
2. Observe capture cards loading
3. Test brain_view filter (click a view tab, e.g., "technical")
4. Test source filter (select "slack" from dropdown if Slack captures exist)

**Expected:** Capture cards render with content preview, type badge, date, source. Filtering updates the list. Infinite scroll loads more when scrolling to bottom.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### CAP-10 — Capture detail page in UI
**Steps:**
1. Navigate to https://brain.troy-davis.com/captures
2. Click any capture card to open detail at `/captures/<id>`
3. Verify full content visible, tags, brain_view, pipeline events section

**Expected:** Full capture content displayed. Pipeline events/stages shown with timestamps. Edit tags inline if supported.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 3 — Search

### SRCH-01 — Basic search via GET
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/search?q=test&limit=5' | jq`

**Expected:** Response shape `{ query: "test", total: N, results: [{ capture: {...}, score: N }] }`. Note: results is an array of objects with `capture` and `score` fields, not a flat captures array.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SRCH-02 — Hybrid search mode (default)
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/search?q=decision&search_mode=hybrid&limit=5' | jq '.results | length'`

**Expected:** Returns 0 or more results. No error. Results sorted by relevance score descending.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SRCH-03 — Vector-only search mode
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/search?q=something+important&search_mode=vector&limit=5' | jq '.results[0].score'`

**Expected:** Returns float score between 0 and 1. No error.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SRCH-04 — FTS-only search mode
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/search?q=test&search_mode=fts&limit=5' | jq`

**Expected:** Results contain text matches. Score field present.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SRCH-05 — Search with include_related (spreading activation)
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/search?q=project&include_related=true&limit=5' | jq 'keys'`

**Expected:** Response includes `results` array. May also include `related_results` if related captures found via entity graph.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SRCH-06 — Search with brain_views filter
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/search?q=test&brain_views=technical,career&limit=5' | jq '.results[].capture.brain_view' | sort -u`

**Expected:** All returned capture brain_views are only `technical` or `career`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SRCH-07 — Search with date filter
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/search?q=test&date_from=2026-01-01T00:00:00.000Z&limit=5' | jq '.results | length'`

**Expected:** Returns 0 or more results, all with `captured_at >= 2026-01-01`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SRCH-08 — POST search (JSON body)
**Steps:**
1. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/search -H 'Content-Type: application/json' -d '{"query":"weekly","limit":5,"search_mode":"hybrid","temporal_weight":0.1,"fts_weight":0.5,"vector_weight":0.5,"include_related":false}' | jq '.total'`

**Expected:** Returns integer. HTTP 200.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SRCH-09 — Search UI page
**Steps:**
1. Navigate to https://brain.troy-davis.com/search
2. Type a query in the search box (e.g., `decision`)
3. Observe results rendering
4. Check if synthesis answer card appears above results for question-like queries

**Expected:** Results render with score badges, capture type, date. For question-like queries (`what is...`), an AI synthesis card appears at top.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SRCH-10 — Empty search (q missing) returns 400
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" 'https://brain.troy-davis.com/api/v1/search'`

**Expected:** HTTP 400. Query param `q` is required.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 4 — Documents

### DOC-01 — Upload a plain text document
**Steps:**
1. Create a test file: `echo "This is a test document for Open Brain user testing 2026-05-09." > /tmp/test-doc.txt`
2. Upload: `curl -s -X POST https://brain.troy-davis.com/api/v1/documents -F "file=@/tmp/test-doc.txt" -F "brain_view=technical" -F "tags=test,userplan" | jq`

**Expected:** HTTP 201. Response contains `capture_id`, `filename`, `mime_type`, `pipeline_status`, `brain_view = "technical"`, `tags = ["test","userplan"]`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### DOC-02 — Duplicate document title returns 409
**Steps:**
1. Upload the same file twice using an explicit title override:
   - First: `curl -s -X POST https://brain.troy-davis.com/api/v1/documents -F "file=@/tmp/test-doc.txt" -F "title=My Unique Document Title" | jq .capture_id`
   - Second (same title): `curl -s -o /dev/null -w "%{http_code}" -X POST https://brain.troy-davis.com/api/v1/documents -F "file=@/tmp/test-doc.txt" -F "title=My Unique Document Title"`

**Expected:** First upload: 201. Second upload: 409 Conflict (title hash collision — `[Document] My Unique Document Title` already exists).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### DOC-03 — Upload unsupported file type rejected
**Steps:**
1. Create a dummy file: `echo "test" > /tmp/test.exe`
2. Upload: `curl -s -o /dev/null -w "%{http_code}" -X POST https://brain.troy-davis.com/api/v1/documents -F "file=@/tmp/test.exe"`

**Expected:** HTTP 400. Error message mentions unsupported file type. Supported: PDF, DOCX, DOC, MD, TXT, HTML.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### DOC-04 — Upload Markdown document
**Steps:**
1. Create: `echo "# Test Markdown\n\nThis is **bold** content for testing." > /tmp/test.md`
2. Upload: `curl -s -X POST https://brain.troy-davis.com/api/v1/documents -F "file=@/tmp/test.md" -F "brain_view=personal" | jq .pipeline_status`

**Expected:** HTTP 201. `pipeline_status` starts as `pending`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### DOC-05 — Document pipeline processes file
**Steps:**
1. Wait 30–60 seconds after DOC-01
2. Check pipeline status: `curl -s https://brain.troy-davis.com/api/v1/captures/<capture_id_from_DOC-01> | jq .pipeline_status`

**Expected:** `pipeline_status` has advanced from `pending` to `embedded` or `complete`. If still `pending`, wait another minute and check again.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### DOC-06 — Ingest UI page loads
**Steps:**
1. Navigate to https://brain.troy-davis.com/ingest
2. Observe the page content

**Expected:** Ingest page loads. File upload UI or ingest trigger controls visible.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 5 — Entities

### ENT-01 — List entities
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/entities?limit=10' | jq`

**Expected:** Response shape `{ items: [...], total: N, limit: 10, offset: 0 }`. Each entity has `id`, `name`, `type`, `mention_count`, `last_seen`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ENT-02 — Filter entities by type
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/entities?type_filter=person&limit=10' | jq '.items[].type' | sort -u`

**Expected:** All returned items have `type = "person"`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ENT-03 — Sort entities by last_seen
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/entities?sort_by=last_seen&limit=5' | jq '.items[].last_seen'`

**Expected:** Dates returned in descending order (most recent first). No error.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ENT-04 — Lookup entity by name
**Steps:**
1. Pick an entity name from ENT-01 output (e.g., "OpenAI")
2. Run: `curl -s 'https://brain.troy-davis.com/api/v1/entities?name=OpenAI' | jq .entity.name`

**Expected:** Returns single entity with matching name. HTTP 200.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ENT-05 — Entity detail with linked captures
**Steps:**
1. Get an entity ID from ENT-01
2. Run: `curl -s https://brain.troy-davis.com/api/v1/entities/<id> | jq '{name: .entity.name, captures: (.linked_captures | length)}'`

**Expected:** Entity detail plus array of linked captures sorted by recency.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ENT-06 — Entity UI page
**Steps:**
1. Navigate to https://brain.troy-davis.com/entities
2. Observe entity list with type filters
3. Click an entity to open detail at `/entities/<id>`

**Expected:** Entity list loads. Type filter chips update list. Detail page shows entity info and linked captures.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ENT-07 — Entity extraction from new capture
**Steps:**
1. Create a capture with named entities: `curl -s -X POST https://brain.troy-davis.com/api/v1/captures -H 'Content-Type: application/json' -d '{"content":"Met with Anthropic CEO Dario Amodei to discuss Claude deployment at Acme Corp","capture_type":"observation","brain_view":"work-internal"}' | jq .id`
2. Wait 60–90 seconds for pipeline to complete
3. Check entities: `curl -s 'https://brain.troy-davis.com/api/v1/entities?name=Anthropic' | jq`

**Expected:** After pipeline completes, "Anthropic" and/or "Acme Corp" appear as entities. May take up to 2 minutes.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 6 — Sessions (Governance, Review, Planning)

### SESS-01 — Create governance session
**Steps:**
1. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/sessions -H 'Content-Type: application/json' -d '{"type":"governance"}' | jq`

**Expected:** HTTP 201. Response contains `session` object (`id`, `session_type = "governance"`, `status = "active"`) and `first_message` string.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-02 — Create planning session
**Steps:**
1. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/sessions -H 'Content-Type: application/json' -d '{"type":"planning"}' | jq .session.session_type`

**Expected:** Returns `"planning"`. HTTP 201.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-03 — Create review session
**Steps:**
1. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/sessions -H 'Content-Type: application/json' -d '{"type":"review"}' | jq .session.session_type`

**Expected:** Returns `"review"`. HTTP 201.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-04 — Invalid session type returns 400
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" -X POST https://brain.troy-davis.com/api/v1/sessions -H 'Content-Type: application/json' -d '{"type":"invalid_type"}'`

**Expected:** HTTP 400. Error mentions valid types: governance, review, planning.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-05 — List sessions
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/sessions?limit=5' | jq`

**Expected:** Response `{ items: [...], total: N, limit: 5, offset: 0 }`. Each session has `id`, `session_type`, `status`, `created_at`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-06 — List sessions with status_filter
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/sessions?status_filter=active' | jq '.items[].status' | sort -u`

**Expected:** All returned sessions have `status = "active"`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-07 — Invalid status_filter returns 400
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" 'https://brain.troy-davis.com/api/v1/sessions?status_filter=bogus'`

**Expected:** HTTP 400. Error message lists valid values: active, paused, complete, abandoned.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-08 — Get session by UUID
**Steps:**
1. Use session ID from SESS-01
2. Run: `curl -s https://brain.troy-davis.com/api/v1/sessions/<id> | jq '.session.id'`

**Expected:** Returns session object with transcript. HTTP 200.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-09 — Non-UUID session ID returns 400 (not 500)
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" https://brain.troy-davis.com/api/v1/sessions/not-a-valid-uuid`

**Expected:** HTTP 400 (not 500). Error: "id must be a valid UUID".

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-10 — Respond to session
**Steps:**
1. Use active session from SESS-01
2. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/sessions/<id>/respond -H 'Content-Type: application/json' -d '{"message":"What decisions are pending this week?"}' | jq .bot_message`

**Expected:** Returns bot_message string (AI response). Session `turn_count` increments. May take 5–10 seconds (LLM call).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-11 — Pause and resume session
**Steps:**
1. Pause active session: `curl -s -X POST https://brain.troy-davis.com/api/v1/sessions/<id>/pause | jq .session.status`
2. Verify status = `"paused"`
3. Resume: `curl -s -X POST https://brain.troy-davis.com/api/v1/sessions/<id>/resume | jq .session.status`
4. Verify status = `"active"` again

**Expected:** Pause returns `"paused"`. Resume returns `"active"` and a `context_message` summarizing the session so far.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-12 — Complete session with summary
**Steps:**
1. Use an active session (create new one with SESS-01 if needed)
2. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/sessions/<id>/complete | jq '{status: .session.status, has_summary: (.summary != null)}'`

**Expected:** `status = "complete"`, `has_summary = true`. Summary is a string.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SESS-13 — Abandon session
**Steps:**
1. Create a fresh governance session
2. Abandon immediately: `curl -s -X POST https://brain.troy-davis.com/api/v1/sessions/<id>/abandon | jq .session.status`

**Expected:** Returns `"abandoned"`. HTTP 200.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 7 — Weekly Briefs

### BR-01 — List briefs
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/briefs?limit=5' | jq`

**Expected:** Response contains `items` array and `total`. Each brief has `id`, `title`, `kind`, `created_at`, `read` boolean.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BR-02 — Get brief detail
**Steps:**
1. Get a brief ID from BR-01
2. Run: `curl -s https://brain.troy-davis.com/api/v1/briefs/<id> | jq '{title: .brief.title, has_html: (.brief.body_html != null)}'`

**Expected:** Full brief with `body_html` field populated. HTTP 200.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BR-03 — Non-UUID brief ID returns 400
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" https://brain.troy-davis.com/api/v1/briefs/not-a-uuid`

**Expected:** HTTP 400 (not 500). "id must be a valid UUID."

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BR-04 — Mark brief as read
**Steps:**
1. Use a brief ID from BR-01
2. Run: `curl -s -X PATCH https://brain.troy-davis.com/api/v1/briefs/<id> -H 'Content-Type: application/json' -d '{"read":true}' | jq .brief.read`

**Expected:** Returns `true`. HTTP 200.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BR-05 — Dismiss a brief
**Steps:**
1. Use a brief ID
2. Run: `curl -s -o /dev/null -w "%{http_code}" -X POST https://brain.troy-davis.com/api/v1/briefs/<id>/dismiss`

**Expected:** HTTP 204 No Content.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BR-06 — Brief UI page
**Steps:**
1. Navigate to https://brain.troy-davis.com/briefs
2. Observe brief list
3. Click a brief to open detail

**Expected:** Brief list renders with title and date. Detail page renders formatted HTML content (table of contents if present).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BR-07 — Filter unread briefs
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/briefs?unread=true&limit=10' | jq '.items[].read' | sort -u`

**Expected:** All returned briefs have `read = false`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 8 — Settings

### SET-01 — Get autonomy_level setting
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/settings/autonomy_level | jq`

**Expected:** Returns `{ key: "autonomy_level", value: "observe" | "assist" | "advise" | "partner", updated_at: "..." }`. If not set: 404.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SET-02 — Set autonomy_level to assist
**Steps:**
1. Run: `curl -s -X PUT https://brain.troy-davis.com/api/v1/settings/autonomy_level -H 'Content-Type: application/json' -d '{"value":"assist"}' | jq`

**Expected:** HTTP 200. Returns `{ key: "autonomy_level", value: "assist", updated_at: "..." }`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SET-03 — Invalid autonomy_level rejected
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" -X PUT https://brain.troy-davis.com/api/v1/settings/autonomy_level -H 'Content-Type: application/json' -d '{"value":"robot"}'`

**Expected:** HTTP 400. Error lists valid values: observe, assist, advise, partner.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SET-04 — Get email_allowlist setting
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/settings/email_allowlist | jq`

**Expected:** Returns array of email addresses, or 404 if not yet configured.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SET-05 — Set email_allowlist with valid emails
**Steps:**
1. Run: `curl -s -X PUT https://brain.troy-davis.com/api/v1/settings/email_allowlist -H 'Content-Type: application/json' -d '{"value":["brain@troy-davis.com","test@example.com"]}' | jq .value`

**Expected:** HTTP 200. Returns array `["brain@troy-davis.com","test@example.com"]`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SET-06 — email_allowlist with invalid email rejected
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" -X PUT https://brain.troy-davis.com/api/v1/settings/email_allowlist -H 'Content-Type: application/json' -d '{"value":["not-an-email"]}'`

**Expected:** HTTP 400. Error message mentions invalid email address format.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SET-07 — Unknown settings key rejected
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" https://brain.troy-davis.com/api/v1/settings/totally_unknown_key`

**Expected:** HTTP 400. Error: "Unknown settings key."

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SET-08 — Settings UI page loads all sections
**Steps:**
1. Navigate to https://brain.troy-davis.com/settings
2. Default section (Sources) loads
3. Click through sidebar sections: Email Allowlist, Voice, Wiki, Service Health, Danger zone

**Expected:** Each section renders without blank page. "Email allowlist" section shows current allowlist and form to add/remove emails. "Danger zone" section shows reset controls.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SET-09 — Settings UI: update email allowlist
**Steps:**
1. Navigate to https://brain.troy-davis.com/settings?section=email-allowlist
2. Add a test email address using the UI form
3. Click Save

**Expected:** Success toast. Page refreshes to show updated allowlist with the new email.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 9 — Admin

### ADM-01 — Health endpoint (external-safe)
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/captures?limit=1 | jq '.total'`

**Expected:** Returns a number. (Note: `/health` is Docker-internal only; use `/api/v1/captures?limit=1` as the external health check.)

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-02 — Detailed health check
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/health | jq`

**Expected:** Returns `{ status: "healthy" | "degraded" | "unhealthy", services: { postgres: {...}, redis: {...}, llm: {...} }, version: "...", uptime_s: N }`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-03 — Pipeline health (queue counts)
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/admin/pipeline/health | jq`

**Expected:** Returns `{ queues: { "capture-pipeline": {...}, "skill-execution": {...}, ... }, overall: { pending: N, processing: N, complete: N, failed: N } }`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-04 — Stats endpoint
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/stats | jq`

**Expected:** Returns capture statistics including total counts by source, type, brain_view, and pipeline health.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-05 — Config reload (requires ADMIN_KEY)
**Steps:**
1. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/admin/config/reload -H "Authorization: Bearer $ADMIN_KEY" | jq`

**Expected:** HTTP 200. Response `{ success: true, results: [...], reloaded_at: "..." }`. Each result shows which YAML file was reloaded.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-06 — Reset data: step 1 (request token)
**Steps:**
1. From the browser at https://brain.troy-davis.com, open browser DevTools console
2. Run: `fetch('/api/v1/admin/reset-data', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({intent:'reset'}) }).then(r => r.json()).then(console.log)`

**Expected:** Response `{ token: "...", expires_in: 300, message: "POST again with this token..." }`. Origin check passes from the allowed domain.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-07 — Reset data: origin check from external curl (must fail)
**Steps:**
1. From terminal (not browser): `curl -s -o /dev/null -w "%{http_code}" -X POST https://brain.troy-davis.com/api/v1/admin/reset-data -H 'Content-Type: application/json' -d '{"intent":"reset"}'`

**Expected:** HTTP 403 Forbidden. Origin check fails for non-browser requests without Origin header.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-08 — Reset data: step 2 with wrong phrase fails
**Steps:**
1. Get a token from ADM-06 (in browser console)
2. In same console: `fetch('/api/v1/admin/reset-data', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({confirm: 'wrong phrase', token: '<token_from_step1>'}) }).then(r => r.json()).then(console.log)`

**Expected:** HTTP 422 or 400. Error: confirmation phrase required / wrong phrase.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-09 — Reset data: token expires after 5 minutes
**Steps:**
1. Get a token from ADM-06
2. Wait 6 minutes
3. Attempt step 2 with the expired token (correct phrase, correct body format)

**Expected:** HTTP 401 or similar. Error: "Invalid or expired token."

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-10 — Bull Board UI loads (requires ADMIN_KEY)
**Steps:**
1. Open https://brain.troy-davis.com/api/v1/admin/queues in browser
2. Provide Authorization: Bearer <ADMIN_KEY> header (or use curl: `curl -s https://brain.troy-davis.com/api/v1/admin/queues -H "Authorization: Bearer $ADMIN_KEY"`)

**Expected:** Bull Board HTML UI renders showing queue list: capture-pipeline, skill-execution, notification, access-stats, daily-sweep.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-11 — Admin audit log preserved after data operations
**Steps:**
1. Run: `docker exec open-brain-postgres psql -U openbrain -c "SELECT event_type, outcome, created_at FROM admin_audit ORDER BY created_at DESC LIMIT 5;"`

**Expected:** Shows rows for any reset_requested / reset_blocked events from ADM-06–ADM-09. `admin_audit` table exists and has entries.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-12 — Clear failed jobs from queue
**Steps:**
1. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/admin/queues/capture-pipeline/clear -H 'Content-Type: application/json' -d '{"state":"failed"}' | jq`

**Expected:** HTTP 200. Response `{ queue: "capture-pipeline", state: "failed", cleared_count: N, cleared_at: "..." }`. N ≥ 0.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ADM-13 — Invalid queue name returns 404
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" -X POST https://brain.troy-davis.com/api/v1/admin/queues/nonexistent-queue/clear -H 'Content-Type: application/json' -d '{}'`

**Expected:** HTTP 404. Error lists valid queue names.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 10 — Slack Bot

### SLK-01 — Bot responds to !ping / !help
**Steps:**
1. In Slack, DM `@OpenBrain`: `!help`

**Expected:** Bot responds with full help text listing all available commands (captures, briefs, entities, board, bets, email, etc.).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-02 — !stats command
**Steps:**
1. In Slack, send: `!stats`

**Expected:** Bot replies with brain statistics: total captures, counts by source/type/view, pipeline health.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-03 — !recent command
**Steps:**
1. In Slack, send: `!recent 3`

**Expected:** Bot replies with last 3 captures, each with ID, type, source, date, and content preview.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-04 — Natural language capture
**Steps:**
1. In a Slack channel (not DM), send a plain message: `Decided to upgrade PostgreSQL to 17 next quarter after benchmarking confirms no breaking changes`

**Expected:** Bot acknowledges the capture (adds reaction emoji or sends confirmation). Message is stored in Open Brain as a capture.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-05 — Explicit `?` query prefix
**Steps:**
1. In Slack, send: `? What decisions did I make about PostgreSQL?`

**Expected:** Bot responds with search results from the knowledge base related to PostgreSQL decisions.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-06 — @mention query
**Steps:**
1. In Slack, send: `@OpenBrain what are my open tasks?`

**Expected:** Bot searches for task-type captures and responds with results. Intent router classifies @mention as QUERY.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-07 — !brief command (generate weekly brief)
**Steps:**
1. In Slack, send: `!brief`

**Expected:** Bot responds with "Generating weekly brief… this may take a minute." Then a follow-up confirming it's queued.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-08 — !brief last command
**Steps:**
1. In Slack, send: `!brief last`

**Expected:** Bot replies with last brief metadata: date generated, duration, captures queried, and summary snippet.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-09 — !entities command
**Steps:**
1. In Slack, send: `!entities`

**Expected:** Bot replies with list of known entities (name, type, mention count).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-10 — !entity <name> detail
**Steps:**
1. In Slack, send: `!entity Anthropic` (or another known entity name)

**Expected:** Bot replies with entity detail: type, mention count, last seen, and linked captures preview.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-11 — !pipeline status
**Steps:**
1. In Slack, send: `!pipeline status`

**Expected:** Bot replies with BullMQ queue counts: pending, active, completed, failed per queue.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-12 — !board quick (governance session)
**Steps:**
1. In Slack, send: `!board quick`

**Expected:** Bot creates a new governance session and responds in a thread with the opening prompt. Subsequent messages in that thread continue the session.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-13 — !board status
**Steps:**
1. In Slack, send: `!board status`

**Expected:** Bot replies listing active and paused sessions with IDs and types.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-14 — !bet add command
**Steps:**
1. In Slack, send: `!bet add 0.8 PostgreSQL 17 will be stable for production use by end of 2026`

**Expected:** Bot confirms bet created with confidence 0.8 and statement. Returns bet ID.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-15 — !bet list command
**Steps:**
1. In Slack, send: `!bet list`

**Expected:** Bot replies with list of pending bets with confidence, statement, and expiry date.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-16 — !connections command
**Steps:**
1. In Slack, send: `!connections 7`

**Expected:** Bot triggers daily-connections skill for last 7 days and responds with result or "queued" confirmation.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### SLK-17 — !drift command
**Steps:**
1. In Slack, send: `!drift`

**Expected:** Bot triggers drift-monitor skill and responds with analysis (silent bets, declining topics, or "no drift detected").

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 11 — Voice Capture

### VOICE-01 — Health check for voice-capture service
**Steps:**
1. Check from homeserver: `curl -s http://localhost:3003/health | jq` (adjust port if different)
2. Or from inside Docker: `docker exec open-brain-voice-capture curl -s http://127.0.0.1:3003/health`

**Expected:** `{ status: "healthy", service: "voice-capture", timestamp: "..." }`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### VOICE-02 — Voice capture via iOS Shortcut (if available)
**Steps:**
1. On iPhone/Watch: trigger the Open Brain voice capture shortcut
2. Record a ~10 second voice memo: "This is a test voice capture from the user test plan"
3. Wait for confirmation

**Expected:** Shortcut confirms submission. After 30–60 seconds, capture appears in Open Brain with `source = "voice"`, transcribed content, and `capture_type` auto-classified.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### VOICE-03 — Voice capture: unsupported format rejected
**Steps:**
1. Run: `curl -s -X POST http://homeserver.k4jda.net:3003/api/capture -F "file=@/tmp/test.exe" | jq`

**Expected:** HTTP 400. Error mentions supported formats: m4a, wav, mp3, ogg.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### VOICE-04 — Voice capture: missing file field rejected
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" -X POST http://homeserver.k4jda.net:3003/api/capture`

**Expected:** HTTP 400. Error: "Missing required field: file".

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### VOICE-05 — Voice capture UI page
**Steps:**
1. Navigate to https://brain.troy-davis.com/voice

**Expected:** Voice interface page loads. Browser-based voice recording UI visible (if implemented).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### VOICE-06 — Voice upload UI page
**Steps:**
1. Navigate to https://brain.troy-davis.com/voice-upload

**Expected:** File upload page for audio files loads. Supports drag-and-drop or file picker.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 12 — MCP Tools

All MCP tests use the LiteLLM gateway at https://llm.troy-davis.com/mcp with `Authorization: Bearer $MCP_API_KEY`.

Helper: `MCP_CALL='curl -s -X POST https://llm.troy-davis.com/mcp -H "Content-Type: application/json" -H "Authorization: Bearer $MCP_API_KEY"'`

### MCP-01 — search_brain tool
**Steps:**
1. Run: `curl -s -X POST https://llm.troy-davis.com/mcp -H 'Content-Type: application/json' -H "Authorization: Bearer $MCP_API_KEY" -d '{"method":"tools/call","params":{"name":"search_brain","arguments":{"query":"test","limit":3}}}' | jq '.result.content[0].text' | head -10`

**Expected:** Returns text with search results listing ID, match percentage, type, date, and content preview. Format: "Search results for: test / Found N results".

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-02 — list_captures tool
**Steps:**
1. Run MCP call with: `{"name":"list_captures","arguments":{"limit":5}}`

**Expected:** Returns formatted text listing recent captures. Each entry has date, type, source, content preview (truncated to ~300 chars).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-03 — brain_stats tool
**Steps:**
1. Run MCP call with: `{"name":"brain_stats","arguments":{}}`

**Expected:** Returns statistics text: total captures, breakdown by source/type/brain_view, pipeline health (pending/failed counts).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-04 — capture_thought tool
**Steps:**
1. Run MCP call with: `{"name":"capture_thought","arguments":{"content":"MCP tool test capture from user test plan 2026-05-09","capture_type":"observation","brain_view":"technical"}}`

**Expected:** Returns confirmation text with new capture ID and `pipeline_status`. Capture appears in Open Brain.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-05 — get_entity tool
**Steps:**
1. Run MCP call with: `{"name":"get_entity","arguments":{"name":"Anthropic"}}`

**Expected:** Returns entity detail text with type, mention count, aliases, and list of recent linked captures (IDs + preview).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-06 — list_entities tool
**Steps:**
1. Run MCP call with: `{"name":"list_entities","arguments":{"limit":5,"sort_by":"mention_count"}}`

**Expected:** Returns formatted text listing top 5 entities by mention count. Each entry: name, type, mention count.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-07 — get_weekly_brief tool
**Steps:**
1. Run MCP call with: `{"name":"get_weekly_brief","arguments":{}}`

**Expected:** Returns most recent weekly brief summary text. If no brief exists: "No weekly brief found."

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-08 — get_capture tool (full content, not truncated)
**Steps:**
1. Get a capture ID (any from CAP-01 or earlier tests)
2. Run MCP call with: `{"name":"get_capture","arguments":{"id":"<uuid>"}}`

**Expected:** Returns full capture content (not truncated), plus metadata: type, source, brain_view, tags, pipeline_status, entities linked.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-09 — search_brain with include_related=true (default)
**Steps:**
1. Run MCP call: `{"name":"search_brain","arguments":{"query":"project decisions","limit":5,"include_related":true}}`

**Expected:** Results section plus optional "Related captures (via entity graph)" section if spreading activation finds related captures.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-10 — MCP bearer token required
**Steps:**
1. Run: `curl -s -o /dev/null -w "%{http_code}" -X POST https://llm.troy-davis.com/mcp -H 'Content-Type: application/json' -d '{"method":"tools/call","params":{"name":"brain_stats","arguments":{}}}'`

**Expected:** HTTP 401 or 403. Request without Authorization header rejected.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-11 — search_wiki tool (if wiki configured)
**Steps:**
1. Run MCP call with: `{"name":"search_wiki","arguments":{"query":"project"}}`

**Expected:** Returns wiki page matches with title, path, type, and content snippet. If wiki is empty: "No pages found."

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### MCP-12 — MCP resource: open_brain://context
**Steps:**
1. Run: `curl -s -X POST https://llm.troy-davis.com/mcp -H 'Content-Type: application/json' -H "Authorization: Bearer $MCP_API_KEY" -d '{"method":"resources/read","params":{"uri":"open_brain://context"}}' | jq '.result.contents[0].text' | head -5`

**Expected:** Returns contextual brain summary text including stats and recent activity.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 13 — Pipeline Health & Workers

### PIP-01 — System health endpoint
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/system/health | jq '{status: .status, queue_depths: .queues}'`

**Expected:** Status is `healthy` or `degraded`. Queue depth numbers present.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### PIP-02 — Skills list endpoint
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/skills | jq '.[] | {name: .name, schedule: .schedule, last_run: .last_run_at}' | head -40`

**Expected:** Lists all 24 configured skills with their cron schedules and last-run timestamps. Skills include: weekly-brief, daily-connections, drift-monitor, memory-consolidation, wiki-lint, wiki-synthesis, etc.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### PIP-03 — Manually trigger a skill
**Steps:**
1. Run: `curl -s -X POST https://brain.troy-davis.com/api/v1/skills/pipeline-health/trigger -H 'Content-Type: application/json' -d '{}' | jq`

**Expected:** HTTP 202 Accepted. Response contains `{ queued: true, job_id: "..." }`. Skill runs in background.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### PIP-04 — Skill logs endpoint
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/skills/weekly-brief/logs?limit=3 | jq '.[].status'`

**Expected:** Returns array of recent log entries with `status = "success"` or `"failed"`.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### PIP-05 — Pipeline infrastructure data
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/system/infrastructure | jq`

**Expected:** Returns container health, backup status, and cost data. HTTP 200.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### PIP-06 — Pipeline flows (recent job history)
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/system/flows?limit=5' | jq '.flows | length'`

**Expected:** Returns array of recent pipeline flow objects. HTTP 200.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### PIP-07 — System page in UI
**Steps:**
1. Navigate to https://brain.troy-davis.com/system
2. Observe service health indicators, queue depths, skill run history

**Expected:** System health dashboard loads. Services (Postgres, Redis, LLM) shown with healthy/degraded/unhealthy status. Queue depths displayed. Recent skill runs listed.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### PIP-08 — Intelligence page: connections and drift
**Steps:**
1. Navigate to https://brain.troy-davis.com/intelligence
2. Observe connections and drift sections

**Expected:** Intelligence page loads. Shows latest daily-connections results (if run), latest drift-monitor results, and unresolved questions section.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### PIP-09 — Activity feed endpoint
**Steps:**
1. Run: `curl -s 'https://brain.troy-davis.com/api/v1/activity/feed?limit=5' | jq '.items | length'`

**Expected:** Returns array of activity feed entries. HTTP 200.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### PIP-10 — Stale capture sweep (daily-sweep) is scheduled
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/skills | jq '.[] | select(.name=="daily-sweep") | {schedule, last_run: .last_run_at}'`

**Expected:** daily-sweep skill has schedule `0 3 * * *` (3 AM daily) and a last_run_at timestamp.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 14 — Observability

### OBS-01 — Grafana dashboard accessible
**Steps:**
1. Open http://homeserver.k4jda.net:3000 (or Grafana port)
2. Log in with Grafana credentials
3. Navigate to Open Brain dashboard (if configured)

**Expected:** Grafana loads. Dashboards show container metrics, request rates, error rates.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### OBS-02 — Loki log search
**Steps:**
1. In Grafana, open Explore
2. Select Loki data source
3. Query: `{container_name="open-brain-core-api"}` with time range: last 1 hour

**Expected:** Loki returns log lines from core-api. Structured JSON log format visible.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### OBS-03 — Prometheus metrics endpoint
**Steps:**
1. Run: `curl -s http://homeserver.k4jda.net:9090/api/v1/query?query=up | jq '.data.result | length'`

**Expected:** Returns count of scraped targets that are up. At least 1.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### OBS-04 — Docker log driver (Loki) functional
**Steps:**
1. Run: `docker logs open-brain-core-api --tail 5`

**Expected:** Logs visible in Docker (Loki driver uses `mode=non-blocking`; local driver still accessible). Lines appear in expected JSON format.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### OBS-05 — SSE health stream
**Steps:**
1. Run: `curl -s -N --max-time 15 https://brain.troy-davis.com/api/v1/system/health/stream`

**Expected:** SSE stream emits `event: system_health` lines with JSON payloads every 10 seconds. At least 1 event received within 15 seconds.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 15 — Backup & Recovery

### BAK-01 — Backup script runs without errors
**Steps:**
1. SSH to homeserver: `ssh claude@homeserver.k4jda.net`
2. Run: `cd /mnt/user/appdata/open-brain && bash scripts/backup.sh 2>&1 | tail -20`

**Expected:** Script completes without error. Backup directory created under `$BACKUP_ROOT` with timestamp. Output includes confirmation of backed-up files.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BAK-02 — Backup does NOT contain secrets
**Steps:**
1. After BAK-01, locate the backup directory
2. Run: `bash scripts/test-backup-secrets-redaction.sh`

**Expected:** Exit code 0. Output confirms no secret variable names found in backup payload. If exit code 1: secrets were found — critical failure.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BAK-03 — Secrets roundtrip test
**Steps:**
1. Run: `bash scripts/test-secrets-roundtrip.sh`

**Expected:** All 5 test fixture cases pass. Exit code 0.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BAK-04 — Verify secrets against Bitwarden
**Steps:**
1. SSH to homeserver
2. Run: `bash scripts/verify-secrets.sh --target-dir /mnt/user/appdata/open-brain`

**Expected:** All secrets in `secrets-map.sh` are present in `.env.secrets` and match Bitwarden values. No SHA256 mismatch.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BAK-05 — pre-wipe pg_dump capability (do NOT complete step 2)
**Steps:**
1. Check pg_dump is available in core-api container: `docker exec open-brain-core-api pg_dump --version`

**Expected:** pg_dump binary present. Version output printed. This confirms pre-wipe dump capability exists without executing a real wipe.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

## Section 16 — Additional Feature Areas

### WIKI-01 — Wiki pages list
**Steps:**
1. Run: `curl -s https://brain.troy-davis.com/api/v1/wiki/pages | jq '.pages | length'`

**Expected:** Returns array of wiki page metadata objects. HTTP 200. May be 0 if wiki has no pages.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### WIKI-02 — Wiki UI page
**Steps:**
1. Navigate to https://brain.troy-davis.com/wiki

**Expected:** Wiki page list renders. If pages exist, they show with title, type, and last updated date.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### EMAIL-01 — Email UI page
**Steps:**
1. Navigate to https://brain.troy-davis.com/email

**Expected:** Email page loads. Shows email drafts list or empty state. Draft email form accessible.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BOARD-01 — Board/Commitments page
**Steps:**
1. Navigate to https://brain.troy-davis.com/board
2. Observe 4 columns: Pending, You owe, Waiting on, Resolved

**Expected:** Board renders with 4 kanban columns. If commitments exist, they appear in correct columns. "New item" button present.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### BOARD-02 — Create a commitment via board UI
**Steps:**
1. On https://brain.troy-davis.com/board, click "New item"
2. Fill in: text "Follow up with test contact", status "pending", due date optional
3. Submit

**Expected:** New commitment card appears in "Pending" column. No error.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### FIN-01 — Financial page loads
**Steps:**
1. Navigate to https://brain.troy-davis.com/financial

**Expected:** Financial page renders without error. Shows financial data or empty state.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### TIMELINE-01 — Timeline infinite scroll
**Steps:**
1. Navigate to https://brain.troy-davis.com/timeline
2. Scroll to bottom of capture list

**Expected:** More captures load automatically (if total > 25). Loading indicator appears briefly.

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

### ONBOARD-01 — Onboarding page
**Steps:**
1. Navigate to https://brain.troy-davis.com/onboarding

**Expected:** Onboarding page renders (user profile setup form).

`[ ] Pass` `[ ] Fail` `[ ] Skip`
**Notes:**

---

---

## Known Limitations / Skip Conditions

| Area | Skip Condition |
|------|----------------|
| Voice capture (iOS) | Requires iPhone/Watch with Shortcut installed |
| TTS audio (briefs) | Requires OpenAI API key with TTS access; skipped if not configured |
| Grafana/Prometheus | Skip if observability stack not deployed (`--profile observability`) |
| Wiki MCP tools | Skip if `WIKI_REPO_URL` not configured |
| Email MCP tools | Skip if `EmailDraftService` not configured (Composio) |
| Admin reset (step 2) | **Do not execute full data wipe** — test only step 1 token issuance |
| ADM-09 (token expiry) | Requires 6-minute wait — safe to skip in time-constrained testing |
| !connections / !drift | Skip if LLM is unavailable or over budget |
| Loki log search | Skip if Loki not deployed on homeserver |
| BAK-01 to BAK-04 | Requires SSH access to homeserver |

---

## Pass/Fail Tracking Table

| Section | Total Tests | Pass | Fail | Skip | Pass Rate |
|---------|-------------|------|------|------|-----------|
| 1. Web Dashboard | 8 | | | | |
| 2. Captures | 10 | | | | |
| 3. Search | 10 | | | | |
| 4. Documents | 6 | | | | |
| 5. Entities | 7 | | | | |
| 6. Sessions | 13 | | | | |
| 7. Briefs | 7 | | | | |
| 8. Settings | 9 | | | | |
| 9. Admin | 13 | | | | |
| 10. Slack Bot | 17 | | | | |
| 11. Voice Capture | 6 | | | | |
| 12. MCP Tools | 12 | | | | |
| 13. Pipeline & Workers | 10 | | | | |
| 14. Observability | 5 | | | | |
| 15. Backup & Recovery | 5 | | | | |
| 16. Additional Features | 9 | | | | |
| **TOTAL** | **147** | | | | |

---

## Test Run Log

| Date | Tester | Environment | Notes |
|------|--------|-------------|-------|
| | | | |

---

*End of User Test Plan*
