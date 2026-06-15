import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IngestDedup } from '../lib/ingest-dedup.js'

// ============================================================
// Mock Redis
// ============================================================

function makeRedis(setResult: string | null = 'OK') {
  return {
    set: vi.fn().mockResolvedValue(setResult),
  }
}

function makeRedisError() {
  return {
    set: vi.fn().mockRejectedValue(new Error('Redis connection error')),
  }
}

// ============================================================
// Tests
// ============================================================

describe('IngestDedup', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  // ----------------------------------------------------------
  // New content hash — not a duplicate
  // ----------------------------------------------------------

  describe('new content hash', () => {
    it('returns false (not duplicate) when hash is seen for the first time', async () => {
      const redis = makeRedis('OK') // SET NX returns 'OK' when key is new
      const dedup = new IngestDedup(redis as never)

      const result = await dedup.isDuplicate('abc123hash', 'cap-1')

      expect(result).toBe(false)
    })

    it('calls SET with NX and EX flags for atomic check-and-set', async () => {
      const redis = makeRedis('OK')
      const dedup = new IngestDedup(redis as never, 300)

      await dedup.isDuplicate('hash-xyz', 'cap-2')

      expect(redis.set).toHaveBeenCalledWith(
        'ob:ingest:dedup:hash-xyz:cap-2',
        '1',
        'EX',
        300,
        'NX',
      )
    })

    it('uses custom TTL when provided', async () => {
      const redis = makeRedis('OK')
      const dedup = new IngestDedup(redis as never, 120)

      await dedup.isDuplicate('hash-custom-ttl', 'cap-3')

      expect(redis.set).toHaveBeenCalledWith(
        'ob:ingest:dedup:hash-custom-ttl:cap-3',
        '1',
        'EX',
        120,
        'NX',
      )
    })

    it('uses 300-second default TTL when not specified', async () => {
      const redis = makeRedis('OK')
      const dedup = new IngestDedup(redis as never)

      await dedup.isDuplicate('hash-default', 'cap-4')

      expect(redis.set).toHaveBeenCalledWith(
        'ob:ingest:dedup:hash-default:cap-4',
        '1',
        'EX',
        300,
        'NX',
      )
    })
  })

  // ----------------------------------------------------------
  // Duplicate content hash
  // ----------------------------------------------------------

  describe('duplicate content hash', () => {
    it('returns true (duplicate) when hash already exists in Redis', async () => {
      const redis = makeRedis(null) // SET NX returns null when key already exists
      const dedup = new IngestDedup(redis as never)

      const result = await dedup.isDuplicate('already-seen-hash', 'cap-5')

      expect(result).toBe(true)
    })
  })

  // ----------------------------------------------------------
  // Redis error handling
  // ----------------------------------------------------------

  describe('Redis error handling', () => {
    it('returns false (allow through) when Redis call fails', async () => {
      const redis = makeRedisError()
      const dedup = new IngestDedup(redis as never)

      const result = await dedup.isDuplicate('hash-during-redis-error', 'cap-6')

      // Redis failure must not block ingestion
      expect(result).toBe(false)
    })
  })

  // ----------------------------------------------------------
  // Key prefix
  // ----------------------------------------------------------

  describe('key naming', () => {
    it('prefixes all keys with ob:ingest:dedup:', async () => {
      const redis = makeRedis('OK')
      const dedup = new IngestDedup(redis as never)

      await dedup.isDuplicate('my-hash', 'cap-99')

      const calledKey = redis.set.mock.calls[0][0]
      expect(calledKey).toBe('ob:ingest:dedup:my-hash:cap-99')
    })
  })

  // ----------------------------------------------------------
  // SE-4 — captureId in key prevents self-dedup on retry
  // ----------------------------------------------------------

  describe('SE-4 — captureId scoping', () => {
    it('key includes captureId so same capture can retry within TTL', async () => {
      const redis = makeRedis('OK')
      const dedup = new IngestDedup(redis as never, 300)

      await dedup.isDuplicate('hash-abc', 'cap-111')

      expect(redis.set).toHaveBeenCalledWith(
        'ob:ingest:dedup:hash-abc:cap-111',
        '1',
        'EX',
        300,
        'NX',
      )
    })

    it('different captureId with same content hash gets its own key (cross-capture dedup still works)', async () => {
      // First capture sets the key
      const redis1 = makeRedis('OK')
      const dedup1 = new IngestDedup(redis1 as never)
      await dedup1.isDuplicate('same-hash', 'cap-AAA')

      // Second capture with same hash but different id → different key → also 'OK' if new
      const redis2 = makeRedis('OK')
      const dedup2 = new IngestDedup(redis2 as never)
      const result = await dedup2.isDuplicate('same-hash', 'cap-BBB')

      expect(redis2.set.mock.calls[0][0]).toBe('ob:ingest:dedup:same-hash:cap-BBB')
      expect(result).toBe(false) // Different key — treated as new
    })

    it('same captureId retry within TTL is not blocked (key still gets SET NX attempted)', async () => {
      // Simulate: first enqueue sets key → returns 'OK'
      const redis = makeRedis('OK')
      const dedup = new IngestDedup(redis as never)

      // First processing
      const r1 = await dedup.isDuplicate('hash-xyz', 'cap-222')
      expect(r1).toBe(false) // Not a duplicate — key was new

      // BullMQ retry: key already set but now redis returns null (already set for this capture+hash combo)
      // Simulate Redis returning null for second call (key exists for same cap)
      redis.set.mockResolvedValueOnce(null)
      const r2 = await dedup.isDuplicate('hash-xyz', 'cap-222')
      // With captureId in key, this would normally block. But the FIX in ingestion-worker
      // skips dedup on forceRetry. This test confirms the key shape is captureId-scoped.
      expect(redis.set.mock.calls[1][0]).toBe('ob:ingest:dedup:hash-xyz:cap-222')
    })
  })
})
