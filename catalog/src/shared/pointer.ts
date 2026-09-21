import { ConfigError } from '@harness/shared';

const PROTOTYPE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** RFC 6901 segments. A pointer is the same shape the kernel's lock set uses. */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new ConfigError(`pointer "${pointer}" must start with "/"`);
  const segments = pointer
    .slice(1)
    .split('/')
    .map((s) => s.replaceAll('~1', '/').replaceAll('~0', '~'));
  for (const s of segments) {
    if (PROTOTYPE_SEGMENTS.has(s)) throw new ConfigError(`pointer "${pointer}" names a prototype segment`);
  }
  return segments;
}

export function pointersOverlap(a: string, b: string): boolean {
  const x = pointerSegments(a);
  const y = pointerSegments(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

function walk(doc: unknown, segments: string[]): { parent: unknown; key: string } | null {
  let node: unknown = doc;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[segments[i]];
  }
  if (typeof node !== 'object' || node === null) return null;
  return { parent: node, key: segments[segments.length - 1] };
}

export function hasPointer(doc: unknown, pointer: string): boolean {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) return true;
  const at = walk(doc, segments);
  return at !== null && Object.prototype.hasOwnProperty.call(at.parent, at.key);
}

export function getPointer(doc: unknown, pointer: string): unknown {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) return doc;
  const at = walk(doc, segments);
  return at === null ? undefined : (at.parent as Record<string, unknown>)[at.key];
}

/** Set a value, creating intermediate objects. Arrays are addressed by index or "-" for append. */
export function setPointer(doc: Record<string, unknown>, pointer: string, value: unknown): void {
  const segments = pointerSegments(pointer);
  if (segments.length === 0) throw new ConfigError('cannot set the whole document through a pointer');
  let node: Record<string, unknown> = doc;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = node[key] as Record<string, unknown>;
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(node) && last === '-') (node as unknown[]).push(value);
  else node[last] = value;
}
