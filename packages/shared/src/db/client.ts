import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '../schema/index.js'

export interface DbConnection {
  db: ReturnType<typeof drizzle>
  pool: Pool
}

export type Database = DbConnection['db']

export function createDb(connectionString: string): DbConnection {
  const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })

  return { db: drizzle(pool, { schema }), pool }
}
