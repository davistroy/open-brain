import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { HonoAdapter } from '@bull-board/hono'
import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { sql } from 'drizzle-orm'
import type { Context } from 'hono'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type { ConfigService, Database } from '@open-brain/shared'
import { logger, admin_audit } from '@open-brain/shared'
import { adminAuth } from '../middleware/admin-auth.js'
import { SlackChannelService } from '../services/slack-channel.js'

/**
 * Queue names that Bull Board registers for monitoring.
 * Must match the queue names defined in @open-brain/workers queues/*.
 */
const QUEUE_NAMES = [
  'capture-pipeline',
  'skill-execution',
  'notification',
  'access-stats',
  'daily-sweep',
] as const

/** Job states that can be cleared via POST /queues/:name/clear */
const CLEARABLE_STATES = ['failed', 'completed', 'delayed'] as const
type ClearableState = typeof CLEARABLE_STATES[number]

export interface AdminRouterOptions {
  configService: ConfigService
  /** Redis connection for Bull Board queue monitoring. Optional — if omitted, /queues returns a placeholder. */
  redisConnection?: ConnectionOptions
  /** Database instance — required for POST /reset-data */
  db?: Database
}

/** Banner stored in Redis — displayed at top of dashboard */
interface AdminBanner {
  message: string
  level: 'info' | 'success' | 'warning'
  created_at: string
}

const BANNER_REDIS_KEY = 'admin:banner'
const BANNER_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

// ── Origin allowlist for /admin/reset-data ────────────────────────────────
// Only requests from brain.troy-davis.com are permitted.
// Fail-closed: only explicit NODE_ENV='development' or 'test' bypasses.
// Unset or unknown NODE_ENV (including the foot-gun case of a production
// deploy without NODE_ENV set) is treated as production — origin check applies.
const ALLOWED_ORIGINS = new Set(['https://brain.troy-davis.com'])

function checkOrigin(c: Context): boolean {
  const env = process.env.NODE_ENV
  if (env === 'development' || env === 'test') return true
  const origin = c.req.header('origin') ?? c.req.header('referer') ?? ''
  if (!origin) return false
  return [...ALLOWED_ORIGINS].some(a => origin === a || origin.startsWith(a + '/'))
}

function getActor(c: Context): string {
  return c.req.header('cf-access-authenticated-user-email') ?? 'unknown@internal'
}

function getClientIp(c: Context): string {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown'
}

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
      '-h', url.hostname,
      '-p', url.port || '5432',
      '-U', url.username,
      '-d', url.pathname.slice(1),
      '--format=plain',
      '--no-owner',
      '--no-privileges',
      '-f', outPath,
    ], {
      env: { ...process.env, PGPASSWORD: url.password },
      timeout: 120_000,
    })
    const stderr: Buffer[] = []
    proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    proc.on('close', (code) => {
      if (code === 0) resolve(outPath)
      else reject(new Error(`pg_dump exit ${code}: ${Buffer.concat(stderr).toString()}`))
    })
    proc.on('error', reject)
  })
}

/**
 * Creates the admin router.
 *
 * Mounts:
 *   POST /config/reload            — hot-reload YAML config files
 *   GET  /queues/*                  — Bull Board UI (when redisConnection is provided)
 *   POST /queues/:name/clear        — clear jobs from a named BullMQ queue
 *   GET  /pipeline/health           — BullMQ queue counts
 *
 * Bull Board path: /api/v1/admin/queues
 * (app.ts mounts this router at /api/v1/admin)
 */
