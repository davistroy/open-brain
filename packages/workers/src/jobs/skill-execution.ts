import { Worker, UnrecoverableError } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { Database, ConfigService } from '@open-brain/shared'
import { logger, activity_feed } from '@open-brain/shared'
import { executeWeeklyBrief } from '../skills/weekly-brief.js'
import { executeDailyConnections } from '../skills/daily-connections.js'
import { executeDriftMonitor } from '../skills/drift-monitor.js'
import { executeDailySweep } from '../skills/daily-sweep-skill.js'
import { executeMemoryConsolidation } from '../skills/memory-consolidation.js'
import type { SkillExecutionJobData } from '../queues/skill-execution.js'
import type Anthropic from '@anthropic-ai/sdk'
import type { WikiGitService } from '@open-brain/shared'

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
 *  2. Add a case here in the switch statement
 *  3. Register the skill name in core-api/src/routes/skills.ts KNOWN_SKILLS
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
    wikiService?: WikiGitService
  },
): Worker {
  // Resolve model aliases from ai-routing.yaml so skills send actual model
  // names (e.g. 'gpt-5.4') to the OpenAI API, not LiteLLM aliases.
  const aiConfig = opts.configService.get('ai')
  const synthesisModel: string = aiConfig.models['synthesis'].model

  const worker = new Worker<SkillExecutionJobData>(
    'skill-execution',
    async (job) => {
      const { skillName, input } = job.data

      logger.info({ skillName, jobId: job.id }, '[skill-execution] job received')

      switch (skillName) {
        case 'weekly-brief': {
          const result = await executeWeeklyBrief(db, {
            windowDays: typeof input?.windowDays === 'number' ? input.windowDays : undefined,
            tokenBudget: typeof input?.tokenBudget === 'number' ? input.tokenBudget : undefined,
            modelAlias: synthesisModel,
            emailTo: typeof input?.emailTo === 'string' ? input.emailTo : undefined,
          })

          logger.info(
            { skillName, captureCount: result.captureCount, durationMs: result.durationMs },
            '[skill-execution] weekly-brief complete',
          )
          break
        }

        case 'daily-connections': {
          const result = await executeDailyConnections(db, {
            windowDays: typeof input?.windowDays === 'number' ? input.windowDays : undefined,
            tokenBudget: typeof input?.tokenBudget === 'number' ? input.tokenBudget : undefined,
            modelAlias: synthesisModel,
          })

          logger.info(
            { skillName, captureCount: result.captureCount, connectionCount: result.output.connections.length, durationMs: result.durationMs },
            '[skill-execution] daily-connections complete',
          )
          break
        }

        case 'drift-monitor': {
          const result = await executeDriftMonitor(db, {
            betActivityDays: typeof input?.betActivityDays === 'number' ? input.betActivityDays : undefined,
            commitmentDays: typeof input?.commitmentDays === 'number' ? input.commitmentDays : undefined,
            entityWindowDays: typeof input?.entityWindowDays === 'number' ? input.entityWindowDays : undefined,
            modelAlias: synthesisModel,
          })

          logger.info(
            { skillName, driftItemCount: result.output.drift_items.length, overallHealth: result.output.overall_health, notificationSent: result.notificationSent, durationMs: result.durationMs },
            '[skill-execution] drift-monitor complete',
          )
          break
        }

        case 'pipeline-health': {
          const { executePipelineHealth } = await import('../skills/pipeline-health.js')
          const result = await executePipelineHealth(db, {
            failureLookbackMinutes: typeof input?.failureLookbackMinutes === 'number' ? input.failureLookbackMinutes : undefined,
            failedThreshold: typeof input?.failedThreshold === 'number' ? input.failedThreshold : undefined,
            waitingThreshold: typeof input?.waitingThreshold === 'number' ? input.waitingThreshold : undefined,
          })
          logger.info(
            { skillName, healthy: result.healthy, alertSent: result.alertSent, durationMs: result.durationMs },
            '[skill-execution] pipeline-health complete',
          )
          break
        }

        case 'daily-sweep-skill': {
          const result = await executeDailySweep(db, {
            tokenBudget: typeof input?.tokenBudget === 'number' ? input.tokenBudget : undefined,
            modelAlias: synthesisModel,
            storeCapture: typeof input?.storeCapture === 'boolean' ? input.storeCapture : false,
          })
          logger.info(
            { skillName, captureCount: result.captureCount, headline: result.output.headline, durationMs: result.durationMs },
            '[skill-execution] daily-sweep-skill complete',
          )
          break
        }

        case 'morning-brief': {
          const { executeMorningBrief } = await import('../skills/morning-brief.js')
          const result = await executeMorningBrief(db, {})
          logger.info(
            { skillName, thread: result.yesterdayThread.length, loops: result.openLoops.length, people: result.people.length, notificationSent: result.notificationSent, durationMs: result.durationMs },
            '[skill-execution] morning-brief complete',
          )
          break
        }

        case 'capture-reminder-morning': {
          const { executeCaptureReminder } = await import('../skills/capture-reminder.js')
          const result = await executeCaptureReminder(db, { mode: 'morning' })
          logger.info(
            { skillName, notificationSent: result.notificationSent, durationMs: result.durationMs },
            '[skill-execution] capture-reminder-morning complete',
          )
          break
        }

        case 'capture-reminder-evening': {
          const { executeCaptureReminder } = await import('../skills/capture-reminder.js')
          const result = await executeCaptureReminder(db, { mode: 'evening' })
          logger.info(
            { skillName, notificationSent: result.notificationSent, captureCount: result.captureCount, durationMs: result.durationMs },
            '[skill-execution] capture-reminder-evening complete',
          )
          break
        }

        case 'memory-consolidation': {
          const result = await executeMemoryConsolidation(db, {
            modelAlias: synthesisModel,
            similarityThreshold: typeof input?.similarityThreshold === 'number' ? input.similarityThreshold : undefined,
            minClusterSize: typeof input?.minClusterSize === 'number' ? input.minClusterSize : undefined,
            maxClusters: typeof input?.maxClusters === 'number' ? input.maxClusters : undefined,
          })
          logger.info(
            { skillName, totalMerged: result.totalMerged, totalSkipped: result.totalSkipped, totalErrors: result.totalErrors, durationMs: result.durationMs },
            '[skill-execution] memory-consolidation complete',
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
          const { executeWikiIngest } = await import('../skills/wiki-ingest.js')
          const result = await executeWikiIngest(db, captureId, opts.wikiService, {
            anthropicClient: opts.anthropicClient,
            promptsDir: opts.promptsDir,
          })
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
