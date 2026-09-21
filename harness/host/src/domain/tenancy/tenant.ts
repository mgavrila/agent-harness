import path from 'node:path';
import {
  createInProcessCoreToolsClient,
  loadSurfaces,
  registerApprovalHandlers,
  startRunner,
  surfaceSinks,
  type SurfaceSettings,
} from '@harness/approvals';
import {
  parsePlaybooksFile,
  surfaceNamesOf,
  surfaceSecretsOf,
  tenantKeysOf,
  type ClientDocument,
} from '@harness/config-api';
import { buildKernelConfig, loadIdentity, reconcile, type GatewayConfig } from '@harness/core-tools';
import { outRoot } from '@harness/core-tools/storage';
import { parseIdentityFileWithDefaults } from '@harness/identity-api';
import {
  ConfigError,
  describeError,
  envOrDefault,
  numberFromEnv,
  optionalEnv,
  type EnvSource,
  type Logger,
} from '@harness/shared';
import { assertMounts } from '../api/surfaces.js';
import { TIMEOUT_MARGIN_MS } from '../conversation.js';
import type { Host, HostBudget } from '../host.js';
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
function assertSecretsPresent(document: ClientDocument, env: EnvSource): void {
  for (const ref of surfaceSecretsOf(document)) {
    if ((optionalEnv(ref.env, env) ?? '').trim() === '') {
      throw new ConfigError(
        `client "${document.id}" declares the "${ref.surface}" surface, which needs ${ref.env}; this deployment does not set it`,
      );
    }
  }
}

/**
 * What one turn may spend, and the one check that the two per-run model-call limits agree.
 *
 * There are two of them and they bound the same run from different sides. The runtime stops
 * itself after `HARNESS_RUN_MAX_MODEL_CALLS` calls; `callModel`'s breaker refuses a *tool* once
 * the run has `HARNESS_GATEWAY_MAX_CALLS_PER_RUN` `model_calls` rows, and since the host began
 * persisting the runtime's own spend those rows include the conversation's. So a budget that
 * reaches the breaker spends the breaker's allowance on the conversation and has the kernel's
 * tools refused partway through the turn, with a message that can only say the run is at its
 * limit. Both numbers are known here and nowhere earlier, so they are compared here, before a
 * surface or a plug-in is opened.
 */
function runBudget(client: string, gateway: GatewayConfig, env: EnvSource): HostBudget {
  const maxModelCalls = numberFromEnv('HARNESS_RUN_MAX_MODEL_CALLS', 30, { min: 1, max: 1_000, integer: true }, env);
  if (maxModelCalls >= gateway.maxCallsPerRun) {
    throw new ConfigError(
      `client "${client}": HARNESS_RUN_MAX_MODEL_CALLS (${maxModelCalls}) must be less than ` +
        `HARNESS_GATEWAY_MAX_CALLS_PER_RUN (${gateway.maxCallsPerRun}); the conversation's own model calls count ` +
        `against the gateway's per-run breaker, so a budget that reaches it has the kernel's tools refused mid-turn`,
    );
  }
  return {
    maxModelCalls,
    maxToolCalls: numberFromEnv('HARNESS_RUN_MAX_TOOL_CALLS', 60, { min: 1, max: 5_000, integer: true }, env),
    timeoutMs: numberFromEnv('HARNESS_RUN_TIMEOUT_S', 600, { min: 1, max: 86_400, unit: 'seconds' }, env) * 1000,
    timeoutMarginMs: TIMEOUT_MARGIN_MS,
    maxHistoryMessages: numberFromEnv('HARNESS_HISTORY_MAX_MESSAGES', 40, { min: 0, max: 500, integer: true }, env),
  };
}

/** One thing a tenant holds open, and how to let go of it. */
interface Stoppable {
  what: string;
  stop: () => Promise<void>;
}

/**
 * Stop every one of these, in order, and never throw.
 *
 * `Tenant.close()` promises exactly this, and a rejecting `session.stop()` that skipped the stops
 * after it would leave a runtime and a database client running for a tenant the pool has already
 * forgotten — and, inside `invalidate`, would skip the reopen and leave the client unserved until
 * the process restarts. A failure here is a log line and nothing else, because there is no caller
 * left who could do anything about it.
 */
async function stopEach(steps: readonly Stoppable[], client: string, log: Logger): Promise<void> {
  for (const step of steps) {
    try {
      await step.stop();
    } catch (err) {
      log.error(`tenant ${client}: could not stop ${step.what}: ${describeError(err)}`);
    }
  }
}

/**
 * Open one client: its configuration, its plug-ins, its playbooks, its loops.
 *
 * Everything a `Host` holds, built from the resolved document and from the deployment's own
 * environment — and nothing shared with another tenant but the database handle, the logger and
 * the clock. Playbooks first, so a malformed schedule fails with no socket open; then the
 * surfaces; then identity, which a directory-backed plug-in cannot connect before the surface it
 * reads group membership from; then the runtime, last before the object is built.
 */
export async function openTenant(pool: HostPool, loaded: LoadedDocument): Promise<Tenant> {
  // What this open has already started, newest last. A tenant that fails halfway — a runtime that
  // will not connect, a service principal the document does not declare — would otherwise leave a
  // connected surface and a running loop behind with no handle to stop them, and `invalidate`
  // reopens a tenant on the ordinary path every time a document changes.
  const opened: Stoppable[] = [];
  try {
    return await buildTenant(pool, loaded, opened);
  } catch (err) {
    await stopEach([...opened].reverse(), loaded.document.id, pool.log);
    throw err;
  }
}

