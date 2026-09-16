import { drizzle, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { createLogger } from '../shared/log.js';
import * as schema from './schema.js';

const log = createLogger('db');

/**
 * The database handle every tool and helper accepts. Widened from
 * NodePgDatabase so that a transaction handle (`tx` inside `db.transaction`)
 * is also a `Db`: handlers run inside a transaction and must not care.
 */
export type Db = PgDatabase<NodePgQueryResultHKT, typeof schema>;

export function createDb(url: string | undefined = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url });
  // An idle client that dies (server restart, network drop) emits on the pool;
  // without a listener node-postgres turns that into an unhandled 'error' event
  // and takes the process down.
  pool.on('error', (err) => {
    log.error('postgres pool error', err);
  });
  const db: Db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

// Type-level guarantee: a transaction handle is a Db. Fails to compile otherwise.
export async function withTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => fn(tx));
}
