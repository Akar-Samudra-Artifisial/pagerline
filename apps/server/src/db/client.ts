import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

type Db = ReturnType<typeof drizzle<typeof schema>>

// Reuse one pool across Next dev hot reloads.
const globalForDb = globalThis as unknown as { pagerlineDb?: Db }

export function getDb(): Db {
  if (globalForDb.pagerlineDb) return globalForDb.pagerlineDb
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  // prepare: false — Neon's pooled endpoint (PgBouncer, transaction mode) cannot keep
  // named prepared statements across transactions; harmless for a direct local connection.
  const client = postgres(url, { max: 5, prepare: false })
  const db = drizzle(client, { schema })
  globalForDb.pagerlineDb = db
  return db
}

export { schema }
