import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url: string | undefined = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url });
  // An idle client that dies (server restart, network drop) emits on the pool;
  // without a listener node-postgres turns that into an unhandled 'error' event
  // and takes the process down.
  pool.on('error', (err) => {
    console.error('postgres pool error:', err.message);
  });
  const db: Db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
