import * as z from 'zod/v4';
import { CREDENTIAL_KINDS } from './credentials.js';

// Deliberately ordered for the prompt rather than shared with the template
// manifest's list: this order is what the model reads in the schema.
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

/**
 * `document_kinds` is plain strings, not an enum.
 *
 * Before the pack contract existed, this was checked against core-tools' `DOCUMENT_KINDS`.
 * The pack is now the *source* of that list — `Pack.documentKinds` is this very field — so
 * validating it against a copy of itself would be circular, and keeping the copy in core-tools
 * is exactly the hard-coding the contract removes. What guards the list instead is the public
 * surface snapshot: `documents_ingest.input.kind` is built from the loaded registry, and a
 * changed or reordered list fails `surface.test.ts`.
 */
const ProviderManifestShape = z.object({
  version: z.string().min(1),
  fields: z.array(ManifestField).min(1),
  credentials: z.array(ManifestCredential),
  document_kinds: z.array(z.string().min(1)).min(1),
});
export type ProviderManifest = z.infer<typeof ProviderManifestShape>;

/**
 * The checks a manifest is validated against that the contract cannot make on its own.
 *
 * `isRestrictedName` decides which field names the storage layer will encrypt. That rule is
 * domain knowledge and spec section 3 keeps it in core-tools' `shared/redaction/names.ts`, so
 * the caller hands it in. core-tools re-exports a one-argument `parseManifest` bound to its
 * own predicate, which is what every existing caller and test uses.
 */
export interface ManifestChecks {
  isRestrictedName: (name: string) => boolean;
}

function schemaFor({ isRestrictedName }: ManifestChecks) {
  return ProviderManifestShape.superRefine((m, ctx) => {
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
}

export function parseManifest(raw: unknown, checks: ManifestChecks): ProviderManifest {
  const parsed = schemaFor(checks).safeParse(raw);
  if (!parsed.success) throw new Error(`provider manifest is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
