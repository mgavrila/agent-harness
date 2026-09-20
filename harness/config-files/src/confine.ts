import path from 'node:path';

/**
 * Whether `target` is `root` itself or lies under it.
 *
 * Both sides must already be resolved, and it is asked twice on two different pairs — once on
 * the literal paths, so an escape is refused as an escape rather than reported as a missing
 * file, and once on the real paths, which is the only comparison that sees through a symlink
 * sitting inside the client's own directory. Neither check subsumes the other.
 *
 * Segment-wise via `path.sep`, so a sibling directory whose name merely starts with the root's
 * (`/clients/acme-staging` beside `/clients/acme`) is outside.
 */
export function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}
