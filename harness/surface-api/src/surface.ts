import { ConfigError, SURFACE_NAME_PATTERN } from '@harness/shared';
import type { Surface } from './types.js';

export type { Surface, SurfaceDeps, SurfaceSession } from './types.js';

/** An environment variable name, which is what every entry of `Surface.secrets` has to be. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

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
