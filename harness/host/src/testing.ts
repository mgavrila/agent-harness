import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { envSecretSource, type ClientDocument, type SecretSource } from '@harness/config-api';
import { MemoryConfigSource } from '@harness/config-api/testing';
import type { KernelConfig, PackRegistry } from '@harness/core-tools';
import { makeTestDeps, type TestDepsOverrides } from '@harness/core-tools/testing';
import type { Db } from '@harness/db';
import { surfacesOf } from '@harness/approvals';
import type { Logger } from '@harness/shared';
import type { Principal } from '@harness/identity-api';
import { StaticIdentity } from '@harness/identity-api/testing';
import type { RunSkill } from '@harness/runtime-api';
import { ScriptedRuntime, type Trajectory } from '@harness/runtime-api/testing';
import { scriptedTrajectories } from '@harness/runtime-scripted';
import { MemorySurface } from '@harness/surface-api/testing';
import { attachMessageHandlers, TIMEOUT_MARGIN_MS } from './domain/conversation.js';
import type { Host, HostBudget } from './domain/host.js';
import { createHost } from './domain/tenancy/pool.js';
import { dedicatedResolver } from './domain/tenancy/resolver.js';
import type { HostPool, Tenant } from './domain/tenancy/types.js';

export { useTestDb } from '@harness/db/testing';

/**
 * Poll until `ready` holds, so a test waits on the signal it means rather than on a fixed delay.
 *
 * A turn opens a run, resolves an identity and writes to Postgres before the runtime sees it, and
 * under a loaded suite that takes far longer than the tens of milliseconds a sleep would guess at.
 */
