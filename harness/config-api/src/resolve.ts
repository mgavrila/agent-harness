import * as z from 'zod/v4';
import { ConfigError } from '@harness/shared';
import { parseClientDocument, type ClientDocument } from './document.js';
import { pointerSegments, writePointer } from './pointer.js';
import type { Blueprint, Overlay } from './types.js';

/**
 * What a blueprint and an overlay have to be before anything reads them.
 *
 * Both files are written by hand or by a control plane, and both reach this function as a cast
 * (`config-files` reads YAML and asserts the type). Without a parse, a `blueprint.yaml` with no
 * `lockset` is a `TypeError` on an iteration and an operation with a non-string `path` or an
 * unknown `op` falls quietly into the `add` branch — neither of which is a sentence anybody can
 * act on. `document` is a record rather than a whole client document: a blueprint is missing `id`
 * and `displayName` by construction, and the resolved result is what gets parsed properly.
 */
export const BlueprintShape = z.object({
  document: z.record(z.string(), z.unknown()),
  lockset: z.array(z.string()),
  version: z.string().min(1),
});

export const OverlayShape = z.object({
  patch: z.array(
    z.discriminatedUnion('op', [
      z.object({ op: z.literal('replace'), path: z.string(), value: z.unknown() }),
      z.object({ op: z.literal('add'), path: z.string(), value: z.unknown() }),
      z.object({ op: z.literal('remove'), path: z.string() }),
    ]),
  ),
  version: z.string().min(1),
});

/** Parsed for the error only: what was handed in is what the caller keeps using. */
function assertShape(shape: z.ZodType, value: unknown, what: string): void {
  const parsed = shape.safeParse(value);
  if (!parsed.success) throw new ConfigError(`${what} is invalid: ${z.prettifyError(parsed.error)}`);
}

/**
 * Strip the prototype from every plain object in a tree, in place, and refuse a cyclic one.
 *
 * `structuredClone` copies a plain object onto `Object.prototype`, so the working copy a patch is
 * applied to inherits every name on it and a `__proto__` key in the blueprint would decide what
 * the document inherits. That is not a tenant's decision to make. Only plain objects are touched —
 * anything with a prototype of its own is left as it is rather than broken.
 *
 * `ancestors` is the path from the root, not everything seen: an anchor used twice is a shared
 * node and perfectly legal, and only a node that contains itself is a cycle. The `yaml` parser
 * resolves an anchor that names one of its own ancestors into exactly that, and `structuredClone`
 * keeps it, so without this a tenant's file ends the request with a `RangeError` instead of a
 * sentence naming what is wrong with it.
 */
function stripPrototypes<T>(node: T, ancestors: Set<unknown> = new Set()): T {
  if (typeof node !== 'object' || node === null) return node;
  if (ancestors.has(node)) {
    throw new ConfigError('blueprint: a value refers to itself; a client document is a tree, not a loop');
  }
  ancestors.add(node);
  if (Array.isArray(node)) {
    for (const item of node) stripPrototypes(item, ancestors);
  } else if (Object.getPrototypeOf(node) === Object.prototype) {
    for (const value of Object.values(node)) stripPrototypes(value, ancestors);
    Object.setPrototypeOf(node, null);
  }
  ancestors.delete(node);
  return node;
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
  assertShape(BlueprintShape, blueprint, 'blueprint');
  assertShape(OverlayShape, overlay, 'overlay');
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
  const draft = stripPrototypes(structuredClone(blueprint.document) as unknown as Record<string, unknown>);
  for (const op of overlay.patch) writePointer(draft, op);
  return parseClientDocument(draft);
}
