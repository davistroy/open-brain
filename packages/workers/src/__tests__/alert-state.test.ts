import { describe, it, expect, vi } from 'vitest'
import {
  nextAction,
  readAlertState,
  writeAlertState,
  listOpenAlerts,
  alertStateKey,
  type AlertState,
} from '../lib/alert-state.js'
import { logger } from '@open-brain/shared'

const NOW = new Date('2026-11-23T12:00:00Z')

const badState: AlertState = {
  status: 'bad',
  since: '2026-11-22T12:00:00.000Z',
  last_notified_at: '2026-11-22T12:00:00.000Z',
  level: 0,
  receipt: null,
  acked_at: null,
}
const okState: AlertState = { ...badState, status: 'ok' }

describe('nextAction', () => {
  const cases: Array<[string, AlertState | null | undefined, boolean, 'critical' | 'warning', string]> = [
    ['ok -> bad', okState, true, 'critical', 'notify'],
    ['bad -> bad', badState, true, 'critical', 'none'],
    ['bad -> bad (warning)', badState, true, 'warning', 'none'],
    ['bad -> ok', badState, false, 'critical', 'resolve'],
    ['ok -> ok', okState, false, 'warning', 'none'],
    ['missing state + bad', null, true, 'critical', 'notify'],
    ['undefined state + bad', undefined, true, 'warning', 'notify'],
    ['missing state + ok', null, false, 'critical', 'none'],
  ]
  it.each(cases)('%s', (_n, state, bad, severity, expected) => {
    expect(nextAction(state, { bad, severity, now: NOW })).toBe(expected)
  })
})

describe('alertStateKey', () => {
  it('prefixes the key', () => {
    expect(alertStateKey('backup-stale')).toBe('alert_state:backup-stale')
  })
})

describe('alert-state store', () => {
  it('read returns null when no row', async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) }
    expect(await readAlertState(db as never, 'k')).toBeNull()
  })

  it('write then read round-trips the state', async () => {
    let stored: unknown = null
    const db = {
      execute: vi.fn().mockImplementation(async (q: { queryChunks?: unknown[] }) => {
        // the write statement carries the JSON string as a bound param
        const chunks = (q.queryChunks ?? []) as unknown[]
        const param = chunks.find((c) => typeof c === 'string' && c.startsWith('{'))
        if (param) {
          stored = JSON.parse(param as string)
          return { rows: [] }
        }
        return { rows: stored ? [{ value: stored }] : [] }
      }),
    }
    await writeAlertState(db as never, 'backup-stale', badState)
    expect(db.execute).toHaveBeenCalledTimes(1)
    expect(await readAlertState(db as never, 'backup-stale')).toEqual(badState)
  })

  it('read accepts a JSON string value', async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ value: JSON.stringify(badState) }] }) }
    expect(await readAlertState(db as never, 'k')).toEqual(badState)
  })

  it('unparseable JSON is treated as ok (null) with a warn log', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ value: '{not json' }] }) }
    expect(await readAlertState(db as never, 'k')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('a value of the wrong shape is treated as ok (null) with a warn log', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ value: { status: 'weird' } }] }) }
    expect(await readAlertState(db as never, 'k')).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('db errors propagate (raiseAlert fails open on them)', async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error('db down')) }
    await expect(readAlertState(db as never, 'k')).rejects.toThrow('db down')
    await expect(writeAlertState(db as never, 'k', badState)).rejects.toThrow('db down')
  })

  it('listOpenAlerts returns only bad states, key stripped of the prefix', async () => {
    const db = {
      execute: vi.fn().mockResolvedValue({
        rows: [
          { key: 'alert_state:backup-stale', value: badState },
          { key: 'alert_state:queues', value: okState },
          { key: 'alert_state:junk', value: 'garbage' },
        ],
      }),
    }
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
    const open = await listOpenAlerts(db as never)
    expect(open).toEqual([{ key: 'backup-stale', state: badState }])
    warn.mockRestore()
  })
})
