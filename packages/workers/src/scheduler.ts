import { Queue } from 'bullmq'
import type { ConnectionOptions, RepeatableJob } from 'bullmq'
import { logger } from '@open-brain/shared'
import type { DailySweepJobData } from './jobs/daily-sweep.js'
import { createBudgetCheckQueue } from './jobs/budget-check.js'
import type { BudgetCheckJobData } from './jobs/budget-check.js'
import { createSkillExecutionQueue } from './queues/skill-execution.js'
import type { SkillExecutionJobData } from './queues/skill-execution.js'
import type { DataRetentionPruneJobData } from './jobs/data-retention-prune.js'

export interface ScheduledQueues {
  dailySweep: Queue<DailySweepJobData>
  budgetCheck: Queue<BudgetCheckJobData>
  skillExecution: Queue<SkillExecutionJobData>
  pruneAssociations: Queue<{ triggeredAt: string }>
  dataRetentionPrune: Queue<DataRetentionPruneJobData>
}

/**
 * Identity of a freshly-registered repeatable job, captured at registration
 * time. Reconciliation matches live repeatables against these descriptors by
 * exact (name + jobId + pattern) — the same identity BullMQ embeds in the
 * repeat key — so it never removes a live schedule (GitHub #217).
 */
interface RegisteredRepeat {
  name: string
  jobId: string
  pattern: string
}

/**
 * Minimal queue surface needed by {@link reconcileRepeatableJobs}. Keeps the
 * function decoupled from Queue's DataType variance and trivially mockable in
 * tests. The legacy getRepeatableJobs/removeRepeatableByKey API is used
 * deliberately to MATCH the .add({ repeat }) registration style — mixing the
 * newer JobScheduler API against legacy-registered repeatables is error-prone.
 */
interface ReconcilableQueue {
  readonly name: string
  getRepeatableJobs(): Promise<RepeatableJob[]>
  removeRepeatableByKey(key: string): Promise<boolean>
}

/**
 * Removes orphaned repeatable jobs from a queue (GitHub #217).
 *
 * BullMQ's legacy repeatable API keys each repeat by name + pattern + tz +
 * jobId. Changing a job's cron leaves the OLD key behind — it keeps firing
 * forever because nothing reconciles it. This compares every repeatable
 * currently on the queue against the set just registered and removes any that
 * does not EXACTLY match a registration.
 *
 * MUST run AFTER registration so every live schedule is guaranteed present in
 * getRepeatableJobs(). Matching by exact registered identity — and collecting
 * the live keys in a first pass before removing anything in a second pass —
 * guarantees a currently-registered schedule is never removed.
 *
 * @param queue       Queue to reconcile (any BullMQ Queue satisfies this).
 * @param registered  Descriptors of the repeatables just registered on `queue`.
 */
export async function reconcileRepeatableJobs(
  queue: ReconcilableQueue,
  registered: RegisteredRepeat[],
): Promise<void> {
  let existing: RepeatableJob[]
  try {
    existing = await queue.getRepeatableJobs()
  } catch (err) {
    // Reconciliation is best-effort: a Redis hiccup here must not block worker
    // startup. Orphans firing is strictly less bad than workers not starting.
    logger.warn(
      { err, queue: queue.name },
      '[scheduler] repeatable reconciliation skipped — getRepeatableJobs failed',
    )
    return
  }

  // Pass 1 — collect the exact keys of live (freshly-registered) repeatables.
  // A repeatable is live iff its full identity matches a current registration.
  // None of our registrations set a tz or an `every` interval, so any entry
  // carrying those cannot be one of ours.
  const liveKeys = new Set<string>()
  for (const job of existing) {
    const isLive = registered.some(
      (r) =>
        r.name === job.name &&
        r.pattern === job.pattern &&
        r.jobId === job.id &&
        job.tz == null &&
        job.every == null,
    )
    if (isLive) liveKeys.add(job.key)
  }

  // Pass 2 — remove every repeatable whose key is NOT a live key. These are
  // orphans left by past schedule changes.
  for (const job of existing) {
    if (liveKeys.has(job.key)) continue
    try {
      const removed = await queue.removeRepeatableByKey(job.key)
      logger.warn(
        {
          queue: queue.name,
          key: job.key,
          name: job.name,
          pattern: job.pattern,
          jobId: job.id,
          removed,
        },
        '[scheduler] removed orphaned repeatable job (#217)',
      )
    } catch (err) {
      logger.warn(
        { err, queue: queue.name, key: job.key },
        '[scheduler] failed to remove orphaned repeatable job',
      )
    }
  }
}

