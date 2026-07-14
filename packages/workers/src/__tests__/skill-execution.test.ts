import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MockInstance } from 'vitest'

// ============================================================
// Hoisted mocks — every dispatchable skill class becomes a fake
// constructor whose instances expose a controllable `execute()`.
// vi.mock factories are hoisted above imports, so any state they
// reference must itself be created via vi.hoisted().
// ============================================================

const skillMocks = vi.hoisted(() => {
  function makeSkillMock() {
    const execute = vi.fn()
    const ctor = vi.fn().mockImplementation((opts: unknown) => ({ execute, __opts: opts }))
    return { execute, ctor }
  }
  return {
    captureReminder: makeSkillMock(),
    dailyConnections: makeSkillMock(),
    wikiIngest: makeSkillMock(),
    weeklyBrief: makeSkillMock(),
    driftMonitor: makeSkillMock(),
    dailySweep: makeSkillMock(),
    memoryConsolidation: makeSkillMock(),
    pipelineHealth: makeSkillMock(),
    morningBrief: makeSkillMock(),
    wikiLint: makeSkillMock(),
    wikiSynthesis: makeSkillMock(),
    monthlyReflection: makeSkillMock(),
    emailCompose: makeSkillMock(),
    costAnalysis: makeSkillMock(),
    containerHealth: makeSkillMock(),
    secretRotation: makeSkillMock(),
    storageAudit: makeSkillMock(),
    captureDedupSweep: makeSkillMock(),
    emailClassify: makeSkillMock(),
    refineBrief: makeSkillMock(),
    entityBrief: makeSkillMock(),
  }
})

const sharedMocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
  HotmailClient: vi.fn().mockImplementation(() => ({})),
  GmailClient: vi.fn().mockImplementation(() => ({})),
  EmailClassifier: vi.fn().mockImplementation(() => ({})),
  loadEmailRules: vi.fn().mockReturnValue({ rules: [] }),
}))

vi.mock('../skills/capture-reminder.js', () => ({ CaptureReminderSkill: skillMocks.captureReminder.ctor }))
vi.mock('../skills/daily-connections.js', () => ({ DailyConnectionsSkill: skillMocks.dailyConnections.ctor }))
vi.mock('../skills/wiki-ingest.js', () => ({ WikiIngestSkill: skillMocks.wikiIngest.ctor }))
vi.mock('../skills/weekly-brief.js', () => ({ WeeklyBriefSkill: skillMocks.weeklyBrief.ctor }))
vi.mock('../skills/drift-monitor.js', () => ({ DriftMonitorSkill: skillMocks.driftMonitor.ctor }))
vi.mock('../skills/daily-sweep-skill.js', () => ({ DailySweepSkill: skillMocks.dailySweep.ctor }))
vi.mock('../skills/memory-consolidation.js', () => ({ MemoryConsolidationSkill: skillMocks.memoryConsolidation.ctor }))
vi.mock('../skills/pipeline-health.js', () => ({ PipelineHealthSkill: skillMocks.pipelineHealth.ctor }))
vi.mock('../skills/morning-brief.js', () => ({ MorningBriefSkill: skillMocks.morningBrief.ctor }))
vi.mock('../skills/wiki-lint.js', () => ({ WikiLintSkill: skillMocks.wikiLint.ctor }))
vi.mock('../skills/wiki-synthesis.js', () => ({ WikiSynthesisSkill: skillMocks.wikiSynthesis.ctor }))
vi.mock('../skills/monthly-reflection.js', () => ({ MonthlyReflectionSkill: skillMocks.monthlyReflection.ctor }))
vi.mock('../skills/email-compose.js', () => ({ EmailComposeSkill: skillMocks.emailCompose.ctor }))
vi.mock('../skills/cost-analysis.js', () => ({ CostAnalysisSkill: skillMocks.costAnalysis.ctor }))
vi.mock('../skills/container-health.js', () => ({ ContainerHealthSkill: skillMocks.containerHealth.ctor }))
vi.mock('../skills/secret-rotation.js', () => ({ SecretRotationSkill: skillMocks.secretRotation.ctor }))
vi.mock('../skills/storage-audit.js', () => ({ StorageAuditSkill: skillMocks.storageAudit.ctor }))
vi.mock('../skills/capture-dedup-sweep.js', () => ({ CaptureDedupSweepSkill: skillMocks.captureDedupSweep.ctor }))
vi.mock('../skills/email-classify.js', () => ({ EmailClassifySkill: skillMocks.emailClassify.ctor }))
vi.mock('../skills/refine-brief.js', () => ({ RefineBriefSkill: skillMocks.refineBrief.ctor }))
vi.mock('../skills/entity-brief.js', () => ({ EntityBriefSkill: skillMocks.entityBrief.ctor }))

