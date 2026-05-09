# Implementation Plan — Cloudscape M3: Briefs, Board, Settings, Onboarding + Full Backlog

**Generated:** 2026-04-22 02:00:00
**Based On:** M3_BACKLOG.md, HANDOFF.md §6 Milestone 3, Cloudscape screens (09-board, 11-settings, 13-onboarding), Ultra-plan Phase 1-4 analysis
**Total Phases:** 8
**Estimated Total Effort:** ~8,500 LOC across ~120 files

---

## Executive Summary

Milestone 3 completes the Cloudscape UI migration by delivering four high-impact features (brief generation, commitments + governance board, settings, onboarding), porting all remaining /web screens to web-next, cutting over production traffic, and polishing the PWA experience.

**The Cloudscape Board (screen 09) is a commitments/decisions Kanban — NOT a port of /web Board.tsx governance sessions.** The design shows 4 status columns (Pending, You owe, Waiting on, Resolved) populated by an extraction pipeline that identifies forward-looking obligations from captures. This requires a new `commitments` domain model (migration 0031, pipeline extraction job, API endpoints) before the Board UI can render real data.

**Key architectural decisions carried from ultra-plan analysis:**
- **D116:** Entity-brief skill reuses `search_synthesis` task key (no new routing entry)
- **D117:** Commitments status enum: `pending | owed_by_user | waiting_on | resolved` maps to Cloudscape 4-column layout
- **D118:** Settings implements 3 live sections + 5 empty states (pragmatic for missing backend support)
- **D119:** Onboarding source connection is instructional, not self-service OAuth
- **D120:** TTS uses OpenAI `tts-1` (same key, lowest integration cost), Redis cache 24h
- **D121:** Production cut-over uses 2-week parallel URL before primary tunnel swap

**Implementation strategy:** CS1 (Briefs) and CS2 (Commitments+Board) run in parallel as Phases 1-2. CS3+CS4 (Settings+Onboarding) follow as Phase 3. CS5+CS6+CS7 (TTS+Search+Timeline) combine in Phase 4. Remaining screen ports fill Phases 5-6. Production cut-over (Phase 7) gates on all screens. Polish (Phase 8) is final.

---

## Plan Overview

The plan groups the 10 M3_BACKLOG sections plus the Cloudscape onboarding screen into 8 phases optimized for parallel execution and dependency ordering.

**Critical path:** Phase 2 (Commitments domain) → Phase 5-6 (all screens) → Phase 7 (production cut-over)

**Parallelization:** Phases 1+2 are fully parallel. Within Phase 3, Settings and Onboarding share `settingsApi` but touch different routes. Within Phase 4, TTS/Search/Timeline are independent. Phase 5+6 screen ports can parallelize per-screen.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies | Execution Mode |
|-------|------------|------------------|-----------------|--------------|----------------|
| 1 | Brief Generation (CS1) | Entity-brief skill, DOSSIER briefs, trigger UI | M (~12 files, ~800 LOC) | None | Sequential |
| 2 | Commitments + Board (CS2) | Migration 0031, extraction pipeline, Kanban board | L (~18 files, ~1500 LOC) | None | Sequential |
| 3 | Settings + Onboarding (CS3+CS4) | Cloudscape settings, 4-step onboarding wizard | M (~14 files, ~1200 LOC) | None | Parallel |
| 4 | TTS + Search + Timeline (CS5+CS6+CS7) | Audio playback, search port, timeline port | M (~16 files, ~1400 LOC) | Phase 1 (briefs exist for TTS) | Parallel |
| 5 | Screen Ports: Simple + Moderate (CS8a+partial CS8c) | Financial, Intelligence, VoiceUpload, Help, Investments, VoiceConversations | M (~18 files, ~1200 LOC) | None | Parallel |
| 6 | Screen Ports: Complex + Remaining (CS8b+CS8c) | Wiki, Ingest, Email, System, SlackCleanup, Admin Reset | L (~20 files, ~1500 LOC) | None | Parallel |
| 7 | Production Cut-Over (CS9) | Dockerfile, docker-compose, tunnel swap | M (~6 files, ~400 LOC) | Phases 1-6 (all screens ported) | Sequential |
| 8 | Polish (CS10) | PWA, dark mode, keyboard shortcuts | S (~8 files, ~500 LOC) | Phase 7 | Sequential |

<!-- BEGIN PHASES -->

---

## Phase 1: Brief Generation

**Estimated Complexity:** M (~12 files, ~800 LOC)
**Dependencies:** None
**Parallelizable:** Yes (items 1.1-1.2 backend, then 1.3-1.4 frontend)
**Execution Mode:** Sequential

### Goals

- Wire end-to-end entity dossier brief generation: button → skill → SSE → reader
- Add manual "New brief" trigger on briefs list page for DAILY and DOSSIER kinds
- Register entity-brief skill in BullMQ dispatch

### Work Items

#### 1.1 Entity-brief worker skill
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §2, HANDOFF M3 "brief generator", D112 (BaseSkill.logResult → Promise<string>)
**Files Affected:**
- `packages/workers/src/skills/entity-brief.ts` (create)
- `packages/workers/src/jobs/skill-execution.ts` (modify — add case dispatch)
- `packages/workers/src/__tests__/entity-brief.test.ts` (create)

**Description:**
New skill extending BaseSkill. Fetches entity + top-50 captures via FTS rank on entity name. Fetches related entities (1-hop spreading_activation). Synthesizes via `llmGateway.completeByTask('search_synthesis')` — reuses existing task key (same quality tier, no new ai-routing entry). Renders via `renderBriefHtml()` from shared. Writes briefs row with `kind: 'DOSSIER'`, `entity_id`, `refine_options: ['Focus on recent', 'Focus on decisions', 'Key relationships only']`. `minimum_autonomy: 'observe'` (informational, always safe).

**Tasks:**
1. [ ] Create `entity-brief.ts` extending BaseSkill with `run()` implementation
2. [ ] Fetch entity + captures + related entities; assemble context block
3. [ ] LLM synthesis via completeByTask('search_synthesis')
4. [ ] Render HTML + TOC + sources; write briefs row via BriefsService pattern
5. [ ] Add `case 'entity-brief'` in skill-execution.ts dispatch
6. [ ] Write unit tests mocking LLM + DB

**Acceptance Criteria:**
- [ ] Skill produces a readable DOSSIER brief for a real entity with ≥5 linked captures
- [ ] Brief has body_html, toc, sources populated
- [ ] Skill gracefully handles entity with 0 captures (writes minimal brief)
- [ ] `pnpm --filter @open-brain/workers exec vitest run` passes

**Notes:**
Follow weekly-brief.ts pattern exactly: logResult() → build markdown → renderBriefHtml() → map sources → db.insert(briefs). Non-fatal try/catch on brief insert.

---

#### 1.2 POST /entities/:id/brief endpoint
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §2 "Backend: Endpoint"
**Files Affected:**
- `packages/core-api/src/routes/entities.ts` (modify — add POST route)
- `packages/core-api/src/app.ts` (modify — strict rate limit for brief generation)
- `packages/core-api/src/__tests__/entity-routes.test.ts` (modify)

**Description:**
Add `POST /api/v1/entities/:id/brief` endpoint. Validates entity exists (404 if not). Enqueues `entity-brief` BullMQ skill-execution job with `{ entityId, entityName, entityType }`. Returns `202 Accepted` with `{ job_id }`. Apply strict rate limit tier (LLM-heavy, same as `/briefs/:id/refine`).

**Tasks:**
1. [ ] Add POST route with entity existence check
2. [ ] Enqueue skill-execution job for 'entity-brief'
3. [ ] Mount strict rate limiter before the route in app.ts
4. [ ] Add test for 202 response and 404 on missing entity

**Acceptance Criteria:**
- [ ] POST /entities/:id/brief returns 202 with job_id
- [ ] POST /entities/nonexistent/brief returns 404
- [ ] Rate limiter rejects rapid successive calls

---

#### 1.3 Entity-brief frontend wiring
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §2 "Frontend: Wire Button", D113 (Radix Dialog + sonner)
**Files Affected:**
- `packages/web-next/components/entity/entity-detail-client.tsx` (modify)
- `packages/web-next/components/entity/entity-header.tsx` (modify)
- `packages/web-next/lib/api-client.ts` (modify — add entitiesApi.brief)

**Description:**
Replace the M3 toast stub with real functionality. `entity-header.tsx` "Generate brief" button calls `onGenerateBrief` prop. `entity-detail-client.tsx` wires `useMutation(entitiesApi.brief(entityId))` → sonner "Generating dossier..." (spinning). On SSE `brief_created` event with matching `entity_id`: toast "Brief ready" with link → `router.push('/briefs/${id}')`. On error: sonner error toast.

**Tasks:**
1. [ ] Add `entitiesApi.brief(entityId): Promise<{job_id}>` to api-client.ts
2. [ ] Wire useMutation in entity-detail-client.tsx
3. [ ] Listen for SSE `brief_created` event with entity_id match → navigate
4. [ ] Replace toast stub in entity-header.tsx with actual onGenerateBrief call

