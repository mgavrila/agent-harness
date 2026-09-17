import { runMigrations } from '@harness/db';
import { TEST_DATABASE_URL } from '@harness/db/testing';

export default async function setup(): Promise<void> {
  await runMigrations(TEST_DATABASE_URL);
}
