# IMPLEMENT_PHASE-P04a.md — /admin/reset-data two-step + audit

**Phase:** P04a (first post-bootstrap phase)
**Closes:** #104
**Severity:** High
**Estimated effort:** ~1-1.5 days
**Dependencies:** P03 merged (bootstrap complete)
**Branch name:** `feat/phase-P04a-admin-reset`
**Gate 5 approval:** **Operator required** per ORCHESTRATOR.md matrix (new migration + compose + Dockerfile changes)
**Gate 5.5 trigger:** YES — migration 0023 + `admin_prewipe_backup` volume + `postgresql-client` in Dockerfile
**Drift audit date:** 2026-04-19
**Base HEAD:** `2699160` (main, post-P03 bootstrap-complete doc sweep)
**Authored by:** Gate 1 phase-planner subagent (Sonnet 4.6)

---

## 1. Scope Drift

**PROCEEDED — 7 drifts cleared, none invalidating acceptance:**

| # | Drift | Adjustment |
|---|---|---|
| 1 | CF Access email header NOT forwarded through nginx — only `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Open-Brain-Caller` forwarded | Add `proxy_set_header CF-Access-Authenticated-User-Email $http_cf_access_authenticated_user_email;` to nginx `/api/` block (work item 4.9) |
| 2 | `/backup/pre-wipe/` NOT in compose volume layout | Add `admin_prewipe_backup` named volume + mount at `/backup/pre-wipe` in core-api (work item 4.7b) |
| 3 | `pg_dump` binary NOT in core-api Docker image | Add `postgresql-client` to Dockerfile `prod-base` stage (work item 4.7b) |
| 4 | Token storage — Redis already imported (`ioredis` in admin.ts line 8, used for banner). Redis 7 supports native GETDEL. | Confirms Redis as token storage choice; no change |
| 5 | Other admin endpoints — `/queues/:name/clear` + `/slack/channels/:id/archive` are destructive but NOT in P04a scope | Document as potential future P04c; no change in P04a |
| 6 | `admin_audit` table must NOT be in the TRUNCATE list — current list preserves non-captures tables but table doesn't exist yet | Explicit code comment + integration test assertion (work item 4.8) |
| 7 | **Allowed origin is `brain.troy-davis.com`, NOT `web.troy-davis.com`** — tunnel.yaml is the authority; plan card was wrong | Allowlist `https://brain.troy-davis.com` only in prod; dev bypass via `NODE_ENV !== 'production'` |

---

## 2. Current-State Baseline

### 2.1 `/admin/reset-data` current state

- Route: `router.post('/reset-data')` in `packages/core-api/src/routes/admin.ts` L83-135
- Mounted at `/api/v1/admin/reset-data`
- Current protections: POST method + JSON body + exact `confirm === "WIPE ALL DATA"` phrase + admin rate limiter (5 req/min)
- Missing: CSRF, two-step flow, pre-wipe backup, audit trail
- Wipe sequence: single `TRUNCATE ... CASCADE` for 10 tables (skills_log, ai_audit_log, session_messages, bets, sessions, entity_links, entity_relationships, entities, pipeline_events, captures)
- Preserves: triggers, __drizzle_migrations, app_settings, activity_feed, backup_log, container_health, mcp_activity, voice_sessions, file_uploads, email_drafts, capture_associations

### 2.2 Migrations

Count: 23 (0000–0022). Next: **0023**.

### 2.3 Existing pg_dump

`scripts/backup.sh` uses `docker exec open-brain-postgres pg_dump` — runs inside the postgres container (pg_dump native). Core-api has no pg_dump usage. P04a adds `child_process.spawn('pg_dump', ...)` from inside the core-api container after adding `postgresql-client` to the image.

### 2.4 Redis access

`admin.ts` already creates a `bannerRedis` via `new Redis(redisConnection)` when `redisConnection` is present in `AdminRouterOptions`. Reuse the same pattern for `resetRedis`.

### 2.5 Nginx API proxy (web/nginx.conf L67-77)

Currently forwards: `Host`, `X-Real-IP`, `X-Forwarded-For`, `X-Open-Brain-Caller`. Missing: `CF-Access-Authenticated-User-Email`.

### 2.6 Token storage — **Decision: Redis.**

