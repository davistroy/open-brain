# IMPLEMENT_PHASE-P07 — Internal traffic hygiene

**Source card:** PHASED_PLAN.md § P07
**Tracks issues:** #114 (High — rate-limit self-contention) + #117 (Medium — job thunderstorm)
**Effort estimate:** ~4 hours
**Branch (Gate 2 will create):** `feat/phase-P07-internal-traffic-hygiene`
**Gate 5 path:** operator-approval required — nginx.conf (live production traffic path) + rate-limit.ts (security middleware) + scheduler cron changes

---

## Investigation findings

### Current BYPASS_CALLERS + rate-limit tiers

**File:** `packages/core-api/src/middleware/rate-limit.ts`

Current `BYPASS_CALLERS` Set (lines 159–167):
- `internal:integration-test`
- `internal:web-ui`
- `internal:email-worker`
- `internal:financial-pipeline`
- `internal:utility-pipeline`
- `internal:ingest`

Key format is `internal:<caller-value>` — `getClientKey` at line 136 prepends `internal:` when the header is present. Header read via `headers.get('x-open-brain-caller')` (case-insensitive via Fetch API normalization).

Rate-limit tiers:
- `default`: 100 req/min (all `/api/v1/*`)
- `strict`: 20 req/min (`/captures`, `/search`, `/synthesize`)
- `admin`: 5 req/min (`/admin/*`)

Bypass is all-or-nothing (no per-caller limit). Card says "appropriate limit"; for single-user system, full bypass is appropriate. Per-caller tiering deferred.

### Internal caller inventory

**Already set header (6 callers):**
- `email-classify` — `packages/workers/src/skills/email-classify.ts:493` → `'email-classify'`
- `email-compose-skill` — `packages/workers/src/skills/email-compose.ts:190` → `'email-compose-skill'`
- `batch-wiki-ingest.py` — `scripts/batch-wiki-ingest.py` → `'batch-wiki-ingest'`
- `email-pipeline.py` — `scripts/email-pipeline.py:730` → `'email-pipeline'`
- `ingest-onedrive.py` — via `scripts/lib/capture_api.py:67` → `'ingest-onedrive'`
- `ingest-repair.py` — via `scripts/lib/capture_api.py` → `'ingest-repair'`

None of the 6 are in BYPASS_CALLERS today. All currently get the default 100 req/min or strict 20 req/min, depending on endpoint.

**Missing header (9 callers must be added):**
- `packages/slack-bot/src/lib/core-api-client.ts` — central `request()` (line 41) → `'slack-bot'`
- `packages/voice-capture/src/services/ingest.ts:57` → `'voice-capture'`
- `packages/workers/src/skills/memory-consolidation.ts:422` → `'memory-consolidation'` (named in card)
- `packages/workers/src/skills/daily-sweep-skill.ts:231` → `'workers'`
- `packages/workers/src/skills/daily-connections.ts:245` → `'workers'`
- `packages/workers/src/skills/drift-monitor.ts:269` → `'workers'`
- `packages/workers/src/skills/monthly-reflection.ts:457` → `'workers'`
- `packages/workers/src/skills/weekly-brief.ts:157` → `'workers'`
- `packages/workers/src/skills/base-skill.ts:15` — autonomy fetch → `'workers'`

Single `'workers'` value covers all skill fetches (same container); `memory-consolidation` keeps its own value (card specifies it by name, finer observability).

### Front-door config

**Architecture:**
```
Browser → Cloudflare Edge → cloudflared tunnel → web container (nginx:80) → core-api:3000
```

**No `config/cloudflare/nginx.conf`** — the front door is `packages/web/nginx.conf`. Cloudflare tunnel (`config/cloudflare/tunnel.yaml`) routes `brain.troy-davis.com → web:80`.

**Current nginx state:**
- `/api/` + `/api/v1/events` blocks: `proxy_set_header X-Open-Brain-Caller "web-ui"` — correctly **overwrites** any client-supplied value (nginx `proxy_set_header` for a given header name replaces client value).
- `/mcp` block: **NO** `proxy_set_header X-Open-Brain-Caller` — client-supplied header passes through unchanged. Bug: `X-Open-Brain-Caller: integration-test` on `/mcp` would bypass rate-limits.

**Fix:** add `proxy_set_header X-Open-Brain-Caller ""` to `/mcp` block. MCP clients get IP-based rate-limiting, not bypass.

### Scheduler 06:00-09:00 jobs (actual vs card)

**Card says "19 jobs"** in 06:00-09:00 window. **Actual audit: 7 jobs** in 06:00-08:15.

