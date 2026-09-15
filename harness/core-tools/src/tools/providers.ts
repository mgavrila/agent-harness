import * as z from 'zod/v4';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { providers, fields, credentials, encrypt } from '@harness/db';
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

/**
 * Field-name stems that always identify a restricted identifier. A caller may
 * mark any field restricted, but may never un-mark one of these: the check is
 * authoritative, so `restricted: false` on an `ssn` is ignored.
 */
const RESTRICTED_NAME_KEYS = ['ssn', 'socialsecurity', 'ein', 'taxid', 'dea'] as const;
/** Suffixes a key may carry: `dea`, `dea_number`, `DEA-No`, `dea_id`, ... */
const RESTRICTED_NAME_SUFFIXES = ['', 'number', 'no', 'id', 'registration'] as const;

/**
 * True when `name` denotes a restricted identifier. Normalizes away case and
 * separators, drops a trailing ordinal, then matches a key exactly or a key
 * plus a known suffix — so `deadline` and `npi` are not restricted while
 * `DEA-Number` is.
 *
 * The trailing ordinal matters: `fieldNameFor` in documents/redact.ts names a
 * second distinct value of a kind `ssn_2`, `ein_2`, `dea_number_2`. Those are
 * names this harness generates itself, so a caller replaying an earlier
 * extraction through `providers_upsert` must not be able to land one in the
 * plaintext `fields.value` column just because it carries a suffix.
 */
export function isRestrictedName(name: string): boolean {
  // Separators are already gone, so the ordinal is a bare digit run at the end.
  const stem = name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/\d+$/, '');
  return RESTRICTED_NAME_KEYS.some((key) =>
    RESTRICTED_NAME_SUFFIXES.some((suffix) => stem === `${key}${suffix}`),
  );
}

export async function requireProvider(deps: ToolDeps, providerId: string) {
  const p = await deps.db.query.providers.findFirst({ where: and(eq(providers.id, providerId), eq(providers.client, deps.client)) });
  if (!p) throw new ToolError(`provider ${providerId} not found`);
  return p;
}

/** Stands in for any value a caller is not allowed to read back. */
export const MASKED = '[restricted]';

/**
 * A field value belongs in exactly one column: plaintext when it may be read
 * back, encrypted when it may not. Never both, so that masking a value cannot
 * leave a readable copy behind.
 */
function fieldValueColumns(value: string, restricted: boolean, key: Buffer) {
  return {
    value: restricted ? null : value,
    valueEncrypted: restricted ? encrypt(value, key) : null,
  };
}

/** A field as a caller sees it. A restricted value is reported as masked, never decrypted. */
function maskField(f: typeof fields.$inferSelect) {
  return {
    name: f.name,
    value: f.restricted ? MASKED : f.value,
    restricted: f.restricted,
    confidence: f.confidence,
    status: f.status,
    source_page: f.sourcePage,
  };
}

/** A credential as a caller sees it. The number is never returned, only whether one is on file. */
function maskCredential(c: typeof credentials.$inferSelect) {
  return {
    id: c.id,
    kind: c.kind,
    issuer: c.issuer,
    number: c.numberEncrypted ? MASKED : null,
    state: c.state,
    expires_at: c.expiresAt,
  };
}

