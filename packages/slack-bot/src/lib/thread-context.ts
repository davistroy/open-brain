/**
 * Thread context management for Slack conversations.
 * Stores search state, session IDs, and pagination info per thread.
 */

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
  /** Timestamp of last activity */
  lastActivity: number
}

// In-memory store keyed by `channel:thread_ts`
const store = new Map<string, ThreadContext>()

// Context expiry time (1 hour)
const CONTEXT_TTL_MS = 60 * 60 * 1000

function makeKey(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`
}

/**
 * Get thread context. Returns undefined if not found or expired.
 */
export function getThreadContext(channel: string, threadTs: string): ThreadContext | undefined {
  const key = makeKey(channel, threadTs)
  const ctx = store.get(key)
  if (!ctx) return undefined

  // Check expiry
  if (Date.now() - ctx.lastActivity > CONTEXT_TTL_MS) {
    store.delete(key)
    return undefined
  }

  return ctx
}

/**
 * Set or update thread context.
 */
export function setThreadContext(channel: string, threadTs: string, ctx: Partial<ThreadContext>): void {
  const key = makeKey(channel, threadTs)
  const existing = store.get(key) ?? { lastActivity: Date.now() }
  store.set(key, {
    ...existing,
    ...ctx,
    lastActivity: Date.now(),
  })
}

/**
 * Clear thread context.
 */
export function clearThreadContext(channel: string, threadTs: string): void {
  const key = makeKey(channel, threadTs)
  store.delete(key)
}

/**
 * Periodic cleanup of expired contexts (call from scheduler).
 */
export function cleanupExpiredContexts(): void {
  const now = Date.now()
  for (const [key, ctx] of store.entries()) {
    if (now - ctx.lastActivity > CONTEXT_TTL_MS) {
      store.delete(key)
    }
  }
}
