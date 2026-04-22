import { Worker, UnrecoverableError } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type OpenAI from 'openai'
import type { Redis } from 'ioredis'
import type { Database, ConfigService, LLMGatewayService, PushoverService } from '@open-brain/shared'
import { logger, activity_feed } from '@open-brain/shared'
import type { SkillExecutionJobData } from '../queues/skill-execution.js'
import type Anthropic from '@anthropic-ai/sdk'
import type { WikiGitService } from '@open-brain/shared'
import type { BaseResult } from '../skills/types.js'
import type { BaseSkill } from '../skills/base-skill.js'

// Skill class imports — all 24 dispatchable skills
import { CaptureReminderSkill } from '../skills/capture-reminder.js'
import { DailyConnectionsSkill } from '../skills/daily-connections.js'
import { WikiIngestSkill } from '../skills/wiki-ingest.js'
import { WeeklyBriefSkill } from '../skills/weekly-brief.js'
import { DriftMonitorSkill } from '../skills/drift-monitor.js'
import { DailySweepSkill } from '../skills/daily-sweep-skill.js'
import { MemoryConsolidationSkill } from '../skills/memory-consolidation.js'
import { PipelineHealthSkill } from '../skills/pipeline-health.js'
import { MorningBriefSkill } from '../skills/morning-brief.js'
import { WikiLintSkill } from '../skills/wiki-lint.js'
import { WikiSynthesisSkill } from '../skills/wiki-synthesis.js'
import { MonthlyReflectionSkill } from '../skills/monthly-reflection.js'
import { EmailComposeSkill } from '../skills/email-compose.js'
import { CostAnalysisSkill } from '../skills/cost-analysis.js'
import { ContainerHealthSkill } from '../skills/container-health.js'
import { SecretRotationSkill } from '../skills/secret-rotation.js'
import { StorageAuditSkill } from '../skills/storage-audit.js'
import { CaptureDedupSweepSkill } from '../skills/capture-dedup-sweep.js'
import { EmailClassifySkill } from '../skills/email-classify.js'
import { RefineBriefSkill } from '../skills/refine-brief.js'
import { EntityBriefSkill } from '../skills/entity-brief.js'
import { HotmailClient, GmailClient, EmailClassifier, loadEmailRules } from '@open-brain/shared'
import path from 'node:path'

/**
 * Instantiate a BaseSkill subclass and execute it.
 *
 * All 23 dispatchable skills use this helper. Each skill class takes
 * a typed opts object in its constructor, and the input is passed
 * to `execute()`.
 *
 * @param SkillClass  Constructor that takes a single `opts` argument
 * @param opts        Constructor options (db, pushover, etc.)
 * @param input       Skill-specific input passed to `execute()`
 */
async function runSkill<TOpts, TInput, TResult extends BaseResult>(
  SkillClass: new (opts: TOpts) => BaseSkill<TInput, TResult>,
  opts: TOpts,
  input: TInput,
): Promise<TResult> {
  const skill = new SkillClass(opts)
  return skill.execute(input)
}

/**
 * BullMQ worker that consumes the `skill-execution` queue and dispatches
 * to the appropriate skill implementation based on `job.data.skillName`.
 *
 * Each skill is responsible for its own error handling, logging to
 * skills_log, and delivery (email/Pushover). This worker handles
 * BullMQ lifecycle concerns: concurrency, retries, and fatal errors.
 *
 * Adding a new skill:
 *  1. Implement the skill in src/skills/<skill-name>.ts
 *  2. Import the skill class at the top of this file
 *  3. Add a case here in the switch statement
 *  4. Register the skill name in core-api/src/routes/skills.ts KNOWN_SKILLS
 */
