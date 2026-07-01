import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * SA-8 / SE-12: Enforce cron-slot uniqueness among workers' repeatable scheduled jobs.
 *
 * Reads scheduler.ts source, extracts every `const *Cron = '...'` declaration
 * (including the `?? default` form used for testable overrides), and asserts
 * that no two jobs can fire at the same (minute, hour, day-of-week).
 *
 * Sub-hourly crons (step-minute form, e.g. every 15 min) are excluded from
 * the uniqueness check — container-health fires many times per hour and would
 * produce false positives against every job that fires on :00, :15, :30, :45.
 *
 * A small allowlist covers accepted co-firing pairs documented in CLAUDE.md:
 *   - pipeline-health (every 6h, fires at 0/6/12/18:00) and wiki-synthesis
 *     (0 6 * * *) both fire at 6:00 AM daily; they are background maintenance
 *     jobs whose concurrency is intentional and has no ordering constraint.
 */

// ---------------------------------------------------------------------------
// Cron field expansion helpers
// ---------------------------------------------------------------------------

/**
 * Expand a single cron field string into the set of integer values it matches.
 * Supports wildcard, literal integer, step-form (N-step), range (N-M), and
 * comma-separated combinations.  The min/max args are inclusive bounds.
 */
function expandCronField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>()

  // Wildcard
  if (field === '*') {
    for (let i = min; i <= max; i++) values.add(i)
    return values
  }

  // Step: */N
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10)
    for (let i = min; i <= max; i += step) values.add(i)
    return values
  }

  // Comma list: a,b,c  (each part may itself be */N, N-M, or a literal)
  if (field.includes(',')) {
    for (const part of field.split(',')) {
      for (const v of expandCronField(part.trim(), min, max)) values.add(v)
    }
    return values
  }

  // Range: N-M
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(Number)
    for (let i = start; i <= end; i++) values.add(i)
    return values
  }

  // Literal integer
  values.add(parseInt(field, 10))
  return values
}

/** Returns true if at least one element of Set `a` is also present in Set `b`. */
function setsIntersect<T>(a: Set<T>, b: Set<T>): boolean {
  for (const v of a) if (b.has(v)) return true
  return false
}

/**
 * Returns true if the two 5-field cron strings can fire on the
 * same (minute, hour, day-of-week).  Day-of-month is intentionally
 * ignored: monthly jobs (0 9 1 * *, 0 10 1 * *) do not collide with
 * daily jobs in practice and the simplified (min, hr, dow) model is
 * sufficient to catch the slot-collision class this test targets.
 */
function cronsOverlap(cronA: string, cronB: string): boolean {
  const fieldsA = cronA.split(' ')
  const fieldsB = cronB.split(' ')

  const aMinutes = expandCronField(fieldsA[0], 0, 59)
  const bMinutes = expandCronField(fieldsB[0], 0, 59)
  const aHours   = expandCronField(fieldsA[1], 0, 23)
  const bHours   = expandCronField(fieldsB[1], 0, 23)
  const aDows    = expandCronField(fieldsA[4], 0, 6)
  const bDows    = expandCronField(fieldsB[4], 0, 6)

  return (
    setsIntersect(aMinutes, bMinutes) &&
    setsIntersect(aHours,   bHours)   &&
    setsIntersect(aDows,    bDows)
  )
}

/**
 * Returns true if the cron fires more than once per hour (sub-hourly).
 * Criteria: the minute field uses the step form (e.g. every-15-min) with
 * N < 60, or contains a comma (multiple minute values per hour-mark).
 */
function isSubHourlyCron(cron: string): boolean {
  const minuteField = cron.split(' ')[0]
  if (minuteField.startsWith('*/')) {
    return parseInt(minuteField.slice(2), 10) < 60
  }
  return minuteField.includes(',')
}

/** Stable canonical key for an unordered pair, used in the allowlist set. */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join(' || ')
}