/**
 * Registers repeatable BullMQ jobs on their respective queues.
 *
 * Jobs registered:
 * - daily-sweep: 3:00 AM daily (cron: 0 3 * * *) — re-queues stuck pipeline captures
 * - wiki-synthesis:           6:00 AM daily    (cron: 0 6 * * *)    — anchor (unchanged)
 * - daily-connections:        6:10 AM daily    (cron: 10 6 * * *)   — cross-domain connections (P07: spread from 7:00)
 * - cost-analysis:            6:20 AM daily    (cron: 20 6 * * *)   — LLM cost tracking (P07: spread from 7:10)
 * - morning-brief:            6:30 AM weekdays (cron: 30 6 * * 1-5) — structured morning briefing (P07: spread from 7:15)
 * - capture-reminder-morning: 6:45 AM weekdays (cron: 45 6 * * 1-5) — morning Pushover nudge (P07: spread from 7:05)
 * - budget-check:             7:00 AM daily    (cron: 0 7 * * *)    — monthly AI spend vs thresholds (P07: spread from 8:00)
 * - drift-monitor:            7:15 AM daily    (cron: 15 7 * * *)   — brain-view classification drift (P07: spread from 8:15)
 * - pipeline-health: every 6 hours (cron: 0 0,6,12,18 * * *) — checks pipeline + capture flow health
 * - daily-sweep-skill: 8:00 PM daily (cron: 0 20 * * *) — LLM-powered evening summary
 * - capture-reminder-evening: 9:00 PM daily (cron: 0 21 * * *) — evening Pushover nudge with capture count
 * - memory-consolidation: 4:00 AM Sundays (cron: 0 4 * * 0) — LLM near-duplicate merging
 * - monthly-reflection: 9:00 AM 1st of month (cron: 0 9 1 * *) — LLM-powered monthly synthesis via runAgent()
 * - wiki-lint: 4:30 AM Sundays (cron: 30 4 * * 0) — scans wiki pages for quality issues (shifted from 0 5 to avoid email-classify overlap)
 * - wiki-synthesis: 6:00 AM daily (cron: 0 6 * * *) — queues unintegrated captures for wiki-ingest
 * - container-health: every 15 min (cron: 0,15,30,45 * * * *) — /health checks on all containers
 * - storage-audit: 3:15 AM Sundays (cron: 15 3 * * 0) — Postgres, Redis, backup, wiki sizes (shifted from 0 3 to avoid daily-sweep overlap)
 * - prune-associations: 3:30 AM Sundays (cron: 30 3 * * 0) — prunes stale low-weight Hebbian capture_associations (P06)
 * - data-retention-prune: 2:00 AM Sundays (cron: 0 2 * * 0) — deletes aged rows from event/log tables per retention policy (RC-4)
 * - secret-rotation: 10:00 AM 1st of month (cron: 0 10 1 * *) — checks API key ages via bws CLI, alerts if > 90 days
 * - capture-dedup-sweep: 4:00 AM Saturdays (cron: 0 4 * * 6) — flags near-duplicate captures (cosine > 0.95) for review
 *
 * - email-classify: 5:00 AM daily (cron: 0 5 * * *) — email classification pipeline
 *
 * jobId values are stable — BullMQ treats a repeat job with the same jobId as
 * an upsert, so calling this on every startup is safe.
 *
 * After all registrations complete, orphaned repeatables left by past cron
 * changes (GitHub #217) are reconciled away per-queue via
 * {@link reconcileRepeatableJobs}: any repeatable that does not match a
 * freshly-registered (name + jobId + pattern) identity is removed. Because a
 * changed cron yields a different repeat key, the stale key is orphaned and
 * would otherwise fire forever; reconciliation runs AFTER registration and
 * matches by exact key so it can never remove a live schedule.
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
  // Per-queue registry of the repeatables registered below, keyed by the queue
  // instance. Consumed after registration by reconcileRepeatableJobs() to
  // detect and remove orphaned repeat keys (#217). Populated only by register().
  const registeredByQueue = new Map<Queue<any, any, string>, RegisteredRepeat[]>()

  /**
   * Registers one repeatable job AND records its identity for reconciliation.
   * Sourcing both the .add() call and the registry from the SAME arguments is
   * what makes reconciliation drift-proof: the recorded identity can never
   * disagree with what was actually registered, so a live schedule can never
   * be misclassified as an orphan (the sole failure mode of the risk row).
   *
   * The .add() call goes through a minimal structural type so a plain `string`
   * job name typechecks — Queue.add's name param resolves to the generic
   * conditional `ExtractNameType<DataType, string>`, which a bare `string` is
   * not provably assignable to when DataType is unresolved. `data: DataType`
   * keeps full call-site type-safety on the job payload.
   */
  async function register<DataType>(
    queue: Queue<DataType>,
    name: string,
    data: DataType,
    pattern: string,
    jobId: string,
  ): Promise<void> {
    const addable = queue as unknown as {
      add(
        name: string,
        data: DataType,
        opts: { repeat: { pattern: string }; jobId: string },
      ): Promise<unknown>
    }
    await addable.add(name, data, { repeat: { pattern }, jobId })
    const list = registeredByQueue.get(queue) ?? []
    list.push({ name, jobId, pattern })
    registeredByQueue.set(queue, list)
    logger.info({ cron: pattern }, `[scheduler] ${name} repeatable job registered`)
  }

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

  await register(
    dailySweepQueue,
    'daily-sweep',
    { triggeredAt: new Date().toISOString() },
    sweepCron,
    'daily-sweep-recurring',
  )

  // --------------------------------------------------------
  // Budget check (8:00 AM)
  // --------------------------------------------------------
  const budgetCron = budgetCronOverride ?? '0 7 * * *' // P07: spread from 8:00 AM

  const budgetCheckQueue = createBudgetCheckQueue(connection)

  await register(
    budgetCheckQueue,
    'budget-check',
    { triggeredAt: new Date().toISOString() },
    budgetCron,
    'budget-check-recurring',
  )

  // --------------------------------------------------------
  // Daily connections skill (7:00 AM daily)
  // --------------------------------------------------------
  const connectionsCron = '10 6 * * *' // P07: spread from 7:00 AM

  const skillExecutionQueue = createSkillExecutionQueue(connection)

  await register(
    skillExecutionQueue,
    'daily-connections',
    { skillName: 'daily-connections', input: {} },
    connectionsCron,
    'scheduled_daily-connections',
  )

  // --------------------------------------------------------
  // Drift monitor skill (8:15 AM)
  // --------------------------------------------------------
  const driftCron = '15 7 * * *' // P07: spread from 8:15 AM

  await register(
    skillExecutionQueue,
    'drift-monitor',
    { skillName: 'drift-monitor', input: {} },
    driftCron,
    'scheduled_drift-monitor',
  )

  // --------------------------------------------------------
  // Pipeline health (every 6 hours)
  // --------------------------------------------------------
  const pipelineHealthCron = '0 */6 * * *'

  await register(
    skillExecutionQueue,
    'pipeline-health',
    { skillName: 'pipeline-health', input: {} },
    pipelineHealthCron,
    'scheduled_pipeline-health',
  )

  // --------------------------------------------------------
  // Daily sweep skill (8:00 PM)
  // --------------------------------------------------------
  const dailySweepSkillCron = '0 20 * * *'

  await register(
    skillExecutionQueue,
    'daily-sweep-skill',
    { skillName: 'daily-sweep-skill', input: {} },
    dailySweepSkillCron,
    'scheduled_daily-sweep-skill',
  )

  // --------------------------------------------------------
  // Memory consolidation skill (4:00 AM Sundays)
  // --------------------------------------------------------
  const memoryConsolidationCron = '0 4 * * 0'

  await register(
    skillExecutionQueue,
    'memory-consolidation',
    { skillName: 'memory-consolidation', input: {} },
    memoryConsolidationCron,
    'scheduled_memory-consolidation',
  )

  // --------------------------------------------------------
  // Capture reminder — morning (7:05 AM weekdays)
  // --------------------------------------------------------
  const captureReminderMorningCron = '45 6 * * 1-5' // P07: spread from 7:05 AM weekdays

  await register(
    skillExecutionQueue,
    'capture-reminder-morning',
    { skillName: 'capture-reminder-morning', input: { mode: 'morning' } },
    captureReminderMorningCron,
    'scheduled_capture-reminder-morning',
  )

  // --------------------------------------------------------
  // Morning brief (7:15 AM weekdays)
  // --------------------------------------------------------
  const morningBriefCron = '30 6 * * 1-5' // P07: spread from 7:15 AM weekdays

  await register(
    skillExecutionQueue,
    'morning-brief',
    { skillName: 'morning-brief', input: {} },
    morningBriefCron,
    'scheduled_morning-brief',
  )

  // --------------------------------------------------------
  // Capture reminder — evening (9 PM daily)
  // --------------------------------------------------------
  const captureReminderEveningCron = '0 21 * * *'

  await register(
    skillExecutionQueue,
    'capture-reminder-evening',
    { skillName: 'capture-reminder-evening', input: { mode: 'evening' } },
    captureReminderEveningCron,
    'scheduled_capture-reminder-evening',
  )

  // --------------------------------------------------------
  // Wiki lint (5:00 AM Sundays)
  // --------------------------------------------------------
  const wikiLintCron = '30 4 * * 0'

  await register(
    skillExecutionQueue,
    'wiki-lint',
    { skillName: 'wiki-lint', input: {} },
    wikiLintCron,
    'scheduled_wiki-lint',
  )

  // --------------------------------------------------------
  // Wiki synthesis (6:00 AM daily)
  // --------------------------------------------------------
  const wikiSynthesisCron = '0 6 * * *'

  await register(
    skillExecutionQueue,
    'wiki-synthesis',
    { skillName: 'wiki-synthesis', input: {} },
    wikiSynthesisCron,
    'scheduled_wiki-synthesis',
  )

  // --------------------------------------------------------
  // Monthly reflection (1st of month, 9:00 AM)
  // --------------------------------------------------------
  const monthlyReflectionCron = '0 9 1 * *'

  await register(
    skillExecutionQueue,
    'monthly-reflection',
    { skillName: 'monthly-reflection', input: {} },
    monthlyReflectionCron,
    'scheduled_monthly-reflection',
  )

  // --------------------------------------------------------
  // Cost analysis (6:20 AM daily — P07 spread)
  // --------------------------------------------------------
  const costAnalysisCron = '20 6 * * *'

  await register(
    skillExecutionQueue,
    'cost-analysis',
    { skillName: 'cost-analysis', input: {} },
    costAnalysisCron,
    'scheduled_cost-analysis',
  )

  // --------------------------------------------------------
  // Container health (every 15 minutes)
  // --------------------------------------------------------
  const containerHealthCron = '*/15 * * * *'

  await register(
    skillExecutionQueue,
    'container-health',
    { skillName: 'container-health', input: {} },
    containerHealthCron,
    'scheduled_container-health',
  )

  // --------------------------------------------------------
  // Storage audit (3:00 AM Sundays)
  // --------------------------------------------------------
  const storageAuditCron = '15 3 * * 0'

  await register(
    skillExecutionQueue,
    'storage-audit',
    { skillName: 'storage-audit', input: {} },
    storageAuditCron,
    'scheduled_storage-audit',
  )

  // --------------------------------------------------------
  // Secret rotation (1st of month, 10:00 AM)
  // --------------------------------------------------------
  const secretRotationCron = '0 10 1 * *'

  await register(
    skillExecutionQueue,
    'secret-rotation',
    { skillName: 'secret-rotation', input: {} },
    secretRotationCron,
    'scheduled_secret-rotation',
  )

  // --------------------------------------------------------
  // Capture dedup sweep (Saturday 4:00 AM)
  // --------------------------------------------------------
  const captureDedupSweepCron = '0 4 * * 6'

  await register(
    skillExecutionQueue,
    'capture-dedup-sweep',
    { skillName: 'capture-dedup-sweep', input: {} },
    captureDedupSweepCron,
    'scheduled_capture-dedup-sweep',
  )

  // --------------------------------------------------------
  // Email classify (5:00 AM daily)
  // --------------------------------------------------------
  const emailClassifyCron = '0 5 * * *'

  await register(
    skillExecutionQueue,
    'email-classify',
    { skillName: 'email-classify', input: { providers: ['hotmail', 'gmail'], sinceHours: 24 } },
    emailClassifyCron,
    'scheduled_email-classify',
  )

  // --------------------------------------------------------
  // Prune associations (3:30 AM Sundays)
  // 15 min after storage-audit (15 3 * * 0) and 30 min before
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

  await register(
    pruneAssociationsQueue,
    'prune-associations',
    { triggeredAt: new Date().toISOString() },
    pruneAssociationsCron,
    'prune-associations-recurring',
  )

  // --------------------------------------------------------
  // Data retention prune (2:00 AM Sundays)
  // 1 hour before storage-audit (15 3 * * 0), 30 min before
  // prune-associations (30 3 * * 0) — earliest safe Sunday slot,
  // no collision with any daily or weekly job.
  // --------------------------------------------------------
  const dataRetentionPruneCron = '0 2 * * 0'

  const dataRetentionPruneQueue = new Queue<DataRetentionPruneJobData>(
    'data-retention-prune',
    {
      connection,
      defaultJobOptions: {
        attempts: 1, // prune failure is logged, not retried — next run is next Sunday
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 10 },
      },
    },
  )

  await register(
    dataRetentionPruneQueue,
    'data-retention-prune',
    { triggeredAt: new Date().toISOString() },
    dataRetentionPruneCron,
    'data-retention-prune-recurring',
  )

  // --------------------------------------------------------
  // Reconcile repeatable jobs (#217)
  // Runs AFTER every registration above so each queue's live schedules are
  // guaranteed present. For each queue, removes any repeatable that does not
  // match a freshly-registered (name + jobId + pattern) identity — these are
  // orphans left by past cron changes that would otherwise fire forever.
  // --------------------------------------------------------
  for (const [queue, registered] of registeredByQueue) {
    await reconcileRepeatableJobs(queue, registered)
  }

  return {
    dailySweep: dailySweepQueue,
    budgetCheck: budgetCheckQueue,
    skillExecution: skillExecutionQueue,
    pruneAssociations: pruneAssociationsQueue,
    dataRetentionPrune: dataRetentionPruneQueue,
  }
}
