import { mkdir, writeFile, readdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createLogger } from '@open-brain/shared'

const log = createLogger('voice-capture')

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
}

/**
 * Retry every spooled transcript through `ingest`. On success the spool file is
 * deleted; on failure it is left for the next sweep. An unparseable/corrupt
 * file is removed (it can never succeed) so the spool can't loop forever.
 */
export async function retrySpooledTranscripts(
  ingest: (payload: unknown) => Promise<{ id: string }>,
): Promise<SpoolRetryResult> {
  const files = await listSpooled()
  let succeeded = 0
  let failed = 0

  for (const file of files) {
    let payload: unknown
    try {
      payload = JSON.parse(await readFile(file, 'utf8'))
    } catch (err) {
      log.warn({ err, file }, 'Spooled transcript is unreadable/corrupt — discarding')
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

  return { retried: files.length, succeeded, failed }
}
