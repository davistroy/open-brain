import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import {
  NotFoundError,
  ValidationError,
  app_settings,
  AUTONOMY_LEVELS,
  logger,
} from '@open-brain/shared'

/** Simple email format check — permissive but catches obvious non-emails */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Valid settings keys — prevents unbounded key creation */
const VALID_SETTINGS_KEYS = new Set([
  'email_allowlist',
  'autonomy_level',
  'auto_response_threshold',
  'auto_response_staleness_days',
  'monitored_channels',
  'email_classification',
  'ms_token_cache_node',
  'gmail_token_cache',
  'gmail_credentials',
  // M3 onboarding + settings page (3.4 / 3.5)
  'user_profile',
  'capture_habit',
  'onboarding_completed',
  // M3 ingest filters (3.2)
  'ingest_skip_automated_emails',
  'ingest_skip_low_signal_slack',
  'ingest_capture_bare_calendar',
  'ingest_voice_min_duration',
  // M3 entity extraction (3.2)
  'entity_extract_locations',
  'entity_extract_monetary',
  'entity_confidence_threshold',
])

/** Type-specific value validators for settings that need them */
const SETTINGS_VALIDATORS: Record<string, (value: unknown) => string | null> = {
  autonomy_level: (v) =>
    typeof v === 'string' && AUTONOMY_LEVELS.includes(v as never)
      ? null
      : `autonomy_level must be one of: ${AUTONOMY_LEVELS.join(', ')}`,
  auto_response_threshold: (v) =>
    typeof v === 'number' && v >= 0 && v <= 1
      ? null
      : 'auto_response_threshold must be a number between 0 and 1',
  auto_response_staleness_days: (v) =>
    typeof v === 'number' && v >= 1 && v <= 365
      ? null
      : 'auto_response_staleness_days must be a number between 1 and 365',
  monitored_channels: (v) =>
    Array.isArray(v) && v.every((item: unknown) => typeof item === 'string')
      ? null
      : 'monitored_channels must be an array of channel ID strings',
  email_allowlist: (v) =>
    Array.isArray(v) && v.every((item: unknown) =>
      typeof item === 'string' && EMAIL_REGEX.test(item)
    )
      ? null
      : 'email_allowlist must be an array of valid email addresses',
}

/**
 * Register settings API routes.
 *
 * GET  /api/v1/settings/:key — retrieve a setting by key
 * PUT  /api/v1/settings/:key — upsert a setting (key must be in whitelist)
 */
export function registerSettingsRoutes(app: Hono, db: Database): void {
  app.get('/api/v1/settings/:key', async (c) => {
    const key = c.req.param('key')
    if (!VALID_SETTINGS_KEYS.has(key)) {
      throw new ValidationError(`Unknown settings key: ${key}`)
    }
    const rows = await db.select().from(app_settings).where(eq(app_settings.key, key))
    if (rows.length === 0) {
      throw new NotFoundError(`Setting not found: ${key}`)
    }
    return c.json({ key: rows[0].key, value: rows[0].value, updated_at: rows[0].updated_at })
  })

  app.put('/api/v1/settings/:key', async (c) => {
    const key = c.req.param('key')
    if (!VALID_SETTINGS_KEYS.has(key)) {
      throw new ValidationError(`Unknown settings key: ${key}`)
    }
    let body: { value: unknown }
    try {
      body = await c.req.json()
    } catch {
      throw new ValidationError('Invalid JSON body')
    }
    if (body.value === undefined) {
      throw new ValidationError('value is required')
    }

    // Type-specific validation for settings that need it
    const validator = SETTINGS_VALIDATORS[key]
    if (validator) {
      const validationError = validator(body.value)
      if (validationError) {
        throw new ValidationError(`${validationError} (key: ${key})`)
      }
    }

    const now = new Date()
    await db.insert(app_settings).values({ key, value: body.value, updated_at: now })
      .onConflictDoUpdate({ target: app_settings.key, set: { value: body.value, updated_at: now } })

    logger.info({ key }, '[settings] Setting updated')
    return c.json({ key, value: body.value, updated_at: now.toISOString() })
  })
}
