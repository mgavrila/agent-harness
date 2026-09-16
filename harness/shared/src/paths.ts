import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve symlinks in `target`, walking up to the nearest existing ancestor when `target`
 * itself does not exist yet and re-appending the remaining segments untouched (a path segment
 * that does not exist cannot itself be a symlink, so this is safe).
 */
export async function realOrNearestAncestor(target: string): Promise<string> {
  const remainder: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return remainder.length > 0 ? path.join(real, ...remainder) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err; // reached the filesystem root; give up
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Why a candidate was refused. Callers map these onto their own error wording. */
export type EscapeReason = 'lexical' | 'real' | 'unreadable';

export interface InsideRootOptions {
  /** Whether `candidate` resolving to `root` itself counts as inside it. Default true. */
  allowRoot?: boolean;
  /**
   * What to do when `realpath` fails for a reason other than a missing path — ELOOP, EACCES,
   * ENOTDIR. `'rethrow'` (the default) propagates the original error, which is what the two
   * storage callers want, because the errno message never reaches a caller. `'escape'` reports
   * it through `onEscape`, for the Slack sink, whose failures land in a plaintext column and
   * must never quote a path.
   */
  onUnreadable?: 'rethrow' | 'escape';
}

/**
 * The single containment primitive for the whole file store: three implementations of this
 * check used to sit in three files, and the one in the Slack sink had already drifted.
 *
 * Both the lexical path and the symlink-resolved path are compared, and both are necessary.
 * Lexical alone is not enough because every reader here follows symlinks: a link planted under
 * the root passes `path.relative` and then serves whatever it points at. Real-path alone is not
 * enough either, because the target may not exist yet.
 *
 * The separator in `realRoot + path.sep` matters: `${realRoot}-evil` starts with `realRoot` and
 * is not inside it.
 *
 * `onEscape` must throw. It is typed `never` so that TypeScript narrows after a call, and
 * `fail` below turns a caller that returns anyway into a loud failure rather than a silently
 * approved path.
 */
export async function assertInsideRoot(
  candidate: string,
  root: string,
  onEscape: (reason: EscapeReason) => never,
  options: InsideRootOptions = {},
): Promise<string> {
  const { allowRoot = true, onUnreadable = 'rethrow' } = options;
  const fail = (reason: EscapeReason): never => {
    onEscape(reason);
    throw new Error(`assertInsideRoot: onEscape returned for "${reason}"; it must throw`);
  };

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('lexical');
  if (!allowRoot && rel === '') fail('lexical');

  let realRoot: string;
  let realResolved: string;
  try {
    realRoot = await realOrNearestAncestor(resolvedRoot);
    realResolved = await realOrNearestAncestor(resolved);
  } catch (err) {
    if (onUnreadable === 'rethrow') throw err;
    return fail('unreadable');
  }

  if (!allowRoot && realResolved === realRoot) fail('real');
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) fail('real');
  return resolved;
}
