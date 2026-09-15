import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../drizzle');

export async function runMigrations(url?: string): Promise<void> {
  const { db, close } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // CLI only: tests call runMigrations() with an explicit URL and must not pick
  // up the developer's repository-root .env.
  loadEnv({ path: path.resolve(here, '../../../.env'), quiet: true });
  runMigrations()
    .then(() => {
      console.log('migrations applied');
    })
    .catch((err: unknown) => {
      console.error(`migration failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
