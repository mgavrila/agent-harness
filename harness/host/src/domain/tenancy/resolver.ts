import type { ClientResolver, InboundRef } from './resolver-types.js';

/**
 * One client, and nothing else (spec §4.2, invariant 19).
 *
 * `HARNESS_CLIENT` set means this process belongs to one tenant. An event that names no workspace
 * is that tenant's by construction — its own surfaces are the only ones connected. An event that
 * *does* name one is checked against the tenant's own keys, so a misrouted event from another
 * workspace is refused and audited rather than answered with this tenant's data.
 */
export function dedicatedResolver(
  clientId: string,
  keysOf: (clientId: string) => readonly { surface: string; key: string }[],
): ClientResolver {
  return {
    mode: 'dedicated',
    resolve(ref: InboundRef): string | null {
      if (ref.from === 'api') return ref.clientId === null || ref.clientId === clientId ? clientId : null;
      if (ref.tenantHint === null) return clientId;
      const mine = keysOf(clientId).some((k) => k.surface === ref.surface && k.key === ref.tenantHint);
      return mine ? clientId : null;
    },
  };
}

/**
 * Many clients, each named by the event that arrived (spec §3.4).
 *
 * `lookup` answers which client claims a surface's workspace key; the pool builds it from every
 * loaded document's `tenantKeysOf`, so nothing here reads a vendor's field. An event that names no
 * workspace is refused rather than guessed at: a pool that picked a tenant because it only had one
 * would answer with the wrong one the day it had two.
 */
export function pooledResolver(lookup: (surface: string, key: string) => string | null): ClientResolver {
  return {
    mode: 'pooled',
    resolve(ref: InboundRef): string | null {
      if (ref.from === 'api') return ref.clientId;
      if (ref.tenantHint === null) return null;
      return lookup(ref.surface, ref.tenantHint);
    },
  };
}
