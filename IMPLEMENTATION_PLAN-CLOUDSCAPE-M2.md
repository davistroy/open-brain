# Implementation Plan — Cloudscape Web-Next M2

**Generated:** 2026-04-21
**Based On:** IMPLEMENTATION_PLAN-CLOUDSCAPE-M1.md (completed), LAB_NOTEBOOK Entry 127, Phase 1 investigation findings (CS1/CS2/CS3/CS4), decisions D106–D115
**Total Phases:** 8
**Estimated Total Effort:** ~6,500 LOC across ~70 files

---

## Executive Summary

M2 wires the 5 Cloudscape-designed screens shipped in M1 (`/dashboard`, `/entities`, `/entities/:id`, `/briefs`, `/briefs/:id`) to real backend endpoints, while building the first-class `briefs` domain model, 3 new entity detail endpoints, and the frontend data-fetching infrastructure that every future screen will depend on. Architectural posture: **`packages/web-next/` is a pure presentation layer**; `packages/core-api/` remains the only API tier; no BFF, no Server Actions, no per-screen fetch hacks.

The plan resolves the shape mismatch between M1 mocks (display-formatted) and the real API (semantic) by locating **all presentation formatting in `lib/format.ts`**, leaving the API to return raw data. A first-class `briefs` table (migration 0030) replaces the skills_log wrap that was tempting-but-costly long-term; 4 brief-producing skills extend to write structured output (body_html, TOC, sources, refine_options) via a shared `unified`-stack renderer. Brief refinement is **async via SSE arrival** (Option 2: generic LLM HTML transform, ~3s) — not blocking. Commitments, the entity-brief skill, TTS, and 13 other `/web` surfaces are explicitly **deferred to M3** with stubs + backlog document.

The 8 phases are ordered to surface infrastructure before consumers: CS1 (frontend infra, Phases 1–3) lands before any screen wiring; CS2 (briefs backend, Phases 4–6) before CS4's brief screens; CS3 (entity endpoints, Phase 7) before CS4's entity detail. CS3 and late CS2 can run in parallel since they touch disjoint paths. Several load-bearing architectural decisions (local-redeclaration vs `@open-brain/shared` import, `unstable_retry` rename, X-Open-Brain-Caller header placement, `outputFileTracingRoot`) are captured as sharp-edge notes on their respective work items.

---

## Plan Overview

**Critical path:** Phase 1 → 2 → 3 (frontend infra) → Phase 4 → 5 → 6 (briefs backend) → Phase 7 (entity endpoints + first 2 screens) → Phase 8 (remaining screens + M3 handoff). Phases 6 and 7 can partially overlap because CS3 touches only `packages/core-api/src/routes/entities.ts` and CS2 skill extensions touch only `packages/workers/src/skills/`.

**Phasing rationale:** The phases mirror the approved 5-change-set grouping but consolidate CS1 into 3 phases (foundation / client / realtime) and expand CS2 into 3 phases (schema / rendering+routes / skills+refine) to fit the skill's 6-item-per-phase limit. CS3 pairs with the first 2 CS4 screens so the first screen wiring validates the api-client + Query + SSE stack end-to-end before the more complex Entity Detail page. M3 handoff lives in Phase 8 so the final commit ships a complete M3_BACKLOG alongside the last working screen.

**Integrated-change grouping:** Three decisions bundle multiple findings into single work items —
- `BaseSkill.logResult()` signature change (D112) touches ~25 subclasses; bundled into a single work item in Phase 4 to prevent partial-state commits.
- `unified`-stack brief renderer + TOC extraction + source mapping (CS2 renderer) share a single pipeline pass; bundled in Phase 5 so the AST walk isn't implemented twice.
- Ask AI modal + Merge modal + sonner toasts + Radix Dialog dep (CS4 modal UX) share the same infrastructure; bundled into the Entity Detail work item in Phase 8.

### Phase Summary Table

| Phase | Focus Area | Key Deliverables | Est. Complexity | Dependencies | Execution Mode |
|-------|------------|------------------|-----------------|--------------|----------------|
| 1 | CS1 Foundation | Deps, next.config rewrites+standalone, formatters, test scaffolding, drift-guard, ESLint guard | M (~8 files, ~400 LOC) | None | Sequential |
| 2 | CS1 Client Layer | api-client, Query provider, error.tsx, loading.tsx, 4xx/5xx split | M (~10 files, ~500 LOC) | Phase 1 | Sequential |
| 3 | CS1 Realtime + E2E | SSE client+reconnect, SSE provider, invalidation map, Playwright smoke | M (~6 files, ~400 LOC) | Phase 2 | Sequential |
| 4 | CS2 Schema + BaseSkill | Migration 0030, Drizzle schema, types/constants, BaseSkill signature, subclass audit, MEETING type | L (~12 files, ~700 LOC) | Phase 3 | Sequential |
| 5 | CS2 Rendering + Routes + SSE | unified renderer, TOC+source mapping, BriefsService, 5 routes, brief_created SSE | L (~10 files, ~900 LOC) | Phase 4 | Sequential |
| 6 | CS2 Skills + Refine + Backfill | Extend 4 skills, refine-brief skill, backfill script | L (~8 files, ~800 LOC) | Phase 5 | Sequential |
| 7 | CS3 Entity Endpoints + CS4 Dashboard/Entities | 3 new endpoints, rate-limit ordering, Dashboard wiring, Entities list wiring | L (~12 files, ~1100 LOC) | Phase 6 | Sequential |
| 8 | CS4 Entity Detail + Briefs + M3 Handoff | Entity detail + modals, Briefs library, Brief reader, M3_BACKLOG.md | L (~14 files, ~1200 LOC) | Phase 7 | Sequential |

<!-- BEGIN PHASES -->

---

## Phase 1: CS1 Foundation (deps, config, formatters, test scaffolding, guards)

**Estimated Complexity:** M (~8 files, ~400 LOC)
**Dependencies:** None
**Parallelizable:** No (sets baseline for all subsequent phases)

### Goals

- Establish all runtime + test dependencies for web-next before any wiring code is written
- Lock down configuration traps (`outputFileTracingRoot` for pnpm standalone, rewrites for API proxy) that silently break later if missed
- Set up presentation-layer formatters so API shape and UI shape are decoupled from day 1
- Add guard rails that prevent the two biggest tech-debt traps: `@open-brain/shared` runtime import + type drift between shared canonical types and web-next UI types

### Work Items

#### 1.1 Add web-next dependencies
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 decisions D108/D109/D113/D115
**Files Affected:**
- `packages/web-next/package.json` (modify)
- `pnpm-lock.yaml` (modify)

**Description:**
Add all runtime + dev dependencies M2 requires. Intentionally NOT adding `@open-brain/shared` — web-next redeclares types locally per D109 to avoid dragging `pg`/`openai`/`@anthropic-ai/sdk`/`drizzle-orm` into the Next.js server bundle.

**Tasks:**
1. [ ] Add runtime deps: `@tanstack/react-query@^5.90`, `@radix-ui/react-dialog@^1`, `sonner@^1`
2. [ ] Add dev deps: `vitest@^1.6`, `@vitest/coverage-v8`, `jsdom@^24`, `@testing-library/react@^16`, `@testing-library/jest-dom@^6`, `@testing-library/user-event@^14`, `msw@^2`, `@playwright/test@^1.45`
3. [ ] Run `pnpm install` from repo root; verify lockfile updates cleanly
4. [ ] Run `NODE_OPTIONS="--max-old-space-size=4096" pnpm --filter @open-brain/web-next build` — must still pass with new deps installed

**Acceptance Criteria:**
- [ ] `pnpm-lock.yaml` committed with change
- [ ] `pnpm --filter @open-brain/web-next build` exits 0
- [ ] `pnpm --filter @open-brain/web-next install --frozen-lockfile` succeeds in CI

**Notes:**
Bundle size impact: Query (~13KB gz), Radix Dialog (~6.5KB gz), sonner (~4KB gz). Test deps don't ship in production bundle. Do NOT add `@open-brain/shared` — drift-guard test (1.5) enforces type parity without the import.

---

#### 1.2 Configure next.config.ts for M2
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 D115, sharp-edges: API rewrite + standalone + tracing root
**Files Affected:**
- `packages/web-next/next.config.ts` (modify)
- `packages/web-next/.env.local.example` (create)

**Description:**
Three additive config changes, each with a known trap. Rewrites make `/api/:path*` same-origin in both dev and prod. Standalone output enables future Docker packaging in M3+. Output file tracing root is **mandatory** for pnpm monorepos — standalone silently misses workspace deps without it.

**Tasks:**
1. [ ] Add `async rewrites()` returning `[{ source: '/api/:path*', destination: \`${process.env.API_URL}/api/:path*\` }]`
2. [ ] Add `output: 'standalone'`
3. [ ] Add `outputFileTracingRoot: path.join(__dirname, '../../')` — path import from 'node:path'
4. [ ] Create `.env.local.example` with `API_URL=http://localhost:3002` (dev core-api port per MEMORY)
5. [ ] Add comment-doc block at top of config file referencing D115 and the `X-Open-Brain-Caller` header placement rule (rewrites are URL-only; header goes in api-client wrapper — PR-2)

**Acceptance Criteria:**
- [ ] Build generates `.next/standalone/` directory
- [ ] `.next/standalone/` contains `server.js` plus workspace-traced deps
- [ ] `next dev --port 3001` starts successfully with `API_URL` env set
- [ ] `curl http://localhost:3001/api/v1/health` returns valid response when core-api is running on `http://localhost:3002`

**Notes:**
Do NOT add `transpilePackages: ['@open-brain/shared']` — we are NOT importing that package per D109. If a future PR accidentally adds it, ESLint rule (1.5) catches the import. `X-Open-Brain-Caller: web-ui` is set by the api-client request wrapper (Phase 2), not by rewrites — rewrites are URL-only.

---

#### 1.3 Create lib/format.ts with pure formatters
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 investigation item 1.7
**Files Affected:**
- `packages/web-next/lib/format.ts` (create)
- `packages/web-next/lib/__tests__/format.test.ts` (create)

**Description:**
Six pure presentation-layer formatters. No dependencies beyond `Intl` (built-in). This is the single boundary where API semantic data (numbers, ISO strings) becomes display strings ("▲ 12%", "Apr 18"). The custom relative-time compacter is needed because `Intl.RelativeTimeFormat` outputs "14 minutes ago" — we want "14m ago".

**Tasks:**
1. [ ] `formatRelativeDate(iso: string): string` — "Apr 18" / "Yesterday" / "3d ago" / "14m ago"
2. [ ] `formatDelta(previous: number, current: number): { sign: '▲'|'▼'|'◆'; arrow: string; text: string }` (returns object so UI colors independently)
3. [ ] `formatCount(n: number): string` — "1.2k" / "217"
4. [ ] `formatCurrency(n: number): string` — "$4.82" / "$12.4K" (compact ≥ 10K)
5. [ ] `formatDuration(ms: number): string` — "4 min" / "30s"
6. [ ] `truncate(str: string, n: number): string`
7. [ ] Unit tests for each — 5+ cases per function including edge cases (negative, zero, very large)

