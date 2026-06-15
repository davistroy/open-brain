import { describe, it, expect } from 'vitest'
import { ACCESS_STATS_JOB_OPTIONS } from '../lib/access-stats-options.js'

/**
 * DA-M3 parity guard — ensures the core-api access-stats Queue retains the same
 * defaultJobOptions as the workers-side consumer so completed/failed jobs are pruned
 * from Redis and don't accumulate unboundedly.
 */
describe('ACCESS_STATS_JOB_OPTIONS', () => {
  it('sets removeOnComplete to cap at 100 entries', () => {
    expect(ACCESS_STATS_JOB_OPTIONS.removeOnComplete).toEqual({ count: 100 })
  })

  it('sets removeOnFail to cap at 50 entries', () => {
    expect(ACCESS_STATS_JOB_OPTIONS.removeOnFail).toEqual({ count: 50 })
  })

  it('matches workers-side consumer defaults (parity guard)', () => {
    expect(ACCESS_STATS_JOB_OPTIONS).toMatchObject({
      priority: 1,
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    })
  })
})
