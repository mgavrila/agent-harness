import { ConfigError } from '@harness/shared';
import { parseClientDocument, type ClientDocument } from './document.js';
import { pointerSegments, writePointer } from './pointer.js';
import type { Blueprint, Overlay } from './types.js';

// `pointerSegments`, `readPointer` and `writePointer` are the pointer-level operations a JSON
// Patch overlay is built from; they live in `./pointer.js` and are re-exported here so every
// existing importer of `resolve.js` keeps working.
export { pointerSegments, readPointer, writePointer } from './pointer.js';

/**
 * Whether `a` and `b` overlap: either is a prefix of the other, or they are equal.
 *
 * Both directions matter (decision 11). An operation *inside* a locked subtree edits something
 * locked; an operation *above* a locked leaf replaces the subtree that leaf is in, which edits it
 * just as surely. Segment-wise rather than string-wise, so `/policy` does not appear to be a
 * prefix of `/policyOverride`.
 */
function pointersOverlap(a: string[], b: string[]): boolean {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A blueprint plus a tenant's overlay, under the blueprint's lock set (spec §3.5, decision 3).
 *
 * Every operation is checked against every locked pointer **before** anything is applied, in the
 * order the overlay lists them, and the first violation is the one named — so the message is the
 * same every time for the same overlay. The result is parsed as a whole document, because a patch
 * that left the schema behind is a patch that has to fail here rather than at the first run.
 *
 * `/id` and `/displayName` are what the overlay supplies — a blueprint has neither — so a lock
 * set that named either would describe a blueprint no tenant could instantiate, and is refused.
 */
export function resolve(blueprint: Blueprint, overlay: Overlay): ClientDocument {
  for (const locked of blueprint.lockset) {
    const segments = pointerSegments(locked);
    if (segments.length === 1 && (segments[0] === 'id' || segments[0] === 'displayName')) {
      throw new ConfigError(
        `blueprint ${blueprint.version}: "${locked}" cannot be locked; a tenant's overlay is the only thing that supplies it`,
      );
    }
  }
  const locks = blueprint.lockset.map((pointer) => ({ pointer, segments: pointerSegments(pointer) }));
  for (const op of overlay.patch) {
    const segments = pointerSegments(op.path);
    const hit = locks.find((lock) => pointersOverlap(segments, lock.segments));
    if (hit) {
      throw new ConfigError(
        `overlay ${overlay.version}: ${op.op} ${op.path} touches "${hit.pointer}", which blueprint ${blueprint.version} locks`,
      );
    }
  }
  const draft = structuredClone(blueprint.document) as unknown as Record<string, unknown>;
  for (const op of overlay.patch) writePointer(draft, op);
  return parseClientDocument(draft);
}
