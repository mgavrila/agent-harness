import { describe, it, expect } from 'vitest';
import { hashArgs } from './audit.js';

describe('hashArgs', () => {
  it('is independent of key order', () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
  });

  it('is independent of key order in nested objects and objects inside arrays', () => {
    expect(hashArgs({ outer: { a: 1, b: 2 }, list: [{ x: 1, y: 2 }] })).toBe(
      hashArgs({ list: [{ y: 2, x: 1 }], outer: { b: 2, a: 1 } }),
    );
  });

  it('still distinguishes different values and array order', () => {
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(hashArgs({ a: [1, 2] })).not.toBe(hashArgs({ a: [2, 1] }));
  });

  it('handles null and undefined', () => {
    expect(hashArgs(null)).toBe(hashArgs(undefined));
  });
});