vi.mock('@open-brain/shared', () => ({
  logger: sharedMocks.logger,
  activity_feed: 'activity_feed_table',
  HotmailClient: sharedMocks.HotmailClient,
  GmailClient: sharedMocks.GmailClient,
  EmailClassifier: sharedMocks.EmailClassifier,
  loadEmailRules: sharedMocks.loadEmailRules,
}))

vi.mock('bullmq', () => {
  class UnrecoverableError extends Error {
    constructor(message?: string) {
      super(message)
      this.name = 'UnrecoverableError'
    }
  }
  const WorkerMock = vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  }))
  return { Worker: WorkerMock, UnrecoverableError }
})

// eslint-disable-next-line import/order
import { Worker, UnrecoverableError } from 'bullmq'
// eslint-disable-next-line import/order
import { createSkillExecutionWorker } from '../jobs/skill-execution.js'

type Processor = (job: any) => Promise<void>

// ============================================================
// Test fixtures
// ============================================================

function makeDb() {
  const values = vi.fn().mockReturnValue(Promise.resolve(undefined))
  const insert = vi.fn().mockReturnValue({ values })
  return { insert, values } as any
}

// Note: `null` (not `undefined`) is the "no wiki_agent configured" sentinel —
// an explicit `undefined` argument would trigger the default-parameter value
// instead of overriding it, per JS default-parameter semantics.
function makeConfigService(wikiAgentModel: string | null = 'test-wiki-model') {
  return {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'ai') {
        return {
          models: wikiAgentModel === null ? {} : { wiki_agent: { model: wikiAgentModel } },
        }
      }
      return {}
    }),
  }
}

function makeOpts(overrides: Record<string, unknown> = {}) {
  return {
    litellmUrl: 'http://litellm.local',
    litellmApiKey: 'key',
    promptsDir: '/prompts',
    coreApiUrl: 'http://core-api.local',
    configService: makeConfigService(),
    anthropicClient: { name: 'anthropic' } as any,
    ollamaClient: { name: 'ollama' } as any,
    wikiService: { name: 'wiki' } as any,
    llmGateway: { name: 'llmGateway' } as any,
    composioMeterRedis: { name: 'redis' } as any,
    pushover: { name: 'pushover' } as any,
    ...overrides,
  }
}

/** Builds a worker + returns { worker, processor, db, opts }. */
function build(optsOverrides: Record<string, unknown> = {}, dbOverride?: ReturnType<typeof makeDb>) {
  const connection = { host: 'localhost' } as any
  const db = dbOverride ?? makeDb()
  const opts = makeOpts(optsOverrides)
  const worker = createSkillExecutionWorker(connection, db, opts as any)
  const calls = (Worker as unknown as MockInstance).mock.calls
  const processor = calls[calls.length - 1][1] as Processor
  return { worker, processor, db, opts, connection }
}