async function findOrCreateProvider(deps: ToolDeps, name: string, npi?: string) {
  const match = npi ? eq(providers.npi, npi) : eq(providers.name, name);
  const existing = await deps.db.query.providers.findFirst({
    where: and(eq(providers.client, deps.client), match),
  });
  if (existing) {
    const [updated] = await deps.db
      .update(providers)
      .set({ name, npi: npi ?? existing.npi, updatedAt: deps.now() })
      .where(eq(providers.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await deps.db.insert(providers).values({ client: deps.client, name, npi: npi ?? null }).returning();
  return created;
}

async function upsertField(deps: ToolDeps, providerId: string, f: FieldInput) {
  const existing = await deps.db.query.fields.findFirst({ where: and(eq(fields.providerId, providerId), eq(fields.name, f.name)) });
  if (existing?.status === 'verified') {
    return 'verified' as const;
  }
  const restricted = f.restricted === true || isRestrictedName(f.name);
  const confidence = f.confidence ?? 1;
  const status = confidence >= deps.confidenceThreshold ? 'extracted' : 'pending';
  const values = {
    providerId,
    name: f.name,
    ...fieldValueColumns(f.value, restricted, deps.encryptionKey),
    restricted,
    confidence,
    sourceDocId: f.source_doc_id ?? null,
    sourcePage: f.source_page ?? null,
    status,
  };
  await deps.db
    .insert(fields)
    .values(values)
    .onConflictDoUpdate({
      target: [fields.providerId, fields.name],
      // A verified field returned above, so any confirmation recorded on the
      // row being overwritten refers to a value this extraction replaces.
      set: { ...values, confirmedBy: null, confirmedAt: null },
    });
  return status;
}

async function upsertCredential(deps: ToolDeps, providerId: string, c: CredentialInput) {
  // A provider can hold one credential of a kind per state (two licences in
  // two states), so the state — null included — is part of the match.
  const existing = await deps.db.query.credentials.findFirst({
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
    await deps.db.update(credentials).set(values).where(eq(credentials.id, existing.id));
  } else {
    await deps.db.insert(credentials).values(values);
  }
}

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

/**
 * The write behind `providers_upsert`, callable from another tool handler.
 * `documents_extract` uses it so the extraction path and the direct tool obey
 * exactly one set of rules about restricted names, confidence thresholds and
 * verified-field protection.
 */
export async function upsertProviderRecord(deps: ToolDeps, args: UpsertProviderInput): Promise<UpsertProviderResult> {
  const providerId = args.providerId ?? (await findOrCreateProvider(deps, args.name, args.npi)).id;
  let pending = 0;
  let extracted = 0;
  for (const f of args.fields) {
    // A field already verified by a human keeps its value and counts as neither.
    const status = await upsertField(deps, providerId, f);
    if (status === 'pending') pending += 1;
    else if (status === 'extracted') extracted += 1;
  }
  for (const c of args.credentials) {
    await upsertCredential(deps, providerId, c);
  }
  const credCount = await deps.db.$count(credentials, eq(credentials.providerId, providerId));
  return { provider_id: providerId, fields_pending: pending, fields_extracted: extracted, credentials: credCount };
}

const providersUpsert = defineTool({
  name: 'providers_upsert',
  description:
    'Create or update a provider record with extracted fields and credentials. Matches an existing provider by NPI (or by name when no NPI). ' +
    'Fields named for a restricted identifier (ssn, social security number, ein, tax id, dea number) are always encrypted and never returned in plaintext, ' +
    'whatever `restricted` says; set `restricted: true` to protect any other field.',
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
  handler: async (args, deps) => upsertProviderRecord(deps, args),
  recordIds: (_args, result) => [result.provider_id],
  // A parked approval stores its payload as plaintext jsonb, so restricted
  // field values and credential numbers are masked out of it here. The full
  // arguments remain available, encrypted, in approvals.payload_encrypted.
  redact: (args) => ({
    ...args,
    fields: args.fields.map((f) =>
      f.restricted === true || isRestrictedName(f.name) ? { ...f, value: MASKED } : f,
    ),
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
  handler: async ({ provider_id }, deps) => {
    const p = await requireProvider(deps, provider_id);
    const fieldRows = await deps.db.select().from(fields).where(eq(fields.providerId, provider_id));
    const credentialRows = await deps.db.select().from(credentials).where(eq(credentials.providerId, provider_id));
    return {
      provider: { id: p.id, name: p.name, npi: p.npi, status: p.status },
      fields: fieldRows.map(maskField),
      credentials: credentialRows.map(maskCredential),
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
    await requireProvider(deps, provider_id);
    const existing = await deps.db.query.fields.findFirst({ where: and(eq(fields.providerId, provider_id), eq(fields.name, field)) });
    const restricted = existing?.restricted === true || isRestrictedName(field);
    const values = {
      providerId: provider_id,
      name: field,
      ...fieldValueColumns(value, restricted, deps.encryptionKey),
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
  redact: (args) => (isRestrictedName(args.field) ? { ...args, value: MASKED } : args),
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
    await requireProvider(deps, provider_id);
    const rows = await deps.db
      .select()
      .from(fields)
      .where(and(eq(fields.providerId, provider_id), eq(fields.status, 'pending')));
    return { fields: rows.map((r) => ({ name: r.name, confidence: r.confidence, source_page: r.sourcePage })) };
  },
});

export const providerTools: AnyToolDef[] = [providersUpsert, providersGet, providersSearch, providersConfirmField, providersListPending];
