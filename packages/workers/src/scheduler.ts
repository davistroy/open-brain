import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { logger } from '@open-brain/shared'
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
  const connectionsCron = '0 0 29 2 *'

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

  // --------------------------------------------------------
  // Drift monitor skill (8:00 AM)
  // --------------------------------------------------------
  const driftCron = '0 8 * * *'

  await skillExecutionQueue.add(
    'drift-monitor',
    {
      skillName: 'drift-monitor',
      input: {},
    },
    {
      repeat: { pattern: driftCron },
      jobId: 'scheduled_drift-monitor',
    },
  )

  logger.info({ cron: driftCron }, '[scheduler] drift-monitor repeatable job registered')

  // --------------------------------------------------------
  // Pipeline health (every 6 hours)
  // --------------------------------------------------------
  const pipelineHealthCron = '0 */6 * * *'

  await skillExecutionQueue.add(
    'pipeline-health',
    {
      skillName: 'pipeline-health',
      input: {},
    },
    {
      repeat: { pattern: pipelineHealthCron },
      jobId: 'scheduled_pipeline-health',
    },
  )

  logger.info({ cron: pipelineHealthCron }, '[scheduler] pipeline-health repeatable job registered')

  // --------------------------------------------------------
  // Daily sweep skill (8:00 PM)
  // --------------------------------------------------------
  const dailySweepSkillCron = '0 20 * * *'

  await skillExecutionQueue.add(
    'daily-sweep-skill',
    {
      skillName: 'daily-sweep-skill',
      input: {},
    },
    {
      repeat: { pattern: dailySweepSkillCron },
      jobId: 'scheduled_daily-sweep-skill',
    },
  )

  logger.info({ cron: dailySweepSkillCron }, '[scheduler] daily-sweep-skill repeatable job registered')

  // --------------------------------------------------------
  // Memory consolidation skill (4:00 AM Sundays)
  // --------------------------------------------------------
  const memoryConsolidationCron = '0 4 * * 0'

  await skillExecutionQueue.add(
    'memory-consolidation',
    {
      skillName: 'memory-consolidation',
      input: {},
    },
    {
      repeat: { pattern: memoryConsolidationCron },
      jobId: 'scheduled_memory-consolidation',
    },
  )

  logger.info({ cron: memoryConsolidationCron }, '[scheduler] memory-consolidation repeatable job registered')

  // --------------------------------------------------------
  // Capture reminder — morning (7 AM weekdays)
  // --------------------------------------------------------
  const captureReminderMorningCron = '0 7 * * 1-5'

  await skillExecutionQueue.add(
    'capture-reminder-morning',
    {
      skillName: 'capture-reminder-morning',
      input: { mode: 'morning' },
    },
    {
      repeat: { pattern: captureReminderMorningCron },
      jobId: 'scheduled_capture-reminder-morning',
    },
  )

  logger.info({ cron: captureReminderMorningCron }, '[scheduler] capture-reminder-morning repeatable job registered')

  // --------------------------------------------------------
  // Morning brief (7:15 AM weekdays)
  // --------------------------------------------------------
  const morningBriefCron = '15 7 * * 1-5'

  await skillExecutionQueue.add(
    'morning-brief',
    {
      skillName: 'morning-brief',
      input: {},
    },
    {
      repeat: { pattern: morningBriefCron },
      jobId: 'scheduled_morning-brief',
    },
  )

  logger.info({ cron: morningBriefCron }, '[scheduler] morning-brief repeatable job registered')

  // --------------------------------------------------------
  // Capture reminder — evening (9 PM daily)
  // --------------------------------------------------------
  const captureReminderEveningCron = '0 21 * * *'

  await skillExecutionQueue.add(
    'capture-reminder-evening',
    {
      skillName: 'capture-reminder-evening',
      input: { mode: 'evening' },
    },
    {
      repeat: { pattern: captureReminderEveningCron },
      jobId: 'scheduled_capture-reminder-evening',
    },
  )

  logger.info({ cron: captureReminderEveningCron }, '[scheduler] capture-reminder-evening repeatable job registered')

  return { dailySweep: dailySweepQueue, budgetCheck: budgetCheckQueue, skillExecution: skillExecutionQueue }
}
