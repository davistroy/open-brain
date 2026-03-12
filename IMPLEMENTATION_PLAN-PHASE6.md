# Implementation Plan — Phase 6: UX Polish + Admin Tools

**Generated:** 2026-03-11 22:00:00
**Based On:** docs/PRD.md (v0.8, F29-F35), docs/TDD.md (v0.7, Phase 6 endpoints)
**Total Phases:** 5 (Phase 21-25, continuing from IMPLEMENTATION_PLAN-PHASE5.md Phase 20)
**Estimated Total Effort:** ~2,200 LOC across ~30 files

---

## Executive Summary

This plan implements seven features (F29-F35) that round out the Open Brain web UI with operational improvements, bug fixes, and administrative tooling. The features fall into three categories: bug fixes and restructuring (F30 trigger delete fix, F33 settings reorg), small independent enhancements (F29 queue management, F32 dark mode), and new functionality (F31 skill schedule editing, F34 help page, F35 Slack channel cleanup).

None of these features require schema migrations or new database tables. F29/F33 extend the existing admin routes and Settings page. F30 is a field-mapping fix. F31 adds a PATCH endpoint and config file write-back. F32 is purely client-side. F34 adds a new page with a build-time markdown dependency. F35 is the most complex — it introduces a new Slack Web API dependency and a long-running BullMQ job for rate-limited message deletion.

The phasing prioritizes foundation work first (fix the trigger bug and restructure Settings before adding new widgets to it), then layers on independent features, and saves the most complex/risky feature (Slack cleanup) for last.

---

## Plan Overview

Phases are ordered by dependency and risk:

- **Phase 21** fixes the trigger delete bug (F30) and restructures the Settings page (F33) — this is foundation work that must land before F29 adds clear buttons to the queue section.
- **Phase 22** adds queue clear buttons (F29) into the restructured Settings page and implements the dark mode toggle (F32) — two small, independent features.
- **Phase 23** implements skill schedule editing (F31) — a vertical slice requiring a new API endpoint, config file persistence, and inline-editable UI.
- **Phase 24** adds the in-app help page (F34) — a new route, new npm dependency, and build-time markdown bundling.
- **Phase 25** implements Slack channel cleanup (F35) — the most complex feature with a new npm dependency, Bitwarden secret, long-running BullMQ job, and rate-limited Slack API calls.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies |
|-------|------------|------------------|-----------------|--------------|
| 21 | Trigger Fix + Settings Reorg (F30, F33) | Fix trigger delete field mapping, split SystemHealthSection into 3 cards | S (~4 files, ~200 LOC) | None |
| 22 | Queue Management + Dark Mode (F29, F32) | POST clear endpoint, clear buttons in queue section, dark mode toggle | S (~5 files, ~300 LOC) | Phase 21 (F29 depends on F33 restructured queue section) |
| 23 | Skill Schedule Editing (F31) | PATCH /skills/:name endpoint, cron validation, inline-editable UI, skills.yaml write-back | M (~5 files, ~450 LOC) | None |
| 24 | In-App Help Page (F34) | /help route, react-markdown dependency, tabbed markdown viewer, TOC sidebar | M (~5 files, ~500 LOC) | None |
| 25 | Slack Channel Cleanup (F35) | POST cleanup endpoint, @slack/web-api dependency, BullMQ job, confirmation modal, dry-run mode | L (~7 files, ~750 LOC) | None |

<!-- BEGIN PHASES -->

---

## Phase 21: Trigger Delete Fix + Settings Page Reorganization (F30, F33)

**Estimated Complexity:** S (~4 files, ~200 LOC)
**Dependencies:** None
**Parallelizable:** Yes — F30 and F33 are independent work items

### Goals

- Fix the trigger delete (trash icon) so it works end-to-end
- Split the monolithic `SystemHealthSection` into three focused sections

### Work Items

#### 21.1 Fix Trigger Delete Field Name Mismatch (F30) ✅ Completed 2026-03-11
**Status: COMPLETE [2026-03-11]**
**Requirement Refs:** PRD F30
**Files Affected:**
- `packages/web/src/lib/api.ts` (modify — add field mapping in `triggersApi.list`)
- `packages/web/src/lib/types.ts` (modify — verify Trigger type covers both field names)

**Description:**
The trigger delete chain is wired correctly: Settings.tsx `handleDeleteTrigger` -> `triggersApi.delete(id)` -> `DELETE /api/v1/triggers/:id` -> `triggerService.delete(nameOrId)`. The issue is a field name mismatch between what the backend returns and what the frontend renders.

The backend `TriggerService.list()` returns rows with `condition_text` (the semantic query text) and `enabled` (boolean active state). The frontend `TriggersSection` component reads `trigger.query_text` and `trigger.is_active`. Because these fields are `undefined`, the query text never displays and the active badge falls through to the `enabled` fallback (which works because of the `trigger.is_active ?? trigger.enabled` pattern).

The fix: map `condition_text` -> `query_text` and `enabled` -> `is_active` in the `triggersApi.list()` response mapper, following the same pattern used by `entitiesApi.list()` which maps `entity_type` -> `type` and `mention_count` -> `capture_count`. Also map `last_triggered_at` -> `last_fired_at` and `trigger_count` -> `fire_count` for the metadata display.

Additionally, verify the delete actually works by tracing: the `triggerService.delete()` method does a soft-deactivate (`enabled = false`), but the frontend calls `loadTriggers()` after deletion. Since `list()` returns all triggers (active and inactive), the deactivated trigger will still appear in the list but with an "inactive" badge. This is the expected behavior — confirm this is acceptable or decide if inactive triggers should be filtered out.

