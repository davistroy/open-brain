/**
 * Item 3.3 — POST /api/v1/internal/heartbeat/:source.
 * The route reuses the existing `utility-pipeline` / `actual-pipeline` callers
 * (both already in BYPASS_CALLERS) and writes `app_settings` `heartbeat:<source>`.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { registerHeartbeatRoutes } from '../routes/heartbeat.js'
import { makeTestApp } from './helpers.js'

function flatten(q: unknown): { text: string; params: unknown[] } {
  const chunks = (q as { queryChunks: unknown[] }).queryChunks
  let text = ''
  const params: unknown[] = []
  for (const c of chunks) {
    if (c && typeof c === 'object' && 'value' in c && Array.isArray((c as { value: unknown }).value)) {
      text += ((c as { value: string[] }).value).join('')
    } else {
      params.push(c)
      text += '?'
    }
  }
  return { text, params }
}

function setup(existing: unknown = null) {
  const execute = vi.fn(async (q: unknown) => {
    const { text } = flatten(q)
    if (text.includes('SELECT')) return { rows: existing === null ? [] : [{ value: existing }] }
    return { rows: [] }
  })
  const app = makeTestApp((a) => {
    registerHeartbeatRoutes(a, { execute } as never)
  })
  const post = (source: string, caller: string | null, body: unknown) =>
    app.request(`/api/v1/internal/heartbeat/${source}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(caller ? { 'X-Open-Brain-Caller': caller } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  const writes = () => execute.mock.calls.map((c) => flatten(c[0])).filter((q) => q.text.includes('INSERT'))
  return { post, writes, execute }
}

describe('POST /api/v1/internal/heartbeat/:source', () => {
  it('upserts heartbeat:gas for caller utility-pipeline and returns 200 with the stored shape', async () => {
    const { post, writes } = setup()
    const res = await post('gas', 'utility-pipeline', { ok: true, meta: { latest_bill_date: '2026-11-01' } })
    expect(res.status).toBe(200)
    const json = (await res.json()) as { source: string; record: Record<string, unknown> }
    expect(json.source).toBe('gas')
    expect(json.record).toMatchObject({ ok: true, errors: [], meta: { latest_bill_date: '2026-11-01' } })
    expect(typeof json.record.last_attempt_at).toBe('string')
    expect(json.record.last_success_at).toBe(json.record.last_attempt_at)
    const w = writes()
    expect(w).toHaveLength(1)
    expect(w[0].params).toContain('heartbeat:gas')
    expect(JSON.parse(w[0].params.find((p) => typeof p === 'string' && p.startsWith('{')) as string)).toEqual(json.record)
  })

  it('accepts actual from actual-pipeline', async () => {
    const { post } = setup()
    expect((await post('actual', 'actual-pipeline', { ok: true })).status).toBe(200)
  })

  it('keeps last_success_at and stores at most 5 errors when ok is false', async () => {
    const prev = { last_attempt_at: '2026-11-20T00:00:00.000Z', last_success_at: '2026-11-20T00:00:00.000Z', ok: true, errors: [], meta: {} }
    const { post } = setup(prev)
    const res = await post('gas', 'utility-pipeline', { ok: false, errors: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })
    const json = (await res.json()) as { record: { ok: boolean; errors: string[]; last_success_at: string } }
    expect(json.record.ok).toBe(false)
    expect(json.record.errors).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(json.record.last_success_at).toBe('2026-11-20T00:00:00.000Z')
  })

  it('returns 400 for an unknown source and writes nothing', async () => {
    const { post, execute } = setup()
    const res = await post('plaid', 'utility-pipeline', { ok: true })
    expect(res.status).toBe(400)
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([['integration-test'], ['web-next-public'], ['workers'], [null]])('returns 403 for caller %s and writes nothing', async (caller) => {
    const { post, execute } = setup()
    const res = await post('gas', caller, { ok: true })
    expect(res.status).toBe(403)
    expect(execute).not.toHaveBeenCalled()
  })

  it('checks the caller before the source (a bad caller on an unknown source is 403)', async () => {
    const { post } = setup()
    expect((await post('plaid', 'web-next-public', { ok: true })).status).toBe(403)
  })

  it.each([
    ['not json', 'nope'],
    ['missing ok', {}],
    ['ok not boolean', { ok: 'yes' }],
    ['errors not strings', { ok: false, errors: [1] }],
    ['meta array', { ok: true, meta: [] }],
  ])('returns 400 for a bad body (%s) and writes nothing', async (_n, body) => {
    const { post, execute } = setup()
    const res = await post('gas', 'utility-pipeline', body)
    expect(res.status).toBe(400)
    expect(execute).not.toHaveBeenCalled()
  })

  it('does not expose heartbeat keys through the settings API', () => {
    const src = readFileSync(fileURLToPath(new URL('../routes/settings.ts', import.meta.url)), 'utf8')
    expect(src).not.toContain('heartbeat')
  })
})
