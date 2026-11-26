import { describe, it, expect } from 'vitest'
import {
  CAPTURE_PIPELINE_JOB_OPTIONS,
  SKILL_EXECUTION_JOB_OPTIONS,
  DOCUMENT_PIPELINE_JOB_OPTIONS,
  INGEST_PROCESS_JOB_OPTIONS,
  WIKI_INGEST_JOB_OPTIONS,
} from '../lib/queue-job-options.js'

// Expected values are INLINED: core-api does not import @open-brain/workers.
// They must equal packages/workers/src/queues/<queue>.ts defaultJobOptions.
const FOURTEEN_DAYS = 1_209_600

const cases = [
  ['capture-pipeline', CAPTURE_PIPELINE_JOB_OPTIONS, { priority: 5, attempts: 5, backoff: { type: 'custom' }, removeOnComplete: { count: 500 } }],
  ['skill-execution', SKILL_EXECUTION_JOB_OPTIONS, { priority: 3, attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: { count: 200 } }],
  ['document-pipeline', DOCUMENT_PIPELINE_JOB_OPTIONS, { priority: 4, attempts: 5, backoff: { type: 'custom' }, removeOnComplete: { count: 200 } }],
  ['ingest-process', INGEST_PROCESS_JOB_OPTIONS, { priority: 6, attempts: 5, backoff: { type: 'custom' }, removeOnComplete: { count: 200 } }],
  ['wiki-ingest', WIKI_INGEST_JOB_OPTIONS, { priority: 4, attempts: 3, backoff: { type: 'exponential', delay: 15_000 }, removeOnComplete: { count: 200 } }],
] as const

describe('core-api queue job options (item 9.3)', () => {
  it.each(cases)('%s matches the workers-side factory', (_name, actual, expected) => {
    expect(actual).toEqual({ ...expected, removeOnFail: { age: FOURTEEN_DAYS, count: 100 } })
  })

  it.each(cases)('%s has a bounded removeOnComplete and an age-bounded removeOnFail', (_name, actual) => {
    expect(actual.removeOnComplete.count).toBeGreaterThan(0)
    expect(actual.removeOnFail.age).toBe(FOURTEEN_DAYS)
  })
})
