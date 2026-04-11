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
    expect(flow.data).toEqual({ captureId })
  })

  it('sets idempotent jobId on the root node', () => {
    expect(flow.opts?.jobId).toBe(`ingest-root_${captureId}`)
  })

  it('has exactly two children: embed-capture and extract-entities', () => {
    expect(flow.children).toHaveLength(2)

    const queueNames = flow.children!.map(c => c.queueName).sort()
    expect(queueNames).toEqual(['embed-capture', 'extract-entities'])
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

  it('sets correct captureId data on all children', () => {
    for (const child of flow.children!) {
      expect(child.data).toEqual({ captureId })
    }
  })

  it('sets idempotent jobIds on children matching existing conventions', () => {
    const embedChild = flow.children!.find(c => c.queueName === 'embed-capture')!
    expect(embedChild.opts?.jobId).toBe(`embed_${captureId}`)

    const extractChild = flow.children!.find(c => c.queueName === 'extract-entities')!
    expect(extractChild.opts?.jobId).toBe(`extract-entities_${captureId}`)
  })

  it('sets 5 attempts with custom backoff on children', () => {
    for (const child of flow.children!) {
      expect(child.opts?.attempts).toBe(5)
      expect(child.opts?.backoff).toEqual({ type: 'custom' })
    }
  })

  it('generates unique flows for different captureIds', () => {
    const flow1 = buildIngestFlow('cap-aaa')
    const flow2 = buildIngestFlow('cap-bbb')

    expect(flow1.opts?.jobId).not.toBe(flow2.opts?.jobId)
    expect(flow1.data).toEqual({ captureId: 'cap-aaa' })
    expect(flow2.data).toEqual({ captureId: 'cap-bbb' })
  })
})
