import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { logger } from './lib/logger.js'
import type { DailySweepJobData } from './jobs/daily-sweep.js'
import { createBudgetCheckQueue } from './jobs/budget-check.js'
import type { BudgetCheckJobData } from './jobs/budget-check.js'
import { createSkillExecutionQueue } from './queues/skill-execution.js'
import type { SkillExecutionJobData } from './queues/skill-execution.js'

export interface ScheduledQueues {
  dailySweep: Queue<DailySweepJobData>
  budgetCheck: Queue<BudgetCheckJobData>
  skillExecution: Queue<SkillExecutionJobData>
}

/**
 * Registers repeatable BullMQ jobs on their respective queues.
 *
 * Jobs registered:
 * - daily-sweep: 3:00 AM daily (cron: 0 3 * * *) — re-queues stuck pipeline captures
 * - budget-check: 8:00 AM daily (cron: 0 8 * * *) — checks monthly AI spend vs thresholds
 * - daily-connections: 9:00 PM daily (cron: 0 21 * * *) — cross-domain pattern detection skill
 *
 * jobId values are stable — BullMQ treats a repeat job with the same jobId as
 * an upsert, so calling this on every startup is safe.
 *
 * @param connection  Redis ConnectionOptions (same pool as other workers)
 * @param cronOverride  Optional cron string override (applies to daily-sweep; for testing)
 * @param budgetCronOverride  Optional cron string override for budget-check (for testing)
 */
export async function registerScheduledJobs(
  connection: ConnectionOptions,
  cronOverride?: string,
  budgetCronOverride?: string,
): Promise<ScheduledQueues> {
  // --------------------------------------------------------
  // Daily sweep (3:00 AM)
  // --------------------------------------------------------
  const sweepCron = cronOverride ?? '0 3 * * *'

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
      repeat: { pattern: sweepCron },
      jobId: 'daily-sweep-recurring',
    },
  )

  logger.info({ cron: sweepCron }, '[scheduler] daily-sweep repeatable job registered')

  // --------------------------------------------------------
  // Budget check (8:00 AM)
  // --------------------------------------------------------
  const budgetCron = budgetCronOverride ?? '0 8 * * *'

  const budgetCheckQueue = createBudgetCheckQueue(connection)

  await budgetCheckQueue.add(
    'budget-check',
    { triggeredAt: new Date().toISOString() },
    {
      repeat: { pattern: budgetCron },
      jobId: 'budget-check-recurring',
    },
  )

  logger.info({ cron: budgetCron }, '[scheduler] budget-check repeatable job registered')

  // --------------------------------------------------------
  // Daily connections skill (9:00 PM)
  // --------------------------------------------------------
  const connectionsCron = '0 21 * * *'

  const skillExecutionQueue = createSkillExecutionQueue(connection)

  await skillExecutionQueue.add(
    'daily-connections',
    {
      skillName: 'daily-connections',
      input: {},
    },
    {
      repeat: { pattern: connectionsCron },
      jobId: 'scheduled_daily-connections',
    },
  )

  logger.info({ cron: connectionsCron }, '[scheduler] daily-connections repeatable job registered')

  return { dailySweep: dailySweepQueue, budgetCheck: budgetCheckQueue, skillExecution: skillExecutionQueue }
}
