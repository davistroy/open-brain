# Implementation Plan: 11-Issue Cohesive Remediation

**Date:** 2026-05-09
**Source:** Ultra-plan analysis of GitHub issues #177, #190, #191, #192, #193, #194, #195, #197, #198, #199, #200
**Scope:** Production-bug fixes (4) + tech-debt closeouts (7), sequenced by interaction dependencies
**Risk:** Medium — Phase A is on production; Phases F, G.2 touch broad test/lint infra; rest is contained
**Rollback:** Per-phase, see Risk table below

> **Authoritative tracker:** GitHub issues. Every phase ends with `Closes #N` in the merge commit.
> **Lab Notebook:** Each PR requires a `LAB_NOTEBOOK.md` entry BEFORE the first commit.

---

## Pre-flight Unknowns to Resolve (BEFORE starting Phase A)

| # | Question | How to resolve |
|---|---|---|
| U1 | Does `spark-llm` accept JSON-mode entity-extraction prompts? | `curl http://spark.k4jda.net:8000/v1/chat/completions -d '{"model":"spark-llm","messages":[{"role":"user","content":"Return JSON: {\"entities\":[]}"}],"response_format":{"type":"json_object"}}'` — expect 200 with valid JSON |
| U2 | Container `open-brain-web-next` timezone? | `ssh claude@homeserver "docker exec open-brain-web-next date '+%H %Z'"` — if UTC, must add `TZ=America/New_York` to web-next service env in B.1 |
| U3 | Homeserver capacity for observability profile? | `ssh claude@homeserver "free -m && df -h /mnt/user/appdata"` — need ≥ 2 GB free RAM, ≥ 5 GB free disk |
| U4 | Are 744 failed-job reasons all model-name 404s? | Spot-check 1-2 failed jobs per affected queue (extract-entities, skill-execution, embed-capture, ingest-root) — see A.5 commands |
| U5 | Does Vitest 2.x break the Windows `pool: 'forks'` profile? | Read https://vitest.dev/guide/migration; smoke-test `pnpm test` on Windows VM after F.1 |
| U6 | ESLint 9 lint-error budget across web-next? | Run flat-config on full tree before merging G.2 |

**Gate:** U1, U2, U3, U4 must be resolved before Phase A starts. U5, U6 resolved within their own phases.

---

# Phase A — Stop the Bleeding

**Atomic for code (A.1 + A.2 + A.5 = one PR); A.3 + A.4 = ops actions; ~2-3 h total.**

### A.1 Fix `t1_spark` model name (#200 root cause 1)

**File:** `config/ai-routing.yaml`

**Changes:**
- `t1_spark.model: "qwen3.5-35b"` → `model: "spark-llm"`
- Update inline comment from "35B Qwen model via vLLM" to "Qwen3.6-35B-A3B served as `spark-llm` via vLLM"

**Why:** vLLM at `spark.k4jda.net:8000/v1/models` exposes id `spark-llm` (root `Qwen/Qwen3.6-35B-A3B`). Current config requests `qwen3.5-35b` → 404 on every t1_spark call → root cause of ~700 of 744 failed jobs.

**Acceptance:**
- [ ] `grep -n 'spark-llm' config/ai-routing.yaml` returns the new line
- [ ] `pnpm --filter @open-brain/shared exec tsc --noEmit` clean (ConfigService schema OK)
- [ ] After deploy: `ssh claude@homeserver "docker logs --since 5m open-brain-workers 2>&1 | grep 'qwen3.5-35b' | wc -l"` returns `0`
- [ ] Test enqueue: `curl -X POST -H 'X-Open-Brain-Caller: integration-test' .../api/v1/captures -d '...'` → pipeline_status reaches `complete`

**Deploy:** `docker compose restart core-api workers` (config mounted RO; no image rebuild)

---

### A.2 Fix `metadata` → `source_metadata` column typo (#200 root cause 2)

