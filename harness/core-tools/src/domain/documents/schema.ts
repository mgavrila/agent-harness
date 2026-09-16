import { ATTACHMENT_PROPERTIES } from '@harness/pack-api';
import type { AttachmentKindSpec, ExtractionManifest, ManifestField, RecordKindSpec } from './manifest.js';

/** One field's slot in the model-facing schema: the value plus how sure and from where. */
function fieldSlot(field: ManifestField): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'confidence', 'source_page'],
    description: field.description,
    properties: {
      value: {
        type: field.type,
        description: 'The value as printed, or an empty string when the document does not state it.',
      },
      confidence: {
        type: 'number',
        description: 'How sure you are, from 0 to 1. Use a low number when you are guessing.',
      },
      source_page: { type: 'integer', description: 'The 1-based page this value came from, or 0 when it is absent.' },
    },
  };
}

/** What the model is told each attachment property means. One entry per `ATTACHMENT_PROPERTIES`. */
const CREDENTIAL_PROPERTY_DESCRIPTIONS: Record<(typeof ATTACHMENT_PROPERTIES)[number], string> = {
  state: 'Two-letter US state code, or an empty string when the credential is not state-issued.',
  issuer: 'The issuing board, agency or carrier as printed.',
  issued_at: 'The issue date in YYYY-MM-DD form, or an empty string when absent.',
  expires_at: 'The expiry date in YYYY-MM-DD form, or an empty string when absent.',
};

/**
 * The `response_format` schema. Everything is inlined: `$ref` and `$defs`
 * support is uneven across providers, and a schema the provider silently
 * ignores is worse than a verbose one.
 *
 * Restricted fields are absent by construction. The model is not asked for an
 * SSN, so no prompt-level instruction has to hold the line.
 */
export function buildExtractionSchema(
  manifest: ExtractionManifest,
  kind: RecordKindSpec,
  attachments: AttachmentKindSpec[],
): { name: string; schema: Record<string, unknown> } {
  const modelFields = kind.fields.filter((f) => f.source === 'model');
  const fieldProperties: Record<string, unknown> = {};
  for (const f of modelFields) fieldProperties[f.name] = fieldSlot(f);

  const credentialProperties: Record<string, unknown> = {
    kind: {
      type: 'string',
      enum: attachments.map((a) => a.kind),
      description: 'Which kind of credential this is.',
    },
    confidence: {
      type: 'number',
      description: 'How sure you are that this credential is present in the document, from 0 to 1.',
    },
    source_page: { type: 'integer', description: 'The 1-based page this credential was read from.' },
  };
  for (const prop of ATTACHMENT_PROPERTIES) {
    credentialProperties[prop] = { type: 'string', description: CREDENTIAL_PROPERTY_DESCRIPTIONS[prop] };
  }

  return {
    name: 'provider_extraction',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['document_kind', 'fields', 'credentials'],
      properties: {
        document_kind: {
          type: 'string',
          enum: [...manifest.document_kinds],
          description: 'What kind of document this is.',
        },
        fields: {
          type: 'object',
          additionalProperties: false,
          required: modelFields.map((f) => f.name),
          properties: fieldProperties,
        },
        credentials: {
          type: 'array',
          description:
            'Credentials this document evidences. The registration, licence or policy number is deliberately NOT part of this schema and is not extracted at all: report only the kind, issuer, state and dates.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'confidence', 'source_page', ...ATTACHMENT_PROPERTIES],
            properties: credentialProperties,
          },
        },
      },
    },
  };
}

export function buildClassificationSchema(manifest: ExtractionManifest): {
  name: string;
  schema: Record<string, unknown>;
} {
  return {
    name: 'document_classification',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['document_kind', 'confidence'],
      properties: {
        document_kind: {
          type: 'string',
          enum: [...manifest.document_kinds],
          description: 'What kind of document this is.',
        },
        confidence: { type: 'number', description: 'How sure you are, from 0 to 1.' },
      },
    },
  };
}
