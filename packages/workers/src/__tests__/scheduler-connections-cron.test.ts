import { describe, it, expect, vi } from 'vitest'

/**
 * Verifies that the daily-connections cron is correctly set.
 * P07: rescheduled from 7:00 AM to 6:10 AM to spread the morning job cluster.
 * We test this by reading the scheduler source and checking the cron value,
 * since BullMQ queue operations require a live Redis connection.
 */
describe('scheduler — daily-connections cron', () => {
  it('daily-connections cron is 10 6 * * * (daily 6:10 AM), not disabled', async () => {
    // Read the scheduler source to verify the cron value
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    const schedulerPath = join(import.meta.dirname, '..', 'scheduler.ts')
    const source = readFileSync(schedulerPath, 'utf-8')

    // P07: connectionsCron rescheduled to '10 6 * * *' (daily 6:10 AM)
    expect(source).toContain("const connectionsCron = '10 6 * * *'")
    // Should NOT contain the disabled Feb 29 cron
    expect(source).not.toContain("'0 0 29 2 *'")
    // Should NOT contain the old 7 AM cron
    expect(source).not.toContain("const connectionsCron = '0 7 * * *'")
  })

  it('JSDoc describes daily-connections as enabled at 6:10 AM (P07 spread)', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    const schedulerPath = join(import.meta.dirname, '..', 'scheduler.ts')
    const source = readFileSync(schedulerPath, 'utf-8')

    // JSDoc should describe it as active at 6:10 AM
    expect(source).toContain('daily-connections:        6:10 AM daily')
    expect(source).not.toContain('DISABLED')
  })
})