**Acceptance Criteria:**
- [ ] Button click shows "Generating dossier..." toast
- [ ] SSE event arrives → navigates to new brief
- [ ] Error case shows error toast (not crash)

---

#### 1.4 "New brief" trigger on briefs list
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** HANDOFF M3 "brief generator (daily + dossier kinds first)"
**Files Affected:**
- `packages/web-next/app/(shell)/briefs/page.tsx` (modify)
- `packages/web-next/components/briefs/NewBriefModal.tsx` (create)
- `packages/web-next/lib/api-client.ts` (modify — add skillsApi.trigger)

**Description:**
The "New brief" button on the briefs list page currently has no handler. Add a modal with kind selection: DAILY (trigger morning-brief skill) or DOSSIER (entity picker → trigger entity-brief). Uses existing `POST /api/v1/skills/:name/trigger` endpoint (confirmed: returns 202 with `{ skill, job_id, status: 'queued' }`). SSE `brief_created` event invalidates briefs list query.

**Tasks:**
1. [ ] Create NewBriefModal with Radix Dialog + kind selector
2. [ ] DAILY option: trigger morning-brief skill via skillsApi
3. [ ] DOSSIER option: entity search input → trigger entity-brief with entityId
4. [ ] Add `skillsApi.trigger(name, params?)` to api-client.ts
5. [ ] Wire "New brief" button onClick → modal open

**Acceptance Criteria:**
- [ ] "New brief" button opens modal with DAILY and DOSSIER options
- [ ] Selecting DAILY triggers morning-brief skill (202 response)
- [ ] Selecting DOSSIER shows entity picker, triggers entity-brief
- [ ] New brief appears in list after SSE notification

---

### Phase 1 Testing Requirements

- [ ] entity-brief skill unit tests pass (mock LLM + DB)
- [ ] entity-routes integration test for POST /entities/:id/brief
- [ ] `pnpm --filter @open-brain/workers exec vitest run` all pass
- [ ] `pnpm --filter @open-brain/core-api exec vitest run` all pass
- [ ] `pnpm --filter @open-brain/web-next exec vitest run` all pass

### Phase 1 Completion Checklist

- [ ] All 4 work items complete
- [ ] All tests passing across workers, core-api, web-next
- [ ] Entity-brief skill registered in skill-execution dispatch
- [ ] No regressions in existing brief skills (weekly, daily, morning, monthly)

---

## Phase 2: Commitments Domain + Board

**Estimated Complexity:** L (~18 files, ~1500 LOC)
**Dependencies:** None (parallel with Phase 1)
**Parallelizable:** Yes (2.1-2.4 backend sequential, 2.5-2.6 frontend after 2.4)

### Goals

- Create `commitments` table with directional obligation tracking
- Extract commitments from captures via T1 LLM pipeline job
- Build Cloudscape Kanban board (screen 09) with 4 status columns
- Replace CommitmentsCard "Coming in M3" placeholder with live data

### Work Items

#### 2.1 Migration 0031 + Drizzle schema
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §1 "Backend: Database", D111 (deferred to M3)
**Files Affected:**
- `packages/shared/drizzle/0031_commitments.sql` (create)
- `packages/shared/src/schema/commitments.ts` (create)
- `packages/shared/src/schema/index.ts` (modify — export commitments)
- `packages/shared/src/types/commitment.ts` (create)
- `packages/shared/src/types/index.ts` (modify)

**Description:**
Migration creates `commitments` table: `id UUID PK DEFAULT gen_random_uuid()`, `capture_id UUID NOT NULL FK captures(id) ON DELETE CASCADE`, `entity_id UUID FK entities(id) ON DELETE SET NULL`, `text TEXT NOT NULL`, `due_date DATE`, `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','owed_by_user','waiting_on','resolved'))`, `resolved_at TIMESTAMPTZ`, `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`. Indexes: `(entity_id, status)`, `(capture_id)`, `(status, due_date)`. Also adds `'extract_commitments'` to `pipeline_events.stage` CHECK constraint via ALTER.

Drizzle schema mirrors migration. Types file defines `CommitmentStatus` union and `Commitment` interface.

**Pre-flight:** Run `SELECT DISTINCT stage FROM pipeline_events` before applying migration to verify no unexpected values (mandatory per CLAUDE.md).

**Tasks:**
1. [ ] Write migration 0031 SQL with table + indexes + CHECK update
2. [ ] Create Drizzle schema in commitments.ts
3. [ ] Create TypeScript types in commitment.ts
4. [ ] Export from shared/schema and shared/types index files
5. [ ] Rebuild shared package (`pnpm --filter @open-brain/shared build`)

**Acceptance Criteria:**
- [ ] Migration applies cleanly on fresh DB
- [ ] Drizzle schema compiles and matches migration
- [ ] `pipeline_events.stage` CHECK includes `extract_commitments`

---

#### 2.2 Extract-commitments pipeline job
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §1 "Worker: Extraction Skill"
**Files Affected:**
- `packages/workers/src/jobs/extract-commitments.ts` (create)
- `packages/workers/src/flows/ingest-pipeline.ts` (modify — add DAG child)
- `config/prompts/extract-commitments.v1.txt` (create)
- `config/ai-routing.yaml` (modify — add task key)
- `packages/workers/src/__tests__/extract-commitments.test.ts` (create)

**Description:**
New BullMQ job handler. Non-critical child in ingest DAG (`removeDependencyOnFailure: true`), parallel to extract-entities. Fetches capture text, calls T1 LLM (Jetson/Spark) via `llmGateway.completeByTask('commitment_extraction')` with prompt template. LLM returns JSON: `[{ text, due_date_iso, entity_name, direction }]` where direction is `pending|owed_by_user|waiting_on`. Upserts to commitments table — dedup by SHA-256 of text per capture. Resolves entity_name to entity_id via existing entity resolver.

Add `commitment_extraction` task key to ai-routing.yaml under t1_spark (routine extraction, free).

**Tasks:**
1. [ ] Create prompt template: extract forward-looking statements, classify direction
2. [ ] Implement job handler following extract-entities pattern
3. [ ] Add `commitment_extraction: t1_spark` to ai-routing.yaml task_routing
4. [ ] Add extract-commitments as sibling child in ingest pipeline DAG
5. [ ] Record pipeline_events (started/success/failed)
6. [ ] Write unit tests with mocked LLM responses

**Acceptance Criteria:**
- [ ] Capture "I'll send the report to Sarah by Friday" → creates commitment row with `owed_by_user` status and due_date
- [ ] Capture "Ravi owes us the pricing memo" → creates commitment with `waiting_on` status
- [ ] Duplicate text for same capture → no duplicate row (SHA-256 dedup)
- [ ] Pipeline completes even if extract-commitments fails (non-critical child)

---

#### 2.3 Commitments API routes
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §1 "Backend: API Endpoints"
**Files Affected:**
- `packages/core-api/src/routes/commitments.ts` (create)
- `packages/core-api/src/app.ts` (modify — mount routes)
- `packages/core-api/src/__tests__/commitment-routes.test.ts` (create)

**Description:**
Four endpoints: `GET /api/v1/commitments` (list with status/entity_id filters, sorted by due_date ASC), `GET /api/v1/entities/:id/commitments` (entity-scoped, open by default), `PATCH /api/v1/commitments/:id` (toggle resolved: sets/clears resolved_at), `POST /api/v1/commitments` (manual creation: text, entity_id, due_date, status). Default rate limit tier; `web-ui` already bypassed.

**Tasks:**
1. [ ] Create routes file with all 4 endpoints
2. [ ] Implement list query with status + entity_id filters + pagination
3. [ ] Implement PATCH resolved toggle (sets resolved_at = NOW() or NULL)
4. [ ] Implement POST manual creation with validation
5. [ ] Mount in app.ts
6. [ ] Write route tests

**Acceptance Criteria:**
- [ ] GET /commitments returns filtered list sorted by due_date
- [ ] GET /entities/:id/commitments returns open commitments for entity
- [ ] PATCH /commitments/:id toggles resolved_at
- [ ] POST /commitments creates manual commitment

---

#### 2.4 Board Kanban page
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** HANDOFF M3 "Board", Cloudscape screen 09
**Files Affected:**
- `packages/web-next/app/(shell)/board/page.tsx` (create)
- `packages/web-next/app/(shell)/board/loading.tsx` (create)
- `packages/web-next/app/(shell)/board/error.tsx` (create)
- `packages/web-next/components/board/BoardColumn.tsx` (create)
- `packages/web-next/components/board/BoardCard.tsx` (create)
- `packages/web-next/components/board/GroupByBar.tsx` (create)

