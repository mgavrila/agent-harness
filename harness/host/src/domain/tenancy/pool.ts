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

  /**
   * The reload in flight per client, so two version changes for one client run one after the
   * other rather than over each other.
   *
   * A change that lands *during* a reopen is the case this exists for: the tenant is out of the
   * map and the new one does not exist yet, so nothing can be evicted for it and a reload that
   * simply returned would leave the tenant on the previous version until somebody edited the
   * document again. Chained, that second change waits for the open it interrupted and then
   * reloads on top of it.
   */
  const reloading = new Map<string, Promise<void>>();

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
  /**
   * Watch this client's document, once, for as long as the process serves it.
   *
   * **The watch outlives the tenant.** It is registered before the first open can fail and stopped
   * only by `close`, or when the source turns out to hold no document for the client at all. A
   * watch that lived and died with a tenant left a client whose reopen threw — a missing secret, a
   * runtime that is not installed, an undeclared service principal — with nothing listening for
   * the edit that fixes it, so the tenant stayed dead until the process restarted.
   *
   * The version is compared against whatever tenant is open *now*, because by the time this fires
   * there may be none.
   */
  const watchClient = (clientId: string): void => {
    if (stopWatching.has(clientId)) return;
    const stop = deps.source.watch?.(clientId, (version) => {
      if (tenants.get(clientId)?.version === version) return;
      deps.log.info(`tenant ${clientId}: document moved to ${version}; reopening`);
      void pool.invalidate(clientId).catch((err: unknown) => {
        // Error, not warn: this client is serving nobody until the next version arrives, and the
        // watch is still up precisely so that the operator's fix is what ends that.
        deps.log.error(`tenant ${clientId}: could not reopen: ${describeError(err)}`);
      });
    });
    if (stop) stopWatching.set(clientId, stop);
  };

  /**
   * One eviction and one reopen. `invalidate` serialises these per client; nothing else calls it.
   *
   * Quiesce first, evict second. The tenant stops taking work in — no tick, no approval poll, no
   * message off a surface — while it is still the tenant this client's events resolve to, so a
   * message that arrives mid-reload is either run or dropped by the drain, and never refused as
   * another client's and written to the audit log as `unauthorised`. A row like that is what an
   * operator reads to decide whether a tenant boundary was crossed, and a document edit must not
   * manufacture one.
   */
  const reloadOnce = async (clientId: string): Promise<void> => {
    const tenant = tenants.get(clientId);
    if (tenant) {
      await tenant.quiesce();
      await drainActive(tenant.host, INVALIDATE_DRAIN_MS);
      tenants.delete(clientId);
      // Only after it is shut: a pooled host that reopened while the old one was still draining
      // would have two runtimes and two schedulers for one client. The client keeps its claim
      // across the whole of this, and gives it up only if there is no document to reopen from.
      await tenant.close();
    }
    if (!pool.draining && (await pool.tenantFor(clientId))) return;
    // Nothing is open for this client. Its claim goes either way — an event for it now has no
    // tenant to reach — but the watch is stopped only when the client is gone from the source,
    // never because this process is shutting down, which `close` handles on its own.
    forget(clientId);
    if (!pool.draining) {
      stopWatching.get(clientId)?.();
      stopWatching.delete(clientId);
    }
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
        // Before the open, which is what can fail: see `watchClient`.
        watchClient(clientId);
        const tenant = await openTenant(pool, loaded);
        tenants.set(clientId, tenant);
        claim(clientId, tenantKeysOf(tenant.document));
        attachMessageHandlers(pool, tenant);
        for (const session of tenant.host.surfaces.all) await session.start();
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
      const queued = (reloading.get(clientId) ?? Promise.resolve()).catch(() => {}).then(() => reloadOnce(clientId));
      reloading.set(clientId, queued);
      try {
        await queued;
      } finally {
        // Only if nothing chained behind this one, which is the entry a later caller is waiting on.
        if (reloading.get(clientId) === queued) reloading.delete(clientId);
      }
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
    // Per client, because on a pooled host every other id is a different customer: one
    // malformed document, one missing secret or one uninstalled pack is that tenant's outage
    // and nobody else's. Decision 12 says warm every id; it does not say fail all for one. The
    // failure is logged with the id, and its watch stays up, so the edit that fixes it opens it.
    const listed = await deps.source.list();
    for (const clientId of listed) {
      try {
        await pool.tenantFor(clientId);
      } catch (err) {
        deps.log.error(`tenant ${clientId}: could not open: ${describeError(err)}`);
      }
    }
    // Every listed client failing is not one tenant's problem, it is a deployment that is wrong —
    // a bad mount, the wrong database — and a host serving nobody should say so at start rather
    // than answer its health check. A source that lists nothing has nothing to have failed.
    if (listed.length > 0 && tenants.size === 0) {
      throw new ConfigError(
        `no tenant of the ${listed.length} the ${deps.source.name} config source lists could be opened; the errors above name each one`,
      );
    }
    deps.log.info(`pooled host: ${tenants.size} of ${listed.length} tenants open`);
  }
  return pool;
}
