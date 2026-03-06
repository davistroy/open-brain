/**
 * Query handler — processes Slack messages classified as QUERY intent.
 *
 * Flow for new query:
 * 1. Strip `?` prefix (or `@Open Brain` mention) from message text
 * 2. POST /api/v1/search via CoreApiClient
 * 3. Format results and reply in thread
 * 4. Store thread context in Redis (query, page 1, all results) with 1-hour TTL
 *
 * Flow for follow-up reply in existing search thread:
 * 1. Look up thread context by thread_ts
 * 2. If expired (no context): inform user to send a new query
 * 3. If reply is a number: fetch and display that result's full detail
 * 4. If reply is "more": advance page and re-display
 * 5. If reply is anything else: treat as a new query
 */

import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import type { Redis } from 'ioredis'
import type { CoreApiClient } from '../lib/core-api-client.js'
import { formatSearchResults, formatCapture, formatError } from '../lib/formatters.js'
import { getThreadContext, setThreadContext } from '../lib/thread-context.js'
import { logger } from '../lib/logger.js'

const SEARCH_LIMIT = 20   // Fetch up to 20 results; paginate 5 per page
const PAGE_SIZE = 5

/**
 * Strip query prefixes (`?`, `@Open Brain` bot mention text) from raw message text.
 */
function extractQueryText(text: string): string {
  // Strip leading `?` prefix (with optional whitespace)
  let q = text.replace(/^\?\s*/, '')

  // Strip leading `<@...>` Slack mention block (bot mention) if present
  q = q.replace(/^<@[A-Z0-9]+>\s*/i, '')

  return q.trim()
}

/**
 * Parse a follow-up reply in a search thread.
 * Returns:
 *   { type: 'select', index: number }  — user replied with a number (1-based)
 *   { type: 'more' }                   — user replied "more" to advance pages
 *   { type: 'new_query', text: string } — treat as a fresh query
 */
function parseFollowUp(text: string): { type: 'select'; index: number } | { type: 'more' } | { type: 'new_query'; text: string } {
  const trimmed = text.trim().toLowerCase()

  // "more" or "next" → advance page
  if (trimmed === 'more' || trimmed === 'next') {
    return { type: 'more' }
  }

  // Pure integer → select that result
  const num = parseInt(trimmed, 10)
  if (!isNaN(num) && String(num) === trimmed && num >= 1) {
    return { type: 'select', index: num }
  }

  // Anything else → treat as a new query string within the thread
  return { type: 'new_query', text: text.trim() }
}

/**
 * Execute a search against Core API and store results in thread context.
 */
async function runSearch(
  queryText: string,
  ts: string,
  say: SayFn,
  coreApiClient: CoreApiClient,
  redis: Redis,
): Promise<void> {
  let searchResponse
  try {
    searchResponse = await coreApiClient.search_query({
      query: queryText,
      limit: SEARCH_LIMIT,
      search_mode: 'hybrid',
      temporal_weight: 0.0,
    })
  } catch (err) {
    logger.error({ err, query: queryText }, 'handleQuery: search_query failed')
    await say({ text: formatError('Search failed', err), thread_ts: ts })
    return
  }

  const { results } = searchResponse

  // Store thread context so follow-up replies can navigate results
  await setThreadContext(redis, ts, { query: queryText, page: 1, results })

  const formatted = formatSearchResults(results, queryText, 1, PAGE_SIZE)
  await say({ text: formatted, thread_ts: ts })

  logger.info({ query: queryText, resultCount: results.length, ts }, 'handleQuery: search complete')
}

/**
 * Main query handler. Called by server.ts when IntentRouter returns intent = 'query'.
 *
 * @param message       - Slack GenericMessageEvent
 * @param say           - Bolt's say() function scoped to the current channel
 * @param coreApiClient - Initialized CoreApiClient
 * @param redis         - ioredis client for thread context storage
 */
export async function handleQuery(
  message: GenericMessageEvent,
  say: SayFn,
  coreApiClient: CoreApiClient,
  redis: Redis,
): Promise<void> {
  if (!('text' in message) || !message.text) {
    logger.debug({ ts: message.ts }, 'handleQuery: empty text, skipping')
    return
  }

  const rawText = message.text.trim()
  const ts = message.ts
  const threadTs = 'thread_ts' in message ? (message.thread_ts ?? undefined) : undefined

  // -------------------------------------------------------------------------
  // Follow-up in an existing search thread
  // -------------------------------------------------------------------------
  if (threadTs) {
    const ctx = await getThreadContext(redis, threadTs)

    if (ctx === null) {
      // Context expired (>1 hour) — inform user
      await say({
        text: 'This search has expired (1-hour timeout). Send a new query to search again.',
        thread_ts: ts,
      })
      return
    }

    const followUp = parseFollowUp(rawText)

    if (followUp.type === 'select') {
      // User wants full detail for result N (1-based)
      const selected = ctx.results[followUp.index - 1]
      if (!selected) {
        await say({
          text: `No result #${followUp.index}. There are ${ctx.results.length} results.`,
          thread_ts: ts,
        })
        return
      }

      // Fetch full capture detail from Core API
      try {
        const fullCapture = await coreApiClient.captures_get(selected.id)
        await say({ text: formatCapture(fullCapture), thread_ts: ts })
      } catch (err) {
        logger.error({ err, captureId: selected.id }, 'handleQuery: captures_get failed')
        await say({ text: formatError('Failed to load capture', err), thread_ts: ts })
      }
      return
    }

    if (followUp.type === 'more') {
      // Advance to next page
      const nextPage = ctx.page + 1
      const offset = (nextPage - 1) * PAGE_SIZE
      if (offset >= ctx.results.length) {
        await say({ text: 'No more results.', thread_ts: ts })
        return
      }

      // Update stored page
      await setThreadContext(redis, threadTs, { ...ctx, page: nextPage })
      const formatted = formatSearchResults(ctx.results, ctx.query, nextPage, PAGE_SIZE)
      await say({ text: formatted, thread_ts: ts })
      return
    }

    // followUp.type === 'new_query' — run a fresh search scoped to this thread
    const queryText = extractQueryText(followUp.text)
    await runSearch(queryText, ts, say, coreApiClient, redis)
    return
  }

  // -------------------------------------------------------------------------
  // Fresh query (not a thread reply)
  // -------------------------------------------------------------------------
  const queryText = extractQueryText(rawText)
  await runSearch(queryText, ts, say, coreApiClient, redis)
}
