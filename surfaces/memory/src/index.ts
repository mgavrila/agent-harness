import { ANY_USER, defineSurface, parseAllowedUsers, type Surface } from '@harness/surface-api';
import { MemorySurface } from '@harness/surface-api/testing';

/**
 * A surface with no transport.
 *
 * It exists for two reasons and does the same job for both: a developer runs the host with
 * `HARNESS_SURFACES=@harness/surface-memory` and no Slack workspace at all, and the suite loads
 * it beside the Slack adapter so every host test can drive a real, loaded surface rather than a
 * mock of one. `MemorySurface` itself lives in the contract's `testing` subpath, so the thing the
 * suite proves the host against is the thing that runs.
 *
 * `MEMORY_ALLOWED_USERS` defaults to the wildcard. This is the only surface that may be open, and
 * only because there is nothing to be open to: nothing it posts leaves the process.
 */
export const surface: Surface = defineSurface({
  name: 'memory',
  version: '0.1.0',
  secrets: [],
  // Not `async`: a surface with no transport has nothing to await on the way up.
  connect: (deps) => {
    // Read off the bag rather than through `optionalEnv`, which reads an empty value as absent.
    // Here unset and empty mean opposite things — everybody and nobody — and only the raw string
    // tells them apart, so an operator who clears the list gets nobody, as on every other
    // surface. The cost is that the environment scan, which looks for a helper call, does not
    // see this name; the variable is documented in `.env.example` instead.
    const listed = deps.env.MEMORY_ALLOWED_USERS;
    return Promise.resolve(
      new MemorySurface({
        name: 'memory',
        conversation: 'memory',
        allowedUsers: parseAllowedUsers(listed ?? ANY_USER),
      }),
    );
  },
});