function fakeJob(skillName: string, input: Record<string, unknown> = {}, captureId?: string) {
  return {
    id: `job-${skillName}`,
    data: { skillName, input, captureId },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ============================================================
// Worker construction / harness
// ============================================================

describe('createSkillExecutionWorker — construction', () => {
  it('constructs a BullMQ Worker named "skill-execution" with concurrency 1 and a limiter', () => {
    const { connection } = build()
    expect(Worker).toHaveBeenCalledWith(
      'skill-execution',
      expect.any(Function),
      expect.objectContaining({
        connection,
        concurrency: 1,
        limiter: { max: 1, duration: 5_000 },
      }),
    )
  })

  it('registers "completed" and "failed" listeners on the worker', () => {
    const { worker } = build()
    const onMock = (worker as any).on as MockInstance
    const events = onMock.mock.calls.map((call: any[]) => call[0])
    expect(events).toContain('completed')
    expect(events).toContain('failed')
  })

  it('logs an error when llmGateway is not configured', () => {
    build({ llmGateway: undefined })
    expect(sharedMocks.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('LLMGatewayService not configured'),
    )
  })

  it('does not log the llmGateway warning when llmGateway is configured', () => {
    build()
    expect(sharedMocks.logger.error).not.toHaveBeenCalled()
  })

  it('falls back to the default wiki-agent model when configService has no models.wiki_agent', async () => {
    const { processor, db, opts } = build({ configService: makeConfigService(null) })
    skillMocks.wikiIngest.execute.mockResolvedValueOnce({
      pagesCreated: [],
      pagesUpdated: [],
      skipped: false,
      durationMs: 1,
    })

    await processor(fakeJob('wiki-ingest', {}, 'cap-1'))

    expect(skillMocks.wikiIngest.ctor).toHaveBeenCalledWith({
      db,
      wikiService: opts.wikiService,
      anthropicClient: opts.anthropicClient,
      model: 'claude-haiku-4-5-20251001',
      promptsDir: opts.promptsDir,
      configService: opts.configService,
    })
  })
})

// ============================================================
// LLM synthesis skills
// ============================================================

describe('skill-execution — LLM synthesis skills', () => {
  it('dispatches weekly-brief with mapped input and logs completion', async () => {
    const { processor, db, opts } = build()
    skillMocks.weeklyBrief.execute.mockResolvedValueOnce({ captureCount: 3, durationMs: 10 })

    await processor(fakeJob('weekly-brief', { windowDays: 7, tokenBudget: 500, emailTo: 'a@b.com' }))

    expect(skillMocks.weeklyBrief.ctor).toHaveBeenCalledWith({ db, llmGateway: opts.llmGateway })
    expect(skillMocks.weeklyBrief.execute).toHaveBeenCalledWith({
      windowDays: 7,
      tokenBudget: 500,
      emailTo: 'a@b.com',
    })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'weekly-brief', captureCount: 3, durationMs: 10 }),
      '[skill-execution] weekly-brief complete',
    )
  })

  it('dispatches daily-connections with wikiService + llmGateway wiring', async () => {
    const { processor, db, opts } = build()
    skillMocks.dailyConnections.execute.mockResolvedValueOnce({
      captureCount: 2,
      output: { connections: [{ a: 1 }] },
      durationMs: 11,
    })

    await processor(fakeJob('daily-connections', { windowDays: 3 }))

    expect(skillMocks.dailyConnections.ctor).toHaveBeenCalledWith({
      db,
      wikiService: opts.wikiService,
      llmGateway: opts.llmGateway,
    })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'daily-connections', connectionCount: 1 }),
      '[skill-execution] daily-connections complete',
    )
  })

  it('dispatches drift-monitor and logs overall_health', async () => {
    const { processor } = build()
    skillMocks.driftMonitor.execute.mockResolvedValueOnce({
      output: { drift_items: [1, 2], overall_health: 'ok' },
      notificationSent: true,
      durationMs: 12,
    })

    await processor(fakeJob('drift-monitor', { betActivityDays: 5 }))

    expect(skillMocks.driftMonitor.execute).toHaveBeenCalled()
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'drift-monitor', driftItemCount: 2, overallHealth: 'ok' }),
      '[skill-execution] drift-monitor complete',
    )
  })

  it('dispatches daily-sweep-skill with storeCapture default false', async () => {
    const { processor } = build()
    skillMocks.dailySweep.execute.mockResolvedValueOnce({
      captureCount: 4,
      output: { headline: 'headline' },
      durationMs: 13,
    })

    await processor(fakeJob('daily-sweep-skill', {}))

    expect(skillMocks.dailySweep.execute).toHaveBeenCalledWith({ tokenBudget: undefined, storeCapture: false })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'daily-sweep-skill', headline: 'headline' }),
      '[skill-execution] daily-sweep-skill complete',
    )
  })

  it('dispatches memory-consolidation with cluster options', async () => {
    const { processor } = build()
    skillMocks.memoryConsolidation.execute.mockResolvedValueOnce({
      totalMerged: 1,
      totalSkipped: 2,
      totalErrors: 0,
      durationMs: 14,
    })

    await processor(fakeJob('memory-consolidation', { similarityThreshold: 0.9, minClusterSize: 2, maxClusters: 10 }))

    expect(skillMocks.memoryConsolidation.execute).toHaveBeenCalledWith({
      similarityThreshold: 0.9,
      minClusterSize: 2,
      maxClusters: 10,
    })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'memory-consolidation', totalMerged: 1 }),
      '[skill-execution] memory-consolidation complete',
    )
  })

  it('dispatches email-compose when instruction is present', async () => {
    const { processor, db, opts } = build()
    skillMocks.emailCompose.execute.mockResolvedValueOnce({
      draftId: 'd1',
      to: 'x@y.com',
      agentIterations: 2,
      toolCalls: 3,
      durationMs: 15,
    })

    await processor(fakeJob('email-compose', { instruction: 'reply to bob' }))

    expect(skillMocks.emailCompose.ctor).toHaveBeenCalledWith({
      db,
      anthropicClient: opts.anthropicClient,
      coreApiUrl: opts.coreApiUrl,
      configService: opts.configService,
      llmGateway: opts.llmGateway,
    })
    expect(skillMocks.emailCompose.execute).toHaveBeenCalledWith({
      instruction: 'reply to bob',
      coreApiUrl: opts.coreApiUrl,
      anthropicClient: opts.anthropicClient,
    })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'email-compose', draftId: 'd1' }),
      '[skill-execution] email-compose complete',
    )
  })

  it('rejects email-compose with UnrecoverableError when instruction is missing', async () => {
    const { processor } = build()

    await expect(processor(fakeJob('email-compose', {}))).rejects.toThrow(UnrecoverableError)
    await expect(processor(fakeJob('email-compose', {}))).rejects.toThrow(
      /email-compose requires input.instruction/,
    )
    expect(skillMocks.emailCompose.ctor).not.toHaveBeenCalled()
  })
})

