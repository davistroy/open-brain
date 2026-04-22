import type { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import type { BriefsService } from '../services/briefs.js'
import { NotFoundError, logger } from '@open-brain/shared'
import { BriefKindSchema, ai_audit_log } from '@open-brain/shared'
import type { Database } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Query / body schemas
// ---------------------------------------------------------------------------

const listBriefsSchema = z.object({
  kind: BriefKindSchema.optional(),
  unread: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = parseInt(v ?? '20', 10)
      return Number.isFinite(n) ? Math.min(Math.max(n, 1), 100) : 20
    }),
  offset: z
    .string()
    .optional()
    .transform((v) => {
      const n = parseInt(v ?? '0', 10)
      return Number.isFinite(n) && n >= 0 ? n : 0
    }),
})

const refineBriefSchema = z.object({
  option: z.string().min(1).max(200),
})

const patchBriefSchema = z.object({
  read: z.boolean(),
})

const audioQuerySchema = z.object({
  voice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']).optional().default('alloy'),
})

// ---------------------------------------------------------------------------
// TTS helpers
// ---------------------------------------------------------------------------

/** Duck-typed Redis interface — satisfied by ioredis and test mocks alike */
export interface TtsRedisClient {
  getBuffer: (key: string) => Promise<Buffer | null>
  setex: (key: string, ttl: number, value: Buffer) => Promise<unknown>
}

/** Optional deps for TTS endpoint. When absent, POST /briefs/:id/audio returns 503. */
export interface TtsDeps {
  db: Database
  redis: TtsRedisClient
  openaiBaseUrl: string
  openaiApiKey: string
}

/**
 * Strip HTML tags from a string and decode common HTML entities.
 * Avoids pulling in a DOM dependency — handles the subset present in renderBriefHtml output.
 */
function htmlToPlainText(html: string): string {
  // Remove script/style blocks entirely
  let text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
  // Strip all remaining tags
  text = text.replace(/<[^>]+>/g, ' ')
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(parseInt(code, 10)))
  // Collapse whitespace
  return text.replace(/\s+/g, ' ').trim()
}

/** Cost per 1K characters for OpenAI TTS tts-1 model */
const TTS_COST_PER_1K_CHARS = 0.015

// ---------------------------------------------------------------------------

/**
 * Register briefs API routes.
 *
 * GET  /api/v1/briefs             — list with kind/unread filters + pagination
 * GET  /api/v1/briefs/:id         — full detail (body_html, toc, sources)
 * POST /api/v1/briefs/:id/refine  — async refinement (202); strict rate-limit applied in app.ts
 * POST /api/v1/briefs/:id/dismiss — set dismissed_at; 204
 * PATCH /api/v1/briefs/:id        — read/unread toggle
 * POST /api/v1/briefs/:id/audio   — TTS synthesis + Redis cache (audio/mpeg); strict rate-limit applied in app.ts
 */
