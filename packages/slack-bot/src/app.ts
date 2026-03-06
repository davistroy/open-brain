import { App, LogLevel } from '@slack/bolt'
import { logger } from './lib/logger.js'
import { CoreApiClient } from './lib/core-api-client.js'

export interface BotConfig {
  slackBotToken: string
  slackAppToken: string
  coreApiUrl: string
}

/**
 * Create and configure the Bolt application with Socket Mode.
 *
 * Environment variables required:
 *   SLACK_BOT_TOKEN  — xoxb-... bot token
 *   SLACK_APP_TOKEN  — xapp-... app-level token (Socket Mode)
 *   CORE_API_URL     — http://core-api:3000
 *   REDIS_URL        — redis://redis:6379
 *   LITELLM_URL      — https://llm.k4jda.net (for intent classification)
 */
export function createBoltApp(config: BotConfig): { app: App; coreApiClient: CoreApiClient } {
  const app = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    socketMode: true,
    // Suppress Bolt's own console logging — pino handles it
    logger: {
      debug: (...args) => logger.debug(args, 'bolt'),
      info: (...args) => logger.info(args, 'bolt'),
      warn: (...args) => logger.warn(args, 'bolt'),
      error: (...args) => logger.error(args, 'bolt'),
      setLevel: () => {},
      getLevel: () => LogLevel.INFO,
      setName: () => {},
    },
  })

  const coreApiClient = new CoreApiClient(config.coreApiUrl)

  // Global error handler — log but don't crash
  app.error(async (error) => {
    logger.error({ err: error }, 'Unhandled Bolt error')
  })

  return { app, coreApiClient }
}
