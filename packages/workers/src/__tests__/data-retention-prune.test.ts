import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  RETENTION_POLICY,
  pruneRetentionData,
  pruneSoftDeletedCaptures,
} from '../jobs/data-retention-prune.js'
import type { RetentionPolicyEntry } from '../jobs/data-retention-prune.js'

// Convenience helper — renders a Drizzle sql`` template tag result to a
// { sql, params } object.  `arg` is typed as `any` because the drizzle-orm
// SQL object type is opaque to test code.
function renderSql(arg: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(arg as any)
}

// ============================================================
// Allowed tables + expected configuration
// ============================================================

const EXPECTED_POLICY: RetentionPolicyEntry[] = [
  { table: 'pipeline_events',       column: 'created_at',   days: 90  },
  { table: 'ai_audit_log',          column: 'created_at',   days: 180 },
  { table: 'activity_feed',         column: 'timestamp',    days: 30  },
  { table: 'mcp_activity',          column: 'created_at',   days: 30  },
  { table: 'skills_log',            column: 'created_at',   days: 60  },
  { table: 'container_health',      column: 'created_at',   days: 30  },
  { table: 'email_classifications', column: 'processed_at', days: 60  },
]

// ============================================================
// Mock helpers
// ============================================================

/**
 * Creates a mock Database whose execute() call returns a successful result.
 * For DELETE CTEs it returns a deleted_count row; for INSERT it returns empty.
 */
function makeMockDb(deletedCountPerCall = 5) {
  // execute() is called twice per policy entry:
  //   call 1 — DELETE CTE returning deleted_count
  //   call 2 — INSERT INTO retention_audit
  const execute = vi.fn().mockImplementation((_sqlArg: unknown) => {
    // Return a rows array that matches what the DELETE CTE SELECT returns.
    // INSERT returns an empty rows array — that is fine; the job ignores it.
    return Promise.resolve({ rows: [{ deleted_count: deletedCountPerCall }] })
  })

  return { execute, _execute: execute }
}

// ============================================================
// INVARIANT: admin_audit must never be pruned
// ============================================================

describe('RETENTION_POLICY — admin_audit invariant (RC-4)', () => {
  it('does NOT include admin_audit in RETENTION_POLICY', () => {
    const tables = RETENTION_POLICY.map(e => e.table)
    expect(tables).not.toContain('admin_audit')
  })

  it('does not reference admin_audit anywhere in the policy', () => {
    // Belt-and-suspenders: check column too, in case a future typo
    // tries to sneak admin_audit in via a different column name.
    for (const entry of RETENTION_POLICY) {
      expect(entry.table).not.toBe('admin_audit')
    }
  })
})

// ============================================================
// POLICY CONTENT: exact tables, columns, and retention windows
// ============================================================

