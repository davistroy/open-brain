import { describe, it, expect } from 'vitest'
import { buildIngestFlow, INGEST_ROOT_QUEUE_NAME } from '../flows/ingest-pipeline.js'
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
