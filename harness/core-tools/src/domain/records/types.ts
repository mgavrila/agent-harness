import * as z from 'zod/v4';

export const FieldInput = z.object({
  name: z.string().min(1),
  value: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  restricted: z.boolean().optional(),
  source_doc_id: z.string().uuid().optional(),
  source_page: z.number().int().positive().optional(),
});
export type FieldInput = z.infer<typeof FieldInput>;

/**
 * Something to attach to a record.
 *
 * `kind` is a plain string, not an enum: the kinds come from the loaded packs' declarations and
 * `upsertRecord` checks it against them, so the kernel never carries a copy of one pack's
 * vocabulary. `number` is the only member that may be restricted and it is the only one written
 * to a `bytea` column.
 */
export const AttachmentInput = z.object({
  kind: z.string().min(1),
  issuer: z.string().optional(),
  number: z.string().optional(),
  state: z.string().length(2).optional(),
  issued_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  expires_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  source_doc_id: z.string().uuid().optional(),
  /** Whatever else the attachment kind declares. Plaintext jsonb: never a restricted value. */
  properties: z.record(z.string(), z.string()).optional(),
});
export type AttachmentInput = z.infer<typeof AttachmentInput>;

export interface UpsertRecordInput {
  kind: string;
  name: string;
  external_id?: string;
  fields: FieldInput[];
  attachments: AttachmentInput[];
  /**
   * Write to this record row directly, skipping name/external-id matching entirely. The caller
   * has already resolved and client-scoped this id (typically via `requireRecord`); re-deriving
   * a match from `name`/`external_id` here could silently attach to, rename, or duplicate a
   * *different* record of the same client — e.g. when the caller's record has no external id on
   * file and the extracted one happens to belong to someone else. When set, `name` and
   * `external_id` are otherwise unused: the record's own name and external id are left untouched.
   */
  recordId?: string;
}