// ---------------------------------------------------------------------------
// Accepted overlaps — co-firing pairs that are intentional (CLAUDE.md §BullMQ)
// ---------------------------------------------------------------------------
const ACCEPTED_OVERLAPS = new Set([
  // pipeline-health fires every 6h (0,6,12,18:00); wiki-synthesis fires at 6:00 AM daily.
  // Both fire at 6:00 AM — accepted, they are background maintenance jobs
  // with no ordering constraint; concurrent execution is by design.
  pairKey('0 */6 * * *', '0 6 * * *'),
])

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('scheduler cron-slot uniqueness (SA-8 / SE-12)', () => {
  // Read scheduler source once for all cases in this suite.
  const schedulerPath = join(import.meta.dirname, '..', 'scheduler.ts')
  const source = readFileSync(schedulerPath, 'utf-8')

  /**
   * Regex captures `const <name>Cron = ['"]<value>['"]` AND the override form
   * `const <name>Cron = someIdentifier ?? ['"]<value>['"]` used for the two
   * testable overrides (sweepCron, budgetCron).  The captured group [2] is
   * always the literal cron string (the default fallback).
   */
  const CRON_DECL_RE =
    /const\s+(\w+Cron)\s*=\s*(?:\w+\s*\?\?\s*)?['"]([^'"]+)['"]/g

  const cronMap: Record<string, string> = {}
  let match: RegExpExecArray | null
  while ((match = CRON_DECL_RE.exec(source)) !== null) {
    const [, name, value] = match
    cronMap[name] = value
  }

  // ------------------------------------------------------------------
  // Sanity: the regex must find a reasonable number of declarations.
  // If this fails the regex broke or the file was moved.
  // ------------------------------------------------------------------
  it('extracts at least 15 cron declarations from scheduler.ts', () => {
    const count = Object.keys(cronMap).length
    expect(count).toBeGreaterThanOrEqual(15)
  })

  // ------------------------------------------------------------------
  // Core invariant: no two business-level jobs share a firing slot.
  // ------------------------------------------------------------------
  it('no two repeatable scheduled jobs share the same firing slot (minute, hour, dow)', () => {
    const entries = Object.entries(cronMap)

    // Exclude sub-hourly heartbeat monitors (containerHealthCron fires every 15 min).
    // They fire on :00/:15/:30/:45 of every hour and would produce spurious
    // failures against every job that fires at those minutes.
    const businessJobs = entries.filter(([, cron]) => !isSubHourlyCron(cron))

    const collisions: string[] = []

    for (let i = 0; i < businessJobs.length; i++) {
      for (let j = i + 1; j < businessJobs.length; j++) {
        const [nameA, cronA] = businessJobs[i]
        const [nameB, cronB] = businessJobs[j]

        if (cronsOverlap(cronA, cronB)) {
          const key = pairKey(cronA, cronB)
          if (!ACCEPTED_OVERLAPS.has(key)) {
            collisions.push(
              `${nameA} (${cronA})  overlaps  ${nameB} (${cronB})`,
            )
          }
        }
      }
    }

    // All collisions are reported together so a single run shows every problem.
    expect(collisions).toEqual([])
  })

  // ------------------------------------------------------------------
  // Regression: the two fixed slots must use the corrected cron strings.
  // ------------------------------------------------------------------
  it('storageAuditCron is shifted to 15 3 * * 0 (Sunday 3:15 AM)', () => {
    expect(cronMap['storageAuditCron']).toBe('15 3 * * 0')
  })

  it('wikiLintCron is shifted to 30 4 * * 0 (Sunday 4:30 AM)', () => {
    expect(cronMap['wikiLintCron']).toBe('30 4 * * 0')
  })

  // ------------------------------------------------------------------
  // JSDoc parity: the top-of-function schedule block must match the consts.
  // Drift between JSDoc and code is the pattern that let these collisions
  // accumulate undetected (CLAUDE.md § BullMQ scheduler cron rule).
  // ------------------------------------------------------------------
  it('JSDoc lists storage-audit as 15 3 * * 0 (Sunday 3:15 AM)', () => {
    expect(source).toContain('(cron: 15 3 * * 0)')
  })

  it('JSDoc lists wiki-lint as 30 4 * * 0 (Sunday 4:30 AM)', () => {
    expect(source).toContain('(cron: 30 4 * * 0)')
  })
})
