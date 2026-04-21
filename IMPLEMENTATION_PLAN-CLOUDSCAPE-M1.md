# Cloudscape UI — Milestone 1: Read-Only Shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pixel-accurate, read-only Next.js shell matching 5 approved design screens (Dashboard, Entities, Entity Detail, Briefs, Brief Reader) with mock data, wired to the Open Brain Cloudscape design tokens.

**Context:** This is a UI replacement for the existing `packages/web` (Vite + React Router). The new package `packages/web-next` coexists in the monorepo until it reaches parity, then replaces the old one. The existing core-api (25+ API routes, 25+ DB tables) is untouched — M2+ will wire the new UI to real endpoints.

**Architecture:** New `@open-brain/web-next` package inside the existing pnpm monorepo at `packages/web-next/`. Design tokens ported from `colors_and_type.css` into `globals.css` + `tailwind.config.ts`. Mock data fixtures mirror existing API response shapes for seamless M2 wiring.

**Tech Stack:** Next.js 16 (App Router, stable), TypeScript, Tailwind CSS v3, lucide-react, local woff2 fonts, pnpm.

**Acceptance bar:** Visual parity with prototype screenshots. Every route screenshotted before milestone sign-off.

---

## Implementation Summary

**Status:** ✅ COMPLETE — 2026-04-21
**Branch:** feat/cloudscape-m1
**Final SHA:** 974d4a5

### What was built
- `packages/web-next/` — Next.js 16 App Router package alongside existing Vite web UI
- **5 screens implemented:** Dashboard, Entities list, Entity detail, Briefs library, Brief reader
- **Design system:** 11 primitives (Button, Card, Container, PageHeader, Pill, Eyebrow, MetaLine, Rule, StatusDot, EmptyState, Input)
- **Navigation:** TopNav + SideNav (15 items, 6 sections) + shell route group
- **Foundation:** Full Cloudscape token palette, 13 woff2 fonts, Tailwind v3 config with 100+ CSS-var color classes
- **Mock data:** Typed fixtures mirroring real API shapes (M2 is a straight import swap)
- **All routes SSG-prerendered:** /dashboard, /entities, /entities/sarah-chen, /briefs, /briefs/tuesday-brief

### M2 wiring checklist
- Replace `mockStats/mockCaptures/mockEntities/mockBriefs` imports with `useQuery` or RSC fetches
- Wire QuickCapture `console.log` → `POST /api/v1/captures`
- Enable TypeFilterTabs server-side filtering via URL search params
- Add real `generateStaticParams` entity/brief IDs from API

---

## Reference Files (read-only)

All under `reference/handoff/open-brain-cloudscape-design-system/project/`:

| File | Purpose |
|------|---------|
| `HANDOFF.md` | Full spec — source of truth |
| `colors_and_type.css` | Design tokens — do NOT re-derive from screenshots |
| `screens/_shell.jsx` | Reference primitives (Shell, SCard, SBtn, Pill, Eyebrow, MetaLine, EmptyState) |
| `screens/01-dashboard.html` | Screen 01 — Dashboard |
| `screens/05-entities.html` | Screen 05 — Entities index |
| `screens/06-entity-detail.html` | Screen 06 — Entity detail (Sarah Chen) |
| `screens/07-briefs.html` | Screen 07 — Briefs library |
| `screens/08-brief-detail.html` | Screen 08 — Brief reader |
| `ui_kits/dashboard/TopNav.jsx` | TopNav reference |
| `ui_kits/dashboard/SideNav.jsx` | SideNav reference |
| `screens/_check-dashboard.jpg` | Visual target — Dashboard |
| `screens/_check-briefs-parchment.jpg` | Visual target — Briefs |
| `screens/_check-entity.jpg` | Visual target — Entity detail |
| `assets/icons.md` | Lucide icon mapping |

---

## File Structure

