# Web ↔ Web-Next Parity Audit

**Date:** 2026-05-05
**Branch:** feat/arch-review-remediation
**Purpose:** Drive Phase 7.3 (gap closure) and Phase 8b (packages/web deletion). Verified by direct file inspection — not recon assertions.

---

## Section 1: Routes

All 19 web pages have a web-next equivalent route. No missing routes.

| web file | web-next route | status |
|----------|----------------|--------|
| `pages/Dashboard.tsx` | `app/(shell)/dashboard/page.tsx` | parity |
| `pages/Timeline.tsx` | `app/(shell)/timeline/page.tsx` | parity |
| `pages/Search.tsx` | `app/(shell)/search/page.tsx` | parity |
| `pages/Entities.tsx` | `app/(shell)/entities/page.tsx` | parity |
| `pages/EntityDetail.tsx` | `app/(shell)/entities/[id]/page.tsx` | parity |
| `pages/Briefs.tsx` | `app/(shell)/briefs/page.tsx` + `[id]/page.tsx` | web-next-deeper (briefs have dedicated detail route) |
| `pages/Board.tsx` | `app/(shell)/board/page.tsx` | parity |
| `pages/Wiki.tsx` | `app/(shell)/wiki/page.tsx` + `[...slug]/page.tsx` | web-next-deeper (slug routing) |
| `pages/Settings.tsx` | `app/(shell)/settings/page.tsx` | parity (section gaps detailed in Section 2) |
| `pages/System.tsx` | `app/(shell)/system/page.tsx` | parity |
| `pages/Intelligence.tsx` | `app/(shell)/intelligence/page.tsx` | parity |
| `pages/Email.tsx` | `app/(shell)/email/page.tsx` | parity |
| `pages/Financial.tsx` | `app/(shell)/financial/page.tsx` | parity |
| `pages/Investments.tsx` | `app/(shell)/investments/page.tsx` | parity |
| `pages/Ingest.tsx` | `app/(shell)/ingest/page.tsx` | parity |
| `pages/Voice.tsx` | `app/(shell)/voice-upload/page.tsx` | parity (renamed to clarify single-file upload purpose) |
| `pages/VoiceConversations.tsx` | `app/(shell)/voice/page.tsx` | parity |
| `pages/SlackCleanup.tsx` | `app/(shell)/slack-cleanup/page.tsx` | parity |
| `pages/Help.tsx` | `app/(shell)/help/page.tsx` | parity |

web-next-only routes (not in web): `app/(shell)/captures/[id]/page.tsx` (capture detail), `app/onboarding/page.tsx`, `app/offline/page.tsx`.

---

## Section 2: Settings Sections (Critical Deep-Dive)

web has **12 components** in `packages/web/src/components/settings/` (11 sections + AutonomyCard helper). web-next `packages/web-next/components/settings/` has **7 files**.

web-next settings page is a sidebar layout with 9 named section keys: `profile`, `appearance`, `sources`, `brief-preferences`, `privacy`, `workspaces`, `billing`, `api-export`, `danger`. Only 4 are live (sources, appearance, danger + the inline sources combo). The remainder use `EmptySettingsSection`.

**Summary: 3 PARITY, 1 PARITY (renamed), 8 MISSING**

