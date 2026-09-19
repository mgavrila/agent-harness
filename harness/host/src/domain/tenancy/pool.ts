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
  const stopWatching = new Map<string, () => void>();
  /** `<surface>:<key>` → client id, rebuilt whenever a tenant opens or closes. */
  const keys = new Map<string, string>();

  const keysOf = (clientId: string): readonly { surface: string; key: string }[] => {
    const tenant = tenants.get(clientId);
    return tenant ? tenantKeysOf(tenant.document) : [];
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
      const loaded = await deps.source.load(clientId);
      if (!loaded) return null;
      const tenant = await openTenant(pool, loaded);
      tenants.set(clientId, tenant);
      for (const { surface, key } of tenantKeysOf(tenant.document)) keys.set(`${surface}:${key}`, clientId);
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
    },
    async invalidate(clientId) {
      const tenant = tenants.get(clientId);
      if (!tenant) return;
      tenants.delete(clientId);
      for (const { surface, key } of tenantKeysOf(tenant.document)) keys.delete(`${surface}:${key}`);
      stopWatching.get(clientId)?.();
      stopWatching.delete(clientId);
      await drainActive(tenant.host, INVALIDATE_DRAIN_MS);
      await tenant.close();
      // Only after it is shut: a pooled host that reopened while the old one was still draining
      // would have two runtimes and two schedulers for one client.
      if (!pool.draining) await pool.tenantFor(clientId);
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
