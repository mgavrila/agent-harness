import * as z from 'zod/v4';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { providers, fields, credentials, encrypt, type Db } from '@harness/db';
import { defineTool, ToolError, type AnyToolDef, type ToolDeps } from '../registry.js';

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
  kind: z.enum(['license', 'dea', 'malpractice', 'board_cert']),
  issuer: z.string().optional(),
  number: z.string().optional(),
  state: z.string().length(2).optional(),
  issued_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source_doc_id: z.string().uuid().optional(),
});
export type CredentialInput = z.infer<typeof CredentialInput>;

const RESTRICTED_FIELD_NAMES = new Set(['ssn', 'ein', 'dea_number', 'tax_id']);

async function findOrCreateProvider(db: Db, deps: ToolDeps, name: string, npi?: string) {
  const existing = npi
    ? await db.query.providers.findFirst({ where: and(eq(providers.client, deps.client), eq(providers.npi, npi)) })
    : await db.query.providers.findFirst({ where: and(eq(providers.client, deps.client), eq(providers.name, name)) });
  if (existing) {
    const [updated] = await db
      .update(providers)
      .set({ name, npi: npi ?? existing.npi, updatedAt: deps.now() })
      .where(eq(providers.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db.insert(providers).values({ client: deps.client, name, npi: npi ?? null }).returning();
  return created;
}

async function upsertField(db: Db, deps: ToolDeps, providerId: string, f: FieldInput) {
  const restricted = f.restricted ?? RESTRICTED_FIELD_NAMES.has(f.name);
  const confidence = f.confidence ?? 1;
  const status = confidence >= deps.confidenceThreshold ? 'extracted' : 'pending';
  const values = {
    providerId,
    name: f.name,
    value: restricted ? null : f.value,
    valueEncrypted: restricted ? encrypt(f.value, deps.encryptionKey) : null,
    restricted,
    confidence,
    sourceDocId: f.source_doc_id ?? null,
    sourcePage: f.source_page ?? null,
    status,
  };
  await db
    .insert(fields)
    .values(values)
    .onConflictDoUpdate({
      target: [fields.providerId, fields.name],
      set: { ...values, confirmedBy: null, confirmedAt: null },
    });
  return status;
}

async function upsertCredential(db: Db, deps: ToolDeps, providerId: string, c: CredentialInput) {
  const existing = await db.query.credentials.findFirst({
    where: and(
      eq(credentials.providerId, providerId),
      eq(credentials.kind, c.kind),
      sql`${credentials.state} IS NOT DISTINCT FROM ${c.state ?? null}`,
    ),
  });
  const values = {
    providerId,
    kind: c.kind,
    issuer: c.issuer ?? null,
    numberEncrypted: c.number ? encrypt(c.number, deps.encryptionKey) : null,
    state: c.state ?? null,
    issuedAt: c.issued_at ?? null,
    expiresAt: c.expires_at ?? null,
    sourceDocId: c.source_doc_id ?? null,
  };
  if (existing) {
    await db.update(credentials).set(values).where(eq(credentials.id, existing.id));
  } else {
    await db.insert(credentials).values(values);
  }
}

const providersUpsert = defineTool({
  name: 'providers_upsert',
  description:
    'Create or update a provider record with extracted fields and credentials. Matches an existing provider by NPI (or by name when no NPI). Restricted fields (ssn, ein, dea_number, tax_id) are encrypted and never returned in plaintext.',
  actionClass: 'write.internal',
  input: z.object({
    name: z.string().min(1),
    npi: z.string().regex(/^\d{10}$/).optional(),
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
    const provider = await findOrCreateProvider(deps.db, deps, args.name, args.npi);
    let pending = 0;
    let extracted = 0;
    for (const f of args.fields) {
      const status = await upsertField(deps.db, deps, provider.id, f);
      if (status === 'pending') pending += 1;
      else extracted += 1;
    }
    for (const c of args.credentials) {
      await upsertCredential(deps.db, deps, provider.id, c);
    }
    const credCount = await deps.db.$count(credentials, eq(credentials.providerId, provider.id));
    return { provider_id: provider.id, fields_pending: pending, fields_extracted: extracted, credentials: credCount };
  },
  recordIds: (_args, result) => [result.provider_id],
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
        number: z.string(),
        state: z.string().nullable(),
        expires_at: z.string().nullable(),
      }),
    ),
  }),
  handler: async ({ provider_id }, deps) => {
    const p = await deps.db.query.providers.findFirst({ where: and(eq(providers.id, provider_id), eq(providers.client, deps.client)) });
    if (!p) throw new ToolError(`provider ${provider_id} not found`);
    const fs = await deps.db.select().from(fields).where(eq(fields.providerId, provider_id));
    const cs = await deps.db.select().from(credentials).where(eq(credentials.providerId, provider_id));
    return {
      provider: { id: p.id, name: p.name, npi: p.npi, status: p.status },
      fields: fs.map((f) => ({
        name: f.name,
        value: f.restricted ? '[restricted]' : f.value,
        restricted: f.restricted,
        confidence: f.confidence,
        status: f.status,
        source_page: f.sourcePage,
      })),
      credentials: cs.map((c) => ({
        id: c.id,
        kind: c.kind,
        issuer: c.issuer,
        number: c.numberEncrypted ? '[restricted]' : '',
        state: c.state,
        expires_at: c.expiresAt,
      })),
    };
  },
  recordIds: ({ provider_id }) => [provider_id],
});

