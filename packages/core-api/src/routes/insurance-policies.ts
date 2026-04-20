import type { Hono } from 'hono'
import { and, eq, gte, lte, isNull, or } from 'drizzle-orm'
import type { Database } from '@open-brain/shared'
import { insurancePolicies } from '@open-brain/shared'

/**
 * Register insurance policies API routes.
 *
 * GET /api/v1/insurance-policies
 *   Query params:
 *     policy_type  — filter by type (health | auto | home | umbrella)
 *     active_only  — boolean (default "true"); filters rows where
 *                    effective_date <= today AND (expiration_date IS NULL OR expiration_date >= today)
 *
 *   Response: { policies: InsurancePolicy[] }
 *
 * This endpoint is read-only. Writes are performed by
 * scripts/insurance-policy-extract.py (T0 Python, direct psycopg2).
 *
 * P22b gap analysis depends on this endpoint as its primary data source.
 */
export function registerInsurancePoliciesRoutes(app: Hono, db: Database): void {
  app.get('/api/v1/insurance-policies', async (c) => {
    const rawPolicyType = c.req.query('policy_type')
    const rawActiveOnly  = c.req.query('active_only')

    // Validate policy_type if provided
    const validTypes = ['health', 'auto', 'home', 'umbrella'] as const
    if (rawPolicyType && !validTypes.includes(rawPolicyType as (typeof validTypes)[number])) {
      return c.json(
        { error: 'Invalid policy_type', valid_types: validTypes },
        400,
      )
    }

    // active_only defaults to true; explicit "false" disables the date filter
    const activeOnly = rawActiveOnly !== 'false'

    // Build WHERE conditions
    const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

    const conditions = []

    if (rawPolicyType) {
      conditions.push(eq(insurancePolicies.policy_type, rawPolicyType))
    }

    if (activeOnly) {
      // effective_date <= today (or NULL — treat unset as always-effective)
      conditions.push(
        or(
          isNull(insurancePolicies.effective_date),
          lte(insurancePolicies.effective_date, today),
        ),
      )
      // expiration_date >= today (or NULL — treat unset as never-expiring)
      conditions.push(
        or(
          isNull(insurancePolicies.expiration_date),
          gte(insurancePolicies.expiration_date, today),
        ),
      )
    }

    const rows = conditions.length > 0
      ? await db.select().from(insurancePolicies).where(and(...conditions))
      : await db.select().from(insurancePolicies)

    return c.json({ policies: rows })
  })
}
