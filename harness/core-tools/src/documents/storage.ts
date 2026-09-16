import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError, assertInsideRoot } from '@harness/shared';

export const DOCUMENT_KINDS = ['state_license', 'dea_certificate', 'malpractice_certificate', 'w9', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

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
  return assertInsideRoot(requested, storageDir, () => {
    throw new ToolError('document path is outside HARNESS_STORAGE_DIR');
  });
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

/**
 * Where the redacted text for a document lives: beside it, with a fixed suffix
 * appended to the whole file name. Appending rather than replacing the
 * extension is what keeps `incoming/a.pdf` and `incoming/a.png` — two
 * different documents, each with its own `documents` row — from resolving to
 * one `incoming/a.redacted.txt` that the second extraction would silently
 * overwrite while both rows still pointed at it.
 */
export function documentTextPath(absPath: string): string {
  return `${absPath}.redacted.txt`;
}

/** Store paths relative to the storage root so a moved root does not invalidate rows. */
export function toStorageRelative(storageDir: string, absPath: string): string {
  return path.relative(path.resolve(storageDir), absPath);
}
