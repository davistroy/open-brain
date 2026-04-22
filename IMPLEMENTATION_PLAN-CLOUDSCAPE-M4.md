# Implementation Plan — Cloudscape M4: Polish & Completion

**Generated:** 2026-04-22 18:00:00
**Based On:** HANDOFF.md §6 Milestone 4, M3_BACKLOG.md (deferred items), Cloudscape screens 02b/10/12, Ultra-plan Phase 1-4 analysis (2026-04-22)
**Total Phases:** 4
**Estimated Total Effort:** ~1,850 LOC across ~29 files

---

## Executive Summary

Milestone 4 completes the Cloudscape design system implementation. M3 shipped 41 work items across 17+ routes, but three gaps remain: the Capture Detail page (Cloudscape screen 10 — the only unbuilt screen), the Search Grouped view (screen 02b — the only unbuilt screen variant), and the HANDOFF.md polish items (wash preference, empty states, stale stub cleanup).

M4 also wires up three UI actions that M3 built shells for but left as toast stubs: Brief Export, Brief Follow-up Questions, and Entity Merge. All backend APIs already exist — M4 is entirely frontend + one new API endpoint (entity merge).

**Key decisions from ultra-plan analysis:**
- **D122:** Capture Detail is a full page (matching screen 10), not a slide-over panel (as in old /web). Breadcrumb, waveform player, transcript with annotations, extraction sidebar.
- **D123:** Search grouped view is client-side grouping (no new API). Toggle persists to localStorage.
- **D124:** Wash preference uses localStorage (not API) — single-user, single-device. Same flash-prevention pattern as dark mode.
- **D125:** Brief export is client-side (markdown download + browser print). No server-side PDF dependency.
- **D126:** Brief follow-up uses existing `POST /api/v1/synthesize` with brief content as context.
- **D127:** Entity merge is transactional: update refs → soft-delete source. Reversible.

---

## Plan Overview