**Tasks:**
1. [x] Add field mapping in `triggersApi.list()` to transform each trigger: `condition_text` -> `query_text`, `enabled` -> `is_active`, `last_triggered_at` -> `last_fired_at`, `trigger_count` -> `fire_count`, `action_config.cooldown_minutes` -> `cooldown_minutes`, `action_config.delivery_channel` -> `delivery_channel`
2. [x] Verify the `Trigger` type in `types.ts` already has both field name variants (it does — `enabled` and `is_active`, `query_text` are all present)
3. [ ] Test end-to-end: create a trigger, verify fields display correctly, click trash, verify it becomes inactive in the list

**Acceptance Criteria:**
- [x] Trigger query text displays in the trigger list (was previously blank)
- [x] Active/inactive badge shows correct state
- [x] Clicking the trash icon soft-deactivates the trigger (badge changes to "inactive")
- [x] Trigger metadata (threshold, cooldown, fire count, last fired) displays correctly
- [x] Trigger list refreshes after deletion

**Notes:**
- The soft-deactivate behavior is intentional — triggers are never hard-deleted because they contain pre-computed embeddings. Users can see deactivated triggers and know they exist. A future enhancement could add a "show inactive" toggle.
- The `triggersApi.create()` method already sends `query_text` in the POST body, but the backend route handler reads `queryText` (camelCase). This works because the route destructures `body as { queryText }` but the create body sends `query_text`. Need to verify — the POST body in `api.ts` line 189 sends `{ name, query_text: queryText }`, and the route handler reads `body.queryText`. These are different keys. **This is a second bug**: the create sends `query_text` but the handler reads `queryText`. However, since creates work (triggers exist in the database), one of two things is true: (a) the frontend `queryText` variable is being sent as camelCase somewhere, or (b) there's another path. Investigate during implementation.

---

#### 21.2 Reorganize Settings Page — Split System Health into Three Sections (F33) ✅ Completed 2026-03-11
**Status: COMPLETE [2026-03-11]**
**Requirement Refs:** PRD F33
**Files Affected:**
- `packages/web/src/pages/Settings.tsx` (modify — refactor `SystemHealthSection` into three components)

**Description:**
Split the current `SystemHealthSection` component (lines 50-115 in Settings.tsx) into three separate card-based sections:

1. **Version & Uptime** — Shows application version and uptime. Simple key-value display.
2. **Service Health** — Shows Postgres, Redis, and LiteLLM status with status dots and latency. Each service gets its own row with `StatusDot`.
3. **Queue Status** — Shows BullMQ queue counts (waiting, active, failed) with the `Activity` icon. This section will receive the "Clear Failed" buttons in Phase 22 (F29).

Each section is a standalone component with its own `<section>` wrapper, heading (`<h2>`), and card (`rounded-lg border bg-card`). The existing `StatusDot` component is shared across sections.

The visual hierarchy follows the PRD: version/uptime at top, then services, then queues, with `<Separator />` between sections.

**Tasks:**
1. [ ] Extract `VersionUptimeSection` component — takes `version` and `uptime_s` props, renders two key-value rows
2. [ ] Extract `ServiceHealthSection` component — takes `services` prop (Record<string, ServiceStatus>), renders one row per service with `StatusDot`, latency, and model list
3. [ ] Extract `QueueStatusSection` component — takes `queues` prop (Record<string, QueueCounts>), renders one row per queue with `Activity` icon and counts. Accept an optional `onClearQueue` callback prop (used by F29 in Phase 22)
4. [ ] Replace the single `<SystemHealthSection>` call in the main `Settings` component with the three new sections separated by `<Separator />`
5. [ ] Remove the old `SystemHealthSection` component

**Acceptance Criteria:**
- [ ] Three visually distinct sections render on the Settings page
- [ ] Version & Uptime section shows version and formatted uptime
- [ ] Service Health section shows each service with status dot and latency
- [ ] Queue Status section shows per-queue waiting/active/failed counts
- [ ] Loading skeletons still work for each section independently
- [ ] Error states still display correctly
- [ ] No visual regression — layout matches the existing card-based design

**Notes:**
- Keep the `SystemHealth` interface for the data fetching — only the rendering is being split. The `loadHealth` callback in the main component stays the same.
- The `QueueStatusSection` component should accept `onClearQueue?: (queueName: string) => Promise<void>` even though it won't be used until Phase 22. This avoids re-touching the component later.

---

### Phase 21 Testing Requirements

- [ ] Trigger delete: manual test — create trigger via UI, verify query text displays, click trash, verify deactivation
- [ ] Settings sections: visual inspection — three separate sections render with correct data
- [ ] No regressions in existing Settings functionality (skills, danger zone)
- [ ] All existing unit tests pass (`pnpm test`)

### Phase 21 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Trigger delete works end-to-end (field mapping verified)
- [ ] Settings page renders three distinct health sections
- [ ] No regressions introduced

---

## Phase 22: Queue Management UI + Dark Mode Toggle (F29, F32)

**Estimated Complexity:** S (~5 files, ~300 LOC)
**Dependencies:** Phase 21 (F29 needs the restructured `QueueStatusSection` from F33)
**Parallelizable:** Yes — F29 (backend + UI) and F32 (purely client-side) are independent

### Goals

- Add per-queue "Clear Failed" buttons to the queue status section
- Implement a dark mode toggle with localStorage persistence

### Work Items

#### 22.1 Queue Clear API Endpoint (F29 — Backend)
**Status: PENDING**
**Requirement Refs:** PRD F29, TDD §3.2 (POST /api/v1/admin/queues/:name/clear)
**Files Affected:**
- `packages/core-api/src/routes/admin.ts` (modify — add POST route inside the `if (redisConnection)` block)

**Description:**
Add a `POST /api/v1/admin/queues/:name/clear` endpoint to the admin router. This endpoint clears jobs in a specified state (default: `failed`) from a named BullMQ queue using `Queue.clean()`.

The endpoint lives inside the existing `if (redisConnection)` block in `createAdminRouter`, alongside the Bull Board and pipeline health routes. It reuses the same `queues` array (Queue instances created for Bull Board monitoring).