describe('RETENTION_POLICY — content contract (RC-4)', () => {
  it('contains exactly 7 entries', () => {
    expect(RETENTION_POLICY).toHaveLength(7)
  })

  it('includes pipeline_events with created_at and 90-day retention', () => {
    const entry = RETENTION_POLICY.find(e => e.table === 'pipeline_events')
    expect(entry).toBeDefined()
    expect(entry?.column).toBe('created_at')
    expect(entry?.days).toBe(90)
  })

  it('includes ai_audit_log with created_at and 180-day retention', () => {
    const entry = RETENTION_POLICY.find(e => e.table === 'ai_audit_log')
    expect(entry).toBeDefined()
    expect(entry?.column).toBe('created_at')
    expect(entry?.days).toBe(180)
  })

  it('includes activity_feed with timestamp column and 30-day retention', () => {
    const entry = RETENTION_POLICY.find(e => e.table === 'activity_feed')
    expect(entry).toBeDefined()
    expect(entry?.column).toBe('timestamp')
    expect(entry?.days).toBe(30)
  })

  it('includes mcp_activity with created_at and 30-day retention', () => {
    const entry = RETENTION_POLICY.find(e => e.table === 'mcp_activity')
    expect(entry).toBeDefined()
    expect(entry?.column).toBe('created_at')
    expect(entry?.days).toBe(30)
  })

  it('includes skills_log with created_at and 60-day retention', () => {
    const entry = RETENTION_POLICY.find(e => e.table === 'skills_log')
    expect(entry).toBeDefined()
    expect(entry?.column).toBe('created_at')
    expect(entry?.days).toBe(60)
  })

  // DA-3/RC-15 (Phase 8.4) — previously-unbounded event tables.
  it('includes container_health with created_at and 30-day retention', () => {
    const entry = RETENTION_POLICY.find(e => e.table === 'container_health')
    expect(entry).toBeDefined()
    expect(entry?.column).toBe('created_at')
    expect(entry?.days).toBe(30)
  })

  it('includes email_classifications with processed_at and 60-day retention', () => {
    const entry = RETENTION_POLICY.find(e => e.table === 'email_classifications')
    expect(entry).toBeDefined()
    expect(entry?.column).toBe('processed_at')
    expect(entry?.days).toBe(60)
  })

  it('does NOT include voice_sessions — removed with the dead conversational-voice feature (#298/D143)', () => {
    const tables = RETENTION_POLICY.map(e => e.table)
    expect(tables).not.toContain('voice_sessions')
  })

  it('matches the full expected policy exactly (table/column/days)', () => {
    // Sort both by table name before comparing so order doesn't matter.
    const actual = [...RETENTION_POLICY].sort((a, b) => a.table.localeCompare(b.table))
    const expected = [...EXPECTED_POLICY].sort((a, b) => a.table.localeCompare(b.table))
    expect(actual).toEqual(expected)
  })
})

// ============================================================
// SQL RENDERING: DELETE query uses correct table, column, interval
// ============================================================

describe('pruneRetentionData — generated SQL (RC-4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('DELETE SQL for pipeline_events references the correct table name', async () => {
    const db = makeMockDb()

    await pruneRetentionData(db as any)

    const firstEntry = RETENTION_POLICY.find(e => e.table === 'pipeline_events')!
    // Find the execute call whose rendered SQL mentions pipeline_events.
    const allCalls = db._execute.mock.calls as unknown[][]
    const pipelineCall = allCalls.find(([arg]) => renderSql(arg).sql.includes('pipeline_events'))
    expect(pipelineCall).toBeDefined()

    const { sql: renderedSql } = renderSql(pipelineCall![0])
    expect(renderedSql).toContain('pipeline_events')
    expect(renderedSql).toContain(firstEntry.column)         // 'created_at'
    expect(renderedSql).toContain(`${firstEntry.days} days`) // '90 days'
  })

  it('DELETE SQL for activity_feed uses the timestamp column', async () => {
    const db = makeMockDb()

    await pruneRetentionData(db as any)

    const allCalls = db._execute.mock.calls as unknown[][]
    const feedCall = allCalls.find(([arg]) => renderSql(arg).sql.includes('activity_feed'))
    expect(feedCall).toBeDefined()

    const { sql: renderedSql } = renderSql(feedCall![0])
    expect(renderedSql).toContain('activity_feed')
    expect(renderedSql).toContain('timestamp')
    expect(renderedSql).toContain('30 days')
  })

  it('generates a retention_audit INSERT for each policy entry', async () => {
    const db = makeMockDb()

    await pruneRetentionData(db as any)

    // Each entry triggers 2 execute() calls: DELETE CTE + INSERT into retention_audit.
    // Total = 5 entries × 2 = 10 calls.
    expect(db._execute).toHaveBeenCalledTimes(RETENTION_POLICY.length * 2)

    // Each INSERT call must reference retention_audit.
    const allCalls = db._execute.mock.calls as unknown[][]
    const auditInserts = allCalls.filter(([arg]) => renderSql(arg).sql.includes('retention_audit'))
    expect(auditInserts).toHaveLength(RETENTION_POLICY.length)
  })

  it('passes the table_name as a parameterised value in the retention_audit INSERT', async () => {
    const db = makeMockDb()

    await pruneRetentionData(db as any)

    const allCalls = db._execute.mock.calls as unknown[][]
    const auditInserts = allCalls.filter(([arg]) => renderSql(arg).sql.includes('retention_audit'))

    // Extract all table_name parameter values passed to INSERT calls.
    const insertedTables = auditInserts.map(([arg]) => {
      const { params } = renderSql(arg)
      // table_name is the first parameter ($1) in the INSERT statement.
      return params[0]
    })

    // Every policy table must appear exactly once.
    for (const entry of RETENTION_POLICY) {
      expect(insertedTables).toContain(entry.table)
    }
    expect(insertedTables).not.toContain('admin_audit')
  })
})