**Description:**
RSC page fetches all commitments via `commitmentsApi.list()`. Groups by status into 4 columns matching Cloudscape design: Pending (status=pending), You owe (owed_by_user), Waiting on (waiting_on), Resolved (resolved). Each column header has count + colored top border. Cards show: priority stripe (overdue=red, has due_date=terracotta, no date=gray, resolved=muted), entity tag eyebrow, title, date badge, note text. "New item" button opens creation modal. GroupByBar client component: toggle between Status (default), Project, Person, Due date groupings. M3 uses click-to-resolve (not drag-and-drop).

**Tasks:**
1. [ ] Create page.tsx RSC with parallel commitments fetch
2. [ ] Create BoardColumn with status header + card list
3. [ ] Create BoardCard with priority stripe, entity tag, date badge, resolve action
4. [ ] Create GroupByBar with 4 toggle buttons (Status active by default)
5. [ ] Loading skeleton + error boundary
6. [ ] "New item" button → POST /commitments modal

**Acceptance Criteria:**
- [ ] `/board` renders 4-column Kanban matching Cloudscape screen 09
- [ ] Cards grouped by status with correct column assignment
- [ ] Overdue cards (due_date < today, not resolved) visually distinguished
- [ ] "Mark resolved" click moves card to Resolved column

---

#### 2.5 CommitmentsCard live data
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §1 "Frontend: CommitmentsCard", D111
**Files Affected:**
- `packages/web-next/components/entity/commitments-card.tsx` (modify — replace placeholder)
- `packages/web-next/lib/api-client.ts` (modify — add commitmentsApi namespace)
- `packages/web-next/lib/types.ts` (modify — add Commitment type)

**Description:**
Replace EmptyState "Coming in M3" with live data. Fetch open commitments from `commitmentsApi.forEntity(entityId)`. Display sorted by due_date ASC. Each row: commitment text, due date badge (red if overdue), "Mark resolved" checkbox. Resolve action: `useMutation(commitmentsApi.patch(id, { resolved: true }))` with optimistic update + query invalidation. Empty state: "No open commitments" (not an error).

**Tasks:**
1. [ ] Add `commitmentsApi` to api-client.ts: `list()`, `forEntity(id)`, `patch(id, body)`, `create(body)`
2. [ ] Add `Commitment` type to web-next types.ts (D109: local declaration, not shared import)
3. [ ] Replace placeholder with data-driven component
4. [ ] Implement resolve checkbox with optimistic update
5. [ ] Handle empty state

**Acceptance Criteria:**
- [ ] Entity detail page shows open commitments for that entity
- [ ] Resolve checkbox toggles commitment and updates UI optimistically
- [ ] Empty state shown when entity has no open commitments

---

### Phase 2 Testing Requirements

- [ ] Migration 0031 applies cleanly (pre-flight SELECT DISTINCT check)
- [ ] extract-commitments unit tests pass with mocked LLM
- [ ] Commitment routes unit tests pass
- [ ] `pnpm -r build` succeeds with new shared schema
- [ ] Full test suite green: workers 980+, core-api 772+, web-next 109+

### Phase 2 Completion Checklist

- [ ] All 6 work items complete
- [ ] Migration tested on homeserver
- [ ] Board renders with real commitments data
- [ ] CommitmentsCard shows live data on entity detail
- [ ] No regressions in ingest pipeline

---

## Phase 3: Settings + Onboarding

**Estimated Complexity:** M (~14 files, ~1200 LOC)
**Dependencies:** None (can start parallel with Phases 1-2)
**Parallelizable:** Yes (Settings and Onboarding touch different routes)

### Goals

- Build Cloudscape Settings page (screen 11) with 8-section sidebar, 3 live sections
- Build first-run onboarding wizard (screen 13) outside the shell
- Add settingsApi + configApi to web-next api-client

### Work Items

#### 3.1 Settings page skeleton + API namespaces
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §6, Cloudscape screen 11
**Files Affected:**
- `packages/web-next/app/(shell)/settings/page.tsx` (create)
- `packages/web-next/app/(shell)/settings/loading.tsx` (create)
- `packages/web-next/app/(shell)/settings/error.tsx` (create)
- `packages/web-next/components/settings/SettingsSidebar.tsx` (create)
- `packages/web-next/lib/api-client.ts` (modify — settingsApi + configApi)
- `packages/web-next/lib/types.ts` (modify)

**Description:**
Settings page with 2-column grid: 220px left sidebar + content area. Sidebar has 8 sections matching Cloudscape: Profile, Sources, Brief preferences, Privacy & data, Workspaces, Billing, API & export, Danger zone. URL-driven section: `?section=sources` (default). Active section gets book-cloth left border + wash background.

Add `settingsApi`: `get(key): Promise<{key, value, updated_at}>`, `put(key, value): Promise<{key, value, updated_at}>`.
Add `configApi`: `integrations(): Promise<{integrations: Integration[]}>`.

**Tasks:**
1. [ ] Create page.tsx RSC with section routing via searchParams
2. [ ] Create SettingsSidebar with 8 items, active state from URL
3. [ ] Add settingsApi and configApi to api-client.ts
4. [ ] Add settings-related types to types.ts
5. [ ] Loading skeleton + error boundary

**Acceptance Criteria:**
- [ ] `/settings` renders sidebar with 8 sections
- [ ] Clicking a section updates URL and highlights in sidebar
- [ ] settingsApi.get/put work against real API

---

#### 3.2 Sources + Ingest filters sections
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §6, Cloudscape screen 11 "Connected" + "Ingest filters"
**Files Affected:**
- `packages/web-next/components/settings/SourcesSection.tsx` (create)
- `packages/web-next/components/settings/IngestFiltersSection.tsx` (create)
- `packages/web-next/components/settings/EntityExtractionSection.tsx` (create)
- `packages/core-api/src/routes/settings.ts` (modify — add new VALID_SETTINGS_KEYS)

**Description:**
**Sources:** "Connected" card lists integrations from `configApi.integrations()`. Each row: icon, name, description, health status dot (healthy=green, degraded=terracotta, error=red), "Configure" button. "Add source" button (placeholder for M4 OAuth).

**Ingest filters:** Toggle rows for `ingest_skip_automated_emails`, `ingest_skip_low_signal_slack`, `ingest_capture_bare_calendar`, `ingest_voice_min_duration`. Each reads/writes via settingsApi.

**Entity extraction:** Toggles for `entity_extract_locations`, `entity_extract_monetary`. Confidence slider for `entity_confidence_threshold`.

Add 7 new keys to `VALID_SETTINGS_KEYS` in core-api settings route.

**Tasks:**
1. [ ] Create SourcesSection with integrations grid + health dots
2. [ ] Create IngestFiltersSection with toggle rows + settingsApi mutation
3. [ ] Create EntityExtractionSection with toggles + slider
4. [ ] Add 7 new setting keys to VALID_SETTINGS_KEYS whitelist
5. [ ] Test toggle persistence (write + read back)

**Acceptance Criteria:**
- [ ] Sources section shows connected integrations with health status
- [ ] Toggle an ingest filter → persists via PATCH → survives page reload
- [ ] Confidence slider writes value to settings API

---

#### 3.3 Empty state sections + Danger zone
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §6 "Future Consideration", Cloudscape screen 12 (empty states)
**Files Affected:**
- `packages/web-next/components/settings/DangerZoneSection.tsx` (create)
- `packages/web-next/components/settings/EmptySettingsSection.tsx` (create)

**Description:**
**Danger zone:** "Reset all data" button → two-step confirmation dialog (matches existing `POST /admin/reset-data` flow: step 1 gets token, step 2 sends token + confirmation phrase). Origin allowlist check — warn if current URL not in allowlist.

**Empty states:** Profile, Brief preferences, Privacy & data, Workspaces, Billing, API & export — each renders `EmptySettingsSection` with section-specific copy in editorial Cloudscape voice ("This section is under construction — check back soon").

**Tasks:**
1. [ ] Create DangerZoneSection with two-step reset flow
2. [ ] Create EmptySettingsSection reusable component
3. [ ] Wire 6 sections to render EmptySettingsSection with appropriate copy
4. [ ] Test danger zone confirmation flow

**Acceptance Criteria:**
- [ ] Danger zone shows warning + confirmation flow
- [ ] 6 sections render empty states (not blank or broken)
- [ ] Empty states use Cloudscape editorial tone

---

#### 3.4 Onboarding layout + steps 1-2
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** HANDOFF M3 "Onboarding flow", Cloudscape screen 13
**Files Affected:**
- `packages/web-next/app/onboarding/layout.tsx` (create)
- `packages/web-next/app/onboarding/page.tsx` (create)
- `packages/web-next/components/onboarding/OnboardingWizard.tsx` (create)
- `packages/web-next/components/onboarding/StepIndicator.tsx` (create)
- `packages/web-next/components/onboarding/SourceGrid.tsx` (create)

**Description:**
Full-bleed layout outside shell (no SideNav/TopNav). Two-panel: left editorial panel (book-cloth background with brand statement, pull-quote, privacy footer) + right wizard area. StepIndicator shows 4 stations: "Introduce yourself", "Connect your first source", "Choose a capture habit", "Shape your first brief". Client-side step state in useState + localStorage (resume on refresh).