export function createSkillExecutionWorker(
  connection: ConnectionOptions,
  db: Database,
  opts: {
    litellmUrl: string
    litellmApiKey: string
    promptsDir: string
    coreApiUrl: string
    configService: ConfigService
    anthropicClient?: Anthropic
    ollamaClient?: OpenAI
    wikiService?: WikiGitService
    llmGateway?: LLMGatewayService
    /** Optional Redis client for Composio monthly quota metering (morning-brief). */
    composioMeterRedis?: Redis
    /** Optional Pushover service for Composio quota alerts (morning-brief). */
    pushover?: PushoverService
  },
): Worker {
  const aiConfig = opts.configService.get('ai')
  const wikiAgentModel: string = aiConfig.models.wiki_agent?.model ?? 'claude-haiku-4-5-20251001'

  if (!opts.llmGateway) {
    logger.error('[skill-execution] LLMGatewayService not configured — LLM skills will fail at runtime')
  }

  const worker = new Worker<SkillExecutionJobData>(
    'skill-execution',
    async (job) => {
      const { skillName, input } = job.data

      logger.info({ skillName, jobId: job.id }, '[skill-execution] job received')

      switch (skillName) {
        // ── LLM Synthesis Skills (LLMSkill subclasses) ──────────

        case 'weekly-brief': {
          const result = await runSkill(
            WeeklyBriefSkill,
            { db, llmGateway: opts.llmGateway },
            {
              windowDays: typeof input?.windowDays === 'number' ? input.windowDays : undefined,
              tokenBudget: typeof input?.tokenBudget === 'number' ? input.tokenBudget : undefined,
              emailTo: typeof input?.emailTo === 'string' ? input.emailTo : undefined,
            },
          )
          logger.info(
            { skillName, captureCount: result.captureCount, durationMs: result.durationMs },
            '[skill-execution] weekly-brief complete',
          )
          break
        }

        case 'daily-connections': {
          const result = await runSkill(
            DailyConnectionsSkill,
            { db, wikiService: opts.wikiService, llmGateway: opts.llmGateway },
            {
              windowDays: typeof input?.windowDays === 'number' ? input.windowDays : undefined,
              tokenBudget: typeof input?.tokenBudget === 'number' ? input.tokenBudget : undefined,
            },
          )
          logger.info(
            { skillName, captureCount: result.captureCount, connectionCount: result.output.connections.length, durationMs: result.durationMs },
            '[skill-execution] daily-connections complete',
          )
          break
        }

        case 'drift-monitor': {
          const result = await runSkill(
            DriftMonitorSkill,
            { db, wikiService: opts.wikiService, llmGateway: opts.llmGateway },
            {
              betActivityDays: typeof input?.betActivityDays === 'number' ? input.betActivityDays : undefined,
              commitmentDays: typeof input?.commitmentDays === 'number' ? input.commitmentDays : undefined,
              entityWindowDays: typeof input?.entityWindowDays === 'number' ? input.entityWindowDays : undefined,
            },
          )
          logger.info(
            { skillName, driftItemCount: result.output.drift_items.length, overallHealth: result.output.overall_health, notificationSent: result.notificationSent, durationMs: result.durationMs },
            '[skill-execution] drift-monitor complete',
          )
          break
        }

        case 'daily-sweep-skill': {
          const result = await runSkill(
            DailySweepSkill,
            { db, llmGateway: opts.llmGateway },
            {
              tokenBudget: typeof input?.tokenBudget === 'number' ? input.tokenBudget : undefined,
              storeCapture: typeof input?.storeCapture === 'boolean' ? input.storeCapture : false,
            },
          )
          logger.info(
            { skillName, captureCount: result.captureCount, headline: result.output.headline, durationMs: result.durationMs },
            '[skill-execution] daily-sweep-skill complete',
          )
          break
        }

        case 'memory-consolidation': {
          const result = await runSkill(
            MemoryConsolidationSkill,
            { db, llmGateway: opts.llmGateway },
            {
              similarityThreshold: typeof input?.similarityThreshold === 'number' ? input.similarityThreshold : undefined,
              minClusterSize: typeof input?.minClusterSize === 'number' ? input.minClusterSize : undefined,
              maxClusters: typeof input?.maxClusters === 'number' ? input.maxClusters : undefined,
            },
          )
          logger.info(
            { skillName, totalMerged: result.totalMerged, totalSkipped: result.totalSkipped, totalErrors: result.totalErrors, durationMs: result.durationMs },
            '[skill-execution] memory-consolidation complete',
          )
          break
        }

        case 'email-compose': {
          const instruction = typeof input?.instruction === 'string' ? input.instruction : ''
          if (!instruction) {
            throw new UnrecoverableError('[skill-execution] email-compose requires input.instruction')
          }
          const result = await runSkill(
            EmailComposeSkill,
            {
              db,
              anthropicClient: opts.anthropicClient,
              coreApiUrl: opts.coreApiUrl,
              configService: opts.configService,
              llmGateway: opts.llmGateway,
            },
            { instruction, coreApiUrl: opts.coreApiUrl, anthropicClient: opts.anthropicClient },
          )
          logger.info(
            {
              skillName,
              draftId: result.draftId,
              to: result.to,
              iterations: result.agentIterations,
              toolCalls: result.toolCalls,
              durationMs: result.durationMs,
            },
            '[skill-execution] email-compose complete',
          )
          break
        }

        // ── Simple Skills (BaseSkill subclasses) ────────────────

        case 'capture-reminder-morning': {
          const result = await runSkill(CaptureReminderSkill, { db }, { mode: 'morning' as const })
          logger.info(
            { skillName, notificationSent: result.notificationSent, durationMs: result.durationMs },
            '[skill-execution] capture-reminder-morning complete',
          )
          break
        }

        case 'capture-reminder-evening': {
          const result = await runSkill(CaptureReminderSkill, { db }, { mode: 'evening' as const })
          logger.info(
            { skillName, notificationSent: result.notificationSent, captureCount: result.captureCount, durationMs: result.durationMs },
            '[skill-execution] capture-reminder-evening complete',
          )
          break
        }

        case 'pipeline-health': {
          const result = await runSkill(
            PipelineHealthSkill,
            { db, redisConnection: connection },
            {
              failureLookbackMinutes: typeof input?.failureLookbackMinutes === 'number' ? input.failureLookbackMinutes : undefined,
              failedThreshold: typeof input?.failedThreshold === 'number' ? input.failedThreshold : undefined,
              waitingThreshold: typeof input?.waitingThreshold === 'number' ? input.waitingThreshold : undefined,
            },
          )
          logger.info(
            { skillName, healthy: result.healthy, alertSent: result.alertSent, durationMs: result.durationMs },
            '[skill-execution] pipeline-health complete',
          )
          break
        }

        case 'morning-brief': {
          const result = await runSkill(MorningBriefSkill, {
            db,
            slackChannelId: process.env.MORNING_BRIEF_SLACK_CHANNEL ?? 'D0AR39RNG4E',
            composioRedis: opts.composioMeterRedis,
            composioPushover: opts.pushover,
          }, {})
          logger.info(
            { skillName, thread: result.yesterdayThread.length, loops: result.openLoops.length, people: result.people.length, notificationSent: result.notificationSent, slackSent: result.slackSent, durationMs: result.durationMs },
            '[skill-execution] morning-brief complete',
          )
          break
        }

        case 'container-health': {
          const result = await runSkill(ContainerHealthSkill, { db }, {
            consecutiveFailureThreshold: typeof input?.consecutiveFailureThreshold === 'number' ? input.consecutiveFailureThreshold : undefined,
          })
          logger.info(
            {
              skillName,
              healthyCount: result.healthyCount,
              unhealthyCount: result.unhealthyCount,
              alertsSent: result.alertsSent,
              durationMs: result.durationMs,
            },
            '[skill-execution] container-health complete',
          )
          break
        }

        case 'secret-rotation': {
          const result = await runSkill(SecretRotationSkill, { db }, {
            maxAgeDays: typeof input?.maxAgeDays === 'number' ? input.maxAgeDays : undefined,
            bwsBinary: typeof input?.bwsBinary === 'string' ? input.bwsBinary : undefined,
          })
          logger.info(
            {
              skillName,
              totalSecrets: result.totalSecrets,
              staleCount: result.staleSecrets.length,
              alertSent: result.alertSent,
              durationMs: result.durationMs,
            },
            '[skill-execution] secret-rotation complete',
          )
          break
        }

        case 'capture-dedup-sweep': {
          const result = await runSkill(CaptureDedupSweepSkill, { db }, {
            similarityThreshold: typeof input?.similarityThreshold === 'number' ? input.similarityThreshold : undefined,
            maxPairs: typeof input?.maxPairs === 'number' ? input.maxPairs : undefined,
          })
          logger.info(
            {
              skillName,
              pairsFound: result.pairsFound,
              notificationSent: result.notificationSent,
              durationMs: result.durationMs,
            },
            '[skill-execution] capture-dedup-sweep complete',
          )
          break
        }

        case 'cost-analysis': {
          const result = await runSkill(CostAnalysisSkill, { db, wikiService: opts.wikiService }, {
            dailyAlertThreshold: typeof input?.dailyAlertThreshold === 'number' ? input.dailyAlertThreshold : undefined,
          })
          logger.info(
            {
              skillName,
              type: result.type,
              totalCost: result.summary.totalCost,
              alertSent: result.alertSent,
              wikiPageWritten: result.wikiPageWritten,
              durationMs: result.durationMs,
            },
            '[skill-execution] cost-analysis complete',
          )
          break
        }

        case 'storage-audit': {
          const result = await runSkill(StorageAuditSkill, { db, wikiService: opts.wikiService }, {})
          logger.info(
            {
              skillName,
              dbSize: result.metrics.postgres.dbSizeHuman,
              redisMemory: result.metrics.redis.usedMemoryHuman,
              wikiPageWritten: result.wikiPageWritten,
              durationMs: result.durationMs,
            },
            '[skill-execution] storage-audit complete',
          )
          break
        }

        // ── Agent & Specialized Skills ──────────────────────────

        case 'wiki-lint': {
          if (!opts.wikiService) {
            throw new UnrecoverableError('[skill-execution] wiki-lint requires wikiService — WikiGitService not configured')
          }
          const result = await runSkill(
            WikiLintSkill,
            {
              db,
              wikiService: opts.wikiService,
              anthropicClient: opts.anthropicClient,
              promptsDir: opts.promptsDir,
              configService: opts.configService,
            },
            undefined as void,
          )
          logger.info(
            {
              skillName,
              pagesScanned: result.pagesScanned,
              issuesFound: result.issuesFound,
              notificationSent: result.notificationSent,
              durationMs: result.durationMs,
            },
            '[skill-execution] wiki-lint complete',
          )
          break
        }

        case 'wiki-synthesis': {
          const result = await runSkill(WikiSynthesisSkill, { db }, {
            redisConnection: connection,
            lookbackHours: typeof input?.lookbackHours === 'number' ? input.lookbackHours : undefined,
          })
          logger.info(
            {
              skillName,
              capturesChecked: result.capturesChecked,
              capturesQueued: result.capturesQueued,
              notificationSent: result.notificationSent,
              durationMs: result.durationMs,
            },
            '[skill-execution] wiki-synthesis complete',
          )
          break
        }

        case 'monthly-reflection': {
          const result = await runSkill(
            MonthlyReflectionSkill,
            {
              db,
              anthropicClient: opts.anthropicClient,
              wikiService: opts.wikiService,
              promptsDir: opts.promptsDir,
              configService: opts.configService,
            },
            {},
          )
          logger.info(
            {
              skillName,
              captureCount: result.captureCount,
              headline: result.output.headline,
              iterations: result.agentIterations,
              toolCalls: result.toolCalls,
              emailSent: result.emailSent,
              wikiPageWritten: result.wikiPageWritten,
              durationMs: result.durationMs,
            },
            '[skill-execution] monthly-reflection complete',
          )
          break
        }

        case 'wiki-ingest': {
          const captureId = job.data.captureId ?? (typeof input?.captureId === 'string' ? input.captureId : undefined)
          if (!captureId) {
            throw new UnrecoverableError('[skill-execution] wiki-ingest requires captureId')
          }
          if (!opts.wikiService) {
            throw new UnrecoverableError('[skill-execution] wiki-ingest requires wikiService — WikiGitService not configured')
          }
          const result = await runSkill(
            WikiIngestSkill,
            {
              db,
              wikiService: opts.wikiService,
              anthropicClient: opts.anthropicClient,
              model: wikiAgentModel,
              promptsDir: opts.promptsDir,
              configService: opts.configService,
            },
            captureId,
          )
          logger.info(
            {
              skillName,
              captureId,
              pagesCreated: result.pagesCreated.length,
              pagesUpdated: result.pagesUpdated.length,
              skipped: result.skipped,
              durationMs: result.durationMs,
            },
            '[skill-execution] wiki-ingest complete',
          )
          break
        }

        // ── Brief Generation Skills ─────────────────────────────

        case 'entity-brief': {
          const entityId = typeof input?.entityId === 'string' ? input.entityId : ''
          if (!entityId) {
            throw new UnrecoverableError('[skill-execution] entity-brief requires input.entityId')
          }
          const result = await runSkill(
            EntityBriefSkill,
            { db, llmGateway: opts.llmGateway },
            {
              entityId,
              entityName: typeof input?.entityName === 'string' ? input.entityName : undefined,
              entityType: typeof input?.entityType === 'string' ? input.entityType : undefined,
            },
          )
          logger.info(
            {
              skillName,
              entityId: result.entityId,
              entityName: result.entityName,
              captureCount: result.captureCount,
              briefId: result.briefId,
              generated: result.generated,
              durationMs: result.durationMs,
            },
            '[skill-execution] entity-brief complete',
          )
          break
        }

        // ── Brief Refinement Skills ─────────────────────────────

        case 'refine-brief': {
          const source_brief_id = typeof input?.source_brief_id === 'string' ? input.source_brief_id : ''
          const option = typeof input?.option === 'string' ? input.option : ''
          if (!source_brief_id || !option) {
            throw new UnrecoverableError('[skill-execution] refine-brief requires input.source_brief_id and input.option')
          }
          const result = await runSkill(
            RefineBriefSkill,
            { db, llmGateway: opts.llmGateway },
            { source_brief_id, option },
          )
          logger.info(
            {
              skillName,
              sourceBriefId: result.sourceBriefId,
              newBriefId: result.newBriefId,
              option: result.option,
              refined: result.refined,
              outputLength: result.outputLength,
              durationMs: result.durationMs,
            },
            '[skill-execution] refine-brief complete',
          )
          break
        }

        // ── Email Pipeline Skills ───────────────────────────────

        case 'email-classify': {
          const configDir = process.env.CONFIG_DIR ?? '/app/config'
          const rulesPath = path.join(configDir, 'email-categories.yaml')
          const rules = loadEmailRules(rulesPath)

          const hotmailClient = new HotmailClient({ db })
          const gmailClient = new GmailClient({ db })
          const classifier = new EmailClassifier(rules, opts.llmGateway ?? null)

          const result = await runSkill(
            EmailClassifySkill,
            {
              db,
              hotmailClient,
              gmailClient,
              classifier,
              llmGateway: opts.llmGateway ?? null,
              rules,
              coreApiUrl: opts.coreApiUrl,
            },
            {
              providers: Array.isArray(input?.providers) ? input.providers : undefined,
              sinceHours: typeof input?.sinceHours === 'number' ? input.sinceHours : undefined,
              dryRun: typeof input?.dryRun === 'boolean' ? input.dryRun : undefined,
            },
          )
          logger.info(
            {
              skillName,
              hotmailClassified: result.hotmail.classified,
              gmailClassified: result.gmail.classified,
              corrections: result.corrections,
              summaryPosted: result.summaryPosted,
              durationMs: result.durationMs,
            },
            '[skill-execution] email-classify complete',
          )
          break
        }

        default: {
          // Unknown skill names are unrecoverable — no point retrying.
          throw new UnrecoverableError(`[skill-execution] unknown skill: ${skillName}`)
        }
      }
    },
    {
      connection,
      concurrency: 1, // Skills are LLM-heavy; run one at a time
      limiter: {
        max: 1,
        duration: 5_000, // At most 1 skill job per 5 seconds
      },
    },
  )

  worker.on('completed', (job) => {
    logger.info({ skillName: job.data.skillName, jobId: job.id }, '[skill-execution] job completed')
    // Fire-and-forget activity feed insert
    db.insert(activity_feed)
      .values({
        type: 'skill',
        subtype: 'completed',
        summary: `Skill "${job.data.skillName}" completed`,
        detail: { skill_name: job.data.skillName, job_id: job.id },
      })
      .catch((err) => {
        logger.debug({ err, skillName: job.data.skillName }, 'activity_feed insert failed for skill completion')
      })
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { skillName: job?.data.skillName, jobId: job?.id, err },
      '[skill-execution] job failed',
    )
  })

  return worker
}
