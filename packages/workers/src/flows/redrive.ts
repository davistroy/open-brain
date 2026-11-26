import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import type { ConnectionOptions, FlowProducer, Job } from 'bullmq'
import { attachErrorListeners, logger } from '@open-brain/shared'
import { buildIngestFlow, INGEST_FLOW_QUEUES_OPTIONS, INGEST_ROOT_QUEUE_NAME } from './ingest-pipeline.js'

/**
 * Embed re-drive for the capture ingestion flow (item 9.1, SE7-01 / PE-012).
 *
 * WHY THIS EXISTS
 *   buildIngestFlow() gives every flow job a FIXED id (`ingest-root_<id>`,
 *   `embed_<id>`, `extract-entities_<id>`, ...). BullMQ returns early when a job
 *   with that id already exists, so a retained FAILED embed job silently blocks
 *   every later re-add — the nightly sweep and the retry route "re-queue" the
 *   capture and nothing runs.
 *
 * WHAT IT DOES
 *   - Per-capture lock: lookup → remove → add runs under a Redis lock
 *     (`<prefix>:redrive-lock:<captureId>`, SET NX PX 120000, released by a
 *     token compare-and-delete). A second concurrent call (ingestion worker
 *     concurrency 2; a double retry; sweep + retry) returns `skipped` (reason
 *     `locked`) and adds nothing, so it can never delete the first call's fresh
 *     jobs and run the paid enrichment twice.
 *   - In flight: add nothing, return `skipped` (reason `in-flight`, logged at
 *     warn). The flow is in flight when the embed or an enrichment child is
 *     itself waiting / active / delayed / prioritized / waiting-children, or
 *     the root is waiting / active / delayed / prioritized. A root in
 *     `waiting-children` alone does NOT count: when its embed is missing,
 *     `unknown` or failed and no child is in flight, nothing will ever move it
 *     (an orphan), so the flow is `finished` and the root is removed.
 *   - stage 'embed' (default): remove ONLY the retained root (removeChildren:
 *     false) and the embed job, then add an embed-only flow (root + embed).
 *     The enrichment children (`extract-entities`, `extract-commitments`,
 *     `wiki-ingest`) are left untouched, so enrichment never re-runs — those
 *     are paid / non-idempotent (commitments insert with no dedup).
 *   - stage 'all': additionally remove each finished enrichment child BY ID in
 *     its own queue, then add the full flow. Never `removeChildren` — a child
 *     that failed with removeDependencyOnFailure is recorded nowhere on the
 *     parent, so a tree removal misses it and on re-add it re-attaches to the
 *     new root, which then waits forever.
 *
 * A job whose state is `unknown` (hash present, in no state list — e.g. an old
 * "job stalled more than allowable limit" orphan) also blocks re-adds, so it is
 * treated as finished and removed.
 */

export type FlowState = 'none' | 'in-flight' | 'finished'

export interface RedriveOptions {
  stage: 'embed' | 'all'
  includeWikiIngest: boolean
  traceId?: string
}

export interface RedriveDeps {
  connection: ConnectionOptions
  flowProducer: FlowProducer
  /** BullMQ key prefix; must match the FlowProducer's prefix. Default 'bull'. */
  prefix?: string
}

export type RedriveResult =
  | { action: 'skipped'; reason: 'in-flight' | 'locked' }
  | { action: 'redriven'; stage: 'embed' | 'all'; removed: string[] }

const EMBED_QUEUE_NAME = 'embed-capture'
const ENRICHMENT_QUEUE_NAMES = ['extract-entities', 'extract-commitments', 'wiki-ingest'] as const