**File:** `packages/core-api/src/services/system-health.ts`

**Changes:**
- Line 431 TS interface field: `metadata: Record<string, unknown> | null` → `source_metadata: Record<string, unknown> | null`
- Lines 432-438 SQL: `SELECT id, pipeline_status, created_at, metadata` → `... source_metadata`
- Line 473: `(r.metadata as Record<string, unknown>)?.trace_id` → `r.source_metadata?.trace_id`

**Why:** `\d captures` confirms column is `source_metadata`. Current query throws → catch → returns `[]` → System → Flows tab silently empty.

**Acceptance:**
- [ ] `pnpm --filter @open-brain/core-api exec tsc --noEmit` clean
- [ ] Updated `system-health.test.ts` integration test: insert real captures with `source_metadata`, call `getPipelineFlows()`, assert non-empty array with `trace_id` populated when present
- [ ] `pnpm --filter @open-brain/core-api test system-health` green
- [ ] After deploy: `curl -s https://brain.troy-davis.com/api/v1/system/flows | jq '. | length'` > 0

---

### A.3 Cloudflare Access bypass for PWA assets (#198 root cause 2)

**Action (operator-driven, not code):**

1. CF Zero Trust → Access → Applications → `brain.troy-davis.com`
2. Add policy: `Action: Bypass`, `Name: PWA assets`, `Include: Everyone`
3. Path includes (one rule each): `/manifest.json`, `/icons/*`, `/sw.js`, `/favicon.ico`, `/apple-touch-icon.png`
4. **Position policy ABOVE** existing auth policies (CF evaluates top-down)
5. Save

**Why:** PWA assets are public-by-design (browsers fetch without auth). CF Access currently 302-redirects unauthenticated requests, violating CORS.

**Acceptance:**
- [ ] `curl -sI https://brain.troy-davis.com/manifest.json | head -1` returns `HTTP/2 200` (not `302`)
- [ ] `curl -sI https://brain.troy-davis.com/icons/icon-192.png | head -1` returns `HTTP/2 200`
- [ ] `curl -sI https://brain.troy-davis.com/admin/reset-data | head -1` STILL returns `302` or `403` (auth path NOT inadvertently bypassed)
- [ ] DevTools Network tab on dashboard load: 0 manifest CORS errors

---

### A.4 Enable Slack DMs (#199)

**Action (operator-driven, not code):**

1. https://api.slack.com/apps → select Open Brain app
2. **App Home** → Show Tabs → **Messages Tab** → enable toggle
3. Enable **"Allow users to send Slash Commands and messages from the messages tab"**
4. Save

**Why:** Slack workspace setting was OFF. Bot itself is healthy (Socket Mode connected, 0 errors in 24h logs).

**Acceptance:**
- [ ] DM `!help` from Troy's account → expect bot help-text response within 2 seconds
- [ ] `@Open Brain ping` in a channel → still works (regression check)

---

### A.5 Failed-jobs cleanup (AFTER A.1 deploy verified)

**Step 1 — Spot-check failure reasons (resolves U4):**
```bash
ssh claude@homeserver bash -lc '
  for q in extract-entities skill-execution embed-capture ingest-root document-pipeline extract-commitments; do
    echo "=== $q ==="
    docker exec open-brain-redis redis-cli ZRANGE "bull:$q:failed" 0 1 | while read jobid; do
      docker exec open-brain-redis redis-cli HGET "bull:$q:$jobid" failedReason
      echo
    done
  done
'
```

Expected: all `qwen3.5-35b does not exist` (or similar 404). If ANY are different (rate limits, OpenAI 5xx, etc.), pause and investigate before clearing.

**Step 2 — Clear via System UI:**
- Open https://brain.troy-davis.com/system → Queues tab
- Click "Clear failed" for each affected queue (preserves audit log via core-api)

