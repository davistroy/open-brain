import { Queue } from 'bullmq'
import type { ConnectionOptions, FlowProducer, Job } from 'bullmq'
import { logger } from '@open-brain/shared'
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
 *   - In flight (root or embed waiting / active / delayed / prioritized /
 *     waiting-children): add nothing, return `skipped`.
 *   - stage 'embed' (default): remove ONLY the retained root (removeChildren:
 *     false) and the embed job, then add an embed-only flow (root + embed).
 *     The enrichment children (`extract-entities`, `extract-commitments`,
 *     `wiki-ingest`) are left untouched, so enrichment never re-runs — those
 *     are paid / non-idempotent (commitments insert with no dedup).
 *   - stage 'all': additionally look up each enrichment child by its fixed id in
 *     its own queue, skip when any is in flight, remove each finished one BY ID,
 *     then add the full flow. Never `removeChildren` — a child that failed with
 *     removeDependencyOnFailure is recorded nowhere on the parent, so a tree
 *     removal misses it and on re-add it re-attaches to the new root, which then
 *     waits forever.
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
  | { action: 'skipped'; reason: 'in-flight' }
  | { action: 'redriven'; stage: 'embed' | 'all'; removed: string[] }

const EMBED_QUEUE_NAME = 'embed-capture'
const ENRICHMENT_QUEUE_NAMES = ['extract-entities', 'extract-commitments', 'wiki-ingest'] as const

const IN_FLIGHT_STATES = new Set<string>(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'])

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

function summarize(jobs: Array<FoundJob | null>): FlowState {
  const present = jobs.filter((j): j is FoundJob => j !== null)
  if (present.length === 0) return 'none'
  if (present.some(j => IN_FLIGHT_STATES.has(j.state))) return 'in-flight'
  return 'finished'
}

async function lookupRootAndEmbed(
  connection: ConnectionOptions,
  captureId: string,
  prefix?: string,
): Promise<[FoundJob | null, FoundJob | null]> {
  return Promise.all([
    lookup(connection, INGEST_ROOT_QUEUE_NAME, rootId(captureId), prefix),
    lookup(connection, EMBED_QUEUE_NAME, embedId(captureId), prefix),
  ])
}

/**
 * State of the retained ingest flow for a capture, from its root and embed jobs.
 *   'none'      — neither `ingest-root_<id>` nor `embed_<id>` exists
 *   'in-flight' — either is waiting / active / delayed / prioritized / waiting-children
 *   'finished'  — at least one exists and none is in flight (completed / failed / unknown)
 */
export async function getFlowState(
  connection: ConnectionOptions,
  captureId: string,
  prefix?: string,
): Promise<FlowState> {
  return summarize(await lookupRootAndEmbed(connection, captureId, prefix))
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
  const { connection, flowProducer, prefix } = deps
  const log = logger.child({ captureId, traceId: opts.traceId, stage: opts.stage })

  const [root, embed] = await lookupRootAndEmbed(connection, captureId, prefix)

  const enrichment: FoundJob[] = []
  if (opts.stage === 'all') {
    const found = await Promise.all(
      ENRICHMENT_QUEUE_NAMES.map(q => lookup(connection, q, `${q}_${captureId}`, prefix)),
    )
    for (const f of found) if (f) enrichment.push(f)
  }

  if (summarize([root, embed, ...enrichment]) === 'in-flight') {
    log.info('[redrive] in flight')
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

  if (opts.stage === 'embed') {
    await flowProducer.add(buildIngestFlow(captureId, { embedOnly: true, traceId: opts.traceId }), {
      queuesOptions: INGEST_FLOW_QUEUES_OPTIONS,
    })
    log.info({ removed }, '[redrive] embed-only flow added')
    return { action: 'redriven', stage: 'embed', removed }
  }

  // stage 'all' — remove each finished enrichment child by id, in its own queue.
  for (const child of enrichment) {
    await getQueue(connection, child.queue, prefix).remove(child.id, { removeChildren: false })
    removed.push(child.id)
  }

  await flowProducer.add(
    buildIngestFlow(captureId, { includeWikiIngest: opts.includeWikiIngest, traceId: opts.traceId }),
    { queuesOptions: INGEST_FLOW_QUEUES_OPTIONS },
  )
  log.info({ removed }, '[redrive] full flow added')
  return { action: 'redriven', stage: 'all', removed }
}
