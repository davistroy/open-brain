import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildIngestFlow, INGEST_ROOT_QUEUE_NAME } from '../flows/ingest-pipeline.js'
import type { FlowState } from '../flows/redrive.js'
import { processIngestionJob } from '../jobs/ingestion-worker.js'
import type { IngestDedup } from '../lib/ingest-dedup.js'
import type { FlowJob } from 'bullmq'

describe('buildIngestFlow', () => {
  const captureId = 'cap-test-123'
  let flow: FlowJob

  // Build once for all tests in this describe block
  flow = buildIngestFlow(captureId)

  it('returns a FlowJob with ingest-root as the parent', () => {
    expect(flow.name).toBe('ingest-root')
    expect(flow.queueName).toBe(INGEST_ROOT_QUEUE_NAME)
    expect(flow.data).toEqual({ captureId, traceId: undefined })
  })

  it('sets idempotent jobId on the root node', () => {
    expect(flow.opts?.jobId).toBe(`ingest-root_${captureId}`)
  })

  it('has exactly three children by default: embed-capture, extract-entities, extract-commitments', () => {
    expect(flow.children).toHaveLength(3)

    const queueNames = flow.children!.map(c => c.queueName).sort()
    expect(queueNames).toEqual(['embed-capture', 'extract-commitments', 'extract-entities'])
  })

  it('sets failParentOnFailure on embed-capture child', () => {
    const embedChild = flow.children!.find(c => c.queueName === 'embed-capture')!
    expect(embedChild.opts?.failParentOnFailure).toBe(true)
  })

  it('sets removeDependencyOnFailure on extract-entities child', () => {
    const extractChild = flow.children!.find(c => c.queueName === 'extract-entities')!
    expect(extractChild.opts?.removeDependencyOnFailure).toBe(true)
  })

  it('does NOT set failParentOnFailure on extract-entities', () => {
    const extractChild = flow.children!.find(c => c.queueName === 'extract-entities')!
    expect(extractChild.opts?.failParentOnFailure).toBeUndefined()
  })

  it('sets removeDependencyOnFailure on extract-commitments child', () => {
    const commitmentsChild = flow.children!.find(c => c.queueName === 'extract-commitments')!
    expect(commitmentsChild.opts?.removeDependencyOnFailure).toBe(true)
  })

  it('does NOT set failParentOnFailure on extract-commitments', () => {
    const commitmentsChild = flow.children!.find(c => c.queueName === 'extract-commitments')!
    expect(commitmentsChild.opts?.failParentOnFailure).toBeUndefined()
  })

  it('sets correct captureId and traceId data on all children', () => {
    for (const child of flow.children!) {
      expect(child.data).toEqual({ captureId, traceId: undefined })
    }
  })

  it('sets idempotent jobIds on children matching existing conventions', () => {
    const embedChild = flow.children!.find(c => c.queueName === 'embed-capture')!
    expect(embedChild.opts?.jobId).toBe(`embed_${captureId}`)

    const extractChild = flow.children!.find(c => c.queueName === 'extract-entities')!
    expect(extractChild.opts?.jobId).toBe(`extract-entities_${captureId}`)

    const commitmentsChild = flow.children!.find(c => c.queueName === 'extract-commitments')!
    expect(commitmentsChild.opts?.jobId).toBe(`extract-commitments_${captureId}`)
  })

  it('sets 5 attempts with custom backoff on embed and extract children', () => {
    const embedChild = flow.children!.find(c => c.queueName === 'embed-capture')!
    const extractChild = flow.children!.find(c => c.queueName === 'extract-entities')!

    expect(embedChild.opts?.attempts).toBe(5)
    expect(embedChild.opts?.backoff).toEqual({ type: 'custom' })
    expect(extractChild.opts?.attempts).toBe(5)
    expect(extractChild.opts?.backoff).toEqual({ type: 'custom' })
  })

  it('generates unique flows for different captureIds', () => {
    const flow1 = buildIngestFlow('cap-aaa')
    const flow2 = buildIngestFlow('cap-bbb')

    expect(flow1.opts?.jobId).not.toBe(flow2.opts?.jobId)
    expect(flow1.data).toEqual({ captureId: 'cap-aaa', traceId: undefined })
    expect(flow2.data).toEqual({ captureId: 'cap-bbb', traceId: undefined })
  })

  it('propagates traceId to root and all children when provided', () => {
    const traceId = 'trace-abc-123'
    const flow = buildIngestFlow(captureId, { traceId })

    expect(flow.data).toEqual({ captureId, traceId })
    for (const child of flow.children!) {
      expect(child.data).toEqual(expect.objectContaining({ captureId, traceId }))
    }
  })

  it('sets traceId to undefined on all nodes when not provided', () => {
    const flow = buildIngestFlow(captureId)

    expect(flow.data).toEqual({ captureId, traceId: undefined })
    for (const child of flow.children!) {
      expect(child.data).toHaveProperty('traceId', undefined)
    }
  })
})