```
packages/web-next/
├── package.json                           # @open-brain/web-next
├── next.config.ts
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.mjs
├── .gitignore
│
├── public/fonts/                          # 13 woff2 files copied from handoff
│
├── app/
│   ├── layout.tsx                         # Root: <html data-wash="parchment">, metadata
│   ├── globals.css                        # @font-face, tokens, base resets, .reader prose, washes
│   ├── page.tsx                           # redirect → /dashboard
│   │
│   ├── (shell)/                           # Route group: TopNav + SideNav layout
│   │   ├── layout.tsx                     # Shell: TopNav + SideNav + <main> content
│   │   ├── dashboard/page.tsx             # Screen 01
│   │   ├── search/page.tsx                # Stub — "Coming in Milestone 4"
│   │   ├── briefs/page.tsx                # Screen 07
│   │   ├── briefs/[id]/page.tsx           # Screen 08
│   │   ├── entities/page.tsx              # Screen 05
│   │   ├── entities/[id]/page.tsx         # Screen 06
│   │   └── [...slug]/page.tsx             # Catch-all stub — "Coming in Milestone N"
│   │
│   └── not-found.tsx                      # 404 — editorial voice
│
├── components/
│   ├── design-system/
│   │   ├── button.tsx                     # SBtn port: primary/normal/ghost/link/dark
│   │   ├── card.tsx                       # SCard port: thin display header, hard corners
│   │   ├── container.tsx                  # Dashboard container: h3 header, shadow, 2px radius
│   │   ├── page-header.tsx                # Breadcrumb + title + subtitle + actions slot
│   │   ├── pill.tsx                       # 6 tones consuming semantic status tokens
│   │   ├── eyebrow.tsx                    # JetBrains Mono 10.5px uppercase
│   │   ├── meta-line.tsx                  # Mono key:value
│   │   ├── rule.tsx                       # 1px divider
│   │   ├── empty-state.tsx                # Icon + title + desc + action
│   │   ├── input.tsx                      # SInput port: icon, hard corners
│   │   └── status-dot.tsx                 # 6px dot + label
│   │
│   ├── nav/
│   │   ├── top-nav.tsx                    # Slate header: brand, search, utilities, user
│   │   └── side-nav.tsx                   # 280px: workspace, sections, active state
│   │
│   ├── dashboard/
│   │   ├── stat-strip.tsx                 # Horizontal stat blocks
│   │   ├── quick-capture.tsx              # Type toggle + textarea (client)
│   │   ├── recent-captures.tsx            # Row list with entity pills (client)
│   │   ├── open-questions.tsx             # Priority-railed questions
│   │   └── upcoming-briefs.tsx            # Progress bar list
│   │
│   ├── briefs/
│   │   ├── brief-hero.tsx                 # Warm paper hero CTA
│   │   ├── brief-card.tsx                 # Grid card: color rail + content
│   │   ├── brief-library.tsx              # Filter tabs + grid/list toggle (client)
│   │   ├── brief-reader.tsx               # Article body (.reader prose)
│   │   ├── brief-toc.tsx                  # Left sticky: ON THIS PAGE
│   │   └── brief-sources.tsx              # Right sticky: Grounded in + Refine
│   │
│   ├── entities/
│   │   ├── type-filter-tabs.tsx           # Reusable tab bar (client)
│   │   ├── entity-table.tsx               # Data table with search + sort
│   │   ├── distribution-card.tsx          # Bar chart by type
│   │   └── needs-attention.tsx            # Low-confidence extraction list
│   │
│   └── entity/
│       ├── entity-header.tsx              # Monogram + stats + actions
│       ├── entity-tabs.tsx                # Summary/Timeline/Captures/Relationships/Commitments
│       ├── ai-summary.tsx                 # Terracotta callout block
│       ├── commitments-card.tsx           # Grid: who/what/due
│       ├── capture-item.tsx               # Source + time + title + snippet
│       ├── relationship-graph.tsx         # SVG radial graph
│       ├── mentions-chart.tsx             # Mini bar chart
│       └── related-entities.tsx           # Type/name/shared-count list
│
└── lib/
    ├── types.ts                           # UI display types
    └── mock-data.ts                       # Typed fixtures for all screens
```

**Total: 43 source files + 13 font files = 56 files**

---

