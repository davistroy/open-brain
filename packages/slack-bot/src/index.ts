// @open-brain/slack-bot — entry point

import { createBoltApp } from './app.js'
import { startServer } from './server.js'
import { logger } from './lib/logger.js'

// Validate required environment variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN
const CORE_API_URL = process.env.CORE_API_URL ?? 'http://localhost:3000'

if (!SLACK_BOT_TOKEN) {
  logger.error('SLACK_BOT_TOKEN is required')
  process.exit(1)
}

if (!SLACK_APP_TOKEN) {
  logger.error('SLACK_APP_TOKEN is required (Socket Mode requires an app-level token)')
  process.exit(1)
}

logger.info({ coreApiUrl: CORE_API_URL }, 'Starting Open Brain Slack bot')

const { app, coreApiClient } = createBoltApp({
  slackBotToken: SLACK_BOT_TOKEN,
  slackAppToken: SLACK_APP_TOKEN,
  coreApiUrl: CORE_API_URL,
})

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received, stopping Slack bot')
  try {
    await app.stop()
    logger.info('Slack bot stopped cleanly')
  } catch (err) {
    logger.error({ err }, 'Error during shutdown')
  } finally {
    process.exit(0)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// Start
startServer(app, coreApiClient).catch((err) => {
  logger.error({ err }, 'Failed to start Slack bot')
  process.exit(1)
})
