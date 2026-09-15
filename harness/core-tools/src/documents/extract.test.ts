import { describe, it, expect } from 'vitest';
import { isRestrictedName } from '../tools/providers.js';
import {
  buildClassificationSchema,
  buildExtractionSchema,
  loadHealthcareManifest,
  parseManifest,
} from './extract.js';

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

describe('buildExtractionSchema', () => {
  const { name, schema } = buildExtractionSchema(manifest);
  const props = schema.properties as Record<string, Record<string, unknown>>;
  const fieldProps = props.fields.properties as Record<string, unknown>;

  it('is a strict object naming its three top-level parts', () => {
    expect(name).toBe('provider_extraction');
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['document_kind', 'fields', 'credentials']);
  });

  it('never asks the model for a restricted field', () => {
    expect(Object.keys(fieldProps)).not.toContain('ssn');
    expect(Object.keys(fieldProps)).not.toContain('ein');
    expect(Object.keys(fieldProps)).not.toContain('dea_number');
    expect(Object.keys(fieldProps)).toContain('npi');
    expect(JSON.stringify(schema)).not.toMatch(/ssn|social security/i);
  });

  it('gives every field a value, confidence and source page', () => {
    expect(fieldProps.npi).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['value', 'confidence', 'source_page'],
      description: 'Ten-digit National Provider Identifier. Digits only, no spaces.',
      properties: {
        value: { type: 'string', description: 'The value as printed, or an empty string when the document does not state it.' },
        confidence: { type: 'number', description: 'How sure you are, from 0 to 1. Use a low number when you are guessing.' },
        source_page: { type: 'integer', description: 'The 1-based page this value came from, or 0 when it is absent.' },
      },
    });
  });

  it('describes credentials as an array of kind-tagged objects without a number', () => {
    const items = (props.credentials as { items: Record<string, unknown> }).items;
    const itemProps = items.properties as Record<string, Record<string, unknown>>;
    expect(itemProps.kind.enum).toEqual(['license', 'dea', 'malpractice', 'board_cert']);
    expect(Object.keys(itemProps)).not.toContain('number');
    expect(Object.keys(itemProps).sort()).toEqual(['confidence', 'expires_at', 'issued_at', 'issuer', 'kind', 'source_page', 'state']);
  });

  it('inlines everything, so no provider has to resolve a $ref', () => {
    const text = JSON.stringify(schema);
    expect(text).not.toContain('$ref');
    expect(text).not.toContain('$defs');
  });
});

describe('buildClassificationSchema', () => {
  it('asks only for a kind and a confidence', () => {
    const { name, schema } = buildClassificationSchema(manifest);
    expect(name).toBe('document_classification');
    expect(schema.required).toEqual(['document_kind', 'confidence']);
    const props = schema.properties as Record<string, { enum?: string[] }>;
    expect(props.document_kind.enum).toEqual(['state_license', 'dea_certificate', 'malpractice_certificate', 'w9', 'other']);
  });
});
