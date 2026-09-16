import * as z from 'zod/v4';
import { CREDENTIAL_KINDS } from '../deadlines/compute.js';

export const FieldInput = z.object({
  name: z.string().min(1),
  value: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  restricted: z.boolean().optional(),
  source_doc_id: z.string().uuid().optional(),
  source_page: z.number().int().positive().optional(),
});
export type FieldInput = z.infer<typeof FieldInput>;

export const CredentialInput = z.object({
  kind: z.enum(CREDENTIAL_KINDS),
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
});
export type CredentialInput = z.infer<typeof CredentialInput>;

export interface UpsertProviderInput {
  name: string;
  npi?: string;
  fields: FieldInput[];
  credentials: CredentialInput[];
  /**
   * Write to this provider row directly, skipping name/NPI matching entirely.
   * The caller has already resolved and client-scoped this id (typically via
   * `requireProvider`); re-deriving a match from `name`/`npi` here could
   * silently attach to, rename, or duplicate a *different* provider of the
   * same client — e.g. when the caller's provider has no NPI on file and the
   * extracted NPI happens to belong to someone else. When set, `name` and
   * `npi` are otherwise unused: the provider's own name and NPI are left
   * untouched.
   */
  providerId?: string;
}

export interface UpsertProviderResult {
  provider_id: string;
  fields_pending: number;
  fields_extracted: number;
  credentials: number;
}
