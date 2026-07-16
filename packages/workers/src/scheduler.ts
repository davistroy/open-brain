import { Queue } from 'bullmq'
import type { ConnectionOptions, JobSchedulerJson } from 'bullmq'
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
 * Identity of a freshly-registered job scheduler, captured at registration
 * time. In BullMQ v5 a job scheduler's `key` IS its id (the value passed to
 * upsertJobScheduler) — a stable, readable identity, not a content hash. So
 * reconciliation just keeps schedulers whose id was registered this boot and
 * removes the rest (GitHub #217).
 */
interface RegisteredScheduler {
  id: string
  pattern: string
}

/**
 * All cron patterns below are interpreted in this timezone (#295). BullMQ defaults
 * to UTC, so before this the homeserver (America/New_York) fired every job at its
 * cron-hour UTC — e.g. morning-brief `30 6` fired at 02:30 ET, not 06:30. With the
 * v5 upsertJobScheduler model the scheduler key is the stable job id (not a
 * content hash), so setting tz updates each schedule IN PLACE on the next boot —
 * no re-keyed orphans (that was a concern only under the old `.add({repeat})` API).
 */
const SCHEDULER_TIMEZONE = 'America/New_York'

/**
 * Minimal queue surface needed by {@link reconcileRepeatableJobs}. Keeps the
 * function decoupled from Queue's DataType variance and trivially mockable.
 * Uses the v5 Job Scheduler API — `getJobSchedulers()` returns BOTH v5
 * schedulers (readable key) AND any legacy `.add({ repeat })` repeatables
 * (hash key), and `removeJobScheduler(key)` removes either — so a single pass
 * cleans both surfaces, including the April-era hash-keyed orphans.
 */
interface ReconcilableQueue {
  readonly name: string
  getJobSchedulers(): Promise<JobSchedulerJson[]>
  removeJobScheduler(id: string): Promise<boolean>
}

/**
 * Removes orphaned job schedulers from a queue (GitHub #217).
 *
 * ## Why this was rewritten (a 2-day production outage — Entries 211–214)
 *
 * The previous version matched a live repeatable by `name + pattern + jobId`
 * against `getRepeatableJobs()`. But **BullMQ v5's `getRepeatableJobs()` never
 * populates `job.id`** (a fact only a real-Redis test surfaces — the unit
 * mock's fixture defaulted it to `null` and let the author fake it). So
 * `r.jobId === job.id` was ALWAYS false, every registration classified as an
 * orphan, and this function deleted all 21 schedules ~30ms after they were
 * registered, on every boot. Registration also passed `jobId` at the TOP LEVEL
 * of `add()` opts, where v5 ignores it — the same phantom-`id` assumption on
 * the write side.
 *
 * The fix uses the v5 model end to end: registration is `upsertJobScheduler(id,
 * …)`, so the scheduler's `key` equals its stable id. A scheduler is live iff
 * its `key` is in the registered id set — no pattern/tz/jobId fuzz. (A pattern
 * change is handled by upsert itself, which replaces in place, so reconcile is
 * only for schedulers whose id is no longer registered: renamed/removed jobs
 * and legacy hash-keyed orphans.)
 *
 * MUST run AFTER registration so every live scheduler is present.
 *
 * @param queue       Queue to reconcile (any BullMQ Queue satisfies this).
 * @param registered  Descriptors of the schedulers just registered on `queue`.
 */
export async function reconcileRepeatableJobs(
  queue: ReconcilableQueue,
  registered: RegisteredScheduler[],
): Promise<void> {
  let existing: JobSchedulerJson[]
  try {
    existing = await queue.getJobSchedulers()
  } catch (err) {
    // Reconciliation is best-effort: a Redis hiccup here must not block worker
    // startup. Orphans firing is strictly less bad than workers not starting.
    logger.warn(
      { err, queue: queue.name },
      '[scheduler] scheduler reconciliation skipped — getJobSchedulers failed',
    )
    return
  }

  const liveIds = new Set(registered.map((r) => r.id))

  for (const sched of existing) {
    // A live scheduler's key IS its registered id. Anything else is an orphan:
    // a renamed/removed job, or a legacy hash-keyed `.add({ repeat })` entry.
    if (liveIds.has(sched.key)) continue
    try {
      const removed = await queue.removeJobScheduler(sched.key)
      logger.warn(
        { queue: queue.name, key: sched.key, name: sched.name, pattern: sched.pattern, removed },
        '[scheduler] removed orphaned job scheduler (#217)',
      )
    } catch (err) {
      logger.warn(
        { err, queue: queue.name, key: sched.key },
        '[scheduler] failed to remove orphaned job scheduler',
      )
    }
  }
}

/**
 * Registers repeatable BullMQ jobs on their respective queues.
 *
 * ALL cron patterns are interpreted in America/New_York (`SCHEDULER_TIMEZONE`,
 * #295) — the "6:00 AM" times below are Eastern, as intended. Before #295 BullMQ
 * used UTC, so these fired ~4–5h early (morning-brief at 02:30 ET, not 06:30).
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
 * Each job's `jobId` is its stable v5 job-scheduler id: `upsertJobScheduler`
 * with the same id is an idempotent upsert that replaces a changed cron in
 * place, so calling this on every startup is safe and self-healing.
 *
 * After all registrations complete, orphaned schedulers (GitHub #217) are
 * reconciled away per-queue via {@link reconcileRepeatableJobs}: any scheduler
 * whose id was NOT registered this boot is removed — a renamed/removed job, or
 * a legacy hash-keyed `.add({ repeat })` orphan from before this migration.
 * A pattern change no longer orphans anything (upsert replaces in place), so
 * reconciliation only handles genuine id-level removals. It runs AFTER
 * registration so a live scheduler is always in the registered id set.
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
  // Per-queue registry of the job schedulers registered below, keyed by the
  // queue instance. Consumed after registration by reconcileRepeatableJobs() to
  // detect and remove orphaned schedulers (#217). Populated only by register().
  const registeredByQueue = new Map<Queue<any, any, string>, RegisteredScheduler[]>()

  /**
   * Registers one repeatable job AND records its identity for reconciliation.
   * Sourcing both the .add() call and the registry from the SAME arguments is
   * what makes reconciliation drift-proof: the recorded identity can never
   * disagree with what was actually registered, so a live schedule can never
   * be misclassified as an orphan (the sole failure mode of the risk row).
   *
   * Registers via the v5 `upsertJobScheduler(id, { pattern }, { name, data })`:
   * `jobId` becomes the scheduler id (a stable, readable key), `name`+`data`
   * form the job template every fire is stamped from. The worker dispatches on
   * `data.skillName`, so the template `name` is cosmetic — but kept for parity
   * with the legacy job name. Upsert is idempotent and replaces a changed
   * pattern in place, so calling this on every boot is safe and self-healing.
   *
   * The call goes through a minimal structural type so a plain `string` id and
   * `DataType` template typecheck without importing BullMQ's `NameType`
   * conditional; `data: DataType` keeps full call-site type-safety on the payload.
   */
  async function register<DataType>(
    queue: Queue<DataType>,
    name: string,
    data: DataType,
    pattern: string,
    jobId: string,
  ): Promise<void> {
    const schedulable = queue as unknown as {
      upsertJobScheduler(
        schedulerId: string,
        repeat: { pattern: string; tz: string },
        template: { name: string; data: DataType },
      ): Promise<unknown>
    }
    await schedulable.upsertJobScheduler(jobId, { pattern, tz: SCHEDULER_TIMEZONE }, { name, data })
    const list = registeredByQueue.get(queue) ?? []
    list.push({ id: jobId, pattern })
    registeredByQueue.set(queue, list)
    logger.info(
      { cron: pattern, schedulerId: jobId },
      `[scheduler] ${name} scheduler upserted`,
    )
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