**Acceptance:**
- [ ] Failure-reason audit completed; all 6 queues confirmed model-name root cause
- [ ] System dashboard shows "0 failed jobs"
- [ ] Daily-sweep at 3 AM next morning re-queues any orphaned `pipeline_status='processing'` rows
- [ ] 24h later: failed count remains < 5 (false-positive floor)

---

## Phase A Verification (gate before Phase B)

- [ ] System dashboard: `744 failed jobs` → `0`
- [ ] Dashboard top-right pipeline badge: still `Degraded` (Pushgateway issue remains; cleared in Phase D)
- [ ] DM bot from Slack works
- [ ] Browser DevTools on dashboard: 0 manifest CORS errors
- [ ] `LAB_NOTEBOOK.md` entry recorded for the deploy

---

# Phase B — UI Hydration Unification (atomic)

**One PR. ~1.5 h. Closes #197, #198 (RC1 only).**

### B.1 Time-aware greeting (#197)

**Pre-flight:** Resolve U2. If `docker exec open-brain-web-next date` shows UTC, add `TZ=America/New_York` to `web-next` service env in `docker-compose.yml` AS PART OF THIS PR.

**File:** `packages/web-next/lib/greeting.ts` (NEW)

```ts
export function getGreeting(now: Date = new Date()): string {
  const h = now.getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}
```

**File:** `packages/web-next/lib/__tests__/greeting.test.ts` (NEW)
- Table-driven test for hours: 0, 5, 6 (boundary), 11, 12 (boundary), 16, 17 (boundary), 23

**File:** `packages/web-next/app/(shell)/dashboard/page.tsx`
- Line 41: `title="Good morning, Troy"` → `title={\`${getGreeting()}, Troy\`}`
- Add import: `import { getGreeting } from '@/lib/greeting'`

**File:** `packages/web-next/components/dashboard/DashboardEmptyState.tsx`
- Line 18: same change

**Acceptance:**
- [ ] `pnpm --filter @open-brain/web-next test greeting` all 8 cases green
- [ ] Server vs. client tz match: `docker exec open-brain-web-next date '+%H'` equals user's local hour
- [ ] Dashboard renders correct greeting at each tested hour (manual visual)

---

### B.2 Hydration audit for `new Date()` patterns (#198 RC1)

**File:** `packages/web-next/components/dashboard/RecentCaptures.tsx`

**Change at line 35:**
- Move `const now = new Date()` out of the client component
- Pass `now: Date` (or `nowMs: number`) as a **prop** from the server-rendered parent (`dashboard/page.tsx`):
  ```tsx
  // page.tsx (RSC)
  const now = new Date()
  return <RecentCaptures captures={captures} now={now} />
  ```
- Update `formatCapturedAt(isoDate: string, now: Date)` signature to take `now` as a param

**Audit pass:**
```bash
grep -rn 'new Date()\|Date.now()' \
  packages/web-next/components packages/web-next/app \
  | grep -v test | grep -v "'use client'"
```
For each remaining hit:
- If in a Server Component → OK (RSC renders once)
- If in a `'use client'` component → fix by passing `now` from server parent OR move to `useEffect`

**Acceptance:**
- [ ] `grep` audit shows zero `new Date()` calls inside `'use client'` files (except inside `useEffect`/event handlers)
- [ ] Browser DevTools console on dashboard load: 0 React hydration warnings (`Error: Hydration failed`, `Warning: Text content did not match`)
- [ ] React error #418 absent from production console

---

## Phase B Verification (gate before Phase C)

- [ ] Greeting respects time of day at all boundary hours
- [ ] No console hydration errors on any page in `(shell)`
- [ ] LAB_NOTEBOOK entry
- [ ] Closes #197, #198

---

# Phase C — Settings GET Semantics + Frontend Cleanup (atomic)

**One PR. ~30 min. Closes the noise channel from #200 RC4.**

### C.1 `GET /api/v1/settings/:key` returns 200 with null when missing

**File:** `packages/core-api/src/routes/settings.ts`