// ============================================================
// Simple (BaseSkill) skills
// ============================================================

describe('skill-execution — simple skills', () => {
  it('dispatches capture-reminder-morning with mode "morning"', async () => {
    const { processor, db } = build()
    skillMocks.captureReminder.execute.mockResolvedValueOnce({ notificationSent: true, durationMs: 1 })

    await processor(fakeJob('capture-reminder-morning'))

    expect(skillMocks.captureReminder.ctor).toHaveBeenCalledWith({ db })
    expect(skillMocks.captureReminder.execute).toHaveBeenCalledWith({ mode: 'morning' })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'capture-reminder-morning', notificationSent: true }),
      '[skill-execution] capture-reminder-morning complete',
    )
  })

  it('dispatches capture-reminder-evening with mode "evening"', async () => {
    const { processor } = build()
    skillMocks.captureReminder.execute.mockResolvedValueOnce({
      notificationSent: false,
      captureCount: 5,
      durationMs: 2,
    })

    await processor(fakeJob('capture-reminder-evening'))

    expect(skillMocks.captureReminder.execute).toHaveBeenCalledWith({ mode: 'evening' })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'capture-reminder-evening', captureCount: 5 }),
      '[skill-execution] capture-reminder-evening complete',
    )
  })

  it('dispatches pipeline-health with redisConnection wired to the queue connection', async () => {
    const { processor, db, connection } = build()
    skillMocks.pipelineHealth.execute.mockResolvedValueOnce({ healthy: true, alertSent: false, durationMs: 3 })

    await processor(fakeJob('pipeline-health', { failedThreshold: 5 }))

    expect(skillMocks.pipelineHealth.ctor).toHaveBeenCalledWith({ db, redisConnection: connection })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'pipeline-health', healthy: true }),
      '[skill-execution] pipeline-health complete',
    )
  })

  it('dispatches container-health with consecutiveFailureThreshold', async () => {
    const { processor } = build()
    skillMocks.containerHealth.execute.mockResolvedValueOnce({
      healthyCount: 10,
      unhealthyCount: 1,
      alertsSent: 1,
      durationMs: 4,
    })

    await processor(fakeJob('container-health', { consecutiveFailureThreshold: 3 }))

    expect(skillMocks.containerHealth.execute).toHaveBeenCalledWith({ consecutiveFailureThreshold: 3 })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'container-health', unhealthyCount: 1 }),
      '[skill-execution] container-health complete',
    )
  })

  it('dispatches secret-rotation with maxAgeDays + bwsBinary', async () => {
    const { processor } = build()
    skillMocks.secretRotation.execute.mockResolvedValueOnce({
      totalSecrets: 8,
      staleSecrets: ['a', 'b'],
      alertSent: true,
      durationMs: 5,
    })

    await processor(fakeJob('secret-rotation', { maxAgeDays: 90, bwsBinary: '/usr/bin/bws' }))

    expect(skillMocks.secretRotation.execute).toHaveBeenCalledWith({ maxAgeDays: 90, bwsBinary: '/usr/bin/bws' })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'secret-rotation', staleCount: 2 }),
      '[skill-execution] secret-rotation complete',
    )
  })

  it('dispatches capture-dedup-sweep with similarityThreshold + maxPairs', async () => {
    const { processor } = build()
    skillMocks.captureDedupSweep.execute.mockResolvedValueOnce({
      pairsFound: 6,
      notificationSent: true,
      durationMs: 6,
    })

    await processor(fakeJob('capture-dedup-sweep', { similarityThreshold: 0.95, maxPairs: 50 }))

    expect(skillMocks.captureDedupSweep.execute).toHaveBeenCalledWith({ similarityThreshold: 0.95, maxPairs: 50 })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'capture-dedup-sweep', pairsFound: 6 }),
      '[skill-execution] capture-dedup-sweep complete',
    )
  })

  it('dispatches cost-analysis with wikiService wired', async () => {
    const { processor, db, opts } = build()
    skillMocks.costAnalysis.execute.mockResolvedValueOnce({
      type: 'daily',
      summary: { totalCost: 1.23 },
      alertSent: false,
      wikiPageWritten: true,
      durationMs: 7,
    })

    await processor(fakeJob('cost-analysis', { dailyAlertThreshold: 10 }))

    expect(skillMocks.costAnalysis.ctor).toHaveBeenCalledWith({ db, wikiService: opts.wikiService })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'cost-analysis', totalCost: 1.23 }),
      '[skill-execution] cost-analysis complete',
    )
  })

  it('dispatches storage-audit with an empty input object', async () => {
    const { processor, db, opts } = build()
    skillMocks.storageAudit.execute.mockResolvedValueOnce({
      metrics: { postgres: { dbSizeHuman: '1 GB' }, redis: { usedMemoryHuman: '10 MB' } },
      wikiPageWritten: false,
      durationMs: 8,
    })

    await processor(fakeJob('storage-audit'))

    expect(skillMocks.storageAudit.ctor).toHaveBeenCalledWith({ db, wikiService: opts.wikiService })
    expect(skillMocks.storageAudit.execute).toHaveBeenCalledWith({})
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'storage-audit', dbSize: '1 GB', redisMemory: '10 MB' }),
      '[skill-execution] storage-audit complete',
    )
  })
})

