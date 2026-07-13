import { mkdir, writeFile, readdir, readFile, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from '@open-brain/shared'
import { NotificationService, type PushoverOptions } from '../services/notification.js'

const log = createLogger('voice-capture')

/** Max age a spooled transcript may sit unretried before it's dead-lettered (default 7 days). */
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Read fresh per-call (no cache) — same rationale as {@link spoolDir}. */
function maxAgeMs(): number {
  return Number(process.env.VOICE_SPOOL_MAX_AGE_MS ?? DEFAULT_MAX_AGE_MS)
}

/** Default notifier — lazily built per-call so env vars (PUSHOVER_TOKEN/PUSHOVER_USER,
 * same names NotificationService reads) are picked up fresh, matching testability
 * conventions elsewhere in this module. Swallows send errors internally (onError:'swallow'). */
async function defaultNotify(opts: PushoverOptions): Promise<void> {
  await new NotificationService().send(opts)
}

/** File age in ms since last write, via mtime. Undefined if the file vanished (race-safe). */
async function fileAgeMs(file: string): Promise<number | undefined> {
  try {
    const st = await stat(file)
    return Date.now() - st.mtimeMs
  } catch {
    return undefined
  }
}

/**
 * INT-M4 transcript dead-letter spool.
 *
 * A classified transcript is written to a durable spool directory BEFORE the
 * ingest call (write-ahead), then deleted on a successful ingest. If ingest
 * fails — e.g. core-api is down/restarting — the spool file survives and the
 * periodic retry (`retrySpooledTranscripts`) re-ingests it later. This means a
 * transcribed voice memo is never lost to a transient core-api outage.
 *
 * The spool dir should be a mounted volume (compose: `voice-spool`) so it
 * survives a container restart. Read VOICE_SPOOL_DIR per-call (no cache) for
 * testability.
 */
function spoolDir(): string {
  return process.env.VOICE_SPOOL_DIR ?? '/data/voice-spool'
}

/** Write a payload to the spool and return the file path. */
export async function spoolTranscript(payload: unknown): Promise<string> {
  const dir = spoolDir()
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${Date.now()}-${randomUUID()}.json`)
  await writeFile(file, JSON.stringify(payload), 'utf8')
  return file
}

/** List spooled transcript file paths (empty if the dir does not exist yet). */
export async function listSpooled(): Promise<string[]> {
  const dir = spoolDir()
  try {
    const entries = await readdir(dir)
    return entries.filter((e) => e.endsWith('.json')).map((e) => join(dir, e))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** Delete a spooled file (no-op if already gone). */
export async function removeSpooled(file: string): Promise<void> {
  await unlink(file).catch(() => {
    /* already removed — fine */
  })
}

export interface SpoolRetryResult {
  retried: number
  succeeded: number
  failed: number
  /** Discarded for exceeding VOICE_SPOOL_MAX_AGE_MS — genuinely stuck, not retried. */
  deadLettered: number
}

/**
 * Retry every spooled transcript through `ingest`. On success the spool file is
 * deleted; on failure it is left for the next sweep. An unparseable/corrupt
 * file is removed (it can never succeed) so the spool can't loop forever.
 *
 * A file older than VOICE_SPOOL_MAX_AGE_MS (default 7 days, ~336 sweeps at the
 * default 30-min interval) is dead-lettered: discarded with a Pushover alert
 * instead of retried forever. This only catches genuinely-stuck failures —
 * 409 (duplicate) is terminal success in `ingest` and never reaches this loop
 * as a retained file, so a dead-lettered file always represents a real,
 * persistent ingest failure (e.g. malformed payload, or an outage far longer
 * than the retry window).
 */
export async function retrySpooledTranscripts(
  ingest: (payload: unknown) => Promise<{ id: string }>,
  notify: (opts: PushoverOptions) => Promise<void> = defaultNotify,
): Promise<SpoolRetryResult> {
  const files = await listSpooled()
  let succeeded = 0
  let failed = 0
  let deadLettered = 0
  const maxAge = maxAgeMs()

  for (const file of files) {
    let payload: unknown
    try {
      payload = JSON.parse(await readFile(file, 'utf8'))
    } catch (err) {
      log.warn({ err, file }, 'Spooled transcript is unreadable/corrupt — discarding')
      await removeSpooled(file)
      continue
    }

    // Age check happens before the ingest attempt — a file this old has already
    // had ~336 retry sweeps (at the default interval) to succeed. Parallels the
    // corrupt-file discard above: both are "this file can't be trusted to ever
    // clear on its own" backstops.
    const ageMs = await fileAgeMs(file)
    if (ageMs !== undefined && ageMs > maxAge) {
      deadLettered++
      const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1)
      log.warn({ file, ageMs, maxAge }, 'Spooled transcript exceeded max age — dead-lettering')
      await notify({
        title: 'Voice capture dead-lettered',
        message: `A spooled transcript (${ageDays}d old) exceeded the max retry age and was discarded without ingest: ${file}`,
        priority: 1,
      }).catch((err) => log.warn({ err, file }, 'Dead-letter Pushover alert failed'))
      await removeSpooled(file)
      continue
    }

    try {
      const created = await ingest(payload)
      await removeSpooled(file)
      succeeded++
      log.info({ file, captureId: created.id }, 'Spooled transcript ingested on retry')
    } catch (err) {
      failed++
      log.warn({ err, file }, 'Spooled transcript retry failed — will retry next sweep')
    }
  }

  return { retried: files.length, succeeded, failed, deadLettered }
}
