/**
 * The five `providers_*` wrappers: renames over the kernel's `records_*` tools.
 *
 * They are renames and not replacements, so none of them is in `HEALTHCARE_REPLACES`. The five
 * `records_*` names they stand in for are hidden from a healthcare-only deployment by
 * `genericTools: false` on the `provider` record kind instead, which is per kind rather than
 * per process and so leaves the generic record tools reachable for a second loaded pack.
 *
 * Every schema here is the object the pre-Plan-5 `tools/providers.ts` declared, copied without
 * an edit, down to the order of its members: the resolved JSON Schema an MCP client receives has
 * to be the same bytes, and `docs/architecture/tool-surface.json` is what proves it.
 */
import * as z from 'zod/v4';
import {
  definePackTool,
  type AnyToolDef,
  type PackToolDeps,
  type RecordsGetResult,
  type RecordsListPendingResult,
  type RecordsSearchResult,
  type RecordsUpsertResult,
} from '@harness/pack-api';
import { CREDENTIAL_KINDS } from '../../domain/credentials/kinds.js';
import { FieldInput } from '../shapes.js';
import { callKernel } from '../../shared/kernel-call.js';

/**
 * The credential input, written out rather than derived from `AttachmentInput`.
 *
 * `AttachmentInput.extend({ kind }).omit({ properties })` would produce the same *set* of
 * members and a different *order* — `extend` appends — and JSON Schema property order is part of
 * the bytes `docs/architecture/tool-surface.json` records. So this is `domain/providers/types.ts`
 * character for character, closed enum included; the kernel's `AttachmentInput` takes a plain
 * string and checks it against the loaded packs instead.
 */
