import { sql, type SQL } from 'drizzle-orm'

/**
 * Build a Postgres `ARRAY[$1, $2, …]::uuid[]` literal from a JS string array,
 * for use with `= ANY(...)`.
 *
 * WHY: writing `sql`… = ANY(${jsArray}::uuid[])`` makes drizzle interpolate the
 * JS array as a ROW constructor `($1, $2, …)`, so the runtime SQL becomes
 * `ANY(($1, $2, …)::uuid[])` and Postgres throws
 * `cannot cast type record to uuid[]` — silently breaking the query. Building an
 * explicit `ARRAY[...]::uuid[]` (each element its own bound param) avoids that.
 *
 * Empty input renders `ARRAY[]::uuid[]` (a valid empty uuid array).
 */
export function pgUuidArray(ids: string[]): SQL {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`
}