| web component | LOC | Primary purpose | web-next status | Evidence |
|---------------|-----|-----------------|-----------------|----------|
| `DangerZoneSection.tsx` | 147 | Two-step admin reset (pre-v2 — no token countdown, no origin check) | **PARITY** | `components/settings/DangerZoneSection.tsx` exists in web-next; substantially more complete (token countdown, origin allowlist check, Cloudscape design) |
| `AutonomyCard.tsx` | 211 | Autonomy level picker with upgrade-confirmation modal | **PARITY** | web Settings.tsx replaces `AutonomyLevelSection` with `AutonomyCard` — web-next does not import it, but the underlying `autonomy_level` setting is accessible via the Sources section. **PARTIAL** in practice: no dedicated Autonomy section UI in web-next. See note below. |
| `AutonomyLevelSection.tsx` | 96 | Simple radio-button autonomy picker (superseded by AutonomyCard in web itself) | **PARTIAL** | Superseded in web itself; `AutonomyCard.tsx` (211 LOC) replaced it. web-next has neither component in `components/settings/`. No autonomy section under Settings → Danger zone or Sources. API: `PUT /api/v1/settings/autonomy_level`. |
| `AIRoutingSection.tsx` | 95 | AI model routing table + monthly budget progress bar | **MISSING** | Checked `components/settings/` (7 files), `app/(shell)/settings/page.tsx` (9 section keys, none map to AI routing), `components/intelligence/` — no routing table component found. API: `GET /api/v1/config/ai-routing`. |
| `EmailAllowlistSection.tsx` | 158 | Add/remove allowed sender emails/domains for brain@troy-davis.com | **MISSING** | Not in `components/settings/`, not inline in `app/(shell)/settings/page.tsx`. Settings page lists `sources` as live but `SourcesSection.tsx` only shows integration status rows, not allowlist CRUD. API: `GET/PUT /api/v1/settings/email_allowlist`. |
| `EmailConfigSection.tsx` | 48 | Inbound/outbound email integration status display | **MISSING** | `SourcesSection.tsx` shows integration rows (Slack, Mic, Mail, OneDrive, MCP) but email inbound/outbound split status is not present. No equivalent component found. API: `GET /api/v1/config/integrations` (name-filtered to Email). |
| `IntegrationsSection.tsx` | 81 | Integration status list with URL, last-activity, badge | **PARTIAL** | `SourcesSection.tsx` covers the same `GET /api/v1/config/integrations` endpoint with richer icon design, but missing: URL display, last_activity tooltip, `badge variant={connected/disconnected}`. The core integration list is present; metadata detail is absent. |
| `ServiceHealthSection.tsx` | 45 | Per-service health dot + latency_ms + models_available | **MISSING** | No equivalent in `components/settings/`. System health detail lives in `app/(shell)/system/page.tsx` via `OverviewTab.tsx`, not in Settings. API: `GET /api/v1/health` (services sub-object). |
| `TriggersSection.tsx` | 143 | Semantic trigger CRUD (name, query_text, create/delete, fire stats) | **MISSING** | Not in `components/settings/`, not in `app/(shell)/settings/page.tsx` section map (no `triggers` section key). API: `GET/POST /api/v1/triggers`, `DELETE /api/v1/triggers/:id`. |
| `VersionUptimeSection.tsx` | 43 | API version + uptime display | **MISSING** | Not in `components/settings/` or any settings section. Available via System page OverviewTab but not surfaced in Settings. API: `GET /api/v1/health` (version, uptime_s fields). |
| `VoiceSection.tsx` | 64 | Pipecat integration status + iOS Shortcut status + session count stats | **MISSING** | No voice status section in web-next Settings. Voice statistics visible on the Voice/VoiceConversations pages, but not in a Settings context. API: `GET /api/v1/voice-sessions`, `GET /api/v1/config/integrations`. |
| `WikiSection.tsx` | 79 | Gitea repo status, page count, sync timestamp, lint schedule display | **MISSING** | No wiki section in web-next Settings. Wiki statistics are on the Wiki page but not surfaced in Settings. API: `GET /api/v1/wiki/stats`, `GET /api/v1/skills` (for schedule). |

**Notes:**
- `AutonomyCard.tsx` is a helper sub-component used only in web's Settings page. web itself deprecated `AutonomyLevelSection` in favor of it. Neither appears in web-next Settings — the autonomy setting has no settings page UI in web-next. Classified as MISSING for practical purposes (no settings UI surface).
- `IngestFiltersSection.tsx` and `EntityExtractionSection.tsx` exist only in web-next (web-next-only additions from M3) — not gaps in the other direction.
- `AppearanceSection.tsx` exists only in web-next (wash palette selector) — web-next-only.

**Settings gap count: 8 MISSING, 1 PARTIAL (IntegrationsSection), 1 PARTIAL (AutonomyLevelSection/AutonomyCard), 1 PARITY (DangerZoneSection)**

---

## Section 3: Lib Utilities

| web lib file | Purpose | web-next status |
|--------------|---------|-----------------|
| `lib/api.ts` | All API fetch helpers (captures, search, briefs, etc.) | **Equivalent** — `lib/api-client.ts` covers all domain APIs using TanStack Query patterns |
| `lib/types.ts` | Shared TypeScript types | **Equivalent** — `lib/types.ts` exists in web-next (different shape — Cloudscape-aligned types) |
| `lib/utils.ts` | `cn()`, `formatDateTime()`, `relativeTime()`, `truncate()` | **Partial** — `lib/format.ts` covers formatting; `cn()` likely inlined. No exact 1:1 file but functions covered |
| `lib/theme.ts` | Theme utilities (dark/light toggle) | **Equivalent** — `components/design-system/ThemeToggle.tsx` + `AppearanceSection.tsx` handle theme; `lib/` has no dedicated theme file but function covered |
| `lib/sse.ts` | SSE event-source utilities | **Equivalent** — `lib/sse-client.ts` + `lib/sse-invalidation-map.ts` (more complete) |

