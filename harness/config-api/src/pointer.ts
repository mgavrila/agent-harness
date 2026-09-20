import { ConfigError } from '@harness/shared';
import type { PatchOp } from './types.js';

/**
 * The three segments no pointer may name.
 *
 * A pointer is a tenant's own string — an overlay is the tenant's edits by definition — and
 * `__proto__`, `constructor` and `prototype` are the three names that reach an object's prototype
 * rather than its contents. One of them written through on a pooled host is every tenant's
 * `Object.prototype`, so they are refused at the one place every walk and every write starts,
 * rather than checked again at each of them.
 */
const PROTOTYPE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The segments of an RFC 6901 JSON pointer, with `~1` and `~0` unescaped.
 *
 * `''` is the whole document and has no segments. Anything that does not begin with `/` is not a
 * pointer, and saying so here is what keeps a typo in a lock set from silently locking nothing.
 */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new ConfigError(`"${pointer}" is not a JSON pointer; one starts with "/"`);
  const segments = pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  for (const segment of segments) {
    if (PROTOTYPE_SEGMENTS.has(segment)) {
      throw new ConfigError(`"${pointer}" names "${segment}", which is an object's prototype rather than its contents`);
    }
  }
  return segments;
}

/**
 * One step of a walk, over what an object *has* rather than what it inherits.
 *
 * `node[segment]` would answer for `toString` on any object and for `polluted` on every object
 * once one prototype somewhere had been written to. A pointer names a place in a document; a key
 * the document does not own is not one.
 */
function own(node: Record<string, unknown>, segment: string): unknown {
  return Object.hasOwn(node, segment) ? node[segment] : undefined;
}

/**
 * Walk to the parent container a pointer's last segment lives in. `path` is the overlay
 * operation's own, unmodified path — used only for the error, so a failing lookup is blamed on
 * what the overlay actually wrote rather than a reconstruction of it (a segment containing `/` or
 * `~` cannot be rejoined into a pointer without re-escaping, and re-escaping it here would just be
 * a second copy of `pointerSegments` to keep in step with the first).
 */
function container(root: Record<string, unknown>, segments: string[], path: string): Record<string, unknown> {
  let node: unknown = root;
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) {
      throw new ConfigError(`overlay: ${path} has no container in the blueprint`);
    }
    node = own(node as Record<string, unknown>, segment);
  }
  if (typeof node !== 'object' || node === null) {
    throw new ConfigError(`overlay: ${path} is not an object or array in the blueprint`);
  }
  return node as Record<string, unknown>;
}

/**
 * Where `add` writes into an array (RFC 6902 §4.1): `-` is one past the last element, and a
 * numeric segment is a position to insert *before* — so `0` on a three-element array puts a new
 * first element and `3` appends, but `4` names a position the array does not have.
 */
function arrayInsertIndex(segment: string, length: number, path: string): number {
  if (segment === '-') return length;
  if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) > length) {
    throw new ConfigError(`overlay: cannot add ${path}, which is not a position in a ${length}-element array`);
  }
  return Number(segment);
}

/** Read what a pointer names, or `undefined`. Used by `remove` and `replace` to check presence. */
export function readPointer(root: unknown, pointer: string): unknown {
  let node: unknown = root;
  for (const segment of pointerSegments(pointer)) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = own(node as Record<string, unknown>, segment);
  }
  return node;
}

/**
 * Apply one operation in place. `remove` deletes a key or splices an array element; `replace`
 * overwrites one that is already there; `add` sets a key on an object but, on an array, *inserts*
 * (RFC 6902 §4.1) — the one place `add` and `replace` are not the same write.
 */
export function writePointer(root: Record<string, unknown>, op: PatchOp): void {
  const segments = pointerSegments(op.path);
  if (segments.length === 0) throw new ConfigError('overlay: the whole document is not a patchable path');
  const last = segments[segments.length - 1];
  const parent = container(root, segments.slice(0, -1), op.path);
  if (op.op === 'remove') {
    if (!Object.hasOwn(parent, last))
      throw new ConfigError(`overlay: cannot remove ${op.path}, which the blueprint does not have`);
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
    return;
  }
  if (op.op === 'replace') {
    if (!Object.hasOwn(parent, last)) {
      throw new ConfigError(`overlay: cannot replace ${op.path}, which the blueprint does not have; use "add"`);
    }
    parent[last] = op.value;
    return;
  }
  if (Array.isArray(parent)) {
    parent.splice(arrayInsertIndex(last, parent.length, op.path), 0, op.value);
    return;
  }
  parent[last] = op.value;
}