describe('buildIngestFlow with wiki-ingest', () => {
  const captureId = 'cap-wiki-test'

  it('does not include wiki-ingest child by default', () => {
    const flow = buildIngestFlow(captureId)
    const wikiChild = flow.children!.find(c => c.queueName === 'wiki-ingest')
    expect(wikiChild).toBeUndefined()
    expect(flow.children).toHaveLength(3)
  })

  it('does not include wiki-ingest when includeWikiIngest is false', () => {
    const flow = buildIngestFlow(captureId, { includeWikiIngest: false })
    const wikiChild = flow.children!.find(c => c.queueName === 'wiki-ingest')
    expect(wikiChild).toBeUndefined()
    expect(flow.children).toHaveLength(3)
  })

  it('adds wiki-ingest as fourth child when includeWikiIngest is true', () => {
    const flow = buildIngestFlow(captureId, { includeWikiIngest: true })
    expect(flow.children).toHaveLength(4)

    const queueNames = flow.children!.map(c => c.queueName).sort()
    expect(queueNames).toEqual(['embed-capture', 'extract-commitments', 'extract-entities', 'wiki-ingest'])
  })

  it('sets removeDependencyOnFailure on wiki-ingest child', () => {
    const flow = buildIngestFlow(captureId, { includeWikiIngest: true })
    const wikiChild = flow.children!.find(c => c.queueName === 'wiki-ingest')!
    expect(wikiChild.opts?.removeDependencyOnFailure).toBe(true)
  })

  it('does NOT set failParentOnFailure on wiki-ingest', () => {
    const flow = buildIngestFlow(captureId, { includeWikiIngest: true })
    const wikiChild = flow.children!.find(c => c.queueName === 'wiki-ingest')!
    expect(wikiChild.opts?.failParentOnFailure).toBeUndefined()
  })

  it('sets 3 attempts with exponential backoff on wiki-ingest', () => {
    const flow = buildIngestFlow(captureId, { includeWikiIngest: true })
    const wikiChild = flow.children!.find(c => c.queueName === 'wiki-ingest')!
    expect(wikiChild.opts?.attempts).toBe(3)
    expect(wikiChild.opts?.backoff).toEqual({ type: 'exponential', delay: 15_000 })
  })

  it('sets correct jobId and data on wiki-ingest child', () => {
    const flow = buildIngestFlow(captureId, { includeWikiIngest: true })
    const wikiChild = flow.children!.find(c => c.queueName === 'wiki-ingest')!
    expect(wikiChild.opts?.jobId).toBe(`wiki-ingest_${captureId}`)
    expect(wikiChild.data).toEqual({ captureId, traceId: undefined })
  })

  it('propagates traceId to wiki-ingest child when provided', () => {
    const traceId = 'trace-wiki-456'
    const flow = buildIngestFlow(captureId, { includeWikiIngest: true, traceId })
    const wikiChild = flow.children!.find(c => c.queueName === 'wiki-ingest')!
    expect(wikiChild.data).toEqual({ captureId, traceId })
  })
})

describe('buildIngestFlow with embedOnly (re-drive, item 9.1)', () => {
  const captureId = 'cap-embed-only'

  it('returns the root job and the embed child only', () => {
    const flow = buildIngestFlow(captureId, { embedOnly: true, traceId: 'trace-eo' })
    expect(flow.name).toBe('ingest-root')
    expect(flow.queueName).toBe(INGEST_ROOT_QUEUE_NAME)
    expect(flow.opts?.jobId).toBe(`ingest-root_${captureId}`)
    expect(flow.data).toEqual({ captureId, traceId: 'trace-eo' })
    expect(flow.children).toHaveLength(1)

    const [embed] = flow.children!
    expect(embed.queueName).toBe('embed-capture')
    expect(embed.opts?.jobId).toBe(`embed_${captureId}`)
    expect(embed.opts?.failParentOnFailure).toBe(true)
    expect(embed.data).toEqual({ captureId, traceId: 'trace-eo' })
  })

  it('ignores includeWikiIngest — no enrichment child is ever included', () => {
    const flow = buildIngestFlow(captureId, { embedOnly: true, includeWikiIngest: true })
    expect(flow.children!.map(c => c.queueName)).toEqual(['embed-capture'])
  })

  it('embedOnly: false keeps the full DAG', () => {
    const flow = buildIngestFlow(captureId, { embedOnly: false })
    expect(flow.children).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// processIngestionJob — re-drive routing + forceRetry dedup bypass (item 9.1)
// ---------------------------------------------------------------------------

function makeIngestDb(capture: Record<string, unknown> | undefined) {
  const updateWhere = vi.fn().mockResolvedValue(undefined)
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere })
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue(capture ? [capture] : []),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    update: vi.fn().mockReturnValue({ set: updateSet }),
  }
}

function makeCaptureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cap-r',
    content_hash: 'hash-r',
    pipeline_status: 'pending',
    pipeline_attempts: 0,
    source_metadata: null,
    ...overrides,
  }
}

function makeRedrive(state: FlowState) {
  return {
    getFlowState: vi.fn().mockResolvedValue(state),
    redriveCapture: vi.fn().mockResolvedValue({ action: 'redriven', stage: 'embed', removed: [] }),
  }
}

