import * as z from 'zod/v4';
import { CREDENTIAL_KINDS } from '../credentials/kinds.js';

/**
 * Credential columns a template may print. `number` is deliberately absent:
 * it is stored encrypted and a filled form is released to a human, so there is
 * no path by which a credential number may reach a PDF.
 */
export const CREDENTIAL_PROPERTIES = ['issuer', 'state', 'issued_at', 'expires_at'] as const;

export const TemplateMapping = z.discriminatedUnion('source', [
  z.object({
    pdf_field: z.string().min(1),
    source: z.literal('provider'),
    property: z.enum(['name', 'npi']),
    required: z.boolean(),
  }),
  z.object({
    pdf_field: z.string().min(1),
    source: z.literal('field'),
    name: z.string().min(1),
    required: z.boolean(),
  }),
  z.object({
    pdf_field: z.string().min(1),
    source: z.literal('credential'),
    kind: z.enum(CREDENTIAL_KINDS),
    property: z.enum(CREDENTIAL_PROPERTIES),
    required: z.boolean(),
  }),
]);
export type TemplateMapping = z.infer<typeof TemplateMapping>;

export const FormTemplate = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1),
  file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/),
  mappings: z.array(TemplateMapping).min(1),
});
export type FormTemplate = z.infer<typeof FormTemplate>;

export const TemplateManifest = z.object({
  version: z.literal(1),
  templates: z.array(FormTemplate).min(1),
});
export type TemplateManifest = z.infer<typeof TemplateManifest>;

/** Everything a template or a roster may read about one provider. */
export interface ProviderData {
  provider: { name: string; npi: string | null; status: string };
  fields: { name: string; value: string | null; restricted: boolean; status: string }[];
  credentials: {
    kind: string;
    issuer: string | null;
    state: string | null;
    issuedAt: string | null;
    expiresAt: string | null;
    /**
     * Whether `number_encrypted` holds anything. The number itself is never
     * loaded — the roster's `*_on_file` columns answer "is a number stored",
     * and a credential row recorded from a document that showed an issuer and
     * an expiry but no legible number must answer no.
     */
    hasNumber: boolean;
  }[];
}

export interface ResolvedMapping {
  pdf_field: string;
  label: string;
  required: boolean;
  value: string | null;
  /** Why there is no value: the field awaits a human, or there is no record at all. */
  blocked: 'pending' | 'missing' | null;
}

/**
 * The payer roster CSV. The column list is a contract with the payer, so it is
 * a frozen array rather than a shape inferred from the data: adding a column
 * is a deliberate edit here and in packs/healthcare/forms/README.md.
 */
export const ROSTER_COLUMNS = [
  'payer_id',
  'provider_name',
  'npi',
  'primary_specialty',
  'practice_address',
  'license_state',
  'license_issuer',
  'license_expires_at',
  'license_number_on_file',
  'dea_on_file',
  'malpractice_carrier',
  'malpractice_expires_at',
  'board_cert_expires_at',
  'provider_status',
] as const;

export interface RosterRow {
  payer_id: string;
  provider_name: string;
  npi: string | null;
  primary_specialty: string | null;
  practice_address: string | null;
  license_state: string | null;
  license_issuer: string | null;
  license_expires_at: string | null;
  /** Whether a licence number is on file. The number itself is encrypted and never exported. */
  license_number_on_file: boolean;
  /** Whether a DEA registration is on file. The number itself is encrypted and never exported. */
  dea_on_file: boolean;
  malpractice_carrier: string | null;
  malpractice_expires_at: string | null;
  board_cert_expires_at: string | null;
  provider_status: string;
}
