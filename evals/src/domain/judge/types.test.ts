import { describe, it, expect } from 'vitest';
import { isRestrictedName, parseRecordKindSpec } from '@harness/core-tools';
import { pack as healthcarePack } from '@harness/pack-healthcare';

/**
 * A pack is a fixture here, never an import of the shipping code: the judged list belongs to
 * whichever pack is being measured, and the only way to assert on a real one is to name it.
 */
const judgedFields = healthcarePack.evals!.judgedFields;

describe('Pack.evals.judgedFields', () => {
  it('lists no restricted field, because a restricted value never leaves the database in plaintext', () => {
    expect(judgedFields.filter((f) => isRestrictedName(f))).toEqual([]);
  });

  it('names no field the healthcare pack marks restricted', () => {
    // Read from the pack's own manifest rather than a repository path: the pack
    // is the source of what it declares restricted, and a test that reaches for
    // packs/healthcare/schema/provider.json by path asserts against a copy. A pack hands its
    // kinds over unparsed, so they go through the kernel's parser here, exactly as the pack
    // registry does at startup.
    const restricted = healthcarePack.records
      .map((r) => parseRecordKindSpec(r))
      .flatMap((r) => r.fields)
      .filter((f) => f.restricted === true)
      .map((f) => f.name);
    expect(restricted.length).toBeGreaterThan(0);
    for (const field of judgedFields) expect(restricted).not.toContain(field);
  });
});