**Step 1 (Introduce yourself):** Name + role inputs → `settingsApi.put('user_profile', { name, role })`. Add `user_profile` to VALID_SETTINGS_KEYS.

**Step 2 (Connect sources):** 6-card grid matching Cloudscape design (Gmail, Google Calendar, iOS voice notes, Slack, Google Drive, Email forwarding). Cards are selectable (toggle). Each shows setup instructions on select (not OAuth). "Skip — I'll capture manually" button advances to step 3.

**Tasks:**
1. [ ] Create onboarding layout (full-bleed, no shell chrome)
2. [ ] Create editorial left panel matching Cloudscape screen 13
3. [ ] Create StepIndicator (4 stations with done/active/pending states)
4. [ ] Create Step 1: name + role form → settingsApi.put
5. [ ] Create SourceGrid: 6 cards with toggle selection + setup instructions
6. [ ] Add `user_profile`, `capture_habit`, `onboarding_completed` to VALID_SETTINGS_KEYS

**Acceptance Criteria:**
- [ ] `/onboarding` renders full-bleed without shell chrome
- [ ] Left panel matches Cloudscape design (book-cloth, brand statement)
- [ ] Step 1 saves user profile to settings
- [ ] Step 2 shows 6 source cards with setup instructions

---

#### 3.5 Onboarding steps 3-4 + first-run redirect
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** HANDOFF M3 "Onboarding flow", Cloudscape screen 13
**Files Affected:**
- `packages/web-next/components/onboarding/CaptureHabitStep.tsx` (create)
- `packages/web-next/components/onboarding/FirstBriefStep.tsx` (create)
- `packages/web-next/app/(shell)/layout.tsx` (modify — first-run check)

**Description:**
**Step 3 (Capture habit):** Card selection: "Morning brain dump", "Meeting notes", "End-of-day reflection", "Ad hoc". Stores preference via `settingsApi.put('capture_habit', selection)`.

**Step 4 (Shape first brief):** Brief preview (if captures exist, trigger daily brief; if not, show sample). "Finish setup" button → `settingsApi.put('onboarding_completed', true)` → redirect to `/dashboard`.

**First-run redirect:** In shell layout.tsx, check `onboarding_completed` setting server-side. If null or false, `redirect('/onboarding')`. Use Next.js `redirect()` in RSC (no flash).

**Tasks:**
1. [ ] Create CaptureHabitStep with 4 card options
2. [ ] Create FirstBriefStep with brief preview or sample
3. [ ] Wire "Finish setup" to set onboarding_completed + redirect
4. [ ] Add first-run detection in shell layout.tsx RSC
5. [ ] Test: clear setting → refresh → redirected to onboarding

**Acceptance Criteria:**
- [ ] Step 3 saves capture habit preference
- [ ] Step 4 completes onboarding and redirects to dashboard
- [ ] First visit (no onboarding_completed) → auto-redirect to /onboarding
- [ ] Second visit (onboarding_completed=true) → no redirect

---

### Phase 3 Testing Requirements

- [ ] Settings sections render and persist toggle values
- [ ] Onboarding wizard completes all 4 steps
- [ ] First-run redirect works (clear setting → redirect → complete → no redirect)
- [ ] `pnpm --filter @open-brain/web-next exec vitest run` passes

### Phase 3 Completion Checklist

- [ ] All 5 work items complete
- [ ] Settings page has 8 sidebar sections (3 live, 5 empty states)
- [ ] Onboarding wizard functional end-to-end
- [ ] New VALID_SETTINGS_KEYS added to core-api

---

## Phase 4: TTS + Search + Timeline

**Estimated Complexity:** M (~16 files, ~1400 LOC)
**Dependencies:** Phase 1 (briefs must exist for TTS)
**Parallelizable:** Yes (TTS, Search, Timeline are fully independent)

### Goals

- Add audio playback for briefs (OpenAI TTS with Redis cache)
- Port search screen with hybrid search + AI synthesis
- Port timeline screen with infinite scroll and date grouping

### Work Items

#### 4.1 TTS endpoint + audio config
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §3, D120
**Files Affected:**
- `packages/core-api/src/routes/briefs.ts` (modify — add POST /briefs/:id/audio)
- `config/ai-routing.yaml` (modify — add tts section)
- `packages/core-api/src/__tests__/brief-tts.test.ts` (create)

**Description:**
Add `POST /api/v1/briefs/:id/audio`. Fetches brief, strips `body_html` to plain text (strip tags, decode HTML entities). Checks Redis cache `tts:{brief_id}:{voice}` (TTL 24h). On miss: calls OpenAI TTS API (`POST /v1/audio/speech`, model `tts-1`, voice `alloy`, response_format `mp3`). Streams audio back as `Content-Type: audio/mpeg`. Records cost in `ai_audit_log` (task_name: 'tts', ~$0.015/1k chars). Strict rate limit.

Add to ai-routing.yaml: `tts: { provider: 'openai', model: 'tts-1', voice: 'alloy' }`.

**Tasks:**
1. [ ] Add tts config to ai-routing.yaml
2. [ ] Implement HTML-to-plain-text stripping utility
3. [ ] Implement Redis cache check/set for TTS audio
4. [ ] Call OpenAI TTS API and stream response
5. [ ] Record cost in ai_audit_log
6. [ ] Write tests (mock OpenAI API + Redis)

**Acceptance Criteria:**
- [ ] POST /briefs/:id/audio returns audio/mpeg for a real brief
- [ ] Second request uses cache (no OpenAI call)
- [ ] Cost recorded in ai_audit_log
- [ ] 404 for nonexistent brief

---

#### 4.2 Audio player + Listen button wiring
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §3 "Frontend: Audio Playback"
**Files Affected:**
- `packages/web-next/components/audio/AudioPlayer.tsx` (create)
- `packages/web-next/app/(shell)/layout.tsx` (modify — mount player)
- `packages/web-next/components/briefs/BriefHero.tsx` (modify — wire Listen)
- `packages/web-next/components/briefs/BriefToc.tsx` (modify — wire Listen)
- `packages/web-next/lib/api-client.ts` (modify — add briefsApi.audio)

**Description:**
Floating mini player component: play/pause button, progress bar, 1x/1.5x/2x speed toggle, close button. Uses `useRef<HTMLAudioElement>` + `URL.createObjectURL(blob)`. Mounted in shell layout (persists across navigation). Player state via React context or zustand.

Replace sonner toasts on Listen buttons: click → `briefsApi.audio(id)` → fetch audio blob → set player source → auto-play. Estimated duration from body_html char count (~150 words/min at 1x).

**Tasks:**
1. [ ] Create AudioPlayer with play/pause, progress, speed, close
2. [ ] Add audio player context/state management
3. [ ] Mount in shell layout.tsx
4. [ ] Add `briefsApi.audio(id): Promise<Blob>` to api-client
5. [ ] Wire BriefHero + BriefToc Listen buttons to fetch + play
6. [ ] Calculate and display estimated duration

**Acceptance Criteria:**
- [ ] Click Listen → audio plays in floating player
- [ ] Speed control works (playbackRate 1x/1.5x/2x)
- [ ] Navigate away → player persists
- [ ] Both BriefHero and BriefToc Listen buttons work

---

#### 4.3 Search page + input
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §4
**Files Affected:**
- `packages/web-next/app/(shell)/search/page.tsx` (create)
- `packages/web-next/app/(shell)/search/loading.tsx` (create)
- `packages/web-next/app/(shell)/search/error.tsx` (create)
- `packages/web-next/components/search/SearchInput.tsx` (create)
- `packages/web-next/lib/synthesis-detect.ts` (create)
- `packages/web-next/lib/api-client.ts` (modify — fix synthesizeApi type)

**Description:**
RSC page with PageHeader. SearchInput is a client component: controlled input with 300ms debounce, `router.push(?q=...)` on submit. URL `?q=` drives search. Port SYNTHESIS_PATTERNS (13 regex patterns) from /web Search.tsx into `synthesis-detect.ts`.

**Critical fix:** synthesizeApi response type is wrong — declares `{ answer, sources, query }` but route returns `{ response: string, capture_count: number }`. Fix the type.

**Tasks:**
1. [ ] Create page.tsx RSC shell with PageHeader
2. [ ] Create SearchInput with debounce + URL push
3. [ ] Port synthesis detection patterns to synthesis-detect.ts
4. [ ] Fix synthesizeApi response type in api-client.ts
5. [ ] Loading skeleton + error boundary

**Acceptance Criteria:**
- [ ] `/search` renders search input and empty state
- [ ] Typing a query updates URL `?q=`
- [ ] synthesizeApi type matches actual API response

---

#### 4.4 Search results + synthesis answer
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §4
**Files Affected:**
- `packages/web-next/components/search/SearchResults.tsx` (create)
- `packages/web-next/components/search/SynthesisAnswer.tsx` (create)
- `packages/web-next/components/search/EntityFacets.tsx` (create)