| Job | Current cron | Fires at |
|-----|-------------|----------|
| wiki-synthesis | `0 6 * * *` | 06:00 daily |
| daily-connections | `0 7 * * *` | 07:00 daily |
| capture-reminder-morning | `5 7 * * 1-5` | 07:05 weekdays |
| cost-analysis | `10 7 * * *` | 07:10 daily |
| morning-brief | `15 7 * * 1-5` | 07:15 weekdays |
| budget-check | `0 8 * * *` | 08:00 daily |
| drift-monitor | `15 8 * * *` | 08:15 daily |

**Real cluster:** 4 jobs within 15 minutes at 07:00 (daily-connections, capture-reminder-morning, cost-analysis, morning-brief). This is the CPU cliff.

**pipeline-health** (`0 */6 * * *`) fires at 06:00 via its every-6-hours pattern — lightweight HTTP check, not LLM, <5s runtime. Leave unchanged (changing pattern breaks 6-hour semantics).

### Scheduler proposed spread

| Job | Current | Proposed | New time |
|-----|---------|----------|----------|
| wiki-synthesis | `0 6 * * *` | `0 6 * * *` | 06:00 (anchor) |
| daily-connections | `0 7 * * *` | `10 6 * * *` | 06:10 daily |
| cost-analysis | `10 7 * * *` | `20 6 * * *` | 06:20 daily |
| morning-brief | `15 7 * * 1-5` | `30 6 * * 1-5` | 06:30 weekdays |
| capture-reminder-morning | `5 7 * * 1-5` | `45 6 * * 1-5` | 06:45 weekdays |
| budget-check | `0 8 * * *` | `0 7 * * *` | 07:00 daily |
| drift-monitor | `15 8 * * *` | `15 7 * * *` | 07:15 daily |

All 7 spread across 06:00-07:15, no two on same minute. CPU cliff eliminated.

**BullMQ upsert:** `repeat: { pattern }` + stable `jobId` upserts on next startup — no manual Redis flush.

### BullMQ worker concurrency

| Worker | Current | Target |
|--------|---------|--------|
| check-triggers | 5 | **2** |
| ingest-root | 3 | **2** |
| ingestion-worker | 3 | **2** |
| update-access-stats | 5 | **2** |
| budget-check | 1 | 1 (singleton) |
| daily-sweep | 1 | 1 (singleton) |
| skill-execution | 1 | 1 (LLM-heavy, documented) |
| prune-associations | 1 | 1 (singleton) |
| wiki-ingest | 1 | 1 (git serialization) |
| document-pipeline | 2 | 2 ✓ |
| embed-capture | 2 | 2 ✓ |
| extract-entities | 2 | 2 ✓ |
| email | 2 | 2 ✓ |
| pushover | 2 | 2 ✓ |

No shared helper — per-file `concurrency:` arg to `new Worker(...)`. Singletons preserved for correctness.

---

## Work items

### 1.1 — Add X-Open-Brain-Caller to 9 internal callers

**slack-bot** (`packages/slack-bot/src/lib/core-api-client.ts` line 41) — single choke point:
```typescript
private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const url = `${this.baseUrl}${path}`
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Open-Brain-Caller': 'slack-bot',
      ...options.headers,
    },
  })
  // ...
}
```
`...options.headers` spread after keeps test overrides working.

**voice-capture** (`packages/voice-capture/src/services/ingest.ts:57`):
```typescript
headers: {
  'Content-Type': 'application/json',
  'X-Open-Brain-Caller': 'voice-capture',
},
```

**6 worker skills** — add `'X-Open-Brain-Caller': <value>` to `headers` object in each fetch call:
- `memory-consolidation.ts:422` → `'memory-consolidation'`
- `daily-sweep-skill.ts:231` → `'workers'`
- `daily-connections.ts:245` → `'workers'`
- `drift-monitor.ts:269` → `'workers'`
- `monthly-reflection.ts:457` → `'workers'`
- `weekly-brief.ts:157` → `'workers'`

**base-skill.ts** (autonomy fetch has no `headers` object today):
```typescript
const response = await fetch(`${coreApiUrl}/api/v1/settings/autonomy_level`, {
  headers: { 'X-Open-Brain-Caller': 'workers' },
})
```

### 1.2 — Extend BYPASS_CALLERS

**File:** `packages/core-api/src/middleware/rate-limit.ts`

```typescript
const BYPASS_CALLERS = new Set([
  'internal:integration-test',
  'internal:web-ui',
  'internal:email-worker',
  'internal:financial-pipeline',
  'internal:utility-pipeline',
  'internal:ingest',
  // P07 — new internal service callers
  'internal:slack-bot',
  'internal:voice-capture',
  'internal:memory-consolidation',
  'internal:workers',
  // P07 — callers that already set the header but were missing from bypass
  'internal:email-classify',
  'internal:email-compose-skill',
  'internal:batch-wiki-ingest',
  'internal:email-pipeline',
  'internal:ingest-onedrive',
  'internal:ingest-repair',
])
```

