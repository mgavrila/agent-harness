/**
 * A third surface, so that "the primary only" is proved against more than a pair.
 *
 * The memory adapter and the Slack adapter are the two a deployment really loads; a host that
 * posted to the first two of three would pass a suite that only had two. Not shipped, and not a
 * second memory adapter: it has no configuration of its own, and nothing but `name` is asserted
 * against it.
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
