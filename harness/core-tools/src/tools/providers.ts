import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { CredentialInput, FieldInput } from '../domain/providers/types.js';
import {
  confirmField,
  listPendingFields,
  readProvider,
  searchProviders,
  upsertProviderRecord,
} from '../domain/providers/repository.js';
import { MASKED, isRestrictedName } from '../shared/redaction/names.js';

const providersUpsert = defineTool({
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
  handler: async (args, deps) => upsertProviderRecord(deps, args),
  recordIds: (_args, result) => [result.provider_id],
  // A parked approval stores its payload as plaintext jsonb, so restricted
  // field values and credential numbers are masked out of it here. The full
  // arguments remain available, encrypted, in approvals.payload_encrypted.
  redact: (args) => ({
    ...args,
    fields: args.fields.map((f) => (f.restricted === true || isRestrictedName(f.name) ? { ...f, value: MASKED } : f)),
    credentials: args.credentials.map((c) => (c.number === undefined ? c : { ...c, number: MASKED })),
  }),
});

const providersGet = defineTool({
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
  handler: async ({ provider_id }, deps) => readProvider(deps, provider_id),
  recordIds: ({ provider_id }) => [provider_id],
});

const providersSearch = defineTool({
  name: 'providers_search',
  description: 'Search providers by name fragment or exact NPI.',
  actionClass: 'read',
  input: z.object({ query: z.string().min(1) }),
  output: z.object({
    providers: z.array(z.object({ provider_id: z.string(), name: z.string(), npi: z.string().nullable() })),
  }),
  handler: async ({ query }, deps) => ({ providers: await searchProviders(deps, query) }),
});

const providersConfirmField = defineTool({
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
    await confirmField(deps, args);
    return { provider_id: args.provider_id, field: args.field, status: 'verified' as const };
  },
  recordIds: ({ provider_id }) => [provider_id],
  redact: (args) => (isRestrictedName(args.field) ? { ...args, value: MASKED } : args),
});

const providersListPending = defineTool({
  name: 'providers_list_pending',
  description: 'List fields that still need human confirmation for a provider.',
  actionClass: 'read',
  input: z.object({ provider_id: z.string().uuid() }),
  output: z.object({
    fields: z.array(
      z.object({ name: z.string(), confidence: z.number().nullable(), source_page: z.number().nullable() }),
    ),
  }),
  handler: async ({ provider_id }, deps) => ({ fields: await listPendingFields(deps, provider_id) }),
});

export const providerTools: AnyToolDef[] = [
  providersUpsert,
  providersGet,
  providersSearch,
  providersConfirmField,
  providersListPending,
];
