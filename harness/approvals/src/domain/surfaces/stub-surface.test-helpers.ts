/**
 * A surface that exists only to make a union of two adapters' credentials a real union.
 *
 * The memory adapter declares no secrets, so a test that loads it beside Slack proves nothing
 * about combining two lists: the answer is Slack's list unchanged, and a host that kept only the
 * first adapter's credentials would pass. This one declares a name no real adapter reads, so
 * that host fails.
 *
 * Not shipped, and not a second memory adapter: it has no configuration and no allowlist of its
 * own, and nothing but `secrets` and `name` is asserted against it.
 */
import { defineSurface, type Surface } from '@harness/surface-api';
import { MemorySurface } from '@harness/surface-api/testing';

/** Deliberately unlike any variable a real adapter reads, so a collision cannot mask a bug. */
export const STUB_SECRET = 'STUB_SURFACE_TOKEN';

/** The session `connect` hands back, so a test that wires its surfaces synchronously gets this one. */
export function stubSession(): MemorySurface {
  return new MemorySurface({ name: 'stub', conversation: 'stub' });
}

export const stubSurface: Surface = defineSurface({
  name: 'stub',
  version: '0.0.0',
  secrets: [STUB_SECRET],
  connect: () => Promise.resolve(stubSession()),
});