// ============================================================
// Agent & specialized skills
// ============================================================

describe('skill-execution — agent & specialized skills', () => {
  it('dispatches wiki-lint when wikiService is configured', async () => {
    const { processor, db, opts } = build()
    skillMocks.wikiLint.execute.mockResolvedValueOnce({
      pagesScanned: 20,
      issuesFound: 1,
      notificationSent: true,
      durationMs: 9,
    })

    await processor(fakeJob('wiki-lint'))

    expect(skillMocks.wikiLint.ctor).toHaveBeenCalledWith({
      db,
      wikiService: opts.wikiService,
      anthropicClient: opts.anthropicClient,
      promptsDir: opts.promptsDir,
      configService: opts.configService,
    })
    expect(skillMocks.wikiLint.execute).toHaveBeenCalledWith(undefined)
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'wiki-lint', pagesScanned: 20 }),
      '[skill-execution] wiki-lint complete',
    )
  })

  it('rejects wiki-lint with UnrecoverableError when wikiService is missing', async () => {
    const { processor } = build({ wikiService: undefined })

    await expect(processor(fakeJob('wiki-lint'))).rejects.toThrow(UnrecoverableError)
    await expect(processor(fakeJob('wiki-lint'))).rejects.toThrow(/wiki-lint requires wikiService/)
    expect(skillMocks.wikiLint.ctor).not.toHaveBeenCalled()
  })

  it('dispatches wiki-synthesis with redisConnection + lookbackHours', async () => {
    const { processor, connection } = build()
    skillMocks.wikiSynthesis.execute.mockResolvedValueOnce({
      capturesChecked: 30,
      capturesQueued: 2,
      notificationSent: false,
      durationMs: 10,
    })

    await processor(fakeJob('wiki-synthesis', { lookbackHours: 24 }))

    expect(skillMocks.wikiSynthesis.execute).toHaveBeenCalledWith({ redisConnection: connection, lookbackHours: 24 })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'wiki-synthesis', capturesQueued: 2 }),
      '[skill-execution] wiki-synthesis complete',
    )
  })

  it('dispatches monthly-reflection with agent wiring', async () => {
    const { processor, db, opts } = build()
    skillMocks.monthlyReflection.execute.mockResolvedValueOnce({
      captureCount: 40,
      output: { headline: 'monthly headline' },
      agentIterations: 3,
      toolCalls: 4,
      emailSent: true,
      wikiPageWritten: true,
      durationMs: 11,
    })

    await processor(fakeJob('monthly-reflection'))

    expect(skillMocks.monthlyReflection.ctor).toHaveBeenCalledWith({
      db,
      anthropicClient: opts.anthropicClient,
      wikiService: opts.wikiService,
      promptsDir: opts.promptsDir,
      configService: opts.configService,
    })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'monthly-reflection', headline: 'monthly headline' }),
      '[skill-execution] monthly-reflection complete',
    )
  })

  it('dispatches wiki-ingest using job.data.captureId when present', async () => {
    const { processor, db, opts } = build()
    skillMocks.wikiIngest.execute.mockResolvedValueOnce({
      pagesCreated: ['p1'],
      pagesUpdated: [],
      skipped: false,
      durationMs: 12,
    })

    await processor(fakeJob('wiki-ingest', {}, 'capture-123'))

    expect(skillMocks.wikiIngest.ctor).toHaveBeenCalledWith({
      db,
      wikiService: opts.wikiService,
      anthropicClient: opts.anthropicClient,
      model: 'test-wiki-model',
      promptsDir: opts.promptsDir,
      configService: opts.configService,
    })
    expect(skillMocks.wikiIngest.execute).toHaveBeenCalledWith('capture-123')
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'wiki-ingest', captureId: 'capture-123', pagesCreated: 1 }),
      '[skill-execution] wiki-ingest complete',
    )
  })

  it('rejects wiki-ingest with UnrecoverableError when captureId is missing', async () => {
    const { processor } = build()

    await expect(processor(fakeJob('wiki-ingest', {}))).rejects.toThrow(UnrecoverableError)
    await expect(processor(fakeJob('wiki-ingest', {}))).rejects.toThrow(/wiki-ingest requires captureId/)
    expect(skillMocks.wikiIngest.ctor).not.toHaveBeenCalled()
  })

  it('rejects wiki-ingest with UnrecoverableError when wikiService is missing', async () => {
    const { processor } = build({ wikiService: undefined })

    await expect(processor(fakeJob('wiki-ingest', {}, 'capture-1'))).rejects.toThrow(UnrecoverableError)
    await expect(processor(fakeJob('wiki-ingest', {}, 'capture-1'))).rejects.toThrow(
      /wiki-ingest requires wikiService/,
    )
    expect(skillMocks.wikiIngest.ctor).not.toHaveBeenCalled()
  })
})

