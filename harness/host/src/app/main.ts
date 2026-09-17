import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import {
  DEFAULT_HEALTH_BIND,
  collectHealth,
  createInProcessCoreToolsClient,
  loadSurfaces,
  registerApprovalHandlers,
  startHealthServer,
  startRunner,
  surfaceSinks,
} from '@harness/approvals';
import { buildKernelConfig, loadIdentity } from '@harness/core-tools';
import { outRoot } from '@harness/core-tools/storage';
import { createDb } from '@harness/db';
import { ConfigError, createLogger, envOrDefault, numberFromEnv, requiredEnv } from '@harness/shared';
import { attachMessageHandlers } from '../domain/conversation.js';
import type { Host } from '../domain/host.js';
import { readPersona } from '../domain/persona.js';
import { decisionDeps } from '../domain/resume.js';
import { loadRuntime } from '../domain/runtime/registry.js';
import { readSkillCatalogue } from '../domain/skills.js';

const log = createLogger('host');

// src/app -> src -> host -> harness -> <repo>. The same resolution the other entrypoints use.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

const seconds = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 86_400, unit: 'seconds' });
const port = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 65_535, integer: true });
const names = (raw: string): string[] =>
  raw
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');

const { db, close: closeDb } = createDb();
const config = await buildKernelConfig(process.env);
const clientDir = path.join(repoRoot, 'clients', config.client);

// The three plug-ins, by name. Identity first: the host's own principal has to be declared.
const identity = await loadIdentity(envOrDefault('HARNESS_IDENTITY', '@harness/identity-static'), {
  env: process.env,
  log,
  clientDir,
});
const servicePrincipalId = envOrDefault('HARNESS_HOST_PRINCIPAL', 'svc-host');
const servicePrincipal = await identity.get(servicePrincipalId);
if (!servicePrincipal || servicePrincipal.kind !== 'service') {
  throw new ConfigError(
    `HARNESS_HOST_PRINCIPAL names "${servicePrincipalId}", which the identity plug-in "${identity.name}" does not declare as a service`,
  );
}
const surfaces = await loadSurfaces(names(requiredEnv('HARNESS_SURFACES')), {
  env: process.env,
  log,
  storageDir: config.storageDir,
});
// Required, with no default: a default here would be a specific runtime plug-in's package name
// in host source, the coupling `HARNESS_SURFACES` already avoids for the same reason. The demo's
// value is a deployment default, supplied in `.env.example` and Compose, not in code.
const runtime = await loadRuntime(requiredEnv('HARNESS_RUNTIME'), {
  env: process.env,
  log,
  databaseUrl: requiredEnv('DATABASE_URL'),
  storageDir: config.storageDir,
});

const host: Host = {
  db,
  config,
  client: config.client,
  identity,
  surfaces,
  runtime,
  persona: await readPersona(clientDir),
  skills: await readSkillCatalogue(config.packs.skillsDirs()),
  model: { baseUrl: config.gateway.baseUrl, apiKey: config.gateway.apiKey, route: 'chat', fallbackRoute: 'reason' },
  budget: {
    maxModelCalls: numberFromEnv('HARNESS_RUN_MAX_MODEL_CALLS', 30, { min: 1, max: 1_000, integer: true }),
    maxToolCalls: numberFromEnv('HARNESS_RUN_MAX_TOOL_CALLS', 60, { min: 1, max: 5_000, integer: true }),
    timeoutMs: seconds('HARNESS_RUN_TIMEOUT_S', 600) * 1000,
    maxHistoryMessages: numberFromEnv('HARNESS_HISTORY_MAX_MESSAGES', 40, { min: 0, max: 500, integer: true }),
  },
  servicePrincipal,
  log,
  now: () => new Date(),
  active: new Map(),
};

const core = createInProcessCoreToolsClient({ db, config, client: config.client, servicePrincipal });
const deps = decisionDeps(host, core);
for (const session of surfaces.all) registerApprovalHandlers(session, deps);
attachMessageHandlers(host);

const runner = startRunner(
  {
    db,
    surfaces,
    core,
    sinks: surfaceSinks(surfaces, { outDir: outRoot(config.storageDir) }),
    client: config.client,
    encryptionKey: config.encryptionKey,
    now: host.now,
  },
  {
    pollMs: seconds('APPROVALS_POLL_SECONDS', 5) * 1000,
    dispatchMs: seconds('EFFECTS_DISPATCH_SECONDS', 5) * 1000,
    reconcileMs: seconds('RECONCILE_SECONDS', 300) * 1000,
    staleAfterMinutes: 10,
  },
);

const health = startHealthServer({
  port: port('APPROVALS_HEALTH_PORT', 8787),
  bind: process.env.APPROVALS_HEALTH_BIND?.trim() || DEFAULT_HEALTH_BIND,
  snapshot: () => collectHealth(db, config.client, runner, host.now),
});

for (const session of surfaces.all) await session.start();
log.info(
  `listening (client=${config.client}, principal=${servicePrincipal.id}, runtime=${runtime.name}, identity=${identity.name}, surfaces=${surfaces.all.map((s) => s.name).join(',')}, primary=${surfaces.primary.name} on ${surfaces.primary.defaultConversation}, skills=${host.skills.length})`,
);

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received, stopping`);
  try {
    for (const controller of host.active.values()) controller.abort();
    await runner.stop();
    await health.close();
    for (const session of surfaces.all) await session.stop();
    await runtime.stop();
    await identity.stop();
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