// ============================================================
// BEHAVIOUR: counts, return value, error isolation
// ============================================================

describe('pruneRetentionData — behaviour', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns a result entry for every policy table', async () => {
    const db = makeMockDb(3)

    const results = await pruneRetentionData(db as any)

    expect(results).toHaveLength(RETENTION_POLICY.length)
    for (const entry of RETENTION_POLICY) {
      const result = results.find(r => r.table === entry.table)
      expect(result).toBeDefined()
    }
  })

  it('captures the deleted_count from the DELETE CTE result', async () => {
    const db = makeMockDb(7)

    const results = await pruneRetentionData(db as any)

    for (const result of results) {
      expect(result.deletedCount).toBe(7)
    }
  })

  it('returns deletedCount of 0 when no rows are deleted', async () => {
    const db = makeMockDb(0)

    const results = await pruneRetentionData(db as any)

    for (const result of results) {
      expect(result.deletedCount).toBe(0)
    }
  })

  it('isolates a first-table DELETE failure — continues pruning the rest, then throws an aggregate error', async () => {
    const db = makeMockDb()
    // Rejects only the very first execute() call — pipeline_events' DELETE
    // CTE (the first policy entry). Every subsequent call uses the default
    // successful mock implementation.
    db._execute.mockRejectedValueOnce(new Error('DB connection lost'))

    await expect(pruneRetentionData(db as any)).rejects.toThrow('DB connection lost')

    // pipeline_events' DELETE failed before its audit INSERT ever ran (1
    // call); the remaining tables still got DELETE + INSERT (2 calls
    // apiece) — per-table fault isolation, not an abort-on-first-error.
    expect(db._execute).toHaveBeenCalledTimes(1 + (RETENTION_POLICY.length - 1) * 2)
  })
})

// ============================================================
// PER-TABLE FAULT ISOLATION (Phase 1 / CS-A)
//
// A single table's DELETE failing (e.g. an FK constraint, matching the
// skills_log/briefs incident that motivated this refactor) must not abort
// the loop. The other tables must still prune + audit, and the failure
// must be surfaced via an aggregate throw at the end — never swallowed.
// ============================================================