// ============================================================
// Brief generation / refinement skills
// ============================================================

describe('skill-execution — brief skills', () => {
  it('dispatches entity-brief when entityId is present', async () => {
    const { processor, db, opts } = build()
    skillMocks.entityBrief.execute.mockResolvedValueOnce({
      entityId: 'e1',
      entityName: 'Bob',
      captureCount: 5,
      briefId: 'b1',
      generated: true,
      durationMs: 13,
    })

    await processor(fakeJob('entity-brief', { entityId: 'e1', entityName: 'Bob', entityType: 'person' }))

    expect(skillMocks.entityBrief.ctor).toHaveBeenCalledWith({ db, llmGateway: opts.llmGateway })
    expect(skillMocks.entityBrief.execute).toHaveBeenCalledWith({
      entityId: 'e1',
      entityName: 'Bob',
      entityType: 'person',
    })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'entity-brief', briefId: 'b1' }),
      '[skill-execution] entity-brief complete',
    )
  })

  it('rejects entity-brief with UnrecoverableError when entityId is missing', async () => {
    const { processor } = build()

    await expect(processor(fakeJob('entity-brief', {}))).rejects.toThrow(UnrecoverableError)
    await expect(processor(fakeJob('entity-brief', {}))).rejects.toThrow(/entity-brief requires input.entityId/)
    expect(skillMocks.entityBrief.ctor).not.toHaveBeenCalled()
  })

  it('dispatches refine-brief when source_brief_id and option are present', async () => {
    const { processor, db, opts } = build()
    skillMocks.refineBrief.execute.mockResolvedValueOnce({
      sourceBriefId: 'sb1',
      newBriefId: 'nb1',
      option: 'shorter',
      refined: true,
      outputLength: 100,
      durationMs: 14,
    })

    await processor(fakeJob('refine-brief', { source_brief_id: 'sb1', option: 'shorter' }))

    expect(skillMocks.refineBrief.ctor).toHaveBeenCalledWith({ db, llmGateway: opts.llmGateway })
    expect(skillMocks.refineBrief.execute).toHaveBeenCalledWith({ source_brief_id: 'sb1', option: 'shorter' })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'refine-brief', newBriefId: 'nb1' }),
      '[skill-execution] refine-brief complete',
    )
  })

  it('rejects refine-brief with UnrecoverableError when source_brief_id/option are missing', async () => {
    const { processor } = build()

    await expect(processor(fakeJob('refine-brief', {}))).rejects.toThrow(UnrecoverableError)
    await expect(processor(fakeJob('refine-brief', {}))).rejects.toThrow(
      /refine-brief requires input.source_brief_id and input.option/,
    )
    expect(skillMocks.refineBrief.ctor).not.toHaveBeenCalled()
  })
})

