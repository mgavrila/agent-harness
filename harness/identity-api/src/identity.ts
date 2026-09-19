import { ConfigError, USER_LEVELS, type Level } from '@harness/shared';
import type { IdentityProvider } from './types.js';

/** A plug-in's name: lowercase, the same rule a pack's and a surface's name follow. */
const NAME = /^[a-z][a-z0-9-]*$/;
/** An environment variable name, which is what every entry of `secrets` has to be. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Declare an identity plug-in. Identity at runtime, plus the checks that turn a typo into a
 * startup failure naming the plug-in rather than a run nobody can attribute.
 */
export function defineIdentityProvider(provider: IdentityProvider): IdentityProvider {
  if (!NAME.test(provider.name)) {
    throw new ConfigError(`identity plug-in name "${provider.name}" must be lowercase letters, digits and hyphens`);
  }
  if (provider.version.trim() === '') throw new ConfigError(`identity plug-in "${provider.name}" has no version`);
  const seen = new Set<string>();
  for (const secret of provider.secrets) {
    if (!ENV_NAME.test(secret)) {
      throw new ConfigError(
        `identity plug-in "${provider.name}" secret "${secret}" must be an environment variable name (A-Z, digits, underscores)`,
      );
    }
    if (seen.has(secret)) throw new ConfigError(`identity plug-in "${provider.name}" lists secret "${secret}" twice`);
    seen.add(secret);
  }
  return provider;
}

/**
 * Whether `actual` clears `required`. The four user levels are cumulative — an admin is at least
 * a member — and `service` sits outside that ladder: a scheduled job is never "at least a lead",
 * and a person is never "at least a service". The only thing a service clears is `service`.
 */
export function levelAtLeast(actual: Level, required: Level): boolean {
  if (actual === 'service' || required === 'service') return actual === required;
  const ladder = USER_LEVELS as readonly string[];
  return ladder.indexOf(actual) >= ladder.indexOf(required);
}
