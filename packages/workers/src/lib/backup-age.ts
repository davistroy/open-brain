import { stat } from 'node:fs/promises'
import { logger } from '@open-brain/shared'
import { pushMetrics } from './push-metrics.js'

/**
 * Default location of the latest-backup manifest — the `${BACKUP_ROOT}/latest`
 * symlink target, bind-mounted read-only into the workers container at
 * `/backup-latest` (docker-compose.yml workers volumes).
 */
export const DEFAULT_BACKUP_MANIFEST_PATH = '/backup-latest/manifest.json'

/**
 * Stat the latest backup manifest and push the `openbrain_backup_age_seconds`
 * gauge to Pushgateway. Returns the age in seconds, or `null` when the manifest
 * is absent/unreadable (mount not deployed yet, local dev, CI).
 *
 * GRACEFUL: never throws — a missing manifest logs at debug and returns null;
 * the push itself swallows its own errors (push-metrics).
 *
 * #309: this is pushed by BOTH `pipeline-health` (every 6h) AND `container-health`
 * (every 15m). Pushgateway has no persistence, so after a Pushgateway restart the
 * gauge would be ABSENT for up to 6h if only pipeline-health pushed it — and
 * `OpenBrainBackupStale` cannot fire on an absent metric. The 15-minute cadence
 * from container-health closes that blind window.
 */
export async function pushBackupAgeGauge(
  manifestPath: string = process.env.BACKUP_LATEST_PATH ?? DEFAULT_BACKUP_MANIFEST_PATH,
): Promise<number | null> {
  let mtimeMs: number
  try {
    const stats = await stat(manifestPath)
    mtimeMs = stats.mtime.getTime()
  } catch (err) {
    logger.debug({ err, manifestPath }, '[backup-age] manifest unavailable — skipping gauge push')
    return null
  }

  const ageSeconds = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000))

  await pushMetrics([
    {
      name: 'openbrain_backup_age_seconds',
      value: ageSeconds,
      help: 'Seconds since the latest backup manifest (scripts/backup.sh) was last written',
      type: 'gauge',
    },
  ])

  return ageSeconds
}
