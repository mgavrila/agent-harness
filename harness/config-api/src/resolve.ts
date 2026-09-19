import { ConfigError } from '@harness/shared';
import { parseClientDocument, type ClientDocument } from './document.js';
import type { Blueprint, Overlay, PatchOp } from './types.js';

/**
 * The segments of an RFC 6901 JSON pointer, with `~1` and `~0` unescaped.
 *
 * `''` is the whole document and has no segments. Anything that does not begin with `/` is not a
 * pointer, and saying so here is what keeps a typo in a lock set from silently locking nothing.
 */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new ConfigError(`"${pointer}" is not a JSON pointer; one starts with "/"`);
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

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

function container(root: Record<string, unknown>, segments: string[]): Record<string, unknown> {
  let node: unknown = root;
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) {
      throw new ConfigError(`overlay: /${segments.join('/')} has no container in the blueprint`);
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'object' || node === null) {
    throw new ConfigError(`overlay: /${segments.join('/')} is not an object or array in the blueprint`);
  }
  return node as Record<string, unknown>;
}

/** Read what a pointer names, or `undefined`. Used by `remove` and `replace` to check presence. */
export function readPointer(root: unknown, pointer: string): unknown {
  let node: unknown = root;
  for (const segment of pointerSegments(pointer)) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Apply one operation in place. `add` and `replace` are the same write; `remove` deletes the key. */
export function writePointer(root: Record<string, unknown>, op: PatchOp): void {
  const segments = pointerSegments(op.path);
  if (segments.length === 0) throw new ConfigError('overlay: the whole document is not a patchable path');
  const last = segments[segments.length - 1];
  const parent = container(root, segments.slice(0, -1));
  if (op.op === 'remove') {
    if (!(last in parent))
      throw new ConfigError(`overlay: cannot remove ${op.path}, which the blueprint does not have`);
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
    return;
  }
  if (op.op === 'replace' && !(last in parent)) {
    throw new ConfigError(`overlay: cannot replace ${op.path}, which the blueprint does not have; use "add"`);
  }
  parent[last] = op.value;
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
