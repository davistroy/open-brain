# IMPLEMENT_PHASE-P18.md — Dashboard & Settings Polish

**Phase:** P18
**GH Issue:** #70
**Wave:** 3 (Polish + search)
**PHASED_PLAN dependencies:** None (independent of all other phases)
**Effort estimate:** ~2 days

---

## Scope Diff (card vs. current state)

The PHASED_PLAN § P18 card lists five "likely candidates" with `(depend on Troy's direction)` caveat.
GH issue #70 lists different items. After reading both against the actual codebase, the status per item:

| PHASED_PLAN candidate | GH #70 item | Actual status | Action |
|---|---|---|---|
| Settings: autonomy-level selector | — | **DONE** — `AutonomyCard` in Settings accordion "Autonomy" tab (P05/P14b). Full selector + upgrade confirmation dialog. | **SKIP** |
| Dashboard: surface current autonomy level | — | Not present on Dashboard. | **IN SCOPE** |
| Dashboard: last memory-consolidation timestamp | — | Not present anywhere. `GET /api/v1/skills` returns `last_run_at` per skill. | **IN SCOPE** |
| Captures list: filter by source (9-value dropdown) | — | **DONE** — `SearchFilters.tsx` already has all 9 `CaptureSource` values; Timeline has client-side `capture_type` filter. Source dropdown on Timeline is **missing**. | **PARTIAL** |
| Search UI: expose `include_related` toggle | — | `SearchFilters` panel has no `include_related` field. API param exists (`include_related` default `false`). `SearchFilters` type has no field. | **IN SCOPE** |
| System.tsx: 5 sub-tabs | `System.tsx: 5 sub-tabs (Queues, Skills, Flows, Infrastructure, MCP Activity)` | **DONE** — System page fully built: all 5 tabs (`QueuesTab`, `SkillsTab`, `FlowsTab`, `InfrastructureTab`, `McpActivityTab`). | **SKIP** |
| Settings.tsx: AI routing, voice, wiki, email, integrations | `Settings.tsx sections expanded` | **DONE** — 6-section accordion (General, AI Routing, Voice, Email, Integrations, Autonomy). | **SKIP** |
| VoiceConversations.tsx | `VoiceConversations.tsx: session list, playback` | `/voice-conversations` page exists (`VoiceConversations.tsx`). | **SKIP** (already built) |
| Related captures component | `Related captures component (spreading activation results per capture)` | `CaptureDetail.tsx` exists but does **not** show related captures. Spreading-activation results are returned when `include_related=true`. | **IN SCOPE** |
| Financial dashboard tab | `Financial dashboard tab (if 3B-3E built)` | `Financial.tsx` page exists and handles the financial view separately. | **SKIP** (condition not met) |

**Net scope drift summary:** ~60% of PHASED_PLAN candidates were already shipped before this phase plan was written. Three new items from GH #70 are also already done. Four items remain genuinely open and are all small, well-bounded, and cohesive.

---

## Work Items

### W1 — Dashboard: Autonomy level + last memory-consolidation timestamp widget

**What:** Add a small "System status" strip below `StatsCards` on the Dashboard showing:
1. Current autonomy level (badge with color: observe=gray, assist=blue, advise=yellow, partner=red)
2. Last memory-consolidation run timestamp (from `GET /api/v1/skills` → find `memory-consolidation` entry → `last_run_at`)

**Files touched:**
- `packages/web/src/pages/Dashboard.tsx` — add `systemStatus` state; fetch from `skillsApi.list()` + `settingsApi.get('autonomy_level')`; render `SystemStatusStrip`
- `packages/web/src/components/SystemStatusStrip.tsx` (NEW) — small inline component; two stat pills; no external deps beyond shadcn Badge

**API contracts:**
- `GET /api/v1/skills` → `{ skills: [{ name, last_run_at, ... }] }` — already exists; `skillsApi.list()` already in `api.ts`
- `GET /api/v1/settings/autonomy_level` → `{ value: AutonomyLevel }` — already exists; `settingsApi.get()` already in `api.ts`

**Implementation notes:**
- Both fetches are fire-and-forget — failure is non-fatal; strip simply doesn't render if either returns null
- Use `Promise.allSettled` alongside existing `loadStats` call (already uses `Promise.allSettled` for four calls)
- Strip shows: `Autonomy: observe` badge + `Memory consolidation: 3 days ago` or `Memory consolidation: never run`
- `relativeTime` helper already exists in `Ingest.tsx` — copy/extract into `lib/utils.ts` or duplicate inline