const CredentialInput = z.object({
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

/**
 * A factory rather than a module-level array, because `redact` is handed only the tool's own
 * arguments: the two redaction primitives it needs have to be closed over from the dependency
 * bag this was built with. The other two groups need no closure and are plain arrays.
 */
export function providerAliases(deps: PackToolDeps): AnyToolDef[] {
  const { MASKED, isRestrictedName } = deps.kernel;

  const providersUpsert = definePackTool({
    name: 'providers_upsert',
    description:
      'Create or update a provider record with extracted fields and credentials. Matches an existing provider by NPI (or by name when no NPI). ' +
      'Fields named for a restricted identifier (ssn, social security number, ein, tax id, dea number) are always encrypted and never returned in plaintext, ' +
      'whatever `restricted` says; set `restricted: true` to protect any other field.',
    actionClass: 'write.internal',
    input: z.object({
      name: z.string().min(1),
      npi: z
        .string()
        .regex(/^\d{10}$/)
        .optional(),
      fields: z.array(FieldInput).default([]),
      credentials: z.array(CredentialInput).default([]),
    }),
    output: z.object({
      provider_id: z.string(),
      fields_pending: z.number(),
      fields_extracted: z.number(),
      credentials: z.number(),
    }),
    handler: async (args, deps) => {
      const r = await callKernel<RecordsUpsertResult>(deps, 'records_upsert', {
        kind: 'provider',
        name: args.name,
        external_id: args.npi,
        fields: args.fields,
        attachments: args.credentials,
      });
      return {
        provider_id: r.record_id,
        fields_pending: r.fields_pending,
        fields_extracted: r.fields_extracted,
        credentials: r.attachments,
      };
    },
    recordIds: (_args, result) => [result.provider_id],
    redact: (args) => ({
      ...args,
      fields: args.fields.map((f) => (f.restricted === true || isRestrictedName(f.name) ? { ...f, value: MASKED } : f)),
      credentials: args.credentials.map((c) => (c.number === undefined ? c : { ...c, number: MASKED })),
    }),
  });

  const providersGet = definePackTool({
    name: 'providers_get',
    description: 'Return a provider with its fields and credentials. Restricted values are masked.',
    actionClass: 'read',
    input: z.object({ provider_id: z.string().uuid() }),
    output: z.object({
      provider: z.object({ id: z.string(), name: z.string(), npi: z.string().nullable(), status: z.string() }),
      fields: z.array(
        z.object({
          name: z.string(),
          value: z.string().nullable(),
          restricted: z.boolean(),
          confidence: z.number().nullable(),
          status: z.string(),
          source_page: z.number().nullable(),
        }),
      ),
      credentials: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          issuer: z.string().nullable(),
          number: z.string().nullable(),
          state: z.string().nullable(),
          expires_at: z.string().nullable(),
        }),
      ),
    }),
    handler: async ({ provider_id }, deps) => {
      // `kind` pins the read to this pack's records. One store serves every loaded pack, so
      // without it a deployment that also loads another pack would hand that pack's record
      // back through the provider schema, its title landing under `name` and its own fields
      // under a provider's. A mismatch is a ToolError naming both kinds.
      const r = await callKernel<RecordsGetResult>(deps, 'records_get', {
        record_id: provider_id,
        kind: 'provider',
      });
      return {
        provider: { id: r.record.id, name: r.record.name, npi: r.record.external_id, status: r.record.status },
        fields: r.fields,
        // Projected down to the six members the credential view has always had: `issued_at` and
        // `properties` are on the kernel's view and were never on this one.
        credentials: r.attachments.map((a) => ({
          id: a.id,
          kind: a.kind,
          issuer: a.issuer,
          number: a.number,
          state: a.state,
          expires_at: a.expires_at,
        })),
      };
    },
    recordIds: ({ provider_id }) => [provider_id],
  });

  const providersSearch = definePackTool({
    name: 'providers_search',
    description: 'Search providers by name fragment or exact NPI.',
    actionClass: 'read',
    input: z.object({ query: z.string().min(1) }),
    output: z.object({
      providers: z.array(z.object({ provider_id: z.string(), name: z.string(), npi: z.string().nullable() })),
    }),
    handler: async ({ query }, deps) => {
      // One box, two meanings: the kernel ORs a name fragment with an exact external id, which is
      // the `ilike(name) OR npi =` this tool has always run.
      const r = await callKernel<RecordsSearchResult>(deps, 'records_search', {
        kind: 'provider',
        name: query,
        external_id: query,
      });
      return { providers: r.records.map((x) => ({ provider_id: x.record_id, name: x.name, npi: x.external_id })) };
    },
  });

  const providersConfirmField = definePackTool({
    name: 'providers_confirm_field',
    description: 'A human confirms or corrects a field value. Marks it verified.',
    actionClass: 'write.internal',
    input: z.object({
      provider_id: z.string().uuid(),
      field: z.string().min(1),
      value: z.string(),
      confirmed_by: z.string().optional(),
    }),
    output: z.object({ provider_id: z.string(), field: z.string(), status: z.literal('verified') }),
    handler: async (args, deps) => {
      await callKernel(deps, 'records_confirm_field', {
        record_id: args.provider_id,
        field: args.field,
        value: args.value,
        confirmed_by: args.confirmed_by,
        kind: 'provider',
      });
      return { provider_id: args.provider_id, field: args.field, status: 'verified' as const };
    },
    recordIds: ({ provider_id }) => [provider_id],
    redact: (args) => (isRestrictedName(args.field) ? { ...args, value: MASKED } : args),
  });

  const providersListPending = definePackTool({
    name: 'providers_list_pending',
    description: 'List fields that still need human confirmation for a provider.',
    actionClass: 'read',
    input: z.object({ provider_id: z.string().uuid() }),
    output: z.object({
      fields: z.array(
        z.object({ name: z.string(), confidence: z.number().nullable(), source_page: z.number().nullable() }),
      ),
    }),
    handler: async ({ provider_id }, deps) =>
      callKernel<RecordsListPendingResult>(deps, 'records_list_pending', {
        record_id: provider_id,
        kind: 'provider',
      }),
  });

  return [providersUpsert, providersGet, providersSearch, providersConfirmField, providersListPending];
}
