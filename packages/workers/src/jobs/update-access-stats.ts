import { Worker } from 'bullmq'
import { sql } from 'drizzle-orm'
import type { ConnectionOptions } from 'bullmq'
import type { Database } from '@open-brain/shared'
import type { AccessStatsJobData } from '../queues/access-stats.js'

/**
 * Processes an access-stats job: increments access_count and sets
 * last_accessed_at for every capture ID returned by a search.
 *
 * Uses a single batch UPDATE for efficiency. Job failure emits a WARN
 * log only — the queue is configured for 1 attempt, so there is no retry storm.
 */
export async function processAccessStatsJob(
  data: AccessStatsJobData,
  db: Database,
): Promise<void> {
  const { captureIds, accessedAt } = data

  if (captureIds.length === 0) {
    return
  }

  // Drizzle's sql`` tag lets us issue parameterised-style raw SQL via the
  // existing connection pool without bundling a raw pg client.
  // ARRAY[...] with explicit ::uuid[] cast avoids any type inference ambiguity.
  const idList = captureIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')

  await db.execute(
    sql.raw(`
      UPDATE captures
      SET
        access_count     = access_count + 1,
        last_accessed_at = '${accessedAt.replace(/'/g, "''")}'::timestamptz
      WHERE id = ANY(ARRAY[${idList}]::uuid[])
    `),
  )
}

/**
 * Creates and returns a BullMQ Worker for the 'access-stats' queue.
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createAccessStatsWorker(
  connection: ConnectionOptions,
  db: Database,
): Worker<AccessStatsJobData> {
  const worker = new Worker<AccessStatsJobData>(
    'access-stats',
    async (job) => {
      await processAccessStatsJob(job.data, db)
    },
    {
      connection,
      concurrency: 5,
    },
  )

  worker.on('failed', (job, err) => {
    const ids = job?.data?.captureIds ?? []
    console.warn(
      `[access-stats] job ${job?.id ?? 'unknown'} failed for ${ids.length} capture(s): ${err.message}`,
    )
  })

  return worker
}
