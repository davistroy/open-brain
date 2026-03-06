import type { ConnectionOptions } from 'bullmq'
import { createAccessStatsQueue } from './access-stats.js'
import { createCapturePipelineQueue } from './capture-pipeline.js'
import { createEmbedCaptureQueue } from './embed-capture.js'
import { createNotificationQueue } from './notification.js'
import { createSkillExecutionQueue } from './skill-execution.js'

export interface AllQueues {
  capturePipeline: ReturnType<typeof createCapturePipelineQueue>
  embedCapture: ReturnType<typeof createEmbedCaptureQueue>
  skillExecution: ReturnType<typeof createSkillExecutionQueue>
  notification: ReturnType<typeof createNotificationQueue>
  accessStats: ReturnType<typeof createAccessStatsQueue>
}

/**
 * Queue factory — creates all BullMQ queues from a single Redis connection.
 * Call once at startup; pass the returned object to workers and services.
 */
export function createAllQueues(connection: ConnectionOptions): AllQueues {
  return {
    capturePipeline: createCapturePipelineQueue(connection),
    embedCapture: createEmbedCaptureQueue(connection),
    skillExecution: createSkillExecutionQueue(connection),
    notification: createNotificationQueue(connection),
    accessStats: createAccessStatsQueue(connection),
  }
}

export * from './access-stats.js'
export * from './capture-pipeline.js'
export * from './embed-capture.js'
export * from './notification.js'
export * from './skill-execution.js'