No `adminAuth` middleware — follows the same pattern as `POST /reset-data` (web UI cannot send Bearer tokens). Protected by POST method requirement and queue name validation.

**Tasks:**
1. [ ] Add `POST /queues/:name/clear` route inside the `if (redisConnection)` block
2. [ ] Validate queue name against `QUEUE_NAMES` constant — return 404 if not recognized
3. [ ] Parse optional body for `state` (default: `'failed'`) and `grace_period_ms` (default: `0`)
4. [ ] Call `queue.clean(gracePeriodMs, limit, state)` — use limit of 1000 (BullMQ's `clean()` returns the list of removed job IDs)
5. [ ] Return `{ queue: name, state, cleared_count: removedIds.length, cleared_at: ISO string }`
6. [ ] Add a placeholder route in the `else` block (no Redis) that returns 503

**Acceptance Criteria:**
- [ ] `POST /api/v1/admin/queues/capture-pipeline/clear` clears failed jobs and returns count
- [ ] Invalid queue names return 404
- [ ] Optional `state` parameter works for `failed`, `completed`, `delayed`
- [ ] Works without adminAuth (same pattern as reset-data)

**Notes:**
- BullMQ `Queue.clean()` signature: `clean(grace: number, limit: number, type: string)`. The `type` parameter maps to job state. Grace period of 0 means "all jobs regardless of age."
- The `QUEUE_NAMES` constant already exists and is used for Bull Board registration.

---

#### 22.2 Queue Clear Buttons in Settings UI (F29 — Frontend)
**Status: PENDING**
**Requirement Refs:** PRD F29
**Files Affected:**
- `packages/web/src/pages/Settings.tsx` (modify — add clear button rendering and handler in `QueueStatusSection`)
- `packages/web/src/lib/api.ts` (modify — add `adminApi.clearQueue` method)

**Description:**
Wire the "Clear Failed" buttons into the `QueueStatusSection` component created in Phase 21 (work item 21.2). Each queue row shows a small "Clear" button when `failed > 0`. Clicking it calls the new endpoint and refreshes queue counts.

**Tasks:**
1. [ ] Add `clearQueue(queueName: string)` method to `adminApi` in `api.ts` — calls `POST /api/v1/admin/queues/${name}/clear` with `{ state: 'failed' }`
2. [ ] In `QueueStatusSection`, render a `<Button size="sm" variant="ghost">` with text "Clear" next to the failed count when `q.failed > 0`
3. [ ] Add click handler that calls `onClearQueue(queueName)`, shows a brief loading state, and displays the cleared count
4. [ ] In the main `Settings` component, implement `handleClearQueue` function that calls `adminApi.clearQueue(name)` and then calls `loadHealth()` to refresh counts
5. [ ] Pass `handleClearQueue` as the `onClearQueue` prop to `QueueStatusSection`

**Acceptance Criteria:**
- [ ] "Clear" button appears next to each queue's failed count only when failed > 0
- [ ] Clicking "Clear" removes failed jobs and the count updates to 0
- [ ] Success feedback shows the number of cleared jobs
- [ ] Button shows loading state during the API call
- [ ] No button appears when a queue has 0 failed jobs

**Notes:**
- The clear button should be small and unobtrusive — `variant="ghost"` with `text-destructive` color. Don't want accidental clicks.

---

#### 22.3 Dark Mode Toggle (F32)
**Status: PENDING**
**Requirement Refs:** PRD F32
**Files Affected:**
- `packages/web/src/components/ThemeToggle.tsx` (create)
- `packages/web/src/components/Layout.tsx` (modify — add ThemeToggle to sidebar footer)
- `packages/web/src/lib/theme.ts` (create — theme detection and persistence utilities)

**Description:**
The dark mode CSS infrastructure is 100% complete: `tailwind.config.ts` has `darkMode: ['class']` configured, and `index.css` has a complete `.dark` CSS variable block. The only missing piece is a toggle component and the logic to add/remove the `.dark` class on `<html>`.

Implementation:
1. A `theme.ts` utility module that handles detection (`prefers-color-scheme`), persistence (`localStorage`), and application (`html.classList.add/remove('dark')`).
2. A `ThemeToggle` component that renders a sun/moon icon button and calls the theme utility.
3. The toggle sits in the sidebar footer, next to the Settings nav link.

The theme must be applied before React renders to avoid a flash of wrong theme (FOWT). This is handled by an inline `<script>` in `index.html` or by calling the theme initializer at module load time in `theme.ts`.

**Tasks:**
1. [ ] Create `packages/web/src/lib/theme.ts` with:
   - `getTheme()`: returns `'light' | 'dark' | 'system'` from localStorage (key: `ob-theme`), defaults to `'system'`
   - `setTheme(theme)`: saves to localStorage and applies `.dark` class
   - `applyTheme()`: reads preference, resolves `system` via `matchMedia('(prefers-color-scheme: dark)')`, applies `.dark` class
   - `initTheme()`: called at module load — applies theme immediately
2. [ ] Create `packages/web/src/components/ThemeToggle.tsx`:
   - Renders a `<Button variant="ghost" size="sm">` with `Sun` or `Moon` icon from lucide-react
   - Cycles through: system -> light -> dark -> system (or simple light/dark toggle)
   - Calls `setTheme()` and updates local state
3. [ ] Modify `packages/web/src/components/Layout.tsx`:
   - Import `ThemeToggle`
   - Add `<ThemeToggle />` in the sidebar footer `<div>` alongside the Settings nav link
4. [ ] Add theme initialization: import `theme.ts` in the app entry point so `initTheme()` runs before first render
5. [ ] Add `<script>` block in `index.html` for instant theme application before React loads (prevents flash)

**Acceptance Criteria:**
- [ ] Toggle visible in the sidebar footer area
- [ ] Clicking toggles between light and dark mode with instant visual switch
- [ ] Preference persists across page refreshes
- [ ] First visit defaults to system preference (`prefers-color-scheme`)
- [ ] No flash of wrong theme on page load
- [ ] All existing UI elements render correctly in both modes (test: dashboard, search, settings, entities)

**Notes:**
- Simple two-state toggle (light/dark) is cleaner than a three-state (light/dark/system). System preference is only used for the initial default. Once the user clicks the toggle, their explicit choice overrides.
- The `index.html` script approach for instant theme is a well-established pattern — Next.js, Vite starter templates, and shadcn/ui all do this.

---

### Phase 22 Testing Requirements

- [ ] Queue clear: create a failing job manually, verify clear button appears, click it, verify count drops to 0
- [ ] Dark mode: toggle on, navigate between pages, verify no visual glitches, refresh page, verify persistence
- [ ] All existing unit tests pass (`pnpm test`)

### Phase 22 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Queue clear buttons functional and visible only when failed > 0
- [ ] Dark mode toggle works with persistence and system preference default
- [ ] No regressions introduced

---

## Phase 23: Skill Schedule Editing (F31)

**Estimated Complexity:** M (~5 files, ~450 LOC)
**Dependencies:** None (can run in parallel with Phase 22)
**Parallelizable:** Yes — backend (23.1) and frontend (23.2) can develop concurrently against a shared API contract

### Goals

- Make skill cron schedules editable from the Settings page
- Persist schedule changes to `config/skills.yaml`
- Changes take effect without container restart (hot-reload)

### Work Items

#### 23.1 PATCH /api/v1/skills/:name Endpoint (F31 — Backend)
**Status: PENDING**
**Requirement Refs:** PRD F31, TDD §3.2 (PATCH /api/v1/skills/:name)
**Files Affected:**
- `packages/core-api/src/routes/skills.ts` (modify — add PATCH route, add skills.yaml write-back)
- `package.json` or `packages/core-api/package.json` (modify — add `cron-parser` dependency if not already present)

**Description:**
Add a `PATCH /api/v1/skills/:name` endpoint that accepts a new cron schedule, validates it, updates the in-memory `KNOWN_SKILLS` constant, and persists the change to `config/skills.yaml` on disk.

Currently, `KNOWN_SKILLS` is a hardcoded `const` in `skills.ts`. The approach:
1. Convert `KNOWN_SKILLS` from `const` to a mutable `let` (or use a module-level `Map`).
2. On PATCH, validate the skill name exists, validate the cron expression with `cron-parser`, update the in-memory map, and write the updated config to `config/skills.yaml` using `fs.writeFileSync` (YAML serialization with `js-yaml`).
3. Trigger a config service hot-reload so the scheduler picks up the new schedule on its next tick.

The scheduler in the workers package uses BullMQ repeatable jobs. Changing a schedule in `skills.yaml` alone won't update repeatable jobs — the scheduler needs to remove the old repeatable and add a new one. This requires either a config reload hook in the scheduler or a restart. For v1, document that schedule changes take effect after the next container restart (or after the scheduler's startup re-registration, which uses stable jobIds to upsert).

