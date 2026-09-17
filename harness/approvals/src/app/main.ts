import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { createDb, loadKey } from '@harness/db';
import { outRoot } from '@harness/core-tools/storage';
import { createLogger, numberFromEnv, requiredEnv } from '@harness/shared';
import { surfaceSinks } from '../domain/sinks.js';
import { loadSurfaces } from '../domain/surfaces/registry.js';
import { createMcpCoreToolsClient } from '../domain/execute/mcp-client.js';
import { registerApprovalHandlers } from '../domain/handlers.js';
import { collectHealth, startRunner } from '../domain/runner.js';
import { DEFAULT_HEALTH_BIND, startHealthServer } from '../domain/health.js';
import { coreToolsChildEnv } from './child-env.js';

const log = createLogger('approvals');

// One level deeper than the package's `src/`, so four segments up is the
// repository root: src/app -> src -> approvals -> harness -> <repo>.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

const seconds = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 86_400, unit: 'seconds' });

const port = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 65_535, integer: true });

/**
 * Which messaging surfaces this host serves, comma-separated package names, the first of them
 * primary. Same shape as the kernel's `HARNESS_PACKS`.
 *
 * **Required, with no default.** `requiredEnv` fails startup naming the variable when it is unset
 * or empty, and `loadSurfaces` refuses a list that trims away to nothing — also naming it. A
 * default here would be a package name in host source, which is the one coupling this task
 * removes, and it would post approval cards somewhere the deployment never asked for. The demo's
 * value is supplied where a deployment's defaults belong: Compose sets it on the service, and
 * `.env.example` documents it.
 */
function surfaceNames(): string[] {
  return requiredEnv('HARNESS_SURFACES')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

const client = process.env.HARNESS_CLIENT ?? 'default';
const storageRoot = requiredEnv('HARNESS_STORAGE_DIR');

const { db, close: closeDb } = createDb();

// Connected before anything else is built: the child environment subtracts the credentials the
// loaded adapters declare, and the runner posts through them.
const surfaces = await loadSurfaces(surfaceNames(), { env: process.env, log, storageDir: storageRoot });

const core = createMcpCoreToolsClient({
  command: 'pnpm',
  args: ['--dir', repoRoot, '--filter', '@harness/core-tools', 'start'],
  env: coreToolsChildEnv({ env: process.env, client, storageRoot, surfaceSecrets: surfaces.secrets }),
});

const deps = {
  db,
  surfaces,
  core,
  // The out tree, not the whole store. A release already narrows to `<root>/out`, and a backstop
  // that accepts more than the thing it backs up is not a backstop: the rest of the store holds
  // ingested documents, which must never be uploadable.
  sinks: surfaceSinks(surfaces, { outDir: outRoot(storageRoot) }),
  client,
  encryptionKey: loadKey(),
  now: () => new Date(),
};

// Every loaded surface, not only the primary one: cards are posted in one place, but a decision
// is accepted from whichever surface posted the card.
for (const session of surfaces.all) registerApprovalHandlers(session, deps);

const runner = startRunner(deps, {
  pollMs: seconds('APPROVALS_POLL_SECONDS', 5) * 1000,
  dispatchMs: seconds('EFFECTS_DISPATCH_SECONDS', 5) * 1000,
  reconcileMs: seconds('RECONCILE_SECONDS', 300) * 1000,
  staleAfterMinutes: 10,
});

const health = startHealthServer({
  port: port('APPROVALS_HEALTH_PORT', 8787),
  // Every interface by default. In Compose nothing can reach a listener on the container's own
  // loopback — not the published host port, not `http://approvals:8787` from Hermes — and the
  // exposure boundary is the port mapping, which is pinned to 127.0.0.1 on the host. Override for
  // a bare-metal run where the process itself is the boundary.
  bind: process.env.APPROVALS_HEALTH_BIND?.trim() || DEFAULT_HEALTH_BIND,
  snapshot: () => collectHealth(db, client, runner, deps.now),
});

for (const session of surfaces.all) await session.start();
log.info(
  `listening (client=${client}, surfaces=${surfaces.all.map((s) => s.name).join(',')}, primary=${surfaces.primary.name} on ${surfaces.primary.defaultConversation})`,
);

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received, stopping`);
  try {
    await runner.stop();
    await health.close();
    for (const session of surfaces.all) await session.stop();
    await core.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    log.error('shutdown failed', err);
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