const providersSearch = defineTool({
  name: 'providers_search',
  description: 'Search providers by name fragment or exact NPI.',
  actionClass: 'read',
  input: z.object({ query: z.string().min(1) }),
  output: z.object({ providers: z.array(z.object({ provider_id: z.string(), name: z.string(), npi: z.string().nullable() })) }),
  handler: async ({ query }, deps) => {
    const rows = await deps.db
      .select()
      .from(providers)
      .where(and(eq(providers.client, deps.client), or(ilike(providers.name, `%${query}%`), eq(providers.npi, query))))
      .limit(20);
    return { providers: rows.map((r) => ({ provider_id: r.id, name: r.name, npi: r.npi })) };
  },
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
  handler: async ({ provider_id, field, value, confirmed_by }, deps) => {
    const existing = await deps.db.query.fields.findFirst({ where: and(eq(fields.providerId, provider_id), eq(fields.name, field)) });
    const restricted = existing?.restricted ?? RESTRICTED_FIELD_NAMES.has(field);
    const values = {
      providerId: provider_id,
      name: field,
      value: restricted ? null : value,
      valueEncrypted: restricted ? encrypt(value, deps.encryptionKey) : null,
      restricted,
      confidence: 1,
      status: 'verified',
      confirmedBy: confirmed_by ?? deps.caller,
      confirmedAt: deps.now(),
    };
    await deps.db
      .insert(fields)
      .values(values)
      .onConflictDoUpdate({ target: [fields.providerId, fields.name], set: values });
    return { provider_id, field, status: 'verified' as const };
  },
  recordIds: ({ provider_id }) => [provider_id],
});

const providersListPending = defineTool({
  name: 'providers_list_pending',
  description: 'List fields that still need human confirmation for a provider.',
  actionClass: 'read',
  input: z.object({ provider_id: z.string().uuid() }),
  output: z.object({
    fields: z.array(z.object({ name: z.string(), confidence: z.number().nullable(), source_page: z.number().nullable() })),
  }),
  handler: async ({ provider_id }, deps) => {
    const rows = await deps.db
      .select()
      .from(fields)
      .where(and(eq(fields.providerId, provider_id), eq(fields.status, 'pending')));
    return { fields: rows.map((r) => ({ name: r.name, confidence: r.confidence, source_page: r.sourcePage })) };
  },
});

export const providerTools: AnyToolDef[] = [providersUpsert, providersGet, providersSearch, providersConfirmField, providersListPending];
