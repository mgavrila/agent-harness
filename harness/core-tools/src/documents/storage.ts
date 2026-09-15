import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../registry.js';

export const DOCUMENT_KINDS = [
  'state_license',
  'dea_certificate',
  'malpractice_certificate',
  'w9',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * Resolve symlinks in `target`, walking up to the nearest existing ancestor
 * when `target` itself does not exist yet and re-appending the remaining
 * segments untouched (a path segment that does not exist cannot itself be a
 * symlink, so this is safe).
 */
async function realOrNearestAncestor(target: string): Promise<string> {
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

/**
 * Turn a caller-supplied path into an absolute path that is provably inside
 * `storageDir`. The agent chooses this string, so it is untrusted: without the
 * containment check, `documents_ingest` would read any file the process can.
 *
 * Checks both the lexical path and its real (symlink-resolved) path: a
 * symlink that lexically sits under `storageDir` but points outside it must
 * still be refused, or reading/hashing it would leak a file the containment
 * check was meant to block.
 */
export async function resolveStoragePath(storageDir: string, requested: string): Promise<string> {
  if (requested.trim() === '') throw new ToolError('document path is empty');
  const root = path.resolve(storageDir);
  const resolved = path.resolve(root, requested);
  // The separator matters: `${root}-evil` starts with `root` but is not in it.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ToolError('document path is outside HARNESS_STORAGE_DIR');
  }
  const realRoot = await realOrNearestAncestor(root);
  const realResolved = await realOrNearestAncestor(resolved);
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
    throw new ToolError('document path is outside HARNESS_STORAGE_DIR');
  }
  return resolved;
}

export async function readDocumentBytes(absPath: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(absPath));
  } catch {
    // The path is caller-supplied and already validated, so naming it is safe;
    // the underlying errno message is not repeated.
    throw new ToolError(`cannot read document at ${absPath}`);
  }
}

export async function sha256File(absPath: string): Promise<string> {
  const bytes = await readDocumentBytes(absPath);
  return createHash('sha256').update(bytes).digest('hex');
}

/** Where the redacted text for a document lives: beside it, with a fixed suffix. */
export function documentTextPath(absPath: string): string {
  const ext = path.extname(absPath);
  return `${absPath.slice(0, absPath.length - ext.length)}.redacted.txt`;
}

/** Store paths relative to the storage root so a moved root does not invalidate rows. */
export function toStorageRelative(storageDir: string, absPath: string): string {
  return path.relative(path.resolve(storageDir), absPath);
}