export async function waitFor(ready: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The startup-only half of a test bag: `makeTestDeps` less the per-run members. */
export function testKernelConfig(db: Db, overrides: TestDepsOverrides = {}): KernelConfig {
  const {
    db: _db,
    principal: _principal,
    context: _context,
    sinks: _sinks,
    tools: _tools,
    kernelTools: _kernel,
    kernel: _k,
    ...config
  } = makeTestDeps(db, overrides);
  return config;
}

export const HOST_PRINCIPAL: Principal = {
  id: 'svc-host',
  kind: 'service',
  level: 'service',
  displayName: 'Host',
  surfaces: {},
  attributes: {},
};
export const COORDINATOR: Principal = {
  id: 'u-coordinator',
  kind: 'user',
  level: 'lead',
  displayName: 'Coordinator',
  surfaces: { memory: 'U012' },
  attributes: {},
};
export const MEMBER: Principal = {
  id: 'u-member',
  kind: 'user',
  level: 'member',
  displayName: 'Member',
  surfaces: { memory: 'U345' },
  attributes: {},
};

/** The principal the test playbooks run as: a service, never a person. */
export const PLAYBOOKS_PRINCIPAL: Principal = {
  id: 'svc-playbooks',
  kind: 'service',
  level: 'service',
  displayName: 'Nightly playbooks',
  surfaces: {},
  attributes: {},
};

export interface HostFixture {
  host: Host;
  surface: MemorySurface;
  identity: StaticIdentity;
  runtime: ScriptedRuntime;
  close(): Promise<void>;
}

/**
 * A whole host over the real kernel and Postgres, with the memory surface, a static identity
 * and a scripted runtime: what every flow test drives. The persona and skills are small
 * literals; a test that needs the shipped skills passes them through `testKernelConfig`'s packs
 * and `readSkillCatalogue`.
 */
export async function hostFixture(
  db: Db,
  opts: {
    trajectory: Trajectory;
    principals?: Principal[];
    budget?: Partial<HostBudget>;
    streaming?: boolean;
    /** The skills the host offers; default one fixture skill. A scheduler test passes the shipped catalogue. */
    skills?: readonly RunSkill[];
    /**
     * The packs this host serves; default the shipped one, as `makeTestDeps` has it. A test of a
     * client with no pack passes `registryOf([])`, which is what an empty `packs` list loads.
     */
    packs?: PackRegistry;
  },
): Promise<HostFixture> {
  const surface = new MemorySurface({ capabilities: { streaming: opts.streaming ?? false } });
  const identity = new StaticIdentity(opts.principals ?? [COORDINATOR, MEMBER, HOST_PRINCIPAL, PLAYBOOKS_PRINCIPAL]);
  const runtime = new ScriptedRuntime(opts.trajectory);
  const host: Host = {
    db,
    config: testKernelConfig(db, {
      storageDir: mkdtempSync(path.join(tmpdir(), 'harness-host-')),
      ...(opts.packs ? { packs: opts.packs } : {}),
    }),
    client: 'test',
    identity,
    surfaces: surfacesOf([surface]),
    runtime,
    persona: 'You are the test assistant.',
    // A plain fixture name: the vocabulary scan of `harness/host/src` (kernel-vocabulary.test.ts)
    // forbids the product's own skill names in anything that is not itself a `*.test.ts` file.
    skills: opts.skills ?? [
      { name: 'sample-skill', version: '1.0.0', description: 'a skill for tests', dir: '/nonexistent' },
    ],
    model: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', route: 'chat', fallbackRoute: 'reason' },
    budget: {
      maxModelCalls: 30,
      maxToolCalls: 60,
      timeoutMs: 30_000,
      // The production margin, so a test reads the same ordering a deployment does. A test of the
      // host's own backstop passes 0 rather than waiting five seconds for it.
      timeoutMarginMs: TIMEOUT_MARGIN_MS,
      maxHistoryMessages: 40,
      ...opts.budget,
    },
    servicePrincipal: HOST_PRINCIPAL,
    log: { info() {}, warn() {}, error() {} },
    // The same frozen clock `testKernelConfig`'s `now` carries (core-tools' `makeTestDeps`), so a
    // row an approval tool stages under one and a decision taken under the other agree on
    // whether it has expired — real wall-clock time would drift out of the TTL window depending
    // on when the suite happens to run, exactly the flakiness a frozen test clock exists to avoid.
    now: () => new Date('2026-09-15T12:00:00Z'),
    active: new Map(),
    turns: new Map(),
    draining: false,
  };
  return {
    host,
    surface,
    identity,
    runtime,
    close: async () => {
      await runtime.stop();
    },
  };
}

/**
 * `attachMessageHandlers` for a one-host fixture.
 *
 * The production call is `attachMessageHandlers(pool, tenant)`: a pool for its database handle,
 * its logger and its resolver, and a tenant for its client id and its host. A test that drives
 * one host has no pool, so this supplies the smallest thing that is one — a dedicated resolver
 * over that host's own client, which answers that client for an event naming no workspace,
 * exactly as a dedicated deployment's resolver does.
 */
export function attachTestHandlers(host: Host): void {
  attachMessageHandlers(
    { db: host.db, log: host.log, resolver: dedicatedResolver(host.client, () => []) },
    { clientId: host.client, host },
  );
}

export interface PoolFixture {
  pool: HostPool;
  /** The in-memory source behind the pool, so a test can move a document and invalidate. */
  source: MemoryConfigSource;
  tenant(clientId: string): Tenant;
  surface(clientId: string): MemorySurface;
  /**
   * Stop this pool and leave nothing of it running: no delivery, no turn, no query.
   *
   * See `settleDeliveries` for why the deliveries are awaited before anything stops, and why a
   * case that does not do this makes the *next* case fail.
   */
  close(): Promise<void>;
}

/** A 32-byte key, base64, which is what `loadKey` requires of every deployment. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

/** How long this fixture gives the turns still in flight, once the deliveries have been awaited. */
const FIXTURE_DRAIN_MS = 10_000;

/**
 * Wait for every delivery this pool's mounted doors have acknowledged, to the end of its turn.
 *
 * **A door answers before it delivers.** `MemorySurface.handleHttp` acknowledges the request and
 * hands the message to `say` on its own promise, exactly as a real transport must, so the 200 a
 * case asserts on is sent while the turn it started is still resolving an identity, opening a
 * thread and writing its `messages` row. Nothing in `pool.close` waits for that: `quiesce` stops
 * the scheduler, the runner's loops and the sessions, each of which does drain its own work, and
 * `drainActive` waits only for turns that have already reached `host.active` — which a delivery
 * has not until `runTurn` opens its kernel.
 *
 * So a case that returned on the acknowledgement left a transaction running on another connection
 * of a pool it shares with every other case in the file, and the next case's `resetDatabase`
 * did not merely race it: `TRUNCATE` takes an `AccessExclusiveLock` on `runs` while the turn's
 * `INSERT INTO messages` holds `messages` and needs a `RowShareLock` on `runs` for its foreign
 * key, and Postgres ends that with `40P01 deadlock detected` on whichever of the two it picks.
 *
 * This is the fixture's job rather than `MemorySurface.stop`'s: `quiesce` stops the sessions
 * *before* `invalidate` drains the tenant, so a `stop` that awaited a whole turn would make a
 * document edit wait out that turn unbounded, where the drain that follows it is bounded on
 * purpose.
 */
async function settleDeliveries(pool: HostPool): Promise<void> {
  for (const tenant of pool.tenants.values()) {
    for (const session of tenant.host.surfaces.all) {
      if (session instanceof MemorySurface) await session.settled();
    }
  }
}

/**
 * A whole pooled host over the real kernel and Postgres, with N tenants.
 *
 * Each tenant gets its own memory surface, its own static identity over its own document and its
 * own scripted runtime — which is what a real pooled host has, and what makes the isolation test
 * a test of the thing that ships rather than of a fixture that pretends. Every plug-in is reached
 * the way a deployment reaches one: the document names it, `createHost` derives a specifier from
 * the name and imports that package.
 *
 * The environment is built here and carries nothing ambient, so a developer's filled-in `.env`
 * cannot reach a tenant and change what a case proves.
 */
export async function poolFixture(
  db: Db,
  opts: {
    documents: readonly ClientDocument[];
    /** Per client id, what its scripted runtime plays back. A client with no entry says nothing. */
    trajectories?: Readonly<Record<string, Trajectory>>;
    dedicated?: string;
    env?: Record<string, string | undefined>;
    /**
     * Where this pool resolves its tenants' secrets from.
     *
     * **The environment source by default**, which is what every deployment has today and what
     * every existing case in this package was written against: a document naming an `{ env }`
     * secret this fixture's environment does not set fails with the sentence it has always
     * failed with, and a `{ ref }` is refused with "this deployment has no secret source". A case
     * that wants a store — the web surface's bearer, the gateway key — builds a
     * `MemorySecretSource`, fills it and passes it.
     */
    secrets?: SecretSource;
    /**
     * Where this pool's log lines go. Silent by default, which is what a suite wants; a case that
     * asserts on a line — a surface that failed mid-stream, a refusal nothing else records —
     * passes a collector.
     */
    log?: Logger;
  },
): Promise<PoolFixture> {
  const source = new MemoryConfigSource(opts.documents.map((document) => ({ document, version: 'v1' })));
  const storageDir = mkdtempSync(path.join(tmpdir(), 'harness-pool-'));
  const env: Record<string, string | undefined> = {
    HARNESS_STORAGE_DIR: storageDir,
    HARNESS_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    LITELLM_MASTER_KEY: 'sk-test',
    ...opts.env,
  };
  // Before `createHost`, because a tenant's runtime is connected while the pool opens it and
  // reads its script out of this registry at that moment.
  scriptedTrajectories.clear();
  for (const [clientId, trajectory] of Object.entries(opts.trajectories ?? {})) {
    scriptedTrajectories.set(clientId, trajectory);
  }
  const pool = await createHost({
    db,
    env,
    log: opts.log ?? { info() {}, warn() {}, error() {} },
    // The frozen clock `hostFixture` and `makeTestDeps` share, so a row an approval tool stages
    // under one and a decision taken under the other agree on whether it has expired.
    now: () => new Date('2026-09-15T12:00:00Z'),
    source,
    // Over **this fixture's own `env`**, not the ambient one, for the reason every other value in
    // that bag is: a developer's filled-in `.env` must not reach a tenant and change what a case
    // proves.
    secrets: opts.secrets ?? envSecretSource(env),
    dedicatedClient: opts.dedicated ?? null,
  });
  const tenant = (clientId: string): Tenant => {
    const found = pool.tenants.get(clientId);
    if (!found) {
      throw new Error(`no tenant "${clientId}" is open; open: ${[...pool.tenants.keys()].join(', ') || 'none'}`);
    }
    return found;
  };
  return {
    pool,
    source,
    tenant,
    surface: (clientId) => tenant(clientId).host.surfaces.find('memory') as MemorySurface,
    close: async () => {
      // The order a deployment shuts down in (`main.ts`), with the deliveries first: the doors'
      // acknowledged work, then the turns anything else started, then the pool itself.
      await settleDeliveries(pool);
      await pool.drain(FIXTURE_DRAIN_MS);
      await pool.close();
      // So one case's script cannot reach the next case's tenant.
      scriptedTrajectories.clear();
      // And so a suite does not leave one storage tree per fixture behind in the temp directory.
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}