export function registerBriefRoutes(app: Hono, briefsService: BriefsService, ttsDeps?: TtsDeps): void {
  // -------------------------------------------------------------------------
  // GET /api/v1/briefs
  // -------------------------------------------------------------------------
  app.get('/api/v1/briefs', zValidator('query', listBriefsSchema), async (c) => {
    const query = c.req.valid('query')

    const result = await briefsService.list({
      kind: query.kind,
      unread: query.unread || undefined,
      limit: query.limit,
      offset: query.offset,
    })

    return c.json(result)
  })

  // -------------------------------------------------------------------------
  // GET /api/v1/briefs/:id
  // -------------------------------------------------------------------------
  app.get('/api/v1/briefs/:id', async (c) => {
    const id = c.req.param('id')

    try {
      const brief = await briefsService.getById(id)
      return c.json({ brief })
    } catch (err) {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message, code: 'NOT_FOUND' }, 404)
      }
      throw err
    }
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/briefs/:id/refine  — async; 202 Accepted
  // Strict rate-limit is applied in app.ts BEFORE the default /api/v1/* limiter.
  // -------------------------------------------------------------------------
  app.post('/api/v1/briefs/:id/refine', zValidator('json', refineBriefSchema), async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')

    try {
      const result = await briefsService.refine(id, body.option)
      return c.json(result, 202)
    } catch (err) {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message, code: 'NOT_FOUND' }, 404)
      }
      throw err
    }
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/briefs/:id/dismiss  — 204 No Content
  // -------------------------------------------------------------------------
  app.post('/api/v1/briefs/:id/dismiss', async (c) => {
    const id = c.req.param('id')

    try {
      await briefsService.dismiss(id)
      return c.body(null, 204)
    } catch (err) {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message, code: 'NOT_FOUND' }, 404)
      }
      throw err
    }
  })

  // -------------------------------------------------------------------------
  // PATCH /api/v1/briefs/:id  — read/unread toggle
  // -------------------------------------------------------------------------
  app.patch('/api/v1/briefs/:id', zValidator('json', patchBriefSchema), async (c) => {
    const id = c.req.param('id')
    const body = c.req.valid('json')

    try {
      const brief = await briefsService.patchRead(id, body.read)
      return c.json({ brief })
    } catch (err) {
      if (err instanceof NotFoundError) {
        return c.json({ error: err.message, code: 'NOT_FOUND' }, 404)
      }
      throw err
    }
  })

  // -------------------------------------------------------------------------
  // POST /api/v1/briefs/:id/audio  — TTS synthesis; strict rate-limit applied in app.ts
  //
  // Query params:
  //   ?voice=alloy  (default) — one of alloy|echo|fable|onyx|nova|shimmer
  //
  // Flow:
  //   1. Fetch brief (404 if not found)
  //   2. Strip body_html to plain text
  //   3. Check Redis cache tts:{brief_id}:{voice} (TTL 24h)
  //   4. On miss: call OpenAI TTS API (POST /v1/audio/speech)
  //   5. Store audio buffer in Redis cache
  //   6. Record cost in ai_audit_log (task_name: 'tts')
  //   7. Return audio/mpeg response
  // -------------------------------------------------------------------------
  app.post('/api/v1/briefs/:id/audio', zValidator('query', audioQuerySchema), async (c) => {
    if (!ttsDeps) {
      return c.json({ error: 'TTS not configured', code: 'SERVICE_UNAVAILABLE' }, 503)
    }

    const { db, redis, openaiBaseUrl, openaiApiKey } = ttsDeps
    const id = c.req.param('id')
    const { voice } = c.req.valid('query')

    // Step 1: fetch brief
    let brief: Awaited<ReturnType<typeof briefsService.getById>>
    try {
      brief = await briefsService.getById(id)
    } catch (err) {
      if (err instanceof NotFoundError) {
        return c.json({ error: (err as Error).message, code: 'NOT_FOUND' }, 404)
      }
      throw err
    }

    // Step 2: strip HTML to plain text
    const plainText = htmlToPlainText(brief.body_html)
    if (!plainText) {
      return c.json({ error: 'Brief has no readable content', code: 'UNPROCESSABLE' }, 422)
    }

    // Step 3: check Redis cache
    const cacheKey = `tts:${id}:${voice}`
    const startMs = Date.now()

    try {
      const cached = await redis.getBuffer(cacheKey)
      if (cached) {
        logger.debug({ briefId: id, voice, bytes: cached.length }, '[tts] cache hit — returning cached audio')
        return new Response(new Uint8Array(cached), {
          status: 200,
          headers: {
            'Content-Type': 'audio/mpeg',
            'Content-Length': String(cached.length),
            'X-TTS-Cache': 'hit',
          },
        })
      }
    } catch (err) {
      // Redis unavailable — proceed to live generation (non-fatal)
      logger.warn({ err, briefId: id }, '[tts] Redis cache read failed — falling through to live TTS')
    }

    // Step 4: call OpenAI TTS API
    // Ensure the base URL ends with /v1 (strip trailing slash for safety)
    const base = openaiBaseUrl.replace(/\/+$/, '')
    const ttsUrl = base.endsWith('/v1') ? `${base}/audio/speech` : `${base}/v1/audio/speech`

    let audioBuffer: Buffer
    try {
      const ttsResponse = await fetch(ttsUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`,
        },
        body: JSON.stringify({
          model: 'tts-1',
          voice,
          input: plainText,
          response_format: 'mp3',
        }),
      })

      if (!ttsResponse.ok) {
        const errText = await ttsResponse.text().catch(() => 'unknown')
        logger.error({ briefId: id, status: ttsResponse.status, body: errText }, '[tts] OpenAI TTS API error')
        return c.json({ error: 'TTS generation failed', code: 'TTS_ERROR', detail: errText }, 502)
      }

      const arrayBuffer = await ttsResponse.arrayBuffer()
      audioBuffer = Buffer.from(arrayBuffer)
    } catch (err) {
      logger.error({ err, briefId: id }, '[tts] fetch to OpenAI TTS failed')
      return c.json({ error: 'TTS generation failed', code: 'TTS_ERROR' }, 502)
    }

    const durationMs = Date.now() - startMs

    // Step 5: store in Redis cache (TTL 24h = 86400s)
    try {
      await redis.setex(cacheKey, 86400, audioBuffer)
      logger.debug({ briefId: id, voice, bytes: audioBuffer.length }, '[tts] cached audio in Redis')
    } catch (err) {
      // Cache write failure is non-fatal — audio still returned to client
      logger.warn({ err, briefId: id }, '[tts] Redis cache write failed (non-fatal)')
    }

    // Step 6: record cost in ai_audit_log
    // Cost: $0.015 per 1K characters of input text
    const charCount = plainText.length
    const costUsd = (charCount / 1000) * TTS_COST_PER_1K_CHARS
    try {
      await db.insert(ai_audit_log).values({
        task_type: 'tts',
        model: 'tts-1',
        prompt_tokens: charCount, // characters, not tokens — closest available field
        completion_tokens: null,
        total_tokens: charCount,
        duration_ms: durationMs,
        capture_id: null,
        session_id: null,
        error: null,
        client_used: 'openai',
        cost_usd: String(costUsd),
      })
    } catch (err) {
      // Audit log failure must not break the caller
      logger.error({ err, briefId: id }, '[tts] Failed to write ai_audit_log')
    }

    // Step 7: return audio
    logger.info({ briefId: id, voice, chars: charCount, bytes: audioBuffer.length, durationMs, costUsd }, '[tts] generated audio')
    return new Response(new Uint8Array(audioBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audioBuffer.length),
        'X-TTS-Cache': 'miss',
      },
    })
  })
}