async function buildTenant(pool: HostPool, loaded: LoadedDocument, opened: Stoppable[]): Promise<Tenant> {
  const { document, version } = loaded;
  const log = pool.log;
  const config = await buildKernelConfig(document, pool.env);
  assertSecretsPresent(document, pool.env);
  const budget = runBudget(config.client, config.gateway, pool.env);

  // The document into the table, once per open, and before a surface or the runtime connects: a
  // playbook added or removed takes effect when the tenant is next opened, a firing missed while
  // the tenant was closed is not replayed, and a malformed schedule fails here.
  const synced = await syncPlaybooks(
    pool.db,
    // `file` is only where a bad schedule is named from, so it names the document, not a path.
    { client: config.client, now: pool.now(), file: `the ${document.id} client document ${version}` },
    parsePlaybooksFile(document.playbooks),
  );

  // What the document says about each surface it declares: the key an inbound event's hint is
  // matched against, and the variable it named for each of that surface's secrets. Both come out
  // of `@harness/config-api`, which is where the typed surface sections are read, so this file
  // names no surface's own field — `field` is as opaque here as `env` already was.
  const settings: Record<string, SurfaceSettings> = {};
  for (const { surface, key } of tenantKeysOf(document)) {
    settings[surface] = { ...settings[surface], tenantKey: key };
  }
  for (const { surface, field, env } of surfaceSecretsOf(document)) {
    settings[surface] = { ...settings[surface], secrets: { ...settings[surface]?.secrets, [field]: env } };
  }
  const surfaces = await loadSurfaces(
    surfaceNamesOf(document).map(surfaceSpecifier),
    { env: pool.env, log, storageDir: config.storageDir },
    settings,
  );
  // Before anything is started: a mount path that could climb out of its tenant prefix, or two
  // surfaces claiming one path, is this client's configuration being wrong, and a tenant that
  // failed at its first request instead would fail it for whoever sent it.
  assertMounts(config.client, surfaces.all);
  for (const session of surfaces.all) opened.push({ what: `surface "${session.name}"`, stop: () => session.stop() });

  // Identity comes after the surfaces, and that is a deliberate change of startup order: a
  // directory-backed plug-in resolves a level from group membership, so the surface it asks has
  // to be connected before it can ask anything. The consequence is that this host's own service
  // principal is checked after the surfaces are up rather than before. Nothing is listening at
  // that point — every shipped surface builds a session here and is only started once the pool
  // has a `Tenant` — so a document that names a principal nobody declares fails with no socket
  // open; and a surface that did take a resource in `connect` is stopped by the unwind in
  // `openTenant`, which is why each one is pushed onto `opened` as it is built.
  const directories = Object.fromEntries(
    surfaces.all.filter((session) => session.directory).map((session) => [session.name, session.directory!]),
  );
  const identity = await loadIdentity(identitySpecifier(document.identityPlugin.kind), {
    env: pool.env,
    log,
    identity: parseIdentityFileWithDefaults(document.identity),
    settings: document.identityPlugin.settings,
    directories,
  });
  opened.push({ what: 'the identity session', stop: () => identity.stop() });
  const servicePrincipalId = envOrDefault('HARNESS_HOST_PRINCIPAL', 'svc-host', pool.env);
  const servicePrincipal = await identity.get(servicePrincipalId);
  if (!servicePrincipal || servicePrincipal.kind !== 'service') {
    throw new ConfigError(
      `client "${config.client}": HARNESS_HOST_PRINCIPAL names "${servicePrincipalId}", which the identity plug-in "${identity.name}" does not declare as a service`,
    );
  }

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
  opened.push({ what: 'the runtime', stop: () => runtime.stop() });

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
    budget,
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
  opened.push({ what: 'the core-tools client', stop: () => core.close() });
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
  opened.push({ what: 'the approvals runner', stop: () => runner.stop() });
  const scheduler = startScheduler(host, { tickMs: SCHEDULER_TICK_MS });
  opened.push({ what: 'the scheduler', stop: () => scheduler.stop() });

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

  // Everything that brings work into this tenant, stopped once and never twice: the scheduler so
  // no tick starts, the runner's three loops so no approval or effect is picked up, and every
  // surface so no message arrives. `invalidate` calls this *before* it evicts the tenant, so an
  // event that lands mid-reload still finds its own tenant rather than being refused as another
  // client's; `close` calls it first for the same reason a shutdown does.
  let quiesced = false;
  const quiesce = async (): Promise<void> => {
    if (quiesced) return;
    quiesced = true;
    await stopEach(
      [
        {
          what: 'the scheduler',
          // Bounded: the tick in flight is waiting on a turn the caller's drain has already
          // aborted, and a runtime that ignored the abort would otherwise hold the whole
          // shutdown here.
          stop: () =>
            Promise.race([
              scheduler.stop(),
              new Promise<void>((resolve) => setTimeout(resolve, SCHEDULER_STOP_MS).unref()),
            ]),
        },
        { what: 'the approvals runner', stop: () => runner.stop() },
        ...surfaces.all.map((session) => ({ what: `surface "${session.name}"`, stop: () => session.stop() })),
      ],
      config.client,
      log,
    );
  };

  return {
    clientId: config.client,
    version,
    document,
    host,
    runner,
    scheduler,
    quiesce,
    close: async () => {
      await quiesce();
      await stopEach(
        [
          { what: 'the runtime', stop: () => runtime.stop() },
          { what: 'the identity session', stop: () => identity.stop() },
          { what: 'the core-tools client', stop: () => core.close() },
        ],
        config.client,
        log,
      );
    },
  };
}
