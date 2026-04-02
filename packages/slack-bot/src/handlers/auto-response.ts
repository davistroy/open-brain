/**
 * Auto-response handler -- processes channel messages that look like questions
 * Open Brain could answer.
 *
 * Three modes based on autonomy level:
 * - observe: Shadow mode -- classify, search, synthesize, LOG but never post
 * - assist: DM mode -- send Pushover/DM with draft when confidence > threshold
 * - advise: Threaded reply -- post attributed response in channel thread
 *
 * This handler runs ASYNCHRONOUSLY after normal message routing.
 * It must NEVER block or interfere with existing capture/query/command handling.
 */

import type { GenericMessageEvent } from '@slack/types'
import type { App } from '@slack/bolt'
import type { CoreApiClient } from '../lib/core-api-client.js'
import type { SearchResult } from '../lib/core-api-types.js'
import { scoreConfidence } from '../services/confidence-scorer.js'
import { formatAttributedResponse } from '../services/attribution-formatter.js'
import { logger, PushoverService, type AutonomyLevel, meetsAutonomyLevel } from '@open-brain/shared'

/** Minimum message length to consider for auto-response */
const MIN_MESSAGE_LENGTH = 15

/** Question patterns -- more conservative than IntentRouter's patterns */
const AUTO_RESPONSE_QUESTION_PATTERNS = [
  /^(what|who|when|where|why|how|which)\s/i,
  /\?\s*$/,
  /^(does anyone know|can someone|has anyone|do we|did we|is there|are there)\s/i,
]

export interface AutoResponseConfig {
  /** Core API base URL */
  coreApiUrl: string
  /** Confidence threshold for delivery (DM/threaded). Default: 0.6 */
  confidenceThreshold: number
  /** Staleness window in days for threaded replies. Default: 90 */
  stalenessDays: number
  /** Minimum corroborating results for threaded reply. Default: 2 */
  minCorroboratingResults: number
  /** Bot user ID (to filter out own messages) */
  botUserId?: string
  /** Owner user ID (skip auto-response for owner messages) */
  ownerUserId?: string
}

/**
 * Check if a message is a candidate for auto-response.
 * Only classifies questions from OTHER users (not the bot owner).
 */
export function isAutoResponseCandidate(
  message: GenericMessageEvent,
  config: AutoResponseConfig,
): boolean {
  const text = message.text ?? ''

  // Skip short messages
  if (text.length < MIN_MESSAGE_LENGTH) return false

  // Skip own messages and owner messages
  if (config.botUserId && message.user === config.botUserId) return false
  if (config.ownerUserId && message.user === config.ownerUserId) return false

  // Skip messages with command/capture prefixes
  if (text.startsWith('!') || text.startsWith('?')) return false

  // Check question patterns
  return AUTO_RESPONSE_QUESTION_PATTERNS.some(p => p.test(text))
}

/**
 * Handle a potential auto-response. This runs asynchronously and never throws.
 */
export async function handleAutoResponse(
  message: GenericMessageEvent,
  app: App,
  coreApiClient: CoreApiClient,
  autonomyLevel: AutonomyLevel,
  config: AutoResponseConfig,
): Promise<void> {
  const text = message.text ?? ''
  const channel = message.channel
  const ts = message.ts

  try {
    // Step 1: Search for relevant captures
    const searchResponse = await coreApiClient.search_query({
      query: text,
      limit: 10,
      search_mode: 'hybrid',
      temporal_weight: 0.1,
    })

    const results: SearchResult[] = searchResponse.results

    // Step 2: Score confidence
    const confidence = scoreConfidence(results)

    // Step 3: Synthesize a response (only if we have decent results)
    let synthesis = ''
    if (confidence.composite > 0.2 && results.length > 0) {
      try {
        const synthResponse = await coreApiClient.synthesize_query({
          query: text,
          limit: 10,
        })
        synthesis = synthResponse.response
      } catch (err) {
        logger.warn({ err }, '[auto-response] synthesis failed -- logging without synthesis')
      }
    }

    // Step 4: Format attributed response
    const attributed = synthesis
      ? formatAttributedResponse(synthesis, results)
      : { text: '', summary: 'No synthesis available', sources: [] }

    // Step 5: Log everything (shadow mode -- always happens)
    logger.info(
      {
        channel,
        ts,
        user: message.user,
        queryLength: text.length,
        confidence: confidence.composite,
        factors: confidence,
        resultCount: results.length,
        hasSynthesis: !!synthesis,
        autonomyLevel,
      },
      '[auto-response] shadow log',
    )

    // Step 6: DM/Pushover delivery (assist mode)
    if (
      meetsAutonomyLevel(autonomyLevel, 'assist') &&
      confidence.composite >= config.confidenceThreshold &&
      synthesis
    ) {
      try {
        const pushover = new PushoverService({ onError: 'swallow' })
        if (pushover.isConfigured) {
          const pushoverMessage = [
            `Channel question from <@${message.user}>:`,
            `"${text.length > 150 ? text.slice(0, 150) + '...' : text}"`,
            '',
            `Draft response (confidence: ${(confidence.composite * 100).toFixed(0)}%):`,
            attributed.summary,
            '',
            `Sources: ${confidence.relevantResultCount} relevant captures`,
          ].join('\n')

          await pushover.send({
            title: 'Open Brain: Auto-Response Draft',
            message: pushoverMessage,
            priority: 0,
          })

          logger.info({ channel, ts, confidence: confidence.composite }, '[auto-response] Pushover sent')
        }
      } catch (err) {
        logger.warn({ err }, '[auto-response] Pushover delivery failed')
      }
    }

    // Step 7: Threaded reply (advise mode)
    if (
      meetsAutonomyLevel(autonomyLevel, 'advise') &&
      confidence.composite >= config.confidenceThreshold &&
      synthesis &&
      confidence.relevantResultCount >= config.minCorroboratingResults
    ) {
      // Check staleness
      const now = Date.now()
      const oldestRelevant = results
        .filter(r => r.score > 0.3)
        .reduce((oldest, r) => {
          const age = (now - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24)
          return Math.max(oldest, age)
        }, 0)

      if (oldestRelevant <= config.stalenessDays) {
        try {
          await app.client.chat.postMessage({
            channel,
            thread_ts: ts,
            text: attributed.text,
          })
          logger.info(
            { channel, ts, confidence: confidence.composite, resultCount: confidence.relevantResultCount },
            '[auto-response] threaded reply posted',
          )
        } catch (err) {
          logger.warn({ err }, '[auto-response] failed to post threaded reply')
        }
      } else {
        logger.debug(
          { oldestRelevant, stalenessDays: config.stalenessDays },
          '[auto-response] skipped -- results too stale',
        )
      }
    }
  } catch (err) {
    // Never throw from auto-response -- it's fire-and-forget
    logger.error({ err, channel, ts }, '[auto-response] unhandled error')
  }
}
