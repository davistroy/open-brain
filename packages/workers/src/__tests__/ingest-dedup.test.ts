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

      const result = await dedup.isDuplicate('abc123hash')

      expect(result).toBe(false)
    })

    it('calls SET with NX and EX flags for atomic check-and-set', async () => {
      const redis = makeRedis('OK')
      const dedup = new IngestDedup(redis as never, 300)

      await dedup.isDuplicate('hash-xyz')

      expect(redis.set).toHaveBeenCalledWith(
        'ob:ingest:dedup:hash-xyz',
        '1',
        'EX',
        300,
        'NX',
      )
    })

    it('uses custom TTL when provided', async () => {
      const redis = makeRedis('OK')
      const dedup = new IngestDedup(redis as never, 120)

      await dedup.isDuplicate('hash-custom-ttl')

      expect(redis.set).toHaveBeenCalledWith(
        'ob:ingest:dedup:hash-custom-ttl',
        '1',
        'EX',
        120,
        'NX',
      )
    })

    it('uses 300-second default TTL when not specified', async () => {
      const redis = makeRedis('OK')
      const dedup = new IngestDedup(redis as never)

      await dedup.isDuplicate('hash-default')

      expect(redis.set).toHaveBeenCalledWith(
        'ob:ingest:dedup:hash-default',
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

      const result = await dedup.isDuplicate('already-seen-hash')

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

      const result = await dedup.isDuplicate('hash-during-redis-error')

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

      await dedup.isDuplicate('my-hash')

      const calledKey = redis.set.mock.calls[0][0]
      expect(calledKey).toBe('ob:ingest:dedup:my-hash')
    })
  })
})