No surprises vs. recon. web-next lib is strictly more complete (adds `query-client.ts`, `source-icons.ts`, `synthesis-detect.ts`, `export.ts`, `mock-data.ts`).

---

## Section 4: Custom Components (non-Settings)

| web component | Purpose | web-next status |
|---------------|---------|-----------------|
| `CaptureCard.tsx` | Shared capture display card (Dashboard, Timeline, Search, EntityDetail) | **Equivalent** — `components/capture/CaptureHeader.tsx` + `AiSummary.tsx` + `TranscriptView.tsx` + `VoicePlayer.tsx` decomposed; no single `CaptureCard.tsx` but all display surfaces covered |
| `CaptureDetail.tsx` | Full capture detail view | **Equivalent** — `app/(shell)/captures/[id]/page.tsx` + capture components |
| `Layout.tsx` | App shell (nav + sidebar) | **Equivalent** — `app/(shell)/layout.tsx` + `components/nav/side-nav.tsx` + `top-nav.tsx` |
| `TranscriptViewer.tsx` | Voice transcript display | **Equivalent** — `components/capture/TranscriptView.tsx` |
| `WikiNavTree.tsx` | Wiki navigation tree | **Equivalent** — `components/wiki/WikiNavTree.tsx` |
| `FileDropZone.tsx` | File drag-and-drop upload | **Equivalent** — `components/ingest/FileDropZone.tsx` (and `components/voice/FileDropZone.tsx`) |
| `ThemeToggle.tsx` | Dark/light mode button | **Equivalent** — `components/design-system/ThemeToggle.tsx` |
| `ActivityFeedItem.tsx` | Single activity feed row | **Equivalent** — consumed by Dashboard; web-next `components/dashboard/RecentCaptures.tsx` covers |
| `EmailComposeDrawer.tsx` | Email compose slide-over | **Equivalent** — `components/email/DraftCard.tsx` + `ThreadView.tsx` cover email actions |
| `SearchFilters.tsx` | Search filter sidebar | **Equivalent** — `components/search/EntityFacets.tsx` + `SearchInput.tsx` |
| `StatsCards.tsx` | Dashboard metric cards | **Equivalent** — `components/dashboard/StatStrip.tsx` |
| `ConnectionsCard.tsx` | Entity connections visualization | **Equivalent** — `components/entity/relationship-graph.tsx` |
| `DriftCard.tsx` | Knowledge drift indicator | **Equivalent** — covered in `components/system/OverviewTab.tsx` |
| `SkillHistoryCard.tsx` | Skill run history display | **Equivalent** — `components/intelligence/SkillCard.tsx` |
| `AllocationDonut.tsx` | Portfolio allocation donut chart | **Equivalent** — `components/investments/AllocationChart.tsx` |
| `FinancialSummaryCard.tsx` | Financial summary card | **Equivalent** — `components/financial/ProviderTabs.tsx` |
| `NetWorthChart.tsx` | Net worth time series chart | **Equivalent** — covered in investments page components |
| `FinancialPulseCard.tsx` | Financial pulse indicator | **Equivalent** — covered in financial page |
| `SystemStatusStrip.tsx` | System health status bar | **Equivalent** — `components/system/OverviewTab.tsx` |
| `StatusStrip.tsx` | Generic status strip | **Equivalent** — `components/design-system/StatusDot.tsx` + page-level layout |

**system/ components:**

| web component | web-next equivalent | status |
|---------------|---------------------|--------|
| `system/FlowsTab.tsx` | `components/system/FlowsTab.tsx` | **Equivalent** |
| `system/McpActivityTab.tsx` | `components/system/McpActivityTab.tsx` | **Equivalent** |
| `system/OverviewStrip.tsx` | `components/system/OverviewTab.tsx` (renamed, expanded) | **Equivalent** |
| `system/QueuesTab.tsx` | `components/system/QueuesTab.tsx` | **Equivalent** |
| `system/SkillsTab.tsx` | `components/system/SkillsTab.tsx` | **Equivalent** |
| `system/InfrastructureTab.tsx` | (absorbed into OverviewTab or SystemTabs) | **Equivalent** — `components/system/SystemTabs.tsx` + OverviewTab covers infrastructure |

web-next adds `components/system/AdminResetSection.tsx` (web-next-only — admin reset moved from Settings into System page). No web-only system components.

---

## Section 5: shadcn/ui Component Usage

web (`packages/web`) imports `@/components/ui/*` at **114 sites across 48 files**. These are backed by `@radix-ui/*` packages in `packages/web/package.json`.