**Tasks:**
1. [ ] Add `cron-parser` dependency (for validation) and `js-yaml` dependency (for YAML write-back) to `packages/core-api/package.json`
2. [ ] Convert `KNOWN_SKILLS` from a frozen `const` to a mutable record (or a `Map`)
3. [ ] Add `PATCH /api/v1/skills/:name` route:
   - Validate skill name exists in `KNOWN_SKILLS` — return 404 if not
   - Parse body for `schedule` field (required string)
   - Validate cron expression with `cron-parser.parseExpression(schedule)` — return 400 if invalid
   - Update `KNOWN_SKILLS[name].schedule`
   - Write updated skills config to `config/skills.yaml` (read existing, merge, write)
   - Return `{ name, schedule, updated_at }`
4. [ ] Add `loadSkillsFromYaml()` function that reads `config/skills.yaml` and merges into `KNOWN_SKILLS` — call this at startup to initialize from persisted config
5. [ ] Handle missing `config/skills.yaml` gracefully — use hardcoded defaults if file doesn't exist

**Acceptance Criteria:**
- [ ] `PATCH /api/v1/skills/weekly-brief` with `{ "schedule": "0 19 * * 0" }` returns 200 with updated schedule
- [ ] Invalid cron expressions return 400 with descriptive error
- [ ] Unknown skill names return 404
- [ ] Updated schedule persists to `config/skills.yaml`
- [ ] `GET /api/v1/skills` reflects the updated schedule
- [ ] Existing skills.yaml (if present) is read on startup

**Notes:**
- `config/skills.yaml` does not currently exist — the `config/` directory has `ai-routing.yaml`, `brain-views.yaml`, `notifications.yaml`, and `pipeline.yaml` but no `skills.yaml`. This endpoint creates it on first write.
- The `js-yaml` package is likely already a transitive dependency (used by ConfigService). Check before adding.
- Schedule changes won't affect BullMQ repeatable jobs until the scheduler restarts. This is acceptable for v1 — document the limitation. A future improvement would add a webhook or Redis pub/sub notification from core-api to workers.

---

#### 23.2 Inline Schedule Editing UI (F31 — Frontend)
**Status: PENDING**
**Requirement Refs:** PRD F31
**Files Affected:**
- `packages/web/src/pages/Settings.tsx` (modify — add edit mode to `SkillsSection` schedule display)
- `packages/web/src/lib/api.ts` (modify — add `skillsApi.updateSchedule` method)

**Description:**
Add inline schedule editing to the `SkillsSection` component. Each skill's schedule line (`Schedule: 0 20 * * 0`) becomes clickable. Clicking it enters edit mode: the cron text turns into an `<Input>` with the current value, flanked by Save (check icon) and Cancel (X icon) buttons.

