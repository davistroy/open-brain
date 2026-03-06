import type { Context, MiddlewareHandler } from 'hono'
import { AppError } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

export const errorHandler = (): MiddlewareHandler => async (c, next) => {
  try {
    await next()
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn({ err, code: err.code }, 'AppError caught')
      return c.json(
        { error: err.message, code: err.code },
        err.statusCode as 400 | 404 | 409 | 500 | 503,
      )
    }
    logger.error({ err }, 'Unexpected error')
    return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500)
  }
}