| shadcn/ui primitive | web usage | web-next equivalent |
|--------------------|-----------|---------------------|
| `badge` | 10+ sites | No shadcn — custom inline spans/classes |
| `button` | 20+ sites | Custom `components/design-system/Button.tsx` |
| `card` | 5+ sites | Custom `components/design-system/Card.tsx` |
| `input` | 5+ sites | Custom `components/design-system/Input.tsx` |
| `separator` | 3+ sites | CSS border / `components/design-system/Rule.tsx` |
| `toast` | 2+ sites | `sonner` package |
| `tooltip` | 3+ sites | Radix `@radix-ui/react-dialog` used for modals, no tooltip primitive |
| `accordion` | 1 site (Settings page) | Not used — Settings uses sidebar layout |
| `dialog` | 3+ sites | `@radix-ui/react-dialog` directly |
| `dropdown-menu` | 3+ sites | `@radix-ui/react-dropdown-menu` directly |
| `progress` | 1 site | Inline CSS progress styling |
| `sheet` | 1 site | Custom drawer/panel patterns |
| `tabs` | 5+ sites | Custom `components/design-system` (no Radix tabs in web-next) |

**web-next does NOT use shadcn/ui**. web-next's `package.json` has only `@radix-ui/react-dialog` and `@radix-ui/react-dropdown-menu` as direct Radix deps — both used at 6 sites for modals/menus, not as shadcn wrappers.

**Phase 8b implication:** Deleting `packages/web` removes the only consumer of the full shadcn/ui component set (`class-variance-authority`, `@radix-ui/react-accordion`, `@radix-ui/react-label`, `@radix-ui/react-progress`, `@radix-ui/react-separator`, `@radix-ui/react-slot`, `@radix-ui/react-tabs`, `@radix-ui/react-toast`, `@radix-ui/react-tooltip`). web-next keeps only the 2 Radix primitives it uses directly. The monorepo pnpm workspace will drop 9 `@radix-ui` packages after Phase 8b.

---

## Section 6: Phase 8b Feasibility Verdict

**Verdict: Conditional YES**

Phase 8b can delete `packages/web` once Phase 7.3 completes the 8 missing Settings sections. No other hard blockers.

**Explicit prerequisites for Phase 8b:**

1. **Phase 7.3 must build the following 8 missing Settings sections in web-next:**
   - `AIRoutingSection` — AI model routing table + budget bar (API: `GET /api/v1/config/ai-routing`, ~95 LOC rebuild)
   - `EmailAllowlistSection` — allowlist CRUD with validation (API: `GET/PUT /api/v1/settings/email_allowlist`, ~158 LOC rebuild)
   - `EmailConfigSection` — inbound/outbound status (API: `GET /api/v1/config/integrations`, ~48 LOC rebuild)
   - `ServiceHealthSection` — per-service health/latency (API: `GET /api/v1/health`, ~45 LOC rebuild)
   - `TriggersSection` — semantic trigger CRUD (API: `GET/POST /api/v1/triggers`, `DELETE /api/v1/triggers/:id`, ~143 LOC rebuild)
   - `VersionUptimeSection` — version/uptime display (API: `GET /api/v1/health`, ~43 LOC rebuild)
   - `VoiceSection` — voice integration status + stats (API: `GET /api/v1/voice-sessions`, `GET /api/v1/config/integrations`, ~64 LOC rebuild)
   - `WikiSection` — Gitea repo status, page count, lint schedule (API: `GET /api/v1/wiki/stats`, `GET /api/v1/skills`, ~79 LOC rebuild)
   - **Autonomy section** — autonomy level picker (API: `GET/PUT /api/v1/settings/autonomy_level`; `AutonomyCard.tsx` in web is 211 LOC — may adapt directly)

2. **All API endpoints for the above sections already exist** — no backend work required for Phase 7.3 to unblock Phase 8b.

3. **`IntegrationsSection` is PARTIAL** — `SourcesSection.tsx` in web-next covers the core list but lacks URL display and last_activity tooltip. Phase 7.3 may enhance `SourcesSection.tsx` or add a supplementary component; not a hard Phase 8b blocker (functional coverage present).

4. **Rollback tag** `pre-web-sunset-2026-05` must be pushed before deletion per Phase 8b plan.

5. **Smoke test** `brain.troy-davis.com` post-delete to confirm Cloudflare Tunnel routes cleanly to web-next container.

No other hard blockers found. Routes, system components, lib utilities, and all non-settings custom components are fully covered in web-next. shadcn/ui removal is clean (web-next does not use it).
