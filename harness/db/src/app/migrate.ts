import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { createLogger } from '@harness/shared';
import { runMigrations } from '../domain/migrate.js';

const log = createLogger('db');
const here = path.dirname(fileURLToPath(import.meta.url));

// CLI only: tests call runMigrations() with an explicit URL and must not pick
// up the developer's repository-root .env.
loadEnv({ path: path.resolve(here, '../../../../.env'), quiet: true });

runMigrations()
  .then(() => {
    log.info('migrations applied');
  })
  .catch((err: unknown) => {
    log.error('migration failed', err);
    process.exit(1);
  });
