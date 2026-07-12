import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BriefsService } from '../services/briefs.js'
import { NotFoundError } from '@open-brain/shared'

// ---------------------------------------------------------------------------
// Mock pg-notify (BriefsService.create() fires a fire-and-forget notify)
// ---------------------------------------------------------------------------
vi.mock('../lib/pg-notify.js', () => ({
  pgNotify: {
    notify: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  },
}))

import { pgNotify } from '../lib/pg-notify.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeBriefRow(overrides: Record<string, unknown> = {}) {
  const d = new Date('2026-05-01T09:00:00Z')
  return {
    id: 'brief-1',
    kind: 'WEEKLY',
    cover: 'cover-url',
    title: 'Weekly Brief',
    subtitle: 'Your week in review',
    source_skill_log_id: 'skill-log-1',
    refined_from_id: null,
    body_html: '<h1>Brief</h1>',
    toc: [{ label: 'Intro', anchor: 'intro' }],
    sources: [{ id: 'cap-1' }],
    refine_options: ['Shorter', 'More formal'],
    generated_at: d,
    read_at: null,
    dismissed_at: null,
    created_at: d,
    updated_at: d,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Generalized fluent Drizzle mock — each select/insert/update call consumes the
// next result set from `queue`. Every chain node is thenable (resolves to its
// bound result) and exposes .returning() resolving to the same result.
// ---------------------------------------------------------------------------
function makeDb(queue: unknown[][]) {
  function chain(result: unknown[]) {
    const terminal = Promise.resolve(result)
    const c: Record<string, unknown> = {}
    for (const m of [
      'from', 'leftJoin', 'innerJoin', 'where', 'groupBy', 'orderBy',
      'limit', 'offset', 'set', 'values',
    ]) {
      c[m] = vi.fn().mockReturnValue(c)
    }
    c.returning = vi.fn().mockResolvedValue(result)
    ;(c as any).then = (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      terminal.then(res, rej)
    ;(c as any).catch = (rej: (e: unknown) => void) => terminal.catch(rej)
    return c
  }
  return {
    select: vi.fn(() => chain(queue.shift() ?? [])),
    insert: vi.fn(() => chain(queue.shift() ?? [])),
    update: vi.fn(() => chain(queue.shift() ?? [])),
    execute: vi.fn(async () => ({ rows: queue.shift() ?? [] })),
  } as any
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BriefsService.list', () => {
  it('returns paginated list-shape items with ISO date strings and defaults', async () => {
    const row = makeBriefRow()
    const db = makeDb([[row], [{ total: '1' }]])
    const svc = new BriefsService(db)

    const result = await svc.list({})

    expect(result.total).toBe(1)
    expect(result.limit).toBe(20)
    expect(result.offset).toBe(0)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].id).toBe('brief-1')
    // dates mapped to ISO strings
    expect(result.items[0].generated_at).toBe('2026-05-01T09:00:00.000Z')
    expect(result.items[0].read_at).toBeNull()
    // list shape must NOT include body_html
    expect((result.items[0] as unknown as Record<string, unknown>).body_html).toBeUndefined()
  })

  it('caps limit at 100 and applies kind + unread filters', async () => {
    const db = makeDb([[], [{ total: '0' }]])
    const svc = new BriefsService(db)

    const result = await svc.list({ kind: 'DAILY', unread: true, limit: 500, offset: 40 })

    expect(result.limit).toBe(100)
    expect(result.offset).toBe(40)
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })
})

