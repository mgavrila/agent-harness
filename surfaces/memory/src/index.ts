import { defineSurface, type Surface } from '@harness/surface-api';
import { MemorySurface } from '@harness/surface-api/testing';

/**
 * A surface with no transport.
 *
 * It exists for two reasons and does the same job for both: a developer runs the host against a
 * document that declares `memory` and no Slack workspace at all, and the suite loads
 * it beside the Slack adapter so every host test can drive a real, loaded surface rather than a
 * mock of one. `MemorySurface` itself lives in the contract's `testing` subpath, so the thing the
 * suite proves the host against is the thing that runs.
 *
 * There is nothing to authorise here: who may act on a message or a decision is the identity
 * plug-in's answer, on every surface, this one included.
 */
export const surface: Surface = defineSurface({
  name: 'memory',
  version: '0.1.0',
  secrets: [],
  // Not `async`: a surface with no transport has nothing to await on the way up. There is no
  // event to read a workspace off either, so every event this surface delivers carries the key
  // the client document declared for it — which is what makes pooled routing provable end to end.
  connect: (deps) =>
    Promise.resolve(
      new MemorySurface({
        name: 'memory',
        conversation: 'memory',
        ...(deps.tenantKey === undefined ? {} : { tenantHint: deps.tenantKey }),
      }),
    ),
});