**Acceptance criteria:**
- [ ] Strip visible on Dashboard when both API calls succeed
- [ ] Autonomy badge color matches level semantics
- [ ] `last_run_at` renders as relative time (e.g., "3 days ago") or "never run"
- [ ] No JS errors when either API call fails (graceful hide)

---

### W2 — Search UI: `include_related` toggle

**What:** Add a checkbox toggle to `SearchFiltersPanel` that sets `include_related: true/false` on the search request body. Activating it returns spreading-activation neighbors alongside direct matches.

**Files touched:**
- `packages/web/src/lib/types.ts` — add `include_related?: boolean` to `SearchFilters` interface
- `packages/web/src/lib/api.ts` — `searchApi.search()` already POSTs the full `filters` object; adding the field to the type automatically includes it in the body
- `packages/web/src/components/SearchFilters.tsx` — add checkbox below the existing `hybrid` checkbox
- `packages/web/src/pages/Search.tsx` — update `DEFAULT_FILTERS` constant (keep `include_related` absent = defaults to `false` on backend)

**Implementation notes:**
- Label: "Include related captures (spreading activation)" — informative, not just "include_related"
- Should be unchecked by default (matches API default `false`)
- The backend already handles `include_related` as a POST body boolean; the API client's `buildQueryString` is not used here (POST body)
- No schema migration — purely frontend + existing API param

**Acceptance criteria:**
- [ ] Checkbox renders in filter panel below "Hybrid search" toggle
- [ ] Toggling it and re-searching returns different result counts (verifiable in network tab when spreading-activation neighbors exist)
- [ ] `tsc --noEmit` clean on `packages/web`
- [ ] `SearchFilters` interface correctly typed

---

### W3 — Timeline: source filter dropdown

**What:** Add a "Source" dropdown filter to the Timeline page (currently has `capture_type` and date filters, but no `source` filter). Uses the same 9-value `CaptureSource` array already in `SearchFilters.tsx`.

**Files touched:**
- `packages/web/src/pages/Timeline.tsx` — add `source` state variable; add `<select>` for source alongside existing type/date filters; apply to the `captures` list fetch

**Current Timeline fetch chain:**
- `capturesApi.list({ limit, offset, ...params })` where params includes `source` (check `api.ts`)

**Prerequisite check:** Verify `capturesApi.list()` passes `source` through to `GET /api/v1/captures?source=...`.

**Implementation notes:**
- Re-use the same `CAPTURE_SOURCES` constant from `SearchFilters.tsx` — extract to `lib/constants.ts` or duplicate inline
- The API endpoint `GET /api/v1/captures` — need to confirm `source` query param is supported (see `packages/core-api/src/routes/captures.ts`)
- Filter resets pagination offset to 0 (same pattern as existing filters)

**Acceptance criteria:**
- [ ] Source dropdown renders in Timeline filter bar
- [ ] Selecting a source correctly filters the capture list
- [ ] "All sources" (blank) is the default
- [ ] `tsc --noEmit` clean

---

### W4 — CaptureDetail: related captures section (spreading activation)

**What:** Add a "Related Captures" section to `CaptureDetail.tsx` that appears when spreading-activation neighbors exist. Triggered by fetching the specific capture via `GET /api/v1/captures/:id?include_related=true` or by passing `include_related=true` to search.

**Files touched:**
- `packages/web/src/components/CaptureDetail.tsx` — add `related` state; fetch `GET /api/v1/captures/:id?include_related=true` on mount; render related list below existing content
- `packages/web/src/lib/api.ts` — verify `capturesApi.get(id)` exists and supports `include_related`; add if missing
- `packages/web/src/lib/types.ts` — verify `Capture` type includes `related_captures` field if the API returns it

