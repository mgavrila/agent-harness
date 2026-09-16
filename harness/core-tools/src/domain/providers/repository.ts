import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { providers, records, fields, credentials, attachments, encrypt } from '@harness/db';
import { ToolError } from '@harness/shared';
import type { ToolDeps } from '../tooling/types.js';
import { isRestrictedName } from '../../shared/redaction/names.js';
import { fieldValueColumns, maskCredential, maskField } from './mask.js';
import type { CredentialInput, FieldInput, UpsertProviderInput, UpsertProviderResult } from './types.js';

export async function requireProvider(deps: ToolDeps, providerId: string) {
  const p = await deps.db.query.providers.findFirst({
    where: and(eq(providers.id, providerId), eq(providers.client, deps.client)),
  });
  if (!p) throw new ToolError(`provider ${providerId} not found`);
  return p;
}

async function findOrCreateProvider(deps: ToolDeps, name: string, npi?: string) {
  const match = npi ? eq(records.externalId, npi) : eq(providers.name, name);
  const existing = await deps.db.query.providers.findFirst({
    where: and(eq(providers.client, deps.client), match),
  });
  if (existing) {
    const [updated] = await deps.db
      .update(providers)
      .set({ name, externalId: npi ?? existing.externalId, updatedAt: deps.now() })
      .where(eq(providers.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await deps.db
    .insert(providers)
    .values({ client: deps.client, pack: 'healthcare', kind: 'provider', name, externalId: npi ?? null })
    .returning();
  return created;
}

async function upsertField(deps: ToolDeps, providerId: string, f: FieldInput) {
  const existing = await deps.db.query.fields.findFirst({
    where: and(eq(fields.recordId, providerId), eq(fields.name, f.name)),
  });
  if (existing?.status === 'verified') {
    return 'verified' as const;
  }
  const restricted = f.restricted === true || isRestrictedName(f.name);
  const confidence = f.confidence ?? 1;
  const status = confidence >= deps.confidenceThreshold ? 'extracted' : 'pending';
  const values = {
    recordId: providerId,
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
      target: [fields.recordId, fields.name],
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
      eq(attachments.recordId, providerId),
      eq(credentials.kind, c.kind),
      sql`${credentials.state} IS NOT DISTINCT FROM ${c.state ?? null}`,
    ),
  });
  const values = {
    recordId: providerId,
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
  const credCount = await deps.db.$count(credentials, eq(attachments.recordId, providerId));
  return { provider_id: providerId, fields_pending: pending, fields_extracted: extracted, credentials: credCount };
}

/** `providers_get`: the provider with its fields and credentials, restricted values masked. */
export async function readProvider(deps: ToolDeps, providerId: string) {
  const p = await requireProvider(deps, providerId);
  const fieldRows = await deps.db.select().from(fields).where(eq(fields.recordId, providerId));
  const credentialRows = await deps.db.select().from(credentials).where(eq(attachments.recordId, providerId));
  return {
    provider: { id: p.id, name: p.name, npi: p.externalId, status: p.status },
    fields: fieldRows.map(maskField),
    credentials: credentialRows.map(maskCredential),
  };
}

/** `providers_search`: name fragment or exact NPI, at most 20, scoped to the client. */
export async function searchProviders(deps: ToolDeps, query: string) {
  const rows = await deps.db
    .select()
    .from(providers)
    .where(
      and(eq(providers.client, deps.client), or(ilike(providers.name, `%${query}%`), eq(records.externalId, query))),
    )
    .limit(20);
  return rows.map((r) => ({ provider_id: r.id, name: r.name, npi: r.externalId }));
}

/** `providers_confirm_field`: a human's value wins and the field becomes verified. */
export async function confirmField(
  deps: ToolDeps,
  args: { provider_id: string; field: string; value: string; confirmed_by?: string },
): Promise<void> {
  const { provider_id, field, value, confirmed_by } = args;
  await requireProvider(deps, provider_id);
  const existing = await deps.db.query.fields.findFirst({
    where: and(eq(fields.recordId, provider_id), eq(fields.name, field)),
  });
  const restricted = existing?.restricted === true || isRestrictedName(field);
  const values = {
    recordId: provider_id,
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
    .onConflictDoUpdate({ target: [fields.recordId, fields.name], set: values });
}

/** `providers_list_pending`: the fields still waiting on a human. */
export async function listPendingFields(deps: ToolDeps, providerId: string) {
  await requireProvider(deps, providerId);
  const rows = await deps.db
    .select()
    .from(fields)
    .where(and(eq(fields.recordId, providerId), eq(fields.status, 'pending')));
  return rows.map((r) => ({ name: r.name, confidence: r.confidence, source_page: r.sourcePage }));
}