- `ioredis` already imported
- Native 5-min TTL (`SET EX 300`)
- Native `GETDEL` for atomic single-use (Redis 7, compose uses `redis:7-alpine`)
- No new DB table required

---

## 3. Work Items

### 3.1 Drizzle schema — `admin_audit` table

**File:** `packages/shared/src/schema/supporting.ts`

Append after `backup_log`:

```ts
export const admin_audit = pgTable(
  'admin_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    event_type: varchar('event_type', { length: 32 }).notNull(),
    actor: text('actor').notNull(),
    confirmation_phrase: text('confirmation_phrase'),
    tables_affected: text('tables_affected').array(),
    outcome: varchar('outcome', { length: 16 }).notNull(),
    error_detail: text('error_detail'),
    backup_path: text('backup_path'),
    origin: text('origin'),
    ip_address: text('ip_address'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    event_type_idx: index('admin_audit_event_type_idx').on(table.event_type),
    actor_idx: index('admin_audit_actor_idx').on(table.actor),
    created_at_idx: index('admin_audit_created_at_idx').on(table.created_at),
  }),
)
```

Export from `packages/shared/src/schema/index.ts`.

### 3.2 Migration 0023

**File:** `packages/shared/drizzle/0023_admin_audit.sql`

```sql
-- Migration 0023: admin_audit table
-- Records every /admin/reset-data attempt: request (token), execution (wipe), blocked (CSRF/bad-token).
-- This table is intentionally EXCLUDED from the reset-data TRUNCATE list.

CREATE TABLE IF NOT EXISTS admin_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(32) NOT NULL,
  actor TEXT NOT NULL,
  confirmation_phrase TEXT,
  tables_affected TEXT[],
  outcome VARCHAR(16) NOT NULL,
  error_detail TEXT,
  backup_path TEXT,
  origin TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS admin_audit_event_type_idx ON admin_audit(event_type);
CREATE INDEX IF NOT EXISTS admin_audit_actor_idx ON admin_audit(actor);
CREATE INDEX IF NOT EXISTS admin_audit_created_at_idx ON admin_audit(created_at);
```

### 3.3 `scripts/init-schema.sql` update

Append migration 0023 DDL to the end of `init-schema.sql` (idempotent `IF NOT EXISTS` ensures fresh DB init works).

### 3.4 Token issuance — Step 1

**File:** `packages/core-api/src/routes/admin.ts`

Step 1 handler (body lacks `confirm`):
- Validate Origin (see 3.6) — reject + audit on fail
- Generate `randomBytes(32).toString('base64url')`
- Redis `SET admin:reset-token:<token> <actor-json> EX 300`
- Write audit: `event_type: 'reset_requested', outcome: 'success'`
- Return `{ token, expires_in: 300, message }`
- Requires `redisConnection` — return 503 if absent

### 3.5 Token validation — Step 2

**File:** `packages/core-api/src/routes/admin.ts`

Step 2 handler (body has `confirm` + `token`):
- Validate Origin
- Require `{ confirm: "WIPE ALL DATA", token: string }`
- `GETDEL admin:reset-token:<token>`:
  - Null → 401 + audit `outcome: 'blocked', error_detail: 'token_invalid_or_expired'`
  - Valid → proceed
- Run pg_dump (see 3.7) — abort wipe on failure
- Execute TRUNCATE (existing logic — preserve)
- Write audit: `event_type: 'reset_executed', outcome: 'success', tables_affected: [...], backup_path`
- Response: existing shape + `backup_path` + `audit_id`

### 3.6 Origin/Referer check

**File:** `packages/core-api/src/routes/admin.ts` — inline helper

```ts
const ALLOWED_ORIGINS = new Set(['https://brain.troy-davis.com'])

function checkOrigin(c: Context): boolean {
  if (process.env.NODE_ENV !== 'production') return true  // dev bypass
  const origin = c.req.header('origin') ?? c.req.header('referer') ?? ''
  if (!origin) return false
  return [...ALLOWED_ORIGINS].some(a => origin === a || origin.startsWith(a + '/'))
}
```

On fail: 403 + audit `event_type: 'reset_blocked', outcome: 'blocked', error_detail: 'origin_check_failed'`.

### 3.7 Pre-wipe pg_dump

