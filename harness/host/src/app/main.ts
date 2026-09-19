import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
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
import { assertEmbedDims, buildKernelConfig, loadIdentity } from '@harness/core-tools';
import { outRoot } from '@harness/core-tools/storage';
import { parsePlaybooksFile, type PlaybookDefinition } from '@harness/config-api';
import { createDb } from '@harness/db';
import { parseIdentityFileWithDefaults } from '@harness/identity-api';
import {
  ConfigError,
  createLogger,
  describeError,
  envOrDefault,
  numberFromEnv,
  optionalEnv,
  requiredEnv,
} from '@harness/shared';
import { startRunApi } from '../domain/api/server.js';
import { DEFAULT_HOST_BIND, DEFAULT_HOST_PORT } from '../domain/api/types.js';
import { SHUTDOWN_DRAIN_MS, TIMEOUT_MARGIN_MS, attachMessageHandlers, drainActive } from '../domain/conversation.js';
import type { Host } from '../domain/host.js';
import { readPersona } from '../domain/persona.js';
import { syncPlaybooks } from '../domain/playbooks/repository.js';
import { SCHEDULER_TICK_MS, startScheduler } from '../domain/playbooks/scheduler.js';
import { decisionDeps } from '../domain/resume.js';
import { loadRuntime } from '../domain/runtime/registry.js';
import { kernelSkillsDir, readSkillCatalogue } from '../domain/skills.js';

const log = createLogger('host');

// src/app -> src -> host -> harness -> <repo>. The same resolution the other entrypoints use.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

const seconds = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 86_400, unit: 'seconds' });
const port = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 65_535, integer: true });
const now = (): Date => new Date();
const names = (raw: string): string[] =>
  raw
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n !== '');

const { db, close: closeDb } = createDb();
const config = await buildKernelConfig(process.env);
// Belt to the image's braces (decision 4): the storage volume's layout comes from
// node.Dockerfile, but an operator who mounts a bare directory instead still gets both.
await mkdir(path.join(config.storageDir, 'incoming'), { recursive: true });
await mkdir(outRoot(config.storageDir), { recursive: true });
// Derived by the kernel from HARNESS_CLIENT (spec section 7), so the host and core-tools cannot
// disagree about where a client's files are.
const clientDir = config.clientDir;
// The knowledge tables' embedding width is fixed by migration 0013; refuse to start rather than
// fail halfway through the first sync.
await assertEmbedDims(db, config.embedDims);

// The three plug-ins, by name. Identity first: the host's own principal has to be declared.
// Task 6 replaces this read with the resolved client document's `identity` section, loaded
// through the ConfigSource; a plug-in is never handed a path.
const identitySection = parseIdentityFileWithDefaults(
  parseYaml(await readFile(path.join(clientDir, 'identity.yaml'), 'utf8')),
);
const identity = await loadIdentity(envOrDefault('HARNESS_IDENTITY', '@harness/identity-static'), {
  env: process.env,
  log,
  identity: identitySection,
  settings: {},
});
const servicePrincipalId = envOrDefault('HARNESS_HOST_PRINCIPAL', 'svc-host');
const servicePrincipal = await identity.get(servicePrincipalId);
if (!servicePrincipal || servicePrincipal.kind !== 'service') {
  throw new ConfigError(
    `HARNESS_HOST_PRINCIPAL names "${servicePrincipalId}", which the identity plug-in "${identity.name}" does not declare as a service`,
  );
}
// The file into the table, once per start, and before a surface or the runtime connects: a
// playbook edited, added or removed in clients/<name>/playbooks.yaml takes effect on the next
// start, a firing missed while the process was down is not replayed (next_run_at is recomputed
// from now), and a malformed file fails startup with no socket open and no message accepted.
// Task 6 replaces this whole script with createHost(), where the document's playbooks arrive
// already parsed. Until then, clients/<name>/playbooks.yaml still exists (Task 9 removes it), so
// this reads and parses it the way the deleted `readPlaybooksFile` used to.
const playbooksPath = path.join(clientDir, 'playbooks.yaml');
let playbooksFile: { file: string; present: boolean; playbooks: PlaybookDefinition[] };
try {
  const text = await readFile(playbooksPath, 'utf8');
  playbooksFile = { file: playbooksPath, present: true, playbooks: parsePlaybooksFile(parseYaml(text)) };
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
    throw new ConfigError(`cannot read ${playbooksPath}: ${describeError(err)}`);
  }
  playbooksFile = { file: playbooksPath, present: false, playbooks: [] };
}
const synced = await syncPlaybooks(
  db,
  { client: config.client, now: now(), file: playbooksFile.file },
  playbooksFile.playbooks,
);
log.info(
  playbooksFile.present
    ? `playbooks: ${synced.upserted} from ${playbooksFile.file}, ${synced.disabled} disabled`
    : `playbooks: no playbooks.yaml in ${clientDir}; ${synced.disabled} disabled`,
);

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
  // The kernel's own skills first, then every pack's. `preflightPlaybook` resolves a playbook's
  // skill name against this list with `find`, so the kernel's entry is the one it lands on. That
  // is not a shadowing rule: `readSkillCatalogue` refuses a duplicate directory name within one
  // directory and not across two, so a pack shipping a `knowledge-sync` directory of its own would
  // still add a second entry of that name to the catalogue the runtime is offered.
  skills: await readSkillCatalogue([kernelSkillsDir(), ...config.packs.skillsDirs()]),
  model: { baseUrl: config.gateway.baseUrl, apiKey: config.gateway.apiKey, route: 'chat', fallbackRoute: 'reason' },
  budget: {
    maxModelCalls: numberFromEnv('HARNESS_RUN_MAX_MODEL_CALLS', 30, { min: 1, max: 1_000, integer: true }),
    maxToolCalls: numberFromEnv('HARNESS_RUN_MAX_TOOL_CALLS', 60, { min: 1, max: 5_000, integer: true }),
    timeoutMs: seconds('HARNESS_RUN_TIMEOUT_S', 600) * 1000,
    timeoutMarginMs: TIMEOUT_MARGIN_MS,
    maxHistoryMessages: numberFromEnv('HARNESS_HISTORY_MAX_MESSAGES', 40, { min: 0, max: 500, integer: true }),
  },
  servicePrincipal,
  log,
  now,
  active: new Map(),
  turns: new Map(),
  draining: false,
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

