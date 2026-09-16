import { ATTACHMENT_PROPERTIES, type AttachmentKindSpec, type ManifestField } from '@harness/pack-api';

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
const ATTACHMENT_PROPERTY_DESCRIPTIONS: Record<(typeof ATTACHMENT_PROPERTIES)[number], string> = {
  state: 'Two-letter US state code, or an empty string when the credential is not state-issued.',
  issuer: 'The issuing board, agency or carrier as printed.',
  issued_at: 'The issue date in YYYY-MM-DD form, or an empty string when absent.',
  expires_at: 'The expiry date in YYYY-MM-DD form, or an empty string when absent.',
};

export interface ExtractionSchemaInput {
  schemaName: string;
  documentKinds: readonly string[];
  fields: ManifestField[];
  attachmentKinds: AttachmentKindSpec[];
  /** The JSON property the attachment list is returned under. `credentials` for healthcare. */
  attachmentsKey: string;
  /**
   * The attachment array's JSON-Schema `description`, from the target's
   * `attachment_schema_description`. **Not** the prompt sentence: that is
   * `attachment_instruction` and it goes to `buildExtractionMessages`. Omitted when the target
   * declares no attachments.
   */
  attachmentsDescription?: string;
}

/**
 * The `response_format` schema. Everything is inlined: `$ref` and `$defs`
 * support is uneven across providers, and a schema the provider silently
 * ignores is worse than a verbose one.
 *
 * Restricted fields are absent by construction. The model is not asked for an
 * SSN, so no prompt-level instruction has to hold the line.
 */
export function buildExtractionSchema(input: ExtractionSchemaInput): { name: string; schema: Record<string, unknown> } {
  const modelFields = input.fields.filter((f) => f.source === 'model');
  const fieldProperties: Record<string, unknown> = {};
  for (const f of modelFields) fieldProperties[f.name] = fieldSlot(f);

  const attachmentProperties: Record<string, unknown> = {
    kind: {
      type: 'string',
      enum: input.attachmentKinds.map((a) => a.kind),
      description: 'Which kind of credential this is.',
    },
    confidence: {
      type: 'number',
      description: 'How sure you are that this credential is present in the document, from 0 to 1.',
    },
    source_page: { type: 'integer', description: 'The 1-based page this credential was read from.' },
  };
  for (const prop of ATTACHMENT_PROPERTIES) {
    attachmentProperties[prop] = { type: 'string', description: ATTACHMENT_PROPERTY_DESCRIPTIONS[prop] };
  }

  return {
    name: input.schemaName,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['document_kind', 'fields', input.attachmentsKey],
      properties: {
        document_kind: {
          type: 'string',
          enum: [...input.documentKinds],
          description: 'What kind of document this is.',
        },
        fields: {
          type: 'object',
          additionalProperties: false,
          required: modelFields.map((f) => f.name),
          properties: fieldProperties,
        },
        [input.attachmentsKey]: {
          type: 'array',
          description: input.attachmentsDescription,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'confidence', 'source_page', ...ATTACHMENT_PROPERTIES],
            properties: attachmentProperties,
          },
        },
      },
    },
  };
}

export function buildClassificationSchema(documentKinds: readonly string[]): {
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
          enum: [...documentKinds],
          description: 'What kind of document this is.',
        },
        confidence: { type: 'number', description: 'How sure you are, from 0 to 1.' },
      },
    },
  };
}
