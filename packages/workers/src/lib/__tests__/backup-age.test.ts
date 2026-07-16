import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the two side effects: fs.stat (the manifest) and the Pushgateway push.
vi.mock('node:fs/promises', () => ({ stat: vi.fn() }))
vi.mock('../push-metrics.js', () => ({ pushMetrics: vi.fn().mockResolvedValue(undefined) }))

import { stat } from 'node:fs/promises'
import { pushMetrics } from '../push-metrics.js'
import type { MetricLine } from '../push-metrics.js'
import { pushBackupAgeGauge } from '../backup-age.js'

const statMock = stat as unknown as ReturnType<typeof vi.fn>
const pushMock = pushMetrics as unknown as ReturnType<typeof vi.fn>

function backupGaugePush(): MetricLine | undefined {
  const calls = pushMock.mock.calls as [MetricLine[]][]
  const hit = calls.find(([metrics]) => metrics.some((m) => m.name === 'openbrain_backup_age_seconds'))
  return hit?.[0].find((m) => m.name === 'openbrain_backup_age_seconds')
}

describe('pushBackupAgeGauge', () => {
  beforeEach(() => vi.clearAllMocks())

  it('pushes openbrain_backup_age_seconds (gauge) and returns the age when the manifest exists', async () => {
    statMock.mockResolvedValue({ mtime: new Date(Date.now() - 3_600_000) }) // 1h old
    const age = await pushBackupAgeGauge('/x/manifest.json')
    expect(age).toBeGreaterThanOrEqual(3595)
    expect(age).toBeLessThanOrEqual(3605)
    const gauge = backupGaugePush()
    expect(gauge).toBeTruthy()
    expect(gauge?.type).toBe('gauge')
    expect(gauge?.value).toBe(age)
  })

  it('returns null and does NOT push when the manifest is absent', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const age = await pushBackupAgeGauge('/missing/manifest.json')
    expect(age).toBeNull()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('clamps a future mtime to a non-negative age', async () => {
    statMock.mockResolvedValue({ mtime: new Date(Date.now() + 60_000) }) // clock skew
    const age = await pushBackupAgeGauge('/x/manifest.json')
    expect(age).toBe(0)
  })
})
