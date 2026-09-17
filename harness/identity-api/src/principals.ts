import * as z from 'zod/v4';
import { ConfigError, LEVELS, SURFACE_NAME_PATTERN } from '@harness/shared';
import type { Principal } from './types.js';

/** `u-` for a person, `svc-` for a service, then a lowercase slug. */
export const PRINCIPAL_ID_PATTERN = /^(u|svc)-[a-z0-9][a-z0-9-]*$/;

/** One entry of `principals:` in `clients/<name>/identity.yaml`. */
export const PrincipalShape = z.object({
  id: z.string().regex(PRINCIPAL_ID_PATTERN, 'a principal id is u-<slug> for a person or svc-<slug> for a service'),
  kind: z.enum(['user', 'service']),
  level: z.enum(LEVELS),
  displayName: z.string().min(1),
  surfaces: z.record(z.string().regex(SURFACE_NAME_PATTERN), z.string().min(1)).default({}),
  attributes: z.record(z.string(), z.string()).default({}),
});

export const IdentityFileShape = z.object({
  principals: z.array(PrincipalShape).min(1),
});

/**
 * Read the principals out of a parsed `identity.yaml`, then apply the four rules zod cannot say:
 * ids are unique, a user has a `u-` id and a user level, a service has a `svc-` id and the
 * `service` level, and no surface user id is claimed twice — `resolve()` has to answer with one
 * principal or none, never a guess.
 */
export function parseIdentityFile(raw: unknown): Principal[] {
  const parsed = IdentityFileShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`identity file is invalid: ${z.prettifyError(parsed.error)}`);
  const seen = new Set<string>();
  const claims = new Map<string, string>();
  for (const p of parsed.data.principals) {
    if (seen.has(p.id)) throw new ConfigError(`identity file: "${p.id}" is declared twice`);
    seen.add(p.id);
    if (p.kind === 'user') {
      if (!p.id.startsWith('u-')) throw new ConfigError(`identity file: "${p.id}" is a user and must have a "u-" id`);
      if (p.level === 'service') {
        throw new ConfigError(`identity file: "${p.id}" is a user and cannot be at level "service"`);
      }
    } else {
      if (!p.id.startsWith('svc-')) {
        throw new ConfigError(`identity file: "${p.id}" is a service and must have a "svc-" id`);
      }
      if (p.level !== 'service') {
        throw new ConfigError(`identity file: "${p.id}" is a service and must be at level "service"`);
      }
    }
    for (const [surface, userId] of Object.entries(p.surfaces)) {
      const key = `${surface}:${userId}`;
      const already = claims.get(key);
      if (already !== undefined) {
        throw new ConfigError(
          `identity file: "${already}" and "${p.id}" both claim user "${userId}" on surface "${surface}"`,
        );
      }
      claims.set(key, p.id);
    }
  }
  return parsed.data.principals;
}
