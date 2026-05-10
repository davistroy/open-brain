/**
 * Synthesis handler — processes messages requesting AI synthesis over brain content.
 *
 * Detects synthesis intent keywords ("summarize", "synthesize", "what's the pattern", etc.)
 * and calls Core API POST /api/v1/synthesize, then replies with the AI-generated response.
 */

import type { SayFn } from '@slack/bolt'
import type { GenericMessageEvent } from '@slack/types'
import type { CoreApiClient } from '../lib/core-api-client.js'
import { formatError } from '../lib/formatters.js'
import { logger } from '@open-brain/shared'

/**
 * Patterns that indicate synthesis intent rather than a plain search.
 *
 * By the time this check runs, the message is already classified as QUERY intent,
 * so we can be aggressive — captures and casual messages never reach here.
 *
 * Design: questions and requests get LLM-synthesized answers.
 * Keyword-only queries (no question structure) fall through to raw search.
 */
const SYNTHESIS_PATTERNS = [
  // Summary / synthesis keywords (verb and noun forms)
  /\bsummar(y|iz(e|ing))\b/i,
  /\bsynthesi(s|z(e|ing))\b/i,
  /\brecap\b/i,
  /\brundown\b/i,
  /\bbreakdown\b/i,
  /\boverview\b/i,

  // Pattern / theme / trend analysis
  /\bwhat('s| is| are) (the |my )?(patterns?|themes?|trends?)\b/i,

  // Reflective queries — "what have/did/do I ..."
  /\bwhat (have|did|do) I\b/i,
  /\bwhat('s| is) my\b/i,

  // Interrogative words at start of query — questions want answers, not result lists
  /^(what|how|why|when|who|where|which)\b/i,

  // Trailing question mark
  /\?\s*$/,

  // Request verbs — "give me ...", "tell me ...", "explain ...", "describe ..."
  /\bgive me\b/i,
  /\btell me\b/i,
  /\bexplain\b/i,
  /\bdescribe\b/i,
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
    // Use core-api's default limit (10). Hardcoded 20 here historically pushed
    // the context past Spark vLLM's 32k ceiling on knowledge-heavy queries
    // (31745 input tokens + 1024 output > 32768). Real long-term fix is
    // per-capture token budgeting on the core-api side; tracked under #204.
    const result = await coreApiClient.synthesize_query({
      query: queryText,
    })

    await say({ text: result.response, thread_ts: ts })

    logger.info({ ts }, 'handleSynthesis: synthesis complete')
  } catch (err) {
    logger.error({ err, query: queryText }, 'handleSynthesis: synthesize_query failed')
    await say({ text: formatError('Synthesis failed', err), thread_ts: ts })
  }
}
