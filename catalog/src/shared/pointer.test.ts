import { describe, expect, it } from 'vitest';
import { getPointer, hasPointer, pointerSegments, pointersOverlap, setPointer } from './pointer.js';

describe('JSON pointers', () => {
  it('splits and unescapes segments', () => {
    expect(pointerSegments('/a/b~1c/0/~0x')).toEqual(['a', 'b/c', '0', '~x']);
    expect(pointerSegments('')).toEqual([]);
  });
  it('refuses a pointer that does not start with a slash or names a prototype segment', () => {
    expect(() => pointerSegments('a/b')).toThrow(/must start with "\/"/);
    expect(() => pointerSegments('/__proto__/x')).toThrow(/prototype/);
  });
  it('reads, writes and tests existence', () => {
    const doc: Record<string, unknown> = { a: { b: [1, 2] } };
    expect(getPointer(doc, '/a/b/1')).toBe(2);
    expect(hasPointer(doc, '/a/c')).toBe(false);
    setPointer(doc, '/a/c', 'x');
    expect(getPointer(doc, '/a/c')).toBe('x');
  });
  it('overlap is segment-wise, both directions', () => {
    expect(pointersOverlap('/policy', '/policy/classes')).toBe(true);
    expect(pointersOverlap('/policy/classes', '/policy')).toBe(true);
    expect(pointersOverlap('/policy', '/policyOverride')).toBe(false);
  });
});
