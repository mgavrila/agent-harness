import * as z from 'zod/v4';
import { ConfigError } from '@harness/shared';
import { ManifestFieldShape, refineFields, type ManifestChecks, type ManifestField } from './manifest.js';

/**
 * The four columns the record model stores on an attachment beside its kind and its dates.
 * A pack names the subset its templates and its extractor read; the kernel stores all four.
 */
export const ATTACHMENT_PROPERTIES = ['state', 'issuer', 'issued_at', 'expires_at'] as const;
export type AttachmentProperty = (typeof ATTACHMENT_PROPERTIES)[number];

/**
 * How a record kind's stable outside identifier is read out of an extraction.
 *
 * `digitsOnly` strips every non-digit before the length check, because the same NPI is printed
 * `1234567890` on one form and `1234-567-890` on another, and `records.external_id` carries a
 * unique index per client: two spellings of one identifier must not become two records.
 */
export interface ExternalIdSpec {
  /** A field this kind declares. Its extracted value becomes `records.external_id`. */
  field: string;
  digitsOnly: boolean;
  /** Reject a normalised value that is not exactly this long. Omit to accept any non-empty one. */
  length?: number;
}

/**
 * One kind of thing a pack stores: `provider`, `epic`, whatever comes next.
 *
 * The kernel owns the tables; this says what goes in them. `fields` is the field manifest for
 * this kind — the same `ManifestField` the extractor builds its model-facing schema from — and
 * `nameFields` says which of them, joined by a space, make the human-readable `records.name`.
 */
export interface RecordKindSpec {
  /** Lowercase identifier. Stored in `records.kind` and published in the `records_*` tool enums. */
  kind: string;
  /** Title case, for a message a human reads. */
  label: string;
  fields: ManifestField[];
  /** Declared fields whose values, joined by a space and with the empties dropped, are the record's name. */
  nameFields: readonly string[];
  externalId?: ExternalIdSpec;
  /**
   * Whether the kernel publishes its generic `records_*` tools for this kind. A pack that ships
   * tools of its own for the kind sets it false and the kernel stays out of the catalogue; the
   * kind is still listed in the `records_*` `kind` enum, so a *second* pack's generic tools
   * still reach these records. Default true.
   */
  genericTools?: boolean;
  /**
   * What `documents_extract` throws when it can find no name for a new record of this kind.
   * The pack owns this string because an agent reads it. Default names the kind.
   */
  missingNameError?: string;
}

/**
 * One kind of thing attached to a record: a licence, a DEA registration, a link to a ticket.
 *
 * `leadDays` is how far before the expiry date a `renewal_start` deadline falls. **Zero means
 * this kind has no renewal deadline at all**, which is the honest answer for an attachment
 * that never expires, rather than a renewal on the day it lapses.
 */
export interface AttachmentKindSpec {
  kind: string;
  label: string;
  leadDays: number;
  /** Whether `attachments.number_encrypted` may hold a value for this kind. */
  numberRestricted: boolean;
  properties: readonly AttachmentProperty[];
}

const KIND = /^[a-z][a-z0-9_]*$/;

/** Declare a record kind, with the checks that turn a typo into a startup failure. */
export function defineRecordKind(spec: RecordKindSpec): RecordKindSpec {
  if (!KIND.test(spec.kind)) {
    throw new ConfigError(`record kind "${spec.kind}" must be lowercase letters, digits and underscores`);
  }
  if (spec.label.trim() === '') throw new ConfigError(`record kind "${spec.kind}" has no label`);
  if (spec.fields.length === 0) throw new ConfigError(`record kind "${spec.kind}" declares no fields`);
  if (spec.nameFields.length === 0) throw new ConfigError(`record kind "${spec.kind}" declares no nameFields`);
  const byName = new Map(spec.fields.map((f) => [f.name, f]));
  for (const name of spec.nameFields) {
    const field = byName.get(name);
    if (!field) {
      throw new ConfigError(`record kind "${spec.kind}" nameFields names "${name}", which is not one of its fields`);
    }
    // `records.name` is a plaintext text column and every read returns it.
    if (field.restricted) {
      throw new ConfigError(`record kind "${spec.kind}" nameFields names the restricted field "${name}"`);
    }
  }
  if (spec.externalId) {
    const field = byName.get(spec.externalId.field);
    if (!field) {
      throw new ConfigError(
        `record kind "${spec.kind}" externalId names "${spec.externalId.field}", which is not one of its fields`,
      );
    }
    if (field.restricted) {
      throw new ConfigError(`record kind "${spec.kind}" externalId names the restricted field "${field.name}"`);
    }
  }
  return spec;
}

/** Declare an attachment kind. */
export function defineAttachmentKind(spec: AttachmentKindSpec): AttachmentKindSpec {
  if (!KIND.test(spec.kind)) {
    throw new ConfigError(`attachment kind "${spec.kind}" must be lowercase letters, digits and underscores`);
  }
  if (spec.label.trim() === '') throw new ConfigError(`attachment kind "${spec.kind}" has no label`);
  if (!Number.isInteger(spec.leadDays) || spec.leadDays < 0) {
    throw new ConfigError(`attachment kind "${spec.kind}" leadDays must be zero or more whole days`);
  }
  for (const property of spec.properties) {
    if (!(ATTACHMENT_PROPERTIES as readonly string[]).includes(property)) {
      throw new ConfigError(`attachment kind "${spec.kind}" names unknown property "${property}"`);
    }
  }
  return spec;
}

const RecordKindShape = z.object({
  kind: z.string().min(1),
  label: z.string().min(1),
  fields: z.array(ManifestFieldShape).min(1),
  nameFields: z.array(z.string().min(1)).min(1),
  externalId: z
    .object({
      field: z.string().min(1),
      digitsOnly: z.boolean().default(false),
      length: z.number().int().positive().optional(),
    })
    .optional(),
  genericTools: z.boolean().default(true),
  missingNameError: z.string().min(1).optional(),
});

const AttachmentKindShape = z.object({
  kind: z.string().min(1),
  label: z.string().min(1),
  leadDays: z.number().int().min(0).default(0),
  numberRestricted: z.boolean().default(false),
  properties: z.array(z.enum(ATTACHMENT_PROPERTIES)),
});

/**
 * Read a record kind out of the JSON a human edits, then run the same checks `defineRecordKind`
 * runs. `checks.isRestrictedName` is the kernel's own rule about which names get encrypted, so
 * it is handed in — see `manifest.ts`.
 */
export function parseRecordKind(raw: unknown, checks: ManifestChecks): RecordKindSpec {
  const parsed = RecordKindShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`record kind is invalid: ${z.prettifyError(parsed.error)}`);
  refineFields(parsed.data.fields, checks);
  return defineRecordKind(parsed.data);
}

export function parseAttachmentKind(raw: unknown): AttachmentKindSpec {
  const parsed = AttachmentKindShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`attachment kind is invalid: ${z.prettifyError(parsed.error)}`);
  return defineAttachmentKind(parsed.data);
}
