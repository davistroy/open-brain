/**
 * Thread context management for Slack conversations.
 * Stores search state, session IDs, and pagination info per thread in Redis.
 */

import type { Redis } from 'ioredis'
import type { SearchResult } from './core-api-client.js'

export interface ThreadContext {
  /** Original search query */
  query?: string
  /** Cached search results for pagination and drilldown */
  results?: SearchResult[]
  /** Current page number (1-indexed) */
  page?: number
  /** Active governance session ID */
  sessionId?: string
}

const THREAD_CTX_TTL = 3600  // 1 hour in seconds

function makeKey(threadTs: string): string {
  return `open-brain:thread-ctx:${threadTs}`
}

/**
 * Get thread context from Redis. Returns null if not found or expired.
 */
export async function getThreadContext(redis: Redis, threadTs: string): Promise<ThreadContext | null> {
  const raw = await redis.get(makeKey(threadTs))
  if (!raw) return null
  return JSON.parse(raw) as ThreadContext
}

/**
 * Set or update thread context in Redis with 1-hour TTL.
 */
export async function setThreadContext(redis: Redis, threadTs: string, ctx: ThreadContext): Promise<void> {
  await redis.set(makeKey(threadTs), JSON.stringify(ctx), 'EX', THREAD_CTX_TTL)
}

/**
 * Clear thread context from Redis.
 */
export async function clearThreadContext(redis: Redis, threadTs: string): Promise<void> {
  await redis.del(makeKey(threadTs))
}
