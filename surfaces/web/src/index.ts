import { defineSurface, type Surface } from './deps.js';
import { createWebSession } from './session.js';

/**
 * The surface a workspace talks to.
 *
 * A tenant with no Slack has no chat and nowhere to put an approval card: `http` may not be a
 * primary surface by schema rule and `memory` posts nowhere. This is what such a tenant declares
 * instead, and `SURFACE_ORDER` puts it first, so its cards go to its own inbox.
 *
 * It opens nothing. The host mounts its door at `/tenants/<clientId>/web/...` and hands over what
 * arrives; every request carries the tenant's own bearer, which the host resolved from
 * `surfaces.web.token` through whatever secret source the deployment configured.
 */
export const surface: Surface = defineSurface({
  name: 'web',
  version: '0.1.0',
  // None. This adapter reads no environment variable at all: its one credential is its tenant's,
  // and it arrives resolved on `deps.secretValues` (spec section 12, constraint 24).
  secrets: [],
  // Not `async`: building the session opens nothing.
  connect: (deps) => Promise.resolve(createWebSession(deps)),
});
