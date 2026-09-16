import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest.js';

const always = { isRestrictedName: () => true };
const never = { isRestrictedName: () => false };

const minimal = {
  version: '1.0.0',
  fields: [{ name: 'npi', type: 'string', description: 'x' }],
  credentials: [],
  document_kinds: ['other'],
};

describe('parseManifest', () => {
  it('fills the two defaults, so a plain field is model-sourced and not restricted', () => {
    const m = parseManifest(minimal, never);
    expect(m.fields[0]).toEqual({ name: 'npi', type: 'string', description: 'x', restricted: false, source: 'model' });
  });

  it('takes any non-empty document kind, because the pack is what defines the list', () => {
    const m = parseManifest({ ...minimal, document_kinds: ['story', 'epic'] }, never);
    expect(m.document_kinds).toEqual(['story', 'epic']);
    expect(() => parseManifest({ ...minimal, document_kinds: [] }, never)).toThrow(/document_kinds/);
  });

  it('applies the caller restricted-name check rather than a rule of its own', () => {
    const restricted = {
      ...minimal,
      fields: [{ name: 'zzz', type: 'string', description: 'x', restricted: true, source: 'redaction' }],
    };
    expect(parseManifest(restricted, always).fields[0].restricted).toBe(true);
    expect(() => parseManifest(restricted, never)).toThrow(/not recognised by isRestrictedName/);
  });
});
