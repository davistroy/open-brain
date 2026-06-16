import { logger } from '@open-brain/shared'

/**
 * Dev-only fallback URL for the core-api service.
 *
 * Returned by {@link requireCoreApiUrl} ONLY when `OPEN_BRAIN_API_URL` is unset
 * AND the environment is development/test. Never used in production — see the
 * fail-fast branch below.
 */
export const CORE_API_URL_DEV_FALLBACK = 'http://localhost:3000'

/**
 * SE-16 — resolve the core-api base URL for workers, fail-closed.
 *
 * Background: workers proactive skills fetch the autonomy level from core-api
 * before running. The old inline `process.env.OPEN_BRAIN_API_URL ?? 'http://localhost:3000'`
 * meant that in production with the var unset, the fetch silently hit localhost,
 * failed, and `fetchAutonomyLevel` defaulted to `observe` — so EVERY autonomy-gated
 * skill was silently gated off and never ran. A misconfiguration that produced no
 * error, only missing behavior.
 *
 * This helper follows the codebase's established fail-closed NODE_ENV convention
 * (same shape as core-api `checkOrigin()`): unset/unknown NODE_ENV is treated as
 * production.
 *
 * Behavior matrix:
 *   | OPEN_BRAIN_API_URL | NODE_ENV              | result                          |
 *   | set                | any                   | return the value (no warn)      |
 *   | unset              | development | test    | warn once, return dev fallback  |
 *   | unset              | production | unset | unknown | throw (fail-fast)        |
 *
 * @throws Error naming the missing variable when unset in a production-like env.
 */
export function requireCoreApiUrl(): string {
  const url = process.env.OPEN_BRAIN_API_URL
  if (url) return url

  // Fail-closed: only development/test are non-production. Unset or any other
  // value (e.g. 'staging') is treated as production.
  const env = process.env.NODE_ENV
  const isDevOrTest = env === 'development' || env === 'test'

  if (isDevOrTest) {
    logger.warn(
      { fallback: CORE_API_URL_DEV_FALLBACK, nodeEnv: env },
      '[require-core-api-url] OPEN_BRAIN_API_URL not set — using dev fallback. ' +
        'Set OPEN_BRAIN_API_URL to the core-api base URL to silence this warning.',
    )
    return CORE_API_URL_DEV_FALLBACK
  }

  throw new Error(
    'OPEN_BRAIN_API_URL is required in production but was not set. ' +
      'Workers fetch the autonomy level from core-api at this URL before running ' +
      'proactive skills; without it every autonomy-gated skill is silently gated to ' +
      "'observe'. Set OPEN_BRAIN_API_URL (e.g. http://core-api:3000) in the workers " +
      'environment.',
  )
}
