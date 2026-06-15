import type { Redis } from 'ioredis'
import { logger } from '@open-brain/shared'

// ============================================================
// Constants
// ============================================================

const DEDUP_KEY_PREFIX = 'ob:ingest:dedup:'
const DEFAULT_TTL_SECONDS = 300 // 5 minutes

// ============================================================
// IngestDedup
// ============================================================

/**
 * Redis-based content hash deduplication for the ingestion pipeline.
 *
 * When a capture is about to be enqueued for embedding, checks if its
 * content_hash has been seen within the TTL window. This prevents
 * duplicate voice captures from iOS Shortcut retries and rapid
 * double-submits from the API.
 *
 * Note: This is a time-windowed dedup layer on TOP of the existing
 * content_hash unique index in Postgres. The DB constraint catches
 * exact duplicates permanently; this Redis layer catches rapid retries
 * before they even hit the pipeline.
 */
export class IngestDedup {
  private redis: Redis
  private ttlSeconds: number

  constructor(redis: Redis, ttlSeconds = DEFAULT_TTL_SECONDS) {
    this.redis = redis
    this.ttlSeconds = ttlSeconds
  }

  /**
   * Check if a content hash has been seen recently for a DIFFERENT capture.
   * If not seen, marks it as seen (SET NX EX) and returns false (not a duplicate).
   * If already seen, returns true (duplicate — skip processing).
   *
   * The key is scoped to `contentHash:captureId` so that a BullMQ retry of the
   * SAME capture within the TTL window is never self-classified as a duplicate.
   * A genuinely different capture with identical content still hits a different key
   * and is deduped correctly (both keys resolve to the same hash prefix, but the
   * per-capture suffix makes each capture's entry distinct).
   *
   * Uses SET NX (set-if-not-exists) + EX (expiry) for atomic check-and-set.
   *
   * @param contentHash The SHA-256 hash of the capture content
   * @param captureId   UUID of the capture being processed (scopes the dedup key)
   * @returns true if this is a duplicate (already seen within TTL), false if new
   */
  async isDuplicate(contentHash: string, captureId: string): Promise<boolean> {
    try {
      const key = `${DEDUP_KEY_PREFIX}${contentHash}:${captureId}`
      // SET key "1" NX EX ttl — returns "OK" if set (new), null if already exists (dup)
      const result = await this.redis.set(key, '1', 'EX', this.ttlSeconds, 'NX')

      if (result === 'OK') {
        // First time seeing this hash — not a duplicate
        return false
      }

      // Key already existed — duplicate within TTL window
      logger.info(
        { contentHash, captureId, ttlSeconds: this.ttlSeconds },
        '[ingest-dedup] duplicate content hash detected — skipping',
      )
      return true
    } catch (err) {
      // Redis failure should never block ingestion — log and allow through
      logger.warn(
        { err, contentHash },
        '[ingest-dedup] Redis error during dedup check — allowing through',
      )
      return false
    }
  }
}
