import { Worker } from 'bullmq'
import type { ConnectionOptions } from 'bullmq'
import { logger } from '../lib/logger.js'
import { EmailService } from '../services/email.js'
import type { NotificationQueue } from '../queues/notification.js'

export interface EmailJobData {
  to: string
  subject: string
  htmlBody: string
  textBody: string
  /** Optional correlation ID — captureId or skill execution ID for tracing */
  correlationId?: string
}

/**
 * Process an email notification job.
 *
 * Delegates to EmailService.send(). Throws on delivery failure so BullMQ
 * retries with fixed 30s backoff (3 attempts per notification queue defaults).
 *
 * SMTP_HOST + SMTP_USER must be set in environment. If not configured,
 * the job logs a warning and completes without error (idempotent no-op).
 */
export async function processEmailJob(
  data: EmailJobData,
  emailService: EmailService,
): Promise<void> {
  const { to, subject, correlationId } = data

  logger.info({ to, subject, correlationId }, '[email-job] processing email delivery')

  if (!emailService.isConfigured) {
    logger.warn({ to, subject }, '[email-job] SMTP not configured — email delivery skipped')
    return
  }

  await emailService.send({
    to: data.to,
    subject: data.subject,
    htmlBody: data.htmlBody,
    textBody: data.textBody,
  })

  logger.info({ to, subject, correlationId }, '[email-job] email delivered successfully')
}

/**
 * Creates a BullMQ Worker that processes email notification jobs from the
 * 'notification' queue where channel === 'email'.
 *
 * Job configuration (set on the notification queue):
 * - priority: 5 (normal — below pipeline, above skill execution)
 * - timeout: 60s
 * - attempts: 3 with 30s fixed backoff
 *
 * The caller is responsible for calling worker.close() on process shutdown.
 */
export function createEmailWorker(
  connection: ConnectionOptions,
  emailService?: EmailService,
): Worker<EmailJobData> {
  const service = emailService ?? new EmailService()

  const worker = new Worker<EmailJobData>(
    'email',
    async (job) => {
      await processEmailJob(job.data, service)
    },
    {
      connection,
      concurrency: 2, // two concurrent SMTP sends is plenty
    },
  )

  worker.on('failed', (job, err) => {
    logger.warn(
      {
        jobId: job?.id,
        to: job?.data?.to,
        subject: job?.data?.subject,
        attempts: job?.attemptsMade ?? 0,
        err: err.message,
      },
      '[email-job] job failed',
    )
  })

  worker.on('completed', (job) => {
    logger.info(
      {
        jobId: job?.id,
        to: job?.data?.to,
        subject: job?.data?.subject,
      },
      '[email-job] job completed',
    )
  })

  return worker
}

/**
 * Enqueue an email delivery job on the notification queue.
 *
 * Uses a stable jobId (correlationId + subject hash) so re-enqueuing the
 * same email (e.g., on a skill retry) is idempotent.
 *
 * @param queue     The notification queue (channel routing is done externally;
 *                  email jobs go to the dedicated 'email' queue or inline here)
 * @param data      Email payload
 */
export async function enqueueEmailJob(
  queue: NotificationQueue,
  data: EmailJobData,
): Promise<void> {
  const jobId = data.correlationId
    ? `email:${data.correlationId}:${encodeURIComponent(data.subject).slice(0, 40)}`
    : undefined

  await queue.add(
    'email',
    // NotificationJobData shape: channel + message + metadata
    {
      channel: 'email',
      message: data.subject,
      captureId: data.correlationId,
      metadata: {
        to: data.to,
        subject: data.subject,
        htmlBody: data.htmlBody,
        textBody: data.textBody,
      },
    },
    {
      priority: 5,
      jobId,
      // 60s processing timeout; 3 retries with 30s fixed delay
      attempts: 3,
      backoff: { type: 'fixed', delay: 30_000 },
    },
  )

  logger.info({ to: data.to, subject: data.subject, jobId }, '[email-job] job enqueued')
}
