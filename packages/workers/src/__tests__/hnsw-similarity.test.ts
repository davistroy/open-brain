import { describe, it, expect, vi } from 'vitest'
import {
  findSimilarPairs,
  readScanWatermark,
  writeScanWatermark,
  DEFAULT_K,
  DEFAULT_EF_SEARCH,
  MEMORY_CONSOLIDATION_WATERMARK_KEY,
  CAPTURE_DEDUP_WATERMARK_KEY,
} from '../lib/hnsw-similarity.js'

// ---------------------------------------------------------------------------
// Mock db helper
// ---------------------------------------------------------------------------

/**
 * Build a mock db whose:
 *  - `execute` answers the candidate-enumeration query (1 call) with the given IDs
 *  - `transaction(cb)` runs cb with a `tx` whose `execute` answers, in order:
 *      call 1: SET LOCAL hnsw.ef_search  -> { rows: [] }
 *      call 2..n: one probe per candidate (in enumeration order) -> the queued neighbors
 *
 * neighborsByCandidate maps candidate id -> the rows that probe returns
 * (each row: { neighbor_id, similarity } where similarity is a numeric string,
 * mirroring Postgres ::text casting).
 */
function makeDb(
  candidateIds: string[],
  neighborsByCandidate: Record<string, Array<{ neighbor_id: string; similarity: string }>>,
) {
  const execute = vi.fn().mockResolvedValue({ rows: candidateIds.map((id) => ({ id })) })

  const txExecute = vi.fn()
  // call 1: SET LOCAL ef_search
  txExecute.mockResolvedValueOnce({ rows: [] })
  // one probe per candidate, in enumeration order
  for (const id of candidateIds) {
    txExecute.mockResolvedValueOnce({ rows: neighborsByCandidate[id] ?? [] })
  }

  const transaction = vi.fn(async (cb: (tx: { execute: typeof txExecute }) => unknown) =>
    cb({ execute: txExecute }),
  )

  return { execute, transaction, txExecute }
}

