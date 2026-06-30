import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { createLogger } from '@open-brain/shared'

const log = createLogger('voice-capture')

/**
 * Lightweight load of the configured brain views (SE-13). voice-capture is a
 * thin service that does NOT mount the full ConfigService — this mirrors the
 * slack-bot `ai-routing.yaml` pattern (read one YAML directly via js-yaml).
 *
 * Returns the list of configured view names, or `null` when the config is
 * unavailable / unparseable. A `null` result tells the caller to SKIP
 * brain_view validation (graceful degradation — core-api re-validates
 * brain_view at ingest, so this is a cost guard, not the only line of defense).
 *
 * Read per-call (no cache): voice captures are low-volume, so re-parsing a ~1 KB
 * YAML per request is negligible and keeps the function trivially testable
 * (set CONFIG_DIR per test, no stale module-level cache).
 */
export function getValidBrainViews(): string[] | null {
  const configDir = process.env.CONFIG_DIR ?? '/app/config'
  const path = join(configDir, 'brain-views.yaml')
  if (!existsSync(path)) return null
  try {
    const raw = yaml.load(readFileSync(path, 'utf8')) as { views?: Array<{ name?: unknown }> } | null
    const names = (raw?.views ?? [])
      .map((v) => v?.name)
      .filter((n): n is string => typeof n === 'string' && n.length > 0)
    return names.length > 0 ? names : null
  } catch (err) {
    log.warn({ err, path }, 'Failed to load brain-views.yaml — skipping brain_view validation')
    return null
  }
}
