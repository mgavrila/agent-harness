import { createHash } from 'node:crypto';
import path from 'node:path';
import { ConfigError, optionalEnv, realOrNearestAncestor } from '@harness/shared';

// Re-exported for @harness/approvals' Slack file sink, which checks containment again as
// defence in depth. Task 9 points it at the public API and this line goes.
export { realOrNearestAncestor };

/**
 * Root of the harness file store. There is no default: a deployment that has
 * not said where files live must fail at startup rather than scatter provider
 * documents into whatever directory happened to be the working directory.
 */
export function storageRoot(dir: string | undefined = optionalEnv('HARNESS_STORAGE_DIR')): string {
  if (!dir || dir.trim() === '' || !path.isAbsolute(dir.trim())) {
    throw new ConfigError('HARNESS_STORAGE_DIR must be set to an absolute path');
  }
  return path.resolve(dir.trim());
}

/**
 * Everything a human may receive lives under one subtree, so one guard covers
 * all of it and nothing a tool generates can land next to ingested documents.
 */
export function outRoot(root: string): string {
  return path.join(root, 'out');
}

/** First 12 hex of sha256: enough to make a file id content-addressed and stable. */
export function contentTag(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
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
