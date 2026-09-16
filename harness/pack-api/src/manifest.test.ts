import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest.js';

const always = { isRestrictedName: () => true };
const never = { isRestrictedName: () => false };

const minimal = [{ name: 'npi', type: 'string', description: 'x' }];

describe('parseManifest', () => {
  it('fills the two defaults, so a plain field is model-sourced and not restricted', () => {
    const fields = parseManifest(minimal, never);
    expect(fields[0]).toEqual({ name: 'npi', type: 'string', description: 'x', restricted: false, source: 'model' });
  });

  it('applies the caller restricted-name check rather than a rule of its own', () => {
    const restricted = [{ name: 'zzz', type: 'string', description: 'x', restricted: true, source: 'redaction' }];
    expect(parseManifest(restricted, always)[0].restricted).toBe(true);
    expect(() => parseManifest(restricted, never)).toThrow(/not recognised by isRestrictedName/);
  });

  it('refuses an empty list, because a record kind with no fields can store nothing', () => {
    expect(() => parseManifest([], never)).toThrow(/provider manifest is invalid/);
  });
});
