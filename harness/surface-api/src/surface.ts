import { ConfigError, SURFACE_NAME_PATTERN } from '@harness/shared';
import type { Surface } from './types.js';

export type { Surface, SurfaceDeps, SurfaceSession } from './types.js';

/** An environment variable name, which is what every entry of `Surface.secrets` has to be. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The one allowlist member that means "everybody".
 *
 * Only a surface with no transport may use it — the memory adapter does, so a developer running
 * the host locally is not asked to invent a user id. On a real surface an allowlist is the whole
 * authorisation story and a wildcard there would be a deployment anyone in the workspace can
 * approve from.
 */
export const ANY_USER = '*';

/**
 * Declare a messaging surface. Identity at runtime, plus the checks that turn a typo into a
 * startup failure naming the adapter rather than an approval card nobody can answer.
 */
export function defineSurface(surface: Surface): Surface {
  if (!SURFACE_NAME_PATTERN.test(surface.name)) {
    throw new ConfigError(`surface name "${surface.name}" must be lowercase letters, digits and hyphens`);
  }
  if (surface.version.trim() === '') throw new ConfigError(`surface "${surface.name}" has no version`);
  const seen = new Set<string>();
  for (const secret of surface.secrets) {
    // Every entry is subtracted from the environment of a child process, by name. A lowercase
    // or misspelled entry subtracts nothing and the credential travels, which is the failure
    // this check exists to make loud.
    if (!ENV_NAME.test(secret)) {
      throw new ConfigError(
        `surface "${surface.name}" secret "${secret}" must be an environment variable name (A-Z, digits, underscores)`,
      );
    }
    if (seen.has(secret)) throw new ConfigError(`surface "${surface.name}" lists secret "${secret}" twice`);
    seen.add(secret);
  }
  return surface;
}

/**
 * Parse an allowlist variable: comma-separated user ids, trimmed, empties dropped.
 *
 * An adapter reads its own variable — `SLACK_ALLOWED_USERS`, `MEMORY_ALLOWED_USERS` — and passes
 * the string here, so the parsing and the fail-closed meaning of an empty result are written
 * once and every adapter behaves the same way.
 */
export function parseAllowedUsers(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
  );
}

/**
 * Whether this user may act on this surface. The host calls this and never `allowedUsers.has`,
 * so the empty-means-nobody rule and the wildcard live in one place.
 */
export function allowsUser(allowedUsers: ReadonlySet<string>, userId: string): boolean {
  if (allowedUsers.size === 0) return false;
  return allowedUsers.has(ANY_USER) || allowedUsers.has(userId);
}
