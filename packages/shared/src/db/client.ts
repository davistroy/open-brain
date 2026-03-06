import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from '../schema/index.js'

export type Database = ReturnType<typeof createDb>

export function createDb(connectionString: string): ReturnType<typeof drizzle> {
  const pool = new Pool({
    connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  })

  return drizzle(pool, { schema })
}
