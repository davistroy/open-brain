import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '../schema/index.js'
import { logger } from '../lib/logger.js'

export interface DbConnection {
  db: ReturnType<typeof drizzle>
  pool: Pool
}

export type Database = DbConnection['db']

export interface CreateDbOptions {
  /** Server-side per-statement timeout for this pool's sessions. Unset = no timeout. */
  statementTimeoutMs?: number
}

export function createDb(connectionString: string, opts?: CreateDbOptions): DbConnection {
  const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ...(opts?.statementTimeoutMs ? { statement_timeout: opts.statementTimeoutMs } : {}),
  })

  // Without a listener, an error on an idle client (e.g. Postgres restart) is an uncaught exception.
  pool.on('error', (err) => {
    logger.error({ err }, '[db] idle client error')
  })

  return { db: drizzle(pool, { schema }), pool }
}