**Changes:**
- Lines 80-82 (the `if (rows.length === 0)` branch):
  ```ts
  // BEFORE: throw new NotFoundError(`Setting not found: ${key}`)
  // AFTER:
  return c.json({ key, value: null, updated_at: null })
  ```
- Whitelist check (line 76-78) UNCHANGED — still 400 on unknown key

**File:** `packages/core-api/src/__tests__/settings-routes.test.ts`

**Changes:**
- Update test "A110: GET enforces VALID_SETTINGS_KEYS whitelist":
  - Keep 400 assertion for unknown key
  - **Change** missing-row assertion from 404 to 200 with body `{ key: <key>, value: null, updated_at: null }`
- Add new test: "GET returns 200 with null value when settings key whitelisted but no row exists"

**Why:** Frontend already treats missing as default via `.catch()`. Server should match. Eliminates 6 NotFoundError logs per dashboard load.

---

### C.2 Frontend cleanup — drop `.catch` workarounds

**File:** `packages/web-next/components/settings/IngestFiltersSection.tsx`

**Changes:**
- Lines ~186-195 and similar: drop `.catch(() => ({ key, value: <default> }))` plumbing
- Read defaults from a single `DEFAULTS` const at top of file
- Use `data?.value ?? DEFAULTS[key]` pattern

**File:** `packages/web-next/components/settings/EntityExtractionSection.tsx`
- Same pattern

**Acceptance:**
- [ ] `pnpm --filter @open-brain/core-api test settings-routes` green (updated assertions)
- [ ] `curl -s https://brain.troy-davis.com/api/v1/settings/ingest_voice_min_duration | jq '.value'` returns `null` (not 404)
- [ ] After deploy: 1 minute of dashboard load → core-api logs show 0 `Setting not found:` entries
- [ ] Settings → Sources page renders correctly with default values; toggling persists

---

## Phase C Verification

- [ ] LAB_NOTEBOOK entry
- [ ] Closes #200 RC4 (partial close — still need D for full #200 closeout)

---

# Phase D — Observability Profile Bring-Up

**Ops action + (optional) defense-in-depth code. ~30 min. Closes #200 RC3 + final piece of #200.**

### D.1 (PRIMARY) Bring up observability profile

**Pre-flight (resolves U3):**
```bash
ssh claude@homeserver "free -m && df -h /mnt/user/appdata"
```
Required: ≥ 2 GB free RAM, ≥ 5 GB free disk.

**Action:**
```bash
ssh claude@homeserver "cd /mnt/user/appdata/open-brain && \
  docker compose --profile observability up -d"
```

**Acceptance:**
- [ ] `docker ps | grep -E 'pushgateway|prometheus|grafana'` — all "Up"
- [ ] After 10 min: `docker logs --since 5m open-brain-workers 2>&1 | grep ENOTFOUND | wc -l` → `0`
- [ ] After next `PipelineHealthSkill` run: log shows `healthy: true`
- [ ] System dashboard pipeline badge: `Degraded` → `Healthy`
- [ ] `LAB_NOTEBOOK.md` entry: closes P12 pending ops
- [ ] `MEMORY.md` updated to remove "P12 — `docker compose --profile observability up -d`" from pending ops

---

### D.2 (FALLBACK only — skip if D.1 succeeds)

**Triggered only if D.1 is operationally infeasible.**

**File:** `packages/workers/src/lib/push-metrics.ts`
- Demote `getaddrinfo ENOTFOUND` from `warn` to `debug`

**File:** `packages/workers/src/jobs/pipeline-health.ts`
- Don't set `healthy: false` purely on `pushMetrics` failure — gate on `recentFailureCount` and queue depth

**Acceptance:** (only if executed)
- [ ] Workers log noise reduced
- [ ] `PipelineHealthSkill` reports `healthy: true` when actual health is good

---

# Phase E — Small Verifications

