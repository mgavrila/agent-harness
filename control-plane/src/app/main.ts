import { serve } from '@hono/node-server';
import { loadCatalog } from '@hf1/catalog';
import { connect } from '../domain/db/connect.js';
import { runMigrations } from '../domain/db/migrate.js';
import { organisationsService } from '../domain/organisations/service.js';
import { usersService } from '../domain/users/service.js';
import { loadEnv } from '../shared/env.js';
import { createOidcClient } from './auth/oidc.js';
import { createApp } from './server.js';

const env = loadEnv();
await runMigrations(env.DATABASE_URL);
const { db } = await connect(env.DATABASE_URL);
const { db: kernelDb } = await connect(env.KERNEL_DATABASE_URL);
if (!env.BLUEPRINTS_DIR) throw new Error('BLUEPRINTS_DIR is required until the shipped catalogue exists');
const catalog = await loadCatalog(env.BLUEPRINTS_DIR);
const log = {
  info: (m: string, meta?: unknown) => console.log(m, meta ?? ''),
  error: (m: string, e?: unknown) => console.error(m, e ?? ''),
};
const oidc = await createOidcClient(env);
const now = () => new Date();
const users = usersService(db, env.PLATFORM_SUPERADMINS);
const orgs = organisationsService(db, now);
const app = createApp({ env, db, kernelDb, catalog, log, now, oidc, users, orgs });
serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) =>
  log.info(`control plane listening on ${info.port}`),
);
