/**
 * Synthesis handler — processes messages requesting AI synthesis over brain content.
 *
 * Detects synthesis intent keywords ("summarize", "synthesize", "what's the pattern", etc.)
 * and calls Core API POST /api/v1/synthesize, then replies with the AI-generated response.
 */

import type { GenericMessageEvent, SayFn } from '@slack/bolt'
import type { CoreApiClient } from '../lib/core-api-client.js'
import { formatError } from '../lib/formatters.js'
import { logger } from '../lib/logger.js'

/** Patterns that indicate synthesis intent rather than a plain search */
const SYNTHESIS_PATTERNS = [
  /\bsummariz(e|ing)\b/i,
  /\bsynthesiz(e|ing)\b/i,
  /\bwhat('s| is) the pattern\b/i,
  /\bwhat('s| are) (my|the) (themes?|trends?|patterns?)\b/i,
  /\bwhat have I (learned|decided|said|captured)\b/i,
  /\boverall (summary|view|picture)\b/i,
  /\bgive me an overview\b/i,
]

/**
 * Returns true if the message text appears to request synthesis rather than search.
 */
export function isSynthesisRequest(text: string): boolean {
  return SYNTHESIS_PATTERNS.some((p) => p.test(text))
}

/**
 * Main synthesis handler. Called when a QUERY message is identified as a synthesis request.
 *
 * @param message       - Slack GenericMessageEvent
 * @param say           - Bolt's say() scoped to current channel
 * @param coreApiClient - Initialized CoreApiClient
 * @param queryText     - Pre-extracted query text (prefix-stripped)
 */
export async function handleSynthesis(
  message: GenericMessageEvent,
  say: SayFn,
  coreApiClient: CoreApiClient,
  queryText: string,
): Promise<void> {
  const ts = message.ts

  logger.info({ query: queryText, ts }, 'handleSynthesis: requesting synthesis')

  // Acknowledge immediately so the user knows synthesis is running
  await say({
    text: '_Synthesizing… this may take a moment._',
    thread_ts: ts,
  })

  try {
    const result = await coreApiClient.synthesize_query({
      query: queryText,
      limit: 20,
    })

    await say({ text: result.response, thread_ts: ts })

    logger.info({ ts }, 'handleSynthesis: synthesis complete')
  } catch (err) {
    logger.error({ err, query: queryText }, 'handleSynthesis: synthesize_query failed')
    await say({ text: formatError('Synthesis failed', err), thread_ts: ts })
  }
}
