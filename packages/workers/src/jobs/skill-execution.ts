import { Worker, UnrecoverableError } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import type OpenAI from 'openai'
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
    ollamaClient?: OpenAI
    wikiService?: WikiGitService
  },
): Worker {
  // Resolve model aliases from ai-routing.yaml so skills send actual model
  // names (e.g. 'claude-sonnet-4-20250514') to the API, not LiteLLM aliases.
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
          }, opts.anthropicClient)

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
          }, opts.wikiService, opts.anthropicClient)

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
          }, opts.wikiService, opts.anthropicClient)

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
          }, opts.anthropicClient)
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
          }, opts.anthropicClient)
          logger.info(
            { skillName, totalMerged: result.totalMerged, totalSkipped: result.totalSkipped, totalErrors: result.totalErrors, durationMs: result.durationMs },
            '[skill-execution] memory-consolidation complete',
          )
          break
        }

        case 'wiki-lint': {
          if (!opts.wikiService) {
            throw new UnrecoverableError('[skill-execution] wiki-lint requires wikiService — WikiGitService not configured')
          }
          const { executeWikiLint } = await import('../skills/wiki-lint.js')
          const wikiLintResult = await executeWikiLint(db, opts.wikiService, {
            anthropicClient: opts.anthropicClient,
            promptsDir: opts.promptsDir,
          })
          logger.info(
            {
              skillName,
              pagesScanned: wikiLintResult.pagesScanned,
              issuesFound: wikiLintResult.issuesFound,
              notificationSent: wikiLintResult.notificationSent,
              durationMs: wikiLintResult.durationMs,
            },
            '[skill-execution] wiki-lint complete',
          )
          break
        }

        case 'wiki-synthesis': {
          const { executeWikiSynthesis } = await import('../skills/wiki-synthesis.js')
          const wikiSynthResult = await executeWikiSynthesis(db, {
            redisConnection: connection,
            lookbackHours: typeof input?.lookbackHours === 'number' ? input.lookbackHours : undefined,
          })
          logger.info(
            {
              skillName,
              capturesChecked: wikiSynthResult.capturesChecked,
              capturesQueued: wikiSynthResult.capturesQueued,
              notificationSent: wikiSynthResult.notificationSent,
              durationMs: wikiSynthResult.durationMs,
            },
            '[skill-execution] wiki-synthesis complete',
          )
          break
        }

        case 'monthly-reflection': {
          const { executeMonthlyReflection } = await import('../skills/monthly-reflection.js')
          const monthlyResult = await executeMonthlyReflection(db, {
            anthropicClient: opts.anthropicClient,
            wikiService: opts.wikiService,
            promptsDir: opts.promptsDir,
          })
          logger.info(
            {
              skillName,
              captureCount: monthlyResult.captureCount,
              headline: monthlyResult.output.headline,
              iterations: monthlyResult.agentIterations,
              toolCalls: monthlyResult.toolCalls,
              emailSent: monthlyResult.emailSent,
              wikiPageWritten: monthlyResult.wikiPageWritten,
              durationMs: monthlyResult.durationMs,
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

        case 'db-backup': {
          const { executeDbBackup } = await import('../skills/db-backup.js')
          const dbBackupResult = await executeDbBackup(db, {
            backupDir: typeof input?.backupDir === 'string' ? input.backupDir : undefined,
            containerName: typeof input?.containerName === 'string' ? input.containerName : undefined,
            dbName: typeof input?.dbName === 'string' ? input.dbName : undefined,
            dbUser: typeof input?.dbUser === 'string' ? input.dbUser : undefined,
          })
          logger.info(
            {
              skillName,
              status: dbBackupResult.status,
              sizeBytes: dbBackupResult.sizeBytes,
              durationSeconds: dbBackupResult.durationSeconds,
              prunedCount: dbBackupResult.prunedCount,
            },
            '[skill-execution] db-backup complete',
          )
          break
        }

        case 'wiki-backup': {
          const { executeWikiBackup } = await import('../skills/wiki-backup.js')
          const wikiBackupResult = await executeWikiBackup(db, {
            backupDir: typeof input?.backupDir === 'string' ? input.backupDir : undefined,
            wikiRepoPath: typeof input?.wikiRepoPath === 'string' ? input.wikiRepoPath : undefined,
          })
          logger.info(
            {
              skillName,
              status: wikiBackupResult.status,
              sizeBytes: wikiBackupResult.sizeBytes,
              durationSeconds: wikiBackupResult.durationSeconds,
              prunedCount: wikiBackupResult.prunedCount,
            },
            '[skill-execution] wiki-backup complete',
          )
          break
        }

        case 'redis-snapshot': {
          const { executeRedisSnapshot } = await import('../skills/redis-snapshot.js')
          const redisResult = await executeRedisSnapshot(db, {
            backupDir: typeof input?.backupDir === 'string' ? input.backupDir : undefined,
            containerName: typeof input?.containerName === 'string' ? input.containerName : undefined,
          })
          logger.info(
            {
              skillName,
              status: redisResult.status,
              sizeBytes: redisResult.sizeBytes,
              durationSeconds: redisResult.durationSeconds,
              prunedCount: redisResult.prunedCount,
            },
            '[skill-execution] redis-snapshot complete',
          )
          break
        }

        case 'email-compose': {
          const { executeEmailCompose } = await import('../skills/email-compose.js')
          const instruction = typeof input?.instruction === 'string' ? input.instruction : ''
          if (!instruction) {
            throw new UnrecoverableError('[skill-execution] email-compose requires input.instruction')
          }
          const emailResult = await executeEmailCompose(db, instruction, {
            anthropicClient: opts.anthropicClient,
            coreApiUrl: opts.coreApiUrl,
          })
          logger.info(
            {
              skillName,
              draftId: emailResult.draftId,
              to: emailResult.to,
              iterations: emailResult.agentIterations,
              toolCalls: emailResult.toolCalls,
              durationMs: emailResult.durationMs,
            },
            '[skill-execution] email-compose complete',
          )
          break
        }

        case 'cost-analysis': {
          const { executeCostAnalysis } = await import('../skills/cost-analysis.js')
          const costResult = await executeCostAnalysis(db, {
            dailyAlertThreshold: typeof input?.dailyAlertThreshold === 'number' ? input.dailyAlertThreshold : undefined,
          }, opts.wikiService)
          logger.info(
            {
              skillName,
              type: costResult.type,
              totalCost: costResult.summary.totalCost,
              alertSent: costResult.alertSent,
              wikiPageWritten: costResult.wikiPageWritten,
              durationMs: costResult.durationMs,
            },
            '[skill-execution] cost-analysis complete',
          )
          break
        }

        case 'container-health': {
          const { executeContainerHealth } = await import('../skills/container-health.js')
          const healthResult = await executeContainerHealth(db, {
            consecutiveFailureThreshold: typeof input?.consecutiveFailureThreshold === 'number' ? input.consecutiveFailureThreshold : undefined,
          })
          logger.info(
            {
              skillName,
              healthyCount: healthResult.healthyCount,
              unhealthyCount: healthResult.unhealthyCount,
              alertsSent: healthResult.alertsSent,
              durationMs: healthResult.durationMs,
            },
            '[skill-execution] container-health complete',
          )
          break
        }

        case 'secret-rotation': {
          const { executeSecretRotation } = await import('../skills/secret-rotation.js')
          const secretResult = await executeSecretRotation(db, {
            maxAgeDays: typeof input?.maxAgeDays === 'number' ? input.maxAgeDays : undefined,
            bwsBinary: typeof input?.bwsBinary === 'string' ? input.bwsBinary : undefined,
          })
          logger.info(
            {
              skillName,
              totalSecrets: secretResult.totalSecrets,
              staleCount: secretResult.staleSecrets.length,
              alertSent: secretResult.alertSent,
              durationMs: secretResult.durationMs,
            },
            '[skill-execution] secret-rotation complete',
          )
          break
        }

        case 'storage-audit': {
          const { executeStorageAudit } = await import('../skills/storage-audit.js')
          const storageResult = await executeStorageAudit(db, {}, opts.wikiService)
          logger.info(
            {
              skillName,
              dbSize: storageResult.metrics.postgres.dbSizeHuman,
              redisMemory: storageResult.metrics.redis.usedMemoryHuman,
              wikiPageWritten: storageResult.wikiPageWritten,
              durationMs: storageResult.durationMs,
            },
            '[skill-execution] storage-audit complete',
          )
          break
        }

        case 'capture-dedup-sweep': {
          const { executeCaptureDedupSweep } = await import('../skills/capture-dedup-sweep.js')
          const dedupResult = await executeCaptureDedupSweep(db, {
            similarityThreshold: typeof input?.similarityThreshold === 'number' ? input.similarityThreshold : undefined,
            maxPairs: typeof input?.maxPairs === 'number' ? input.maxPairs : undefined,
          })
          logger.info(
            {
              skillName,
              pairsFound: dedupResult.pairsFound,
              notificationSent: dedupResult.notificationSent,
              durationMs: dedupResult.durationMs,
            },
            '[skill-execution] capture-dedup-sweep complete',
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
