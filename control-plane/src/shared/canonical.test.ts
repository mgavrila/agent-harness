import { describe, expect, it } from 'vitest';
import { canonicalJson, contentVersion } from './canonical.js';

describe('canonical', () => {
  it('sorts keys at every depth so key order does not change the version', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[1,{"y":2,"z":1}]},"b":1}',
    );
    expect(contentVersion({ b: 1, a: 2 })).toBe(contentVersion({ a: 2, b: 1 }));
    expect(contentVersion({ a: 1 })).toMatch(/^[0-9a-f]{16}$/);
  });
});
