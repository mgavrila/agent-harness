import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../../drizzle');

export async function runMigrations(url?: string): Promise<void> {
  const { db, close } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