**Two small PRs. ~1.5 h total. Closes #191, #194. #193 closed without code (DEFER decision documented).**

### E.1 Close out IMPLEMENTATION_PLAN.md (#191)

**Audit-only. ~30 min.**

**Commands to run:**
```bash
pnpm --filter @open-brain/core-api test
pnpm --filter @open-brain/workers test
grep -rn 'gpt-4\|claude-3\|text-embedding' packages/ --include='*.ts' \
  | grep -v 'test\|ai-routing\|config'
```
Expected: tests green, grep returns 0 hits in app code.

**File:** `IMPLEMENTATION_PLAN.md`
- Tick boxes in lines 26, 47, 109, 144-149
- Add header line: `**Status: COMPLETE (verified 2026-05-09)**`

**File:** `OPEN_ITEMS.md`
- Move #191 row to "Recently-closed" section (or delete, since GitHub is authoritative)

**Acceptance:**
- [ ] All test suites green
- [ ] No hardcoded model strings in app code
- [ ] Plan marked COMPLETE
- [ ] PR with `Closes #191`

---

### E.2 Fix TS2502 in entity-resolution.test.ts:345 (#194)

**File:** `packages/workers/src/__tests__/entity-resolution.test.ts`

**Changes:**
- Read line 345 — identify root cause (likely circular `infer` in mock generic)
- Choose:
  - (a) Add explicit type annotation if structural fix is small
  - (b) Add `// @ts-expect-error TS2502 — <one-line reason>` if (a) is invasive

**Acceptance:**
- [ ] `pnpm --filter @open-brain/workers exec tsc --noEmit` clean
- [ ] `pnpm --filter @open-brain/workers test entity-resolution` green
- [ ] PR with `Closes #194`

---

### E.3 SSE onAbort coverage (#193) — DEFER

**No code change.** Add comment to issue documenting decision:
> "Option 1 (leave `/* v8 ignore */`) accepted. SSE abort branches require real client abort mid-stream which vitest env can't trigger; the `/* v8 ignore */` is intentional and documented per A117. Closing as won't-fix (intentional) — solo project, low value."

**Acceptance:**
- [ ] Issue closed with comment
- [ ] CLAUDE.md unchanged

---

# Phase F — Vitest 2.x Bump

**One PR. ~1 h. Closes #192.**

### F.1 Bump deps

**Workspace root:**
```bash
pnpm -w add -D vitest@^2 @vitest/coverage-v8@^2
```

Confirm cascade across all workspace packages (shared, core-api, workers, voice-capture, web-next). Commit `pnpm-lock.yaml`.

---

### F.2 Migration audit (resolves U5)

**Read:** https://vitest.dev/guide/migration

**Known breakers to verify:**
1. `pool: 'forks'` config — Vitest 2.x may have moved sub-options under `poolOptions.forks`. Verify CLAUDE.md's `minForks: 1, maxForks: N` Windows profile still works.
2. `hookTimeout`/`testTimeout` — no breaking change expected, but confirm.
3. Mock semantics — verify `vi.mock`, `vi.hoisted` patterns used in `core-api/__tests__/*` still work.

**Files to update (if migration requires):**
- `packages/shared/vitest.config.ts`
- `packages/core-api/vitest.config.ts`
- `packages/core-api/vitest.config.integration.ts`
- `packages/workers/vitest.config.ts`
- `packages/voice-capture/vitest.config.ts`
- `packages/web-next/vitest.config.ts`

---

### F.3 Per-file glob coverage thresholds

**File:** `packages/workers/vitest.config.ts`

**Add:**
```ts
coverage: {
  provider: 'v8',
  thresholds: {
    lines: 78,
    functions: 81,
    'src/lib/entity-resolver.ts': { lines: 95, functions: 95 },
    'src/skills/email-compose/**': { lines: 90, functions: 90 },
    // Add 2-3 more per high-coverage measurement
  }
}
```

