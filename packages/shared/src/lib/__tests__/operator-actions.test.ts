import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  parseOperatorActions,
  summarizeOperatorActions,
  loadOperatorActions,
} from '../operator-actions.js'

function table(rows: Array<[string, string, string]>): string {
  const body = rows.map(([id, due, status]) => `| ${id} | do ${id} | ${due} | Troy | src | ${status} |`).join('\n')
  return `# Reg\n\n## Open Actions\n\n| ID | Action | Due | Owner | Source | Status |\n|----|--------|-----|-------|--------|--------|\n${body}\n\n## Completed Actions\n\n| ID | Action | Completed | Source |\n|----|--------|-----------|--------|\n| OA-99 | x | y | z |\n`
}

const stateOf = (status: string): string => {
  const { actions, parseErrors } = parseOperatorActions(table([['OA-1', '2026-01-01', status]]))
  return parseErrors.length > 0 ? 'error' : actions[0].state
}

describe('parseOperatorActions status vocabulary', () => {
  it.each([
    ['OPEN', 'open'],
    ['**OPEN**', 'open'],
    ['OPEN (upstream)', 'open'],
    ['IN PROGRESS', 'open'],
    ['**IN PROGRESS 2026-07-14** (detail)', 'open'],
    ['DONE 2026-07-14', 'closed'],
    ['**DONE 2026-07-16** — detail', 'closed'],
    ['✅ DONE', 'closed'],
    ['BLOCKED (reason)', 'closed'],
    ['**BLOCKED 2026-07-14 — x**', 'closed'],
    ['OBSOLETE 2026-07-14', 'closed'],
    ['CLOSED', 'closed'],
    ['PARTIAL 2026-07-14', 'error'],
    ['GATE NEARLY CLEARED', 'error'],
    ['', 'error'],
  ])('%s -> %s', (status, expected) => {
    expect(stateOf(status)).toBe(expected)
  })

  it('reads only the Open Actions table, skipping header and separator', () => {
    const { actions } = parseOperatorActions(table([['OA-1', '2026-01-01', 'OPEN'], ['OA-2', '2026-01-02', 'DONE 2026-01-01']]))
    expect(actions.map((a) => a.id)).toEqual(['OA-1', 'OA-2'])
  })

  it('reports the offending id and status for an unknown status', () => {
    const { parseErrors } = parseOperatorActions(table([['OA-7', '2026-01-01', 'PARTIAL']]))
    expect(parseErrors).toEqual([{ id: 'OA-7', status: 'PARTIAL' }])
  })

  it('returns nothing for a document without the table', () => {
    expect(parseOperatorActions('no table here')).toEqual({ actions: [], parseErrors: [] })
  })
})

describe('summarizeOperatorActions', () => {
  const now = new Date('2026-11-23T12:00:00Z')

  it('counts open rows, overdue rows, and returns the 3 oldest overdue', () => {
    const rows: Array<[string, string, string]> = [
      ['OA-1', '2026-07-01', 'OPEN'],
      ['OA-2', '2026-05-01', 'OPEN'],
      ['OA-3', '2026-06-01', 'IN PROGRESS'],
      ['OA-4', '2026-08-01', 'OPEN'],
      ['OA-5', '2026-01-01', 'DONE 2026-02-01'],
      ['OA-6', '2026-12-31', 'OPEN'],
      ['OA-7', 'with the deploy', 'OPEN'],
    ]
    const s = summarizeOperatorActions(parseOperatorActions(table(rows)), now)
    expect(s.open).toBe(6)
    expect(s.overdue).toBe(4)
    expect(s.oldest.map((a) => a.id)).toEqual(['OA-2', 'OA-3', 'OA-1'])
    expect(s.parseErrors).toEqual([])
  })

  it('a row due today is not overdue', () => {
    const s = summarizeOperatorActions(parseOperatorActions(table([['OA-1', '2026-11-23', 'OPEN']])), now)
    expect(s.overdue).toBe(0)
  })

  it('carries parse errors through', () => {
    const s = summarizeOperatorActions(parseOperatorActions(table([['OA-1', '2026-01-01', 'WEIRD']])), now)
    expect(s.parseErrors).toEqual([{ id: 'OA-1', status: 'WEIRD' }])
    expect(s.open).toBe(0)
  })
})

describe('loadOperatorActions', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'oa-'))
  const file = resolve(dir, 'OA.md')
  writeFileSync(file, 'FROM FILE')

  it('uses the fetched register when the fetch succeeds', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => 'FROM URL' })
    await expect(loadOperatorActions({ url: 'http://x', fallbackPath: file, fetchFn })).resolves.toBe('FROM URL')
  })

  it('falls back to the file on a network error', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('down'))
    await expect(loadOperatorActions({ url: 'http://x', fallbackPath: file, fetchFn })).resolves.toBe('FROM FILE')
  })

  it('falls back to the file on a non-ok response', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'nope' })
    await expect(loadOperatorActions({ url: 'http://x', fallbackPath: file, fetchFn })).resolves.toBe('FROM FILE')
  })

  it('throws when both sources fail', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('down'))
    await expect(loadOperatorActions({ url: 'http://x', fallbackPath: resolve(dir, 'missing.md'), fetchFn })).rejects.toThrow()
  })
})

describe('the real OPERATOR_ACTIONS.md', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const md = readFileSync(resolve(here, '../../../../../OPERATOR_ACTIONS.md'), 'utf8')
  const parsed = parseOperatorActions(md)

  it('has rows', () => {
    expect(parsed.actions.length).toBeGreaterThan(10)
  })

  it('uses only the enforced status vocabulary', () => {
    expect(parsed.parseErrors).toEqual([])
  })

  it('gives every open row a YYYY-MM-DD due date', () => {
    const bad = parsed.actions.filter((a) => a.state === 'open' && a.dueDate === null).map((a) => a.id)
    expect(bad).toEqual([])
  })
})
