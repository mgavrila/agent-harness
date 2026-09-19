import path from 'node:path';
import {
  createInProcessCoreToolsClient,
  loadSurfaces,
  registerApprovalHandlers,
  startRunner,
  surfaceSinks,
} from '@harness/approvals';
import { parsePlaybooksFile, surfaceNamesOf, surfaceSecretsOf } from '@harness/config-api';
import { buildKernelConfig, loadIdentity, reconcile } from '@harness/core-tools';
import { outRoot } from '@harness/core-tools/storage';
import { parseIdentityFileWithDefaults } from '@harness/identity-api';
import { ConfigError, describeError, envOrDefault, numberFromEnv, optionalEnv } from '@harness/shared';
import { TIMEOUT_MARGIN_MS } from '../conversation.js';
import type { Host } from '../host.js';
import { syncPlaybooks } from '../playbooks/repository.js';
import { SCHEDULER_TICK_MS, startScheduler } from '../playbooks/scheduler.js';
import { decisionDeps } from '../resume.js';
import { loadRuntime } from '../runtime/registry.js';
import { kernelSkillsDir, readSkillCatalogue } from '../skills.js';
import { materialiseSkills } from './skills.js';
import { identitySpecifier, runtimeSpecifier, surfaceSpecifier } from './specifiers.js';
import type { HostPool, LoadedDocument, Tenant } from './types.js';

/** Where a tenant's skills are written, under the deployment's own storage root. */
const SKILLS_SUBDIR = 'skills';

/** How long a tenant's scheduler is given to finish the tick in flight while it closes. */
const SCHEDULER_STOP_MS = 10_000;

/**
 * Check that every secret the document *refers to* is actually present.
 *
 * A `SecretRef` names an environment variable; the value stays in the process environment and
 * reaches the surface through `deps.env`, exactly as it does today. What the document adds is the
 * chance to fail at load, naming the tenant and the variable, instead of at the first message
 * with a transport error nobody can attribute. `surfaceSecretsOf` is what reads the typed surface
 * sections, so this file names no surface's own fields.
 */
function assertSecretsPresent(document: LoadedDocument['document'], env: Record<string, string | undefined>): void {
  for (const ref of surfaceSecretsOf(document)) {
    if ((env[ref.env] ?? '').trim() === '') {
      throw new ConfigError(
        `client "${document.id}" declares the "${ref.surface}" surface, which needs ${ref.env}; this deployment does not set it`,
      );
    }
  }
}

/**
 * Open one client: its configuration, its plug-ins, its playbooks, its loops.
 *
 * Everything a `Host` holds, built from the resolved document and from the deployment's own
 * environment — and nothing shared with another tenant but the database handle, the logger and
 * the clock. The order is the order `app/main.ts` had, and for the same reasons: identity first
 * because the host's own principal has to be declared; playbooks before a surface connects, so a
 * malformed schedule fails with no socket open; the runtime last before the object is built.
 */