**Selection criteria:** files currently > 90% coverage; pin floor at current measurement to prevent regression. Do NOT lower the package-level floor (78/81).

---

## Phase F Verification

- [ ] `pnpm -r test` green across all 5 packages
- [ ] CI `Integration tests (core-api + real DB)` green
- [ ] Workers coverage threshold check still gates CI at 78/81 floor
- [ ] CLAUDE.md updated if `pool` config syntax changed
- [ ] LAB_NOTEBOOK entry
- [ ] PR with `Closes #192`

---

# Phase G — Hooks → ESLint 9 → RTL (sequential)

**Three sequenced PRs (G.1 split into multiple sub-PRs). ~6-10 h total. Closes #177, #190, #195.**

### G.1 TanStack Query hooks per API domain (#177)

**Scope:** ALL 22 domains in `packages/web-next/lib/api/` (uniform application per user direction).

**Sub-PRs (one domain per PR for reviewability):**

For each domain `<d>` in `lib/api/`:

**File:** `packages/web-next/lib/api/<d>.hooks.ts` (NEW) OR collocate in `<d>.ts`

**Pattern:**
```ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { fetchX, createX, updateX } from './<d>'

export function useX(params: ...) {
  return useQuery({ queryKey: ['<d>', 'x', params], queryFn: () => fetchX(params) })
}

export function useCreateX() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: createX,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['<d>'] }),
  })
}
```

**Migration per consumer:**
1. `grep -rn '<d>Api\.' packages/web-next/components packages/web-next/app`
2. For each consumer, replace inline `useQuery({ queryKey, queryFn: () => <d>Api.fetchX(...) })` with `useX(...)`
3. Mutation patterns: replace inline `useMutation({ mutationFn: <d>Api.createX, ... })` with `useCreateX()`

**Domain order (alphabetical for consistency, batched 2-3 per PR for high-traffic, individual PRs for write-heavy):**
1. captures, search, briefs, intelligence (high-traffic batch)
2. settings, entities, system-health, mcp-activity (mid batch)
3. email-drafts, wiki, ingest, voice (mid batch)
4. governance, sessions, board, financial (mid batch)
5. (remaining 6 domains as 2-3 PRs)

**Acceptance per sub-PR:**
- [ ] New hooks file added with consistent pattern
- [ ] Consumers migrated (all hits from grep)
- [ ] `pnpm --filter @open-brain/web-next test` green
- [ ] Visual smoke of affected pages (load page, verify data renders, mutation paths still work)
- [ ] No regressions in TanStack Query devtools cache keys

**Final sub-PR acceptance:**
- [ ] All 22 domains have hooks file (or documented exception for write-only)
- [ ] Zero inline `useQuery`/`useMutation` constructions remain in components/pages calling api-client functions
- [ ] PR with `Closes #177`

---

### G.2 ESLint 9 + flat-config migration (#190)

**Pre-req:** G.1 fully shipped (file restructure stable).

**File:** Convert `packages/web-next/.eslintrc.json` → `packages/web-next/eslint.config.mjs` (flat-config form)

**Reference:** Next.js 16 ESLint 9 flat-config docs (use Context7 to fetch current syntax).

**Deps to bump:**
```bash
pnpm --filter @open-brain/web-next add -D \
  eslint@^9 eslint-config-next@^16
```

Audit + bump if needed:
- `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`
- `eslint-plugin-react`, `eslint-plugin-react-hooks`
- Any other web-next-specific plugins

**Lint-error budget (resolves U6):**
- Run `pnpm --filter @open-brain/web-next lint` against full tree
- Triage errors:
  - Auto-fixable: `pnpm lint --fix`
  - Trivial manual: fix in same PR
  - Nontrivial (suggest scope split): if > 50 manual errors remain, split into separate "G.2-followup" PR

**File:** `CLAUDE.md`
- Remove the rule: "**`eslint-config-next` MUST stay at `^15.0.0` until A130 lands**" (lines documented in the Testing/CI section)

