import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { DEFAULT_HEALTH_BIND, collectHealth, startHealthServer, type HealthPayload } from '@harness/approvals';
import {
  assertEmbedDims,
  configSourceNameFrom,
  loadConfigSource,
  loadSecretSource,
  secretSourceNameFrom,
} from '@harness/core-tools';
import { outRoot, storageRoot } from '@harness/core-tools/storage';
import { createDb } from '@harness/db';
import { createLogger, envOrDefault, numberFromEnv, optionalEnv } from '@harness/shared';
import { startRunApi } from '../domain/api/server.js';
import { DEFAULT_HOST_BIND, DEFAULT_HOST_PORT } from '../domain/api/types.js';
import { SHUTDOWN_DRAIN_MS } from '../domain/conversation.js';
import { createHost } from '../domain/tenancy/pool.js';

const log = createLogger('host');

// src/app -> src -> host -> harness -> <repo>. The .env this deployment was started with; a
// client is not here any more, and nothing below resolves one from this path (invariant 18).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

const port = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 65_535, integer: true });
const now = (): Date => new Date();

const { db, close: closeDb } = createDb();
const storageDir = storageRoot(process.env);
// Belt to the image's braces: the storage volume's layout comes from node.Dockerfile, but an
// operator who mounts a bare directory instead still gets both.
await mkdir(path.join(storageDir, 'incoming'), { recursive: true });
await mkdir(outRoot(storageDir), { recursive: true });
// The knowledge tables' embedding width is fixed by migration 0013; refuse to start rather than
// fail halfway through the first sync. One database, one check, whatever the tenancy.
await assertEmbedDims(db, numberFromEnv('HARNESS_EMBED_DIMS', 1_024, { min: 8, max: 2_000, integer: true }));

const source = await loadConfigSource(configSourceNameFrom(process.env), { env: process.env, log, db });
// Where a tenant's secrets come from: `env` reads this process's environment, `postgres` reads
// `client_secrets`. Required, with no default, for the reason `HARNESS_CONFIG_SOURCE` is.
const secrets = await loadSecretSource(secretSourceNameFrom(process.env), { env: process.env, log, db });
// Set: a dedicated host, serving one client and refusing every other. Unset: a pooled host,
// resolving the client per event.
const dedicatedClient = (optionalEnv('HARNESS_CLIENT') ?? '').trim() || null;
const pool = await createHost({ db, env: process.env, log, now, source, secrets, dedicatedClient });

const health = startHealthServer({
  port: port('APPROVALS_HEALTH_PORT', 8787),
  bind: process.env.APPROVALS_HEALTH_BIND?.trim() || DEFAULT_HEALTH_BIND,
  // One tenant: exactly the shape a container health check has always read. Several: the same
  // shape per tenant under `tenants`, because there is no single client to report (decision 13).
  snapshot: async (): Promise<HealthPayload> => {
    const entries = await Promise.all(
      [...pool.tenants.values()].map(
        async (tenant) => [tenant.clientId, await collectHealth(db, tenant.clientId, tenant.runner, now)] as const,
      ),
    );
    if (dedicatedClient !== null && entries.length === 1) return entries[0][1];
    // A dedicated host between tenants — its one client is reloading — has nothing serving, and
    // `every` over an empty list would call that healthy. `ok: false` is the true answer, and the
    // shape says which tenants there are, which is none.
    const serving = entries.length > 0 && entries.every(([, snapshot]) => snapshot.ok);
    return { ok: serving, tenants: Object.fromEntries(entries) };
  },
});

// The host's HTTP server: the run API (spec 5.8) below `/v1`, and every tenant's surface mounts
// below `/tenants` (spec section 4.6). It always listens, because a surface reached by a request
// has to be reachable whether or not this deployment uses the run API — and an empty
// HARNESS_HOST_TOKEN closes `/v1` rather than closing the socket. One listener per process,
// whatever the tenancy: it resolves the tenant a request belongs to per request.
const hostToken = (optionalEnv('HARNESS_HOST_TOKEN') ?? '').trim();
const runApi = startRunApi(pool, {
  token: hostToken,
  bind: envOrDefault('HARNESS_HOST_BIND', DEFAULT_HOST_BIND),
  port: port('HARNESS_HOST_PORT', DEFAULT_HOST_PORT),
});
await runApi.ready;

log.info(
  `listening (mode=${pool.resolver.mode}, tenants=${[...pool.tenants.keys()].join(',') || 'none'}, runApi=${hostToken === '' ? 'closed (set HARNESS_HOST_TOKEN)' : 'open'})`,
);

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received, stopping`);
  try {
    // Before the drain: nothing new is accepted while the turns in flight unwind, and the open
    // event streams are closed rather than holding the shutdown for as long as a caller listens.
    await runApi.close();
    // Abort every tenant's turns and wait for them, bounded, before anything they are still
    // using goes away: each tenant's `close` ends its runtime and `closeDb` the pool they share,
    // and a turn that loses that race leaves its `runs` row `running` with nothing to sweep it.
    await pool.drain(SHUTDOWN_DRAIN_MS);
    await pool.close();
    await health.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    log.error('shutdown failed', err);
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
