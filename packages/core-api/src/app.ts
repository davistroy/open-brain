import { Hono } from 'hono'
import { logger as honoLogger } from 'hono/logger'
import { cors } from 'hono/cors'
import { errorHandler } from './middleware/error-handler.js'

export function createApp(): Hono {
  const app = new Hono()

  // Global middleware
  app.use('*', honoLogger())
  app.use('*', cors({ origin: '*' }))
  app.use('*', errorHandler())

  return app
}