**File:** `OPEN_ITEMS.md`
- Mark A130 closed (if listed independently)

**Acceptance:**
- [ ] `pnpm --filter @open-brain/web-next lint` exits 0
- [ ] CI `build-and-test` job green (Phase 8b enabled this; see CLAUDE.md branch-protection section)
- [ ] CLAUDE.md rule removed
- [ ] LAB_NOTEBOOK entry
- [ ] PR with `Closes #190`

---

### G.3 Migrate MPill/TabBar tests to RTL (#195)

**Pre-req:** G.2 shipped (ESLint 9 active).

**Files:** `packages/web-next/src/__tests__/MPill.test.tsx`, `TabBar.test.tsx`

**Migration:**
- Rewrite tests using `@testing-library/react` (`render`, `screen.getByRole`, `userEvent`)
- Drop `react-test-renderer` imports
- Verify tests cover the same assertions

**Audit other consumers of `react-test-renderer`:**
```bash
grep -rn 'react-test-renderer' packages/web-next/src
```
If zero remaining, drop deps:
```bash
pnpm --filter @open-brain/web-next remove react-test-renderer @types/react-test-renderer
```

**Acceptance:**
- [ ] `pnpm --filter @open-brain/web-next exec tsc --noEmit` clean (no TS2345)
- [ ] `pnpm --filter @open-brain/web-next test MPill TabBar` green
- [ ] If applicable: `react-test-renderer` removed from package.json
- [ ] LAB_NOTEBOOK entry
- [ ] PR with `Closes #195`

---

# Risk Assessment Summary

| Phase | Risk | Mitigation | Rollback |
|---|---|---|---|
| A.1 | Wrong model name → continued failures | Resolve U1 before commit | `git revert` ai-routing.yaml + `docker restart` |
| A.2 | Low (read-only query, returns []) | Unit + integration test | `git revert` |
| A.3 | CF policy too broad → admin paths leak | Path-specific bypass; verify `/admin/*` still redirects | Disable CF Access policy |
| A.4 | Low (admin UI only) | Manual smoke test | Disable Slack toggle |
| A.5 | Clearing destructive | Spot-check failedReason first (Step 1) | Restore Redis from snapshot |
| B | Container TZ ≠ user TZ → hydration mismatch | Resolve U2; add TZ env in same PR if needed | `git revert` |
| C | Other consumers of GET /settings/:key broke | grep usage; update test A110 | `git revert` route + tests |
| D.1 | Resource pressure on homeserver | Resolve U3 before bring-up | `docker compose --profile observability down` |
| E.1, E.2 | Low (audit + tiny test fix) | n/a | `git revert` |
| F | Vitest 2.x breaks pool/hooks | Resolve U5; per-package smoke | Revert deps + lockfile |
| G.1 | Consumer migration error | One domain per PR; CI gates | Revert per-PR |
| G.2 | ESLint 9 surfaces many errors blocking CI | Resolve U6; dedicated session; consider followup PR | Revert + re-pin to ^15 |
| G.3 | Low (test-only) | One test at a time | `git revert` |

---

# Implementation Sequence + Time Estimates

| Day | Phase | Effort | Gate before next |
|---|---|---|---|
| 1 | A (1 PR + 2 ops) | 2-3 h | Failed jobs = 0 |
| 1-2 | B (1 PR) | 1.5 h | No console hydration errors |
| 2 | C (1 PR) | 30 min | 0 NotFoundError logs |
| 2 | D (ops) | 30 min | 0 ENOTFOUND logs; pipeline = Healthy |
| 2-3 | E.1, E.2 (2 small PRs) | 1.5 h | Tests green; #193 closed via comment |
| 3-4 | F (1 PR) | 1 h | CI green |
| 4-7 | G.1 (multiple sub-PRs) | 4-6 h | All 22 domains |
| 7-8 | G.2 (1 PR) | 1.5-2 h | `pnpm lint` exits 0 |
| 8 | G.3 (1 PR) | 30 min | TS clean |

