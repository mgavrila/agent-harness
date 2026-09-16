import { describe, it, expect } from 'vitest';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { parseAttachmentKindSpec, parseRecordKindSpec } from './manifest.js';
import { buildClassificationSchema, buildExtractionSchema } from './schema.js';

const manifest = healthcarePack.extraction;
const provider = parseRecordKindSpec(healthcarePack.records[0]);
const attachments = (healthcarePack.attachments ?? []).map((a) => parseAttachmentKindSpec(a));
const [target] = manifest.targets;

describe('buildExtractionSchema', () => {
  const { name, schema } = buildExtractionSchema({
    schemaName: target.schema_name,
    documentKinds: manifest.document_kinds,
    fields: provider.fields,
    attachmentKinds: attachments,
    attachmentsKey: target.attachments_key,
    attachmentsDescription: target.attachment_schema_description,
    attachmentDescriptions: target.attachment_descriptions,
  });
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
        value: {
          type: 'string',
          description: 'The value as printed, or an empty string when the document does not state it.',
        },
        confidence: {
          type: 'number',
          description: 'How sure you are, from 0 to 1. Use a low number when you are guessing.',
        },
        source_page: { type: 'integer', description: 'The 1-based page this value came from, or 0 when it is absent.' },
      },
    });
  });

  it('describes credentials as an array of kind-tagged objects without a number', () => {
    const items = (props.credentials as { items: Record<string, unknown> }).items;
    const itemProps = items.properties as Record<string, Record<string, unknown>>;
    expect(itemProps.kind.enum).toEqual(['license', 'dea', 'malpractice', 'board_cert']);
    expect(Object.keys(itemProps)).not.toContain('number');
    expect(Object.keys(itemProps).sort()).toEqual([
      'confidence',
      'expires_at',
      'issued_at',
      'issuer',
      'kind',
      'source_page',
      'state',
    ]);
  });

  /**
   * A pack that describes no attachment slot still gets a working schema, and what the model
   * reads in that case is the kernel's own wording. The kernel does not know what hangs off a
   * record — "credential" is this pack's noun for it, "link" would be another's — so its floor
   * has to say nothing about any one area of the product, and this is the assertion that keeps
   * it that way.
   */
  it('falls back to its own colourless wording for a target that describes no slot', () => {
    const { schema: bare } = buildExtractionSchema({
      schemaName: target.schema_name,
      documentKinds: manifest.document_kinds,
      fields: provider.fields,
      attachmentKinds: attachments,
      attachmentsKey: target.attachments_key,
      attachmentsDescription: target.attachment_schema_description,
    });
    const bareProps = bare.properties as Record<string, { items: { properties: Record<string, unknown> } }>;
    const slots = bareProps[target.attachments_key].items.properties as Record<string, { description: string }>;
    expect(slots.kind.description).toBe('Which kind of attachment this is.');
    expect(slots.source_page.description).toBe('The 1-based page this attachment was read from.');
    expect(slots.issuer.description).toBe('The issuing organisation as printed.');
    // Every slot is described, and none of the wording borrows a word from this pack.
    const wording = Object.values(slots).map((s) => s.description);
    expect(wording.every((d) => typeof d === 'string' && d.length > 0)).toBe(true);
    expect(wording.join(' ')).not.toMatch(/credential|licen[cs]e|provider|policy|carrier|board/i);
  });

  it('inlines everything, so no provider has to resolve a $ref', () => {
    const text = JSON.stringify(schema);
    expect(text).not.toContain('$ref');
    expect(text).not.toContain('$defs');
  });
});

describe('buildClassificationSchema', () => {
  it('asks only for a kind and a confidence', () => {
    const { name, schema } = buildClassificationSchema(manifest.document_kinds);
    expect(name).toBe('document_classification');
    expect(schema.required).toEqual(['document_kind', 'confidence']);
    const props = schema.properties as Record<string, { enum?: string[] }>;
    expect(props.document_kind.enum).toEqual([
      'state_license',
      'dea_certificate',
      'malpractice_certificate',
      'w9',
      'other',
    ]);
  });
});
