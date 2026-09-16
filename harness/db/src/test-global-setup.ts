import { runMigrations } from './domain/migrate.js';
import { TEST_DATABASE_URL } from './testing.js';

export default async function setup(): Promise<void> {
  await runMigrations(TEST_DATABASE_URL);
}