Four change sets ordered by dependency: CS1 creates the capture detail page (a link target for CS2's search grouped view and for CaptureCard everywhere), CS2 polishes the design system, CS3 completes brief actions, CS4 adds entity merge. CS2-CS4 are independent after CS1 ships.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies | Execution Mode |
|-------|------------|------------------|-----------------|--------------|----------------|
| 1 | Screen Completion | Capture detail page, search grouped view, CaptureCard linking | M (~12 files, ~900 LOC) | None | Sequential |
| 2 | Design Polish | Wash preference, empty states audit, stale toast cleanup | S (~10 files, ~400 LOC) | None | Parallel |
| 3 | Brief Actions | Brief export (markdown + print), follow-up questions | S (~5 files, ~300 LOC) | None | Parallel |
| 4 | Entity Merge | Merge API endpoint, wire existing modal | S (~4 files, ~250 LOC) | None | Parallel |

<!-- BEGIN PHASES -->

---

## Phase 1: Screen Completion

**Estimated Complexity:** M (~12 files, ~900 LOC)
**Dependencies:** None
**Parallelizable:** Yes — 1.1 and 1.2 can run concurrently; 1.3 depends on both

### Goals

- Build the Capture Detail page (Cloudscape screen 10) — the last unimplemented Cloudscape screen
- Add Search Grouped view toggle (Cloudscape screen 02b) — the last unimplemented screen variant
- Wire CaptureCard across all surfaces to link to capture detail

### Work Items

#### 1.1 Capture Detail Page — Route, Layout, and Content Components

**Status: COMPLETE 2026-04-22**
**Requirement Refs:** HANDOFF.md §2 Screen 10, M3_BACKLOG.md §7 (implied)
**Files Affected:**
- `packages/web-next/app/(shell)/captures/[id]/page.tsx` (create)
- `packages/web-next/app/(shell)/captures/[id]/loading.tsx` (create)
- `packages/web-next/app/(shell)/captures/[id]/error.tsx` (create)
- `packages/web-next/components/capture/CaptureHeader.tsx` (create)
- `packages/web-next/components/capture/AiSummary.tsx` (create)
- `packages/web-next/components/capture/TranscriptView.tsx` (create)
- `packages/web-next/components/capture/ExtractionsSidebar.tsx` (create)

**Description:**
Build the capture detail page matching Cloudscape screen 10. RSC page fetches capture via existing `capturesApi.get(id)`. Layout: 2-column grid — left `minmax(0, 1fr)` for content, right `340px` sidebar for extractions.

**CaptureHeader:** Mono eyebrow (`VOICE MEMO · TUE, APR 21 · 07:12`), display-font title (34px, weight 300), secondary metadata line (location, device, upload time). Pills: duration, transcription status, entity count.

**AiSummary:** Book-cloth-50 background, 3px left book-cloth border, sparkle icon + `SUMMARY` eyebrow, display-font summary text (17px, weight 300). Content: `capture.content` first paragraph or `source_metadata.summary` if available.

**TranscriptView:** Timestamped transcript paragraphs. Each paragraph: mono timestamp (11px, left-aligned, 48px min-width) + body text (14px, weight 300, 1.75 line-height). Entity mentions highlighted with book-cloth-50 background + dotted bottom border. Decision mentions highlighted with warm amber (#FBF6EC). Show "Edit" ghost button in card header (noop for M4 — edit workflow is M5).

**ExtractionsSidebar:** Three `<Card>` sections — Entities (accent pills, wrapped), Decisions (2px book-cloth left-border items), Commitments (status label + due date badge). Data from existing entity_links + commitments endpoints.

**Tasks:**
1. [ ] Create RSC page at `captures/[id]/page.tsx` — fetch capture by ID, handle 404 → notFound()
2. [ ] Build CaptureHeader with source-type eyebrow, title, meta pills
3. [ ] Build AiSummary card with book-cloth styling
4. [ ] Build TranscriptView with timestamp + entity/decision annotation highlights
5. [ ] Build ExtractionsSidebar with entities, decisions, commitments sections
6. [ ] Create loading.tsx skeleton and error.tsx boundary

**Acceptance Criteria:**
- [ ] `/captures/{id}` renders full capture detail for a real capture on homeserver
- [ ] Voice captures show duration pill and transcription status
- [ ] Entity mentions in transcript are highlighted with book-cloth-50 background
- [ ] ExtractionsSidebar shows linked entities, decisions, and commitments from API
- [ ] 404 capture ID returns Next.js not-found page
- [ ] Loading skeleton matches Cloudscape design density

**Notes:**
Backend is fully ready: `GET /api/v1/captures/:id` returns content, source_metadata, pipeline_status. Entity links via `GET /api/v1/entities` filtered by capture. Commitments via existing `commitmentsApi`. The old `/web` `CaptureDetail.tsx` is reference for field mapping but NOT for layout — use screen 10 design.

---

#### 1.2 Capture Detail — Voice Player Component

**Status: COMPLETE 2026-04-22**
**Requirement Refs:** HANDOFF.md §2 Screen 10 (audio player section)
**Files Affected:**
- `packages/web-next/components/capture/VoicePlayer.tsx` (create)
- `packages/web-next/lib/types.ts` (modify — add `CaptureSourceMetadata` type)

**Description:**
Build the dark-background audio player with waveform visualization shown in screen 10. Slate-dark background, book-cloth play button (40x40), waveform SVG bars, mono timestamp counter.

**Waveform:** Generate from capture duration metadata (seeded pseudo-random like screen 10's reference implementation). Bars: 2px wide, variable height, played = book-cloth, unplayed = cloud-dark. Progress tracks `<audio>` element currentTime.

**Conditionally rendered:** Only for captures where `source === 'voice'` or `source === 'slack'` with `source_metadata.audio_url`. Hidden for text-only captures (email, api, document, etc.).

**Tasks:**
1. [ ] Create VoicePlayer component with `<audio>` element + waveform SVG
2. [ ] Implement seeded pseudo-random waveform bar generation from duration
3. [ ] Wire play/pause button and progress tracking via `useRef<HTMLAudioElement>`
4. [ ] Add mono timestamp counter (`MM:SS / MM:SS` format, tabular-nums)
5. [ ] Conditionally render: voice/audio captures only, hidden otherwise

**Acceptance Criteria:**
- [ ] Voice captures display dark-bg player with waveform between header and transcript
- [ ] Play/pause toggles audio playback
- [ ] Waveform progress updates in real-time during playback
- [ ] Non-voice captures do not render the player component
- [ ] Timestamp counter shows current position / total duration

**Notes:**
Audio URL may come from `source_metadata.audio_url` or may need to be fetched from voice-capture service. Check what the capture API returns for voice captures before hardcoding a path. The briefs `AudioPlayer` context (used for TTS) is a different component — VoicePlayer is self-contained within the capture page, not a floating global player.

---

#### 1.3 Search Grouped View + CaptureCard Linking

**Status: COMPLETE 2026-04-22**
**Requirement Refs:** HANDOFF.md §2 Screen 02b, HANDOFF.md §6 M4 "Search refinement (both variants)"
**Files Affected:**
- `packages/web-next/components/search/SearchResults.tsx` (modify)
- `packages/web-next/components/search/GroupedResults.tsx` (create)
- `packages/web-next/components/dashboard/RecentCaptures.tsx` (modify — add link)
- `packages/web-next/components/timeline/TimelineEntry.tsx` (modify — add link)

**Description:**
Add flat/grouped toggle to SearchResults. Grouped view organizes results under typed headers (Entities, Captures, Briefs, Wiki) with match counts and "View all" links, matching screen 02b.

**View toggle:** Two icon buttons (List / LayoutGrid from lucide) in the results header area. Active state: book-cloth underline. Persist to `localStorage('search-view')`.

**GroupedResults:** Client-side grouping of existing search results by `kind` field. Each group: display-font section header (18px, weight 400), mono match count, "View all" link. Max 4 items per group. Items reuse existing result row components.

**CaptureCard linking:** Update CaptureCard (used in Dashboard recent, Timeline, Search) to wrap in `<Link href="/captures/{id}">`. Currently capture cards are non-navigable — this connects them to the new detail page.

**Tasks:**
1. [ ] Add `viewMode` state to SearchResults with flat/grouped toggle buttons
2. [ ] Create GroupedResults component with typed section headers and counts
3. [ ] Implement client-side grouping logic (entities, captures, briefs, wiki)
4. [ ] Add `<Link>` wrapping to CaptureCard in RecentCaptures, TimelineEntry
5. [ ] Persist view preference to localStorage

**Acceptance Criteria:**
- [ ] Search results toggle between flat and grouped views
- [ ] Grouped view shows typed section headers with match counts
- [ ] Each group shows max 4 items with "View all" link
- [ ] View preference persists across page navigations
- [ ] CaptureCards in Dashboard, Timeline, and Search link to `/captures/{id}`

---

### Phase 1 Testing Requirements

- [ ] `/captures/{id}` renders for voice, email, document, and API captures (all source types)
- [ ] Search flat/grouped toggle works with real search queries on homeserver
- [ ] CaptureCard links navigate to correct capture detail page
- [ ] No regressions on existing search, timeline, or dashboard behavior
- [ ] Screenshot validation: capture detail + search grouped on homeserver

### Phase 1 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing (`pnpm --filter @open-brain/web-next exec vitest run`)
- [ ] Screenshot: capture detail page for a voice capture
- [ ] Screenshot: search results in grouped view
- [ ] No regressions introduced
- [ ] Deploy to homeserver and verify

---

## Phase 2: Design Polish

**Estimated Complexity:** S (~10 files, ~400 LOC)
**Dependencies:** None (can run parallel to Phase 1)
**Parallelizable:** Yes — all items are independent

### Goals

- Add wash/theme preference to Settings (HANDOFF M4 scope)
- Audit and fix empty states across all surfaces (HANDOFF M4 scope)
- Clean up all stale "Coming in M3" toasts and placeholders

### Work Items

#### 2.1 Wash Preference in Settings

**Status: COMPLETE 2026-04-22**
**Requirement Refs:** HANDOFF.md §6 M4 "Wash preference in user settings", HANDOFF.md §3 (wash definitions)
**Files Affected:**
- `packages/web-next/components/settings/AppearanceSection.tsx` (create)
- `packages/web-next/components/settings/SettingsSidebar.tsx` (modify — add Appearance item)
- `packages/web-next/app/(shell)/settings/page.tsx` (modify — add 'appearance' section key + dynamic import)
- `packages/web-next/app/layout.tsx` (modify — dynamic `data-wash` from localStorage)
- `packages/web-next/app/globals.css` (modify — add wash-specific CSS custom property overrides if missing)

**Description:**
Add an Appearance section to Settings with a wash selector. The design system defines 4 washes: parchment (default), kraft, moss, peach. Each wash changes the canvas background tint and soft-fill colors.

**AppearanceSection:** Grid of 4 wash swatches (48x48 squares with representative colors). Active wash has 2px book-cloth border. Click sets `localStorage('wash')` and updates `document.documentElement.dataset.wash`. Include a "System theme" note reminding the user that dark mode is in the nav bar toggle.

**Flash prevention:** Extend the existing inline `<script>` in `layout.tsx` (which handles dark mode) to also read `localStorage('wash')` and set `data-wash` before first paint. Currently hardcoded to `data-wash="parchment"`.

**CSS:** Verify that `globals.css` has `[data-wash="kraft"]`, `[data-wash="moss"]`, `[data-wash="peach"]` override blocks. The parchment wash is the default (no `data-wash` or `data-wash="parchment"`). If blocks are missing, add them — the design system `colors_and_type.css` defines the palette but web-next may not have ported all wash variants.

**Tasks:**
1. [ ] Create AppearanceSection with wash swatch grid (4 options)
2. [ ] Wire localStorage read/write + live `data-wash` attribute update
3. [ ] Add Appearance to SettingsSidebar between Profile and Sources
4. [ ] Add 'appearance' to SettingsSection union + route resolver
5. [ ] Extend layout.tsx inline script for wash flash prevention
6. [ ] Verify/add wash CSS override blocks in globals.css

**Acceptance Criteria:**
- [ ] Settings → Appearance shows 4 wash swatches with active indicator
- [ ] Clicking a wash immediately changes the canvas background tint
- [ ] Wash preference persists across page reload (no flash)
- [ ] All 4 washes render correctly in both light and dark mode
- [ ] Default (no localStorage value) renders as parchment

---

#### 2.2 Empty States Audit

**Status: COMPLETE 2026-04-22**
**Requirement Refs:** HANDOFF.md §6 M4 "Empty states across all surfaces", Cloudscape screen 12
**Files Affected:**
- `packages/web-next/app/(shell)/dashboard/page.tsx` (modify — zero-captures conditional)
- `packages/web-next/components/search/SearchResults.tsx` (modify — no-results with suggestions)
- `packages/web-next/app/(shell)/timeline/page.tsx` (modify — quiet-day messaging)
- `packages/web-next/components/board/BoardColumn.tsx` (verify)

**Description:**
Screen 12 defines 6 empty state patterns. Audit each surface and ensure the EmptyState component matches the Cloudscape voice and design:

1. **Dashboard (zero captures):** "Your brain is empty." + "Connect a source or capture a thought" + CTA buttons. Currently dashboard always has data — add `stats.total_captures === 0` conditional.
2. **Search (no results):** "quarterly mushroom strategy" pattern — show query in italic display-font, then "Nothing matched — but these are close in meaning:" with suggestion links. Requires a secondary relaxed search API call.
3. **Timeline (quiet day):** "A quiet Tuesday." + last capture reference. Verify messaging matches design.
4. **Error/disconnected:** Verify error.tsx boundaries match screen 12's "We lost the thread" pattern.
5. **Board (no matters):** "THE BOARD · 0 OPEN MATTERS" + "Commitments surface here..." Verify BoardColumn empty state.
6. **Capture detail (not found):** New — 404 for deleted or non-existent captures.

**Tasks:**
1. [ ] Add zero-captures empty state to dashboard (conditional on stats.total_captures === 0)
2. [ ] Enhance search no-results to show "close in meaning" suggestions (relaxed search)
3. [ ] Verify timeline quiet-day messaging matches screen 12 voice
4. [ ] Verify board empty column messaging matches "0 OPEN MATTERS" pattern
5. [ ] Verify error boundaries have editorial voice ("We lost the thread" pattern)

**Acceptance Criteria:**
- [ ] Dashboard with 0 captures shows "Your brain is empty" + CTA buttons
- [ ] Search with no results shows italicized query + suggestion links
- [ ] All error boundaries use editorial, non-chirpy messaging
- [ ] Board empty columns show Cloudscape-matching empty state text

---

#### 2.3 Stale Toast & Stub Cleanup

**Status: COMPLETE 2026-04-22**
**Requirement Refs:** Ultra-plan Phase 1 findings (stale references)
**Files Affected:**
- `packages/web-next/components/entities/NeedsAttention.tsx` (modify)
- `packages/web-next/components/entity/merge-entity-modal.tsx` (modify — toast removed in Phase 4)
- `packages/web-next/components/briefs/BriefToc.tsx` (modify — toast removed in Phase 3)
- `packages/web-next/components/board/GroupByBar.tsx` (modify)
- `packages/web-next/app/(shell)/settings/page.tsx` (modify — empty section messaging)
- `packages/web-next/app/(shell)/[[...slug]]/page.tsx` (modify — update MILESTONE_MAP)

**Description:**
Several components reference "Coming in M3" or show stale milestone labels. Update all to be either: (a) implemented (covered by other phases), or (b) updated to milestone-agnostic text.

| Component | Current | Action |
|-----------|---------|--------|
| `NeedsAttention.tsx` | "Coming in M3" | Change to "Extraction review coming soon" |
| `merge-entity-modal.tsx` | toast "Merge API coming in M3" | Phase 4 replaces with real merge — no action here |
| `BriefToc.tsx` follow-up | toast "Follow-up questions coming in M3" | Phase 3 replaces with real follow-up — no action here |
| `GroupByBar.tsx` | UI-only stubs for group options | Add toast "Group-by filtering coming soon" on non-default selection |
| Settings empty sections | `EmptySettingsSection` with no messaging | Add section-specific descriptions ("Profile settings coming soon", etc.) |
| `[[...slug]]/page.tsx` | MILESTONE_MAP references M2/M3 | Remove entries for implemented routes; default to "a future update" |

**Tasks:**
1. [ ] Update NeedsAttention.tsx text to "Extraction review coming soon"
2. [ ] Update GroupByBar.tsx stubs with "coming soon" toasts on selection
3. [ ] Add descriptive text to each EmptySettingsSection (Profile, Brief preferences, Privacy, Workspaces, Billing, API & export)
4. [ ] Clean MILESTONE_MAP in catch-all — remove entries for routes that now have dedicated pages
5. [ ] Verify no other "M3" string references remain in web-next components

**Acceptance Criteria:**
- [ ] Zero instances of "Coming in M3" visible in the running app
- [ ] All empty settings sections have descriptive placeholder text
- [ ] `[[...slug]]` catch-all only fires for truly unimplemented routes
- [ ] `grep -r "Coming in M3" packages/web-next/` returns zero matches (excluding comments)

---

### Phase 2 Testing Requirements

- [ ] Wash preference persists and renders correctly for all 4 options
- [ ] Empty states match Cloudscape screen 12 patterns (visual comparison)
- [ ] No stale "M3" references visible in any page
- [ ] All existing tests pass (`pnpm --filter @open-brain/web-next exec vitest run`)

### Phase 2 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Screenshot: Settings → Appearance with wash selector
- [ ] Screenshot: Search no-results with suggestions
- [ ] Screenshot: Dashboard empty state (if testable)
- [ ] Deploy to homeserver and verify

---

## Phase 3: Brief Actions

**Estimated Complexity:** S (~5 files, ~300 LOC)
**Dependencies:** None (can run parallel to Phase 1)
**Parallelizable:** Yes — 3.1 and 3.2 can run concurrently

### Goals

- Wire the Brief Export button (currently noop) to download brief content
- Wire the Brief Follow-up button (currently toast) to synthesis with context

### Work Items

#### 3.1 Brief Export (Markdown + Print)

**Status: COMPLETE 2026-04-22**
**Requirement Refs:** HANDOFF.md §7 Q4 (brief export), BriefToc.tsx comment "Export is UI-only"
**Files Affected:**
- `packages/web-next/components/briefs/BriefToc.tsx` (modify — wire Export button)
- `packages/web-next/components/briefs/BriefExportMenu.tsx` (create)
- `packages/web-next/lib/export.ts` (create)

**Description:**
Replace the noop Export button with a Radix DropdownMenu offering two options:

1. **Download as Markdown:** Strip `body_html` to plain text / markdown, create a Blob, trigger download via `<a download>`. Filename: `{brief-title-slug}-{date}.md`.
2. **Print to PDF:** Open `window.print()` which targets a `@media print` stylesheet that hides the shell/sidebar and renders only the brief content cleanly.

Client-side only — no new API endpoint needed. Brief content (`body_html`) is already available in the page data.

**Tasks:**
1. [ ] Create `lib/export.ts` with `downloadMarkdown(html, title)` and `triggerPrint()` helpers
2. [ ] Create BriefExportMenu with Radix DropdownMenu (2 items)
3. [ ] Wire BriefToc Export button to open BriefExportMenu
4. [ ] Add `@media print` styles to globals.css (hide shell, sidebar, nav; full-width brief body)

**Acceptance Criteria:**
- [ ] "Download as Markdown" produces a `.md` file download with brief content
- [ ] "Print to PDF" opens browser print dialog with clean brief-only layout
- [ ] Print output hides navigation, sidebar, and shell chrome
- [ ] Export works for briefs with and without `body_html` (graceful fallback for empty)

---

#### 3.2 Brief Follow-up Questions

**Status: COMPLETE 2026-04-22**
**Requirement Refs:** BriefToc.tsx stub toast ("Follow-up questions coming in M3")
**Files Affected:**
- `packages/web-next/components/briefs/BriefToc.tsx` (modify — replace toast)
- `packages/web-next/components/briefs/BriefFollowUp.tsx` (create)

**Description:**
Replace the follow-up toast with an inline question input below the TOC actions. Click "Ask follow-up" → reveals input field. Submit → calls existing `synthesizeApi.synthesize()` with the question + brief title as context. Answer renders in a card below the input.

**UX:** Inline expansion (not a modal). Input: single-line text input with submit button. Answer: book-cloth-50 background card with streaming or static synthesis response. Loading: shimmer animation. Error: sonner toast.

**Tasks:**
1. [ ] Create BriefFollowUp component with input + answer card
2. [ ] Wire `synthesizeApi.synthesize({ query: question })` — the synthesis endpoint already handles context from the query
3. [ ] Replace BriefToc toast with follow-up section toggle
4. [ ] Add loading shimmer and error handling

**Acceptance Criteria:**
- [ ] "Ask follow-up" reveals text input below TOC actions
- [ ] Submitting a question returns a synthesis answer in a styled card
- [ ] Loading state shows shimmer animation
- [ ] Error state shows sonner toast without breaking the UI
- [ ] Multiple follow-ups accumulate (new answer appends below previous)

---

### Phase 3 Testing Requirements

- [ ] Export produces valid markdown for a real brief
- [ ] Print layout hides chrome and renders brief content cleanly
- [ ] Follow-up synthesis returns meaningful answers for real briefs
- [ ] No regressions on existing brief reader behavior

### Phase 3 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Export tested with a real brief on homeserver
- [ ] Follow-up tested with a real brief on homeserver
- [ ] Deploy to homeserver and verify

---

## Phase 4: Entity Merge

**Estimated Complexity:** S (~4 files, ~250 LOC)
**Dependencies:** None (can run parallel to Phase 1)
**Parallelizable:** No — backend must precede frontend wiring

### Goals

- Build the entity merge API endpoint (transactional)
- Wire the existing merge modal UI to the real API

### Work Items

#### 4.1 Entity Merge API Endpoint

**Status: COMPLETE 2026-04-22**
**Requirement Refs:** M3_BACKLOG.md §7.2 (entity operations implied), merge-entity-modal.tsx stub
**Files Affected:**
- `packages/core-api/src/routes/entities.ts` (modify — add merge endpoint)
- `packages/core-api/src/__tests__/entities-routes.test.ts` (modify — add merge tests)

**Description:**
Add `POST /api/v1/entities/:id/merge` endpoint. Body: `{ target_id: string }`. The source entity (`:id`) is merged INTO the target entity.

**Transaction steps:**
1. Validate both entities exist and are different
2. Update `entity_links` — change all rows where `entity_id = source_id` to `entity_id = target_id`. Handle duplicates (same capture + target entity already linked) by skipping.
3. Update `commitments` — change `entity_id = source_id` to `entity_id = target_id`
4. Merge aliases: append source entity name to target entity's `aliases` array (if not already present)
5. Soft-delete source entity: set `deleted_at = NOW()`
6. Return updated target entity

**Rate limit:** Default tier. Caller: `web-ui` (already bypassed).

**Tasks:**
1. [ ] Add `POST /api/v1/entities/:id/merge` route with zod validation (`{ target_id: string }`)
2. [ ] Implement transactional merge logic (entity_links, commitments, aliases, soft-delete)
3. [ ] Handle edge cases: same entity, already-deleted entity, missing entity → 404/400
4. [ ] Add unit tests: successful merge, duplicate link handling, validation errors

**Acceptance Criteria:**
- [ ] `POST /entities/:id/merge` with valid target returns 200 with merged entity
- [ ] All entity_links from source are transferred to target
- [ ] Commitments linked to source are re-linked to target
- [ ] Source entity name added to target aliases
- [ ] Source entity soft-deleted (deleted_at set)
- [ ] Merging entity with itself returns 400
- [ ] Merging non-existent entity returns 404

---

#### 4.2 Wire Merge Modal to API

**Status: COMPLETE 2026-04-22**
**Requirement Refs:** `merge-entity-modal.tsx` stub toast
**Files Affected:**
- `packages/web-next/components/entity/merge-entity-modal.tsx` (modify)
- `packages/web-next/lib/api-client.ts` (modify — add `entitiesApi.merge()`)

**Description:**
The merge modal UI already exists with entity search, target selection, and confirmation flow. Replace the `toast.info('Merge API coming in M3')` on line 73 with a real `useMutation` call.

**Wire:** `entitiesApi.merge(sourceId, targetId)` → `POST /api/v1/entities/${sourceId}/merge` with body `{ target_id: targetId }`. On success: sonner "Entities merged", navigate to target entity detail (`/entities/${targetId}`), invalidate entity queries. On error: sonner error, keep modal open.

**Tasks:**
1. [ ] Add `entitiesApi.merge(sourceId: string, targetId: string)` to api-client.ts
2. [ ] Replace toast in merge-entity-modal with `useMutation(entitiesApi.merge)`
3. [ ] Add success handler: navigate to target entity + invalidate queries
4. [ ] Add error handler: sonner error toast + keep modal open

**Acceptance Criteria:**
- [ ] Merge modal submits to real API and merges entities
- [ ] Success navigates to target entity detail page
- [ ] Target entity shows merged aliases and combined entity_links
- [ ] Error shows toast without closing modal
- [ ] Entity list refreshes after merge (query invalidation)

---

### Phase 4 Testing Requirements

- [ ] Merge API tested with real entities on homeserver
- [ ] Modal flow tested end-to-end: search target → confirm → verify merge
- [ ] Soft-deleted source entity no longer appears in entity list
- [ ] `pnpm --filter @open-brain/core-api exec vitest run` passes with new tests

### Phase 4 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing (core-api + web-next)
- [ ] Merge tested with real duplicate entities on homeserver
- [ ] Deploy to homeserver and verify
- [ ] No regressions on entity detail or entity list pages

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Phase 1 (1.1) | Phase 1 (1.2) | CaptureHeader/Transcript and VoicePlayer are independent components |
| Phase 2 (all) | Phase 1 (all) | No shared files; cosmetic changes only |
| Phase 3 (all) | Phase 1 (all) | BriefToc changes are independent of capture/search work |
| Phase 4 (all) | Phase 1 (all) | Entity merge is independent of all other phases |
| Phase 2 | Phase 3 | No shared files |
| Phase 2 | Phase 4 | No shared files |
| Phase 3 | Phase 4 | No shared files |
| Phase 3 (3.1) | Phase 3 (3.2) | Both touch BriefToc.tsx — coordinate edits but changes are in different sections |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Voice audio URL not available in capture API response | Med | Med | Check `source_metadata` for audio_url field; fall back to hiding VoicePlayer if absent |
| Wash CSS overrides incomplete in globals.css | Low | Low | Design system `colors_and_type.css` is the reference; port missing wash blocks |
| Entity merge leaves orphaned references | Low | High | Transaction wraps all steps; test with real data; merge is reversible (restore soft-deleted entity) |
| Search grouped view breaks existing search UX | Low | Med | Flat view is default; grouped is opt-in toggle. Existing tests still validate flat mode. |
| Brief follow-up synthesis quality poor without explicit context | Med | Low | Synthesis API infers context from query content; brief title provides enough signal for semantic search |

---

## Success Metrics

- [ ] All 4 phases completed
- [ ] All 8 work items pass acceptance criteria
- [ ] All 13 Cloudscape design screens fully implemented (capture detail was the last)
- [ ] Both search variants (flat 02a + grouped 02b) working
- [ ] All 4 wash themes render correctly in light and dark mode
- [ ] Zero "Coming in M3" references visible in the app
- [ ] Brief Export and Follow-up buttons functional (no more stub toasts)
- [ ] Entity merge tested with real duplicate entities
- [ ] Screenshot validation of all modified pages on homeserver deployment
- [ ] `pnpm -r build` and full test suite pass

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| Capture detail page (screen 10) | HANDOFF.md §2 | 1 | 1.1, 1.2 |
| Search refinement — both variants | HANDOFF.md §6 M4 | 1 | 1.3 |
| CaptureCard navigation links | Ultra-plan Phase 3 | 1 | 1.3 |
| Wash preference in settings | HANDOFF.md §6 M4 | 2 | 2.1 |
| Empty states across all surfaces | HANDOFF.md §6 M4, Screen 12 | 2 | 2.2 |
| Stale "Coming in M3" cleanup | Ultra-plan Phase 1 | 2 | 2.3 |
| Brief export | HANDOFF.md §7 Q4, BriefToc stub | 3 | 3.1 |
| Brief follow-up questions | BriefToc stub | 3 | 3.2 |
| Entity merge API | merge-entity-modal stub | 4 | 4.1 |
| Entity merge modal wiring | merge-entity-modal stub | 4 | 4.2 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-04-22 18:00:00*
*Source: /ultra-plan → /create-plan pipeline*