// The scheduler (spec 5.6): the same shape as the three loops above, one tick every thirty
// seconds, claiming due playbooks with skip-locked rows and running each as its own service
// principal.
const scheduler = startScheduler(host, { tickMs: SCHEDULER_TICK_MS });

const health = startHealthServer({
  port: port('APPROVALS_HEALTH_PORT', 8787),
  bind: process.env.APPROVALS_HEALTH_BIND?.trim() || DEFAULT_HEALTH_BIND,
  snapshot: () => collectHealth(db, config.client, runner, host.now),
});

// The run API (spec 5.8). No bearer secret, no listener: a control plane that opened a socket with
// no bearer secret because a variable was missing is the failure this avoids (decision 13). The
// scheduler's handle goes in so `GET /v1/status` can report it, which is the one place that
// status is reachable from.
const hostToken = (optionalEnv('HARNESS_HOST_TOKEN') ?? '').trim();
const runApi =
  hostToken === ''
    ? null
    : startRunApi(host, {
        token: hostToken,
        bind: envOrDefault('HARNESS_HOST_BIND', DEFAULT_HOST_BIND),
        port: port('HARNESS_HOST_PORT', DEFAULT_HOST_PORT),
        scheduler,
      });
if (runApi) await runApi.ready;

for (const session of surfaces.all) await session.start();
log.info(
  `listening (client=${config.client}, principal=${servicePrincipal.id}, runtime=${runtime.name}, identity=${identity.name}, surfaces=${surfaces.all.map((s) => s.name).join(',')}, primary=${surfaces.primary.name} on ${surfaces.primary.defaultConversation}, skills=${host.skills.length}, playbooks=${synced.upserted}, runApi=${runApi ? 'on' : 'off (set HARNESS_HOST_TOKEN)'})`,
);

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received, stopping`);
  try {
    // No new tick from here on; the promise settles once the tick in flight has, which needs the
    // drain below to abort the turn that tick is waiting on — so it is created first and awaited
    // after.
    const schedulerStopped = scheduler.stop();
    // Before the drain: nothing new is accepted while the turns in flight unwind, and the open
    // event streams are closed rather than holding the shutdown for as long as a caller listens.
    await runApi?.close();
    // Abort the turns in flight and wait for them, bounded, before anything they are still using
    // goes away: `runtime.stop()` ends the runtime's own pool and `closeDb()` the host's, and a
    // turn that loses that race leaves its `runs` row `running` with nothing to sweep it.
    await drainActive(host, SHUTDOWN_DRAIN_MS);
    // Under the same bound, and for the same reason: the tick is waiting on a turn the drain has
    // just aborted, and a runtime that ignores an abort would otherwise hold the whole shutdown
    // here with nothing to time it out — until the container's grace period kills the process and
    // leaves behind exactly the `running` rows the bounded drain exists to avoid.
    await Promise.race([
      schedulerStopped,
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS).unref()),
    ]);
    if (scheduler.status().ticking) {
      log.warn(`the scheduler tick had not finished ${SHUTDOWN_DRAIN_MS}ms after the drain; stopping anyway`);
    }
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