**Total active effort:** ~14-18 h spread over 5-8 working days. Most of the lapsed time is CI runs and waiting for verification.

---

# Scope Boundaries

**In scope:** All 11 GitHub issues. CF Access policy. Slack admin UI. Observability profile bring-up. Failed-jobs cleanup.

**Explicitly OUT of scope:**
- Spark vLLM `--served-model-name` change (Spark project is standalone)
- New entity-extraction features
- Mobile app work
- Wiki content updates
- A107 / A116 follow-on improvements not in these 11 issues
- Voice architecture decision (#54, #57)
- P23 cognitive memory tuning (#71 — data-gated)
- P33 Qdrant evaluation (#73 — scale-gated)
- P34 RTX PRO deployment (#72 — hardware decision)

**Recommended follow-up after this plan:**
- If G.2 surfaces > 50 lint errors, schedule a "G.2-followup" cleanup
- Re-run `/personal-plugin:plan-improvements` after G ships to identify the next refactor wave
- Revisit P23 around 2026-05-17 when sufficient cognitive-memory data accumulates

---

# Definition of Done (Runnable)

| Phase | Check | Command |
|---|---|---|
| A.1 | Config grep | `grep -n 'spark-llm' config/ai-routing.yaml` |
| A.1 | Worker logs | `ssh claude@homeserver "docker logs --since 5m open-brain-workers \| grep qwen3.5-35b \| wc -l"` (= 0) |
| A.2 | Typecheck | `pnpm --filter @open-brain/core-api exec tsc --noEmit` |
| A.2 | Unit | `pnpm --filter @open-brain/core-api test system-health` |
| A.2 | Integration | `curl -s https://brain.troy-davis.com/api/v1/system/flows \| jq '. \| length'` (> 0) |
| A.3 | CF bypass | `curl -sI https://brain.troy-davis.com/manifest.json \| head -1` (= `HTTP/2 200`) |
| A.3 | Admin not bypassed | `curl -sI https://brain.troy-davis.com/admin/reset-data \| head -1` (= `HTTP/2 302` or `403`) |
| A.5 | Failed count | `redis-cli ZCARD bull:extract-entities:failed` (= 0) |
| B.1 | Greeting unit | `pnpm --filter @open-brain/web-next test greeting` |
| B.1 | TZ match | `ssh claude@homeserver "docker exec open-brain-web-next date '+%H'"` matches client hour |
| B.2 | Hydration grep | `grep -rn 'new Date()\|Date.now()' packages/web-next/components packages/web-next/app \| grep -v test` (only RSC or useEffect hits) |
| C.1 | Settings unit | `pnpm --filter @open-brain/core-api test settings-routes` |
| C.1 | Settings integration | `curl -s https://brain.troy-davis.com/api/v1/settings/ingest_voice_min_duration \| jq '.value'` (= `null`) |
| D.1 | Containers | `ssh claude@homeserver "docker ps \| grep -E 'pushgateway\|prometheus\|grafana' \| wc -l"` (>= 3) |
| D.1 | DNS | `ssh claude@homeserver "docker logs --since 5m open-brain-workers \| grep ENOTFOUND \| wc -l"` (= 0) |
| E.1 | Hardcoded models | `grep -rn 'gpt-4\|claude-3\|text-embedding' packages/ --include='*.ts' \| grep -v 'test\|ai-routing\|config'` (= 0 hits) |
| E.2 | Workers TS | `pnpm --filter @open-brain/workers exec tsc --noEmit` |
| F | All tests | `pnpm -r test` |
| G.1 | Web tests | `pnpm --filter @open-brain/web-next test` |
| G.2 | Web lint | `pnpm --filter @open-brain/web-next lint` |
| G.3 | Web TS | `pnpm --filter @open-brain/web-next exec tsc --noEmit` |
