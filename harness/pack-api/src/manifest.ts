import * as z from 'zod/v4';

/**
 * One field a pack declares on a record kind. The extractor turns the `model`-sourced ones into
 * the model-facing JSON Schema; the `redaction`-sourced ones are filled from the regex pass over
 * the document text and are dropped from that schema, which is how a model is never asked for
 * an SSN.
 */
export const ManifestFieldShape = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  type: z.enum(['string', 'number']),
  description: z.string().min(1),
  restricted: z.boolean().default(false),
  source: z.enum(['model', 'redaction']).default('model'),
});
export type ManifestField = z.infer<typeof ManifestFieldShape>;

/**
 * The checks a manifest is validated against that the contract cannot make on its own.
 *
 * `isRestrictedName` decides which field names the storage layer will encrypt. That rule is
 * domain knowledge and spec section 3 keeps it in core-tools' `shared/redaction/names.ts`, so
 * the caller hands it in. core-tools re-exports one-argument wrappers bound to its own
 * predicate, which is what every existing caller and test uses.
 */
export interface ManifestChecks {
  isRestrictedName: (name: string) => boolean;
}

/**
 * The three rules that make a restricted field safe, applied to one list of fields. Throws on
 * the first violation with the message the old `superRefine` produced, so every existing
 * assertion about those messages still matches.
 */
export function refineFields(fields: ManifestField[], { isRestrictedName }: ManifestChecks): void {
  for (const f of fields) {
    // A restricted value must never be something a model is asked to produce.
    if (f.restricted && f.source !== 'redaction') {
      throw new Error(`provider manifest is invalid: field "${f.name}" is restricted but not sourced from redaction`);
    }
    if (f.source === 'redaction' && !f.restricted) {
      throw new Error(`provider manifest is invalid: field "${f.name}" is redaction-sourced but not marked restricted`);
    }
    // The storage layer decides what to encrypt from the field *name*. A restricted field whose
    // name it does not recognise would be stored in plaintext, so the manifest refuses one.
    if (f.restricted && !isRestrictedName(f.name)) {
      throw new Error(
        `provider manifest is invalid: restricted field "${f.name}" is not recognised by isRestrictedName; add its stem to RESTRICTED_NAME_KEYS in shared/redaction/names.ts`,
      );
    }
  }
}

/** Validate a bare list of fields. Used by `parseRecordKind` and by core-tools' own tests. */
export function parseManifest(raw: unknown, checks: ManifestChecks): ManifestField[] {
  const parsed = z.array(ManifestFieldShape).min(1).safeParse(raw);
  if (!parsed.success) throw new Error(`provider manifest is invalid: ${z.prettifyError(parsed.error)}`);
  refineFields(parsed.data, checks);
  return parsed.data;
}