describe('pruneRetentionData — per-table fault isolation (Phase 1 / CS-A)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * Mock Database whose execute() rejects ONLY the DELETE CTE call for
   * `failingTable` (identified by inspecting the rendered SQL, cf. the
   * table-detection pattern used above at ~test:137,152) and resolves
   * normally for every other call — including every other table's DELETE
   * + audit INSERT, and (implicitly) `failingTable`'s own audit INSERT,
   * which never runs because its DELETE throws first.
   */
  function makeMockDbWithTableFailure(failingTable: string, deletedCountPerCall = 5) {
    const execute = vi.fn().mockImplementation((arg: unknown) => {
      const { sql: renderedSql } = renderSql(arg)
      if (renderedSql.includes('DELETE FROM') && renderedSql.includes(failingTable)) {
        return Promise.reject(new Error(`simulated ${failingTable} failure`))
      }
      return Promise.resolve({ rows: [{ deleted_count: deletedCountPerCall }] })
    })
    return { execute, _execute: execute }
  }

  it('a skills_log DELETE failure does not abort the other tables', async () => {
    const db = makeMockDbWithTableFailure('skills_log')

    await expect(pruneRetentionData(db as any)).rejects.toThrow()

    const allCalls = db._execute.mock.calls as unknown[][]

    // Every table (including skills_log) still gets its DELETE attempted —
    // the table name appears raw only in the DELETE CTE, never in the
    // (parameterised) retention_audit INSERT, so `includes(table)` isolates
    // the DELETE call.
    for (const entry of RETENTION_POLICY) {
      const deleteCalls = allCalls.filter(([arg]) => renderSql(arg).sql.includes(entry.table))
      expect(deleteCalls).toHaveLength(1)
    }

    // retention_audit INSERTs — table_name is parameterised ($1), so identify
    // which table each INSERT belongs to via the bound param, mirroring the
    // pattern at ~test:176-196.
    const auditInserts = allCalls.filter(([arg]) => renderSql(arg).sql.includes('retention_audit'))
    const auditedTables = auditInserts.map(([arg]) => renderSql(arg).params[0])

    // The succeeding tables were each audited exactly once; skills_log —
    // whose DELETE failed — was never audited (its INSERT never ran).
    const otherTables = RETENTION_POLICY.filter(e => e.table !== 'skills_log')
    expect(auditedTables).toHaveLength(otherTables.length)
    for (const entry of otherTables) {
      expect(auditedTables).toContain(entry.table)
    }
    expect(auditedTables).not.toContain('skills_log')
  })

  it('surfaces the skills_log failure as an aggregate error naming the table — never swallowed', async () => {
    const db = makeMockDbWithTableFailure('skills_log')

    await expect(pruneRetentionData(db as any)).rejects.toThrow(
      new RegExp(`1/${RETENTION_POLICY.length} table\\(s\\) failed to prune:.*skills_log`),
    )
  })

  it('all tables failing produces one aggregate error naming every table', async () => {
    const execute = vi.fn().mockImplementation((arg: unknown) => {
      const { sql: renderedSql } = renderSql(arg)
      if (renderedSql.includes('DELETE FROM')) {
        return Promise.reject(new Error('simulated failure'))
      }
      return Promise.resolve({ rows: [] })
    })
    const db = { execute, _execute: execute }

    await expect(pruneRetentionData(db as any)).rejects.toThrow(
      new RegExp(`${RETENTION_POLICY.length}/${RETENTION_POLICY.length} table\\(s\\) failed to prune`),
    )

    // No retention_audit INSERTs at all — every table's DELETE failed first.
    const allCalls = db._execute.mock.calls as unknown[][]
    const auditInserts = allCalls.filter(([arg]) => renderSql(arg).sql.includes('retention_audit'))
    expect(auditInserts).toHaveLength(0)
  })
})

// ============================================================
// pruneSoftDeletedCaptures — DEFERRED (DA-5/RC-15, Phase 8.4)
//
// This function must NEVER delete rows until a real backup-freshness
// precondition exists (see its JSDoc). These tests pin the fail-closed
// contract: it always reports attempted:false and never touches the db.
// ============================================================

describe('pruneSoftDeletedCaptures — disabled pending backup-freshness signal (DA-5/RC-15)', () => {
  it('returns attempted:false with a reason and deletes nothing (default days)', async () => {
    const execute = vi.fn()
    const db = { execute } as any

    const result = await pruneSoftDeletedCaptures(db)

    expect(result).toEqual({
      attempted: false,
      deletedCount: 0,
      reason: expect.stringContaining('DA-5/RC-15'),
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('never touches the db even when a custom days value is passed', async () => {
    const execute = vi.fn()
    const db = { execute } as any

    const result = await pruneSoftDeletedCaptures(db, 180)

    expect(result.attempted).toBe(false)
    expect(result.deletedCount).toBe(0)
    expect(execute).not.toHaveBeenCalled()
  })

  it('is NOT part of RETENTION_POLICY — captures is excluded from the automatic loop', () => {
    const tables = RETENTION_POLICY.map(e => e.table)
    expect(tables).not.toContain('captures')
  })
})
