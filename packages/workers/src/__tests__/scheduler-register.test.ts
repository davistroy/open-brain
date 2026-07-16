import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ConnectionOptions, JobSchedulerJson } from 'bullmq'

/**
 * Executes registerScheduledJobs() end-to-end against a mocked bullmq Queue.
 *
 * scheduler.ts's other test files (scheduler-slots.test.ts,
 * scheduler-connections-cron.test.ts, scheduler-reconcile.test.ts) either
 * statically parse the source or exercise reconcileRepeatableJobs() directly
 * with a hand-built mock queue — none of them actually CALL
 * registerScheduledJobs(), so the ~21 register() call sites, the 5 `new
 * Queue(...)` constructions (including the ones behind
 * createBudgetCheckQueue/createSkillExecutionQueue), and the
 * registeredByQueue reconciliation loop were all at 0% coverage.
 *
 * Only bullmq's Queue is mocked — no Redis, no db, no fetch. Queue instances
 * are captured by name in mockQueueInstances so assertions can target a
 * specific queue's .upsertJobScheduler()/.getJobSchedulers()/.removeJobScheduler()
 * mock functions. mockSchedulersByQueue lets a test seed what a given queue's
 * getJobSchedulers() resolves to, for the orphan-reconciliation case.
 */

// ---------------------------------------------------------------------------
// bullmq mock — variable names are `mock`-prefixed per Vitest's vi.mock
// hoisting rule (out-of-scope references must be prefixed with "mock").
// ---------------------------------------------------------------------------
let mockQueueInstances: Record<string, any> = {}
let mockSchedulersByQueue: Record<string, JobSchedulerJson[]> = {}

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string, opts: unknown) => {
    const instance = {
      name,
      opts,
      // Registration uses upsertJobScheduler (v5); reconcile uses
      // getJobSchedulers/removeJobScheduler. The legacy add/getRepeatableJobs
      // are gone — the migration (Entry 214) does not touch them any more.
      upsertJobScheduler: vi.fn().mockResolvedValue({ id: 'mock-job' }),
      getJobSchedulers: vi.fn(() => Promise.resolve(mockSchedulersByQueue[name] ?? [])),
      removeJobScheduler: vi.fn().mockResolvedValue(true),
    }
    mockQueueInstances[name] = instance
    return instance
  }),
}))

import { registerScheduledJobs } from '../scheduler.js'

const FAKE_CONNECTION = { host: 'test-redis', port: 6379 } as unknown as ConnectionOptions

/** Build a scheduler entry as getJobSchedulers() would return it. */
function jobScheduler(over: { key: string; name: string; pattern?: string }): JobSchedulerJson {
  return { key: over.key, name: over.name, pattern: over.pattern ?? '0 0 * * *' }
}

/**
 * Extracts { name, pattern, jobId } for every upsertJobScheduler() call.
 * `upsertJobScheduler(schedulerId, { pattern }, { name, data })` — so
 * schedulerId is the jobId, and the template carries the name.
 */
function addedJobs(queueName: string): Array<{ name: string; pattern: string; jobId: string }> {
  const instance = mockQueueInstances[queueName]
  return instance.upsertJobScheduler.mock.calls.map((call: any[]) => ({
    name: call[2]?.name,
    pattern: call[1]?.pattern,
    jobId: call[0],
  }))
}

