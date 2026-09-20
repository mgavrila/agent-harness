import { tenantKeysOf } from '@harness/config-api';
import { ConfigError, describeError } from '@harness/shared';
import { attachMessageHandlers, drainActive } from '../conversation.js';
import { dedicatedResolver, pooledResolver } from './resolver.js';
import { openTenant } from './tenant.js';
import type { ClientResolver, HostDeps, HostPool, Tenant } from './types.js';

/** How long a tenant being evicted is given to finish the turns it has in flight. */
const INVALIDATE_DRAIN_MS = 10_000;

/**
 * The process, as a factory over tenants (spec §4.2).
 *
 * Dedicated (`HARNESS_CLIENT` set) opens exactly one tenant at start and refuses every other.
 * Pooled opens every client the source lists — because in Plan 11a each tenant still connects its
 * own surfaces, so a tenant nobody had opened would have nothing listening for it. Plan 11b's
 * ingress is what turns that into open-on-demand; the `tenantFor` path below is already written
 * for it, and the pooled test drives it directly.
 *
 * `watch` never mutates a live tenant: a version change evicts it once its turns have drained,
 * and the next event opens a fresh one. A turn whose policy changed halfway through it is not a
 * feature anybody asked for.
 */
export async function createHost(deps: HostDeps): Promise<HostPool> {
  const tenants = new Map<string, Tenant>();
  /** The opens in flight, by client id, so two callers that miss together share one tenant. */
  const opening = new Map<string, Promise<Tenant | null>>();
  const stopWatching = new Map<string, () => void>();
  /** `<surface>:<key>` → client id: the routing index, rewritten whenever a tenant opens. */
  const keys = new Map<string, string>();
  /**
   * What each client claims, from the last document opened for it.
   *
   * It outlives the tenant on purpose. A client that is reloading has no tenant in the map for as
   * long as its turns take to drain and its plug-ins to stop, and an event that arrives in that
   * window still belongs to it — a routing table that had forgotten the client would have the
   * message refused as *another* client's and written to the audit log as `unauthorised`, which
   * is the record an operator reads to decide whether a tenant boundary was crossed. The entry is
   * dropped only when a reopen finds the client is gone, and by `close`.
   */
  const claimed = new Map<string, readonly { surface: string; key: string }[]>();

  const keysOf = (clientId: string): readonly { surface: string; key: string }[] => claimed.get(clientId) ?? [];

  /** Drop everything the client claims: it is gone, not merely between tenants. */
  const forget = (clientId: string): void => {
    for (const [indexed, owner] of keys) if (owner === clientId) keys.delete(indexed);
    claimed.delete(clientId);
  };
  /** Make these the client's keys, dropping whatever it claimed before. */
  const claim = (clientId: string, own: readonly { surface: string; key: string }[]): void => {
    forget(clientId);
    for (const { surface, key } of own) keys.set(`${surface}:${key}`, clientId);
    claimed.set(clientId, own);
  };
  const resolver: ClientResolver =
    deps.dedicatedClient === null
      ? pooledResolver((surface, key) => keys.get(`${surface}:${key}`) ?? null)
      : dedicatedResolver(deps.dedicatedClient, keysOf);

  const pool: HostPool = {
    ...deps,
    resolver,
    tenants,
    draining: false,
    async tenantFor(clientId) {
      const open = tenants.get(clientId);
      if (open) return open;
      if (pool.draining) return null;
      if (resolver.resolve({ from: 'api', clientId }) !== clientId) return null;
      // One open per client, however many callers miss at once. Opening is a long await — a
      // config source, three plug-ins, a playbook sync — and two callers that both missed would
      // otherwise each open a tenant, the second overwriting the first in the map while the
      // first's scheduler, runner, runtime and surface connections kept running unreferenced.
      // Two schedulers for one client is a playbook that fires twice. The window is not
      // hypothetical: `invalidate` leaves the map without this client for as long as its drain
      // takes, and every run API request arriving meanwhile lands here.
      const inFlight = opening.get(clientId);
      if (inFlight) return inFlight;
      const openPromise = (async (): Promise<Tenant | null> => {
        const loaded = await deps.source.load(clientId);
        if (!loaded) return null;
        const tenant = await openTenant(pool, loaded);
        tenants.set(clientId, tenant);
        claim(clientId, tenantKeysOf(tenant.document));
        attachMessageHandlers(pool, tenant);
        for (const session of tenant.host.surfaces.all) await session.start();
        const stop = deps.source.watch?.(clientId, (version) => {
          if (version === tenant.version) return;
          deps.log.info(`tenant ${clientId}: document moved to ${version}; reopening`);
          void pool.invalidate(clientId).catch((err: unknown) => {
            deps.log.error(`tenant ${clientId}: could not reopen: ${describeError(err)}`);
          });
        });
        if (stop) stopWatching.set(clientId, stop);
        return tenant;
      })();
      opening.set(clientId, openPromise);
      try {
        return await openPromise;
      } finally {
        // In a `finally`, so an open that threw is not remembered as the answer: the next caller
        // tries again rather than being handed the same rejection forever.
        opening.delete(clientId);
      }
    },
    async invalidate(clientId) {
      const tenant = tenants.get(clientId);
      if (!tenant) return;
      // Quiesce first, evict second. The tenant stops taking work in — no tick, no approval poll,
      // no message off a surface — while it is still the tenant this client's events resolve to,
      // so a message that arrives mid-reload is either run or dropped by the drain, and never
      // refused as another client's and written to the audit log as `unauthorised`. A row like
      // that is what an operator reads to decide whether a tenant boundary was crossed, and a
      // document edit must not manufacture one.
      await tenant.quiesce();
      await drainActive(tenant.host, INVALIDATE_DRAIN_MS);
      tenants.delete(clientId);
      stopWatching.get(clientId)?.();
      stopWatching.delete(clientId);
      await tenant.close();
      // Only after it is shut: a pooled host that reopened while the old one was still draining
      // would have two runtimes and two schedulers for one client. The client keeps its claim
      // across the whole of this, and gives it up only if there is no document to reopen from.
      const reopened = pool.draining ? null : await pool.tenantFor(clientId);
      if (!reopened) forget(clientId);
    },
    async drain(boundMs) {
      pool.draining = true;
      await Promise.all([...tenants.values()].map((tenant) => drainActive(tenant.host, boundMs)));
    },
    async close() {
      pool.draining = true;
      for (const stop of stopWatching.values()) stop();
      stopWatching.clear();
      for (const tenant of tenants.values()) await tenant.close();
      tenants.clear();
      keys.clear();
      claimed.clear();
      await deps.source.close?.();
    },
  };

  if (deps.dedicatedClient !== null) {
    const tenant = await pool.tenantFor(deps.dedicatedClient);
    if (!tenant) {
      throw new ConfigError(
        `HARNESS_CLIENT names "${deps.dedicatedClient}", which the ${deps.source.name} config source does not hold`,
      );
    }
  } else {
    if (!deps.source.list) {
      throw new ConfigError(
        `HARNESS_CLIENT is unset, so this host is pooled, and the ${deps.source.name} config source cannot list its clients`,
      );
    }
    for (const clientId of await deps.source.list()) await pool.tenantFor(clientId);
    deps.log.info(`pooled host: ${tenants.size} tenants open`);
  }
  return pool;
}
