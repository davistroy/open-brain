import { createHash } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'
import { logger } from '@open-brain/shared'

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
 * - mobile:  200 req/min — authenticated mobile clients (Expo React Native). Bearer-token bucket
 *                          per unique token so each device gets its own window. Between default and
 *                          lenient — human-driven mobile usage is burstier than anonymous web but
 *                          single-user, so a generous-but-finite limit prevents runaway loops.
 */
export const RATE_LIMIT_TIERS = {
  default: { maxRequests: 100, windowMs: 60_000 },
  strict: { maxRequests: 20, windowMs: 60_000 },
  admin: { maxRequests: 5, windowMs: 60_000 },
  mobile: { maxRequests: 200, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitConfig>

// Module-scope: constructed once, not per-request.
const BYPASS_CALLERS = new Set([
  'internal:integration-test',
  'internal:web-ui',
  'internal:email-worker',
  'internal:financial-pipeline',
  'internal:utility-pipeline',
  // CS3 — batch ingest sidecar + ingest-process worker callbacks
  'internal:ingest',
  // P07 — new internal service callers
  'internal:slack-bot',
  'internal:voice-capture',
  'internal:memory-consolidation',
  'internal:workers',
  // P07 — callers that already set the header but were missing from bypass
  'internal:email-classify',
  'internal:email-compose-skill',
  'internal:batch-wiki-ingest',
  'internal:email-pipeline',
  'internal:ingest-onedrive',
  'internal:ingest-repair',
  // P21 — financial advisor newsletter assessment pipeline (open-brain-vm cron)
  'internal:newsletter-pipeline',
])

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
 * Defense-in-depth: returns true when `ip` belongs to a network range that
 * we trust as "internal" for purposes of accepting an `X-Open-Brain-Caller`
 * bypass header.
 *
 * Trusted ranges:
 * - Loopback: 127.0.0.0/8, ::1
 * - RFC1918 private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - Tailscale CGNAT: 100.64.0.0/10
 * - Link-local: 169.254.0.0/16 (defensive — some Docker setups), fe80::/10
 * - IPv6 unique local: fc00::/7
 *
 * A public IP appearing in `X-Forwarded-For` (e.g., the originating client
 * behind nginx / Cloudflare Tunnel) MUST NOT be allowed to set caller
 * bypass headers. Implementation is dependency-free per CLAUDE.md.
 */
export function isInternalIp(ip: string): boolean {
  if (!ip) return false
  const trimmed = ip.trim().toLowerCase()
  if (!trimmed) return false

  // Strip surrounding brackets or zone suffix (e.g., "fe80::1%eth0")
  const cleaned = trimmed.replace(/^\[|\]$/g, '').split('%')[0]!

  // IPv6 loopback
  if (cleaned === '::1') return true

  // IPv6 link-local (fe80::/10 — first 10 bits = 1111111010)
  // Practical match: starts with "fe8", "fe9", "fea", or "feb"
  if (/^fe[89ab]/.test(cleaned)) return true

  // IPv6 unique local (fc00::/7 — first 7 bits = 1111110)
  // Practical match: starts with "fc" or "fd"
  if (/^f[cd]/.test(cleaned)) return true

  // IPv4-mapped IPv6 (e.g., "::ffff:10.0.0.1") — extract embedded v4
  const v4MappedMatch = cleaned.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  const candidate = v4MappedMatch ? v4MappedMatch[1]! : cleaned

  // IPv4 octet parse
  const m = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!m) return false
  const o1 = Number(m[1])
  const o2 = Number(m[2])
  const o3 = Number(m[3])
  const o4 = Number(m[4])
  if ([o1, o2, o3, o4].some((o) => o < 0 || o > 255)) return false

  // 127.0.0.0/8
  if (o1 === 127) return true
  // 10.0.0.0/8
  if (o1 === 10) return true
  // 172.16.0.0/12 (172.16 – 172.31)
  if (o1 === 172 && o2 >= 16 && o2 <= 31) return true
  // 192.168.0.0/16
  if (o1 === 192 && o2 === 168) return true
  // 100.64.0.0/10 (Tailscale CGNAT — 100.64 – 100.127)
  if (o1 === 100 && o2 >= 64 && o2 <= 127) return true
  // 169.254.0.0/16 (link-local)
  if (o1 === 169 && o2 === 254) return true

  return false
}

/**
 * Extracts a rate-limit key from the request.
 *
 * Priority:
 * 1. X-Open-Brain-Caller: mobile-app from a PUBLIC source IP — mobile tier, keyed
 *    on the SHA-256 prefix of the Bearer token (first 16 hex chars). Each unique
 *    token gets its own bucket, supporting multiple physical devices in the future.
 *    If no Bearer token is present (auth will reject the request downstream), the
 *    key falls back to the source IP so the unauthenticated attempt is still counted.
 *    **Phase 6 (R8):** mobile-app removed from BYPASS_CALLERS — authenticated via
 *    Bearer (mobile-auth middleware) and rate-limited via the 'mobile' tier instead.
 * 2. X-Open-Brain-Caller (non-mobile) — set by internal Docker services (slack-bot,
 *    workers) to get their own rate-limit bucket instead of sharing 'default-client'.
 *    **Defense-in-depth (Phase 2.3):** the caller header is honored ONLY when the
 *    source IP (first entry of `X-Forwarded-For`) is internal per `isInternalIp()`,
 *    OR when no `X-Forwarded-For` is present (meaning the request came directly to
 *    core-api — only reachable from the Docker network in production). A public XFF
 *    IP forces fall-through to IP keying regardless of any client-supplied caller header.
 * 3. X-Forwarded-For (first hop) — set by reverse proxies / Cloudflare Tunnel.
 * 4. 'default-client' — fallback when neither header is present.
 */
export function getClientKey(headers: Headers): { key: string; tier?: keyof typeof RATE_LIMIT_TIERS } {
  const caller = headers.get('x-open-brain-caller')
  const forwarded = headers.get('x-forwarded-for')
  const sourceIp = forwarded ? forwarded.split(',')[0]!.trim() : ''

  // Mobile callers from a public IP get their own rate-limit tier keyed on token hash.
  // Defense-in-depth: internal source IP + mobile-app is treated as an internal caller
  // (BYPASS_CALLERS path) — an iPhone on the LAN would skip the mobile tier.  In
  // practice, all mobile traffic arrives via Cloudflare Tunnel (public WAN IP).
  if (caller === 'mobile-app' && sourceIp && !isInternalIp(sourceIp)) {
    const authHeader = headers.get('authorization')
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim()
      if (token) {
        const tokenPrefix = createHash('sha256').update(token).digest('hex').slice(0, 16)
        return { key: `mobile:${tokenPrefix}`, tier: 'mobile' }
      }
    }
    // No (or malformed) Bearer token — key on source IP; mobile-auth rejects next.
    return { key: sourceIp, tier: 'mobile' }
  }

  if (caller) {
    // Defense-in-depth: ignore caller header when the source IP is public.
    // Absence of XFF means the request did not transit a reverse proxy —
    // in production, only the Docker network can reach core-api directly.
    if (!sourceIp || isInternalIp(sourceIp)) {
      return { key: `internal:${caller}` }
    }
    // Public source IP — fall through to IP-based keying. Caller header ignored.
  }

  if (sourceIp) {
    return { key: sourceIp }
  }
  return { key: 'default-client' }
}