// ============================================================
// Email pipeline skill
// ============================================================

describe('skill-execution — email-classify', () => {
  it('constructs Hotmail/Gmail/EmailClassifier clients and dispatches EmailClassifySkill', async () => {
    const { processor, db, opts } = build()
    skillMocks.emailClassify.execute.mockResolvedValueOnce({
      hotmail: { classified: 3 },
      gmail: { classified: 2 },
      corrections: 1,
      summaryPosted: true,
      durationMs: 15,
    })

    await processor(fakeJob('email-classify', { providers: ['hotmail', 'gmail'], sinceHours: 24, dryRun: false }))

    expect(sharedMocks.loadEmailRules).toHaveBeenCalled()
    expect(sharedMocks.HotmailClient).toHaveBeenCalledWith({ db })
    expect(sharedMocks.GmailClient).toHaveBeenCalledWith({ db })
    expect(sharedMocks.EmailClassifier).toHaveBeenCalledWith({ rules: [] }, opts.llmGateway)
    expect(skillMocks.emailClassify.execute).toHaveBeenCalledWith({
      providers: ['hotmail', 'gmail'],
      sinceHours: 24,
      dryRun: false,
    })
    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'email-classify', hotmailClassified: 3, gmailClassified: 2 }),
      '[skill-execution] email-classify complete',
    )
  })

  it('passes null llmGateway to EmailClassifier when llmGateway is not configured', async () => {
    const { processor } = build({ llmGateway: undefined })
    skillMocks.emailClassify.execute.mockResolvedValueOnce({
      hotmail: { classified: 0 },
      gmail: { classified: 0 },
      corrections: 0,
      summaryPosted: false,
      durationMs: 16,
    })

    await processor(fakeJob('email-classify', {}))

    expect(sharedMocks.EmailClassifier).toHaveBeenCalledWith({ rules: [] }, null)
  })
})

// ============================================================
// morning-brief — SLACK_CHANNEL env var precedence (recently changed
// to pass `undefined` when unset, rather than a baked-in default).
// ============================================================

describe('skill-execution — morning-brief', () => {
  const ORIGINAL_ENV = process.env.MORNING_BRIEF_SLACK_CHANNEL

  it('passes the configured MORNING_BRIEF_SLACK_CHANNEL through to MorningBriefSkill', async () => {
    process.env.MORNING_BRIEF_SLACK_CHANNEL = 'C123'
    try {
      const { processor, db, opts } = build()
      skillMocks.morningBrief.execute.mockResolvedValueOnce({
        yesterdayThread: [1],
        openLoops: [1, 2],
        people: [1, 2, 3],
        notificationSent: true,
        slackSent: true,
        durationMs: 17,
      })

      await processor(fakeJob('morning-brief'))

      expect(skillMocks.morningBrief.ctor).toHaveBeenCalledWith({
        db,
        slackChannelId: 'C123',
        composioRedis: opts.composioMeterRedis,
        composioPushover: opts.pushover,
      })
      expect(skillMocks.morningBrief.execute).toHaveBeenCalledWith({})
      expect(sharedMocks.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ skillName: 'morning-brief', thread: 1, loops: 2, people: 3, slackSent: true }),
        '[skill-execution] morning-brief complete',
      )
    } finally {
      if (ORIGINAL_ENV === undefined) delete process.env.MORNING_BRIEF_SLACK_CHANNEL
      else process.env.MORNING_BRIEF_SLACK_CHANNEL = ORIGINAL_ENV
    }
  })

  it('passes undefined slackChannelId when MORNING_BRIEF_SLACK_CHANNEL is unset', async () => {
    delete process.env.MORNING_BRIEF_SLACK_CHANNEL
    try {
      const { processor, db, opts } = build()
      skillMocks.morningBrief.execute.mockResolvedValueOnce({
        yesterdayThread: [],
        openLoops: [],
        people: [],
        notificationSent: false,
        slackSent: false,
        durationMs: 18,
      })

      await processor(fakeJob('morning-brief'))

      expect(skillMocks.morningBrief.ctor).toHaveBeenCalledWith({
        db,
        slackChannelId: undefined,
        composioRedis: opts.composioMeterRedis,
        composioPushover: opts.pushover,
      })
    } finally {
      if (ORIGINAL_ENV === undefined) delete process.env.MORNING_BRIEF_SLACK_CHANNEL
      else process.env.MORNING_BRIEF_SLACK_CHANNEL = ORIGINAL_ENV
    }
  })
})

