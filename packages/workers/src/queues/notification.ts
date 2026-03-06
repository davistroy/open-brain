import { Queue } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'

export type NotificationChannel = 'pushover' | 'email' | 'slack-reply'

export interface NotificationJobData {
  channel: NotificationChannel
  captureId?: string
  /** Human-readable message to deliver */
  message: string
  /** Channel-specific metadata (e.g. Slack thread_ts, email subject) */
  metadata?: Record<string, unknown>
}

/**
 * Queue for outbound notifications (Pushover, email, Slack replies).
 *
 * Channel priorities reflect urgency:
 * - pushover: priority 7 (high), timeout 30s, 3 retries
 * - slack-reply: priority 7 (high), timeout 10s, 3 retries
 * - email: priority 5 (normal), timeout 60s, 3 retries
 *
 * All use exponential backoff — notification failures should not consume
 * pipeline retry budget.
 */
export function createNotificationQueue(connection: ConnectionOptions) {
  return new Queue<NotificationJobData>('notification', {
    connection,
    defaultJobOptions: {
      priority: 7,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5_000, // 5s, 10s, 20s
      },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 100 },
    },
  })
}

export type NotificationQueue = ReturnType<typeof createNotificationQueue>