describe('registerScheduledJobs — execution coverage', () => {
  beforeEach(() => {
    mockQueueInstances = {}
    mockSchedulersByQueue = {}
    vi.clearAllMocks()
  })

  it('constructs all 5 documented queues by name', async () => {
    await registerScheduledJobs(FAKE_CONNECTION)

    expect(Object.keys(mockQueueInstances).sort()).toEqual(
      [
        'budget-check',
        'daily-sweep',
        'data-retention-prune',
        'prune-associations',
        'skill-execution',
      ].sort(),
    )
  })

  it('returns a ScheduledQueues object referencing the 5 mock queue instances', async () => {
    const queues = await registerScheduledJobs(FAKE_CONNECTION)

    expect(queues.dailySweep).toBe(mockQueueInstances['daily-sweep'])
    expect(queues.budgetCheck).toBe(mockQueueInstances['budget-check'])
    expect(queues.skillExecution).toBe(mockQueueInstances['skill-execution'])
    expect(queues.pruneAssociations).toBe(mockQueueInstances['prune-associations'])
    expect(queues.dataRetentionPrune).toBe(mockQueueInstances['data-retention-prune'])
  })

  it('registers daily-sweep with the default cron when no override is given', async () => {
    await registerScheduledJobs(FAKE_CONNECTION)

    expect(addedJobs('daily-sweep')).toEqual([
      { name: 'daily-sweep', pattern: '0 3 * * *', jobId: 'daily-sweep-recurring' },
    ])
  })

  it('honors cronOverride and budgetCronOverride when provided', async () => {
    await registerScheduledJobs(FAKE_CONNECTION, '*/5 * * * *', '*/10 * * * *')

    expect(addedJobs('daily-sweep')).toEqual([
      { name: 'daily-sweep', pattern: '*/5 * * * *', jobId: 'daily-sweep-recurring' },
    ])
    expect(addedJobs('budget-check')).toEqual([
      { name: 'budget-check', pattern: '*/10 * * * *', jobId: 'budget-check-recurring' },
    ])
  })

  it('registers budget-check, prune-associations, and data-retention-prune singletons', async () => {
    await registerScheduledJobs(FAKE_CONNECTION)

    expect(addedJobs('budget-check')).toEqual([
      { name: 'budget-check', pattern: '0 7 * * *', jobId: 'budget-check-recurring' },
    ])
    expect(addedJobs('prune-associations')).toEqual([
      { name: 'prune-associations', pattern: '30 3 * * 0', jobId: 'prune-associations-recurring' },
    ])
    expect(addedJobs('data-retention-prune')).toEqual([
      {
        name: 'data-retention-prune',
        pattern: '0 2 * * 0',
        jobId: 'data-retention-prune-recurring',
      },
    ])
  })

  it('registers all 17 skill-execution repeatables with their documented crons and jobIds', async () => {
    await registerScheduledJobs(FAKE_CONNECTION)

    const jobs = addedJobs('skill-execution')
    expect(jobs).toHaveLength(17)

    expect(jobs).toEqual(
      expect.arrayContaining([
        { name: 'daily-connections', pattern: '10 6 * * *', jobId: 'scheduled_daily-connections' },
        { name: 'drift-monitor', pattern: '15 7 * * *', jobId: 'scheduled_drift-monitor' },
        { name: 'pipeline-health', pattern: '0 */6 * * *', jobId: 'scheduled_pipeline-health' },
        {
          name: 'daily-sweep-skill',
          pattern: '0 20 * * *',
          jobId: 'scheduled_daily-sweep-skill',
        },
        {
          name: 'memory-consolidation',
          pattern: '0 4 * * 0',
          jobId: 'scheduled_memory-consolidation',
        },
        {
          name: 'capture-reminder-morning',
          pattern: '45 6 * * 1-5',
          jobId: 'scheduled_capture-reminder-morning',
        },
        { name: 'morning-brief', pattern: '30 6 * * 1-5', jobId: 'scheduled_morning-brief' },
        {
          name: 'capture-reminder-evening',
          pattern: '0 21 * * *',
          jobId: 'scheduled_capture-reminder-evening',
        },
        { name: 'wiki-lint', pattern: '30 4 * * 0', jobId: 'scheduled_wiki-lint' },
        { name: 'wiki-synthesis', pattern: '0 6 * * *', jobId: 'scheduled_wiki-synthesis' },
        {
          name: 'monthly-reflection',
          pattern: '0 9 1 * *',
          jobId: 'scheduled_monthly-reflection',
        },
        { name: 'cost-analysis', pattern: '20 6 * * *', jobId: 'scheduled_cost-analysis' },
        {
          name: 'container-health',
          pattern: '*/15 * * * *',
          jobId: 'scheduled_container-health',
        },
        { name: 'storage-audit', pattern: '15 3 * * 0', jobId: 'scheduled_storage-audit' },
        { name: 'secret-rotation', pattern: '0 10 1 * *', jobId: 'scheduled_secret-rotation' },
        {
          name: 'capture-dedup-sweep',
          pattern: '0 4 * * 6',
          jobId: 'scheduled_capture-dedup-sweep',
        },
        { name: 'email-classify', pattern: '0 5 * * *', jobId: 'scheduled_email-classify' },
      ]),
    )
  })

  it('reconciles every queue after registration, removing an orphaned scheduler', async () => {
    // Seed prune-associations' live queue state with the freshly-registered
    // scheduler (key === its id, won't be touched) plus an orphan whose id is no
    // longer registered — a renamed job left behind. This exercises
    // reconcileRepeatableJobs() through the real registerScheduledJobs() path (#217).
    const liveEntry = jobScheduler({
      key: 'prune-associations-recurring', // key IS the registered id in v5
      name: 'prune-associations',
      pattern: '30 3 * * 0',
    })
    const orphanKey = 'prune-associations-retired' // an id nobody registers any more
    const orphanEntry = jobScheduler({
      key: orphanKey,
      name: 'prune-associations-retired',
      pattern: '0 3 * * 0',
    })
    mockSchedulersByQueue['prune-associations'] = [liveEntry, orphanEntry]

    await registerScheduledJobs(FAKE_CONNECTION)

    const pruneQueue = mockQueueInstances['prune-associations']
    expect(pruneQueue.getJobSchedulers).toHaveBeenCalledTimes(1)
    expect(pruneQueue.removeJobScheduler).toHaveBeenCalledTimes(1)
    expect(pruneQueue.removeJobScheduler).toHaveBeenCalledWith(orphanKey)
    // The live scheduler's id must NEVER be removed — the whole point of #217.
    expect(pruneQueue.removeJobScheduler).not.toHaveBeenCalledWith('prune-associations-recurring')

    // Every other queue is reconciled too (getJobSchedulers default: []).
    expect(mockQueueInstances['daily-sweep'].getJobSchedulers).toHaveBeenCalledTimes(1)
    expect(mockQueueInstances['budget-check'].getJobSchedulers).toHaveBeenCalledTimes(1)
    expect(mockQueueInstances['skill-execution'].getJobSchedulers).toHaveBeenCalledTimes(1)
    expect(mockQueueInstances['data-retention-prune'].getJobSchedulers).toHaveBeenCalledTimes(1)
    expect(mockQueueInstances['skill-execution'].removeJobScheduler).not.toHaveBeenCalled()
  })
})