### 1.3 — Strip client-set X-Open-Brain-Caller at front door

**File:** `packages/web/nginx.conf`

**`/mcp` block** — add explicit strip:
```nginx
location /mcp {
    proxy_pass $core_api_upstream;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # P07: strip client-supplied X-Open-Brain-Caller — MCP clients use IP-based rate limits
    proxy_set_header X-Open-Brain-Caller "";
    proxy_set_header Connection "";
    proxy_read_timeout 60s;
}
```

**`/api/` + `/api/v1/events` blocks** — add comment for auditability (existing `proxy_set_header X-Open-Brain-Caller "web-ui"` already correctly overwrites):
```nginx
# P07: nginx overwrites X-Open-Brain-Caller (replaces any client-supplied value — intentional)
proxy_set_header X-Open-Brain-Caller "web-ui";
```

**Deployment validation:** `docker compose exec web nginx -t` before reload. Test with `curl -H "X-Open-Brain-Caller: integration-test" https://brain.troy-davis.com/mcp ...` — should rate-limit after 20 req/min (strict tier), not bypass.

### 1.4 — Spread 7 jobs across 06:00-07:15

**File:** `packages/workers/src/scheduler.ts`

Update cron strings per table in "Scheduler proposed spread" above. Also update the JSDoc comment block at the top of `registerScheduledJobs` (lines 22-46) to reflect the new times:

```typescript
 * - wiki-synthesis:           6:00 AM daily    (cron: 0 6 * * *)    — anchor
 * - daily-connections:        6:10 AM daily    (cron: 10 6 * * *)   — cross-domain connections
 * - cost-analysis:            6:20 AM daily    (cron: 20 6 * * *)   — LLM cost tracking
 * - morning-brief:            6:30 AM weekdays (cron: 30 6 * * 1-5) — structured morning briefing
 * - capture-reminder-morning: 6:45 AM weekdays (cron: 45 6 * * 1-5) — Pushover nudge
 * - budget-check:             7:00 AM daily    (cron: 0 7 * * *)    — monthly AI spend vs thresholds
 * - drift-monitor:            7:15 AM daily    (cron: 15 7 * * *)   — brain-view classification drift
```

### 1.5 — BullMQ concurrency: 2 per queue (4 files)

Change `concurrency:` argument on 4 worker factories:
- `packages/workers/src/jobs/check-triggers.ts:289` — 5 → 2 (with comment: `// P07: reduced from 5`)
- `packages/workers/src/jobs/ingest-root.ts:96` — 3 → 2
- `packages/workers/src/jobs/ingestion-worker.ts:211` — 3 → 2
- `packages/workers/src/jobs/update-access-stats.ts:130` — 5 → 2

### 1.6 — Integration test

**New file:** `packages/core-api/src/__tests__/integration/rate-limit-internal.test.ts`

Uses existing `getTestApp()` pattern. Two tests:

```typescript
describe('Internal caller bypass under 100-parallel load', () => {
  it('100 parallel GET /api/v1/captures with X-Open-Brain-Caller: integration-test all succeed (no 429)', async () => {
    const N = 100
    const requests = Array.from({ length: N }, () =>
      ctx.app.fetch(
        new Request('http://localhost/api/v1/captures', {
          headers: {
            'Content-Type': 'application/json',
            'X-Open-Brain-Caller': 'integration-test',
          },
        }),
      ),
    )
    const responses = await Promise.all(requests)
    expect(responses.every(r => r.status !== 429)).toBe(true)
    expect(responses.every(r => r.status === 200)).toBe(true)
  })

  it('negative control: POST without header DOES 429 after strict-tier exhaustion', async () => {
    // Confirms bypass is doing real work — strict limiter still fires at 21 req/min
    const N = 100
    const requests = Array.from({ length: N }, () =>
      ctx.app.fetch(
        new Request('http://localhost/api/v1/captures', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: 'test', capture_type: 'idea',
            brain_view: 'technical', source: 'api',
          }),
        }),
      ),
    )
    const responses = await Promise.all(requests)
    const count429 = responses.filter(r => r.status === 429).length
    expect(count429).toBeGreaterThan(0) // strict 20/min limit was enforced
  })
})
```

Negative control ensures the test is not vacuous — if bypass were a no-op, test 1 would still pass at 100 concurrent GETs with a 100/min default limit, but test 2 confirms the limiter really is firing at 21 without the header.

### 1.7 — LAB_NOTEBOOK Entry 101

