import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { logger } from './lib/logger.js'
import type { DailySweepJobData } from './jobs/daily-sweep.js'

/**
 * Registers the daily sweep repeatable job on the 'daily-sweep' queue.
 *
 * Cron: 0 3 * * * (3:00 AM daily, matches pipeline.yaml daily_sweep_cron).
 * jobId: 'daily-sweep-recurring' is stable — BullMQ treats a repeat job with
 * the same jobId as an upsert, so calling this on every startup is safe.
 *
 * @param connection  Redis ConnectionOptions (same pool as other workers)
 * @param cronOverride  Optional cron string override (for testing)
 */
export async function registerScheduledJobs(
  connection: ConnectionOptions,
  cronOverride?: string,
): Promise<Queue<DailySweepJobData>> {
  const cron = cronOverride ?? '0 3 * * *'

  const dailySweepQueue = new Queue<DailySweepJobData>('daily-sweep', {
    connection,
    defaultJobOptions: {
      attempts: 1, // sweep failure is logged, not retried — next run is tomorrow
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 10 },
    },
  })

  await dailySweepQueue.add(
    'daily-sweep',
    { triggeredAt: new Date().toISOString() },
    {
      repeat: { pattern: cron },
      jobId: 'daily-sweep-recurring',
    },
  )

  logger.info({ cron }, '[scheduler] daily-sweep repeatable job registered')

  return dailySweepQueue
}