function sqlText(arg: unknown): string {
  return JSON.stringify(arg)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('findSimilarPairs()', () => {
  it('propagates a DB error (callers must avoid advancing the scan watermark on failure)', async () => {
    const db = {
      execute: vi.fn().mockRejectedValue(new Error('connection refused')),
      transaction: vi.fn(),
    }
    await expect(
      findSimilarPairs(db as any, { threshold: 0.9, maxPairs: 100 }),
    ).rejects.toThrow('connection refused')
  })

  it('returns an empty array and opens no transaction when there are no candidates', async () => {
    const db = makeDb([], {})
    const pairs = await findSimilarPairs(db as any, { threshold: 0.9, maxPairs: 100 })

    expect(pairs).toEqual([])
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it('emits canonical-ordered (a<b) pairs for neighbors above the threshold', async () => {
    // candidate 'aaa' is near 'bbb' (0.97); candidate 'bbb' is near 'aaa' (0.97)
    const db = makeDb(['aaa', 'bbb'], {
      aaa: [{ neighbor_id: 'bbb', similarity: '0.97' }],
      bbb: [{ neighbor_id: 'aaa', similarity: '0.97' }],
    })

    const pairs = await findSimilarPairs(db as any, { threshold: 0.92, maxPairs: 100 })

    expect(pairs).toEqual([{ capture_id_a: 'aaa', capture_id_b: 'bbb', similarity: 0.97 }])
  })

  it('excludes neighbors at or below the threshold (strict >)', async () => {
    const db = makeDb(['aaa'], {
      aaa: [
        { neighbor_id: 'bbb', similarity: '0.92' }, // exactly threshold -> excluded
        { neighbor_id: 'ccc', similarity: '0.9201' }, // above -> kept
      ],
    })

    const pairs = await findSimilarPairs(db as any, { threshold: 0.92, maxPairs: 100 })

    expect(pairs).toEqual([{ capture_id_a: 'aaa', capture_id_b: 'ccc', similarity: 0.9201 }])
  })

  it('dedupes a pair found from both directions into one canonical pair', async () => {
    const db = makeDb(['xxx', 'yyy'], {
      // note: 'yyy' < 'xxx' is false; canonical is 'xxx' < 'yyy'
      xxx: [{ neighbor_id: 'yyy', similarity: '0.95' }],
      yyy: [{ neighbor_id: 'xxx', similarity: '0.95' }],
    })

    const pairs = await findSimilarPairs(db as any, { threshold: 0.9, maxPairs: 100 })

    expect(pairs).toHaveLength(1)
    expect(pairs[0]).toEqual({ capture_id_a: 'xxx', capture_id_b: 'yyy', similarity: 0.95 })
  })

  it('sorts by similarity descending and caps to maxPairs', async () => {
    const db = makeDb(['a', 'b', 'c'], {
      a: [{ neighbor_id: 'z1', similarity: '0.93' }],
      b: [{ neighbor_id: 'z2', similarity: '0.99' }],
      c: [{ neighbor_id: 'z3', similarity: '0.96' }],
    })

    const pairs = await findSimilarPairs(db as any, { threshold: 0.9, maxPairs: 2 })

    expect(pairs).toHaveLength(2)
    expect(pairs[0].similarity).toBe(0.99)
    expect(pairs[1].similarity).toBe(0.96)
  })

  it('issues SET LOCAL hnsw.ef_search as the first statement inside the transaction', async () => {
    const db = makeDb(['a'], { a: [{ neighbor_id: 'b', similarity: '0.99' }] })

    await findSimilarPairs(db as any, { threshold: 0.9, maxPairs: 100, efSearch: 80 })

    expect(db.transaction).toHaveBeenCalledTimes(1)
    const firstTxArg = sqlText(db.txExecute.mock.calls[0][0])
    expect(firstTxArg).toMatch(/SET LOCAL/i)
    expect(firstTxArg).toMatch(/hnsw\.ef_search/)
    expect(firstTxArg).toMatch(/80/)
  })

  it('defaults k=50 and ef_search=60 when not provided', async () => {
    expect(DEFAULT_K).toBe(50)
    expect(DEFAULT_EF_SEARCH).toBe(60)

    const db = makeDb(['a'], { a: [] })
    await findSimilarPairs(db as any, { threshold: 0.9, maxPairs: 100 })

    const firstTxArg = sqlText(db.txExecute.mock.calls[0][0])
    expect(firstTxArg).toMatch(/60/) // default ef_search
    // probe carries the default k LIMIT
    const probeArg = sqlText(db.txExecute.mock.calls[1][0])
    expect(probeArg).toMatch(/50/)
  })

  it('excludeConsolidationSource=true filters source=consolidation in BOTH enumeration and probe', async () => {
    const db = makeDb(['a'], { a: [] })
    await findSimilarPairs(db as any, {
      threshold: 0.95,
      maxPairs: 100,
      excludeConsolidationSource: true,
    })

    const enumArg = sqlText(db.execute.mock.calls[0][0])
    expect(enumArg).toMatch(/consolidation/)
    const probeArg = sqlText(db.txExecute.mock.calls[1][0])
    expect(probeArg).toMatch(/consolidation/)
  })

  it('excludeConsolidationSource=false (default) does NOT filter source — consolidation parity', async () => {
    const db = makeDb(['a'], { a: [] })
    await findSimilarPairs(db as any, { threshold: 0.92, maxPairs: 100 })

    const enumArg = sqlText(db.execute.mock.calls[0][0])
    expect(enumArg).not.toMatch(/consolidation/)
    const probeArg = sqlText(db.txExecute.mock.calls[1][0])
    expect(probeArg).not.toMatch(/consolidation/)
  })

  it('candidatesSince filters the candidate ENUMERATION but not the neighbor probe (new↔old still found)', async () => {
    const since = new Date('2026-06-01T00:00:00Z')
    const db = makeDb(['newcap'], {
      // newcap (a candidate created after `since`) probes against the full corpus
      // and finds an OLD neighbor 'oldcap' (not itself a candidate this run)
      newcap: [{ neighbor_id: 'oldcap', similarity: '0.96' }],
    })

    const pairs = await findSimilarPairs(db as any, {
      threshold: 0.92,
      maxPairs: 100,
      candidatesSince: since,
    })

    // enumeration query carries the created_at filter
    const enumArg = sqlText(db.execute.mock.calls[0][0])
    expect(enumArg).toMatch(/created_at/)
    // the probe (neighbor query) must NOT restrict by created_at — old neighbors are eligible
    const probeArg = sqlText(db.txExecute.mock.calls[1][0])
    expect(probeArg).not.toMatch(/created_at/)
    // and the new↔old pair is emitted
    expect(pairs).toEqual([{ capture_id_a: 'newcap', capture_id_b: 'oldcap', similarity: 0.96 }])
  })
})

describe('scan watermark', () => {
  it('exposes distinct keys for the two scans', () => {
    expect(MEMORY_CONSOLIDATION_WATERMARK_KEY).toBe('memory_consolidation_last_scan_at')
    expect(CAPTURE_DEDUP_WATERMARK_KEY).toBe('capture_dedup_last_scan_at')
    expect(MEMORY_CONSOLIDATION_WATERMARK_KEY).not.toBe(CAPTURE_DEDUP_WATERMARK_KEY)
  })

  it('readScanWatermark returns null when no row exists (→ full scan)', async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) }
    expect(await readScanWatermark(db as any, 'k')).toBeNull()
  })

  it('readScanWatermark parses a stored ISO timestamp into a Date', async () => {
    const iso = '2026-06-01T00:00:00.000Z'
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ value: iso }] }) }
    const d = await readScanWatermark(db as any, 'k')
    expect(d).toBeInstanceOf(Date)
    expect(d!.toISOString()).toBe(iso)
  })

  it('readScanWatermark returns null on a malformed value (safe → full scan)', async () => {
    const db = { execute: vi.fn().mockResolvedValue({ rows: [{ value: 'not-a-date' }] }) }
    expect(await readScanWatermark(db as any, 'k')).toBeNull()
  })

  it('readScanWatermark returns null (not throw) when the query fails', async () => {
    const db = { execute: vi.fn().mockRejectedValue(new Error('db down')) }
    expect(await readScanWatermark(db as any, 'k')).toBeNull()
  })

  it('writeScanWatermark upserts the key with the ISO timestamp', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] })
    const ts = new Date('2026-06-30T12:00:00.000Z')
    await writeScanWatermark({ execute } as any, 'memory_consolidation_last_scan_at', ts)

    expect(execute).toHaveBeenCalledTimes(1)
    const sqlStr = JSON.stringify(execute.mock.calls[0][0])
    expect(sqlStr).toMatch(/app_settings/)
    expect(sqlStr).toMatch(/ON CONFLICT/i)
    expect(sqlStr).toMatch(/2026-06-30T12:00:00\.000Z/)
  })

  it('writeScanWatermark swallows write failures (does not throw)', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('write failed'))
    await expect(
      writeScanWatermark({ execute } as any, 'k', new Date()),
    ).resolves.toBeUndefined()
  })
})
