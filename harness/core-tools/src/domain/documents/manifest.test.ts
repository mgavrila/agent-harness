import { describe, it, expect } from 'vitest';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { isRestrictedName } from '../../shared/redaction/names.js';
import { parseAttachmentKindSpec, parseRecordKindSpec } from './manifest.js';

const provider = parseRecordKindSpec(healthcarePack.records[0]);

describe('the healthcare pack manifest', () => {
  it('validates the shipped manifest', () => {
    expect(healthcarePack.extraction.version).toBe('1.0.0');
    expect(provider.fields.length).toBeGreaterThan(10);
    expect((healthcarePack.attachments ?? []).map((c) => c.kind)).toEqual([
      'license',
      'dea',
      'malpractice',
      'board_cert',
    ]);
  });

  it('marks exactly the redaction-sourced fields restricted', () => {
    const redaction = provider.fields.filter((f) => f.source === 'redaction').map((f) => f.name);
    expect(redaction).toEqual(['ssn', 'ein', 'dea_number']);
    for (const name of redaction) {
      expect(isRestrictedName(name)).toBe(true);
    }
  });
});

describe('parseRecordKindSpec', () => {
  const kindWith = (field: Record<string, unknown>) => ({
    kind: 'provider',
    label: 'Provider',
    nameFields: ['last_name'],
    fields: [{ name: 'last_name', type: 'string', description: 'x' }, field],
  });

  it('rejects a restricted field that is not redaction-sourced', () => {
    expect(() =>
      parseRecordKindSpec(
        kindWith({ name: 'ssn', type: 'string', description: 'x', restricted: true, source: 'model' }),
      ),
    ).toThrow(/restricted/);
  });

  it('rejects a field whose name would not be treated as restricted downstream', () => {
    expect(() =>
      parseRecordKindSpec(
        kindWith({ name: 'secret_code', type: 'string', description: 'x', restricted: true, source: 'redaction' }),
      ),
    ).toThrow(/secret_code/);
  });

  it('accepts every attachment kind the pack ships', () => {
    for (const raw of healthcarePack.attachments ?? []) {
      expect(parseAttachmentKindSpec(raw).leadDays).toBeGreaterThan(0);
    }
  });
});
