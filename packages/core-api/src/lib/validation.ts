/**
 * Shared validation helpers for core-api route handlers.
 *
 * Provides small, focused utilities that throw `ValidationError` (400) on
 * bad input so the global errorHandler renders the canonical
 * `{ error, code: 'VALIDATION_ERROR' }` response shape.
 */
import { z } from 'zod'
import { ValidationError } from '@open-brain/shared'

const uuidSchema = z.string().uuid()

/**
 * Parse and validate a UUID path parameter.
 * Throws `ValidationError` (HTTP 400) if the value is not a valid UUID v4/v5/etc.
 *
 * @param value    The raw string from `c.req.param()`
 * @param paramName  Human-readable param name used in the error message (default: 'id')
 */
export function parseUUIDParam(value: string, paramName = 'id'): string {
  const result = uuidSchema.safeParse(value)
  if (!result.success) {
    throw new ValidationError(`${paramName} must be a valid UUID`)
  }
  return result.data
}
