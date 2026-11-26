/**
 * One-time cleanup of completed flow jobs (item 9.3, PE-004).
 *
 * Before item 9.3 the five flow queues kept every completed job forever
 * (FlowProducer.add ignores Queue defaultJobOptions). New jobs now carry an age
 * bound; this script removes the backlog that already exists.
 *
 * Destructive ONLY when run without --dry-run. `--dry-run` prints getJobCounts()
 * per queue and removes nothing. Failed jobs are never touched.
 *
 * Run inside the workers container:
 *   docker cp scripts/clean-completed-flow-jobs.mjs open-brain-workers:/tmp/
 *   docker exec open-brain-workers node /tmp/clean-completed-flow-jobs.mjs --dry-run
 *   docker exec open-brain-workers node /tmp/clean-completed-flow-jobs.mjs
 *
 * Env: REDIS_URL (default redis://redis:6379), BULL_PREFIX (default bull).
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { Queue } = require(
  process.env.BULLMQ_PATH ?? '/app/node_modules/.pnpm/bullmq@5.70.4/node_modules/bullmq/dist/cjs/index.js',
)

const QUEUES = ['ingest-root', 'embed-capture', 'extract-entities', 'extract-commitments', 'wiki-ingest']
const dryRun = process.argv.includes('--dry-run')

const redisUrl = process.env.REDIS_URL ?? 'redis://redis:6379'
const url = new URL(redisUrl)
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  ...(url.pathname && url.pathname !== '/' ? { db: Number(url.pathname.slice(1)) || 0 } : {}),
}
const prefix = process.env.BULL_PREFIX ?? 'bull'

console.log(dryRun ? 'DRY RUN — nothing will be removed' : 'Removing ALL completed jobs from the flow queues')

for (const name of QUEUES) {
  const queue = new Queue(name, { connection, prefix })
  try {
    if (dryRun) {
      console.log(name, JSON.stringify(await queue.getJobCounts()))
    } else {
      // grace 0 ms, up to 100000 jobs per call, completed set only.
      const removed = await queue.clean(0, 100000, 'completed')
      console.log(name, `removed ${removed.length} completed`)
    }
  } finally {
    await queue.close()
  }
}
process.exit(0)