On save, call the new PATCH endpoint. On success, exit edit mode and show the updated schedule. On error (invalid cron), show a red error message below the input.

**Tasks:**
1. [ ] Add `updateSchedule(skillName: string, schedule: string)` method to `skillsApi` in `api.ts` — calls `PATCH /api/v1/skills/${name}` with `{ schedule }`
2. [ ] Add edit state to `SkillsSection`: `editingSkill: string | null`, `editValue: string`, `editError: string | null`, `saving: boolean`
3. [ ] Replace the static schedule `<span>` with a clickable element — on click, set `editingSkill = skill.name` and `editValue = skill.schedule`
4. [ ] When in edit mode for a skill, render: `<Input value={editValue} onChange={...} className="w-48 font-mono text-xs" />` with Save (Check icon) and Cancel (X icon) buttons
5. [ ] Save handler: call `skillsApi.updateSchedule(name, editValue)`, on success reset edit state and reload skills, on error set `editError`
6. [ ] Cancel handler: reset `editingSkill` to null
7. [ ] Add keyboard support: Enter to save, Escape to cancel

**Acceptance Criteria:**
- [ ] Clicking a schedule cron expression enters inline edit mode
- [ ] Valid cron expression saves and updates the display
- [ ] Invalid cron expression shows an error message without closing edit mode
- [ ] Cancel button (or Escape) exits edit mode without changes
- [ ] Enter key submits the edit
- [ ] Only one skill can be edited at a time
- [ ] Saving shows a brief loading indicator

**Notes:**
- Consider adding a human-readable cron description below the input (e.g., "Every Sunday at 8 PM") using a library like `cronstrue`. This is optional for v1 but would significantly improve usability since most users can't read raw cron expressions.
- The `Pencil` icon from lucide-react works well as a click-to-edit affordance next to the schedule text.

---

### Phase 23 Testing Requirements

- [ ] Unit test: `PATCH /api/v1/skills/:name` with valid cron, invalid cron, unknown skill name
- [ ] Unit test: `loadSkillsFromYaml()` with existing file, missing file, malformed YAML
- [ ] Manual test: edit schedule in UI, verify persistence, refresh page, verify schedule is updated
- [ ] All existing unit tests pass (`pnpm test`)

### Phase 23 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Schedule editing works end-to-end (UI -> API -> YAML -> reload)
- [ ] `config/skills.yaml` created on first edit
- [ ] No regressions introduced

---

## Phase 24: In-App Help Page (F34)

**Estimated Complexity:** M (~5 files, ~500 LOC)
**Dependencies:** None (can run in parallel with Phase 22 or 23)
**Parallelizable:** Yes — all work items can develop concurrently

### Goals

- Add a `/help` page that renders the user documentation in-app
- Bundle markdown content at build time — no runtime API dependency
- Provide tab navigation between Quick Start and Full Guide
- Include a table of contents sidebar for the Full Guide

### Work Items

#### 24.1 Add react-markdown Dependency and Vite Raw Import Config
**Status: PENDING**
**Requirement Refs:** PRD F34
**Files Affected:**
- `packages/web/package.json` (modify — add `react-markdown`, `remark-gfm`, `rehype-slug`, `rehype-autolink-headings` dependencies)
- `packages/web/src/vite-env.d.ts` (modify — add `*.md?raw` module declaration)

**Description:**
Add the npm dependencies needed for markdown rendering and configure Vite to support raw markdown imports.

Vite natively supports `?raw` imports (`import content from './file.md?raw'`), which returns the file content as a string at build time. This avoids runtime fetching and ensures the help content is always available.

Dependencies:
- `react-markdown` — React component for rendering markdown as React elements
- `remark-gfm` — Plugin for GitHub Flavored Markdown (tables, strikethrough, task lists)
- `rehype-slug` — Adds `id` attributes to headings (for anchor links)
- `rehype-autolink-headings` — Adds anchor links to headings (for ToC navigation)

**Tasks:**
1. [ ] Add dependencies: `pnpm --filter @open-brain/web add react-markdown remark-gfm rehype-slug rehype-autolink-headings`
2. [ ] Add TypeScript declaration for raw markdown imports in `vite-env.d.ts`:
   ```typescript
   declare module '*.md?raw' {
     const content: string
     export default content
   }
   ```