## Design Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| One Button component | SBtn only — kill Cloudscape `Button` | Screenshots confirm SBtn (weight 400, 13px) is the target; Cloudscape Button (weight 500, 14px) was prototype-timeline artifact |
| PageHeader component | Shared: breadcrumb + title + subtitle + right-side actions slot | Used on every page; eliminates copy-paste of Shell pattern |
| Semantic status tokens | New token layer: `--color-success`, `--color-status-{tone}-{bg/fg/border}` | Reused by Pill, StatusDot, badges, Board chips — not component-internal |
| Catch-all stub | Explicit "Coming in Milestone N" with owning milestone named | No silent 404s; user knows what's planned |
| Container vs Card | Both: Container (dashboard sections, h3, 2px radius, shadow) and Card (everywhere else, display 15px, 0 radius, 1px border) | Two distinct visual treatments in the approved screens |
| Font loading | Manual `@font-face` in globals.css | Tokens already reference `--font-family-*` by name; simpler than `next/font/local` |
| Dev port | 3001 | Core-api owns 3000, existing Vite web owns 5173 |
| `#5E8F4A` | New token `--color-success` | Distinct from `--color-moss` (#7A8471, grey sage) and `--color-olive` (#5F5B3B, brown-green). Bright true green for positive UI status. |

---

## Phase 1: Foundation

### 1.1 — Scaffold Next.js package in monorepo ✅ Completed 2026-04-21

**Status:** COMPLETE 2026-04-21

**Files:**
- Create: `packages/web-next/` (via pnpm create)
- Modify: none (pnpm-workspace.yaml auto-discovers `packages/*`)

- [ ] **Step 1:** Scaffold Next.js project

```bash
cd packages
pnpm create next-app web-next --typescript --tailwind --eslint --app --src-dir=false --no-import-alias --no-turbopack
```

- [ ] **Step 2:** Update `packages/web-next/package.json` — set name to `@open-brain/web-next`, add `"dev": "next dev --port 3001"`, set `"private": true`

- [ ] **Step 3:** Install lucide-react

```bash
cd packages/web-next && pnpm add lucide-react
```

- [ ] **Step 4:** Copy font files from handoff

```bash
mkdir -p packages/web-next/public/fonts
cp reference/handoff/open-brain-cloudscape-design-system/project/fonts/*.woff2 packages/web-next/public/fonts/
```

Verify: 13 woff2 files in `public/fonts/`.

- [ ] **Step 5:** Commit scaffold

```
feat(web-next): scaffold Next.js package in monorepo
```

---

### 1.2 — Design tokens + globals.css

**Status:** COMPLETE 2026-04-21

**Files:**
- Create/replace: `packages/web-next/app/globals.css`

Port from `reference/handoff/.../colors_and_type.css` with these changes:

- [ ] **Step 1:** Write `@font-face` declarations for all 13 fonts pointing to `/fonts/*.woff2`

- [ ] **Step 2:** Write `:root` palette block — lines 35-55 of source (ivory, cloud, slate, book-cloth). **Add new success token:**

```css
--color-success: #5E8F4A;
```

- [ ] **Step 3:** Write `html` block — lines 57-68 (kraft, faded-red, clay, moss, olive, sienna). **Add semantic status tokens:**

```css
/* Status semantics — from approved screen Pill tones */
--color-status-success-bg:     #EEF3E8;
--color-status-success-fg:     #4A7237;
--color-status-success-border: #CFE0C8;

--color-status-warning-bg:     #FBF6EC;
--color-status-warning-fg:     #8B6A3A;
--color-status-warning-border: #EFD9B8;

--color-status-error-bg:       #FBF0ED;
--color-status-error-fg:       #8C3F28;
--color-status-error-border:   #EBCAC3;

--color-status-accent-border:  #EBCFC0;
```

- [ ] **Step 4:** Write semantic surface/text/border/button variables — lines 129-175 of source

- [ ] **Step 5:** Write typography, spacing, radius, shadow, motion variables — lines 182-288

- [ ] **Step 6:** **SKIP legacy aliases** (lines 69-127) — dead weight for new app

- [ ] **Step 7:** Write dark mode block — lines 291-336

- [ ] **Step 8:** Write base element resets — lines 338-382 (html, body, h1-h5, p, a, code, small)

- [ ] **Step 9:** Write wash overrides — lines 388-404 (parchment, kraft, moss)

- [ ] **Step 10:** Write `.reader` prose class for brief content:

```css
.reader p { font-size: 15px; line-height: 1.7; font-weight: 300; color: var(--color-text-body); margin: 0 0 18px; }
.reader h3 { font-family: var(--font-family-display); font-size: 20px; font-weight: 400; letter-spacing: -0.01em; color: var(--color-text-heading); margin: 28px 0 10px; }
.reader blockquote { margin: 0 0 18px; padding: 10px 16px; border-left: 2px solid var(--color-book-cloth); background: var(--color-ivory-dark); font-size: 14px; color: var(--color-text-heading); }
.reader .callout { display: inline-flex; align-items: center; gap: 6px; padding: 1px 8px; background: var(--color-book-cloth-50); color: var(--color-book-cloth-dark); font-family: var(--font-family-monospace); font-size: 10.5px; letter-spacing: 0.06em; }
```

- [ ] **Step 11:** Add `@tailwind base; @tailwind components; @tailwind utilities;` and focus-visible rule:

```css
*:focus-visible { outline: 2px solid var(--color-book-cloth); outline-offset: 2px; }
```

- [ ] **Step 12:** Commit tokens

```
feat(web-next): port design tokens with semantic status colors
```

---

### 1.3 — Tailwind config

**Status:** COMPLETE 2026-04-21

**Files:**
- Modify: `packages/web-next/tailwind.config.ts`

- [ ] **Step 1:** Extend `theme.extend.colors` with all palette + semantic colors mapped to CSS custom properties. Include `success: 'var(--color-success)'` and all `status-*` tokens.

- [ ] **Step 2:** Extend `fontFamily` with `display`, `body`, `mono` mapped to `--font-family-*` vars.

- [ ] **Step 3:** Extend `boxShadow` with `container`, `container-active`, `dropdown`, `panel`, `sticky`.

- [ ] **Step 4:** Set `content` paths to include `./app/**/*.tsx` and `./components/**/*.tsx`.

- [ ] **Step 5:** Commit config

```
feat(web-next): tailwind config with design token extensions
```

---

### 1.4 — Root layout + redirect

**Status:** COMPLETE 2026-04-21

**Files:**
- Modify: `packages/web-next/app/layout.tsx`
- Modify: `packages/web-next/app/page.tsx`

- [ ] **Step 1:** Update `layout.tsx`: `<html lang="en" data-wash="parchment">`, metadata, body class `font-body text-[14px] leading-[22px] antialiased bg-[var(--color-bg-layout-main)]`

- [ ] **Step 2:** Update `page.tsx`: `import { redirect } from 'next/navigation'; redirect('/dashboard');`

- [ ] **Step 3:** Verify scaffold runs on port 3001:

```bash
cd packages/web-next && pnpm dev
```

Visit `http://localhost:3001` — should redirect to `/dashboard`. Verify ivory-medium background, fonts load in network tab.

- [ ] **Step 4:** Commit layout

```
feat(web-next): root layout with parchment wash + dashboard redirect
```

---

### 1.5 — Design system primitives

**Status:** COMPLETE 2026-04-21

**Files:**
- Create: all 11 files in `components/design-system/`

All components port from `_shell.jsx` inline styles to React + Tailwind. Reference the prototype source lines noted below; match the SCREEN SCREENSHOTS, not the code, for visual truth.

- [ ] **Step 1: Button** — Port `SBtn` from `_shell.jsx:233-259`. Variants: primary/normal/ghost/link/dark. Sizes: normal/small. Props: `variant`, `size`, `icon`, `iconRight`, `children`, `disabled`, `onClick`, `type`, `className`. Hard corners, 1px border, 120ms transitions. This is the ONLY button component.

- [ ] **Step 2: Card** — Port `SCard` from `_shell.jsx:201-231`. Props: `header`, `description`, `actions`, `children`, `padded`, `className`. Display font header 15px/400. Hard corners (`rounded-none`), 1px `border-cloud-light`.

- [ ] **Step 3: Container** — Adapted from `ui_kits/dashboard/Container.jsx` with corrections: `rounded-[2px]` (not 16px), `shadow-container`. Header uses `<h3>` via `font-display text-[18px]`. Props: `header`, `description`, `actions`, `children`, `padding`.

- [ ] **Step 4: PageHeader** — Port from `_shell.jsx:43-85`. Props: `breadcrumb: string[]`, `title?: string`, `subtitle?: string`, `actions?: ReactNode`. Breadcrumb: mono 10.5px, `/` separator, last item in heading color. Title: display 30px/400, `-0.02em` tracking. Subtitle: 13.5px/300. **Actions slot aligned right** via `flex justify-between`.

- [ ] **Step 5: Pill** — Port from `_shell.jsx:127-151`. 6 tones: neutral, accent, success, warning, error, ghost. 2 sizes: sm (11.5px), xs (10.5px). **Consume semantic tokens** for success/warning/error tones (e.g., `bg-[var(--color-status-success-bg)] text-[var(--color-status-success-fg)] border-[var(--color-status-success-border)]`). Neutral and ghost use existing palette tokens. Hard corners.

- [ ] **Step 6: Eyebrow** — `_shell.jsx:166-174`. `font-mono text-[10.5px] font-normal uppercase tracking-[0.08em]` in secondary color.

- [ ] **Step 7: MetaLine** — `_shell.jsx:154-158`. Mono key:value pair.

- [ ] **Step 8: Rule** — `_shell.jsx:161-163`. 1px `bg-cloud-light` divider.

- [ ] **Step 9: StatusDot** — From `01-dashboard.html:115-129`. Props: `status`. 6px square dot + label. Map: `processed` → `--color-success`, `needs-review` → book-cloth, `unlinked` → cloud-dark, `processing` → book-cloth.

- [ ] **Step 10: EmptyState** — `_shell.jsx:177-198`. Centered: 40x40 icon box (1px border), display title, description, optional action button.

- [ ] **Step 11: Input** — `_shell.jsx:262-275`. Optional lucide icon, 30px height, hard corners, Inter 13px/300, focus → `border-slate-medium`.

- [ ] **Step 12:** Commit primitives

```
feat(web-next): design system primitives — Button, Card, Container, PageHeader, Pill, Eyebrow, MetaLine, Rule, StatusDot, EmptyState, Input
```

---

### 1.6 — Navigation (TopNav + SideNav + Shell layout)

**Status:** COMPLETE 2026-04-21

**Files:**
- Create: `components/nav/top-nav.tsx`
- Create: `components/nav/side-nav.tsx`
- Create: `app/(shell)/layout.tsx`

- [ ] **Step 1: TopNav** — Port from `ui_kits/dashboard/TopNav.jsx`. Server component (no client state in M1). 56px height, `bg-[var(--color-bg-home-header)]`, sticky top, z-20.

Structure:
1. Brand: Brain SVG (inline, stroke `var(--color-book-cloth)`, strokeWidth 0.9) + "Open Brain" (display 17px, "Open" 400, "Brain" 300)
2. Search: flex-1, max-w-[560px], ghost input, `⌘K` badge
3. Utilities: Ask AI (accent), Bell (badge=3), Moon, HelpCircle — use local `UtilItem` sub-component
4. User: 24x24 square avatar (book-cloth bg, "TD"), email, chevron-down

All icons from `lucide-react`.

- [ ] **Step 2: SideNav** — Port from `ui_kits/dashboard/SideNav.jsx`. **Client component** (`'use client'` — uses `usePathname()`). 280px, white bg, sticky `top-[56px] h-[calc(100vh-56px)]`, overflow-y auto.

Structure:
1. Workspace: mono "WORKSPACE" eyebrow, "P" square + "Personal — Troy" + `ChevronsUpDown`
2. 5 sections with nav items as `<Link>`:
   - (no title): Dashboard `/dashboard`, Search `/search`, Timeline `/timeline`
   - CAPTURE: Ingest `/ingest`, Voice capture `/voice`, Email bridge `/email`
   - KNOWLEDGE: Entities `/entities`, Wiki `/wiki`, Briefs `/briefs`, Intelligence `/intelligence`
   - GOVERNANCE: Board `/board`, Financial `/financial`, Investments `/investments`
   - SYSTEM: System status `/system`, Settings `/settings`
3. Active state: `bg-[var(--color-bg-item-selected)]` + 2px left `border-book-cloth` + font-weight 500. Active detection: `pathname.startsWith(item.href)` (handles `/entities/123` matching `/entities`)
4. Counts: Timeline (842), Email bridge (12), Briefs (3). System status: green dot.

- [ ] **Step 3: Shell layout** — `app/(shell)/layout.tsx`. Renders `<TopNav />` sticky top, then flex row: `<SideNav />` + `<main className="flex-1 min-w-0 p-[22px_32px_48px]"><div className="max-w-[1280px] mx-auto">{children}</div></main>`.

- [ ] **Step 4: Catch-all stub** — `app/(shell)/[...slug]/page.tsx`. Maps route slug to milestone:

```typescript
const MILESTONE_MAP: Record<string, string> = {
  'timeline': 'Milestone 2',
  'ingest': 'Milestone 2',
  'voice': 'Milestone 2',
  'email': 'Milestone 2',
  'wiki': 'Milestone 3',
  'intelligence': 'Milestone 3',
  'board': 'Milestone 3',
  'financial': 'Milestone 3',
  'investments': 'Milestone 3',
  'system': 'Milestone 3',
  'settings': 'Milestone 3',
};
```

Renders PageHeader with breadcrumb + EmptyState: "Coming in {milestone}. This surface is designed but not yet built."

- [ ] **Step 5: 404 page** — `app/not-found.tsx`. EmptyState in editorial voice: title "Nothing here", description "The page you're looking for doesn't exist. Maybe it never did."

- [ ] **Step 6:** Verify nav renders at `http://localhost:3001/dashboard` — dark top bar, white side nav, correct sections, active state on Dashboard.

- [ ] **Step 7:** Commit nav

```
feat(web-next): TopNav + SideNav + shell layout with catch-all stubs
```

---

### 1.7 — Types + mock data

**Status:** COMPLETE 2026-04-21

**Files:**
- Create: `packages/web-next/lib/types.ts`
- Create: `packages/web-next/lib/mock-data.ts`

- [ ] **Step 1:** Define TypeScript interfaces in `lib/types.ts`. UI display types (not DB types — those live in `@open-brain/shared`). Capture, Entity, Brief, OpenQuestion, UpcomingBrief, EntityDetail, Commitment, CaptureItem, RelatedEntity, BriefDetail, TocItem, BriefSource. Export all.

- [ ] **Step 2:** Create `lib/mock-data.ts` with typed constants extracted from the 5 screen HTML files:
- `RECENTS`: 6 captures (`01-dashboard.html:94-113`)
- `OPEN_QUESTIONS`: 4 items (`01-dashboard.html:168-173`)
- `UPCOMING_BRIEFS`: 3 items (`01-dashboard.html:211-215`)
- `ENTITIES`: 12 entities (`05-entities.html:35-48`)
- `TYPE_COUNTS`: `{ all: 12, person: 4, project: 3, topic: 3, org: 1, decision: 1 }`
- `BRIEFS`: 6 briefs (`07-briefs.html:26-33`)
- `SARAH_CHEN`: entity detail (`06-entity-detail.html`)
- `TUESDAY_BRIEF`: brief detail content, TOC, sources (`08-brief-detail.html`)

- [ ] **Step 3:** Commit types + data

```
feat(web-next): typed mock data fixtures for all M1 screens
```

---

## Phase 2: Dashboard (Screen 01)

### 2.1 — Dashboard components + page

**Status:** COMPLETE 2026-04-21

**Files:**
- Create: `components/dashboard/stat-strip.tsx`
- Create: `components/dashboard/quick-capture.tsx`
- Create: `components/dashboard/recent-captures.tsx`
- Create: `components/dashboard/open-questions.tsx`
- Create: `components/dashboard/upcoming-briefs.tsx`
- Create: `app/(shell)/dashboard/page.tsx`

- [ ] **Step 1: StatStrip** — Port `01-dashboard.html:32-87`. Horizontal flex, white bg, 1px border. 5 blocks separated by 1px right border. Each: mono eyebrow, display number (34px/300), delta arrow (`text-[var(--color-success)]` or `text-faded-red`), meta text. Pipeline: 8x8 green square + "Healthy" + mono "3 active · 12 queued".

- [ ] **Step 2: QuickCapture** — `'use client'`. Port `01-dashboard.html:241-287`. Inside Container. 4-button segmented control (Note active → dark bg). Textarea. Footer: mono shortcut hint + primary Button "Capture".

- [ ] **Step 3: RecentCaptures** — `'use client'`. Port `01-dashboard.html:131-165`. Inside Container with header "Recent activity (6)", actions: Filter button + "View all →" link. Each row: 3-col grid (icon | content with Pill tags | meta with StatusDot). Selected row: `bg-book-cloth-50` + 2px left terracotta. Hover: `bg-ivory-dark`.

- [ ] **Step 4: OpenQuestions** — Port `01-dashboard.html:175-208`. Inside Container with "Board →" link action. Each row: 4px priority rail + question + mono metadata.

- [ ] **Step 5: UpcomingBriefs** — Port `01-dashboard.html:217-238`. Inside Container with "All briefs →" link action. Each row: title + due, 2px progress bar, mono stats.

- [ ] **Step 6: Dashboard page** — `app/(shell)/dashboard/page.tsx`:
- PageHeader: breadcrumb `["Open Brain", "Dashboard"]`, title "Good morning, Troy", subtitle "Tuesday, April 21 · 47 captures this week · 3 open briefs", actions: Refresh + Export + New brief (primary)
- `<StatStrip />`
- 2-col grid (`grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]` gap-5): left (QuickCapture + RecentCaptures), right (OpenQuestions + UpcomingBriefs)

- [ ] **Step 7:** Verify against `_check-dashboard.jpg`

- [ ] **Step 8:** Commit

```
feat(web-next/dashboard): match screen 01 — stats, captures, questions, briefs
```

---

## Phase 3: Entities (Screens 05 + 06)

### 3.1 — Entities list page

**Status:** COMPLETE 2026-04-21

**Files:**
- Create: `components/entities/type-filter-tabs.tsx`
- Create: `components/entities/entity-table.tsx`
- Create: `components/entities/distribution-card.tsx`
- Create: `components/entities/needs-attention.tsx`
- Create: `app/(shell)/entities/page.tsx`

- [ ] **Step 1: TypeFilterTabs** — `'use client'`. Reusable. Props: `items: {id: string, label: string, count?: number}[]`, `active: string`, `onChange: (id: string) => void`. Tab bar with 2px terracotta underline on active. Port from `05-entities.html:77-94`.

- [ ] **Step 2: EntityTable** — Port `05-entities.html:98-134`. Inside Card (padded=false). Toolbar: Input + sort indicator. Header row: mono 10px columns. Data rows as `<Link>` to `/entities/[id]`. Hover bg. TypeChip sub-component (mono 10px terracotta).

- [ ] **Step 3: DistributionCard** — Card "Distribution". 5 rows: label + mono count + 3px bar.

- [ ] **Step 4: NeedsAttention** — Card "Needs attention" + "Low-confidence extractions". 3 rows with hover.

- [ ] **Step 5: Entities page** — `'use client'` (lifts filter state). PageHeader + TypeFilterTabs + 2-col grid (`grid-cols-[1fr_280px]`): EntityTable | sidebar (DistributionCard + NeedsAttention).

- [ ] **Step 6:** Commit

```
feat(web-next/entities): match screen 05 — type tabs, table, distribution
```

---

### 3.2 — Entity detail page

**Status:** COMPLETE 2026-04-21

**Files:**
- Create: all 8 files in `components/entity/`
- Create: `app/(shell)/entities/[id]/page.tsx`

- [ ] **Step 1: EntityHeader** — Port `06-entity-detail.html:92-126`. 3-col grid: 88px monogram square (book-cloth bg, display initials 36px/300) | content (Eyebrow, h1 38px/300, summary, 5 stats row) | actions column (4 stacked Buttons).

- [ ] **Step 2: EntityTabs** — Reuse TypeFilterTabs with items: Summary, Timeline, Captures(14), Relationships(11), Commitments(3). Static — always shows Summary.

- [ ] **Step 3: AISummary** — `bg-book-cloth-50`, 3px left `border-book-cloth`. Sparkles icon + mono update timestamp. Display 19px/300 paragraph. Two buttons.

- [ ] **Step 4: CommitmentsCard** — Card "Active commitments". 4-col grid rows. Overdue in `text-faded-red`.

- [ ] **Step 5: CaptureItem** — Source eyebrow + time, title, snippet. 1px dividers.

- [ ] **Step 6: RelationshipGraph** — SVG `viewBox="0 0 320 220"`. Concentric dashed rings. Connection lines. Node circles (4px, slate-medium) with text labels. Center: 14px circle, book-cloth, mono initials. Direct port of trig code from `06-entity-detail.html:36-71`.

- [ ] **Step 7: MentionsChart** — Flex row of ~36 bars. Recent bars book-cloth, older cloud-dark. Mono axis labels.

- [ ] **Step 8: RelatedEntities** — Card list: type eyebrow (mono 9.5px) + name (13px) | shared count (mono). Hover bg.

- [ ] **Step 9: Entity detail page** — PageHeader breadcrumb `["Open Brain", "Entities", "Sarah Chen"]` (no title — header card IS the title). EntityHeader → EntityTabs → 2-col grid (`grid-cols-[minmax(0,1fr)_320px]`): left (AISummary + CommitmentsCard + captures Card) | right (RelationshipGraph + MentionsChart + RelatedEntities). All renders use Sarah Chen fixture; `[id]` param accepted for M2 wiring.

- [ ] **Step 10:** Verify against `_check-entity.jpg`

- [ ] **Step 11:** Commit

```
feat(web-next/entity-detail): match screen 06 — header, summary, graph, commitments
```

---

## Phase 4: Briefs (Screens 07 + 08)

### 4.1 — Briefs list page

**Status:** COMPLETE 2026-04-21

**Files:**
- Create: `components/briefs/brief-hero.tsx`
- Create: `components/briefs/brief-card.tsx`
- Create: `components/briefs/brief-library.tsx`
- Create: `app/(shell)/briefs/page.tsx`

- [ ] **Step 1: BriefHero** — Port `07-briefs.html:61-93`. `bg-book-cloth-50`, 1px border `var(--color-status-accent-border)`, 3px left `border-book-cloth`. 2-col grid: left (eyebrow, h2 display 34px/300, paragraph, 3 buttons) | right ("IN THIS BRIEF" list with terracotta `→` arrows).

- [ ] **Step 2: BriefCard** — Port `07-briefs.html:128-160`. 2-col grid: 64px rail (colored bg + icon + faded glyph 36px/0.35 opacity) | content (kind eyebrow + unread dot, display title 17px/400, subtitle, footer). 5 cover schemes. Hover darkens border.

- [ ] **Step 3: BriefLibrary** — `'use client'`. Filter segmented buttons + grid/list toggle. Grid: 3 columns of BriefCard. List: Card with table rows. Port from `07-briefs.html:96-190`.

- [ ] **Step 4: Briefs page** — PageHeader + BriefHero + BriefLibrary.

- [ ] **Step 5:** Verify against `_check-briefs-parchment.jpg`

- [ ] **Step 6:** Commit

```
feat(web-next/briefs): match screen 07 — hero, library grid/list, filter tabs
```

---

### 4.2 — Brief reader page

**Status:** COMPLETE 2026-04-21

**Files:**
- Create: `components/briefs/brief-reader.tsx`
- Create: `components/briefs/brief-toc.tsx`
- Create: `components/briefs/brief-sources.tsx`
- Create: `app/(shell)/briefs/[id]/page.tsx`

- [ ] **Step 1: BriefToc** — Sticky left (220px, top ~78px). "ON THIS PAGE" eyebrow + section links (active: 2px terracotta left border). Rule. "ACTIONS" eyebrow + 3 Buttons.

- [ ] **Step 2: BriefReader** — Center column (max-w-[720px]). Kind eyebrow → title (display 42px/300) → subtitle row with `·` separators → article body using `.reader` class. Full article content from mock data.

- [ ] **Step 3: BriefSources** — Sticky right (280px). "Grounded in" Card (source list + "Show all 18 →"). "REFINE THIS BRIEF" box (ivory-dark bg, text buttons with `→` prefix).

- [ ] **Step 4: Brief reader page** — PageHeader breadcrumb only (no title). 3-col grid: `grid-cols-[220px_minmax(0,720px)_280px]`, gap 32px. BriefToc | BriefReader | BriefSources.

- [ ] **Step 5:** Commit

```
feat(web-next/brief-reader): match screen 08 — 3-col reader with TOC and sources
```

---

## Phase 5: Verification Gate

### 5.1 — Build + search stub

**Status:** COMPLETE 2026-04-21

- [ ] **Step 1:** Create `app/(shell)/search/page.tsx` — PageHeader breadcrumb `["Open Brain", "Search"]` + EmptyState: icon="search", title="Search", description="Full-text and semantic search. Coming in Milestone 4."

- [ ] **Step 2:** Run build:

```bash
cd packages/web-next && pnpm build
```

Fix any TypeScript errors. All routes must compile.

- [ ] **Step 3:** Commit

```
feat(web-next): search stub + passing build
```

---

### 5.2 — Screenshot verification ✅ Completed 2026-04-21

**Status:** COMPLETE 2026-04-21

- [x] **Step 1:** Start dev server (`pnpm dev` in `packages/web-next`)

- [x] **Step 2:** Screenshot all 6 routes via Chrome browser automation:
1. `/dashboard` — compare against `_check-dashboard.jpg`
2. `/entities` — verify type tabs, table, distribution sidebar
3. `/entities/sarah-chen` — compare against `_check-entity.jpg`
4. `/briefs` — compare against `_check-briefs-parchment.jpg`
5. `/briefs/tuesday` — verify 3-col reader layout
6. `/search` — verify empty state stub

- [x] **Step 3:** Fix visual discrepancies found in screenshots

- [x] **Step 4:** Present all 6 screenshots to user for sign-off

- [x] **Step 5:** Final commit

```
fix(web-next): visual parity adjustments from screenshot review
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Font rendering diffs (manual @font-face vs next/font) | Verify in screenshots; can switch if needed |
| SVG relationship graph mismatch | Direct trig code port from prototype |
| Color drift from screenshots | Screenshot gate is the acceptance bar |
| Tailwind arbitrary values clutter | Group by component; document common patterns |
| pnpm workspace conflict with Next.js | Next.js in `packages/` works with pnpm — proven pattern |

## Scope Boundaries

**Covers:** Screens 01, 05, 06, 07, 08 + search stub + catch-all stubs + 404. All with mock data.

**Does NOT cover:** Dark mode wiring, responsive/mobile, API connections, search functionality, database, server actions, React Query, screens 02a/02b/03/04/09/10/11/12/13.

**Next:** Milestone 2 (capture in: Ingest, Capture detail, Timeline, adapters, entity extraction).
