import { describe, expect, it } from 'vitest';
import { canonicalize, hashArgs } from './hash.js';

describe('hashArgs', () => {
  it('does not depend on key order, at any depth', () => {
    expect(hashArgs({ a: 1, b: { c: 2, d: [3, { e: 4, f: 5 }] } })).toBe(
      hashArgs({ b: { d: [3, { f: 5, e: 4 }], c: 2 }, a: 1 }),
    );
  });

  it('is the sha256 hex of the canonical JSON, so the audit rows written before this move still match', () => {
    // sha256 of '{"a":1,"b":"x"}'
    expect(hashArgs({ b: 'x', a: 1 })).toBe('ecf9e98ec0641e23113ff3ce8bdc78d0ddd249886517fd4a7f68cc83d4e65667');
    expect(hashArgs(undefined)).toBe(hashArgs(null));
  });

  it('canonicalizes arrays element-wise and leaves scalars alone', () => {
    expect(canonicalize([{ b: 1, a: 2 }, 'x', null])).toEqual([{ a: 2, b: 1 }, 'x', null]);
  });
});
