import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { logger } from './lib/logger.js'

const app = createApp()
const port = Number(process.env.PORT ?? 3000)

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, 'Core API listening')
})

export { app }
