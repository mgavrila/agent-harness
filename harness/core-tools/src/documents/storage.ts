import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
 * Turn a caller-supplied path into an absolute path that is provably inside
 * `storageDir`. The agent chooses this string, so it is untrusted: without the
 * containment check, `documents_ingest` would read any file the process can.
 */
export function resolveStoragePath(storageDir: string, requested: string): string {
  if (requested.trim() === '') throw new ToolError('document path is empty');
  const root = path.resolve(storageDir);
  const resolved = path.resolve(root, requested);
  // The separator matters: `${root}-evil` starts with `root` but is not in it.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
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
