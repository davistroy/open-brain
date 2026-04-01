import { Worker, UnrecoverableError } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type { Database, ConfigService } from '@open-brain/shared'
import { logger } from '@open-brain/shared'
import { executeWeeklyBrief } from '../skills/weekly-brief.js'
import { executeDailyConnections } from '../skills/daily-connections.js'
import { executeDriftMonitor } from '../skills/drift-monitor.js'
import type { SkillExecutionJobData } from '../queues/skill-execution.js'

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
  },
): Worker {
  // Resolve model aliases from ai-routing.yaml so skills send actual model
  // names (e.g. 'gpt-5.4') to the OpenAI API, not LiteLLM aliases.
  const aiConfig = opts.configService.get('ai')
  const synthesisModel: string = aiConfig.models['synthesis'] as string

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
          // Defined in KNOWN_SKILLS for scheduling visibility but not yet implemented.
          // Log and skip gracefully.
          logger.warn({ skillName }, '[skill-execution] skill not yet implemented — skipping')
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
  })

  worker.on('failed', (job, err) => {
    logger.error(
      { skillName: job?.data.skillName, jobId: job?.id, err },
      '[skill-execution] job failed',
    )
  })

  return worker
}
