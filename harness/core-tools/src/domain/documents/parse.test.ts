import { describe, it, expect } from 'vitest';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { pack as storiesPack } from '@harness/pack-stories';
import { registryOf } from '../packs/registry.js';
import { parseExtraction } from './parse.js';

/** The one target the shipped pack declares, resolved the way `documents_extract` resolves it. */
const target = registryOf([healthcarePack]).targetFor('state_license');

describe('parseExtraction', () => {
  const raw = {
    document_kind: 'state_license',
    fields: {
      first_name: { value: 'Ada', confidence: 0.98, source_page: 1 },
      last_name: { value: 'Lovelace', confidence: 0.97, source_page: 1 },
      npi: { value: '1234567890', confidence: 0.62, source_page: 1 },
      email: { value: '', confidence: 0.1, source_page: 0 },
      specialty: { value: 'Internal Medicine', confidence: 1.4, source_page: 2 },
    },
    credentials: [
      {
        kind: 'license',
        state: 'CA',
        issuer: 'Medical Board of California',
        issued_at: '2020-04-01',
        expires_at: '2027-03-31',
        confidence: 0.95,
        source_page: 1,
      },
      { kind: 'dea', state: '', issuer: '', issued_at: '', expires_at: 'not printed', confidence: 0.3, source_page: 2 },
    ],
  };

  it('keeps non-empty fields and drops empty ones', () => {
    const out = parseExtraction(raw, target);
    expect(out.fields.map((f) => f.name).sort()).toEqual(['first_name', 'last_name', 'npi', 'specialty']);
  });

  it('carries confidence and source page, clamping confidence and dropping page 0', () => {
    const out = parseExtraction(raw, target);
    expect(out.fields.find((f) => f.name === 'npi')).toEqual({
      name: 'npi',
      value: '1234567890',
      confidence: 0.62,
      source_page: 1,
    });
    expect(out.fields.find((f) => f.name === 'specialty')!.confidence).toBe(1);
  });

  it('keeps only credentials with a usable date and drops unparseable ones', () => {
    const out = parseExtraction(raw, target);
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0]).toEqual({
      kind: 'license',
      state: 'CA',
      issuer: 'Medical Board of California',
      issued_at: '2020-04-01',
      expires_at: '2027-03-31',
      confidence: 0.95,
      source_page: 1,
    });
  });

  it('never returns a restricted field even if the model volunteers one', () => {
    const sneaky = { ...raw, fields: { ...raw.fields, ssn: { value: '123-45-6789', confidence: 1, source_page: 1 } } };
    const out = parseExtraction(sneaky, target);
    expect(out.fields.map((f) => f.name)).not.toContain('ssn');
  });

  it('rejects a reply that is not an object with the three parts', () => {
    expect(() => parseExtraction({ fields: {} }, target)).toThrow(/document_kind/);
    expect(() => parseExtraction('nope', target)).toThrow();
  });

  it('falls back to "other" for an unknown document kind', () => {
    const out = parseExtraction({ ...raw, document_kind: 'passport' }, target);
    expect(out.documentKind).toBe('other');
  });
});

/**
 * Whether an attachment needs an expiry date is the attachment kind's own declaration, not a
 * rule the kernel applies to everything hung off a record.
 */
describe('parseExtraction and an attachment kind that never expires', () => {
  const storiesTarget = registryOf([storiesPack]).targetFor('meeting_notes');
  const link = { kind: 'source_link', issuer: 'JIRA', state: '', issued_at: '', confidence: 0.9, source_page: 1 };

  it('keeps a link with no expiry, because source_link declares no expires_at property', () => {
    const out = parseExtraction(
      { document_kind: 'meeting_notes', fields: {}, links: [{ ...link, expires_at: '' }] },
      storiesTarget,
    );
    expect(out.attachments).toEqual([
      {
        kind: 'source_link',
        issuer: 'JIRA',
        state: undefined,
        issued_at: undefined,
        expires_at: undefined,
        confidence: 0.9,
        source_page: 1,
      },
    ]);
  });

  it('still drops a healthcare credential with no usable expiry, because its kind declares one', () => {
    const out = parseExtraction(
      {
        document_kind: 'state_license',
        fields: {},
        credentials: [{ kind: 'license', state: 'CA', issuer: 'Board', issued_at: '', expires_at: '' }],
      },
      target,
    );
    expect(out.attachments).toEqual([]);
  });
});
