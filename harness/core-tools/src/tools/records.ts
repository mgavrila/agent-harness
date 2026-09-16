import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import type { PackRegistry } from '../domain/packs/types.js';
import { AttachmentInput, FieldInput } from '../domain/records/types.js';
import {
  confirmField,
  listPendingFields,
  readRecord,
  searchRecords,
  upsertRecord,
} from '../domain/records/repository.js';
import { MASKED, isRestrictedName } from '../shared/redaction/names.js';

/**
 * The five names the publication gate in `tools/catalog.ts` checks. They are published only when
 * at least one loaded record kind leaves `genericTools` true — a deployment whose every kind is
 * served by a pack's own tools publishes none of them, and its catalogue is exactly what the
 * packs named.
 */
export const GENERIC_RECORD_TOOLS = [
  'records_upsert',
  'records_get',
  'records_search',
  'records_confirm_field',
  'records_list_pending',
] as const;

const RecordFieldView = z.object({
  name: z.string(),
  value: z.string().nullable(),
  restricted: z.boolean(),
  confidence: z.number().nullable(),
  status: z.string(),
  source_page: z.number().nullable(),
});

const RecordAttachmentView = z.object({
  id: z.string(),
  kind: z.string(),
  issuer: z.string().nullable(),
  number: z.string().nullable(),
  state: z.string().nullable(),
  issued_at: z.string().nullable(),
  expires_at: z.string().nullable(),
  properties: z.record(z.string(), z.string()),
});

/**
 * Every declared kind, aliased or not.
 *
 * Deliberately not just the kinds that left `genericTools` true: when a second pack is loaded
 * beside one that ships its own tools, the generic tools are published and must still reach the
 * first pack's records — a shared store with two front doors, not two stores.
 */
function kindEnum(packs: PackRegistry) {
  return z.enum(packs.recordKinds().map((r) => r.kind) as [string, ...string[]]);
}

export function recordTools(packs: PackRegistry): AnyToolDef[] {
  const kind = kindEnum(packs);

  const recordsUpsert = defineTool({
    name: 'records_upsert',
    description:
      'Create or update a record of a declared kind with extracted fields and attachments. Matches an existing record by external_id (or by name when there is none). ' +
      'Fields named for a restricted identifier (ssn, social security number, ein, tax id, dea number) are always encrypted and never returned in plaintext, ' +
      'whatever `restricted` says; set `restricted: true` to protect any other field.',
    actionClass: 'write.internal',
    input: z.object({
      kind,
      name: z.string().min(1),
      external_id: z.string().min(1).optional(),
      fields: z.array(FieldInput).default([]),
      attachments: z.array(AttachmentInput).default([]),
    }),
    output: z.object({
      record_id: z.string(),
      fields_pending: z.number(),
      fields_extracted: z.number(),
      attachments: z.number(),
    }),
    handler: async (args, deps) => upsertRecord(deps, args),
    recordIds: (_args, result) => [result.record_id],
    // A parked approval stores its payload as plaintext jsonb, so restricted field values and
    // attachment numbers are masked out of it here. The full arguments remain available,
    // encrypted, in approvals.payload_encrypted.
    redact: (args) => ({
      ...args,
      fields: args.fields.map((f) => (f.restricted === true || isRestrictedName(f.name) ? { ...f, value: MASKED } : f)),
      attachments: args.attachments.map((a) => (a.number === undefined ? a : { ...a, number: MASKED })),
    }),
  });

  const recordsGet = defineTool({
    name: 'records_get',
    description: 'Return a record with its fields and attachments. Restricted values are masked.',
    actionClass: 'read',
    input: z.object({ record_id: z.string().uuid() }),
    output: z.object({
      record: z.object({
        id: z.string(),
        kind: z.string(),
        name: z.string(),
        external_id: z.string().nullable(),
        status: z.string(),
      }),
      fields: z.array(RecordFieldView),
      attachments: z.array(RecordAttachmentView),
    }),
    handler: async ({ record_id }, deps) => readRecord(deps, record_id),
    recordIds: ({ record_id }) => [record_id],
  });

  const recordsSearch = defineTool({
    name: 'records_search',
    description:
      'Search records by name fragment, exact external id, or both. Both given matches either, so one string can be tried as a name and as an identifier at once.',
    actionClass: 'read',
    input: z.object({
      kind: kind.optional(),
      name: z.string().min(1).optional(),
      external_id: z.string().min(1).optional(),
    }),
    output: z.object({
      records: z.array(
        z.object({
          record_id: z.string(),
          kind: z.string(),
          name: z.string(),
          external_id: z.string().nullable(),
        }),
      ),
    }),
    handler: async (args, deps) => searchRecords(deps, args),
  });

  const recordsConfirmField = defineTool({
    name: 'records_confirm_field',
    description: 'A human confirms or corrects a field value. Marks it verified.',
    actionClass: 'write.internal',
    input: z.object({
      record_id: z.string().uuid(),
      field: z.string().min(1),
      value: z.string(),
      confirmed_by: z.string().optional(),
    }),
    output: z.object({ record_id: z.string(), field: z.string(), status: z.literal('verified') }),
    handler: async (args, deps) => {
      await confirmField(deps, args);
      return { record_id: args.record_id, field: args.field, status: 'verified' as const };
    },
    recordIds: ({ record_id }) => [record_id],
    redact: (args) => (isRestrictedName(args.field) ? { ...args, value: MASKED } : args),
  });

  const recordsListPending = defineTool({
    name: 'records_list_pending',
    description: 'List fields that still need human confirmation for a record.',
    actionClass: 'read',
    input: z.object({ record_id: z.string().uuid() }),
    output: z.object({
      fields: z.array(
        z.object({ name: z.string(), confidence: z.number().nullable(), source_page: z.number().nullable() }),
      ),
    }),
    handler: async ({ record_id }, deps) => listPendingFields(deps, record_id),
  });

  return [recordsUpsert, recordsGet, recordsSearch, recordsConfirmField, recordsListPending];
}