**Acceptance Criteria:**
- [ ] `pnpm --filter @open-brain/web-next exec vitest run lib/__tests__/format.test.ts` — all tests pass
- [ ] Every function is pure (no side effects, no external state)
- [ ] Test coverage of lib/format.ts ≥ 95%

**Notes:**
Design glyphs (▲ U+25B2 / ▼ U+25BC / ◆ U+25C6) come directly from the M1 mock data; don't substitute. Test fixtures should be locale-independent — set `TZ=UTC` in test setup if time-dependent.

---

#### 1.4 Vitest + MSW + Playwright scaffolding
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 investigation item 1.8
**Files Affected:**
- `packages/web-next/vitest.config.ts` (create)
- `packages/web-next/test/setup.ts` (create)
- `packages/web-next/test/msw-handlers.ts` (create)
- `packages/web-next/test/msw-server.ts` (create)
- `packages/web-next/playwright.config.ts` (create)
- `packages/web-next/package.json` (modify — add scripts)

**Description:**
Three test infrastructures scaffold-only (first real tests land in later phases). Vitest config mirrors `packages/web/vitest.config.ts` but **with `pool: 'forks'` + `minForks: 1` + `maxForks: 4` + `hookTimeout/testTimeout: 30_000`** per the CLAUDE.md Windows ioredis/bullmq stability rule. MSW v2 syntax (`http.get(...)` not v1's `rest.get(...)`). Playwright config uses `webServer` to auto-start dev server.

**Tasks:**
1. [ ] `vitest.config.ts` — jsdom environment, @vitejs/plugin-react, setupFiles: ['./test/setup.ts'], fork pool config
2. [ ] `test/setup.ts` — imports `@testing-library/jest-dom/vitest`, sets up MSW `beforeAll(() => server.listen({onUnhandledRequest:'error'}))` + resetHandlers + close
3. [ ] `test/msw-handlers.ts` — starter handler set for endpoints web-next will call (use mock-data.ts fixtures as response shapes)
4. [ ] `test/msw-server.ts` — `setupServer(...handlers)`
5. [ ] `playwright.config.ts` — webServer: { command: 'pnpm dev', port: 3001, reuseExistingServer: !CI }, baseURL: 'http://localhost:3001'
6. [ ] Add npm scripts: `test` (vitest), `test:e2e` (playwright), `test:coverage`

**Acceptance Criteria:**
- [ ] `pnpm --filter @open-brain/web-next test` runs Vitest and exits 0 (no tests yet, but config loads)
- [ ] `pnpm --filter @open-brain/web-next exec tsc --noEmit` clean
- [ ] No test files in `src/` tree (Playwright tests in `tests/`, Vitest tests co-located in `__tests__/`)

**Notes:**
MSW `onUnhandledRequest: 'error'` is intentional — catches accidentally-unmocked endpoints during integration tests. Playwright doesn't use MSW; it hits a real dev server against a real core-api. That's why Playwright runs as a separate command, not in the default `test` script.

---

#### 1.5 Extend web-type-drift test to cover web-next
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 D109, investigation item 1.8
**Files Affected:**
- `packages/shared/src/__tests__/web-type-drift.test.ts` (modify)

**Description:**
Because web-next redeclares canonical types locally (D109) to avoid the shared-package runtime import trap, we MUST have an automated guard that catches drift. Existing test validates `packages/web/` union literals against the canonical enums (CaptureSource, CaptureType, PipelineStatus, etc.) — extend to also validate `packages/web-next/lib/types.ts`.

**Tasks:**
1. [ ] Refactor the existing test helper to accept `{path, label}[]` array, iterate over both web and web-next files
2. [ ] Add `WEB_NEXT_TYPES_PATH = resolve(__dirname, '../../../web-next/lib/types.ts')`
3. [ ] Verify the 7 canonical enum sets match in both packages: CaptureSource, CaptureType, PipelineStatus, PipelineEventStage, PipelineEventStatus, SessionType, SessionStatus
4. [ ] Add explicit failure message pointing to D109 + this test as the drift source of truth

**Acceptance Criteria:**
- [ ] Test passes with current web-next types (no drift today)
- [ ] Artificially introducing drift (e.g., removing a CaptureSource value from web-next) causes test failure with clear error message
- [ ] Test runs in standard `pnpm test` CI path

**Notes:**
When web-next adds a NEW type (e.g., `BriefKind`, `BriefCover` in Phase 4) that also exists canonically in shared, extend this test to cover those too. That extension happens in Phase 4, not here.

---

#### 1.6 ESLint rule blocking @open-brain/shared in web-next
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** A79, D109 defense-in-depth
**Files Affected:**
- `packages/web-next/.eslintrc.cjs` or `eslint.config.mjs` (create or modify)

**Description:**
Belt-and-braces companion to the drift-guard test. Even with the drift-guard catching type drift, a casual developer could still `import type { X } from '@open-brain/shared'` and trigger the runtime-dep-drag regression in an unguarded way. An ESLint rule rejects the import at authoring time with a clear explanation pointing to D109.

**Tasks:**
1. [ ] Add `no-restricted-imports` rule in web-next ESLint config
2. [ ] Restrict patterns: `@open-brain/shared` and `@open-brain/shared/*`
3. [ ] Error message: "web-next redeclares types locally (D109). Importing @open-brain/shared drags pg/openai/drizzle-orm into the Next.js bundle. Use lib/types.ts instead — drift-guard enforces parity."
4. [ ] Verify rule fires: write a temporary `import type { CaptureType } from '@open-brain/shared'` in a scratch file, confirm lint error, delete scratch file

**Acceptance Criteria:**
- [ ] `pnpm --filter @open-brain/web-next lint` enforces the rule
- [ ] Error message guides developer to the correct solution
- [ ] Rule does not affect other packages (web-next-scoped)

**Notes:**
If the project migrates to a `@open-brain/shared/types` pure-types subpath export in a future phase, this rule would need relaxation. Document that trade-off in the M3 backlog.

---

### Phase 1 Testing Requirements

- [ ] `pnpm --filter @open-brain/web-next exec vitest run` exits 0 (empty suite + format.test.ts)
- [ ] `pnpm --filter @open-brain/web-next build` exits 0 with `.next/standalone/` present
- [ ] `pnpm --filter @open-brain/web-next lint` passes with new ESLint rule loaded
- [ ] `pnpm --filter @open-brain/shared exec vitest run web-type-drift.test.ts` passes with web-next types included
- [ ] `NODE_OPTIONS="--max-old-space-size=4096"` prefix documented in package.json or README for local contributors

### Phase 1 Completion Checklist

- [ ] All 6 work items COMPLETE
- [ ] LAB_NOTEBOOK entry written covering Phase 1 scope and any surprises
- [ ] No regressions in existing web package (`pnpm --filter @open-brain/web build` still passes)
- [ ] `pnpm-lock.yaml` committed
- [ ] Commit SHA recorded as last_good_sha in state

---

## Phase 2: CS1 Client Layer (api-client, Query provider, error/loading)

**Estimated Complexity:** M (~10 files, ~500 LOC)
**Dependencies:** Phase 1
**Parallelizable:** No

### Goals

- Build the typed API client that every screen in CS4 will consume
- Wire TanStack Query v5 into the Next.js 16 App Router with the RSC-compatible singleton pattern
- Establish error/loading conventions per route segment using Next.js 16's renamed `unstable_retry` prop
- Split 4xx vs 5xx error handling so component-local errors stay in-component and crashes surface to error.tsx

### Work Items

#### 2.1 Create lib/api-client.ts with HttpError + namespaced helpers
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 investigation item 1.4
**Files Affected:**
- `packages/web-next/lib/api-client.ts` (create)
- `packages/web-next/lib/__tests__/api-client.test.ts` (create)

**Description:**
Typed API client modeled on `packages/web/src/lib/api.ts` but evolved. Uses namespaced function objects (`capturesApi.list(...)`) rather than a class — matches existing code style, tree-shakes cleanly, no `this` binding pitfalls. Core wrapper sets `X-Open-Brain-Caller: web-ui` header on every request (CLAUDE.md silent-429 prevention), throws typed `HttpError` for discrimination in error.tsx.

**Tasks:**
1. [ ] `HttpError` class extending `Error` with `status: number`, `body?: unknown`, `path: string` properties
2. [ ] `request<T>(path: string, init?: RequestInit): Promise<T>` — prefixes `/api/v1`, sets `X-Open-Brain-Caller: 'web-ui'`, sets `Content-Type: application/json` on body requests, throws `HttpError` on non-2xx
3. [ ] `buildQueryString(params: Record<string, unknown>): string` — URL-encoded, skips undefined, handles arrays
4. [ ] Namespace objects covering M2 scope: `capturesApi`, `entitiesApi`, `briefsApi`, `statsApi`, `searchApi`, `synthesizeApi`, `intelligenceApi`
5. [ ] Each namespace exports typed methods with parameter objects (e.g., `capturesApi.list({ limit, offset, brain_view })`)
6. [ ] MSW-backed tests — verify header is set, error thrown for 4xx and 5xx, query string built correctly

**Acceptance Criteria:**
- [ ] `api-client.test.ts` tests pass (>= 10 cases)
- [ ] `HttpError` instances carry `status`, `body`, `path`
- [ ] Every `request()` call includes `X-Open-Brain-Caller: web-ui` (asserted in tests)
- [ ] TypeScript strict: all return types explicit, no `any`

**Notes:**
Do NOT implement retry in this layer — TanStack Query v5 handles retry via its `retry` option (default 3x). Do NOT implement response shape normalization yet (RawEntity→Entity mapping); handle that in each screen's RSC page since shape varies per endpoint.

---

#### 2.2 TanStack Query provider with singleton pattern
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 D108, investigation item 1.2
**Files Affected:**
- `packages/web-next/app/providers.tsx` (create)
- `packages/web-next/lib/query-client.ts` (create)
- `packages/web-next/app/layout.tsx` (modify)

**Description:**
Wire TanStack Query v5 into the app shell using the canonical `getQueryClient()` singleton pattern from the v5 docs. `isServer` branch returns a fresh QueryClient (no cross-request pollution); browser branch returns a cached singleton (survives React Suspense retries). `staleTime: 60_000` default to prevent immediate refetch post-hydration. Do NOT use `useState` to initialize the QC (React docs explicitly warn).

**Tasks:**
1. [ ] `lib/query-client.ts` — exports `makeQueryClient()` (fresh instance) and `getQueryClient()` (singleton with isServer branch)
2. [ ] `app/providers.tsx` ('use client') — wraps children in `QueryClientProvider` using `getQueryClient()`
3. [ ] `app/layout.tsx` — import and wrap `{children}` in `<Providers>`
4. [ ] Set `queryClient.defaults.queries.throwOnError: (err) => err instanceof HttpError && err.status >= 500` — 5xx trips error.tsx, 4xx stays in-component
5. [ ] Set `queryClient.defaults.queries.staleTime: 60_000` and `retry: 2`

**Acceptance Criteria:**
- [ ] `pnpm --filter @open-brain/web-next build` passes with providers wired
- [ ] Manual dev test: `useQuery(['test'], () => Promise.resolve('ok'))` inside a client component renders without errors
- [ ] No console warnings about React 19 + Query v5 compatibility

**Notes:**
RSC pages that want SSR-prefetch data will use `const qc = new QueryClient(); await qc.prefetchQuery(...)` and wrap children in `<HydrationBoundary state={dehydrate(qc)}>` — that pattern lands per-screen in Phases 7/8 as screens are converted, not here. Phase 2 only wires the client-side provider.

---

#### 2.3 error.tsx at global + shell + per-segment levels
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 investigation item 1.6, sharp-edge: `unstable_retry` rename
**Files Affected:**
- `packages/web-next/app/error.tsx` (create)
- `packages/web-next/app/(shell)/error.tsx` (create)
- Per-route: `app/(shell)/dashboard/error.tsx`, `app/(shell)/entities/error.tsx`, `app/(shell)/entities/[id]/error.tsx`, `app/(shell)/briefs/error.tsx`, `app/(shell)/briefs/[id]/error.tsx` (create each)

**Description:**
Next.js 16 renamed the error-reset prop from `reset` → **`unstable_retry`**. Copy-paste from Next 14/15 tutorials will fail TS. Each error.tsx logs to console, renders `EmptyState` from the design system, and offers a retry button that calls `unstable_retry()`.

**Tasks:**
1. [ ] `app/error.tsx` — global fallback: `'use client'`, accepts `{ error: Error & { digest?: string }, unstable_retry: () => void }`
2. [ ] `app/(shell)/error.tsx` — shell-scoped (keeps TopNav/SideNav visible during error)
3. [ ] 5 per-segment error.tsx files — differ only in title string ("Failed to load dashboard", etc.)
4. [ ] Each uses `EmptyState` component with `title`, `description`, and a retry Button wired to `onClick={unstable_retry}`
5. [ ] Log to console: `console.error('[Route] error:', error, error.digest)`

**Acceptance Criteria:**
- [ ] Every error.tsx compiles with TypeScript strict mode
- [ ] All use `unstable_retry` (not `reset`) as prop name
- [ ] Manually triggering a throw in a route (e.g., `throw new Error('test')`) shows the correct-level error boundary
- [ ] Retry button re-renders the segment without full page reload

**Notes:**
Client-side TanStack Query errors (`useQuery` error state) do NOT trip `error.tsx` — only RSC render errors and unhandled promise rejections during prefetch do. Component-local 4xx errors should be handled inline (loading state → error state → retry button within the component).

---

#### 2.4 loading.tsx per route with Cloudscape skeletons
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 investigation item 1.6
**Files Affected:**
- `packages/web-next/app/(shell)/loading.tsx` (create)
- Per-route: `app/(shell)/dashboard/loading.tsx`, `app/(shell)/entities/loading.tsx`, `app/(shell)/entities/[id]/loading.tsx`, `app/(shell)/briefs/loading.tsx`, `app/(shell)/briefs/[id]/loading.tsx` (create)

**Description:**
Per-segment loading states matching each screen's layout shape. Uses `Tailwind animate-pulse` for skeleton effect with design-system color tokens (`bg-surface-muted` etc.). No animation library dep.

**Tasks:**
1. [ ] `(shell)/loading.tsx` — generic shell-level skeleton (rarely used since segment loaders take precedence)
2. [ ] Dashboard loading: 5-block stat strip skeleton + 2-col grid with card skeletons matching StatStrip/QuickCapture/RecentCaptures/OpenQuestions/UpcomingBriefs dimensions
3. [ ] Entities list loading: TypeFilterTabs skeleton + 8-row table skeleton + sidebar skeletons
4. [ ] Entity detail loading: Hero monogram + 5-stat row + 2-col body skeleton
5. [ ] Briefs library loading: Hero block + 3-col card grid skeleton
6. [ ] Brief reader loading: 3-col layout skeleton (TOC + body + sources)

**Acceptance Criteria:**
- [ ] Each loading.tsx renders without data
- [ ] Dimensions match the final page so layout doesn't jump on content arrival
- [ ] All use Cloudscape design tokens (no hex literals)

**Notes:**
Skeletons use `animate-pulse` from Tailwind — defined in design-system. No shimmer/gradient animation needed for M2 (simpler = less debt). Design review may want richer skeletons later; M3 follow-up if needed.

---

### Phase 2 Testing Requirements

- [ ] `api-client.test.ts` passes with MSW handlers (>= 10 cases)
- [ ] `pnpm --filter @open-brain/web-next build` exits 0 with all error/loading files present
- [ ] Manual verification: provoke 404, 500, and network error — correct error.tsx renders with retry button
- [ ] Manual verification: slow-throttle Dashboard route — loading.tsx renders skeleton before content

### Phase 2 Completion Checklist

- [ ] All 4 work items COMPLETE
- [ ] `lib/api-client.ts` type-checks with strict mode
- [ ] Every error.tsx uses `unstable_retry` (not `reset`)
- [ ] No screen wiring done yet (that's Phases 7–8)
- [ ] LAB_NOTEBOOK entry

---

## Phase 3: CS1 Realtime + E2E (SSE + invalidation map + Playwright smoke)

**Estimated Complexity:** M (~6 files, ~400 LOC)
**Dependencies:** Phase 2
**Parallelizable:** No

### Goals

- Port the SSE singleton from `/web` with exponential backoff reconnect (missing in existing implementation)
- Centralize event → Query cache invalidation so new screens inherit real-time updates for free
- Prove the full stack (API proxy → Query → SSE → invalidation) with one golden-path E2E test
- Leave M2 infra complete and ready for screen wiring to begin

### Work Items

#### 3.1 Port SSE client with exponential backoff reconnect
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 investigation item 1.3, sharp-edge: existing /web sse.ts has no reconnect
**Files Affected:**
- `packages/web-next/lib/sse-client.ts` (create)
- `packages/web-next/lib/__tests__/sse-client.test.ts` (create)

**Description:**
The existing `packages/web/src/lib/sse.ts` has NO reconnect logic — just an `onerror` console log. Porting without adding reconnect perpetuates the bug. Add exponential backoff (1s → 2s → 4s → 8s → 30s, max 5 attempts) mirroring the pg-notify reconnect pattern from CLAUDE.md.

**Tasks:**
1. [ ] `SseClient` class with `start(): void`, `stop(): void`, `on(handler: (evt: SseEvent) => void): () => void` (returns unsubscribe)
2. [ ] EventSource lifecycle: create on start, close on stop
3. [ ] On error event or connection drop: schedule reconnect with exponential backoff (1s, 2s, 4s, 8s, 30s max)
4. [ ] After 5 failed attempts, stop retrying and emit a `connection_lost` synthetic event for UI handling
5. [ ] Event types (from existing /web): `capture_created`, `pipeline_complete`, `skill_complete`, `bet_expiring`, `upload:status`, plus NEW `brief_created` (added in Phase 5)
6. [ ] Vitest tests with fake EventSource — verify reconnect schedule, handler subscription, unsubscribe cleanup

**Acceptance Criteria:**
- [ ] `sse-client.test.ts` passes (fake EventSource mocked)
- [ ] Reconnect attempts follow exponential schedule (verified via timer mocks)
- [ ] Handler unsubscribe works (no memory leaks when components unmount)

**Notes:**
EventSource doesn't carry Authorization headers — acceptable since Open Brain has no auth. If auth is added in a future phase, the SSE endpoint URL could carry a short-lived token query param — note in M3 backlog.

---

#### 3.2 SSE provider + central invalidation map
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 investigation items 1.3 + 4.7
**Files Affected:**
- `packages/web-next/components/providers/sse-provider.tsx` (create)
- `packages/web-next/lib/sse-invalidation-map.ts` (create)
- `packages/web-next/app/providers.tsx` (modify — wrap children in SseProvider)

**Description:**
Single EventSource instance owned by a React Context Provider. Provider consumes `useQueryClient()` and maps every SSE event to `queryClient.invalidateQueries({ queryKey })` calls. Centralized invalidation map means adding a new screen = just defining its query key; live updates come free.

**Tasks:**
1. [ ] `lib/sse-invalidation-map.ts` — const object mapping event types to query key arrays:
   - `capture_created → [['captures'], ['dashboard'], ['entities']]`
   - `pipeline_complete → [['capture', '{captureId}'], ['dashboard']]`
   - `skill_complete → [['briefs'], ['dashboard']]`
   - `brief_created → [['briefs'], ['dashboard']]`
   - `bet_expiring → []` (unused in M2)
   - `upload:status → []` (unused in M2)
2. [ ] `sse-provider.tsx` ('use client') — mounts `SseClient` in `useEffect`, dispatches invalidations based on map
3. [ ] Dynamic key substitution: `['capture', '{captureId}']` → use event payload's `capture_id` to build `['capture', evt.data.capture_id]`
4. [ ] Wire into `app/providers.tsx` — order: QueryClientProvider → SseProvider → children (SSE needs queryClient)
5. [ ] Cleanup on unmount: call `client.stop()` and clear subscriptions to prevent Fast Refresh dev leaks

**Acceptance Criteria:**
- [ ] `pnpm --filter @open-brain/web-next build` passes with providers wired
- [ ] Manual test: emit `capture_created` event from core-api — dashboard query invalidates automatically
- [ ] Dev Fast Refresh doesn't leak EventSource connections (verify via Chrome DevTools → Network → EventStream)

**Notes:**
Event payload shape must match what core-api emits. If pg-notify payload is id-only, the provider fetches full data on invalidation via the Query refetch. If it's richer, that's a bonus — just don't rely on specific fields beyond `id`.

---

#### 3.3 Playwright smoke test: QuickCapture → dashboard refresh
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 investigation item 1.8
**Files Affected:**
- `packages/web-next/tests/smoke/quick-capture.spec.ts` (create)

**Description:**
One golden-path E2E that exercises the entire stack: Next.js dev server → api-client → core-api → POST /captures → SSE `capture_created` → Query invalidate → Dashboard refetch → new capture visible. This is the single most important test for M2; if it passes, all 4 layers work together.

**Tasks:**
1. [ ] Test: navigate to `http://localhost:3001/dashboard` — verify Dashboard renders
2. [ ] Locate QuickCapture textarea, fill with "Smoke test capture {uuid}"
3. [ ] Click Capture button, wait for `POST /api/v1/captures` response (`page.waitForResponse`)
4. [ ] Wait up to 5s for new capture to appear in Recent captures list (SSE-driven invalidate → refetch)
5. [ ] Assert capture content matches the submitted string
6. [ ] Requires core-api + postgres + redis running on dev ports (documented in test README)

**Acceptance Criteria:**
- [ ] Test passes when `docker compose up -d postgres redis core-api` is running
- [ ] Test fails gracefully with clear error if core-api unreachable
- [ ] `pnpm test:e2e` runs the test (separate from default `pnpm test` CI path)

**Notes:**
Tests are intentionally separated into `tests/` (not `src/`) so `tsc` doesn't try to compile them with app tsconfig. Playwright tests need their own tsconfig (or use the one Playwright generates). CI integration deferred to later — this test runs on-demand for now.

---

### Phase 3 Testing Requirements

- [ ] `sse-client.test.ts` passes
- [ ] `pnpm --filter @open-brain/web-next build` exits 0
- [ ] Playwright smoke test passes against a running local stack
- [ ] Manual test: trigger pg-notify `capture_created` via psql — dashboard query key invalidates (check React Query DevTools)

### Phase 3 Completion Checklist

- [ ] All 3 work items COMPLETE
- [ ] Full frontend infrastructure ready for screen wiring
- [ ] LAB_NOTEBOOK entry documenting SSE reconnect addition
- [ ] Phase 1-3 cumulatively represent CS1 — screen-wiring PRs (Phases 7-8) will consume these patterns

---

## Phase 4: CS2 Briefs Schema + BaseSkill signature change

**Estimated Complexity:** L (~12 files, ~700 LOC)
**Dependencies:** Phase 3 (for test infrastructure)
**Parallelizable:** No (cascading subclass changes must land atomically)

### Goals

- Create first-class `briefs` table with D107 design decisions locked in (MONTHLY kind, soft-dismiss, refined_from_id chain)
- Change `BaseSkill.logResult()` signature from void → Promise<string> (D112) — cascades to ~25 subclasses
- Add canonical TS types, Zod schemas, and per-skill kind/cover mappings to `@open-brain/shared`
- Extend drift-guard test to cover new brief types
- Add `MEETING` variant to BriefSource (needed for morning-brief calendar events)

### Work Items

#### 4.1 Migration 0030 — briefs table
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 D107, investigation item 2.3
**Files Affected:**
- `packages/shared/drizzle/0030_briefs.sql` (create)
- `scripts/apply-migration-0030.md` (create — homeserver apply instructions per CLAUDE.md no-auto-migration rule)

**Description:**
First-class `briefs` table. CHECK constraints on `kind` (includes MONTHLY per D) and `cover`. Indexes for list/filter/unread queries. Unique partial index on `source_skill_log_id WHERE NOT NULL` for backfill idempotency. `set_updated_at` trigger following CLAUDE.md's DROP+CREATE idempotency rule.

**Tasks:**
1. [ ] Write migration 0030 per the schema in CS2 investigation notes (columns, CHECKs, indexes, trigger)
2. [ ] `kind IN ('DAILY','WEEKLY','DOSSIER','DECISION','PROJECT','MONTHLY')` (MONTHLY per D — cheap to add now)
3. [ ] `cover IN ('parchment','evening','sunrise','gold','canvas','slate')`
4. [ ] Indexes: `(generated_at DESC)`, `(kind)`, partial `(generated_at DESC) WHERE read_at IS NULL AND dismissed_at IS NULL`, unique partial `(source_skill_log_id) WHERE source_skill_log_id IS NOT NULL`, `(refined_from_id) WHERE refined_from_id IS NOT NULL`
5. [ ] `DROP TRIGGER IF EXISTS set_briefs_updated_at ON briefs;` before `CREATE TRIGGER` (CLAUDE.md idempotency rule)
6. [ ] Write homeserver apply runbook — `psql $DATABASE_URL -f packages/shared/drizzle/0030_briefs.sql` — with rollback SQL (`DROP TABLE briefs CASCADE;`)

**Acceptance Criteria:**
- [ ] Migration applies cleanly on a fresh test DB
- [ ] Applying twice is idempotent (CHECK constraints + trigger DROP IF EXISTS)
- [ ] Rollback cleans up without cascading failures

**Notes:**
Per CLAUDE.md, no auto-migration. After merging, operator manually applies on homeserver. Document this in the commit message. Pre-flight audit rule: run `\dt briefs` first to confirm absence; run `SELECT version();` for Postgres version match.

---

#### 4.2 Drizzle schema + TS types + Zod + constants
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 D107, investigation items 2.3 + 2.6
**Files Affected:**
- `packages/shared/src/schema/briefs.ts` (create)
- `packages/shared/src/types/brief.ts` (create)
- `packages/shared/src/index.ts` (modify — add exports)

**Description:**
Drizzle schema mirroring migration 0030. TS union types for `BriefKind`, `BriefCover`, `BriefSourceType` (includes new MEETING per D). Zod schemas for API validation. Per-skill constants: `SKILL_TO_BRIEF_KIND`, `SKILL_TO_BRIEF_COVER`, `REFINE_OPTIONS`, `BRIEF_SOURCE_TYPE_MAP`.

**Tasks:**
1. [ ] Drizzle schema in `schema/briefs.ts` — columns match SQL, JSONB for toc/sources/refine_options
2. [ ] TS types: `BriefKind`, `BriefCover`, `Brief` (list shape), `BriefDetail` (full shape), `TocItem`, `BriefSource`, `BriefSourceType = 'EMAIL'|'VOICE'|'MEETING'|'NOTE'`
3. [ ] Zod schemas for each
4. [ ] Constants: `SKILL_TO_BRIEF_KIND` (weekly-brief→WEEKLY, daily-sweep-skill→DAILY, morning-brief→DAILY, monthly-reflection→MONTHLY), `SKILL_TO_BRIEF_COVER`, `REFINE_OPTIONS` (6 preset strings), `BRIEF_SOURCE_TYPE_MAP` (captures.source → BriefSourceType, with `voice→VOICE`, `email→EMAIL`, calendar→MEETING, rest→NOTE)
5. [ ] Export from `packages/shared/src/index.ts`

**Acceptance Criteria:**
- [ ] `pnpm --filter @open-brain/shared build` exits 0
- [ ] TS types align with migration CHECK constraints (union literals match)
- [ ] Zod schemas round-trip parse/serialize fixtures

**Notes:**
MEETING variant is the one BriefSource type that web-next's M1 types.ts doesn't yet have. Work item 4.6 extends web-next types to match. The drift-guard test extension (4.5) locks this alignment.

---

#### 4.3 BaseSkill.logResult() signature change
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 D112, investigation item 2.3
**Files Affected:**
- `packages/workers/src/skills/base-skill.ts` (modify)
- ~25 skill subclasses (modify — all subclasses that call `logResult()`)

**Description:**
`BaseSkill.logResult()` changes from `Promise<void>` → `Promise<string>` (returns inserted skills_log.id). Needed so brief-writer (Phase 6) can set `source_skill_log_id` on new brief rows for provenance. Cascades to ~25 subclasses. MUST land in a single atomic commit — partial state is broken.

**Tasks:**
1. [ ] Update `BaseSkill.logResult()` to return the inserted skills_log row id (Drizzle's `.returning({id})` pattern)
2. [ ] Grep for all `logResult(` call sites: `grep -r 'logResult(' packages/workers/src/` — expect ~25
3. [ ] Update each call site: either discard return (`await this.logResult(...)`) or capture (`const logId = await this.logResult(...)`)
4. [ ] Run full workers test suite: `pnpm --filter @open-brain/workers test`
5. [ ] Run typecheck: `pnpm --filter @open-brain/workers exec tsc --noEmit`

**Acceptance Criteria:**
- [ ] Every subclass compiles cleanly
- [ ] Full workers test suite passes
- [ ] No runtime regressions in existing skill behavior (logs still written)

**Notes:**
This is the single highest-risk change in M2 — it touches every brief-emitting AND non-brief-emitting skill. Atomic commit is mandatory. If any subclass is missed, workers package fails to build. Use grep carefully: include `.skill.ts`, `.skills/`, `.jobs/` paths.

---

#### 4.4 Audit + update skill subclasses
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** A78, CS2 D112 follow-up
**Files Affected:**
- Same ~25 files as 4.3 (this item focuses on verification, not re-editing)
- `docs/skill-inventory.md` (create — one-time inventory of all skills for future reference)

**Description:**
Defensive verification step after 4.3. Create a one-time inventory of all skills (name, file path, schedule if scheduled, brief-producing yes/no, concurrency, minimum_autonomy). Run the full skill suite in integration mode to confirm no regressions. This is separate from 4.3 so reviewers can focus on the signature change in isolation, then the audit gives them confidence the subclass cascade is complete.

**Tasks:**
1. [ ] Produce `docs/skill-inventory.md` — table of all skills with columns: name, path, schedule (if any), brief-producing (Y/N), concurrency, minimum_autonomy
2. [ ] Run workers tests in forks pool: `pnpm --filter @open-brain/workers test`
3. [ ] Run a manual skill trigger on homeserver (e.g., trigger `weekly-brief` or `daily-sweep-skill`) — verify it logs to skills_log correctly with the new return value
4. [ ] Document any discovered skill that was missed in 4.3 as a followup commit

**Acceptance Criteria:**
- [ ] Skill inventory is comprehensive (all skills in `packages/workers/src/skills/` listed)
- [ ] Workers tests pass
- [ ] Manual skill trigger succeeds on homeserver

**Notes:**
The inventory document is also useful for Phase 6 (extending 4 brief-producing skills) since it's the source of truth for which skills to modify. Keep it current as new skills are added.

---

#### 4.5 Extend drift-guard test for brief types
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS1 D109 follow-up, CS2 type alignment
**Files Affected:**
- `packages/shared/src/__tests__/web-type-drift.test.ts` (modify)

**Description:**
Phase 1 (work item 1.5) extended the drift-guard test to cover existing web-next types. Now that Phase 4 added NEW canonical types (`BriefKind`, `BriefCover`, `BriefSourceType`), extend the drift-guard to assert web-next declarations stay aligned. The web-next side is updated in 4.6.

**Tasks:**
1. [ ] Add drift-guard assertions for `BriefKind` (6 values), `BriefCover` (6 values), `BriefSourceType` (4 values)
2. [ ] Verify test fails if any one of these is missing from web-next
3. [ ] Add explicit comment pointing to migration 0030 CHECK constraints as the source of truth

**Acceptance Criteria:**
- [ ] Test passes after 4.6 adds MEETING + updated types
- [ ] Deliberately removing a BriefKind value from web-next causes test failure

**Notes:**
Four canonical enum sources of truth now: migration 0030 CHECK, Drizzle schema, shared Zod, web-next lib/types.ts. The test locks all four together.

---

#### 4.6 Add MEETING to web-next BriefSource types
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 D-MEETING, investigation item 2.6
**Files Affected:**
- `packages/web-next/lib/types.ts` (modify)
- `packages/web-next/lib/mock-data.ts` (modify — add MEETING example)
- `packages/web-next/components/briefs/BriefSources.tsx` (verify rendering)

**Description:**
Morning-brief skill emits calendar events as brief sources (Phase 6). That requires a MEETING variant on `BriefSource.type`. Web-next types must match canonical per drift-guard. Update mock-data to include a MEETING example so the BriefSources component renders it correctly.

**Tasks:**
1. [ ] Extend `BriefSourceType` in `lib/types.ts`: add `'MEETING'` to union
2. [ ] Update `mockTuesdayBrief.sources` in mock-data to include at least one MEETING entry
3. [ ] Verify `BriefSources.tsx` renders MEETING label correctly (may need CSS variant for type eyebrow color)
4. [ ] Run `pnpm --filter @open-brain/web-next build` — expect clean
5. [ ] Run drift-guard test — expect pass with 4.5 changes

**Acceptance Criteria:**
- [ ] Build passes
- [ ] Drift-guard passes
- [ ] Screenshot of /briefs/tuesday-brief shows MEETING source rendering cleanly

**Notes:**
If the MEETING type styling needs a distinct color (vs EMAIL/VOICE/NOTE), add to the design-system Pill variants in a small follow-up. For now the existing generic type eyebrow is sufficient.

---

### Phase 4 Testing Requirements

- [ ] Migration 0030 applies on fresh test DB
- [ ] Workers full test suite passes with BaseSkill signature change
- [ ] Drift-guard test covers all new brief types
- [ ] `pnpm --filter @open-brain/shared build` exits 0
- [ ] `pnpm --filter @open-brain/web-next build` exits 0 with MEETING type

### Phase 4 Completion Checklist

- [ ] All 6 work items COMPLETE
- [ ] Migration 0030 applied on homeserver (per operator runbook)
- [ ] `docs/skill-inventory.md` reviewed for completeness
- [ ] LAB_NOTEBOOK entry covering BaseSkill signature change and migration 0030
- [ ] No regressions: full workers + shared + web-next builds pass

---

## Phase 5: CS2 Rendering + Routes + SSE (briefs API complete)

**Estimated Complexity:** L (~10 files, ~900 LOC)
**Dependencies:** Phase 4
**Parallelizable:** No (renderer must precede routes that use it)

### Goals

- Build the `unified`-stack Markdown→HTML renderer shared by all brief-producing skills
- Extract TOC from rendered HTML via HAST AST walk (same pipeline pass)
- Expose the briefs API: 5 endpoints with Zod validation, rate-limit, strict-tier for refine
- Wire `brief_created` SSE event (additive pg-notify channel)

### Work Items

#### 5.1 Unified-stack brief renderer + TOC + source mapping
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 investigation items 2.4 + 2.5 + 2.6
**Files Affected:**
- `packages/shared/src/lib/brief-renderer.ts` (create)
- `packages/shared/src/lib/__tests__/brief-renderer.test.ts` (create)
- `packages/workers/package.json` (modify — add deps: unified, remark-parse, remark-rehype, rehype-slug, rehype-autolink-headings, rehype-stringify, xss)

**Description:**
Markdown → HTML → TOC pipeline. Uses `unified` stack (matches `/web`'s anchor-slug algorithm via `rehype-slug`). TOC extracted in the same pipeline pass via HAST walker. Source mapping helper converts `captures.source` → `BriefSourceType` (handles MEETING variant for calendar events). `xss` for Node-compatible HTML sanitization.

**Tasks:**
1. [ ] Add deps to `packages/workers/package.json` (shared doesn't run in browser so Node-safe libs are fine)
2. [ ] `renderBriefHtml(markdown: string): { html: string; toc: TocItem[] }` — single pipeline pass
3. [ ] Pipeline: remark-parse → remark-rehype → rehype-slug → rehype-autolink-headings → extract TOC from HAST → rehype-stringify → xss sanitize
4. [ ] `extractToc(hast: Root): TocItem[]` — walks h1/h2/h3 with `node.properties.id`
5. [ ] `mapCaptureSourceToBriefType(source: CaptureSource): BriefSourceType` with the 4-variant mapping
6. [ ] Unit tests: 10+ cases covering empty markdown, headings-only, mixed content, special chars, HTML injection (should be sanitized)

**Acceptance Criteria:**
- [ ] `brief-renderer.test.ts` passes
- [ ] Injection attempt: `<script>alert('xss')</script>` in markdown → stripped in output HTML
- [ ] TOC anchors match `rehype-slug` output (slugified headings)
- [ ] Build passes with new deps

**Notes:**
Deps live in `packages/workers` because that's where skills run. `packages/shared` imports the deps at runtime but shared is consumed by workers, so the install hoists correctly in pnpm workspace. Verify with `pnpm ls unified --filter @open-brain/workers`.

---

#### 5.2 BriefsService + briefs route handlers
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 investigation items 2.3 + 2.6
**Files Affected:**
- `packages/core-api/src/services/briefs.ts` (create)
- `packages/core-api/src/routes/briefs.ts` (create)
- `packages/core-api/src/app.ts` (modify — register routes, rate-limit mounts)

**Description:**
Service layer for brief CRUD. Five endpoints per CS2 design: GET list (with kind/unread filters + pagination), GET detail, POST refine (202 async), POST dismiss, PATCH read (supports read: true|false for mark-unread toggle per D8 decision). Strict rate-limit tier on `/refine` (LLM cost); default for others. `web-ui` caller already bypasses via existing middleware.

**Tasks:**
1. [ ] `BriefsService`: `list({kind?, unread?, limit, offset})`, `getById(id)`, `refine(id, option)`, `dismiss(id)`, `patchRead(id, read)`
2. [ ] `list` sort: `generated_at DESC`; cap limit at 100, default 20
3. [ ] `refine` ENQUEUES BullMQ `skill-execution` job with skillName: 'refine-brief', input: { source_brief_id, option }; returns `{job_id, status: 'queued'}` with HTTP 202
4. [ ] `dismiss` sets `dismissed_at = NOW()`, returns 204
5. [ ] `patchRead({read: true})` sets `read_at = NOW()`, `{read: false}` sets `read_at = NULL` (mark-unread toggle)
6. [ ] Register routes in `app.ts`; strict-tier mount for `/briefs/:id/refine` BEFORE the `/api/v1/*` default-tier mount (Hono first-match wins)

**Acceptance Criteria:**
- [ ] Integration tests in `packages/core-api/src/__tests__/routes/briefs.test.ts` pass (fixtures: 3 briefs with different kinds + read states)
- [ ] POST /refine returns 202 with job_id
- [ ] PATCH with read: false clears read_at
- [ ] Dismiss is idempotent (double-dismissing a brief returns current state)

**Notes:**
Do NOT add a DELETE endpoint for briefs in M2 (soft-dismiss only, per D7). Hard delete deferred to admin UI milestone. Zod schemas use `z.enum` for kind filter, `z.boolean()` for read, `z.string().min(1)` for refine option.

---

#### 5.3 brief_created SSE event
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 investigation item 2.7
**Files Affected:**
- `packages/core-api/src/lib/pg-notify.ts` (modify — add channel)
- `packages/core-api/src/services/briefs.ts` (modify — publish on insert)
- `packages/core-api/src/routes/events.ts` (verify — generic pass-through should work)

**Description:**
Additive pg-notify channel. Service-layer explicit publish (matches `activity_feed`/`upload_status` pattern, not a pg trigger). Payload: `{id, kind, title, generated_at}`. events.ts forwards to SSE clients without translation.

**Tasks:**
1. [ ] Add `'brief_created'` to pg-notify channel enum/allowlist in `pg-notify.ts`
2. [ ] In `BriefsService.create()` (or wherever briefs INSERT happens), call `pgNotify.notify('brief_created', {id, kind, title, generated_at})` after successful INSERT
3. [ ] Verify `events.ts` passes through the channel without mapping (identifier-safe name, no colon)
4. [ ] Integration test: insert a brief, listen on SSE stream, verify `brief_created` event is received within 1s

**Acceptance Criteria:**
- [ ] SSE client connected to `/api/v1/events` receives `brief_created` after INSERT
- [ ] Payload contains id, kind, title, generated_at
- [ ] Missing/null values don't crash the event stream

**Notes:**
Since Phase 4 set up Drift-guard for types, and Phase 3 set up the web-next SSE invalidation map, an end-to-end test of `brief_created → web-next invalidates briefs list` can be done manually after Phases 5+6 are both merged.

---

### Phase 5 Testing Requirements

- [ ] `brief-renderer.test.ts` passes with 10+ cases
- [ ] `briefs.test.ts` integration tests pass (5 endpoints × happy path + error cases)
- [ ] SSE integration test confirms `brief_created` event delivery
- [ ] All routes respect rate-limit tiers (strict for /refine, default for rest)
- [ ] `pnpm --filter @open-brain/core-api build` exits 0

### Phase 5 Completion Checklist

- [ ] All 3 work items COMPLETE
- [ ] LAB_NOTEBOOK entry
- [ ] No regressions: full core-api test suite passes
- [ ] `X-Open-Brain-Caller` bypass verified (web-ui caller already in BYPASS_CALLERS)

---

## Phase 6: CS2 Skill Extensions + Backfill + Refine

**Estimated Complexity:** L (~8 files, ~800 LOC)
**Dependencies:** Phase 5
**Parallelizable:** Items 6.1–6.4 can run in parallel after renderer is in place; 6.5 after briefs exist; 6.6 after refine endpoint in Phase 5

### Goals

- Extend 4 brief-producing skills to write structured briefs (body_html, TOC, sources) alongside existing skills_log
- Build one-time backfill script for historical skills_log entries
- Implement `refine-brief` skill using Option 2 (generic LLM HTML transform)

### Work Items

#### 6.1 Extend weekly-brief + daily-sweep-skill
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 investigation items 2.1 + 2.4
**Files Affected:**
- `packages/workers/src/skills/weekly-brief.ts` (modify)
- `packages/workers/src/skills/daily-sweep-skill.ts` (modify)

**Description:**
Two skills, similar pattern. After `logResult()` (which now returns skills_log.id per 4.3), call a shared `writeBrief()` helper that: (a) renders structured output to markdown, (b) runs renderer to get body_html + TOC, (c) maps sourced captures, (d) POSTs to new `/api/v1/briefs` endpoint OR directly INSERTs via shared Drizzle client.

**Tasks:**
1. [ ] Add `writeBrief()` method to BaseSkill (or shared helper in `packages/shared/src/lib/brief-writer.ts`)
2. [ ] Extend weekly-brief.ts: after logResult, build markdown from `WeeklyBriefOutput` structure, call writeBrief with kind=WEEKLY, cover=week
3. [ ] Extend daily-sweep-skill.ts: same pattern, kind=DAILY, cover=evening
4. [ ] Both emit sources from their `captures` array (top 12, mapped via mapCaptureSourceToBriefType)
5. [ ] Both use `X-Open-Brain-Caller: workers` header if using HTTP; or direct DB if using Drizzle

**Acceptance Criteria:**
- [ ] Manually triggering weekly-brief on homeserver creates a new briefs row
- [ ] Brief has valid body_html, toc (≥ 3 TOC items from h2 sections), sources (≥ 3 entries)
- [ ] SSE `brief_created` fires and web-next would invalidate on trigger

**Notes:**
Preserve existing email-send behavior of weekly-brief (Himalaya cascade). The new brief-write is additive, not replacing. Pushover notification chain preserved.

---

#### 6.2 Extend morning-brief + monthly-reflection
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 investigation items 2.1 + 2.4
**Files Affected:**
- `packages/workers/src/skills/morning-brief.ts` (modify)
- `packages/workers/src/skills/monthly-reflection.ts` (modify)

**Description:**
Two more brief-producing skills. Morning-brief is special: its sections include calendar events which map to the new MEETING source type. Monthly-reflection uses kind=MONTHLY (added to CHECK in Phase 4).

**Tasks:**
1. [ ] Extend morning-brief: build markdown from 7 sections (Today's Schedule, Reference Calendars, Overnight Email, Yesterday's Thread, Open Loops, People, Today), call writeBrief with kind=DAILY, cover=sunrise
2. [ ] Morning-brief sources: calendar events → MEETING type; emails → EMAIL; captures → mapped per type
3. [ ] Extend monthly-reflection: if exists as a skill; if not, defer its brief-write until skill is built (document in M3 backlog)
4. [ ] Verify kind=MONTHLY is accepted by CHECK constraint

**Acceptance Criteria:**
- [ ] Morning-brief run creates a brief with MEETING sources
- [ ] Monthly-reflection (if active) creates brief with kind=MONTHLY
- [ ] Slack DM delivery + Pushover chain unchanged

**Notes:**
If monthly-reflection doesn't exist as a skill yet, 4.6 still needs the MONTHLY kind added to CHECK for future-proofing. Phase 4 handled that. Phase 6 only extends the skill IF it exists.

---

#### 6.3 Backfill script
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 investigation item 2.5
**Files Affected:**
- `scripts/backfill-briefs.ts` (create)
- `scripts/backfill-briefs.README.md` (create)

**Description:**
One-time script. Reads all historical skills_log rows for the 4 brief-producing skills and creates briefs rows. Graceful degradation: old rows without structured output get minimal brief (body_html from output_summary, toc=[], sources=[]). Idempotent via unique partial index on source_skill_log_id.

**Tasks:**
1. [ ] `--dry-run` mode: prints count of rows that would be backfilled per skill
2. [ ] `--apply` mode: actually inserts
3. [ ] Per-row: map skill_name → kind/cover, parse result JSONB, attempt to render if possible (fall back to plain wrapping of output_summary), insert
4. [ ] Idempotent: INSERT ... ON CONFLICT DO NOTHING (on source_skill_log_id unique partial index)
5. [ ] Log errors and skip rows with malformed JSONB rather than aborting
6. [ ] README documents how to run on homeserver (psql container, pnpm tsx invocation)

**Acceptance Criteria:**
- [ ] Dry-run shows expected counts (~N historical briefs per skill)
- [ ] Apply creates briefs rows
- [ ] Running apply twice is idempotent (second run inserts zero)

**Notes:**
This runs ONCE on homeserver post-deploy. Document in LAB_NOTEBOOK + CLAUDE.md as a required post-M2 manual step alongside migration 0030.

---

#### 6.4 Refine-brief skill (Option 2: generic LLM HTML transform)
**Status: COMPLETE 2026-04-21**
**Requirement Refs:** CS2 D110, investigation item 2.9
**Files Affected:**
- `packages/workers/src/skills/refine-brief.ts` (create)
- `config/ai-routing.yaml` (modify — add task_routing entry)

**Description:**
Per D110, Option 2 was chosen: single LLM call rewrites body_html with the option modifier. 3-second response vs Option 1's 30-90 seconds. Triggered by the BullMQ job enqueued by `POST /briefs/:id/refine` in Phase 5. Writes new brief with `refined_from_id` = source.

**Tasks:**
1. [ ] Extend `LLMSkill` with `refine-brief`
2. [ ] Input: `{ source_brief_id, option }`
3. [ ] Fetch source brief from DB
4. [ ] Build prompt: "Rewrite this brief. Apply this modifier: {option}. Preserve HTML structure, headings, and source references." + source.body_html as context
5. [ ] Use SafePromptBuilder (WI-1 hardening)
6. [ ] Route via `task_routing.brief_refinement` in ai-routing.yaml (probably `t1_fast` — Haiku/fast-tier for latency)
7. [ ] Parse LLM output, extract new body_html, run through renderer to regenerate TOC
8. [ ] Write new brief: kind=source.kind, cover=source.cover, body_html=new, toc=new, sources=source.sources (unchanged), refined_from_id=source.id, generated_at=NOW()

**Acceptance Criteria:**
- [ ] Manual refine: POST /briefs/{id}/refine with option="Shorter" → new brief appears within 5s
- [ ] New brief has refined_from_id pointing to source
- [ ] brief_created SSE fires
- [ ] Prompt injection attempt in option string is neutralized by SafePromptBuilder

**Notes:**
Option string validation: Zod enum of the 6 preset refine_options. Rejecting free-form prevents prompt injection via the option field. If additional refinements are needed later, extend the enum.

---

### Phase 6 Testing Requirements

- [ ] Manually triggering each of the 4 brief skills creates a valid brief
- [ ] Backfill script dry-run + apply succeed on a test DB
- [ ] Refine flow end-to-end: POST refine → brief_created SSE → new brief appears
- [ ] Full workers test suite passes

### Phase 6 Completion Checklist

- [ ] All 4 work items COMPLETE
- [ ] Homeserver: migration 0030 applied + backfill run
- [ ] LAB_NOTEBOOK entry
- [ ] M3 backlog updated if monthly-reflection skill doesn't exist yet

---

## Phase 7: CS3 Entity Endpoints + CS4 Dashboard & Entities List

**Estimated Complexity:** L (~12 files, ~1100 LOC)
**Dependencies:** Phase 6
**Parallelizable:** CS3 (items 7.1–7.3) can ship independently of CS4 wiring (items 7.4–7.5)

### Goals

- Ship 3 new entity detail endpoints with zero schema changes (existing indexes sufficient)
- Wire the Dashboard screen end-to-end as the first proof of the full stack
- Wire the Entities list with URL-driven filter state (server-side bookmarkable)

### Work Items

#### 7.1 GET /entities/:id/related
**Status: PENDING**
**Requirement Refs:** CS3 investigation item 3.1
**Files Affected:**
- `packages/core-api/src/services/entity.ts` (modify — add getRelated + entityExists)
- `packages/core-api/src/routes/entities.ts` (modify — register route)

**Description:**
Two-hop self-join on `entity_links` for co-occurrence graph. Excludes `deleted` captures. Tiebreaker on `e.name ASC` for deterministic test output. Existing indexes sufficient — no migration needed. Existence check FIRST (avoid silently hiding typo'd IDs per investigation item 3.5).

**Tasks:**
1. [ ] `EntityService.entityExists(id): Promise<boolean>` — lightweight `SELECT 1 FROM entities WHERE id=$1`
2. [ ] `EntityService.getRelated(id, limit)` — the SQL per investigation notes
3. [ ] Route handler: validate UUID, call entityExists, if false 404, else call getRelated, return `{related: [...]}`
4. [ ] Integration tests: 2 entities with 3 shared captures → related[0].shared_count === 3

**Acceptance Criteria:**
- [ ] GET /api/v1/entities/{valid-id}/related returns 200 with array (possibly empty)
- [ ] GET /api/v1/entities/{typo-id}/related returns 404
- [ ] Integration test passes

**Notes:**
Query plan verification via EXPLAIN: should use `entity_links_entity_capture_idx` composite index. If query planner chooses differently, add `SET LOCAL enable_seqscan = off` or add query hint.

---

#### 7.2 GET /entities/:id/mentions-timeline
**Status: PENDING**
**Requirement Refs:** CS3 investigation item 3.2
**Files Affected:**
- `packages/core-api/src/services/entity.ts` (modify)
- `packages/core-api/src/routes/entities.ts` (modify)

**Description:**
Time-bucketed `date_trunc(bucket, created_at)` aggregation. Validates window ∈ {7d, 30d, 90d, 365d} and bucket ∈ {day, week, month}. Reject `bucket=day AND window=365d` via Zod `.refine()`. Client-side zero-fill (server returns only non-zero buckets for smaller payload).

**Tasks:**
1. [ ] `EntityService.getMentionsTimeline(id, window, bucket)` — parameterized SQL
2. [ ] Zod schema with cross-field `.refine()` rejecting day + 365d combo
3. [ ] Route handler: validates via zValidator, calls entityExists, executes query, returns `{buckets: [...], window, bucket}`
4. [ ] Integration tests: 3 captures across 3 weeks → 3 buckets returned (others excluded)

**Acceptance Criteria:**
- [ ] Valid windows/buckets return buckets array
- [ ] Invalid combo (day + 365d) returns 400 with clear message
- [ ] Non-existent entity returns 404

**Notes:**
Interval string built server-side from the validated enum, NEVER from user input. Check `date_trunc` performance at 10K+ entity links — may need to add composite index on `(entity_id, created_at)` in a future phase.

---

#### 7.3 POST /entities/:id/ask (TS-side intersection with synthesize)
**Status: PENDING**
**Requirement Refs:** CS3 D114, investigation item 3.3
**Files Affected:**
- `packages/core-api/src/services/entity.ts` (modify)
- `packages/core-api/src/routes/entities.ts` (modify)
- `packages/core-api/src/app.ts` (modify — add strict rate-limit mount before `/api/v1/*` default)

**Description:**
Entity-scoped synthesize via path (a): fetch entity-linked capture IDs (top 2000), run `searchService.search(question, {limit: 50})`, intersect on capture ID, take top 10, feed to `SafePromptBuilder` + `llmGateway.completeByTask(prompt, 'search_synthesis', ...)`. No SQL function change.

**Tasks:**
1. [ ] `EntityService.ask(id, question): Promise<{response, capture_count, entity}>` — implements path (a)
2. [ ] Route handler: validates body (Zod: question 1–2000 chars), calls entityExists, calls ask, returns response
3. [ ] In `app.ts`: add `app.use('/api/v1/entities/*/ask', rateLimit(strictLimiter))` BEFORE `app.use('/api/v1/*', rateLimit(defaultLimiter))` (Hono first-match wins)
4. [ ] Integration tests: mock search results + LLM response, assert entity-scoped results

**Acceptance Criteria:**
- [ ] POST /api/v1/entities/{id}/ask with valid body returns 200
- [ ] Rate-limit tier verified: strict (20/min)
- [ ] SafePromptBuilder sanitizes entity name + question
- [ ] Empty entity (no links): returns synthesize's "no relevant captures" response

**Notes:**
Fallback if intersection < 3: widen to top-50 entity captures sorted by FTS rank of question (per CS3 investigation notes). Keep this behavior documented in code comments.

---

#### 7.4 Wire Dashboard screen
**Status: PENDING**
**Requirement Refs:** CS4 investigation item 4.1
**Files Affected:**
- `packages/web-next/app/(shell)/dashboard/page.tsx` (modify — convert to async RSC)
- `packages/web-next/components/dashboard/QuickCapture.tsx` (modify — wire to api-client + mutation)
- `packages/web-next/components/dashboard/*.tsx` (verify — may need prop adjustments)

**Description:**
First screen wiring — validates the entire CS1 infrastructure end-to-end. Convert page to async RSC with `Promise.all` of 4 fetches. QuickCapture becomes a useMutation wrapper that POSTs captures and invalidates `['dashboard']`. Add error.tsx + loading.tsx skeleton per 2.3/2.4.

**Tasks:**
1. [ ] Convert `dashboard/page.tsx` to async function; Promise.all of: `statsApi.get()`, `capturesApi.list({limit: 8, sort: 'created_at_desc'})`, `intelligenceApi.unresolvedQuestions({limit: 4})`, `briefsApi.list({limit: 3})` (upcoming = first N undismissed)
2. [ ] Map raw API responses → UI display types using `lib/format.ts` formatters (`formatDelta`, `formatRelativeDate`, etc.)
3. [ ] QuickCapture: useMutation(`capturesApi.create`) + onSuccess → `queryClient.invalidateQueries({queryKey: ['dashboard']})` + `router.refresh()`
4. [ ] Toast on mutation success ("Captured") via sonner
5. [ ] Remove imports from `lib/mock-data.ts`
6. [ ] Screenshot verification: /dashboard renders with real data

**Acceptance Criteria:**
- [ ] Dashboard loads with real captures/stats/briefs
- [ ] QuickCapture submit creates a capture (verified via DB query)
- [ ] SSE `capture_created` event triggers dashboard refetch (verified via DevTools)
- [ ] No mock-data imports remain in dashboard files

**Notes:**
If `briefsApi.list` returns zero briefs pre-backfill, dashboard's "Upcoming briefs" widget shows empty state. That's fine — real briefs arrive after backfill (Phase 6.3) runs.

---

#### 7.5 Wire Entities list screen
**Status: PENDING**
**Requirement Refs:** CS4 investigation item 4.2
**Files Affected:**
- `packages/web-next/app/(shell)/entities/page.tsx` (modify — convert to async RSC)
- `packages/web-next/components/entities/TypeFilterTabs.tsx` (modify — `'use client'` + useSearchParams)
- `packages/web-next/components/entities/DistributionCard.tsx` (modify — derive from list)
- `packages/web-next/components/entities/NeedsAttention.tsx` (modify — stub empty for M3)

**Description:**
Convert page from `'use client'` back to async RSC. TypeFilterTabs becomes client component using `useSearchParams` + `<Link href={?type=...}>`. EntityTable text search stays client-side. DistributionCard derives counts from entity response. NeedsAttention stubbed until M3.

**Tasks:**
1. [ ] `entities/page.tsx` async RSC: reads `searchParams.type`, calls `entitiesApi.list({type_filter: searchParams.type})`
2. [ ] TypeFilterTabs: `'use client'`, reads useSearchParams, tabs render as `<Link href={?type=person}>` preserving other search params
3. [ ] DistributionCard: accepts entities array, computes type counts in render
4. [ ] NeedsAttention: return empty state with "Coming in M3" label
5. [ ] Remove mock-data imports

**Acceptance Criteria:**
- [ ] URL /entities?type=person correctly filters
- [ ] Browser back/forward preserves filter state
- [ ] Distribution counts match filtered response
- [ ] NeedsAttention shows M3 placeholder

**Notes:**
EntityTable text search is client-side only (filters already-loaded results). For datasets >100 entities this may want server-side search in a future phase — flag in M3 backlog.

---

### Phase 7 Testing Requirements

- [ ] CS3 integration tests pass (3 endpoints × happy path + error cases + rate-limit verification)
- [ ] CS4 screens build and render real data
- [ ] Playwright smoke test from Phase 3 still passes (end-to-end proof)
- [ ] No mock-data imports in dashboard or entities list

### Phase 7 Completion Checklist

- [ ] All 5 work items COMPLETE
- [ ] LAB_NOTEBOOK entry covering CS3 SQL patterns + first CS4 screens
- [ ] Screenshots of /dashboard + /entities with real data
- [ ] No regressions in other screens (entity detail, briefs — not wired yet but shouldn't crash)

---

## Phase 8: CS4 Entity Detail + Briefs + M3 Handoff

**Estimated Complexity:** L (~14 files, ~1200 LOC)
**Dependencies:** Phase 7
**Parallelizable:** Items 8.1–8.3 can partially overlap; 8.4 (M3 handoff doc) is independent

### Goals

- Wire the three remaining screens: Entity Detail, Briefs Library, Brief Reader
- Build Ask AI modal + Merge modal using Radix Dialog
- Write M3_BACKLOG.md capturing everything deferred from M2
- Leave M2 complete: all 5 Cloudscape screens live on real data

### Work Items

#### 8.1 Wire Entity Detail screen + Ask AI & Merge modals
**Status: PENDING**
**Requirement Refs:** CS4 investigation items 4.3, 4.8, 4.9, 4.11
**Files Affected:**
- `packages/web-next/app/(shell)/entities/[id]/page.tsx` (modify — remove staticParams, parallel fetches)
- `packages/web-next/components/entity/ask-ai-modal.tsx` (create)
- `packages/web-next/components/entity/merge-entity-modal.tsx` (create)
- `packages/web-next/components/entity/commitments-card.tsx` (modify — placeholder)
- `packages/web-next/components/entity/entity-header.tsx` (modify — wire buttons)
- `packages/web-next/components/entity/mentions-chart.tsx` (modify — client-side zero-fill)

**Description:**
Largest screen wiring. Parallel RSC fetches for entity/related/mentions-timeline. `notFound()` on missing entity. Ask AI modal opens textarea → POST /entities/:id/ask → displays response. Merge modal opens search → confirmation → POST /entities/:id/merge → redirect. Generate brief stubbed with sonner toast ("Coming in M3"). CommitmentsCard replaced with EmptyState placeholder.

**Tasks:**
1. [ ] Remove/empty `generateStaticParams` in `entities/[id]/page.tsx`
2. [ ] Parallel fetches: `entitiesApi.get(params.id)`, `entitiesApi.related(params.id)`, `entitiesApi.mentionsTimeline(params.id)`
3. [ ] `notFound()` if entity doesn't exist (404)
4. [ ] Ask AI modal: Radix Dialog, textarea (useState), submit via `useMutation` on `entitiesApi.ask`, render response
5. [ ] Merge modal: Radix Dialog, fuzzy search input hitting `entitiesApi.list({name: query})`, confirm button, redirect on success
6. [ ] EntityHeader: wire 3 buttons — Ask AI → open ask modal; Generate brief → sonner toast; Merge → open merge modal
7. [ ] CommitmentsCard: replace content with `<EmptyState title="Coming in M3" description="Commitments extraction is under design" />`
8. [ ] MentionsChart: zero-fill empty buckets client-side before rendering

**Acceptance Criteria:**
- [ ] /entities/sarah-chen loads with real data + related + mentions
- [ ] /entities/{random-uuid} shows 404
- [ ] Ask AI modal: submit question, see synthesis response
- [ ] Merge modal: pick target, confirm, redirect to target URL
- [ ] CommitmentsCard shows placeholder instead of mock data
- [ ] Mentions chart renders 13 weeks (90d/7) even if API returned 8 (5 zero-filled)

**Notes:**
Modal library: `@radix-ui/react-dialog` (added in Phase 1). Toast library: `sonner` (added in Phase 1). Do NOT try to hand-build either — the tech-debt cost dwarfs the bundle savings.

---

#### 8.2 Wire Briefs library screen
**Status: PENDING**
**Requirement Refs:** CS4 investigation item 4.4
**Files Affected:**
- `packages/web-next/app/(shell)/briefs/page.tsx` (modify — async RSC)
- `packages/web-next/components/briefs/BriefLibrary.tsx` (modify — URL searchParams)
- `packages/web-next/components/briefs/BriefHero.tsx` (modify — wire Dismiss button, stub Listen)

**Description:**
Convert to RSC. Filter tabs (DAILY/WEEKLY/etc.) as URL params. Hero = first unread or fallback to first in list. Dismiss button wires to POST /briefs/:id/dismiss + query invalidation. Listen button → sonner toast.

**Tasks:**
1. [ ] `briefs/page.tsx` async: fetch `briefsApi.list({limit: 20})`, compute hero = first where !read && !dismissed, else first in list
2. [ ] BriefLibrary: `'use client'`, filter tabs as Links with ?kind=WEEKLY params, grid/list toggle persisted via localStorage hook
3. [ ] BriefHero Dismiss: `useMutation(briefsApi.dismiss)` + invalidateQueries(['briefs']) + sonner "Brief dismissed"
4. [ ] BriefHero Listen: sonner "Text-to-speech coming in M3"
5. [ ] Remove mock-data imports

**Acceptance Criteria:**
- [ ] /briefs loads with real briefs after Phase 6 backfill
- [ ] Filter tabs update URL + refetch
- [ ] Dismiss hides brief from list and clears hero
- [ ] Listen shows M3 toast

**Notes:**
If briefsApi returns empty list on fresh DB (no backfill), the library shows empty state. That's expected — after backfill + a few scheduled runs, briefs accumulate.

---

#### 8.3 Wire Brief Reader screen
**Status: PENDING**
**Requirement Refs:** CS4 investigation item 4.5
**Files Affected:**
- `packages/web-next/app/(shell)/briefs/[id]/page.tsx` (modify — async RSC)
- `packages/web-next/components/briefs/BriefReader.tsx` (modify — mark-as-read on view)
- `packages/web-next/components/briefs/BriefSources.tsx` (modify — wire refine buttons)
- `packages/web-next/components/briefs/BriefToc.tsx` (modify — stub Listen + Ask follow-up)

**Description:**
Dynamic route. Mark-as-read via small client-wrapper useEffect on first mount (PATCH /briefs/:id {read: true}). Refine buttons async: POST /briefs/:id/refine → sonner toast "Refining..." → SSE `brief_created` event arrives → list invalidates. "Ask follow-up" and "Listen" → sonner toasts.

**Tasks:**
1. [ ] Remove generateStaticParams stub
2. [ ] `briefs/[id]/page.tsx` async: fetch `briefsApi.get(params.id)` → 404 if missing
3. [ ] Client wrapper: useEffect on mount → `briefsApi.patchRead(id, true)`, fire-and-forget
4. [ ] BriefSources refine buttons (Shorter/Longer/etc.): `useMutation(briefsApi.refine)` + sonner toast with spinning state
5. [ ] BriefToc: stub Listen + Ask follow-up with sonner toasts

**Acceptance Criteria:**
- [ ] /briefs/{id} loads real brief with TOC + body_html + sources
- [ ] /briefs/{random-uuid} shows 404
- [ ] Mark-as-read fires on view (verified via DB)
- [ ] Refine enqueues job, toast shows, new brief appears in /briefs list via SSE

**Notes:**
Mark-as-read on EVERY mount is correct for MVP (user returning to a read brief is no-op since read_at stays set). PATCH read: false (mark-unread) is supported but no UI trigger in M2 — add via dropdown in M3.

---

#### 8.4 M3 handoff document
**Status: PENDING**
**Requirement Refs:** A77, CS5
**Files Affected:**
- `M3_BACKLOG.md` (create)

**Description:**
Comprehensive backlog of everything deferred from M2. Each section has: acceptance criteria, estimated scope, prerequisites, reference to M2 context. Includes the /web inventory as appendix so future ports are informed.

**Tasks:**
1. [ ] Section: Commitments domain model (table + 2 endpoints + extraction skill + UI)
2. [ ] Section: entity-brief-skill (DOSSIER-kind briefs triggered from entity detail)
3. [ ] Section: TTS integration (Deepgram Aura vs ElevenLabs vs OpenAI TTS comparison)
4. [ ] Section: /search screen port from /web (synthesize + hybrid search)
5. [ ] Section: /timeline screen port
6. [ ] Section: /settings screen port (autonomy, email allowlist, integrations)
7. [ ] Section: 13 other /web screens (wiki, board, voice, email, ingest, financial, investments, intelligence, help, slack-cleanup, system, voice-upload, admin reset flow)
8. [ ] Section: Production cut-over (Docker packaging, Cloudflare Tunnel swap, /web decommission)
9. [ ] Section: PWA service worker + dark mode + keyboard shortcuts
10. [ ] Appendix: /web route inventory from planning session (20 routes)

**Acceptance Criteria:**
- [ ] M3_BACKLOG.md exists at repo root
- [ ] Every deferred item from M2 has an entry
- [ ] Each entry has acceptance criteria + prerequisites
- [ ] /web inventory appendix is comprehensive

**Notes:**
This is the last commit of M2. Write it carefully — future-you will refer to it when prioritizing M3. If any M2 decision proves wrong (unlikely), add a "Reconsider" section at the top of the relevant M3 item.

---

### Phase 8 Testing Requirements

- [ ] All 5 screens load with real data end-to-end
- [ ] Playwright smoke test (Phase 3) passes (QuickCapture flow)
- [ ] Manual screenshot of each screen before closing phase
- [ ] Refine flow proven E2E: click refine → toast → SSE arrival → new brief in list
- [ ] Merge flow proven E2E: select target → confirm → redirect

### Phase 8 Completion Checklist

- [ ] All 4 work items COMPLETE
- [ ] All 5 screens pixel-verified against M1 reference (no regressions beyond intentional placeholder changes)
- [ ] LAB_NOTEBOOK entry marking M2 complete
- [ ] M3_BACKLOG.md committed
- [ ] Operational runbooks documented: migration 0030 applied, backfill run, scheduled skills running

---

<!-- END PHASES -->

---

<!-- BEGIN TABLES -->

## Parallel Work Opportunities

| Work Item | Can Run With | Notes |
|-----------|--------------|-------|
| 1.3 (formatters) | 1.4 (test scaffolding) | Pure leaf-nodes, no dependencies |
| 5.1 (renderer) | 5.2 (routes + service) | Renderer is shared; routes call it |
| 6.1 (weekly+sweep) | 6.2 (morning+monthly) | Independent skill files |
| 7.1 (related) | 7.2 (timeline) | Independent entity endpoints |
| 7.1–7.3 (CS3 backend) | 7.4–7.5 (CS4 dashboard+entities) | Different packages |
| 8.1 (entity detail) | 8.2 (briefs library) | Different routes, shared modals infra |
| 8.4 (M3 backlog) | Any Phase 8 item | Pure documentation |

## Risk Mitigation

| Risk | Likelihood | Impact | Mitigation Strategy |
|------|------------|--------|---------------------|
| BaseSkill signature change silently breaks a subclass | Medium | High | Full grep + typecheck + test suite in 4.3; atomic commit; rollback = revert PR |
| `@open-brain/shared` accidental import leaks runtime deps | Medium | High | Defense-in-depth: drift-guard test (1.5) + ESLint rule (1.6). Either catches the regression. |
| Markdown renderer sanitization breaks legit content | Low | Medium | Unit tests with 10+ realistic fixtures (5.1). Iterate if false-positives found. |
| Refine LLM quality poor (Option 2) | Medium | Medium | Start with preset prompts; if quality fails, A/B with Option 1 (full skill re-run) for specific kinds. Rollback path: disable refine UI, document as known issue. |
| Next.js 16 `unstable_retry` miss (copy-paste from N14/15) | Low | Low | Flag in PR template + 2.3 task list. TS build catches it. |
| `outputFileTracingRoot` missing in pnpm monorepo | Low | Low | 1.2 task explicit. Only manifests on Docker build (M3+). |
| SSE reconnect retries forever during outage | Low | Low | 5-attempt cap in 3.1. User gets `connection_lost` synthetic event; page refresh recovers. |
| Dashboard composite fetch: one failure kills page | Medium | Medium | 7.4 uses per-widget Suspense boundaries where practical; error.tsx handles full failure. |
| Mark-as-read useEffect fires twice (React Strict Mode) | Low | Low | Fire-and-forget; idempotent on the server (read_at update twice is fine). |
| Entity /ask intersection <3 captures produces weak answer | Medium | Low | Fallback: widen to top-50 entity captures via FTS rank (documented in 7.3). |

## Success Metrics

- [ ] All 8 phases COMPLETE
- [ ] All 27 work items acceptance criteria met
- [ ] Build passes across shared/core-api/workers/web-next (`pnpm -r build`)
- [ ] Full test suite passes (Vitest + integration + Playwright smoke)
- [ ] Migration 0030 applied on homeserver without data loss
- [ ] Backfill script creates briefs for historical skill runs
- [ ] All 5 Cloudscape screens load real data end-to-end via browser verification
- [ ] Zero regressions in existing `/web` (remains on original mock-free wiring)
- [ ] M3_BACKLOG.md published
- [ ] No `@open-brain/shared` imports in web-next (ESLint + drift-guard enforce)
- [ ] Every commit has a LAB_NOTEBOOK entry per CLAUDE.md rule

## Appendix: Requirement Traceability

| Requirement | Source | Phase | Work Item |
|-------------|--------|-------|-----------|
| D106: M2 scope = Option B | LAB_NOTEBOOK Entry 127 | All | All |
| D107: First-class briefs table | LAB_NOTEBOOK Entry 127, CS2 investigation | 4 | 4.1, 4.2 |
| D108: TanStack Query v5 + RSC | CS1 investigation | 2 | 2.2 |
| D109: Local type redeclaration + drift-guard | CS1 investigation | 1, 4 | 1.5, 1.6, 4.5 |
| D110: Refine Option 2 (generic LLM transform) | CS2 investigation | 6 | 6.4 |
| D111: Commitments deferred to M3 | CS2 investigation | 8 | 8.1 (placeholder), 8.4 (backlog) |
| D112: BaseSkill.logResult signature change | CS2 investigation | 4 | 4.3, 4.4 |
| D113: Radix Dialog + sonner | CS4 investigation | 1, 8 | 1.1, 8.1 |
| D114: Entity /ask TS-side intersection | CS3 investigation | 7 | 7.3 |
| D115: outputFileTracingRoot | CS1 investigation | 1 | 1.2 |
| CS1 rewrites + API_URL | CS1 investigation | 1 | 1.2 |
| CS1 typed api-client | CS1 investigation | 2 | 2.1 |
| CS1 SSE reconnect | CS1 investigation | 3 | 3.1 |
| CS1 error.tsx `unstable_retry` | CS1 investigation (Next.js 16 docs) | 2 | 2.3 |
| CS1 Vitest/MSW/Playwright | CS1 investigation | 1 | 1.4 |
| CS2 migration 0030 | CS2 investigation | 4 | 4.1 |
| CS2 MEETING source type | CS2 investigation | 4 | 4.2, 4.6 |
| CS2 unified renderer | CS2 investigation | 5 | 5.1 |
| CS2 brief_created SSE | CS2 investigation | 5 | 5.3 |
| CS2 backfill script | CS2 investigation | 6 | 6.3 |
| CS3 /entities/:id/related | CS3 investigation | 7 | 7.1 |
| CS3 /mentions-timeline | CS3 investigation | 7 | 7.2 |
| CS3 /ask with SafePromptBuilder | CS3 investigation | 7 | 7.3 |
| CS3 rate-limit ordering | CS3 investigation | 7 | 7.3 |
| CS4 Dashboard wiring | CS4 investigation | 7 | 7.4 |
| CS4 Entities list URL params | CS4 investigation | 7 | 7.5 |
| CS4 Entity detail + modals | CS4 investigation | 8 | 8.1 |
| CS4 Briefs library dismiss | CS4 investigation | 8 | 8.2 |
| CS4 Brief reader refine + mark-read | CS4 investigation | 8 | 8.3 |
| CS5 M3 backlog document | CS5 | 8 | 8.4 |
| A76: Execute M2 | LAB_NOTEBOOK Entry 127 | All | All |
| A77: Write M3 backlog | LAB_NOTEBOOK Entry 127 | 8 | 8.4 |
| A78: BaseSkill subclass cascade | LAB_NOTEBOOK Entry 127 | 4 | 4.3, 4.4 |
| A79: ESLint rule blocking shared import | LAB_NOTEBOOK Entry 127 | 1 | 1.6 |

<!-- END TABLES -->

---

*Implementation plan generated by Claude on 2026-04-21*
*Source: /create-plan command, derived from ultra-plan Phase 3 solution design + LAB_NOTEBOOK Entry 127*
