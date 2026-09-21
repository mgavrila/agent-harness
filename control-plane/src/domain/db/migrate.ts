import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { connect } from './connect.js';

export async function runMigrations(url: string): Promise<void> {
  const { db, close } = await connect(url);
  try {
    await migrate(db, {
      migrationsFolder: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../drizzle'),
    });
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  await runMigrations(url);
}