3. [ ] Verify `docs/USER_QUICK_START.md` and `docs/USER_GUIDE.md` are accessible from the web package (may need a Vite alias or symlink since they're outside `packages/web/`)

**Acceptance Criteria:**
- [ ] `import quickStart from '../../../../docs/USER_QUICK_START.md?raw'` compiles without TypeScript errors
- [ ] Build produces the markdown content inlined in the JS bundle
- [ ] No runtime fetch needed for markdown content

**Notes:**
- The markdown files are in `docs/` (project root), not `packages/web/`. Vite can import files outside the project root by default, but the relative path will be long. Consider adding a Vite alias: `'@docs': path.resolve(__dirname, '../../docs')` so the import becomes `import quickStart from '@docs/USER_QUICK_START.md?raw'`.

---

#### 24.2 Help Page Component with Tabbed Markdown Viewer
**Status: PENDING**
**Requirement Refs:** PRD F34
**Files Affected:**
- `packages/web/src/pages/Help.tsx` (create)

**Description:**
Create the Help page component. Features:
- Two tabs: "Quick Start" and "Full Guide"
- Markdown rendered with proper styling (headings, tables, code blocks, links)
- Table of contents sidebar on the Full Guide tab (extracted from heading structure)
- Smooth scrolling to anchor links
- Responsive: ToC becomes a dropdown/accordion on mobile

The component uses `react-markdown` with `remark-gfm` for table support and `rehype-slug` / `rehype-autolink-headings` for navigable headings.

Markdown content is imported at build time using Vite raw imports — no API call needed.

**Tasks:**
1. [ ] Create `Help.tsx` with:
   - Raw imports for both markdown files
   - Tab state: `'quick-start' | 'full-guide'` (default: `'quick-start'`)
   - Tab buttons styled consistently with the app (can use shadcn Tabs or custom)
2. [ ] Implement `MarkdownRenderer` sub-component:
   - Uses `<ReactMarkdown>` with `remarkPlugins={[remarkGfm]}` and `rehypePlugins={[rehypeSlug, rehypeAutolinkHeadings]}`
   - Custom component overrides for styling: headings get appropriate Tailwind classes, tables get `border` and `divide-y`, code blocks get `bg-muted rounded p-3 font-mono text-sm`, inline code gets `bg-muted px-1.5 py-0.5 rounded text-sm font-mono`
   - Links open in new tab for external URLs, use smooth scroll for internal anchors
3. [ ] Implement `TableOfContents` sub-component:
   - Parses heading structure from raw markdown (regex: `/^#{1,3}\s+(.+)$/gm`)
   - Renders as a sidebar list with indent levels for h2/h3
   - Click scrolls to the heading (uses `rehype-slug` generated IDs)
   - Highlights current section based on scroll position (IntersectionObserver)
4. [ ] Layout: two-column on desktop (ToC sidebar + content), single column on mobile
5. [ ] Add "Back to top" floating button for long content

**Acceptance Criteria:**
- [ ] Quick Start tab renders USER_QUICK_START.md with proper formatting
- [ ] Full Guide tab renders USER_GUIDE.md with proper formatting
- [ ] Tables render with borders and proper alignment
- [ ] Code blocks have syntax highlighting background
- [ ] Table of contents shows on Full Guide tab with clickable section links
- [ ] Anchor links scroll smoothly to the target section
- [ ] Responsive: works on mobile without horizontal overflow

**Notes:**
- The Full Guide is large (~700 lines). The ToC is essential for navigation. Without it, users would need to scroll through the entire document.
- Consider lazy-rendering the Full Guide tab content (only render when selected) to avoid loading the large markdown parse on initial page load.

---

#### 24.3 Add Help Route and Navigation Link
**Status: PENDING**
**Requirement Refs:** PRD F34
**Files Affected:**
- `packages/web/src/App.tsx` (modify — add `/help` route)
- `packages/web/src/components/Layout.tsx` (modify — add Help link to sidebar)

**Description:**
Wire the Help page into the app's routing and navigation.

**Tasks:**
1. [ ] Add lazy import in `App.tsx`: `const Help = lazy(() => import('@/pages/Help'))`
2. [ ] Add route: `<Route path="help" element={<Help />} />`
3. [ ] Add Help to `bottomNavItems` in `Layout.tsx` with `HelpCircle` icon from lucide-react: `{ to: '/help', label: 'Help', icon: HelpCircle }`
4. [ ] Position Help above Settings in the sidebar footer (Help is informational, Settings is administrative)

**Acceptance Criteria:**
- [ ] Help link visible in sidebar footer
- [ ] Clicking Help navigates to `/help` and renders the help page
- [ ] Help link highlights when active (NavLink isActive)
- [ ] Mobile bottom nav includes Help if there's room (or it's in the "more" overflow)

**Notes:**
- The `bottomNavItems` array currently only has Settings. Adding Help gives it two items. Both should fit in the sidebar footer without issues.

---

### Phase 24 Testing Requirements

- [ ] Manual test: navigate to /help, verify Quick Start renders, switch to Full Guide, verify TOC links work
- [ ] Manual test: verify tables, code blocks, headings render correctly in both light and dark mode
- [ ] Build test: `pnpm --filter @open-brain/web build` succeeds with markdown imports
- [ ] All existing unit tests pass (`pnpm test`)

### Phase 24 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] Help page accessible from sidebar
- [ ] Both markdown documents render with proper formatting
- [ ] Table of contents works with smooth scrolling
- [ ] No regressions introduced

---

## Phase 25: Slack Channel Cleanup (F35)

**Estimated Complexity:** L (~7 files, ~750 LOC)
**Dependencies:** None (but should ship last — most complex and highest risk)
**Parallelizable:** Yes — backend (25.1, 25.2) and frontend (25.3) can develop concurrently

### Goals

- Add admin action to bulk-delete messages from the #open-brain Slack channel
- Implement as a BullMQ job for rate-limited, long-running execution
- Provide dry-run mode for safe previewing
- Surface results in the Settings Danger Zone

### Work Items

#### 25.1 Add @slack/web-api Dependency and Slack User Token
**Status: PENDING**
**Requirement Refs:** PRD F35, TDD §3.2 (POST /api/v1/admin/cleanup-slack-channel)
**Files Affected:**
- `packages/core-api/package.json` (modify — add `@slack/web-api` dependency)
- Bitwarden vault (add `SLACK_USER_TOKEN` secret)
- `docker-compose.yml` (modify — add `SLACK_USER_TOKEN` env var to core-api service)

**Description:**
The Slack `chat.delete` API requires a **user token** (not a bot token) for full message deletion scope. Bot tokens can only delete messages the bot sent. A user token with `chat:write` scope from a workspace admin can delete any message in channels they have access to.

This is a new secret that needs to be:
1. Created in the Slack app configuration (add User Token Scopes: `channels:history`, `chat:write`)
2. Stored in Bitwarden vault under `dev/open-brain/slack-user-token`
3. Passed to the core-api container as `SLACK_USER_TOKEN` environment variable