/**
 * Creates a Hono rate-limiting middleware using the given RateLimiter instance.
 *
 * Mobile callers (X-Open-Brain-Caller: mobile-app from a public IP) are
 * automatically routed to a separate mobile-tier limiter (200 req/min) keyed
 * on the Bearer token hash, regardless of which endpoint limiter this
 * middleware instance is mounted on.  All other callers use the provided limiter.
 *
 * Returns 429 Too Many Requests with a Retry-After header (in seconds)
 * when the client exceeds the configured limit.
 */
export function rateLimit(limiter: RateLimiter, mobileLimiter?: RateLimiter): MiddlewareHandler {
  return async (c, next) => {
    const { key, tier } = getClientKey(c.req.raw.headers)

    // Bypass rate limiting for trusted internal callers.
    // mobile-app removed in Phase 6 (R8) — now authenticated via Bearer
    // (mobile-auth middleware) and rate-limited via the 'mobile' tier instead.
    if (BYPASS_CALLERS.has(key)) {
      await next()
      return
    }

    // Mobile-tier callers use a dedicated limiter (200 req/min per token hash).
    // Fall back to the provided limiter when no mobileLimiter is injected (e.g., tests).
    const activeLimiter = (tier === 'mobile' && mobileLimiter) ? mobileLimiter : limiter
    const result = activeLimiter.check(key)

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
