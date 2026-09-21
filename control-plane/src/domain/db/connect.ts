import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export async function connect(url: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  await pool.query('SELECT 1');
  return { db: drizzle(pool, { schema }), close: () => pool.end() };
}

export function withTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction((tx) => fn(tx as unknown as Db));
}