// ============================================================
// Unknown skill dispatch
// ============================================================

describe('skill-execution — unknown skill', () => {
  it('throws UnrecoverableError naming the unrecognised skill', async () => {
    const { processor } = build()

    await expect(processor(fakeJob('not-a-real-skill'))).rejects.toThrow(UnrecoverableError)
    await expect(processor(fakeJob('not-a-real-skill'))).rejects.toThrow(
      /unknown skill: not-a-real-skill/,
    )
  })
})

// ============================================================
// worker.on('completed' | 'failed') event handlers
// ============================================================

describe('skill-execution — worker lifecycle handlers', () => {
  it('"completed" handler logs and fire-and-forgets an activity_feed insert', async () => {
    const { worker, db } = build()
    const onMock = (worker as any).on as MockInstance
    const completedHandler = onMock.mock.calls.find((call: any[]) => call[0] === 'completed')![1] as (
      job: any,
    ) => void

    completedHandler({ id: 'job-1', data: { skillName: 'weekly-brief' } })

    expect(sharedMocks.logger.info).toHaveBeenCalledWith(
      { skillName: 'weekly-brief', jobId: 'job-1' },
      '[skill-execution] job completed',
    )
    expect(db.insert).toHaveBeenCalledWith('activity_feed_table')
    expect(db.values).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'skill',
        subtype: 'completed',
        summary: 'Skill "weekly-brief" completed',
      }),
    )
  })

  it('"completed" handler swallows an activity_feed insert failure via .catch', async () => {
    const db = makeDb()
    db.values.mockReturnValueOnce(Promise.reject(new Error('insert failed')))
    const { worker } = build({}, db)
    const onMock = (worker as any).on as MockInstance
    const completedHandler = onMock.mock.calls.find((call: any[]) => call[0] === 'completed')![1] as (
      job: any,
    ) => void

    completedHandler({ id: 'job-2', data: { skillName: 'daily-sweep-skill' } })
    // allow the rejected promise's .catch() microtask to run
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sharedMocks.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'daily-sweep-skill' }),
      'activity_feed insert failed for skill completion',
    )
  })

  it('"failed" handler logs the error with job context when job is defined', () => {
    const { worker } = build()
    const onMock = (worker as any).on as MockInstance
    const failedHandler = onMock.mock.calls.find((call: any[]) => call[0] === 'failed')![1] as (
      job: any,
      err: Error,
    ) => void

    const err = new Error('boom')
    failedHandler({ id: 'job-3', data: { skillName: 'wiki-lint' } }, err)

    expect(sharedMocks.logger.error).toHaveBeenCalledWith(
      { skillName: 'wiki-lint', jobId: 'job-3', err },
      '[skill-execution] job failed',
    )
  })

  it('"failed" handler tolerates an undefined job', () => {
    const { worker } = build()
    const onMock = (worker as any).on as MockInstance
    const failedHandler = onMock.mock.calls.find((call: any[]) => call[0] === 'failed')![1] as (
      job: any,
      err: Error,
    ) => void

    const err = new Error('boom')
    failedHandler(undefined, err)

    expect(sharedMocks.logger.error).toHaveBeenCalledWith(
      { skillName: undefined, jobId: undefined, err },
      '[skill-execution] job failed',
    )
  })
})