const IN_FLIGHT_STATES = new Set<string>(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'])

/** Lock TTL — long enough for lookup → remove → add, short enough to self-heal after a crash. */
const REDRIVE_LOCK_TTL_MS = 120_000

/** Delete the lock only when it still holds our token (never another caller's lock). */
const RELEASE_LOCK_LUA = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`

type QueueName = typeof INGEST_ROOT_QUEUE_NAME | typeof EMBED_QUEUE_NAME | (typeof ENRICHMENT_QUEUE_NAMES)[number]

/**
 * Queue handles are cached per connection object + prefix so the nightly sweep
 * (one call per stuck capture) does not open a Redis connection per capture.
 */
const queueCache = new WeakMap<object, Map<string, Map<QueueName, Queue>>>()

function getQueue(connection: ConnectionOptions, name: QueueName, prefix?: string): Queue {
  const key = connection as object
  let byPrefix = queueCache.get(key)
  if (!byPrefix) {
    byPrefix = new Map()
    queueCache.set(key, byPrefix)
  }
  const prefixKey = prefix ?? ''
  let byName = byPrefix.get(prefixKey)
  if (!byName) {
    byName = new Map()
    byPrefix.set(prefixKey, byName)
  }
  let queue = byName.get(name)
  if (!queue) {
    queue = new Queue(name, { connection, ...(prefix ? { prefix } : {}) })
    // Route connection errors through pino (BullMQ's default is console.error).
    attachErrorListeners([queue], logger)
    byName.set(name, queue)
  }
  return queue
}

/** Close the cached queue handles for a connection (shutdown / tests). */
export async function closeRedriveQueues(connection: ConnectionOptions): Promise<void> {
  const byPrefix = queueCache.get(connection as object)
  if (!byPrefix) return
  queueCache.delete(connection as object)
  const closes: Promise<void>[] = []
  for (const byName of byPrefix.values()) {
    for (const queue of byName.values()) closes.push(queue.close())
  }
  await Promise.all(closes)
}

interface FoundJob {
  queue: QueueName
  id: string
  job: Job
  state: string
}

async function lookup(
  connection: ConnectionOptions,
  queue: QueueName,
  id: string,
  prefix?: string,
): Promise<FoundJob | null> {
  const job = await getQueue(connection, queue, prefix).getJob(id)
  if (!job) return null
  const state = await job.getState()
  return { queue, id, job, state }
}

function rootId(captureId: string): string {
  return `ingest-root_${captureId}`
}

function embedId(captureId: string): string {
  return `embed_${captureId}`
}

interface FlowJobs {
  root: FoundJob | null
  embed: FoundJob | null
  enrichment: FoundJob[]
}

function summarize({ root, embed, enrichment }: FlowJobs): FlowState {
  if (!root && !embed && enrichment.length === 0) return 'none'
  // The children are what runs; a root in waiting-children only waits on them.
  if (embed && IN_FLIGHT_STATES.has(embed.state)) return 'in-flight'
  if (enrichment.some(j => IN_FLIGHT_STATES.has(j.state))) return 'in-flight'
  if (root && root.state !== 'waiting-children' && IN_FLIGHT_STATES.has(root.state)) return 'in-flight'
  return 'finished'
}

async function lookupFlow(connection: ConnectionOptions, captureId: string, prefix?: string): Promise<FlowJobs> {
  const [root, embed, ...children] = await Promise.all([
    lookup(connection, INGEST_ROOT_QUEUE_NAME, rootId(captureId), prefix),
    lookup(connection, EMBED_QUEUE_NAME, embedId(captureId), prefix),
    ...ENRICHMENT_QUEUE_NAMES.map(q => lookup(connection, q, `${q}_${captureId}`, prefix)),
  ])
  return { root, embed, enrichment: children.filter((j): j is FoundJob => j !== null) }
}

/**
 * State of the retained ingest flow for a capture, from its root, embed and
 * enrichment jobs (see `summarize` and the module comment):
 *   'none'      — none of the five fixed-id jobs exists
 *   'in-flight' — the embed or an enrichment child is waiting / active / delayed /
 *                 prioritized / waiting-children, or the root is waiting / active /
 *                 delayed / prioritized
 *   'finished'  — otherwise (completed / failed / unknown jobs, or an orphaned
 *                 root in waiting-children)
 */
export async function getFlowState(
  connection: ConnectionOptions,
  captureId: string,
  prefix?: string,
): Promise<FlowState> {
  return summarize(await lookupFlow(connection, captureId, prefix))
}

/**
 * Re-drive a capture's flow. See the module comment for the exact semantics.
 * The in-flight check is repeated here (callers may have checked earlier) so a
 * flow that started in between is never disturbed.
 */
export async function redriveCapture(
  deps: RedriveDeps,
  captureId: string,
  opts: RedriveOptions,
): Promise<RedriveResult> {
  const { connection, prefix } = deps
  const log = logger.child({ captureId, traceId: opts.traceId, stage: opts.stage })

  const redis = await getQueue(connection, EMBED_QUEUE_NAME, prefix).client
  const lockKey = `${prefix ?? 'bull'}:redrive-lock:${captureId}`
  const token = randomUUID()
  const acquired = await redis.set(lockKey, token, 'PX', REDRIVE_LOCK_TTL_MS, 'NX')
  if (acquired !== 'OK') {
    log.warn('[redrive] another re-drive holds the lock — skipped')
    return { action: 'skipped', reason: 'locked' }
  }

  try {
    return await redriveLocked(deps, captureId, opts, log)
  } finally {
    await redis.eval(RELEASE_LOCK_LUA, 1, lockKey, token).catch((err: unknown) => {
      // The TTL frees it anyway; never mask the re-drive's own outcome.
      log.warn({ err }, '[redrive] lock release failed — expires with its TTL')
    })
  }
}

async function redriveLocked(
  deps: RedriveDeps,
  captureId: string,
  opts: RedriveOptions,
  log: Pick<typeof logger, 'info' | 'warn'>,
): Promise<RedriveResult> {
  const { connection, flowProducer, prefix } = deps
  const flow = await lookupFlow(connection, captureId, prefix)
  const { root, embed, enrichment } = flow

  if (summarize(flow) === 'in-flight') {
    log.warn(
      {
        jobs: [root, embed, ...enrichment].filter((j): j is FoundJob => j !== null).map(j => `${j.id}:${j.state}`),
      },
      '[redrive] flow in flight — skipped',
    )
    return { action: 'skipped', reason: 'in-flight' }
  }

  const removed: string[] = []

  // Root first, WITHOUT its children: the enrichment children stay retained
  // (and their fixed ids keep guarding against duplicate enrichment).
  if (root) {
    await root.job.remove({ removeChildren: false })
    removed.push(root.id)
  }
  if (embed) {
    await getQueue(connection, EMBED_QUEUE_NAME, prefix).remove(embed.id, { removeChildren: false })
    removed.push(embed.id)
  }

  // stage 'all' — remove each finished enrichment child by id, in its own queue.
  if (opts.stage === 'all') {
    for (const child of enrichment) {
      await getQueue(connection, child.queue, prefix).remove(child.id, { removeChildren: false })
      removed.push(child.id)
    }
  }

  const ingestFlow =
    opts.stage === 'embed'
      ? buildIngestFlow(captureId, { embedOnly: true, traceId: opts.traceId })
      : buildIngestFlow(captureId, { includeWikiIngest: opts.includeWikiIngest, traceId: opts.traceId })
  try {
    await flowProducer.add(ingestFlow, { queuesOptions: INGEST_FLOW_QUEUES_OPTIONS })
  } catch (err) {
    // The retained jobs are already gone: the next sweep / retry sees 'none'
    // (or only enrichment children) and adds the flow again.
    log.warn({ captureId, err, removed }, '[redrive] flow add failed after removal')
    throw err
  }
  log.info({ removed }, opts.stage === 'embed' ? '[redrive] embed-only flow added' : '[redrive] full flow added')
  return { action: 'redriven', stage: opts.stage, removed }
}