**File:** `packages/core-api/src/routes/admin.ts`

```ts
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

async function runPreWipeDump(backupDir: string): Promise<string> {
  if (process.env.ADMIN_RESET_SKIP_PGDUMP === 'true') {
    return `${backupDir}/SKIPPED-FOR-TESTS`
  }
  const pgUrl = process.env.POSTGRES_URL
  if (!pgUrl) throw new Error('POSTGRES_URL not set')
  const url = new URL(pgUrl)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = `${backupDir}/${timestamp}.sql`
  mkdirSync(backupDir, { recursive: true })

  return new Promise((resolve, reject) => {
    const proc = spawn('pg_dump', [
      '-h', url.hostname, '-p', url.port || '5432',
      '-U', url.username, '-d', url.pathname.slice(1),
      '--format=plain', '--no-owner', '--no-privileges',
      '-f', outPath,
    ], {
      env: { ...process.env, PGPASSWORD: url.password },
      timeout: 120_000,
    })
    const stderr: Buffer[] = []
    proc.stderr.on('data', (c) => stderr.push(c))
    proc.on('close', (code) => {
      if (code === 0) resolve(outPath)
      else reject(new Error(`pg_dump exit ${code}: ${Buffer.concat(stderr).toString()}`))
    })
    proc.on('error', reject)
  })
}
```

**On failure:** audit `outcome: 'error', error_detail: 'pgdump_failed: <msg>'`, return 500, do NOT proceed with TRUNCATE.

### 3.7b Compose + Dockerfile

**`docker-compose.yml`:**
- Top-level `volumes:` — add `admin_prewipe_backup:`
- core-api service `volumes:` — add `- admin_prewipe_backup:/backup/pre-wipe`

**`Dockerfile` prod-base (L46):** `RUN apk add --no-cache bash git` → `RUN apk add --no-cache bash git postgresql-client`

### 3.8 `admin_audit` row on every attempt

**File:** `packages/core-api/src/routes/admin.ts`

```ts
async function writeAuditRow(db: Database, params: {
  event_type: 'reset_requested' | 'reset_executed' | 'reset_blocked'
  actor: string
  confirmation_phrase?: string
  tables_affected?: string[]
  outcome: 'success' | 'blocked' | 'error'
  error_detail?: string
  backup_path?: string
  origin?: string
  ip_address?: string
}): Promise<string> {
  const [row] = await db.insert(admin_audit).values(params).returning({ id: admin_audit.id })
  return row.id
}
```

Write on: step 1 success, step 1 origin-fail, step 2 success, step 2 bad-token, step 2 pg_dump-error.

**Actor:** `c.req.header('cf-access-authenticated-user-email') ?? 'unknown@internal'`
**IP:** `c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'`

**CRITICAL INVARIANT:** `admin_audit` must NOT be in the TRUNCATE list. Add code comment explicitly. Assert in integration test.

### 3.9 nginx CF Access header forwarding

**File:** `packages/web/nginx.conf` — in `location /api/` block:

```nginx
proxy_set_header CF-Access-Authenticated-User-Email $http_cf_access_authenticated_user_email;
```

### 3.10 Tests

**File:** `packages/core-api/src/__tests__/admin-reset-two-step.test.ts` (new — vitest mocks)

10 test cases:
1. Origin check blocks non-allowed origin in prod mode
2. Origin check allows `brain.troy-davis.com`
3. Missing Redis → 503 on step 1
4. Token single-use (second use → 401)
5. Expired token → 401
6. Wrong confirmation phrase at step 2 → 400
7. `ADMIN_RESET_SKIP_PGDUMP=true` full flow success
8. Audit row written on blocked (bad origin)
9. Audit row written on successful wipe
10. `admin_audit` NOT in TRUNCATE list (code-level assertion)

**Integration test** (optional if unit covers the path): full flow with real Postgres + mocked Redis + `ADMIN_RESET_SKIP_PGDUMP=true`.

---

## 4. Acceptance Criteria

