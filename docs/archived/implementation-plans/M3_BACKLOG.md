# M3 Backlog — Open Brain Cloudscape Web-Next

**Generated:** 2026-04-21
**M2 Close:** IMPLEMENTATION_PLAN-CLOUDSCAPE-M2.md (all 8 phases, 27 work items)
**M2 Decisions in scope:** D106–D115 (see Appendix: Decision Reference)
**Purpose:** Authoritative ordered backlog for the M3 milestone. Everything deferred from M2 is here. When prioritizing M3, start with section 1 (Commitments) and 4 (Search) as they unblock the largest user-facing gaps.

---

## Table of Contents

1. [Commitments Domain Model](#1-commitments-domain-model)
2. [Entity-Brief Skill (DOSSIER Briefs)](#2-entity-brief-skill-dossier-briefs)
3. [TTS Integration](#3-tts-integration)
4. [Search Screen Port](#4-search-screen-port)
5. [Timeline Screen Port](#5-timeline-screen-port)
6. [Settings Screen Port](#6-settings-screen-port)
7. [Remaining /web Screens](#7-remaining-web-screens)
8. [Production Cut-Over](#8-production-cut-over)
9. [Polish](#9-polish)
10. [Appendix: /web Route Inventory](#appendix-web-route-inventory)
11. [Appendix: Decision Reference](#appendix-decision-reference)

---

## 1. Commitments Domain Model

**Estimated Scope:** L
**Prerequisites:** None (independent of all other M3 items)
**M2 Context:** D111 (deferred to M3), work item 8.1 (CommitmentsCard placeholder with "Coming in M3" label)

### Description

A commitment is a forward-looking statement extracted from captures: promises, deadlines, follow-ups, obligations ("I'll send the report by Friday", "we need to revisit the budget in Q3"). Currently the system captures these facts as part of the raw capture text but has no structured way to query them, track resolution, or surface them in the UI.

The Commitments domain consists of four integrated surfaces: a Postgres table, two API endpoints, an async extraction skill, and the CommitmentsCard UI on the entity detail page.

### Backend: Database

- New migration (`0031`) creates `commitments` table:
  - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `capture_id UUID NOT NULL REFERENCES captures(id) ON DELETE CASCADE`
  - `entity_id UUID REFERENCES entities(id) ON DELETE SET NULL` — optional; committed-to entity if identifiable
  - `text TEXT NOT NULL` — verbatim extracted commitment phrase
  - `due_date DATE` — extracted date; null if no deadline
  - `resolved_at TIMESTAMPTZ` — null = open
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
  - Index: `(entity_id, resolved_at)` for entity detail panel query
  - Index: `(capture_id)` for cascade-delete audit

### Backend: API Endpoints

Two new endpoints on `packages/core-api/src/routes/commitments.ts`:

**GET /api/v1/entities/:id/commitments**
- Returns open commitments linked to entity (resolved_at IS NULL)
- Response: `{ commitments: [{ id, text, due_date, capture_id, created_at }], total: number }`
- Query params: `resolved` (boolean, default false), `limit` (int, default 20)
- Rate limit: default tier; `X-Open-Brain-Caller: web-ui` already bypassed

**PATCH /api/v1/commitments/:id**
- Accepts `{ resolved: boolean }` — sets or clears `resolved_at`
- Returns updated commitment row
- No LLM call; pure DB update

### Worker: Extraction Skill

New skill `packages/workers/src/skills/extract-commitments.ts`:
- Triggered post-`extract` stage in pipeline (alongside `extract-entities`)
- Input: capture text + classified brain_view
- Cost tier: T1 local LLM (Jetson/Spark) — short context, structured JSON output
- Prompt: extract forward-looking statements, normalize date references to ISO (relative → absolute using capture created_at as anchor)
- Output: array of `{ text, due_date_iso, entity_name }` objects
- Upsert to `commitments` table — skip exact-duplicate text per capture (SHA-256 of text)
- `minimum_autonomy`: none (reactive pipeline skill, not proactive)

Add `extract-commitments` to BullMQ pipeline after `extract` stage. Add `extract-commitments` to `BYPASS_CALLERS` if it calls core-api internally.

### Frontend: CommitmentsCard

`packages/web-next/components/entity/commitments-card.tsx` — currently shows `<EmptyState title="Coming in M3" />` (placed in M2 work item 8.1):
- Replace EmptyState with live data from `entitiesApi.commitments(entityId)`
- Display: list of open commitments sorted by due_date ASC (soonest first), overdue highlighted
- Each row: commitment text, due date badge (red if overdue), "Mark resolved" checkbox
- Mark resolved: `useMutation(commitmentsApi.patch)` + optimistic update + query invalidation
- Empty state: "No open commitments" (not an error condition)
- Add `commitmentsApi` namespace to `packages/web-next/lib/api-client.ts`

### Acceptance Criteria

- [ ] Migration 0031 applied without data loss on homeserver
- [ ] `GET /entities/:id/commitments` returns structured list, open commitments first
- [ ] `PATCH /commitments/:id` toggles resolved state and clears/sets `resolved_at`
- [ ] Extraction skill processes a real capture containing a future commitment and creates a DB row
- [ ] CommitmentsCard on `/entities/:id` shows live open commitments and allows resolve toggle
- [ ] Overdue commitments (due_date < today, resolved_at IS NULL) visually distinguished
- [ ] `pnpm -r build` and full test suite pass with new skill registered

---

## 2. Entity-Brief Skill (DOSSIER Briefs)

**Estimated Scope:** M
**Prerequisites:** M2 briefs infrastructure (migration 0030, BriefsService, `brief_created` SSE) must be deployed
**M2 Context:** D107 (first-class briefs table with DOSSIER kind), work item 8.1 ("Generate brief" button stubbed with sonner toast)

### Description

The M2 `briefs` table includes a `DOSSIER` kind reserved for entity-specific intelligence reports. The "Generate brief" button on the entity detail page currently fires a sonner toast with "Coming in M3." M3 wires it end-to-end: button click → POST /entities/:id/brief → BullMQ job → `entity-brief` skill → write `briefs` row → `brief_created` SSE → client navigates to `/briefs/{id}`.

### Backend: Endpoint

**POST /api/v1/entities/:id/brief**
- Enqueues `entity-brief` BullMQ job; returns `202 Accepted` with `{ job_id }`
- Rate limit: strict (LLM-heavy); same tier as `/briefs/:id/refine`
- Caller: `web-ui` already bypassed

### Worker: entity-brief Skill

New skill `packages/workers/src/skills/entity-brief.ts`:
- Extends `BaseSkill`; `minimum_autonomy: 'observe'` (informational, always safe)
- Input: `entityId`, `entityName`, `entityType`
- Steps:
  1. Fetch entity row + top-50 captures mentioning entity (FTS rank on entity name)
  2. Fetch entity's related entities (1 hop via `spreading_activation`)
  3. Assemble context block: entity summary + sorted captures (newest first)
  4. Synthesize via `LLMGatewayService.completeByTask('search_synthesis')` — reuse existing task key (same quality tier, no new routing entry needed)
  5. Render via existing `unified` renderer (Phase 5 infrastructure) → `body_html`, `toc`, `sources`
  6. Write `briefs` row: `kind: 'DOSSIER'`, `entity_id: entityId`, fill `body_html`/`toc`/`sources`
  7. Emit `brief_created` pg-notify event → SSE push → client-side `['briefs']` cache invalidation

- `refine_options`: pre-populate with `['Focus on recent', 'Focus on decisions', 'Key relationships only']` — different from DAILY/WEEKLY presets

### Frontend: Wire Button

In `packages/web-next/components/entity/entity-header.tsx`:
- "Generate brief" button → `useMutation(entitiesApi.brief)` → sonner "Generating brief..." (spinning)
- On SSE `brief_created` with matching `entity_id`: toast "Brief ready" with link → navigate to `/briefs/{id}`
- On error: sonner error toast

Add `entitiesApi.brief(entityId)` method to `packages/web-next/lib/api-client.ts`.

### Acceptance Criteria

- [ ] POST /entities/:id/brief returns 202 and enqueues job
- [ ] `entity-brief` skill produces a readable DOSSIER brief for a real entity with ≥5 linked captures
- [ ] `brief_created` SSE event arrives at the client within 30 seconds of button click
- [ ] Client navigates to the new brief after SSE arrival
- [ ] Brief body_html renders in BriefReader with entity name in title
- [ ] Skill gracefully handles entity with 0 linked captures (writes brief with "No captures found for this entity" body, still completes)

---

## 3. TTS Integration

**Estimated Scope:** M
**Prerequisites:** Section 2 (entity-brief skill) — "Listen" buttons on briefs are the primary TTS surface; briefs must exist and have body_html before TTS is meaningful
**M2 Context:** D113 (Radix Dialog + sonner; Listen buttons intentionally stubbed), work items 8.2 and 8.3 ("Text-to-speech coming in M3" toasts)

### Description

Three "Listen" entry points exist in the M2 UI, all showing M3 toasts: BriefHero (briefs list), BriefToc (brief reader), and a future entity dossier. TTS converts `body_html` (stripped to plain text) to an audio stream delivered as a Web Audio API playback or file download.

### Provider Evaluation

Before implementing, run a time-boxed comparison (≤2 hours) of three providers against a representative brief (~600 words):

| Provider | API | Latency (TTFA) | Quality | Cost | Notes |
|----------|-----|---------------|---------|------|-------|
| **Deepgram Aura** | REST streaming | ~300ms | Good, multiple voices | $0.015/1k chars | Already have key via Bitwarden `open-brain-deepgram-api-key`; voice-capture uses Deepgram STT — natural pairing |
| **OpenAI TTS** | `POST /v1/audio/speech` | ~500ms | Excellent | $0.015/1k chars | Same OpenAI key; `tts-1-hd` model; mp3/opus/aac/flac output |
| **ElevenLabs** | REST | ~400ms | Best naturalness | $0.008/char (free: 10k chars/mo) | Requires new key; free tier is marginal for regular use |

**Recommendation:** Start with OpenAI TTS (`tts-1` model, `alloy` voice) — no new key, lowest integration cost, good quality. If naturalness is unsatisfactory after real use, swap to Deepgram Aura (same key category). ElevenLabs only if neither satisfies.

### Backend: TTS Endpoint

**POST /api/v1/briefs/:id/audio**
- Strips `body_html` to plain text (strip tags, decode HTML entities)
- Calls TTS provider API; streams audio response back to client
- Content-Type: `audio/mpeg`
- Cache: store audio in `admin_prewipe_backup` volume or Redis (TTL 24h) keyed by `brief_id` — avoid re-generating for same brief. Cache key: `tts:{brief_id}:{voice}`.
- Rate limit: strict tier (paid API per-call)
- Add `X-Open-Brain-Caller: web-ui` bypass already in place

### Frontend: Audio Playback

Replace sonner toasts on "Listen" buttons with:
- Click → POST /briefs/:id/audio → `<audio>` element with blob URL
- Mini player UI: play/pause, progress bar, 1x/1.5x/2x speed, close
- Player persists across brief navigation (floating, not in-page) — place in shell layout
- Use `useRef<HTMLAudioElement>` + `URL.createObjectURL(blob)`

### Acceptance Criteria

- [ ] POST /briefs/:id/audio returns audio/mpeg stream for a real brief
- [ ] Audio plays correctly in browser via the mini player component
- [ ] Player speed control works (playbackRate)
- [ ] Audio is cached server-side; second click does not re-call TTS API
- [ ] Cost recorded in `ai_audit_log` (TTS cost: $0.015/1k chars for OpenAI; `task_name: 'tts'`)
- [ ] "Listen" buttons on BriefHero and BriefToc both trigger the player (not a new tab/download)
- [ ] Provider is config-driven: `config/ai-routing.yaml` new key `tts.provider` (openai|deepgram|elevenlabs), `tts.voice`

---

## 4. Search Screen Port

**Estimated Scope:** M
**Prerequisites:** M2 Phase 7 endpoints (entities list, related, ask); M2 Phase 5 routes (`POST /api/v1/synthesize` if not already wired); M2 api-client `searchApi` and `synthesizeApi` namespaces (wired in Phase 2 but not fully exercised)
**M2 Context:** D106 (M2 scope = 5 Cloudscape screens only; search is /web-only in M2)

### Description

The `/web` search page (`packages/web/src/pages/Search.tsx`) provides two capabilities:
1. Hybrid search: text input → `GET /api/v1/search?q=...` → ranked capture results with entity facets
2. AI synthesis: if query is a question → `POST /api/v1/synthesize` → streaming answer card above results

Port both to `packages/web-next/app/(shell)/search/page.tsx` using the M2 api-client infrastructure and TanStack Query. This is the most complex screen port because it has streaming (synthesis answer) and hybrid UX (results + answer co-exist).

### Key Design Decisions for M3

- Search input: client component with URL `?q=` param via `useSearchParams` + `router.push` on submit (debounced 300ms)
- Results: TanStack Query `useQuery(['search', q], () => searchApi.search({q}))` — refetches on URL param change
- Synthesis answer card: streaming via EventSource to `POST /api/v1/synthesize` or SSE endpoint (check if synthesize endpoint supports streaming first; if not, non-streaming is acceptable for MVP)
- Entity facet panel: derive from result set client-side (group by entity_name) — do not add a new endpoint
- `include_related: false` default (API default, back-compat per CLAUDE.md)

### Files

- `packages/web-next/app/(shell)/search/page.tsx` (create — currently `[[...slug]]` catch-all renders placeholder)
- `packages/web-next/components/search/SearchInput.tsx` (create)
- `packages/web-next/components/search/SearchResults.tsx` (create)
- `packages/web-next/components/search/SynthesisAnswer.tsx` (create)
- `packages/web-next/lib/api-client.ts` (modify — flesh out `searchApi.search()` and `synthesizeApi.synthesize()` fully)

### Acceptance Criteria

- [ ] `/search` renders search input and empty state on load
- [ ] Typing a query updates URL `?q=` and fires API search
- [ ] Results list renders CaptureCard-equivalent components with score badges
- [ ] Questions trigger synthesis answer card (non-streaming acceptable for M3)
- [ ] Entity facets panel shows entities mentioned in results
- [ ] Search query persists on browser back/forward navigation
- [ ] `pnpm --filter @open-brain/web-next exec vitest run` passes including new search component tests

---

## 5. Timeline Screen Port

**Estimated Scope:** S
**Prerequisites:** M2 api-client `capturesApi.list()` (wired in Phase 2); M2 Phase 7 captures endpoint wiring validated
**M2 Context:** D106 (timeline deferred; simpler screen, unblocked earliest of the deferred ports)

### Description

The `/web` timeline page (`packages/web/src/pages/Timeline.tsx`) renders captures in reverse-chronological order grouped by date, with brain_view filter tabs and source icons. No synthesis, no entity resolution — pure read from `GET /api/v1/captures?limit=50&offset=N`.

### Key Design Decisions for M3

- RSC page with `searchParams.brain_view` and `searchParams.source` as filter inputs
- Infinite scroll: TanStack Query `useInfiniteQuery` with cursor-based offset pagination
- Date grouping: client-side in `format.ts` (already has `formatRelativeDate`) — no new API surface
- Brain view filter tabs: `<Link href={?brain_view=...}>` client components (URL-driven, not useState)
- Source icon map: `{ slack: SlackIcon, voice: MicIcon, api: ApiIcon, document: FileIcon, ... }` — 9 values per canonical `CaptureSource` in CLAUDE.md

### Files

- `packages/web-next/app/(shell)/timeline/page.tsx` (create)
- `packages/web-next/components/timeline/TimelineGroup.tsx` (create)
- `packages/web-next/components/timeline/TimelineEntry.tsx` (create — wraps capture row with source icon + date)

### Acceptance Criteria

- [ ] `/timeline` renders captures in reverse-chronological order
- [ ] Date grouping: "Today", "Yesterday", "Mon Apr 14", etc. using `format.ts`
- [ ] Brain view tabs filter results (URL param change triggers refetch)
- [ ] Source filter (optional tab) narrows to specific sources
- [ ] Infinite scroll loads next page on scroll-to-bottom
- [ ] All 9 `CaptureSource` values have distinct icons (no unknown-source fallback)

---

## 6. Settings Screen Port

**Estimated Scope:** M
**Prerequisites:** M2 api-client infrastructure; `GET/PATCH /api/v1/settings/:key` endpoints (existing in core-api); `app_settings` table with `VALID_SETTINGS_KEYS` whitelist
**M2 Context:** D106 (settings deferred; requires careful handling of autonomy level mutation and email allowlist JSON)

### Description

The `/web` settings page (`packages/web/src/pages/Settings.tsx`) manages three domains:
1. **Autonomy level** — radio group: observe / assist / advise / partner; reads/writes `app_settings.autonomy_level`
2. **Email allowlist** — CRUD list of allowed sender addresses; reads/writes `app_settings.email_allowlist` (JSONB array)
3. **Integrations status** — read-only display of connection health (Slack, OneDrive, Composio); no mutation

### Key Design Decisions for M3

- All settings mutations go through existing `PATCH /api/v1/settings/:key` — no new endpoints
- Autonomy radio group: optimistic update + revert on error; sonner confirmation toast
- Email allowlist: add/remove via controlled input; debounce PATCH to avoid per-keystroke API calls
- Integrations panel: calls `GET /api/v1/health` + checks `app_settings.slack_connected`, etc. — read-only status grid
- `settingsApi` namespace: add to `packages/web-next/lib/api-client.ts`

### Files

- `packages/web-next/app/(shell)/settings/page.tsx` (create)
- `packages/web-next/components/settings/AutonomyControl.tsx` (create — radio group)
- `packages/web-next/components/settings/EmailAllowlist.tsx` (create — CRUD list)
- `packages/web-next/components/settings/IntegrationsPanel.tsx` (create — read-only health grid)

### Future Consideration

The ESLint rule added in M2 (work item 1.6) blocks `@open-brain/shared` imports in web-next. If M3 introduces a `@open-brain/shared/types` pure-types subpath export (no runtime deps), the ESLint rule should be relaxed to allow that subpath. Document this in the D109 trade-off note in the relevant ESLint config file when the subpath is created.

### Acceptance Criteria

- [ ] `/settings` loads with current autonomy level selected
- [ ] Changing autonomy level persists via PATCH and survives page reload
- [ ] Email allowlist shows current addresses; add/remove works
- [ ] Invalid email format rejected client-side (regex) before PATCH
- [ ] Integrations panel shows health status for Slack, OneDrive, Composio
- [ ] All mutations have loading + error states with sonner toasts

---

## 7. Remaining /web Screens

The following 13 screens exist in `/web` and are deferred beyond the 5 Cloudscape-designed screens (Dashboard, Entities, Entity Detail, Briefs, Brief Reader) already wired in M2, and the 3 screens prioritized above (Search, Timeline, Settings).

Each entry: route, source page, estimated complexity, key dependencies, and any known complexity flags.

### 7.1 Wiki

**Route:** `/wiki`, `/wiki/*`
**Source:** `packages/web/src/pages/Wiki.tsx`
**Estimated Scope:** M
**Prerequisites:** Gitea wiki repo access from web-next (currently server-side via `WIKI_REPO_URL` env); `GET /api/v1/wiki/pages` and `GET /api/v1/wiki/pages/:slug` endpoints (verify these exist in core-api before porting)
**Key Complexity:** Nested routing (`/wiki/*`) requires Next.js dynamic catch-all `[...slug]`. The existing M2 `[[...slug]]` route in web-next app shell may conflict — audit before implementing. Markdown rendering: reuse the `unified` renderer built in M2 Phase 5 (already in `packages/core-api/src/lib/brief-renderer.ts`; consider moving to `@open-brain/shared` if web-next needs it client-side, or fetch pre-rendered HTML from the API).

### 7.2 Board

**Route:** `/board`
**Source:** `packages/web/src/pages/Board.tsx`
**Estimated Scope:** M
**Prerequisites:** Sessions API (`GET /api/v1/sessions`, `POST /api/v1/sessions`, `PATCH /api/v1/sessions/:id`); governance engine endpoints. Sessions types: `governance | review | planning` (canonical); Board.tsx local types `quick_check | quarterly` map to these — preserve mapping logic in web-next.
**Key Complexity:** Board.tsx has its own local `SessionType` and `SessionStatus` unions that differ from canonical shared types (documented in CLAUDE.md: "Board.tsx declares its own local types, not API types"). The mapping logic must be preserved in web-next without importing from `@open-brain/shared` (D109 rule). Wire `sessionsApi` namespace in api-client.

### 7.3 Voice Conversations

**Route:** `/voice`
**Source:** `packages/web/src/pages/VoiceConversations.tsx`
**Estimated Scope:** M
**Prerequisites:** Voice conversation interface design decision (documented in MEMORY.md as deferred 2026-04-16); `/api/v1/chat` Redis context endpoint; Web Speech API for STT
**Key Complexity:** Web Speech API is browser-only (no SSR) — must be fully `'use client'` with dynamic import or `typeof window !== 'undefined'` guard. The voice conversation interface was architecturally designed (MEMORY.md `voice-conversation-interface.md`) but implementation deferred. Review that design doc before implementing.

### 7.4 Email

**Route:** `/email`
**Source:** `packages/web/src/pages/Email.tsx`
**Estimated Scope:** M
**Prerequisites:** Email drafts API (`GET /api/v1/email/drafts`, `DELETE /api/v1/email/drafts/:id`); email allowlist managed via Settings (section 6 above, implement first)
**Key Complexity:** Email drafts delete was a separate PR (#88-94 era). Verify current API shape matches what `/web` Email page expects — particularly whether draft delete returns 204 or 200.

### 7.5 Ingest

**Route:** `/ingest`
**Source:** `packages/web/src/pages/Ingest.tsx`
**Estimated Scope:** S
**Prerequisites:** `GET /api/v1/captures?pipeline_status=pending&pipeline_status=processing` (multi-value param supported); ingest trigger endpoint if present
**Key Complexity:** Primarily a status dashboard (pipeline health, pending queue depth). Read-only for M3; ingest trigger button is optional.

### 7.6 Financial

**Route:** `/financial`
**Source:** `packages/web/src/pages/Financial.tsx`
**Estimated Scope:** M
**Prerequisites:** Financial pipeline captures exist (brain_view: personal, source: api); `GET /api/v1/captures?brain_view=personal&capture_type=observation` or dedicated financial endpoint
**Key Complexity:** Financial page likely displays aggregated captures from the financial pipeline (P19/P20 era PRs). No dedicated financial API endpoints — queries are filtered captures. Verify exact query pattern from the existing page before porting.

### 7.7 Investments

**Route:** `/investments`
**Source:** `packages/web/src/pages/Investments.tsx`
**Estimated Scope:** M
**Prerequisites:** Investment pipeline captures; same query pattern as Financial
**Key Complexity:** Same as Financial — read existing page to understand query pattern.

### 7.8 Intelligence

**Route:** `/intelligence`
**Source:** `packages/web/src/pages/Intelligence.tsx`
**Estimated Scope:** M
**Prerequisites:** `GET /api/v1/skills/log` or equivalent; autonomy level settings; auto-response stats
**Key Complexity:** Intelligence page shows proactive skill activity, autonomy controls, and auto-response stats. Overlaps conceptually with Settings (autonomy) — coordinate with section 6 to avoid duplicate API calls.

### 7.9 Help

**Route:** `/help`
**Source:** `packages/web/src/pages/Help.tsx`
**Estimated Scope:** S
**Prerequisites:** None (static content)
**Key Complexity:** Likely static markdown rendered in-page. If content is in `packages/web/src/content/` (per CLAUDE.md: "User-facing markdown must live in packages/web/src/content/"), move equivalent to `packages/web-next/src/content/` or inline as JSX. Simplest screen to port.

### 7.10 Slack Cleanup

**Route:** `/slack-cleanup`
**Source:** `packages/web/src/pages/SlackCleanup.tsx`
**Estimated Scope:** M
**Prerequisites:** Slack cleanup pipeline endpoints; Composio quota meter status (P03)
**Key Complexity:** Slack cleanup was a batch operation feature. Verify current status — was it fully shipped or partially deferred? Read current page implementation before estimating.

### 7.11 System

**Route:** `/system`
**Source:** `packages/web/src/pages/System.tsx`
**Estimated Scope:** S
**Prerequisites:** `GET /api/v1/health` (detailed); Docker container status if exposed via API; `GET /api/v1/stats` or equivalent
**Key Complexity:** System page is read-only ops dashboard. Health API returns `healthy|degraded|unhealthy` per CLAUDE.md — use those exact values (not `up|down`).

### 7.12 Voice Upload

**Route:** `/voice-upload`
**Source:** `packages/web/src/pages/Voice.tsx` (note: imported as `VoiceUpload` in App.tsx)
**Estimated Scope:** S
**Prerequisites:** `POST /api/v1/voice/upload` multipart endpoint (voice-capture service); field name is `file` (not `audio`); optional lat/lon/location_name/location_accuracy fields per CLAUDE.md
**Key Complexity:** File upload via multipart form — must use `FormData`, not JSON. Next.js App Router: ensure no SSR on the upload form. The voice-capture endpoint documentation in CLAUDE.md is canonical; do not assume field names from the existing page.

### 7.13 Admin Reset Flow

**Route:** No dedicated route in /web — triggered from System or Settings page
**Source:** Admin reset functionality in `packages/web/src/pages/System.tsx` or Settings
**Estimated Scope:** S
**Prerequisites:** `POST /admin/reset-data` two-step flow (step 1: no confirm → token; step 2: confirm phrase + token); Origin allowlist enforcement (brain.troy-davis.com only per CLAUDE.md)
**Key Complexity:** Two-step flow requires client-side state across two API calls. The endpoint has no `adminAuth()` — protection is origin allowlist + two-step token + confirmation phrase + rate limiter. Do NOT add auth to this endpoint without a corresponding web UI auth mechanism. Ensure the web-next deployment URL is in the origin allowlist before enabling this UI.

---

## 8. Production Cut-Over

**Estimated Scope:** M
**Prerequisites:** All 5 M2 Cloudscape screens verified in production; sections 4, 5, 6 (Search, Timeline, Settings) ported; Docker packaging tested
**M2 Context:** D115 (`outputFileTracingRoot` configured for standalone; Docker packaging is M3+); M2 work item 1.2 (next.config.ts already has `output: 'standalone'`)

### 8.1 Docker Packaging

`packages/web-next` needs a `Dockerfile` modeled on `packages/web/Dockerfile` but adapted for Next.js standalone output.

Key decisions:
- Base image: `node:22-alpine` (matches all other service images per CLAUDE.md)
- Build stage: `pnpm --filter @open-brain/web-next build` with `NODE_OPTIONS="--max-old-space-size=4096"`
- Runtime stage: copy `.next/standalone/`, `.next/static/`, `public/` — the three artifact directories for Next.js standalone
- `outputFileTracingRoot` (set in M2 Phase 1.2) ensures pnpm workspace deps are traced correctly
- Port: 3001 (already in use for dev; confirm no conflict with existing container map — core-api=3002, redis=6380, web=5173)
- Health check: `wget -qO- http://127.0.0.1:3001/api/v1/captures?limit=1` — use `127.0.0.1` not `localhost` (Alpine IPv6 resolution bug per CLAUDE.md)
- Add `web-next` service to `docker-compose.yml` with `LOKI_URL` log driver (required for all 13+ services per CLAUDE.md P11a rule)

### 8.2 Cloudflare Tunnel Swap

Current tunnel: `brain.troy-davis.com` → `/web` (port 5173).
Target: `brain.troy-davis.com` → `/web-next` (port 3001).

Steps:
1. Deploy web-next container; verify it serves all M2+M3 screens
2. Add parallel tunnel entry `brain-next.troy-davis.com` → 3001 for side-by-side comparison
3. Screenshot both at identical routes — verify parity
4. Update primary tunnel `brain.troy-davis.com` → 3001
5. Keep `brain-next.troy-davis.com` alive for 2 weeks as rollback target
6. After 2 weeks without rollback: remove parallel entry; decommission `/web`

### 8.3 /web Decommission Plan

Sequence after tunnel swap is stable:
1. Remove `/web` service from `docker-compose.yml` (keep `packages/web/` source as git history)
2. Remove port 5173 mapping from any firewall/Cloudflare rules
3. Keep `packages/web/` source tree indefinitely — git is the archive; do not delete
4. Update `packages/web/Dockerfile` with a `# DECOMMISSIONED` header comment (prevents accidental rebuild)

Do NOT delete `packages/web/src/` — the implementation patterns are the reference for porting remaining screens.

### Acceptance Criteria

- [ ] `packages/web-next/Dockerfile` builds successfully and produces a container that starts healthy
- [ ] web-next container added to `docker-compose.yml` with Loki log driver
- [ ] `brain-next.troy-davis.com` serves all implemented screens before tunnel swap
- [ ] Cloudflare tunnel updated; `brain.troy-davis.com` serves web-next
- [ ] Post-swap: all 5 M2 screens + M3 ported screens verified via real browser on production URL
- [ ] Rollback tested: reverting tunnel to port 5173 restores /web (keep /web running for 2 weeks)
- [ ] `/web` service removed from compose after 2-week stable period

---

## 9. Polish

**Estimated Scope:** S–M (can be decomposed into individual PRs)
**Prerequisites:** Core screen wiring complete (all 5 M2 screens + sections 4–6); most polish is additive
**M2 Context:** None explicitly; these were out-of-scope for M2's API wiring focus

### 9.1 PWA Service Worker

The existing `/web` app has a PWA service worker that aggressively caches Vite-hashed bundles (documented CLAUDE.md: "After every web deploy: hard-refresh AND cache delete"). Next.js has first-class PWA support via `next-pwa` (Serwist fork) or manual `next.config.ts` `serviceWorker` configuration.

Considerations:
- Cache strategy: stale-while-revalidate for static assets; network-first for `/api/` routes
- Install prompt: add `beforeinstallprompt` handler for home screen add on iOS/Android
- Offline page: simple "You're offline" fallback — do not cache API responses for offline use (stale brain data is worse than no data)
- Hard-refresh note: the CLAUDE.md cache-busting procedure (`caches.keys().then(...)`) applies to web-next too — document in deploy runbook

### 9.2 Dark Mode

Current web-next uses Tailwind CSS with the Cloudscape design system tokens. Dark mode via:
- Tailwind `darkMode: 'class'` (add to `tailwind.config.ts` if not present)
- System preference detection: `prefers-color-scheme` media query via `useEffect` on client
- User override: persist to `localStorage.theme`; toggle via a button in the nav header
- Cloudscape tokens: verify Cloudscape design system has dark variants; if not, map manually in `globals.css`

### 9.3 Keyboard Shortcuts

Priority shortcuts (add via `useEffect` keydown listener in `app/layout.tsx`):
- `g d` → navigate to Dashboard
- `g e` → navigate to Entities
- `g b` → navigate to Briefs
- `g s` → navigate to Search
- `/` → focus search input
- `?` → open keyboard shortcuts help modal (Radix Dialog, already a dependency)

Implementation: global `useKeyboardShortcuts()` hook in `packages/web-next/lib/hooks/use-keyboard-shortcuts.ts`. Chord detection: set a `firstKey` ref, clear on timeout (500ms).

### Acceptance Criteria

- [ ] PWA: app installable on iOS Safari and Android Chrome; offline page shows instead of blank
- [ ] Dark mode: toggle in nav; persists across sessions; respects system preference on first visit
- [ ] Keyboard shortcuts: all 6 shortcuts documented work; `?` opens help modal listing them

---

## Appendix: /web Route Inventory

Source: `packages/web/src/App.tsx` (read 2026-04-21). All routes nested under `<Layout />` with `Suspense` fallback. 20 distinct routes.

| Route Path | Component | Lazy? | M2 Status | M3 Section |
|------------|-----------|-------|-----------|------------|
| `/` | Navigate → /dashboard | — | Wired (redirect) | — |
| `/dashboard` | `Dashboard` | Yes | Wired in M2 Phase 7.4 | — |
| `/search` | `Search` | Yes | Deferred | Section 4 |
| `/timeline` | `Timeline` | Yes | Deferred | Section 5 |
| `/entities` | `Entities` | Yes | Wired in M2 Phase 7.5 | — |
| `/entities/:id` | `EntityDetail` | Yes | Wired in M2 Phase 8.1 | — |
| `/wiki` | `Wiki` | Yes | Deferred | Section 7.1 |
| `/wiki/*` | `Wiki` (catch-all) | Yes | Deferred | Section 7.1 |
| `/briefs` | `Briefs` | Yes | Wired in M2 Phase 8.2 | — |
| `/board` | `Board` | Yes | Deferred | Section 7.2 |
| `/voice` | `VoiceConversations` | Yes | Deferred | Section 7.3 |
| `/voice-upload` | `VoiceUpload` (Voice.tsx) | Yes | Deferred | Section 7.12 |
| `/email` | `Email` | Yes | Deferred | Section 7.4 |
| `/ingest` | `Ingest` | Yes | Deferred | Section 7.5 |
| `/financial` | `Financial` | Yes | Deferred | Section 7.6 |
| `/investments` | `Investments` | Yes | Deferred | Section 7.7 |
| `/intelligence` | `Intelligence` | Yes | Deferred | Section 7.8 |
| `/help` | `Help` | Yes | Deferred | Section 7.9 |
| `/slack-cleanup` | `SlackCleanup` | Yes | Deferred | Section 7.10 |
| `/settings` | `Settings` | Yes | Deferred | Section 6 |
| `/system` | `System` | Yes | Deferred | Section 7.11 |

**Note on briefs detail route:** The `/web` App.tsx does not show `/briefs/:id` explicitly — in the original `/web` app this may have been a modal or inline expand. M2 added `/briefs/:id` as a proper Next.js dynamic route in `packages/web-next/app/(shell)/briefs/[id]/page.tsx` (Phase 8.3) — this is a net-new route not in the /web inventory.

**Note on admin reset:** No dedicated route in `/web` App.tsx — admin reset is triggered from within the System page. M3 section 7.13 covers this as a sub-feature of the System port.

---

## Appendix: Decision Reference

M2 decisions that have M3 implications, summarized for context:

| Decision | M2 Summary | M3 Implication |
|----------|------------|----------------|
| D106 | M2 scope = 5 Cloudscape screens only (Option B) | All other /web screens are M3 work; sections 4–7 above |
| D107 | First-class `briefs` table (migration 0030); DOSSIER kind reserved | Section 2 (entity-brief skill) writes DOSSIER rows |
| D108 | TanStack Query v5 + RSC pattern | All new M3 screens use same Query pattern established in M2 |
| D109 | web-next redeclares types locally; ESLint blocks @open-brain/shared import | If @open-brain/shared/types subpath created, relax ESLint rule per section 6 note |
| D110 | Refine = Option 2 (single LLM generic transform, ~3s) | TTS in section 3 uses same cost tier; monitor both for quality |
| D111 | Commitments deferred to M3 | Section 1 above — no prerequisites, ship early in M3 |
| D112 | BaseSkill.logResult() → Promise<string>; all ~25 subclasses updated | New skills in M3 (entity-brief, extract-commitments) must use new signature |
| D113 | Radix Dialog + sonner for modals/toasts | All M3 screens reuse same modal pattern; no new modal library needed |
| D114 | Entity /ask: TS-side intersection of top-K captures | Section 2 (entity-brief) uses similar pattern but top-50 via FTS rank |
| D115 | outputFileTracingRoot set in next.config.ts | Section 8.1 (Docker packaging) depends on this being set correctly |

---

*M3 Backlog generated 2026-04-21. Last M2 commit closes with this document.*
*Update this file as M3 items are prioritized, estimated more precisely, or sequencing changes.*
