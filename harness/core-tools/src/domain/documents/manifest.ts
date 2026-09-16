import { createRequire } from 'node:module';
import * as z from 'zod/v4';
import { isRestrictedName } from '../../shared/redaction/names.js';
import { CREDENTIAL_KINDS } from '../../deadlines/compute.js';
import { DOCUMENT_KINDS } from './types.js';

// Deliberately ordered for the prompt rather than shared with the template
// manifest's list: this order is what the model reads in the schema.
export const CREDENTIAL_PROPERTIES = ['state', 'issuer', 'issued_at', 'expires_at'] as const;

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
  /**
   * Reserved, and read by nothing today. No code path populates
   * `CredentialInput.number` from a document — the pipeline does not extract
   * credential numbers at all — so `credentials.number_encrypted` is always
   * null from extraction and there is no value for this flag to govern. It
   * stays in the manifest so the declaration is already in place if numbers
   * are ever read; see the `$comment_credential_numbers` note in
   * packs/healthcare/schema/provider.json.
   */
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
          message: `restricted field "${f.name}" is not recognised by isRestrictedName; add its stem to RESTRICTED_NAME_KEYS in shared/redaction/names.ts`,
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
