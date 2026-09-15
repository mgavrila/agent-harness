import { createRequire } from 'node:module';
import * as z from 'zod/v4';
import { isRestrictedName } from '../tools/providers.js';
import { DOCUMENT_KINDS } from './storage.js';

const CREDENTIAL_KINDS = ['license', 'dea', 'malpractice', 'board_cert'] as const;
const CREDENTIAL_PROPERTIES = ['state', 'issuer', 'issued_at', 'expires_at'] as const;

const ManifestField = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  type: z.enum(['string', 'number']),
  description: z.string().min(1),
  restricted: z.boolean().default(false),
  /**
   * Where the value comes from. `redaction` fields are filled from the regex
   * pass over the document text and are dropped from the model-facing schema.
   */
  source: z.enum(['model', 'redaction']).default('model'),
});
export type ManifestField = z.infer<typeof ManifestField>;

const ManifestCredential = z.object({
  kind: z.enum(CREDENTIAL_KINDS),
  description: z.string().min(1),
  number_restricted: z.boolean(),
  properties: z.array(z.enum(CREDENTIAL_PROPERTIES)).min(1),
});
export type ManifestCredential = z.infer<typeof ManifestCredential>;

const ProviderManifest = z
  .object({
    version: z.string().min(1),
    fields: z.array(ManifestField).min(1),
    credentials: z.array(ManifestCredential),
    document_kinds: z.array(z.enum(DOCUMENT_KINDS)).min(1),
  })
  .superRefine((m, ctx) => {
    for (const f of m.fields) {
      // A restricted value must never be something a model is asked to produce.
      if (f.restricted && f.source !== 'redaction') {
        ctx.addIssue({ code: 'custom', message: `field "${f.name}" is restricted but not sourced from redaction` });
      }
      if (f.source === 'redaction' && !f.restricted) {
        ctx.addIssue({ code: 'custom', message: `field "${f.name}" is redaction-sourced but not marked restricted` });
      }
      // The storage layer decides what to encrypt from the field *name*. A
      // restricted field whose name it does not recognise would be stored in
      // plaintext, so the manifest refuses to declare one.
      if (f.restricted && !isRestrictedName(f.name)) {
        ctx.addIssue({
          code: 'custom',
          message: `restricted field "${f.name}" is not recognised by isRestrictedName; add its stem to RESTRICTED_NAME_KEYS in tools/providers.ts`,
        });
      }
    }
  });
export type ProviderManifest = z.infer<typeof ProviderManifest>;

export function parseManifest(raw: unknown): ProviderManifest {
  const parsed = ProviderManifest.safeParse(raw);
  if (!parsed.success) throw new Error(`provider manifest is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

// A JSON import would need an import attribute and a resolver flag; a require
// keeps the manifest loadable from tsx, vitest and a built bundle alike.
const requireJson = createRequire(import.meta.url);

let cached: ProviderManifest | undefined;

export function loadHealthcareManifest(): ProviderManifest {
  cached ??= parseManifest(requireJson('@harness/pack-healthcare/schema') as unknown);
  return cached;
}

/** One field's slot in the model-facing schema: the value plus how sure and from where. */
function fieldSlot(field: ManifestField): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['value', 'confidence', 'source_page'],
    description: field.description,
    properties: {
      value: { type: field.type, description: 'The value as printed, or an empty string when the document does not state it.' },
      confidence: { type: 'number', description: 'How sure you are, from 0 to 1. Use a low number when you are guessing.' },
      source_page: { type: 'integer', description: 'The 1-based page this value came from, or 0 when it is absent.' },
    },
  };
}

/**
 * The `response_format` schema. Everything is inlined: `$ref` and `$defs`
 * support is uneven across providers, and a schema the provider silently
 * ignores is worse than a verbose one.
 *
 * Restricted fields are absent by construction. The model is not asked for an
 * SSN, so no prompt-level instruction has to hold the line.
 */
export function buildExtractionSchema(manifest: ProviderManifest): { name: string; schema: Record<string, unknown> } {
  const modelFields = manifest.fields.filter((f) => f.source === 'model');
  const fieldProperties: Record<string, unknown> = {};
  for (const f of modelFields) fieldProperties[f.name] = fieldSlot(f);

  const credentialProperties: Record<string, unknown> = {
    kind: { type: 'string', enum: [...CREDENTIAL_KINDS], description: 'Which kind of credential this is.' },
    confidence: { type: 'number', description: 'How sure you are that this credential is present in the document, from 0 to 1.' },
    source_page: { type: 'integer', description: 'The 1-based page this credential was read from.' },
  };
  for (const prop of CREDENTIAL_PROPERTIES) {
    credentialProperties[prop] = {
      type: 'string',
      description:
        prop === 'state'
          ? 'Two-letter US state code, or an empty string when the credential is not state-issued.'
          : prop === 'issuer'
            ? 'The issuing board, agency or carrier as printed.'
            : `The ${prop === 'issued_at' ? 'issue' : 'expiry'} date in YYYY-MM-DD form, or an empty string when absent.`,
    };
  }

  return {
    name: 'provider_extraction',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['document_kind', 'fields', 'credentials'],
      properties: {
        document_kind: { type: 'string', enum: [...manifest.document_kinds], description: 'What kind of document this is.' },
        fields: {
          type: 'object',
          additionalProperties: false,
          required: modelFields.map((f) => f.name),
          properties: fieldProperties,
        },
        credentials: {
          type: 'array',
          description:
            'Credentials this document evidences. The registration or policy number is deliberately NOT part of this schema; it is read separately and never sent to a model.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'confidence', 'source_page', ...CREDENTIAL_PROPERTIES],
            properties: credentialProperties,
          },
        },
      },
    },
  };
}

export function buildClassificationSchema(manifest: ProviderManifest): { name: string; schema: Record<string, unknown> } {
  return {
    name: 'document_classification',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['document_kind', 'confidence'],
      properties: {
        document_kind: { type: 'string', enum: [...manifest.document_kinds], description: 'What kind of document this is.' },
        confidence: { type: 'number', description: 'How sure you are, from 0 to 1.' },
      },
    },
  };
}