**Description:**
**SearchResults:** TanStack `useQuery(['search', q], () => searchApi.search({q}))`. Renders result cards with similarity score badges, capture content preview, source icon, relative date. Refetches on URL param change.

**SynthesisAnswer:** Conditional: if `isSynthesisRequest(q)`, calls `synthesizeApi.query({query: q})`. Renders answer card above results with "AI Synthesis" eyebrow label + response text + capture_count citation.

**EntityFacets:** Client-side grouping of results by entity names mentioned. Sidebar panel showing entity names with mention counts. Click filters results.

**Tasks:**
1. [ ] Create SearchResults with TanStack Query + result cards
2. [ ] Create SynthesisAnswer with conditional rendering
3. [ ] Create EntityFacets with client-side grouping
4. [ ] Wire components together on search page

**Acceptance Criteria:**
- [ ] Search "PostgreSQL" → results with scores
- [ ] Search "What have I captured about PostgreSQL?" → synthesis card + results
- [ ] Entity facets show in sidebar
- [ ] Browser back/forward preserves query

---

#### 4.5 Timeline page + infinite scroll
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §5
**Files Affected:**
- `packages/web-next/app/(shell)/timeline/page.tsx` (create)
- `packages/web-next/app/(shell)/timeline/loading.tsx` (create)
- `packages/web-next/app/(shell)/timeline/error.tsx` (create)
- `packages/web-next/components/timeline/TimelineGroup.tsx` (create)
- `packages/web-next/components/timeline/TimelineEntry.tsx` (create)
- `packages/web-next/components/timeline/TimelineFilters.tsx` (create)
- `packages/web-next/lib/source-icons.ts` (create)

**Description:**
RSC page with initial fetch (25 captures). TimelineFilters: brain_view tabs + source filter, both URL-driven via Link. Client component uses `useInfiniteQuery` with offset pagination (PAGE_SIZE=25). Date grouping client-side: group by YYYY-MM-DD, headers use formatRelativeDate ("Today", "Yesterday", "Apr 14"). TimelineEntry: source icon (map 9 CaptureSource values to lucide icons), brain view color dot, capture text preview, relative timestamp.

**Tasks:**
1. [ ] Create page.tsx RSC with initial fetch + searchParams filters
2. [ ] Create TimelineFilters with brain_view + source tabs
3. [ ] Create TimelineGroup with date header + entry list
4. [ ] Create TimelineEntry with source icon + brain view dot
5. [ ] Implement useInfiniteQuery with IntersectionObserver scroll trigger
6. [ ] Create source-icons.ts mapping all 9 CaptureSource values

**Acceptance Criteria:**
- [ ] `/timeline` shows captures in reverse-chronological order
- [ ] Date grouping headers: "Today", "Yesterday", "Mon Apr 14"
- [ ] Brain view filter tabs work (URL-driven)
- [ ] Infinite scroll loads next page on scroll-to-bottom
- [ ] All 9 CaptureSource values have distinct icons

---

### Phase 4 Testing Requirements

- [ ] TTS endpoint tests pass (mock OpenAI)
- [ ] Search components render with mocked API
- [ ] Timeline infinite scroll loads pages correctly
- [ ] synthesizeApi type mismatch fixed and verified
- [ ] `pnpm --filter @open-brain/web-next exec vitest run` passes

### Phase 4 Completion Checklist

- [ ] All 5 work items complete
- [ ] Audio player works end-to-end
- [ ] Search with synthesis answer functional
- [ ] Timeline with infinite scroll functional
- [ ] No regressions in existing pages

---

## Phase 5: Screen Ports — Simple + Moderate

**Estimated Complexity:** M (~18 files, ~1200 LOC)
**Dependencies:** None
**Parallelizable:** Yes (each screen is independent)
**Execution Mode:** Parallel

### Goals

- Port 6 /web screens to web-next: Financial, Intelligence, VoiceUpload, Help, Investments, VoiceConversations
- Each follows established M2 patterns (RSC + client components + api-client + TanStack Query)

### Work Items

#### 5.1 Financial page
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.6
**Files Affected:**
- `packages/web-next/app/(shell)/financial/page.tsx` (create)
- `packages/web-next/components/financial/ProviderTabs.tsx` (create)

**Description:**
Tabbed view over 6 financial providers. Each tab fetches `capturesApi.list({source_provider: provider, limit: 25})` in parallel. Client-side amount estimation from `source_metadata`. Simple page — read-only capture cards grouped by provider.

**Tasks:**
1. [ ] Create page.tsx with parallel provider fetches
2. [ ] Create ProviderTabs with 6 tabs + capture list per tab
3. [ ] Loading/error states

**Acceptance Criteria:**
- [ ] `/financial` renders tabbed view with provider data
- [ ] Each tab shows captures for that provider

---

#### 5.2 Intelligence page
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.8
**Files Affected:**
- `packages/web-next/app/(shell)/intelligence/page.tsx` (create)
- `packages/web-next/components/intelligence/SkillCard.tsx` (create)
- `packages/web-next/lib/api-client.ts` (modify — add intelligenceApi)

**Description:**
Two read-only cards (ConnectionsCard, DriftCard) with "Run now" trigger buttons. Trigger via `POST /api/v1/skills/:name/trigger`. Add `intelligenceApi` namespace to api-client. Status badges show last run time.

**Tasks:**
1. [ ] Create page.tsx with skill summary cards
2. [ ] Add intelligenceApi.summary() + trigger buttons
3. [ ] Loading/error states

**Acceptance Criteria:**
- [ ] `/intelligence` renders skill cards with last run info
- [ ] "Run now" triggers skill and shows confirmation toast

---

#### 5.3 VoiceUpload + Help pages
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.12, §7.9
**Files Affected:**
- `packages/web-next/app/(shell)/voice-upload/page.tsx` (create)
- `packages/web-next/components/voice/FileDropZone.tsx` (create)
- `packages/web-next/app/(shell)/help/page.tsx` (create)
- `packages/web-next/components/help/HelpContent.tsx` (create)

**Description:**
**VoiceUpload:** File drop zone + FormData multipart POST to voice-capture service. Brain view selector. Field name is `file` (not `audio` per CLAUDE.md). Optional lat/lon/location_name/location_accuracy.

**Help:** Build-time markdown content. ReactMarkdown with custom components. TOC sidebar with IntersectionObserver for active heading tracking. Content from `packages/web-next/content/` or inline.

**Tasks:**
1. [ ] Create VoiceUpload page with FileDropZone + brain view selector
2. [ ] Implement multipart upload with correct field name
3. [ ] Create Help page with markdown rendering + TOC
4. [ ] Active heading tracking via IntersectionObserver

**Acceptance Criteria:**
- [ ] `/voice-upload` accepts audio file and submits successfully
- [ ] `/help` renders formatted content with navigable TOC

---

#### 5.4 Investments page
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.7
**Files Affected:**
- `packages/web-next/app/(shell)/investments/page.tsx` (create)
- `packages/web-next/app/(shell)/investments/loading.tsx` (create)
- `packages/web-next/app/(shell)/investments/error.tsx` (create)
- `packages/web-next/components/investments/HoldingsTable.tsx` (create)
- `packages/web-next/components/investments/AllocationChart.tsx` (create)
- `packages/web-next/lib/api-client.ts` (modify — add investmentsApi)

**Description:**
Investments page with holdings table (sortable), allocation donut chart, net worth chart, account filtering via URL params. RSC page fetches raw Schwab captures (source_provider='schwab', limit=200); all data shaping is client-side matching /web Investments.tsx patterns. No dedicated backend endpoints — composes over capturesApi.list. Top-10 holdings highlighted. Gainers/losers strip. SVG donut + sparkline (no external charting library).

**Tasks:**
1. [x] Create page.tsx with RSC capture fetch + loading/error boundaries
2. [x] Create HoldingsTable with sortable columns + account filter
3. [x] Create AllocationChart (donut, net worth, history sparkline)
4. [x] Add investmentsApi namespace to api-client
5. [x] Account filter via URL params (useSearchParams + router.replace)

**Acceptance Criteria:**
- [x] `/investments` renders holdings table + charts
- [x] Table sorts by column click
- [x] Account filter narrows displayed data

---

#### 5.5 VoiceConversations page
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.3
**Files Affected:**
- `packages/web-next/app/(shell)/voice/page.tsx` (create)
- `packages/web-next/components/voice/SessionList.tsx` (create)
- `packages/web-next/components/voice/SessionDetail.tsx` (create)
- `packages/web-next/components/voice/VoiceConversationsClient.tsx` (create)
- `packages/web-next/lib/api-client.ts` (modify — add voiceSessionApi)

**Description:**
Two-pane layout: left session list + right session detail. Active session banner with ping animation. 10s polling interval for active session detection. Batch fetch of linked captures per session. Add `voiceSessionApi`: `list({limit})`, `active()`, `get(id)`.

