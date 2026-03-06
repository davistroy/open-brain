/**
 * Slack Bot entry point — creates Bolt app, registers handlers, starts Socket Mode connection.
 * Called by index.ts after environment validation.
 */

import type { App } from '@slack/bolt'
import type { CoreApiClient } from './lib/core-api-client.js'
import { logger } from './lib/logger.js'

/**
 * Register all message/event handlers on the Bolt app.
 * Handlers for capture, query, command, etc. will be added here as phases 7.2–7.4 are implemented.
 */
function registerHandlers(app: App, _coreApiClient: CoreApiClient): void {
  // Ignore bot messages globally — prevents feedback loops
  app.message(async ({ message, next }) => {
    if ('subtype' in message && message.subtype === 'bot_message') {
      return
    }
    if ('bot_id' in message && message.bot_id) {
      return
    }
    await next()
  })

  // Placeholder message handler — logs all user messages.
  // Phases 7.2–7.4 will replace this with intent routing.
  app.message(async ({ message, say }) => {
    if (!('text' in message) || !message.text) return

    const text = message.text
    const channel = 'channel' in message ? message.channel : 'unknown'
    const ts = 'ts' in message ? message.ts : 'unknown'

    logger.info({ channel, ts, textLen: text.length }, 'Received message')

    // Echo acknowledgment for now — intent router wires in Phase 7.2
    await say({
      text: '_Open Brain received your message. Intent routing coming in Phase 7.2._',
      thread_ts: ts,
    })
  })

  // App mention handler — `@Open Brain ...`
  app.event('app_mention', async ({ event, say }) => {
    logger.info({ channel: event.channel, ts: event.ts }, 'App mention received')

    await say({
      text: '_Open Brain received your mention. Query handling coming in Phase 7.4._',
      thread_ts: event.ts,
    })
  })

  logger.info('Slack bot handlers registered')
}

/**
 * Start the Bolt app and connect via Socket Mode.
 */
export async function startServer(app: App, coreApiClient: CoreApiClient): Promise<void> {
  registerHandlers(app, coreApiClient)

  await app.start()
  logger.info('Slack bot connected via Socket Mode')
}
