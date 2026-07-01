import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export interface SkillExecutionJobData {
  skillName: string
  captureId?: string
  sessionId?: string
  input: Record<string, unknown>
}

/**
 * Queue for executing AI skills (synthesis, governance sessions, etc.).
 * Priority 3 (lower than pipeline — skills are best-effort background work).
 * 3 attempts with exponential backoff. On final failure, a Pushover alert
 * should be enqueued by the worker (implemented in skill worker phase).
 */
export function createSkillExecutionQueue(connection: ConnectionOptions) {
  return new Queue<SkillExecutionJobData>('skill-execution', {
    connection,
    defaultJobOptions: {
      priority: 3,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 10_000, // 10s, 20s, 40s
      },
      removeOnComplete: { count: 200 },
      // age bound (14d) so stale failures auto-prune — `count` alone never prunes
      // below 100, which let 2-month-old zombie failures accumulate and trip the
      // pipeline-health `>5 failed` alert (Entry 180). Recent failures still stay
      // visible to the health monitor.
      removeOnFail: { age: 14 * 24 * 60 * 60, count: 100 },
    },
  })
}

export type SkillExecutionQueue = ReturnType<typeof createSkillExecutionQueue>
