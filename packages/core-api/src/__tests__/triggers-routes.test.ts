/**
 * Route tests for the triggers API.
 *
 * Routes under test:
 *   GET    /api/v1/triggers        — list all triggers
 *   POST   /api/v1/triggers        — create trigger (generates embedding)
 *   DELETE /api/v1/triggers/:id    — hard-delete trigger by name or UUID
 *   POST   /api/v1/triggers/test   — test query against captures, no fire
 *
 * DI strategy: TriggerService is injected via registerTriggerRoutes().
 * All methods are vi.fn() stubs. The makeTestApp() helper from ./helpers.ts
 * wires the Hono error handler so AppError subclasses produce correct
 * {error, code} JSON at the right HTTP status code.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerTriggerRoutes } from '../routes/triggers.js'
import type { TriggerService, TriggerRecord, TriggerTestMatch } from '../services/trigger.js'
import { makeTestApp, testJson } from './helpers.js'

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const SAMPLE_TRIGGER: TriggerRecord = {
  id: 'trigger-uuid-1',
  name: 'QSR timeline',
  description: 'Watch for QSR project timeline discussions',
  condition_text: 'QSR project timeline compressed urgent',
  threshold: 0.72,
  action: 'notify',
  action_config: { delivery_channel: 'pushover', cooldown_minutes: 60 },
  enabled: true,
  last_triggered_at: null,
  trigger_count: 0,
  created_at: new Date('2026-03-05T10:00:00Z'),
  updated_at: new Date('2026-03-05T10:00:00Z'),
}

const SAMPLE_MATCH: TriggerTestMatch = {
  capture_id: 'cap-abc',
  content: 'QSR project timeline is very compressed this quarter',
  similarity: 0.87,
  capture_type: 'observation',
  brain_view: 'work-internal',
  created_at: new Date('2026-03-01T10:00:00Z'),
}

// ---------------------------------------------------------------------------
// Mock factory
// ---------------------------------------------------------------------------

function makeMockTriggerService(overrides: Partial<TriggerService> = {}): TriggerService {
  return {
    list: vi.fn().mockResolvedValue([SAMPLE_TRIGGER]),
    create: vi.fn().mockResolvedValue(SAMPLE_TRIGGER),
    delete: vi.fn().mockResolvedValue(undefined),
    test: vi.fn().mockResolvedValue([SAMPLE_MATCH]),
    loadActiveTriggers: vi.fn().mockResolvedValue([]),
    recordFire: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as TriggerService
}

function buildApp(svc?: TriggerService) {
  const service = svc ?? makeMockTriggerService()
  return makeTestApp((app) => {
    registerTriggerRoutes(app, service)
  })
}

// ---------------------------------------------------------------------------
// GET /api/v1/triggers
// ---------------------------------------------------------------------------

describe('GET /api/v1/triggers', () => {
  it('returns trigger list wrapped in triggers key', async () => {
    const app = buildApp()
    const { status, body } = await testJson(app, '/api/v1/triggers')

    expect(status).toBe(200)
    const b = body as any
    expect(b.triggers).toHaveLength(1)
    expect(b.triggers[0].id).toBe('trigger-uuid-1')
    expect(b.triggers[0].name).toBe('QSR timeline')
  })

  it('returns empty array when no triggers exist', async () => {
    const svc = makeMockTriggerService({ list: vi.fn().mockResolvedValue([]) })
    const app = buildApp(svc)
    const { status, body } = await testJson(app, '/api/v1/triggers')

    expect(status).toBe(200)
    expect((body as any).triggers).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/triggers — create
// ---------------------------------------------------------------------------

describe('POST /api/v1/triggers', () => {
  it('creates trigger and returns 201 with trigger payload', async () => {
    const svc = makeMockTriggerService()
    const app = buildApp(svc)

    const { status, body } = await testJson(app, '/api/v1/triggers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'QSR timeline',
        queryText: 'QSR project timeline compressed urgent',
      }),
    })

    expect(status).toBe(201)
    const b = body as any
    expect(b.trigger.id).toBe('trigger-uuid-1')
    expect(b.trigger.name).toBe('QSR timeline')
    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'QSR timeline', queryText: 'QSR project timeline compressed urgent' }),
    )
  })

  it('passes optional threshold and cooldownMinutes to create()', async () => {
    const svc = makeMockTriggerService()
    const app = buildApp(svc)

    await testJson(app, '/api/v1/triggers', {
      method: 'POST',
      body: JSON.stringify({
        name: 'High threshold trigger',
        queryText: 'specific critical topic',
        threshold: 0.9,
        cooldownMinutes: 120,
        deliveryChannel: 'slack',
      }),
    })

    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({
        threshold: 0.9,
        cooldownMinutes: 120,
        deliveryChannel: 'slack',
      }),
    )
  })

  it('returns 400 when name is missing', async () => {
    const app = buildApp()
    const { status, body } = await testJson(app, '/api/v1/triggers', {
      method: 'POST',
      body: JSON.stringify({ queryText: 'some query' }),
    })

    expect(status).toBe(400)
    expect((body as any).error).toContain('name is required')
  })

  it('returns 400 when queryText is missing', async () => {
    const app = buildApp()
    const { status, body } = await testJson(app, '/api/v1/triggers', {
      method: 'POST',
      body: JSON.stringify({ name: 'my trigger' }),
    })

    expect(status).toBe(400)
    expect((body as any).error).toContain('queryText is required')
  })

  it('returns 400 when name is an empty string', async () => {
    const app = buildApp()
    const { status, body } = await testJson(app, '/api/v1/triggers', {
      method: 'POST',
      body: JSON.stringify({ name: '   ', queryText: 'some query' }),
    })

    expect(status).toBe(400)
    expect((body as any).error).toContain('name is required')
  })

  it('returns 400 when body is not valid JSON', async () => {
    const app = buildApp()
    const { status, body } = await testJson(app, '/api/v1/triggers', {
      method: 'POST',
      body: 'not-json',
    })

    expect(status).toBe(400)
    expect((body as any).error).toContain('Invalid JSON body')
  })

  it('propagates service ValidationError (e.g. threshold out of range) as 400', async () => {
    const { ValidationError } = await import('@open-brain/shared')
    const svc = makeMockTriggerService({
      create: vi.fn().mockRejectedValue(new ValidationError('Threshold must be between 0.0 and 1.0')),
    })
    const app = buildApp(svc)

    const { status, body } = await testJson(app, '/api/v1/triggers', {
      method: 'POST',
      body: JSON.stringify({ name: 'test', queryText: 'hello', threshold: 1.5 }),
    })

    expect(status).toBe(400)
    expect((body as any).error).toContain('Threshold')
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/v1/triggers/:id
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/triggers/:id', () => {
  it('deletes trigger by ID and returns success message', async () => {
    const svc = makeMockTriggerService()
    const app = buildApp(svc)

    const { status, body } = await testJson(app, '/api/v1/triggers/trigger-uuid-1', {
      method: 'DELETE',
    })

    expect(status).toBe(200)
    expect((body as any).message).toContain('trigger-uuid-1')
    expect(svc.delete).toHaveBeenCalledWith('trigger-uuid-1')
  })

  it('returns 404 when trigger does not exist', async () => {
    const { NotFoundError } = await import('@open-brain/shared')
    const svc = makeMockTriggerService({
      delete: vi.fn().mockRejectedValue(new NotFoundError('Trigger not found: ghost-id')),
    })
    const app = buildApp(svc)

    const { status, body } = await testJson(app, '/api/v1/triggers/ghost-id', {
      method: 'DELETE',
    })

    expect(status).toBe(404)
    expect((body as any).error).toContain('not found')
  })

  it('accepts trigger deletion by name (passes name as-is to service)', async () => {
    const svc = makeMockTriggerService()
    const app = buildApp(svc)

    await testJson(app, '/api/v1/triggers/QSR%20timeline', { method: 'DELETE' })

    expect(svc.delete).toHaveBeenCalledWith('QSR timeline')
  })
})

// ---------------------------------------------------------------------------
// POST /api/v1/triggers/test
// ---------------------------------------------------------------------------

describe('POST /api/v1/triggers/test', () => {
  it('returns top matches for a valid queryText', async () => {
    const svc = makeMockTriggerService()
    const app = buildApp(svc)

    const { status, body } = await testJson(app, '/api/v1/triggers/test', {
      method: 'POST',
      body: JSON.stringify({ queryText: 'QSR timeline urgency' }),
    })

    expect(status).toBe(200)
    const b = body as any
    expect(b.query).toBe('QSR timeline urgency')
    expect(b.matches).toHaveLength(1)
    expect(b.matches[0].capture_id).toBe('cap-abc')
    expect(b.matches[0].similarity).toBe(0.87)
    expect(svc.test).toHaveBeenCalledWith('QSR timeline urgency', 5)
  })

  it('passes custom limit (capped at 20)', async () => {
    const svc = makeMockTriggerService()
    const app = buildApp(svc)

    await testJson(app, '/api/v1/triggers/test', {
      method: 'POST',
      body: JSON.stringify({ queryText: 'hello', limit: 50 }),
    })

    // Route caps at 20
    expect(svc.test).toHaveBeenCalledWith('hello', 20)
  })

  it('uses default limit of 5 when not specified', async () => {
    const svc = makeMockTriggerService()
    const app = buildApp(svc)

    await testJson(app, '/api/v1/triggers/test', {
      method: 'POST',
      body: JSON.stringify({ queryText: 'hello' }),
    })

    expect(svc.test).toHaveBeenCalledWith('hello', 5)
  })

  it('returns 400 when queryText is missing', async () => {
    const app = buildApp()
    const { status, body } = await testJson(app, '/api/v1/triggers/test', {
      method: 'POST',
      body: JSON.stringify({ limit: 3 }),
    })

    expect(status).toBe(400)
    expect((body as any).error).toContain('queryText is required')
  })

  it('returns 400 when queryText is blank', async () => {
    const app = buildApp()
    const { status, body } = await testJson(app, '/api/v1/triggers/test', {
      method: 'POST',
      body: JSON.stringify({ queryText: '   ' }),
    })

    expect(status).toBe(400)
    expect((body as any).error).toContain('queryText is required')
  })

  it('returns 400 when body is not valid JSON', async () => {
    const app = buildApp()
    const { status, body } = await testJson(app, '/api/v1/triggers/test', {
      method: 'POST',
      body: 'not-json',
    })

    expect(status).toBe(400)
    expect((body as any).error).toContain('Invalid JSON body')
  })

  it('returns empty matches array when service finds no results', async () => {
    const svc = makeMockTriggerService({ test: vi.fn().mockResolvedValue([]) })
    const app = buildApp(svc)

    const { status, body } = await testJson(app, '/api/v1/triggers/test', {
      method: 'POST',
      body: JSON.stringify({ queryText: 'very obscure topic with zero matches' }),
    })

    expect(status).toBe(200)
    expect((body as any).matches).toHaveLength(0)
  })
})