export async function openTenant(pool: HostPool, loaded: LoadedDocument): Promise<Tenant> {
  const { document, version } = loaded;
  const env = pool.env as Record<string, string | undefined>;
  const log = pool.log;
  const config = await buildKernelConfig(document, pool.env);
  assertSecretsPresent(document, env);

  const identity = await loadIdentity(identitySpecifier(document.identityPlugin.kind), {
    env: pool.env,
    log,
    identity: parseIdentityFileWithDefaults(document.identity),
    settings: document.identityPlugin.settings,
  });
  const servicePrincipalId = envOrDefault('HARNESS_HOST_PRINCIPAL', 'svc-host', pool.env);
  const servicePrincipal = await identity.get(servicePrincipalId);
  if (!servicePrincipal || servicePrincipal.kind !== 'service') {
    throw new ConfigError(
      `client "${config.client}": HARNESS_HOST_PRINCIPAL names "${servicePrincipalId}", which the identity plug-in "${identity.name}" does not declare as a service`,
    );
  }

  // The document into the table, once per open, and before a surface or the runtime connects: a
  // playbook added or removed takes effect when the tenant is next opened, a firing missed while
  // the tenant was closed is not replayed, and a malformed schedule fails here.
  const synced = await syncPlaybooks(
    pool.db,
    // `file` is only where a bad schedule is named from, so it names the document, not a path.
    { client: config.client, now: pool.now(), file: `the ${document.id} client document ${version}` },
    parsePlaybooksFile(document.playbooks),
  );

  const surfaces = await loadSurfaces(surfaceNamesOf(document).map(surfaceSpecifier), {
    env: pool.env,
    log,
    storageDir: config.storageDir,
  });
  const runtime = await loadRuntime(runtimeSpecifier(document.runtime), {
    // The one per-tenant thing a runtime is told. `RuntimeDeps` is `{ env, log, databaseUrl,
    // storageDir }` and a pooled host's process environment has no HARNESS_CLIENT — that is what
    // makes it pooled — so a runtime opened for a tenant reads which tenant off the env it is
    // handed. `runtimes/scripted` is the reason this matters; a model-backed runtime ignores it.
    env: { ...pool.env, HARNESS_CLIENT: config.client },
    log,
    databaseUrl: optionalEnv('DATABASE_URL', pool.env) ?? '',
    storageDir: config.storageDir,
  });

  const skillsDir = await materialiseSkills(document, path.join(config.storageDir, SKILLS_SUBDIR));
  const host: Host = {
    db: pool.db,
    config,
    client: config.client,
    identity,
    surfaces,
    runtime,
    persona: document.persona,
    // The kernel's own skills first, then this client's, then every pack's.
    skills: await readSkillCatalogue([kernelSkillsDir(), skillsDir, ...config.packs.skillsDirs()]),
    model: { baseUrl: config.gateway.baseUrl, apiKey: config.gateway.apiKey, route: 'chat', fallbackRoute: 'reason' },
    budget: {
      maxModelCalls: numberFromEnv('HARNESS_RUN_MAX_MODEL_CALLS', 30, { min: 1, max: 1_000, integer: true }, pool.env),
      maxToolCalls: numberFromEnv('HARNESS_RUN_MAX_TOOL_CALLS', 60, { min: 1, max: 5_000, integer: true }, pool.env),
      timeoutMs: numberFromEnv('HARNESS_RUN_TIMEOUT_S', 600, { min: 1, max: 86_400, unit: 'seconds' }, pool.env) * 1000,
      timeoutMarginMs: TIMEOUT_MARGIN_MS,
      maxHistoryMessages: numberFromEnv(
        'HARNESS_HISTORY_MAX_MESSAGES',
        40,
        { min: 0, max: 500, integer: true },
        pool.env,
      ),
    },
    servicePrincipal,
    log,
    now: pool.now,
    active: new Map(),
    turns: new Map(),
    draining: false,
  };

  const core = createInProcessCoreToolsClient({
    db: pool.db,
    config,
    client: config.client,
    servicePrincipal,
    now: pool.now,
  });
  const deps = decisionDeps(host, core);
  for (const session of surfaces.all) registerApprovalHandlers(session, deps);

  const seconds = (name: string, fallback: number): number =>
    numberFromEnv(name, fallback, { min: 1, max: 86_400, unit: 'seconds' }, pool.env);
  const runner = startRunner(
    {
      db: pool.db,
      surfaces,
      core,
      sinks: surfaceSinks(surfaces, { outDir: outRoot(config.storageDir) }),
      client: config.client,
      encryptionKey: config.encryptionKey,
      now: pool.now,
    },
    {
      pollMs: seconds('APPROVALS_POLL_SECONDS', 5) * 1000,
      dispatchMs: seconds('EFFECTS_DISPATCH_SECONDS', 5) * 1000,
      reconcileMs: seconds('RECONCILE_SECONDS', 300) * 1000,
      staleAfterMinutes: 10,
    },
  );
  const scheduler = startScheduler(host, { tickMs: SCHEDULER_TICK_MS });

  // This tenant's own startup repair, scoped to this tenant: a pooled host that repaired
  // everything each time a tenant opened would expire one client's approvals because another
  // client's document changed.
  try {
    const repaired = await reconcile(pool.db, { now: pool.now, client: config.client });
    log.info(`reconcile for ${config.client}: ${JSON.stringify(repaired)}`);
  } catch (err) {
    log.warn(`reconcile for ${config.client} failed; continuing: ${describeError(err)}`);
  }

  log.info(
    `tenant ${config.client} open (version=${version}, principal=${servicePrincipal.id}, runtime=${runtime.name}, identity=${identity.name}, surfaces=${surfaces.all.map((s) => s.name).join(',')}, primary=${surfaces.primary.name} on ${surfaces.primary.defaultConversation}, skills=${host.skills.length}, playbooks=${synced.upserted})`,
  );

  return {
    clientId: config.client,
    version,
    document,
    host,
    runner,
    scheduler,
    close: async () => {
      // The scheduler's stop is created first and awaited under a bound: the tick in flight is
      // waiting on a turn the caller's drain has already aborted, and a runtime that ignored the
      // abort would otherwise hold the whole shutdown here.
      const stopping = scheduler.stop();
      await Promise.race([stopping, new Promise<void>((resolve) => setTimeout(resolve, SCHEDULER_STOP_MS).unref())]);
      await runner.stop();
      for (const session of surfaces.all) await session.stop();
      await runtime.stop();
      await identity.stop();
      await core.close();
    },
  };
}
