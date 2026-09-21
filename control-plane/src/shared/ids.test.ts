import { describe, expect, it } from 'vitest';
import { clientIdFor, SLUG_PATTERN } from './ids.js';

describe('ids', () => {
  it('a client id is org slug + agent slug and matches the kernel pattern', () => {
    expect(clientIdFor('acme', 'helper')).toBe('acme-helper');
    expect(SLUG_PATTERN.test('a-b')).toBe(true);
    expect(SLUG_PATTERN.test('-a')).toBe(false);
    expect(() => clientIdFor('a'.repeat(32), 'b'.repeat(32))).toThrow(/64/);
  });
});
