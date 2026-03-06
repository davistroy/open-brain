import type { Context, ErrorHandler, MiddlewareHandler } from 'hono'
import { AppError } from '@open-brain/shared'
import { logger } from '../lib/logger.js'

function handleError(err: Error | unknown, c: Context) {
  if (err instanceof AppError) {
    logger.warn({ err, code: err.code }, 'AppError caught')
    return c.json(
      { error: err.message, code: err.code },
      err.statusCode as 400 | 404 | 409 | 422 | 500 | 503,
    )
  }
  logger.error({ err }, 'Unexpected error')
  return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500)
}

/**
 * Hono onError handler — use with app.onError(errorHandler())
 */
export const errorHandler = (): ErrorHandler => (err, c) => handleError(err, c)

/**
 * Middleware variant — catches errors propagated through next()
 * NOTE: In Hono v4, route errors are handled by onError, not middleware try/catch.
 * Prefer registering via app.onError(errorHandler()) for route error handling.
 */
export const errorMiddleware = (): MiddlewareHandler => async (c, next) => {
  try {
    await next()
  } catch (err) {
    return handleError(err, c)
  }
}