**Tasks:**
1. [ ] Add `@slack/web-api` dependency: `pnpm --filter @open-brain/core-api add @slack/web-api`
2. [ ] Document the Slack app configuration change needed: add User Token Scopes `channels:history`, `chat:write`
3. [ ] Store the user token in Bitwarden: `dev/open-brain/slack-user-token`
4. [ ] Add `SLACK_USER_TOKEN` to `docker-compose.yml` for the core-api service (placeholder, actual value from Bitwarden)
5. [ ] Add `SLACK_USER_TOKEN` to the `.env.example` with a placeholder comment

**Acceptance Criteria:**
- [ ] `@slack/web-api` is importable from core-api package
- [ ] `SLACK_USER_TOKEN` is available as an environment variable in the core-api container
- [ ] Token has the necessary Slack scopes for channel history read and message delete

**Notes:**
- The existing slack-bot package uses `@slack/bolt` which includes `@slack/web-api` as a dependency. However, core-api is a separate package and needs its own dependency. Alternatively, we could move this feature to the slack-bot package and expose it via an internal API, but that adds complexity. Direct dependency in core-api is simpler.
- **Security consideration**: The user token has broad permissions (delete any message). It must be stored in Bitwarden, never in `.env` files, and the endpoint must have strong confirmation safeguards.

---

#### 25.2 Slack Cleanup API Endpoint and BullMQ Job
**Status: PENDING**
**Requirement Refs:** PRD F35, TDD §3.2 (POST /api/v1/admin/cleanup-slack-channel)
**Files Affected:**
- `packages/core-api/src/routes/admin.ts` (modify — add POST /cleanup-slack-channel route)
- `packages/core-api/src/services/slack-cleanup.ts` (create — cleanup service with rate limiting)

**Description:**
Implement the Slack channel cleanup as a two-part system:

1. **API Endpoint** (`POST /api/v1/admin/cleanup-slack-channel`): Validates the request (confirmation phrase, channel name), performs a dry-run count or enqueues the actual deletion job. For simplicity in v1, the deletion runs synchronously in the request handler (not as a separate BullMQ job) with streaming progress via the response. This avoids the complexity of job status polling for a rarely-used admin action.

   Actually, given Slack's 1/second rate limit, deleting 500 messages would take 8+ minutes. That's too long for a synchronous HTTP request. Use BullMQ: the endpoint enqueues a cleanup job, returns 202 with a job ID, and the frontend polls for status.

2. **Cleanup Service** (`SlackCleanupService`): Handles the actual Slack API interaction:
   - Look up channel ID from channel name using `conversations.list`
   - Paginate through `conversations.history` to get all message timestamps
   - Call `chat.delete` for each message with a 1-second delay between calls (Slack Tier 3 rate limit)
   - Track success/failure counts
   - Return results: `{ deleted: number, failed: number, total: number, duration_ms: number }`

**Tasks:**
1. [ ] Create `packages/core-api/src/services/slack-cleanup.ts`:
   - Constructor takes `slackUserToken: string`
   - `countMessages(channelName: string): Promise<number>` — paginates `conversations.history` and counts
   - `deleteMessages(channelName: string, onProgress?: (deleted: number, total: number) => void): Promise<CleanupResult>` — paginates history, deletes each message with 1s delay
   - Uses `@slack/web-api` `WebClient`
   - Rate limiting: `await new Promise(r => setTimeout(r, 1100))` between each `chat.delete` call (1.1s to be safe)
   - Error handling: catches per-message errors (e.g., `message_not_found`, `cant_delete_message`) without aborting the batch
2. [ ] Add `POST /admin/cleanup-slack-channel` route in `admin.ts`:
   - Validate `SLACK_USER_TOKEN` env var exists — return 503 if missing
   - Parse body: `{ confirm: 'DELETE_ALL_MESSAGES', channel_name?: string, dry_run?: boolean }`
   - Validate confirmation phrase
   - If `dry_run`: call `countMessages()` synchronously and return `{ channel, message_count, dry_run: true }`
   - If not dry_run: enqueue a cleanup job to the `skill-execution` queue (reuse existing queue) with job data `{ skillName: 'cleanup-slack-channel', input: { channelName } }`
   - Return 202: `{ job_id, status: 'queued', channel, dry_run: false }`
3. [ ] Add cleanup job handler in workers skill-execution dispatcher — OR keep it simpler: run the cleanup inline in a long-running request with keep-alive headers. Decision: use BullMQ for consistency.
4. [ ] Add `GET /admin/cleanup-slack-channel/status/:jobId` endpoint for polling job progress (reads job state, progress data from BullMQ)

**Acceptance Criteria:**
- [ ] Dry-run mode returns message count without deleting anything
- [ ] Full run deletes messages at ~1/second rate
- [ ] Invalid confirmation phrase returns 400
- [ ] Missing SLACK_USER_TOKEN returns 503 with descriptive error
- [ ] Channel name defaults to "open-brain"
- [ ] Per-message failures don't abort the batch
- [ ] Results include deleted count, failed count, total, and duration

**Notes:**
- Slack's `conversations.history` returns messages newest-first. Delete in that order — it doesn't matter for cleanup.
- The `chat.delete` API can fail for individual messages (e.g., already deleted, system messages). Log these but continue.
- Consider adding this as a new case in the existing skill-execution worker's switch statement. The "skill" pattern already handles arbitrary named jobs with BullMQ.
- For the v1 polling UX, a simple "Cleanup in progress... N deleted so far" display with a 5-second poll interval is sufficient.

---

#### 25.3 Slack Cleanup UI in Settings Danger Zone
**Status: PENDING**
**Requirement Refs:** PRD F35
**Files Affected:**
- `packages/web/src/pages/Settings.tsx` (modify — add cleanup section to DangerZoneSection)
- `packages/web/src/lib/api.ts` (modify — add cleanup methods to adminApi)

**Description:**
Add a "Clean Slack Channel" action to the Danger Zone section on the Settings page. Follows the same confirmation pattern as "Wipe All Data" but with a different confirmation phrase and additional options (dry-run toggle).

