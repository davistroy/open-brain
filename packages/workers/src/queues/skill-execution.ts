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
      removeOnFail: { count: 100 },
    },
  })
}

export type SkillExecutionQueue = ReturnType<typeof createSkillExecutionQueue>
