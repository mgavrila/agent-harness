import { describe, it, expect } from 'vitest';
import { isRestrictedName } from '@harness/core-tools';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { FREE_TEXT_FIELDS } from './types.js';

describe('FREE_TEXT_FIELDS', () => {
  it('names no restricted field, so no restricted value can reach the judge', () => {
    for (const field of FREE_TEXT_FIELDS) expect(isRestrictedName(field)).toBe(false);
  });

  it('names no field the healthcare pack marks restricted', () => {
    // Read from the pack's own manifest rather than a repository path: the pack
    // is the source of what it declares restricted, and a test that reaches for
    // packs/healthcare/schema/provider.json by path asserts against a copy.
    const restricted = healthcarePack.records
      .flatMap((r) => r.fields)
      .filter((f) => f.restricted === true)
      .map((f) => f.name);
    expect(restricted.length).toBeGreaterThan(0);
    for (const field of FREE_TEXT_FIELDS) expect(restricted).not.toContain(field);
  });
});