describe('processIngestionJob — re-drive routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('in-flight flow: returns without touching the capture or adding a flow', async () => {
    const db = makeIngestDb(makeCaptureRow())
    const flowProducer = { add: vi.fn().mockResolvedValue(undefined) }
    const redrive = makeRedrive('in-flight')

    await processIngestionJob({ captureId: 'cap-r' }, db as never, flowProducer as never, undefined, redrive)

    expect(redrive.getFlowState).toHaveBeenCalledWith('cap-r')
    expect(db.update).not.toHaveBeenCalled()
    expect(db.insert).not.toHaveBeenCalled()
    expect(flowProducer.add).not.toHaveBeenCalled()
    expect(redrive.redriveCapture).not.toHaveBeenCalled()
  })

  it('no retained flow, status pending: adds the full flow as before', async () => {
    const db = makeIngestDb(makeCaptureRow())
    const flowProducer = { add: vi.fn().mockResolvedValue(undefined) }
    const redrive = makeRedrive('none')

    await processIngestionJob({ captureId: 'cap-r' }, db as never, flowProducer as never, undefined, redrive)

    expect(flowProducer.add).toHaveBeenCalledTimes(1)
    expect(flowProducer.add.mock.calls[0][0].children).toHaveLength(3)
    expect(redrive.redriveCapture).not.toHaveBeenCalled()
  })

  it('finished flow: re-drives the embed only (no stage)', async () => {
    const db = makeIngestDb(makeCaptureRow({ pipeline_status: 'processing', source_metadata: { trace_id: 't-1' } }))
    const flowProducer = { add: vi.fn().mockResolvedValue(undefined) }
    const redrive = makeRedrive('finished')

    await processIngestionJob({ captureId: 'cap-r' }, db as never, flowProducer as never, undefined, redrive)

    expect(flowProducer.add).not.toHaveBeenCalled()
    expect(redrive.redriveCapture).toHaveBeenCalledWith('cap-r', {
      stage: 'embed',
      includeWikiIngest: !!process.env.WIKI_REPO_URL,
      traceId: 't-1',
    })
  })

  it("status 'extracted' with no retained flow: re-drives instead of a full add", async () => {
    const db = makeIngestDb(makeCaptureRow({ pipeline_status: 'extracted' }))
    const flowProducer = { add: vi.fn().mockResolvedValue(undefined) }
    const redrive = makeRedrive('none')

    await processIngestionJob({ captureId: 'cap-r' }, db as never, flowProducer as never, undefined, redrive)

    expect(flowProducer.add).not.toHaveBeenCalled()
    expect(redrive.redriveCapture).toHaveBeenCalledWith('cap-r', expect.objectContaining({ stage: 'embed' }))
  })

  it("stage 'all': re-drives with stage 'all' even with no retained flow", async () => {
    const db = makeIngestDb(makeCaptureRow())
    const flowProducer = { add: vi.fn().mockResolvedValue(undefined) }
    const redrive = makeRedrive('none')

    await processIngestionJob(
      { captureId: 'cap-r', stage: 'all' },
      db as never,
      flowProducer as never,
      undefined,
      redrive,
    )

    expect(flowProducer.add).not.toHaveBeenCalled()
    expect(redrive.redriveCapture).toHaveBeenCalledWith('cap-r', expect.objectContaining({ stage: 'all' }))
  })

  it('no redrive hooks injected: behaves as before (full flow add)', async () => {
    const db = makeIngestDb(makeCaptureRow({ pipeline_status: 'extracted' }))
    const flowProducer = { add: vi.fn().mockResolvedValue(undefined) }

    await processIngestionJob({ captureId: 'cap-r' }, db as never, flowProducer as never)

    expect(flowProducer.add).toHaveBeenCalledTimes(1)
  })
})

describe('processIngestionJob — forceRetry skips the 5-minute dedup window', () => {
  it('a duplicate hash is dropped without forceRetry', async () => {
    const db = makeIngestDb(makeCaptureRow())
    const flowProducer = { add: vi.fn().mockResolvedValue(undefined) }
    const dedup = { isDuplicate: vi.fn().mockResolvedValue(true) } as unknown as IngestDedup

    await processIngestionJob({ captureId: 'cap-r' }, db as never, flowProducer as never, dedup)

    expect(dedup.isDuplicate).toHaveBeenCalled()
    expect(flowProducer.add).not.toHaveBeenCalled()
  })

  it('forceRetry: the dedup check is not consulted and the pipeline runs', async () => {
    const db = makeIngestDb(makeCaptureRow({ pipeline_status: 'failed' }))
    const flowProducer = { add: vi.fn().mockResolvedValue(undefined) }
    const dedup = { isDuplicate: vi.fn().mockResolvedValue(true) } as unknown as IngestDedup

    await processIngestionJob(
      { captureId: 'cap-r', forceRetry: true },
      db as never,
      flowProducer as never,
      dedup,
    )

    expect(dedup.isDuplicate).not.toHaveBeenCalled()
    expect(flowProducer.add).toHaveBeenCalledTimes(1)
  })
})
