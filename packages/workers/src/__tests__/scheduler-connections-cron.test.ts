import { describe, it, expect, vi } from 'vitest'

/**
 * Verifies that the daily-connections cron was re-enabled from the disabled
 * Feb-29-only cron to daily 7 AM. We test this by importing the scheduler
 * source and checking the cron value, since BullMQ queue operations require
 * a live Redis connection.
 */
describe('scheduler — daily-connections cron re-enablement', () => {
  it('daily-connections cron is 0 7 * * * (daily 7 AM), not disabled', async () => {
    // Read the scheduler source to verify the cron value
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    const schedulerPath = join(import.meta.dirname, '..', 'scheduler.ts')
    const source = readFileSync(schedulerPath, 'utf-8')

    // The connectionsCron should be '0 7 * * *' (daily 7 AM)
    expect(source).toContain("const connectionsCron = '0 7 * * *'")
    // Should NOT contain the disabled Feb 29 cron
    expect(source).not.toContain("'0 0 29 2 *'")
  })

  it('JSDoc describes daily-connections as enabled at 7 AM', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')

    const schedulerPath = join(import.meta.dirname, '..', 'scheduler.ts')
    const source = readFileSync(schedulerPath, 'utf-8')

    // JSDoc should describe it as active, not disabled
    expect(source).toContain('daily-connections: 7:00 AM daily')
    expect(source).not.toContain('DISABLED')
  })
})
