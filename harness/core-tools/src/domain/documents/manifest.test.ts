import { describe, it, expect } from 'vitest';
import { isRestrictedName } from '../../shared/redaction/names.js';
import { loadHealthcareManifest, parseManifest } from './manifest.js';

const manifest = loadHealthcareManifest();

describe('loadHealthcareManifest', () => {
  it('validates the shipped manifest', () => {
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.fields.length).toBeGreaterThan(10);
    expect(manifest.credentials.map((c) => c.kind)).toEqual(['license', 'dea', 'malpractice', 'board_cert']);
  });

  it('marks exactly the redaction-sourced fields restricted', () => {
    const redaction = manifest.fields.filter((f) => f.source === 'redaction').map((f) => f.name);
    expect(redaction).toEqual(['ssn', 'ein', 'dea_number']);
    for (const name of redaction) {
      expect(isRestrictedName(name)).toBe(true);
    }
  });
});

describe('parseManifest', () => {
  it('rejects a restricted field that is not redaction-sourced', () => {
    expect(() =>
      parseManifest({
        version: '1.0.0',
        fields: [{ name: 'ssn', type: 'string', description: 'x', restricted: true, source: 'model' }],
        credentials: [],
        document_kinds: ['other'],
      }),
    ).toThrow(/restricted/);
  });

  it('rejects a field whose name would not be treated as restricted downstream', () => {
    expect(() =>
      parseManifest({
        version: '1.0.0',
        fields: [{ name: 'secret_code', type: 'string', description: 'x', restricted: true, source: 'redaction' }],
        credentials: [],
        document_kinds: ['other'],
      }),
    ).toThrow(/secret_code/);
  });
});