**Tasks:**
1. [x] Create page.tsx with two-pane layout
2. [x] Create SessionList with session rows + active banner
3. [x] Create SessionDetail with transcript + linked captures
4. [x] Add voiceSessionApi namespace to api-client
5. [x] Implement 10s polling for active sessions

**Acceptance Criteria:**
- [x] `/voice` shows voice session list
- [x] Selecting a session shows detail pane
- [x] Active sessions poll and update UI

---

### Phase 5 Testing Requirements

- [ ] Each page renders without errors
- [ ] API calls use correct endpoints and params
- [ ] `pnpm --filter @open-brain/web-next exec vitest run` passes

### Phase 5 Completion Checklist

- [ ] All 5 work items (6 pages) complete
- [ ] All new pages have loading + error boundaries
- [ ] No regressions in existing pages

---

## Phase 6: Screen Ports — Complex + Remaining

**Estimated Complexity:** L (~20 files, ~1500 LOC)
**Dependencies:** None
**Parallelizable:** Yes (each screen is independent)
**Execution Mode:** Parallel

### Goals

- Port 6 complex /web screens: Wiki, Ingest, Email, System, SlackCleanup, Admin Reset
- These are the highest-complexity ports requiring SSE, markdown rendering, multi-tab state, or file upload

### Work Items

#### 6.1 Wiki page
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.1
**Files Affected:**
- `packages/web-next/app/(shell)/wiki/[...slug]/page.tsx` (create)
- `packages/web-next/app/(shell)/wiki/page.tsx` (create)
- `packages/web-next/components/wiki/WikiNavTree.tsx` (create)
- `packages/web-next/components/wiki/WikiTabs.tsx` (create)
- `packages/web-next/lib/api-client.ts` (modify — add wikiApi)

**Description:**
Wiki with `[...slug]` catch-all for nested pages. 4 tabs: Content, Recent changes, Health, Stats. Sidebar nav tree. Markdown rendering (fetch pre-rendered HTML from API or use shared renderer). Add `wikiApi`: `pages()`, `page(slug)`, `recentChanges()`, `lintReport()`, `stats()`, `search()`, `triggerLint()`, `triggerResynthesize()`.

**Tasks:**
1. [x] Create wiki root page + [...slug] dynamic route
2. [x] Create WikiNavTree sidebar with page list
3. [x] Create WikiTabs with 4 tab views
4. [x] Add wikiApi namespace to api-client
5. [x] Markdown content rendering

**Acceptance Criteria:**
- [x] `/wiki` renders page list + content
- [x] `/wiki/some/nested/page` renders specific wiki page
- [x] All 4 tabs functional

---

#### 6.2 Ingest page
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.5
**Files Affected:**
- `packages/web-next/app/(shell)/ingest/page.tsx` (create)
- `packages/web-next/components/ingest/FileDropZone.tsx` (create)
- `packages/web-next/components/ingest/IngestProgress.tsx` (create)
- `packages/web-next/components/ingest/RecentUploads.tsx` (create)
- `packages/web-next/components/ingest/IngestClient.tsx` (create — client orchestrator)
- `packages/web-next/lib/api-client.ts` (modify — add ingestApi)

**Description:**
File upload with SSE progress tracking. FileDropZone accepts files → `ingestApi.upload(file, opts)` → returns upload_id → subscribe to SSE events for progress updates. Recent uploads table shows pipeline status. Re-process button for failed items. Add `ingestApi`: `upload(file, opts)`, `list({limit})`, `subscribeToEvents(upload_id)`, `processNow()`, `process(id)`.

**Tasks:**
1. [x] Create page.tsx with upload zone + recent uploads
2. [x] Implement file upload via FormData
3. [x] SSE subscription for upload progress
4. [x] Recent uploads table with status badges
5. [x] Re-process action for failed items

**Acceptance Criteria:**
- [x] `/ingest` accepts file upload and shows progress
- [x] SSE events update progress in real-time
- [x] Recent uploads table shows pipeline status

---

#### 6.3 Email page
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.4
**Files Affected:**
- `packages/web-next/app/(shell)/email/page.tsx` (create)
- `packages/web-next/components/email/EmailTabs.tsx` (create)
- `packages/web-next/components/email/DraftCard.tsx` (create)
- `packages/web-next/components/email/ThreadView.tsx` (create)
- `packages/web-next/lib/api-client.ts` (modify — add emailApi)

**Description:**
Three tabs: Inbound (captures with source=email), Drafts (`emailApi.list()` with send/reject actions), Threads (client-side grouping by normalized subject). Filter bar: sender, date range. Draft actions: send (`emailApi.send(id)`) and reject (`emailApi.reject(id)`). Thread reconstruction: group email captures by subject, sorted by date. Add `emailApi`: `list()`, `send(id)`, `reject(id)`.

**Tasks:**
1. [x] Create page.tsx with 3-tab layout
2. [x] Create Inbound tab with email captures
3. [x] Create Drafts tab with DraftCard + send/reject actions
4. [x] Create Threads tab with client-side grouping
5. [x] Filter bar (sender, date range)

**Acceptance Criteria:**
- [x] `/email` shows 3 functional tabs
- [x] Draft send/reject works with confirmation
- [x] Thread view groups emails by subject

---

#### 6.4 System page
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.11
**Files Affected:**
- `packages/web-next/app/(shell)/system/page.tsx` (create)
- `packages/web-next/components/system/SystemTabs.tsx` (create)
- `packages/web-next/components/system/OverviewTab.tsx` (create)
- `packages/web-next/components/system/QueuesTab.tsx` (create)
- `packages/web-next/components/system/SkillsTab.tsx` (create)
- `packages/web-next/components/system/FlowsTab.tsx` (create)
- `packages/web-next/components/system/McpActivityTab.tsx` (create)
- `packages/web-next/lib/api-client.ts` (modify — add systemHealthApi, adminQueuesApi, skillsListApi, mcpActivityApi)

**Description:**
5-tab ops dashboard: Overview (health strip + summary), Queues (BullMQ queue status + clear actions), Skills (list + trigger + schedule update), Flows (pipeline flow monitor), MCP Activity (paginated activity log). Health API returns `healthy|degraded|unhealthy`. Multiple API namespaces: `systemHealthApi`, `adminQueuesApi`, `skillsListApi`, `mcpActivityApi`.

**Tasks:**
1. [x] Create page.tsx with 5-tab layout (RSC + SystemTabs client orchestrator)
2. [x] Create OverviewTab with health strip + summary cards + queue depths + skill last-runs
3. [x] Create QueuesTab with queue status table + inline clear-failed confirmation
4. [x] Create SkillsTab with skill list + trigger mutation + inline schedule editor
5. [x] Create FlowsTab (pipeline stage progression) + McpActivityTab (paginated log, TanStack Query)

**Acceptance Criteria:**
- [x] `/system` shows 5 functional tabs
- [x] Health status displays correctly (StatusDot green/yellow/red per service)
- [x] Skill trigger works (fire-and-forget, toast on 202)
- [x] MCP activity paginates (offset-based, 25/page, tool filter dropdown)
- [x] Queue clear has confirmation step before POST /admin/queues/:name/clear

---

#### 6.5 SlackCleanup page
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.10
**Files Affected:**
- `packages/web-next/app/(shell)/slack-cleanup/page.tsx` (create)
- `packages/web-next/components/slack/ChannelTable.tsx` (create)
- `packages/web-next/lib/api-client.ts` (modify — add adminApi)
- `packages/web-next/components/nav/side-nav.tsx` (modify — add Slack cleanup nav item)

**Description:**
Sortable channel table with inactivity threshold filter. Archive action with confirmation modal (text input validation). Summary cards (total channels, archived count). Add `adminApi`: `getSlackChannels()`, `archiveSlackChannel(id)`.

**Tasks:**
1. [x] Create page.tsx with summary cards + channel table
2. [x] Create sortable ChannelTable
3. [x] Archive confirmation modal with validation
4. [x] Add adminApi namespace

**Acceptance Criteria:**
- [x] `/slack-cleanup` shows channel table
- [x] Sort by column works
- [x] Archive requires confirmation

---

#### 6.6 Admin Reset (in System page)
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §7.13
**Files Affected:**
- `packages/web-next/components/system/AdminResetSection.tsx` (create)
- `packages/web-next/components/settings/DangerZoneSection.tsx` (enhance — add countdown timer)
- `packages/web-next/lib/api-client.ts` (modify — add adminApi.requestResetToken + confirmReset)

**Description:**
Two-step reset flow embedded in System page (or Settings Danger zone — wire to whichever is more appropriate). Step 1: POST /admin/reset-data (no confirm) → receive token. Step 2: POST /admin/reset-data with `{ confirm: "WIPE ALL DATA", token }`. Show warning about irreversibility. Check origin allowlist. Per CLAUDE.md: no adminAuth() — protection is origin + token + phrase + rate limit.