**API contracts to verify first:**
- Check `GET /api/v1/captures/:id` — does it accept `include_related=true`?
- Check `packages/core-api/src/routes/captures.ts` for the param
- If not present: use the search API with `capture_id` filter and `include_related=true` as the backing call (fire a search for the capture's content with `include_related=true`)

**Fallback approach** (if `GET /api/v1/captures/:id` doesn't support `include_related`):
- Use `POST /api/v1/search` with `{ query: capture.content.slice(0, 200), include_related: true, limit: 5 }` to approximate related captures
- Deduplicate: exclude the current capture from results

**Implementation notes:**
- Section only renders if `related.length > 0`
- Render as compact list of `CaptureCard` items (same component used everywhere else)
- Non-blocking — fire-and-forget; if fetch fails, section stays hidden
- Title: "Related via memory associations" (descriptive, not just "Related")
- Cap display at 5 items

**Acceptance criteria:**
- [ ] Related section appears in CaptureDetail when associations exist in the database
- [ ] Empty/fetch-fail case: section simply does not render (no error UI)
- [ ] Related captures link back to their own detail (click to select in parent)
- [ ] `tsc --noEmit` clean

---

## Execution Order

```
W1 (Dashboard strip) → independent, simplest
W2 (Search toggle)   → independent, smallest (type + checkbox)
W3 (Timeline source) → requires verifying captures API param first
W4 (CaptureDetail)   → requires verifying captures/:id include_related first
```

All four are fully independent. W3 and W4 require a quick API verification step before implementing — Gate 3 implementer must read `packages/core-api/src/routes/captures.ts` before writing W3/W4 code.

---

## Pre-implementation verifications (Gate 3 implementer must perform)

1. **`capturesApi.list()` source param** — `grep -n "source" packages/core-api/src/routes/captures.ts` — confirm `source` is a supported query param on the list endpoint.

2. **`GET /api/v1/captures/:id` include_related** — `grep -n "include_related" packages/core-api/src/routes/captures.ts` — if missing, use the fallback search approach for W4.

3. **Timeline `capturesApi.list()` call signature** — check `packages/web/src/lib/api.ts` `capturesApi.list` to confirm what params it passes.

4. **`relativeTime` helper location** — currently inline in `Ingest.tsx`; extract to `packages/web/src/lib/utils.ts` if re-using in W1. Do NOT duplicate across files.

---

## Deliverables checklist

| File | Change | Work item |
|------|--------|-----------|
| `packages/web/src/pages/Dashboard.tsx` | Add system status fetch + `SystemStatusStrip` render | W1 |
| `packages/web/src/components/SystemStatusStrip.tsx` | NEW: autonomy badge + last-consolidation pill | W1 |
| `packages/web/src/lib/utils.ts` | Extract `relativeTime()` from Ingest.tsx | W1 |
| `packages/web/src/lib/types.ts` | Add `include_related?: boolean` to `SearchFilters` | W2 |
| `packages/web/src/components/SearchFilters.tsx` | Add include_related checkbox | W2 |
| `packages/web/src/pages/Search.tsx` | Keep `DEFAULT_FILTERS` stable (no change needed) | W2 |
| `packages/web/src/pages/Timeline.tsx` | Add source filter dropdown | W3 |
| `packages/web/src/components/CaptureDetail.tsx` | Add related captures section | W4 |
| `packages/web/src/lib/api.ts` | Add `include_related` to capturesApi.get() if missing | W4 |

---

## LAB_NOTEBOOK requirement

Before first commit: Entry 115 with:
- Objective: Dashboard + search polish
- Hypothesis: 4 items fully independent, no schema migration, pure frontend — should be low-risk
- Rollback: `git revert` PR; no data consequences

---

## Rollback plan

Pure frontend changes — no schema migration, no API routes added, no Docker changes. Rollback = revert the PR. No homeserver deploy required post-merge (web is served via Vite build deployed to the `web` container; standard `docker compose up -d --build` or GHCR pull handles it).

---

## Acceptance criteria (phase-level)

- [ ] W1: Dashboard shows autonomy level badge and last memory-consolidation timestamp
- [ ] W2: Search filter panel has `include_related` toggle; toggling it changes search behavior
- [ ] W3: Timeline has source dropdown filter with all 9 values + "All sources" default
- [ ] W4: CaptureDetail shows "Related via memory associations" section when data exists
- [ ] Zero JavaScript runtime errors on Dashboard, Search, Timeline, and any page with CaptureDetail
- [ ] `pnpm --filter @open-brain/web build` succeeds (zero type errors, zero import errors)
- [ ] `pnpm --filter @open-brain/web exec vitest run` passes (existing tests + any new ones)
- [ ] GH issue #70 can be closed