- [ ] Step 1 (`POST /api/v1/admin/reset-data` without `confirm`) returns single-use token from allowed origin
- [ ] Step 2 (with valid token + correct phrase) executes wipe
- [ ] Step 2 from disallowed origin → 403 (prod mode)
- [ ] Token cannot be used twice (GETDEL atomicity)
- [ ] Token expires after 5 min
- [ ] pg_dump runs before TRUNCATE (or skips via env flag in tests)
- [ ] `admin_audit` row on every attempt
- [ ] `admin_audit` NOT in TRUNCATE list — row survives wipe
- [ ] nginx forwards CF Access email header
- [ ] Actor in audit = CF Access email or `unknown@internal`
- [ ] All 10 unit tests pass
- [ ] `scripts/init-schema.sql` round-trip clean with new `admin_audit` table
- [ ] `0023_admin_audit.sql` applies cleanly to existing DB with migrations 0000-0022
- [ ] LAB_NOTEBOOK Entry 097 with Hypothesis + Rollback before first commit
- [ ] PR body uses `Closes #104` (sole PR; safe)

---

## 5. Rollback Plan

1. `git revert <squash-sha>` on main
2. If migration 0023 applied + audit rows present: write `0024_drop_admin_audit_if_empty.sql` (conditional drop)
3. `docker volume rm open-brain_admin_prewipe_backup` (if empty)
4. Revert nginx.conf change
5. Rebuild core-api image (postgresql-client removal optional — harmless if left)
6. `docker compose up -d --build core-api web`

---

## 6. Test Plan

```bash
# Unit
pnpm --filter @open-brain/core-api test -- admin-reset

# Integration
docker compose -f docker-compose.test.yml up -d
ADMIN_RESET_SKIP_PGDUMP=true pnpm --filter @open-brain/core-api exec vitest run --config vitest.config.integration.ts

# Schema
bash scripts/validate-init-schema.sh    # must still pass with admin_audit in it
```

---

## 7. Homeserver Deploy Notes (Gate 5.5)

### Pre-flight audit (MANDATORY)

```bash
# 1. Verify admin_audit doesn't already exist
docker exec open-brain-postgres psql -U openbrain -d openbrain \
  -c "SELECT tablename FROM pg_tables WHERE tablename = 'admin_audit';"
# Expect: 0 rows

# 2. Verify migration sequence
docker exec open-brain-postgres psql -U openbrain -d openbrain \
  -c "SELECT * FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 3;"
# Expect: latest = 0022_captures_source_check
```

### Apply migration

```bash
docker cp packages/shared/drizzle/0023_admin_audit.sql open-brain-postgres:/tmp/
docker exec open-brain-postgres psql -U openbrain -d openbrain -f /tmp/0023_admin_audit.sql
docker exec open-brain-postgres psql -U openbrain -d openbrain -c "\dt admin_audit"
docker exec open-brain-postgres psql -U openbrain -d openbrain -c \
  "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('0023_admin_audit', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000);"
```

### Rebuild + redeploy

```bash
cd /mnt/user/appdata/open-brain
git pull origin main
docker compose build core-api web
docker compose up -d core-api web
docker volume ls | grep admin_prewipe_backup
docker exec open-brain-core-api pg_dump --version    # expect: PostgreSQL 16.x
docker exec open-brain-core-api ls -la /backup/pre-wipe/
```

### Rollback (if needed)

```bash
docker exec open-brain-postgres psql -U openbrain -d openbrain -c "DROP TABLE IF EXISTS admin_audit;"
docker exec open-brain-postgres psql -U openbrain -d openbrain -c "DELETE FROM __drizzle_migrations WHERE hash = '0023_admin_audit';"
git checkout main~1
docker compose build core-api web && docker compose up -d core-api web
```

---

## 8. Operational Rules Candidates (for CLAUDE.md after merge)

- `/admin/reset-data` is now two-step — step 1 issues single-use 5-min Redis token; step 2 presents token + phrase. Confirmation phrase `"WIPE ALL DATA"` still required. Old single-step flow no longer works.
- `admin_audit` is write-only from the reset endpoint; excluded from TRUNCATE list by design. Do NOT add it to the wipe.
- Pre-wipe pg_dump fires before TRUNCATE; backup at `/backup/pre-wipe/<ISO-timestamp>.sql`. Skip in tests via `ADMIN_RESET_SKIP_PGDUMP=true`.
- Origin allowlist is `brain.troy-davis.com` (production); dev bypass via `NODE_ENV !== 'production'`.