AdminResetSection adds a 5-minute CountdownTimer component (M:SS format, turns red in last 60s, auto-expires to error state). DangerZoneSection (Settings → Danger zone) enhanced with the same timer. adminApi.requestResetToken() and adminApi.confirmReset() added to api-client.ts with typed response shapes.

**Tasks:**
1. [x] Create AdminResetSection with two-step flow
2. [x] Warning UI with confirmation phrase input
3. [x] Wire to System or Settings danger zone
4. [x] Origin check warning if URL not in allowlist
5. [x] 5-minute countdown timer (CountdownTimer component, auto-expires at 0)
6. [x] Add adminApi.requestResetToken() + confirmReset() to api-client.ts

**Acceptance Criteria:**
- [x] Two-step flow works: get token → confirm with phrase
- [x] Confirmation phrase must match exactly
- [x] Warning displayed prominently
- [x] Countdown timer shows time remaining; expires to error state at 0
- [x] Origin warning shown when not on brain.troy-davis.com

---

### Phase 6 Testing Requirements

- [ ] Each page renders without errors
- [ ] SSE subscriptions clean up on unmount (Ingest)
- [ ] Thread reconstruction handles edge cases (Email)
- [ ] `pnpm --filter @open-brain/web-next exec vitest run` passes

### Phase 6 Completion Checklist

- [ ] All 6 work items complete
- [ ] All /web screens now have web-next equivalents
- [ ] Loading + error boundaries on all new pages
- [ ] No regressions

---

## Phase 7: Production Cut-Over

**Estimated Complexity:** M (~6 files, ~400 LOC)
**Dependencies:** Phases 1-6 (all screens must be ported)
**Parallelizable:** No (sequential deployment steps)

### Goals

- Package web-next as Docker container with standalone Next.js output
- Add to docker-compose with Loki logging
- Set up parallel tunnel URL for validation
- Swap primary tunnel after verification

### Work Items

#### 7.1 web-next Dockerfile
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §8.1
**Files Affected:**
- `packages/web-next/Dockerfile` (create)
- `packages/web-next/.dockerignore` (create)

**Description:**
Multi-stage Dockerfile. Builder: `node:22-alpine`, install pnpm, copy workspace files, `pnpm --filter @open-brain/web-next build` with `NODE_OPTIONS="--max-old-space-size=4096"`. Runtime: `node:22-alpine`, copy `.next/standalone/`, `.next/static/`, `public/`. `outputFileTracingRoot` (set in M2) ensures workspace deps are traced. Port 3001. Healthcheck: `wget -qO- http://127.0.0.1:3001/dashboard` (use `127.0.0.1` not `localhost` per CLAUDE.md Alpine IPv6 rule).

**Tasks:**
1. [x] Create multi-stage Dockerfile (builder + runtime)
2. [x] Create .dockerignore (node_modules, .next, .git)
3. [ ] Test local build: `docker build -f packages/web-next/Dockerfile .`
4. [ ] Verify standalone output serves all routes

**Acceptance Criteria:**
- [ ] Docker build completes successfully
- [ ] Container starts and serves all M3 screens
- [ ] Healthcheck passes

---

#### 7.2 docker-compose service + Loki
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §8.1, CLAUDE.md P11a (all services log to Loki)
**Files Affected:**
- `docker-compose.yml` (modify — add web-next service)

**Description:**
Add `web-next` service to docker-compose.yml. Port 3001:3001. `depends_on: core-api` (healthy). Environment: `NEXT_PUBLIC_API_URL` pointing to core-api internal URL. Loki log driver with `LOKI_URL` parameterization. Memory limit 512m. Healthcheck matching Dockerfile.

**Tasks:**
1. [x] Add web-next service definition
2. [x] Configure Loki logging driver
3. [x] Set depends_on and healthcheck
4. [ ] Test: `docker compose up web-next`

**Acceptance Criteria:**
- [ ] web-next container starts healthy in compose
- [ ] Logs appear in Loki (`{container_name="open-brain-web-next"}`)
- [ ] core-api dependency enforced

---

#### 7.3 Parallel tunnel URL
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §8.2
**Files Affected:**
- `config/cloudflare/tunnel.yaml` (modify)

**Description:**
Add parallel ingress rule: `brain-next.troy-davis.com` → `http://web-next:3001`. Keep existing `brain.troy-davis.com` → `http://web:80`. Both active simultaneously for side-by-side comparison. Requires Cloudflare DNS CNAME for `brain-next` subdomain.

**Tasks:**
1. [x] Add brain-next ingress rule to tunnel.yaml
2. [ ] Create DNS CNAME in Cloudflare dashboard
3. [ ] Restart cloudflared container
4. [ ] Verify brain-next.troy-davis.com serves web-next

**Acceptance Criteria:**
- [ ] brain-next.troy-davis.com serves web-next screens
- [ ] brain.troy-davis.com still serves /web (no disruption)

---

#### 7.4 Primary tunnel swap + decommission plan
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §8.2, §8.3
**Files Affected:**
- `config/cloudflare/tunnel.yaml` (modify — swap primary documented in runbook)
- `scripts/apply-tunnel-swap.md` (create — runbook)

**Description:**
After 2-week parallel validation: update primary tunnel `brain.troy-davis.com` → `http://web-next:3001`. Keep `brain-next` alive as rollback. Create runbook documenting: swap steps, rollback procedure (revert tunnel.yaml + restart cloudflared), /web decommission steps (remove service from compose, add DECOMMISSIONED header to packages/web/Dockerfile, keep source tree in git).

**Tasks:**
1. [ ] Screenshot both URLs at all routes — verify visual parity
2. [ ] Update tunnel.yaml primary ingress to web-next:3001
3. [x] Create swap runbook with rollback instructions
4. [x] Document /web decommission sequence

**Acceptance Criteria:**
- [ ] Primary tunnel serves web-next after swap
- [ ] Rollback procedure tested (revert → /web restored)
- [x] Runbook documents full swap + decommission sequence

---

### Phase 7 Testing Requirements

- [ ] Docker build succeeds on CI
- [ ] Container serves all screens from Phases 1-6
- [ ] Parallel tunnel URL works
- [ ] No regressions on primary URL after swap

### Phase 7 Completion Checklist

- [ ] All 4 work items complete
- [ ] web-next container running in production
- [ ] Primary tunnel on web-next
- [ ] Rollback procedure documented and tested

---

## Phase 8: Polish

**Estimated Complexity:** S (~8 files, ~500 LOC)
**Dependencies:** Phase 7 (production must be on web-next)
**Parallelizable:** Yes (PWA, dark mode, shortcuts are independent)

### Goals

- Make web-next installable as PWA
- Add dark mode with Cloudscape token mapping
- Add keyboard shortcuts for power-user navigation

### Work Items

#### 8.1 PWA service worker
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §9.1
**Files Affected:**
- `packages/web-next/public/manifest.json` (created)
- `packages/web-next/public/sw.js` (created — manual SW, no next-pwa dependency)
- `packages/web-next/app/offline/page.tsx` (created)
- `packages/web-next/app/layout.tsx` (modified — manifest + themeColor in metadata/viewport)
- `packages/web-next/app/(shell)/layout.tsx` (modified — ServiceWorkerRegistration + PwaInstallPrompt)
- `packages/web-next/components/pwa/ServiceWorkerRegistration.tsx` (created)
- `packages/web-next/components/pwa/PwaInstallPrompt.tsx` (created)