export function createAdminRouter({ configService, redisConnection, db }: AdminRouterOptions): Hono {
  const router = new Hono()

  // Redis client for reset token issuance + GETDEL (reuses same connection options as bannerRedis).
  // null when redisConnection is not configured — step 1 returns 503 in that case.
  const resetRedis = redisConnection
    ? new Redis(redisConnection as unknown as import('ioredis').RedisOptions)
    : null

  // POST /config/reload — hot-reload YAML config files (auth required)
  router.post('/config/reload', adminAuth(), async (c) => {
    logger.info('Config reload requested via admin API')
    const results = configService.reload()
    const allSuccess = results.every(r => r.success)
    logger.info({ results }, 'Config reload complete')
    return c.json({
      success: allSuccess,
      results,
      reloaded_at: new Date().toISOString(),
    }, allSuccess ? 200 : 207)
  })

  // POST /reset-data — two-step destructive data wipe with audit trail
  //
  // Step 1 (body has { intent: "reset" } OR body lacks `confirm`):
  //   - Validate Origin (prod only)
  //   - Issue single-use 5-min Redis token
  //   - Write audit row: event_type='reset_requested'
  //   - Return: { token, expires_in: 300, message }
  //
  // Step 2 (body has { confirm: "WIPE ALL DATA", token: string }):
  //   - Validate Origin
  //   - Validate phrase
  //   - GETDEL token (atomic single-use)
  //   - Run pg_dump to /backup/pre-wipe/<timestamp>.sql
  //   - TRUNCATE user data tables
  //   - Write audit row: event_type='reset_executed'
  //   - Return: { cleared, preserved, wiped_at, backup_path, audit_id }
  //
  // No adminAuth — web UI cannot send Bearer tokens. Protected by POST method,
  // Origin check, JSON body, exact confirmation phrase, Redis token, and admin rate limiter.
  router.post('/reset-data', async (c) => {
    if (!db) {
      return c.json({ error: 'Database not configured for reset endpoint' }, 503)
    }

    // Parse body — tolerate missing or malformed JSON
    let body: { intent?: string; confirm?: string; token?: string } = {}
    try {
      const raw = await c.req.json()
      if (raw && typeof raw === 'object') body = raw as typeof body
    } catch {
      // No JSON body — treat as step 1 (token request)
    }

    const actor = getActor(c)
    const ip_address = getClientIp(c)
    const origin = c.req.header('origin') ?? c.req.header('referer') ?? undefined

    // Origin check — applies to both steps
    if (!checkOrigin(c)) {
      if (db) {
        await writeAuditRow(db, {
          event_type: 'reset_blocked',
          actor,
          outcome: 'blocked',
          error_detail: 'origin_check_failed',
          origin,
          ip_address,
        })
      }
      return c.json({ error: 'Forbidden' }, 403)
    }

    // ── Step 2: confirm + token present ─────────────────────────────────────
    if (body.confirm !== undefined || body.token !== undefined) {
      if (body.confirm !== 'WIPE ALL DATA') {
        await writeAuditRow(db, {
          event_type: 'reset_blocked',
          actor,
          outcome: 'blocked',
          error_detail: 'wrong_confirmation_phrase',
          origin,
          ip_address,
        })
        return c.json({ error: 'Confirmation required. Send { "confirm": "WIPE ALL DATA", "token": "<token>" }' }, 400)
      }

      if (!body.token || typeof body.token !== 'string') {
        await writeAuditRow(db, {
          event_type: 'reset_blocked',
          actor,
          outcome: 'blocked',
          error_detail: 'token_missing',
          origin,
          ip_address,
        })
        return c.json({ error: 'Token required. Perform step 1 first to obtain a single-use token.' }, 400)
      }

      // GETDEL — atomic single-use; null if missing or expired
      if (!resetRedis) {
        return c.json({ error: 'Token validation requires Redis' }, 503)
      }
      const tokenData = await resetRedis.getdel(`admin:reset-token:${body.token}`)
      if (!tokenData) {
        await writeAuditRow(db, {
          event_type: 'reset_blocked',
          actor,
          outcome: 'blocked',
          error_detail: 'token_invalid_or_expired',
          origin,
          ip_address,
        })
        return c.json({ error: 'Invalid or expired token. Perform step 1 to obtain a new token.' }, 401)
      }

      // Run pg_dump before TRUNCATE — abort wipe on failure
      let backupPath: string
      try {
        backupPath = await runPreWipeDump('/backup/pre-wipe')
      } catch (e) {
        const msg = (e instanceof Error) ? e.message : String(e)
        await writeAuditRow(db, {
          event_type: 'reset_blocked',
          actor,
          outcome: 'error',
          error_detail: `pgdump_failed: ${msg}`,
          origin,
          ip_address,
        })
        logger.error({ err: e }, '[admin] pg_dump failed — aborting reset')
        return c.json({ error: 'pg_dump failed', detail: msg }, 500)
      }

      logger.warn({ actor, backupPath }, '[admin] Data reset initiated — wiping all user data')

      // Tables ordered to avoid FK constraint errors; CASCADE handles any remainder.
      // Triggers are intentionally preserved (user configuration, not test data).
      // __drizzle_migrations is a system table and is never touched.
      // admin_audit is intentionally EXCLUDED from this list — it is the audit trail
      // for this operation and must survive the wipe.
      await db.execute(sql`
        TRUNCATE
          skills_log,
          ai_audit_log,
          session_messages,
          bets,
          sessions,
          entity_links,
          entity_relationships,
          entities,
          pipeline_events,
          captures
        CASCADE
      `)

      const clearedTables = [
        'captures', 'pipeline_events', 'entities', 'entity_links',
        'entity_relationships', 'sessions', 'session_messages',
        'bets', 'skills_log', 'ai_audit_log',
      ]

      const auditId = await writeAuditRow(db, {
        event_type: 'reset_executed',
        actor,
        confirmation_phrase: 'WIPE ALL DATA',
        tables_affected: clearedTables,
        outcome: 'success',
        backup_path: backupPath,
        origin,
        ip_address,
      })

      logger.warn({ actor, clearedTables, backupPath, auditId }, '[admin] Data reset complete')

      return c.json({
        cleared: clearedTables,
        preserved: ['triggers', '__drizzle_migrations', 'schema', 'admin_audit'],
        wiped_at: new Date().toISOString(),
        backup_path: backupPath,
        audit_id: auditId,
      })
    }

    // ── Step 1: issue token ──────────────────────────────────────────────────
    if (!resetRedis) {
      return c.json({ error: 'Token issuance requires Redis' }, 503)
    }
    const token = randomBytes(32).toString('base64url')
    await resetRedis.set(
      `admin:reset-token:${token}`,
      JSON.stringify({ actor, created_at: new Date().toISOString() }),
      'EX',
      300,
    )

    await writeAuditRow(db, {
      event_type: 'reset_requested',
      actor,
      outcome: 'success',
      origin,
      ip_address,
    })

    logger.info({ actor }, '[admin] Reset token issued')

    return c.json({
      token,
      expires_in: 300,
      message: 'POST again with this token + { "confirm": "WIPE ALL DATA", "token": "<this token>" } within 5 minutes.',
    })
  })

  if (redisConnection) {
    // Create read-only Queue instances for Bull Board — no workers attached.
    // These are lightweight: no polling, no processing, just queue inspection.
    const queues = QUEUE_NAMES.map(
      (name) => new Queue(name, { connection: redisConnection }),
    )

    const serverAdapter = new HonoAdapter(serveStatic)

    createBullBoard({
      queues: queues.map((q) => new BullMQAdapter(q)),
      serverAdapter,
    })

    // Bull Board base path must match where it's mounted in the final app.
    // app.ts mounts this router at /api/v1/admin, so the full path is /api/v1/admin/queues.
    serverAdapter.setBasePath('/api/v1/admin/queues')

    const bullBoardApp = serverAdapter.registerPlugin()

    // POST /queues/:name/clear — clear jobs from a named BullMQ queue
    // No adminAuth — web UI cannot send Bearer tokens. Protected by POST method
    // and queue name validation against the QUEUE_NAMES whitelist.
    // Registered BEFORE the Bull Board wildcard middleware so it's handled directly.
    router.post('/queues/:name/clear', async (c) => {
      const queueName = c.req.param('name')

      // Validate queue name against whitelist
      if (!QUEUE_NAMES.includes(queueName as typeof QUEUE_NAMES[number])) {
        return c.json({
          error: 'Not found',
          message: `Unknown queue "${queueName}". Valid queues: ${QUEUE_NAMES.join(', ')}`,
        }, 404)
      }

      // Parse optional body for state and grace_period_ms
      let state: ClearableState = 'failed'
      let gracePeriodMs = 0

      try {
        const body = await c.req.json() as Record<string, unknown>
        if (body.state !== undefined) {
          if (!CLEARABLE_STATES.includes(body.state as ClearableState)) {
            return c.json({
              error: 'Bad request',
              message: `Invalid state "${body.state}". Valid states: ${CLEARABLE_STATES.join(', ')}`,
            }, 400)
          }
          state = body.state as ClearableState
        }
        if (body.grace_period_ms !== undefined) {
          const parsed = Number(body.grace_period_ms)
          if (Number.isNaN(parsed) || parsed < 0) {
            return c.json({
              error: 'Bad request',
              message: 'grace_period_ms must be a non-negative number',
            }, 400)
          }
          gracePeriodMs = parsed
        }
      } catch {
        // No body or invalid JSON — use defaults (state: 'failed', grace: 0)
      }

      const queue = queues.find((q) => q.name === queueName)!

      logger.info({ queue: queueName, state, gracePeriodMs }, '[admin] Queue clear requested')

      const removedIds = await queue.clean(gracePeriodMs, 1000, state)

      logger.info(
        { queue: queueName, state, cleared_count: removedIds.length },
        '[admin] Queue clear complete',
      )

      return c.json({
        queue: queueName,
        state,
        cleared_count: removedIds.length,
        cleared_at: new Date().toISOString(),
      })
    })

    // Bull Board UI — protected by adminAuth (requires Bearer token)
    router.use('/queues/*', adminAuth())
    router.route('/queues', bullBoardApp)

    logger.info('[admin] Bull Board mounted at /api/v1/admin/queues')

    // GET /pipeline/health — returns BullMQ queue counts in PipelineStatus format
    router.get('/pipeline/health', async (ctx) => {
      type QueueCounts = { waiting: number; active: number; completed: number; failed: number; delayed: number }
      const counts: Array<{ name: string } & QueueCounts> = await Promise.all(
        queues.map(async (q) => {
          const result = await q.getJobCounts('active', 'waiting', 'completed', 'failed', 'delayed') as QueueCounts
          return { name: q.name, ...result }
        }),
      )

      const queueMap: Record<string, QueueCounts> = {}
      let totalPending = 0
      let totalProcessing = 0
      let totalComplete = 0
      let totalFailed = 0

      for (const q of counts) {
        queueMap[q.name] = {
          waiting: q.waiting ?? 0,
          active: q.active ?? 0,
          completed: q.completed ?? 0,
          failed: q.failed ?? 0,
          delayed: q.delayed ?? 0,
        }
        totalPending += (q.waiting ?? 0) + (q.delayed ?? 0)
        totalProcessing += q.active ?? 0
        totalComplete += q.completed ?? 0
        totalFailed += q.failed ?? 0
      }

      return ctx.json({
        queues: queueMap,
        overall: {
          pending: totalPending,
          processing: totalProcessing,
          complete: totalComplete,
          failed: totalFailed,
        },
      })
    })

  } else {
    // Placeholder until Redis connection is wired at startup
    router.get('/queues', (c) => {
      return c.json({
        message: 'Bull Board requires a Redis connection — pass redisConnection to createAdminRouter()',
        queues: QUEUE_NAMES,
      })
    })

    router.get('/pipeline/health', (c) => {
      return c.json({
        message: 'Pipeline health requires a Redis connection',
        queues: {},
        overall: { pending: 0, processing: 0, complete: 0, failed: 0 },
      })
    })

    router.post('/queues/:name/clear', (c) => {
      return c.json({
        error: 'Service unavailable',
        message: 'Queue management requires a Redis connection',
      }, 503)
    })
  }

  // ─── Slack Channel Management ──────────────────────────────────────────────
  // GET  /slack/channels              — list channels with activity metadata
  // POST /slack/channels/:id/archive  — archive a channel by ID
  // No adminAuth — web UI cannot send Bearer tokens. Protected by POST method
  // for archive and the admin rate limiter on /api/v1/admin/*.

  const slackToken = process.env.SLACK_USER_TOKEN || process.env.SLACK_BOT_TOKEN
  if (slackToken) {
    const slackChannelService = new SlackChannelService(slackToken)

    router.get('/slack/channels', async (c) => {
      try {
        const channels = await slackChannelService.listChannels()
        return c.json({ channels })
      } catch (err) {
        logger.error({ err }, '[admin] Failed to list Slack channels')
        const message = err instanceof Error ? err.message : 'Unknown error listing Slack channels'
        return c.json({ error: 'Failed to list Slack channels', message }, 500)
      }
    })

    router.post('/slack/channels/:id/archive', async (c) => {
      const channelId = c.req.param('id')
      if (!channelId) {
        return c.json({ error: 'Bad request', message: 'Channel ID is required' }, 400)
      }

      try {
        const result = await slackChannelService.archiveChannel(channelId)
        logger.info({ channelId }, '[admin] Slack channel archived')
        return c.json(result)
      } catch (err) {
        logger.error({ err, channelId }, '[admin] Failed to archive Slack channel')
        const message = err instanceof Error ? err.message : 'Unknown error archiving Slack channel'
        return c.json({ error: 'Failed to archive Slack channel', message }, 500)
      }
    })

    logger.info('[admin] Slack channel management routes registered')
  } else {
    router.get('/slack/channels', (c) => {
      return c.json({
        error: 'Service unavailable',
        message: 'No Slack token available. Set SLACK_BOT_TOKEN or SLACK_USER_TOKEN.',
      }, 503)
    })

    router.post('/slack/channels/:id/archive', (c) => {
      return c.json({
        error: 'Service unavailable',
        message: 'No Slack token available. Set SLACK_BOT_TOKEN or SLACK_USER_TOKEN.',
      }, 503)
    })
  }

  // ── Admin Banner (Redis-backed, 30-day TTL) ──────────────────────────────
  // GET  /banner — read current banner (or null)
  // POST /banner — set banner message { message, level }
  // DELETE /banner — clear banner

  if (redisConnection) {
    const bannerRedis = new Redis(redisConnection as unknown as import('ioredis').RedisOptions)

    router.get('/banner', async (c) => {
      const raw = await bannerRedis.get(BANNER_REDIS_KEY)
      if (!raw) return c.json({ banner: null })
      try {
        return c.json({ banner: JSON.parse(raw) as AdminBanner })
      } catch {
        return c.json({ banner: null })
      }
    })

    router.post('/banner', async (c) => {
      const body = await c.req.json<{ message?: string; level?: string }>()
      if (!body.message || typeof body.message !== 'string') {
        return c.json({ error: 'message is required' }, 400)
      }
      const validLevels: readonly AdminBanner['level'][] = ['info', 'success', 'warning']
      const level: AdminBanner['level'] = validLevels.includes(body.level as AdminBanner['level'])
        ? (body.level as AdminBanner['level'])
        : 'info'
      const banner: AdminBanner = {
        message: body.message.slice(0, 500),
        level,
        created_at: new Date().toISOString(),
      }
      await bannerRedis.set(BANNER_REDIS_KEY, JSON.stringify(banner), 'EX', BANNER_TTL_SECONDS)
      logger.info({ banner }, '[admin] Banner set')
      return c.json({ banner })
    })

    router.delete('/banner', async (c) => {
      await bannerRedis.del(BANNER_REDIS_KEY)
      logger.info('[admin] Banner cleared')
      return c.json({ cleared: true })
    })
  }

  return router
}