describe('BriefsService.getById', () => {
  it('returns full detail shape including body_html', async () => {
    const db = makeDb([[makeBriefRow()]])
    const svc = new BriefsService(db)

    const detail = await svc.getById('brief-1')

    expect(detail.id).toBe('brief-1')
    expect(detail.body_html).toBe('<h1>Brief</h1>')
    expect(detail.toc).toEqual([{ label: 'Intro', anchor: 'intro' }])
  })

  it('throws NotFoundError when the brief does not exist', async () => {
    const db = makeDb([[]])
    const svc = new BriefsService(db)

    await expect(svc.getById('missing')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('BriefsService.create', () => {
  it('inserts a brief, fires a brief_created notification, and returns detail', async () => {
    const inserted = makeBriefRow({ id: 'brief-new' })
    const db = makeDb([[inserted]])
    const svc = new BriefsService(db)

    const detail = await svc.create({
      kind: 'WEEKLY',
      cover: 'c',
      title: 'T',
      body_html: '<p>x</p>',
    })

    expect(detail.id).toBe('brief-new')
    expect(pgNotify.notify).toHaveBeenCalledTimes(1)
    expect(pgNotify.notify).toHaveBeenCalledWith(
      'brief_created',
      expect.objectContaining({ id: 'brief-new', kind: 'WEEKLY' }),
    )
  })

  it('throws when the insert returns no rows', async () => {
    const db = makeDb([[]])
    const svc = new BriefsService(db)

    await expect(
      svc.create({ kind: 'WEEKLY', cover: 'c', title: 'T', body_html: '<p>x</p>' }),
    ).rejects.toThrow(/no rows/)
    expect(pgNotify.notify).not.toHaveBeenCalled()
  })
})

describe('BriefsService.refine', () => {
  it('verifies the brief exists then enqueues a refine-brief job', async () => {
    // getById() consumes one result set (the existence check)
    const db = makeDb([[makeBriefRow()]])
    const add = vi.fn().mockResolvedValue({ id: 'job-42' })
    const svc = new BriefsService(db, { add } as any)

    const out = await svc.refine('brief-1', 'Shorter')

    expect(out).toEqual({ job_id: 'job-42', status: 'queued' })
    expect(add).toHaveBeenCalledTimes(1)
    const [jobName, jobData] = add.mock.calls[0]
    expect(jobName).toBe('refine-brief')
    expect(jobData).toMatchObject({
      skillName: 'refine-brief',
      input: { source_brief_id: 'brief-1', option: 'Shorter' },
    })
  })

  it('throws when no skillQueue is injected', async () => {
    const db = makeDb([[makeBriefRow()]])
    const svc = new BriefsService(db) // no queue

    await expect(svc.refine('brief-1', 'Shorter')).rejects.toThrow(/skillQueue/)
  })

  it('propagates NotFoundError when the source brief is missing', async () => {
    const db = makeDb([[]]) // getById finds nothing
    const add = vi.fn()
    const svc = new BriefsService(db, { add } as any)

    await expect(svc.refine('missing', 'Shorter')).rejects.toBeInstanceOf(NotFoundError)
    expect(add).not.toHaveBeenCalled()
  })
})

describe('BriefsService.dismiss', () => {
  it('resolves when a row is updated', async () => {
    const db = makeDb([[{ id: 'brief-1' }]])
    const svc = new BriefsService(db)

    await expect(svc.dismiss('brief-1')).resolves.toBeUndefined()
  })

  it('throws NotFoundError when nothing was updated', async () => {
    const db = makeDb([[]])
    const svc = new BriefsService(db)

    await expect(svc.dismiss('missing')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('BriefsService.patchRead', () => {
  it('marks a brief read and returns the list-shape item', async () => {
    const readRow = makeBriefRow({ read_at: new Date('2026-05-02T00:00:00Z') })
    const db = makeDb([[readRow]])
    const svc = new BriefsService(db)

    const item = await svc.patchRead('brief-1', true)

    expect(item.id).toBe('brief-1')
    expect(item.read_at).toBe('2026-05-02T00:00:00.000Z')
  })

  it('marks a brief unread (read_at null)', async () => {
    const db = makeDb([[makeBriefRow({ read_at: null })]])
    const svc = new BriefsService(db)

    const item = await svc.patchRead('brief-1', false)

    expect(item.read_at).toBeNull()
  })

  it('throws NotFoundError when nothing was updated', async () => {
    const db = makeDb([[]])
    const svc = new BriefsService(db)

    await expect(svc.patchRead('missing', true)).rejects.toBeInstanceOf(NotFoundError)
  })
})