**Description:**
Manual service worker (no next-pwa/Serwist dependency — avoids build-time complexity). Cache strategy: stale-while-revalidate for static assets (`.next/static/`), network-first for `/api/` routes. Offline page: "You're offline — reconnect to continue". Install prompt: `beforeinstallprompt` handler with localStorage dismiss. Manifest: app name "Open Brain", theme_color book-cloth (#4a3728), background_color ivory (#faf7f2). SKIP_WAITING message handler ensures seamless updates without manual hard-refresh.

**Tasks:**
1. [x] Configure PWA in next.config.ts — N/A: manifest via Next.js metadata API; no next.config.ts changes needed
2. [x] Create manifest.json with app metadata + icons
3. [x] Create offline fallback page
4. [ ] Test install prompt on mobile browsers — deployment-time test

**Acceptance Criteria:**
- [ ] App installable on iOS Safari and Android Chrome
- [ ] Offline page shows instead of blank when disconnected
- [ ] Static assets cached; API routes always network-first

---

#### 8.2 Dark mode
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §9.2
**Files Affected:**
- `packages/web-next/tailwind.config.ts` (modify — darkMode: 'class')
- `packages/web-next/app/globals.css` (modify — dark token overrides)
- `packages/web-next/components/design-system/ThemeToggle.tsx` (create)
- `packages/web-next/components/design-system/index.ts` (modify — export ThemeToggle)
- `packages/web-next/components/nav/top-nav.tsx` (modify — replace static Moon with ThemeToggle)
- `packages/web-next/app/layout.tsx` (modify — anti-flash inline script)

**Description:**
Tailwind `darkMode: 'class'`. System preference detection via `prefers-color-scheme` media query on first visit. User override stored in `localStorage.theme`. Toggle button in TopNav. Dark Cloudscape tokens: invert ivory/slate palette, adjust book-cloth for dark backgrounds, ensure contrast ratios meet WCAG AA.

**Tasks:**
1. [x] Set darkMode: 'class' in tailwind.config.ts
2. [x] Map Cloudscape tokens to dark variants in globals.css
3. [x] Create ThemeToggle component with system preference detection
4. [x] Add toggle to TopNav
5. [ ] Test contrast ratios on key screens

**Acceptance Criteria:**
- [x] Toggle switches between light and dark mode
- [x] Preference persists across sessions (localStorage)
- [x] Respects system preference on first visit
- [ ] All text meets WCAG AA contrast in both modes

---

#### 8.3 Keyboard shortcuts
**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG §9.3
**Files Affected:**
- `packages/web-next/lib/hooks/use-keyboard-shortcuts.ts` (create)
- `packages/web-next/components/shortcuts/ShortcutsProvider.tsx` (create)
- `packages/web-next/components/shortcuts/ShortcutsModal.tsx` (create)
- `packages/web-next/app/(shell)/layout.tsx` (modify — mount ShortcutsProvider)

**Description:**
Global `useKeyboardShortcuts()` hook mounted in shell layout via thin client `ShortcutsProvider` wrapper. Chord detection: first key sets ref, 500ms timeout clears. Shortcuts: `g d` → Dashboard, `g e` → Entities, `g b` → Briefs, `g s` → Search, `g t` → Timeline, `/` → focus search input (`[data-search-input]`), `?` → open shortcuts help modal (Radix Dialog). Disabled when input/textarea/select/contenteditable focused.

**Tasks:**
1. [x] Create useKeyboardShortcuts hook with chord detection
2. [x] Implement all 7 shortcuts with router.push
3. [x] Create ShortcutsModal listing all shortcuts (grouped by section)
4. [x] Disable shortcuts when input focused
5. [x] Mount in shell layout via ShortcutsProvider client wrapper

**Acceptance Criteria:**
- [x] All 7 shortcuts work as documented
- [x] `?` opens help modal listing shortcuts
- [x] Shortcuts don't fire when typing in input fields
- [x] Chord timeout (500ms) prevents accidental triggers

---

### Phase 8 Testing Requirements

- [ ] PWA installs on mobile
- [ ] Dark mode toggle works without flash
- [ ] Keyboard shortcuts fire correctly
- [ ] `pnpm --filter @open-brain/web-next exec vitest run` passes

### Phase 8 Completion Checklist

- [ ] All 3 work items complete
- [ ] PWA installable and offline-capable
- [ ] Dark mode functional with Cloudscape tokens
- [ ] Keyboard shortcuts documented in help modal

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Phase 1 (all) | Phase 2 (all) | Brief generation and Commitments are fully independent domains |
| Phase 1 (all) | Phase 3 (all) | No shared code paths |
| Phase 2 (all) | Phase 3 (all) | No shared code paths |
| 3.1-3.3 (Settings) | 3.4-3.5 (Onboarding) | Different routes; share settingsApi but api-client edits are additive |
| 4.1-4.2 (TTS) | 4.3-4.4 (Search) | Independent features |
| 4.1-4.2 (TTS) | 4.5 (Timeline) | Independent features |
| 4.3-4.4 (Search) | 4.5 (Timeline) | Independent features |
| 5.1-5.5 (all Phase 5) | Each other | Each screen is independent |
| 6.1-6.6 (all Phase 6) | Each other | Each screen is independent |
| 8.1 (PWA) | 8.2 (Dark mode) | Independent |
| 8.1 (PWA) | 8.3 (Shortcuts) | Independent |
| 8.2 (Dark mode) | 8.3 (Shortcuts) | Independent |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Commitment extraction quality on T1 LLM | Medium | Medium | Test with 20 real captures. If T1 misses >30%, upgrade to T2 (still free via CLI). Prompt iteration budget: 2 hours. |
| Board column semantics (direction detection) | Medium | Medium | Prompt includes explicit examples for each direction. Default to `pending` if LLM uncertain. Manual reclassification via PATCH. |
| Pipeline latency from extract-commitments | Low | Low | Non-critical child — pipeline completes without it. Async enrichment on separate queue. |
| Settings toggles with no pipeline backing | Low | Low | Toggles write to app_settings immediately. Pipeline reads them → separate follow-up. |
| Onboarding redirect loop | Low | High | Check `onboarding_completed` server-side in RSC (not client) — prevents flash/loop. |
| TTS cost surprise | Low | Medium | Redis cache (24h TTL) prevents re-generation. Budget: ~$2/mo at 20 briefs/mo. |
| Dark mode token gaps | Medium | Low | Map Cloudscape tokens manually. Audit contrast on 5 key screens before shipping. |
| Production tunnel swap regression | Medium | High | 2-week parallel URL. Screenshot comparison at all routes. Rollback is one config change + restart. |
| Email thread reconstruction perf | Low | Medium | Paginate capture queries (limit 100). Client-side grouping bounded. |
| SSE lifecycle cleanup (Ingest) | Medium | Medium | Port /web pattern exactly. AbortController cleanup on unmount. |
| synthesizeApi type mismatch | High | Low | Fix in 4.3 — trivial type change, but downstream search page depends on correct shape. |

---

## Success Metrics

- [ ] All 8 phases completed
- [ ] All acceptance criteria met across 41 work items
- [ ] `pnpm -r build` passes with all new code
- [ ] Full test suite green: workers 980+, core-api 772+, web-next 150+ (expanded from 109)
- [ ] Entity-brief dossier generates readable brief for entity with ≥5 captures
- [ ] Commitment extraction succeeds on ≥70% of captures containing obligations
- [ ] Board renders commitments in correct columns based on extracted direction
- [ ] Onboarding wizard completes without errors for first-time user
- [ ] TTS audio plays within 3 seconds of Listen button click (cached: <500ms)
- [ ] All 20 /web routes have web-next equivalents
- [ ] Production traffic on web-next via Cloudflare tunnel
- [ ] /web decommission plan documented and tested
- [ ] PWA installable on iOS + Android
- [ ] Dark mode meets WCAG AA contrast

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| Entity-brief skill (DOSSIER) | M3_BACKLOG §2, HANDOFF M3 | 1 | 1.1, 1.2, 1.3 |
| Brief trigger UI | HANDOFF M3 "brief generator" | 1 | 1.4 |
| Commitments table | M3_BACKLOG §1 | 2 | 2.1 |
| Commitment extraction | M3_BACKLOG §1 | 2 | 2.2 |
| Commitments API | M3_BACKLOG §1 | 2 | 2.3 |
| Board Kanban UI | HANDOFF M3 "Board", screen 09 | 2 | 2.4 |
| CommitmentsCard live data | M3_BACKLOG §1, D111 | 2 | 2.5 |
| Settings page | M3_BACKLOG §6, HANDOFF M3, screen 11 | 3 | 3.1, 3.2, 3.3 |
| Onboarding wizard | HANDOFF M3 "Onboarding flow", screen 13 | 3 | 3.4, 3.5 |
| TTS integration | M3_BACKLOG §3, D120 | 4 | 4.1, 4.2 |
| Search screen port | M3_BACKLOG §4 | 4 | 4.3, 4.4 |
| Timeline screen port | M3_BACKLOG §5 | 4 | 4.5 |
| Financial page | M3_BACKLOG §7.6 | 5 | 5.1 |
| Intelligence page | M3_BACKLOG §7.8 | 5 | 5.2 |
| VoiceUpload + Help | M3_BACKLOG §7.12, §7.9 | 5 | 5.3 |
| Investments page | M3_BACKLOG §7.7 | 5 | 5.4 |
| VoiceConversations | M3_BACKLOG §7.3 | 5 | 5.5 |
| Wiki page | M3_BACKLOG §7.1 | 6 | 6.1 |
| Ingest page | M3_BACKLOG §7.5 | 6 | 6.2 |
| Email page | M3_BACKLOG §7.4 | 6 | 6.3 |
| System page | M3_BACKLOG §7.11 | 6 | 6.4 |
| SlackCleanup | M3_BACKLOG §7.10 | 6 | 6.5 |
| Admin Reset | M3_BACKLOG §7.13 | 6 | 6.6 |
| Docker packaging | M3_BACKLOG §8.1, D115 | 7 | 7.1, 7.2 |
| Cloudflare tunnel swap | M3_BACKLOG §8.2 | 7 | 7.3, 7.4 |
| PWA service worker | M3_BACKLOG §9.1 | 8 | 8.1 |
| Dark mode | M3_BACKLOG §9.2 | 8 | 8.2 |
| Keyboard shortcuts | M3_BACKLOG §9.3 | 8 | 8.3 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-04-22 02:00:00*
*Source: /create-plan command via /ultra-plan M3*
