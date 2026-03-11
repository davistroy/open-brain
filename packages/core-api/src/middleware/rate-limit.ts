import type { MiddlewareHandler } from 'hono'
import { logger } from '../lib/logger.js'

/**
 * Rate limit tier configuration.
 */
export interface RateLimitConfig {
  /** Maximum requests allowed within the window */
  maxRequests: number
  /** Window duration in milliseconds */
  windowMs: number
}

/**
 * Predefined rate limit tiers for Open Brain.
 *
 * - default: 100 req/min — general API reads and writes
 * - strict:  20 req/min  — endpoints that trigger LLM/embedding calls (captures, search, synthesize)
 * - admin:    5 req/min  — destructive admin operations (reset-data, config reload)
 */
export const RATE_LIMIT_TIERS = {
  default: { maxRequests: 100, windowMs: 60_000 },
  strict: { maxRequests: 20, windowMs: 60_000 },
  admin: { maxRequests: 5, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitConfig>

/** Sliding window entry: list of request timestamps within the current window */
interface WindowEntry {
  timestamps: number[]
}

/**
 * In-memory sliding window rate limiter.
 *
 * Uses a Map keyed by client IP. Each entry holds an array of request
 * timestamps within the current window. Expired timestamps are pruned
 * on each request. State does not persist across restarts — acceptable
 * for a single-user system.
 *
 * A periodic cleanup runs every 5 minutes to evict stale entries from
 * clients that have gone idle.
 */
export class RateLimiter {
  private windows = new Map<string, WindowEntry>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null

  constructor(private config: RateLimitConfig) {
    // Clean up stale entries every 5 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60_000)
    // Don't keep the process alive just for cleanup
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref()
    }
  }

  /**
   * Check if a request from `key` is allowed.
   * Returns { allowed, remaining, retryAfterMs }.
   */
  check(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = Date.now()
    const windowStart = now - this.config.windowMs

    let entry = this.windows.get(key)
    if (!entry) {
      entry = { timestamps: [] }
      this.windows.set(key, entry)
    }

    // Prune expired timestamps
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

    if (entry.timestamps.length >= this.config.maxRequests) {
      // Over limit — calculate when the oldest request in the window expires
      const oldestInWindow = entry.timestamps[0]!
      const retryAfterMs = oldestInWindow + this.config.windowMs - now
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(retryAfterMs, 1),
      }
    }

    // Under limit — record this request
    entry.timestamps.push(now)
    return {
      allowed: true,
      remaining: this.config.maxRequests - entry.timestamps.length,
      retryAfterMs: 0,
    }
  }

  /** Remove entries with no timestamps in the current window */
  private cleanup(): void {
    const now = Date.now()
    const windowStart = now - this.config.windowMs
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart)
      if (entry.timestamps.length === 0) {
        this.windows.delete(key)
      }
    }
  }

  /** Stop the cleanup timer — call on shutdown */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /** Visible for testing: get the current count for a key */
  _getCount(key: string): number {
    const entry = this.windows.get(key)
    if (!entry) return 0
    const windowStart = Date.now() - this.config.windowMs
    return entry.timestamps.filter((t) => t > windowStart).length
  }

  /** Visible for testing: clear all state */
  _reset(): void {
    this.windows.clear()
  }
}

/**
 * Extracts a rate-limit key from the request.
 * Uses X-Forwarded-For (first hop) if present, falls back to
 * the connecting IP, or 'unknown' as a last resort.
 */
function getClientKey(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0]!.trim()
  }
  // Hono's c.req.header doesn't expose remoteAddress; use a fallback
  return 'default-client'
}

/**
 * Creates a Hono rate-limiting middleware using the given RateLimiter instance.
 *
 * Returns 429 Too Many Requests with a Retry-After header (in seconds)
 * when the client exceeds the configured limit.
 */
export function rateLimit(limiter: RateLimiter): MiddlewareHandler {
  return async (c, next) => {
    const key = getClientKey(c.req.raw.headers)
    const result = limiter.check(key)

    // Always set informational headers
    c.header('X-RateLimit-Remaining', String(result.remaining))

    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000)
      logger.warn({ key, retryAfterSec, path: c.req.path }, 'Rate limit exceeded')
      c.header('Retry-After', String(retryAfterSec))
      return c.json(
        { error: 'Too Many Requests', message: `Rate limit exceeded. Retry after ${retryAfterSec}s.` },
        429,
      )
    }

    await next()
  }
}
