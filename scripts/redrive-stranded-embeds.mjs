/**
 * One-off re-drive of captures that never got an embedding (remediation plan
 * item 1.2; arch-review v7 SE7-01 / PE-012).
 *
 * Why it exists: the ingest flow uses fixed job IDs (`embed_<id>`,
 * `ingest-root_<id>`), and flow jobs are retained after they fail. Every later
 * re-add with the same ID returns the retained job ("duplicated"), so the
 * nightly sweep and `POST /captures/:id/retry` change nothing.
 *
 * Per capture, one at a time:
 *   1. `embed_<id>` in flight (waiting / prioritized / active / delayed /
 *      waiting-children)          -> skip the capture.
 *   2. `ingest-root_<id>` in flight -> skip the capture (a live flow owns it).
 *   3. Remove the retained `embed_<id>` (any other state).
 *   4. `ingest-root_<id>` failed    -> remove it alone ({ removeChildren: false }).
 *   5. Add a standalone `embed_<id>` job (no parent).
 * Enrichment jobs (extract-entities, extract-commitments, wiki-ingest) are
 * never read, removed, or added: each is paid per item.
 *
 * The embed handler skips captures at `pipeline_status = 'failed'`; reset those
 * rows to `extracted` before the run.
 *
 * Run inside the workers container, outside 03:00-03:30 (the nightly sweep):
 *   docker cp scripts/redrive-stranded-embeds.mjs open-brain-workers:/tmp/
 *   docker cp /tmp/stranded-ids.txt open-brain-workers:/tmp/
 *   docker exec open-brain-workers node /tmp/redrive-stranded-embeds.mjs \
 *     --ids-file /tmp/stranded-ids.txt [--dry-run] [--limit <n>]
 *
 * Output: one line per capture, then `TALLY {json}`. Exit 2 = bad input,
 * exit 1 = at least one capture errored.
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const BULLMQ_MODULE =
  process.env.BULLMQ_MODULE ??
  '/app/node_modules/.pnpm/bullmq@5.70.4/node_modules/bullmq/dist/cjs/index.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IN_FLIGHT = new Set(['waiting', 'prioritized', 'active', 'delayed', 'waiting-children'])
const NEW_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: { age: 7 * 24 * 60 * 60 },
  removeOnFail: { age: 14 * 24 * 60 * 60 },
}

function usage(msg) {
  console.error(`error: ${msg}`)
  console.error('usage: node redrive-stranded-embeds.mjs --ids-file <path> [--dry-run] [--limit <n>]')
  process.exit(2)
}

function parseArgs(argv) {
  const args = { idsFile: null, dryRun: false, limit: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--ids-file') args.idsFile = argv[++i]
    else if (a === '--limit') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n < 1) usage('--limit needs a positive integer')
      args.limit = n
    } else usage(`unknown argument: ${a}`)
  }
  if (!args.idsFile) usage('--ids-file is required')
  return args
}

function readIds(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    usage(`cannot read ${path}: ${err.message}`)
  }
  const ids = []
  const lines = text.split('\n')
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim()
    if (!line || line.startsWith('#')) continue
    if (!UUID_RE.test(line)) usage(`line ${n + 1} is not a UUID: ${JSON.stringify(line)}`)
    ids.push(line.toLowerCase())
  }
  if (ids.length === 0) usage(`${path} holds no capture IDs`)
  if (new Set(ids).size !== ids.length) usage(`${path} holds duplicate capture IDs`)
  return ids
}

const args = parseArgs(process.argv.slice(2))
const allIds = readIds(args.idsFile)
const ids = args.limit ? allIds.slice(0, args.limit) : allIds

const { Queue } = require(BULLMQ_MODULE)
const url = new URL(process.env.REDIS_URL ?? 'redis://redis:6379')
const connection = {
  host: url.hostname,
  port: Number(url.port || 6379),
  ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  ...(url.pathname && url.pathname !== '/' ? { db: Number(url.pathname.slice(1)) || 0 } : {}),
}
// skipMetasUpdate: the queues already exist; a dry run must write nothing.
const embedQueue = new Queue('embed-capture', { connection, skipMetasUpdate: true })
const rootQueue = new Queue('ingest-root', { connection, skipMetasUpdate: true })

const stateOf = async (queue, jobId) => {
  const job = await queue.getJob(jobId)
  return job ? job.getState() : 'absent'
}

const tally = { total: ids.length, skipped: 0, removedEmbed: 0, removedRoot: 0, added: 0, errors: 0, dryRun: args.dryRun }
const verb = args.dryRun ? 'would ' : ''
console.log(`${args.dryRun ? 'DRY RUN — ' : ''}${ids.length} of ${allIds.length} capture(s) from ${args.idsFile}`)

for (const id of ids) {
  const embedId = `embed_${id}`
  const rootId = `ingest-root_${id}`
  try {
    const embedState = await stateOf(embedQueue, embedId)
    const rootState = await stateOf(rootQueue, rootId)
    const prefix = `${id} embed=${embedState} root=${rootState}`

    if (IN_FLIGHT.has(embedState) || IN_FLIGHT.has(rootState)) {
      tally.skipped++
      console.log(`${prefix} -> skip (in flight)`)
      continue
    }

    const steps = []
    if (embedState !== 'absent') {
      if (!args.dryRun && (await embedQueue.remove(embedId)) !== 1) {
        throw new Error(`could not remove ${embedId} (locked?)`)
      }
      tally.removedEmbed++
      steps.push(`${verb}remove embed`)
    }
    if (rootState === 'failed') {
      if (!args.dryRun && (await rootQueue.remove(rootId, { removeChildren: false })) !== 1) {
        throw new Error(`could not remove ${rootId} (locked?)`)
      }
      tally.removedRoot++
      steps.push(`${verb}remove failed root`)
    }
    if (!args.dryRun) {
      if ((await stateOf(embedQueue, embedId)) !== 'absent') {
        throw new Error(`${embedId} still exists after remove`)
      }
      await embedQueue.add('embed', { captureId: id }, { ...NEW_JOB_OPTS, jobId: embedId })
      const after = await stateOf(embedQueue, embedId)
      if (!IN_FLIGHT.has(after)) throw new Error(`new ${embedId} is in state ${after}`)
    }
    tally.added++
    steps.push(`${verb}add embed`)
    console.log(`${prefix} -> ${steps.join(', ')}`)
  } catch (err) {
    tally.errors++
    console.log(`${id} -> ERROR ${err.message}`)
  }
}

console.log(`TALLY ${JSON.stringify(tally)}`)
await Promise.all([embedQueue.close(), rootQueue.close()])
process.exit(tally.errors > 0 ? 1 : 0)