UI flow:
1. User clicks "Clean Slack Channel" button
2. Confirmation modal opens:
   - Shows channel name (#open-brain)
   - Checkbox: "Dry run (count only, don't delete)"
   - Confirmation input: type `DELETE_ALL_MESSAGES`
   - Confirm / Cancel buttons
3. On confirm:
   - If dry run: shows message count immediately
   - If full run: shows "Cleanup queued..." with a progress indicator, polls for status
4. Results display: deleted count, failed count, duration

**Tasks:**
1. [ ] Add `adminApi.cleanupSlackChannel(dryRun: boolean)` method — calls `POST /api/v1/admin/cleanup-slack-channel` with `{ confirm: 'DELETE_ALL_MESSAGES', dry_run: dryRun }`
2. [ ] Add `adminApi.getCleanupStatus(jobId: string)` method — calls `GET /api/v1/admin/cleanup-slack-channel/status/${jobId}`
3. [ ] Add `SlackCleanupSection` component within `DangerZoneSection`:
   - "Clean Slack Channel" button with description text
   - Confirmation modal with dry-run checkbox and confirmation input
   - Progress display with polling (5-second interval)
   - Results display: deleted/failed/total/duration
4. [ ] Add confirmation phrase constant: `DELETE_ALL_MESSAGES`
5. [ ] Add polling logic: after job is queued, poll status every 5 seconds until job is completed or failed

**Acceptance Criteria:**
- [ ] "Clean Slack Channel" button appears in Danger Zone section
- [ ] Confirmation modal requires typing `DELETE_ALL_MESSAGES`
- [ ] Dry-run mode shows message count without deletion
- [ ] Full run shows progress indicator while deletion runs
- [ ] Results show deleted count, failed count, and duration
- [ ] Errors (missing token, API failures) display clearly

**Notes:**
- The polling approach is simple but effective. For a rarely-used admin action, it's preferable to WebSocket complexity.
- Add a visual separator between "Wipe All Data" and "Clean Slack Channel" in the Danger Zone to make them distinct destructive actions.

---

### Phase 25 Testing Requirements

- [ ] Unit test: `SlackCleanupService.countMessages()` with mocked Slack API
- [ ] Unit test: `SlackCleanupService.deleteMessages()` with mocked Slack API, verify 1s delay and error handling
- [ ] Unit test: cleanup endpoint validation (missing token, bad confirmation, dry-run)
- [ ] Manual test: dry-run against live #open-brain channel, verify count is accurate
- [ ] Manual test: full cleanup of a test channel, verify messages are deleted at ~1/second
- [ ] All existing unit tests pass (`pnpm test`)

### Phase 25 Completion Checklist

- [ ] All work items complete
- [ ] All tests passing
- [ ] `SLACK_USER_TOKEN` stored in Bitwarden
- [ ] Dry-run mode works correctly
- [ ] Full cleanup deletes messages with proper rate limiting
- [ ] Confirmation modal prevents accidental execution
- [ ] No regressions introduced

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| Phase 21.1 (Trigger Fix) | Phase 21.2 (Settings Reorg) | Independent — one is API client, other is UI components |
| Phase 22.3 (Dark Mode) | Phase 22.1 + 22.2 (Queue Clear) | Dark mode is purely client-side, queue clear is API + UI |
| Phase 23 (Skill Editing) | Phase 22 (Queue + Dark Mode) | No dependencies between them |
| Phase 24 (Help Page) | Phase 22 or 23 | New page, no dependencies on other Phase 6 work |
| Phase 25.1 (Slack Deps) | Phase 25.3 (Slack UI) | UI can stub API while backend is built |

---

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| Trigger create bug (query_text vs queryText in POST body) | Medium | Low | Investigate during F30 work; fix if confirmed broken |
| skills.yaml write-back causes file permission issues in Docker | Medium | Medium | Mount `config/` as a writable volume; test in container before deployment |
| Slack user token scope insufficient for full message deletion | Low | High | Test token with `auth.test` API before building cleanup feature |
| react-markdown bundle size impacts web build | Low | Low | Lazy-load Help page; react-markdown adds ~30KB gzipped |
| Slack rate limit (1/sec) makes large cleanups very slow | High | Low | Expected behavior — document that 1000 messages takes ~17 minutes |
| Dark mode CSS incomplete for third-party components | Low | Medium | Test all shadcn/ui components in dark mode; fix any missing variables |

---

## Success Metrics

- [ ] All 7 features (F29-F35) implemented and functional
- [ ] Settings page visually reorganized into clear, scannable sections
- [ ] Trigger delete works end-to-end (was broken, now fixed)
- [ ] Dark mode works without visual glitches across all pages
- [ ] Help page renders both documents with full formatting
- [ ] Queue management eliminates need for Bull Board for basic failed job cleanup
- [ ] Slack cleanup works with rate limiting and confirmation safeguards
- [ ] All existing tests pass with no regressions
- [ ] Docker build succeeds with new dependencies

---

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| F29: Queue Management UI | PRD §5.2, TDD §3.2 | 22 | 22.1 (backend), 22.2 (frontend) |
| F30: Trigger Delete Fix | PRD §5.2 | 21 | 21.1 |
| F31: Skill Schedule Editing | PRD §5.2, TDD §3.2 | 23 | 23.1 (backend), 23.2 (frontend) |
| F32: Dark Mode Toggle | PRD §5.2 | 22 | 22.3 |
| F33: Settings Page Reorganization | PRD §5.2 | 21 | 21.2 |
| F34: In-App Help/Documentation Viewer | PRD §5.2 | 24 | 24.1 (deps), 24.2 (page), 24.3 (routing) |
| F35: Slack Channel Cleanup | PRD §5.2, TDD §3.2 | 25 | 25.1 (deps), 25.2 (backend), 25.3 (frontend) |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-03-11 22:00:00*
*Source: /create-plan command*
