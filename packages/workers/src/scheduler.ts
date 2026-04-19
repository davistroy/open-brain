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
  pruneAssociations: Queue<{ triggeredAt: string }>
}

/**
 * Registers repeatable BullMQ jobs on their respective queues.
 *
 * Jobs registered:
 * - daily-sweep: 3:00 AM daily (cron: 0 3 * * *) — re-queues stuck pipeline captures
 * - budget-check: 8:00 AM daily (cron: 0 8 * * *) — checks monthly AI spend vs thresholds
 * - daily-connections: 7:00 AM daily (cron: 0 7 * * *) — cross-domain connections + wiki synthesis (anchor)
 * - capture-reminder-morning: 7:05 AM weekdays (cron: 5 7 * * 1-5) — morning Pushover nudge
 * - cost-analysis: 7:10 AM daily (cron: 10 7 * * *) — LLM cost tracking, weekly/monthly reports
 * - morning-brief: 7:15 AM weekdays (cron: 15 7 * * 1-5) — structured morning briefing (no LLM)
 * - drift-monitor: 8:15 AM daily (cron: 15 8 * * *) — detects brain-view classification drift
 * - pipeline-health: every 6 hours (cron: 0 0,6,12,18 * * *) — checks pipeline + capture flow health
 * - daily-sweep-skill: 8:00 PM daily (cron: 0 20 * * *) — LLM-powered evening summary
 * - capture-reminder-evening: 9:00 PM daily (cron: 0 21 * * *) — evening Pushover nudge with capture count
 * - memory-consolidation: 4:00 AM Sundays (cron: 0 4 * * 0) — LLM near-duplicate merging
 * - monthly-reflection: 9:00 AM 1st of month (cron: 0 9 1 * *) — LLM-powered monthly synthesis via runAgent()
 * - wiki-lint: 5:00 AM Sundays (cron: 0 5 * * 0) — scans wiki pages for quality issues
 * - wiki-synthesis: 6:00 AM daily (cron: 0 6 * * *) — queues unintegrated captures for wiki-ingest
 * - container-health: every 15 min (cron: 0,15,30,45 * * * *) — /health checks on all containers
 * - storage-audit: 3:00 AM Sundays (cron: 0 3 * * 0) — Postgres, Redis, backup, wiki sizes
 * - prune-associations: 3:30 AM Sundays (cron: 30 3 * * 0) — prunes stale low-weight Hebbian capture_associations (P06)
 * - secret-rotation: 10:00 AM 1st of month (cron: 0 10 1 * *) — checks API key ages via bws CLI, alerts if > 90 days
 * - capture-dedup-sweep: 4:00 AM Saturdays (cron: 0 4 * * 6) — flags near-duplicate captures (cosine > 0.95) for review
 *
 * - email-classify: 5:00 AM daily (cron: 0 5 * * *) — email classification pipeline
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
  // Daily connections skill (7:00 AM daily)
  // --------------------------------------------------------
  const connectionsCron = '0 7 * * *'

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
  // Drift monitor skill (8:15 AM)
  // --------------------------------------------------------
  const driftCron = '15 8 * * *'

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
  // Capture reminder — morning (7:05 AM weekdays)
  // --------------------------------------------------------
  const captureReminderMorningCron = '5 7 * * 1-5'

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

  // --------------------------------------------------------
  // Wiki lint (5:00 AM Sundays)
  // --------------------------------------------------------
  const wikiLintCron = '0 5 * * 0'

  await skillExecutionQueue.add(
    'wiki-lint',
    {
      skillName: 'wiki-lint',
      input: {},
    },
    {
      repeat: { pattern: wikiLintCron },
      jobId: 'scheduled_wiki-lint',
    },
  )

  logger.info({ cron: wikiLintCron }, '[scheduler] wiki-lint repeatable job registered')

  // --------------------------------------------------------
  // Wiki synthesis (6:00 AM daily)
  // --------------------------------------------------------
  const wikiSynthesisCron = '0 6 * * *'

  await skillExecutionQueue.add(
    'wiki-synthesis',
    {
      skillName: 'wiki-synthesis',
      input: {},
    },
    {
      repeat: { pattern: wikiSynthesisCron },
      jobId: 'scheduled_wiki-synthesis',
    },
  )

  logger.info({ cron: wikiSynthesisCron }, '[scheduler] wiki-synthesis repeatable job registered')

  // --------------------------------------------------------
  // Monthly reflection (1st of month, 9:00 AM)
  // --------------------------------------------------------
  const monthlyReflectionCron = '0 9 1 * *'

  await skillExecutionQueue.add(
    'monthly-reflection',
    {
      skillName: 'monthly-reflection',
      input: {},
    },
    {
      repeat: { pattern: monthlyReflectionCron },
      jobId: 'scheduled_monthly-reflection',
    },
  )

  logger.info({ cron: monthlyReflectionCron }, '[scheduler] monthly-reflection repeatable job registered')

  // --------------------------------------------------------
  // Cost analysis (7:10 AM daily)
  // --------------------------------------------------------
  const costAnalysisCron = '10 7 * * *'

  await skillExecutionQueue.add(
    'cost-analysis',
    {
      skillName: 'cost-analysis',
      input: {},
    },
    {
      repeat: { pattern: costAnalysisCron },
      jobId: 'scheduled_cost-analysis',
    },
  )

  logger.info({ cron: costAnalysisCron }, '[scheduler] cost-analysis repeatable job registered')

  // --------------------------------------------------------
  // Container health (every 15 minutes)
  // --------------------------------------------------------
  const containerHealthCron = '*/15 * * * *'

  await skillExecutionQueue.add(
    'container-health',
    {
      skillName: 'container-health',
      input: {},
    },
    {
      repeat: { pattern: containerHealthCron },
      jobId: 'scheduled_container-health',
    },
  )

  logger.info({ cron: containerHealthCron }, '[scheduler] container-health repeatable job registered')

  // --------------------------------------------------------
  // Storage audit (3:00 AM Sundays)
  // --------------------------------------------------------
  const storageAuditCron = '0 3 * * 0'

  await skillExecutionQueue.add(
    'storage-audit',
    {
      skillName: 'storage-audit',
      input: {},
    },
    {
      repeat: { pattern: storageAuditCron },
      jobId: 'scheduled_storage-audit',
    },
  )

  logger.info({ cron: storageAuditCron }, '[scheduler] storage-audit repeatable job registered')

  // --------------------------------------------------------
  // Secret rotation (1st of month, 10:00 AM)
  // --------------------------------------------------------
  const secretRotationCron = '0 10 1 * *'

  await skillExecutionQueue.add(
    'secret-rotation',
    {
      skillName: 'secret-rotation',
      input: {},
    },
    {
      repeat: { pattern: secretRotationCron },
      jobId: 'scheduled_secret-rotation',
    },
  )

  logger.info({ cron: secretRotationCron }, '[scheduler] secret-rotation repeatable job registered')

  // --------------------------------------------------------
  // Capture dedup sweep (Saturday 4:00 AM)
  // --------------------------------------------------------
  const captureDedupSweepCron = '0 4 * * 6'

  await skillExecutionQueue.add(
    'capture-dedup-sweep',
    {
      skillName: 'capture-dedup-sweep',
      input: {},
    },
    {
      repeat: { pattern: captureDedupSweepCron },
      jobId: 'scheduled_capture-dedup-sweep',
    },
  )

  logger.info({ cron: captureDedupSweepCron }, '[scheduler] capture-dedup-sweep repeatable job registered')

  // --------------------------------------------------------
  // Email classify (5:00 AM daily)
  // --------------------------------------------------------
  const emailClassifyCron = '0 5 * * *'

  await skillExecutionQueue.add(
    'email-classify',
    {
      skillName: 'email-classify',
      input: { providers: ['hotmail', 'gmail'], sinceHours: 24 },
    },
    {
      repeat: { pattern: emailClassifyCron },
      jobId: 'scheduled_email-classify',
    },
  )

  logger.info({ cron: emailClassifyCron }, '[scheduler] email-classify repeatable job registered')

  // --------------------------------------------------------
  // Prune associations (3:30 AM Sundays)
  // Staggered 30 min after storage-audit (0 3 * * 0) and 30 min before
  // memory-consolidation (0 4 * * 0) — safe slot, no Sunday cron collision.
  // --------------------------------------------------------
  const pruneAssociationsCron = '30 3 * * 0'

  const pruneAssociationsQueue = new Queue<{ triggeredAt: string }>(
    'prune-associations',
    {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 10 },
      },
    },
  )

  await pruneAssociationsQueue.add(
    'prune-associations',
    { triggeredAt: new Date().toISOString() },
    {
      repeat: { pattern: pruneAssociationsCron },
      jobId: 'prune-associations-recurring',
    },
  )

  logger.info({ cron: pruneAssociationsCron }, '[scheduler] prune-associations repeatable job registered')

  return { dailySweep: dailySweepQueue, budgetCheck: budgetCheckQueue, skillExecution: skillExecutionQueue, pruneAssociations: pruneAssociationsQueue }
}
