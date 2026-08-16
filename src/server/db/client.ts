// Database client — a single shared pg Pool + Drizzle instance.
// Lazily initialized so the module can be imported in contexts where
// the DB is not required (e.g. unit tests of pure schema logic).

import 'dotenv/config'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import * as schema from './schema'

const { Pool } = pg

let _pool: pg.Pool | null = null
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

function getConnectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and ensure Docker Postgres is running (docker compose up -d).',
    )
  }
  return url
}

export function getDb() {
  if (!_db) {
    _pool = new Pool({ connectionString: getConnectionString() })
    _db = drizzle(_pool, { schema })
  }
  return _db
}

export async function closeDb(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
    _db = null
  }
}

export { schema }
