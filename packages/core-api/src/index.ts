import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { ConfigService } from '@open-brain/shared'
import { createApp } from './app.js'
import { logger } from './lib/logger.js'

// Load config
const configDir = join(process.cwd(), 'config')
const configService = new ConfigService(configDir)
configService.load()
logger.info('Config loaded successfully')

const app = createApp(configService)
const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, 'Core API listening')
})

export { app }