Pre-action entry with Objective / Hypothesis / Rollback per ORCHESTRATOR.md template. Include note that card's "19 jobs" was actually 7 in the 06:00-08:15 window (4-in-15-min cluster at 07:00); real thunderstorm smaller than stated.

---

## Acceptance criteria

- [ ] All 9 internal callers set `X-Open-Brain-Caller` (slack-bot, voice-capture, 6 worker skills, base-skill)
- [ ] BYPASS_CALLERS Set contains 16 entries (6 existing + 4 new service callers + 6 already-setting script callers)
- [ ] `packages/web/nginx.conf` `/mcp` block explicitly strips `X-Open-Brain-Caller`
- [ ] 7 jobs in 06:00-07:15 window on unique minutes (corrected from card's "19")
- [ ] BullMQ concurrency: 4 workers lowered to 2 (check-triggers, ingest-root, ingestion-worker, update-access-stats); 5 singletons preserved
- [ ] Integration test: 100 parallel internal calls succeed without 429; negative control confirms strict limiter still fires
- [ ] `pnpm --filter @open-brain/core-api run test` passes
- [ ] `pnpm --filter @open-brain/workers run test` passes
- [ ] `pnpm --filter @open-brain/slack-bot run test` passes
- [ ] `docker compose exec web nginx -t` passes (operator validates at deploy)
- [ ] LAB_NOTEBOOK Entry 101 present with Result filled

---

## Rollback

`git revert <P07 merge sha>`. No schema changes, no data migration.

- Rate-limit change is additive — internal callers fall back to IP-based limits; no security implication on revert.
- nginx change is `proxy_set_header` directive additions; revert + `docker compose restart web` restores prior behavior.
- Scheduler cron changes take effect on next workers restart; BullMQ's repeat-job upsert will restore old crons. No data loss or queue corruption.
- BullMQ concurrency changes take effect on restart; no data loss.

Safe without maintenance window.

---

## Scope drift check

**NO drift.** All work items map directly to #114 + #117.

**Minor in-scope corrections:**
- Card says "19 jobs" — actual is 7. Spread produced for 7.
- Card mentions `config/cloudflare/nginx.conf` — actual front door is `packages/web/nginx.conf`. Same effect.
- BYPASS_CALLERS expansion includes 6 script callers already setting the header but missing from bypass — necessary audit finding, not scope creep.

---

## Scope creep to defer

- Per-caller rate-limit tiers (e.g., slack-bot=500/min vs memory-consolidation=50/min) — requires converting Set to Map<caller, tier>. Future enhancement.
- Prometheus per-caller bypass metrics (`rate_limit_bypassed_total{caller="..."}`)
- Cloudflare WAF edge-level strip (defense-in-depth beyond nginx)
- Splitting `'workers'` caller into per-skill granularity — low value (same container)
- Spreading `container-health` (`*/15` pattern) — lightweight, not contributing to thunderstorm

---

## Post-merge CLAUDE.md rule candidates

1. **Internal callers rule:** Every new internal service (Docker container or script) that calls core-api MUST set `X-Open-Brain-Caller: <name>` AND add `internal:<name>` to `BYPASS_CALLERS` in `rate-limit.ts`. Missing either side = silent 429s under load.
2. **Scheduler slot colocation rule:** No two repeatable BullMQ jobs may share the same cron minute across 06:00–09:00. Window has 180 minute-slots. Document intended slot in JSDoc when registering a new job. Add to existing Sunday-slot registry rule (P06).
3. **BullMQ concurrency default rule:** New `createXxxWorker` factories default to `concurrency: 2`. Override to 1 only for documented singletons (LLM-heavy, git-serialized, etc.) with inline comment explaining why.
4. **nginx proxy_set_header audit rule:** Every new `location` block in `packages/web/nginx.conf` that proxies to core-api MUST explicitly set or clear `X-Open-Brain-Caller` — no silent inheritance between blocks.

---

## Critical Files for Implementation

- `packages/core-api/src/middleware/rate-limit.ts` (BYPASS_CALLERS)
- `packages/web/nginx.conf` (front-door strip)
- `packages/workers/src/scheduler.ts` (7-job spread + JSDoc)
- `packages/slack-bot/src/lib/core-api-client.ts` (header)
- `packages/voice-capture/src/services/ingest.ts` (header)
- `packages/workers/src/skills/{memory-consolidation,daily-sweep-skill,daily-connections,drift-monitor,monthly-reflection,weekly-brief,base-skill}.ts` (7 headers)
- `packages/workers/src/jobs/{check-triggers,ingest-root,ingestion-worker,update-access-stats}.ts` (concurrency)
- `packages/core-api/src/__tests__/integration/rate-limit-internal.test.ts` (NEW)
- `LAB_NOTEBOOK.md` (Entry 101)
