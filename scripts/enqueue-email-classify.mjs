/**
 * One-shot BullMQ enqueuer. Adds a skill-execution job for email-classify.
 *
 * Run inside the workers container:
 *   docker cp scripts/enqueue-email-classify.mjs open-brain-workers:/tmp/
 *   docker exec open-brain-workers node /tmp/enqueue-email-classify.mjs
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { Queue } = require('/app/node_modules/.pnpm/bullmq@5.70.4/node_modules/bullmq/dist/cjs/index.js')

const redisUrl = process.env.REDIS_URL ?? 'redis://redis:6379'
const url = new URL(redisUrl)
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  ...(url.password ? { password: url.password } : {}),
  ...(url.pathname && url.pathname !== '/' ? { db: Number(url.pathname.slice(1)) || 0 } : {}),
}

const queue = new Queue('skill-execution', { connection })

const job = await queue.add(
  'email-classify',
  { skillName: 'email-classify', input: { providers: ['hotmail', 'gmail'], sinceHours: 24 } },
  { jobId: `manual-email-classify-${Date.now()}`, removeOnComplete: false, removeOnFail: false },
)

console.log('enqueued', job.id)
await queue.close()
process.exit(0)
