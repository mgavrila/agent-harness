import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { ConfigError, LEVELS, SURFACE_NAME_PATTERN, USER_LEVELS } from '@harness/shared';
import type { Principal } from './types.js';

/** The four levels a person may hold. A `service` level belongs to a declared service, never to a default. */
export type UserLevel = (typeof USER_LEVELS)[number];

/** `u-` for a person, `svc-` for a service, then a lowercase slug. */
export const PRINCIPAL_ID_PATTERN = /^(u|svc)-[a-z0-9][a-z0-9-]*$/;

/** One entry of `principals:` in `clients/<name>/identity.yaml`. */
export const PrincipalShape = z.object({
  id: z.string().regex(PRINCIPAL_ID_PATTERN, 'a principal id is u-<slug> for a person or svc-<slug> for a service'),
  kind: z.enum(['user', 'service']),
  level: z.enum(LEVELS),
  /**
   * How a person is addressed. One line, trimmed, and short.
   *
   * Not cosmetic bounds. A runtime renders this string into the rules block it puts under the
   * persona, so a name carrying a line break adds a line that reads as another kernel rule and
   * is typographically indistinguishable from the real ones. `identity.yaml` is the operator's
   * file rather than anything an end user writes, which is why the shape is refused here rather
   * than quarantined further down — but nothing downstream can tell a name that was always two
   * lines from a rule that was, so this is the one place that sees it whole and can say no.
   * `.trim()` runs before the bounds, so the stored value is what the bounds describe.
   *
   * Four categories, not two. `Cc` and `Cf` cover the control and formatting characters, but
   * U+2028 and U+2029 are neither — they are `Zl` and `Zp`, the Unicode line and paragraph
   * separators — and a renderer that honours them breaks the line just as `\n` would. Banning
   * the two obvious spellings of a line break and not these would be a lock on one of two doors.
   */
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u, 'a display name is one line: no line break and no control character'),
  surfaces: z.record(z.string().regex(SURFACE_NAME_PATTERN), z.string().min(1)).default({}),
  attributes: z.record(z.string(), z.string()).default({}),
});

/**
 * `defaults:` in `clients/<name>/identity.yaml`: the level a surface gives someone nobody
 * declared. A surface with no entry here refuses an unknown user, which is the right default for
 * a deployment whose members are all named in the file.
 *
 * User levels only. `service` is the level of a scheduled job's own identity, and a default is by
 * definition what a person who walked in gets, so the two can never be the same thing.
 *
 * A surface this deployment does not load is not an error here and does nothing: the startup line
 * names the surfaces that have a default, which is where a typo shows up.
 */
export const IdentityDefaultsShape = z.record(
  z.string().regex(SURFACE_NAME_PATTERN),
  z.enum(USER_LEVELS, { error: 'a surface default is a user level: member, practitioner, lead or admin' }),
);

export const IdentityFileShape = z.object({
  defaults: IdentityDefaultsShape.default({}),
  principals: z.array(PrincipalShape).min(1),
});

/**
 * The one surface a default may never name.
 *
 * The run API authenticates with a single shared bearer token and takes the surface user id
 * straight from the request body, so a default there would let one token holder open runs as any
 * number of principals of their own choosing, each writing its own memory and audit rows. Every
 * principal that may drive the API is declared, by name, in the file.
 */
export const UNDEFAULTABLE_SURFACE = 'http';

/** The digest appended to a derived id, in hex characters. */
const DIGEST_LENGTH = 8;

/** A parsed `identity.yaml`: who is declared, and what each surface gives everyone else. */
export interface IdentityFile {
  principals: Principal[];
  defaults: Record<string, UserLevel>;
}

/** The principals alone, for the callers that never wanted anything else. */
export function parseIdentityFile(raw: unknown): Principal[] {
  return parseIdentityFileWithDefaults(raw).principals;
}

/**
 * Read a parsed `identity.yaml`, then apply the four rules zod cannot say: ids are unique, a user
 * has a `u-` id and a user level, a service has a `svc-` id and the `service` level, and no
 * surface user id is claimed twice — `resolve()` has to answer with one principal or none, never
 * a guess. The `defaults` table comes back beside the principals, for the plug-in that reads it,
 * and may not name `UNDEFAULTABLE_SURFACE`.
 */
export function parseIdentityFileWithDefaults(raw: unknown): IdentityFile {
  const parsed = IdentityFileShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`identity file is invalid: ${z.prettifyError(parsed.error)}`);
  if (parsed.data.defaults[UNDEFAULTABLE_SURFACE] !== undefined) {
    throw new ConfigError(
      `identity file: "${UNDEFAULTABLE_SURFACE}" may not have a default; the run API's bearer is one shared secret, so every ${UNDEFAULTABLE_SURFACE} user must be declared`,
    );
  }
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
  return { principals: parsed.data.principals, defaults: parsed.data.defaults };
}

/**
 * The principal a surface's `defaults` level gives someone who is not in the file.
 *
 * The id is derived, never random, so the same person is the same principal across restarts and
 * across processes: every audit row, approval and run they leave behind is theirs tomorrow too.
 * It is `u-<surface>-<slug>-<digest>`: the surface user id lowercased, with everything an id may
 * not carry replaced by a hyphen, then the first eight hex characters of its SHA-256.
 *
 * **The digest is what makes the derivation injective, and it is not decoration.** Lowercasing and
 * replacing punctuation maps many user ids onto one slug — `Bob.Smith@example.com`,
 * `bob-smith-example-com` and `BOB_SMITH_EXAMPLE_COM` all slug alike — and two people sharing one
 * principal id share per-person memory, an audit trail and an approval history. The digest is over
 * the raw user id, so ids that slug alike land on different principals and the same user id always
 * lands on the same one.
 *
 * Null when no id can be derived — an empty user id, or a surface name that is not one — because a
 * caller that cannot be named is a caller that runs nothing.
 */
export function principalFromDefault(surface: string, userId: string, level: UserLevel): Principal | null {
  if (!SURFACE_NAME_PATTERN.test(surface)) return null;
  if (userId === '') return null;
  const slug = userId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');
  const digest = createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, DIGEST_LENGTH);
  const id = slug === '' ? `u-${surface}-${digest}` : `u-${surface}-${slug}-${digest}`;
  // Belt and braces: the two rules above already produce an id of this shape.
  if (!PRINCIPAL_ID_PATTERN.test(id)) return null;
  return { id, kind: 'user', level, displayName: userId, surfaces: { [surface]: userId }, attributes: {} };
}
