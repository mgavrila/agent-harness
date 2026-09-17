import { and, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { attachments, encrypt, fields, records } from '@harness/db';
import { ToolError } from '@harness/shared';
import type {
  RecordsGetResult,
  RecordsListPendingResult,
  RecordsSearchResult,
  RecordsUpsertResult,
} from '@harness/pack-api';
import type { ToolDeps } from '../tooling/types.js';
import { isRestrictedName } from '../../shared/redaction/names.js';
import { fieldValueColumns, maskAttachment, maskField } from './mask.js';
import type { AttachmentInput, FieldInput, UpsertRecordInput } from './types.js';

/**
 * One of this client's records, optionally pinned to a kind.
 *
 * `kind` is what a pack's renamed read passes so that its tool answers only for its own records:
 * a deployment loading two packs shares one store, so an id alone no longer says which area of
 * the product a row belongs to, and a read that ignored the kind would hand one pack's row back
 * through the other pack's schema. A mismatch is a `ToolError`, not a not-found: the row exists
 * and the caller is entitled to know it asked the wrong tool.
 */
export async function requireRecord(deps: ToolDeps, recordId: string, kind?: string) {
  const row = await deps.db.query.records.findFirst({
    where: and(eq(records.id, recordId), eq(records.client, deps.client)),
  });
  if (!row) throw new ToolError(`record ${recordId} not found`);
  if (kind !== undefined && row.kind !== kind) {
    throw new ToolError(`record ${recordId} is a "${row.kind}" record, not a "${kind}" record`);
  }
  return row;
}

/**
 * Which pack owns a kind, and whether any does.
 *
 * The kernel stores `pack` on every row so an operator can tell which area of the product wrote
 * it, and it refuses a kind no loaded pack declares rather than writing a row that no tool
 * schema will ever let a caller read back.
 */
function packForKind(deps: ToolDeps, kind: string): string {
  const owner = deps.packs.all.find((p) => p.records.some((r) => r.kind === kind));
  if (!owner) throw new ToolError(`no loaded pack declares record kind "${kind}"`);
  return owner.name;
}

function assertAttachmentKind(deps: ToolDeps, kind: string): void {
  if (!deps.packs.attachmentKind(kind)) {
    throw new ToolError(`no loaded pack declares attachment kind "${kind}"`);
  }
}

async function findOrCreateRecord(deps: ToolDeps, kind: string, name: string, externalId?: string) {
  // The external id identifies the thing; the name only names it. Matching on the id first is
  // what keeps a renamed record one record.
  const match = externalId ? eq(records.externalId, externalId) : eq(records.name, name);
  const existing = await deps.db.query.records.findFirst({
    where: and(eq(records.client, deps.client), eq(records.kind, kind), match),
  });
  if (existing) {
    const [updated] = await deps.db
      .update(records)
      .set({ name, externalId: externalId ?? existing.externalId, updatedAt: deps.now() })
      .where(eq(records.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await deps.db
    .insert(records)
    .values({ client: deps.client, pack: packForKind(deps, kind), kind, name, externalId: externalId ?? null })
    .returning();
  return created;
}

async function upsertField(deps: ToolDeps, recordId: string, f: FieldInput) {
  const existing = await deps.db.query.fields.findFirst({
    where: and(eq(fields.recordId, recordId), eq(fields.name, f.name)),
  });
  if (existing?.status === 'verified') {
    return 'verified' as const;
  }
  const restricted = f.restricted === true || isRestrictedName(f.name);
  const confidence = f.confidence ?? 1;
  const status = confidence >= deps.confidenceThreshold ? 'extracted' : 'pending';
  const values = {
    recordId,
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
      // A verified field returned above, so any confirmation recorded on the row being
      // overwritten refers to a value this extraction replaces.
      set: { ...values, confirmedBy: null, confirmedAt: null },
    });
  return status;
}

async function upsertAttachment(deps: ToolDeps, recordId: string, a: AttachmentInput) {
  assertAttachmentKind(deps, a.kind);
  // A record can hold one attachment of a kind per state (two licences in two states), so the
  // state — null included — is part of the match.
  const existing = await deps.db.query.attachments.findFirst({
    where: and(
      eq(attachments.recordId, recordId),
      eq(attachments.kind, a.kind),
      sql`${attachments.state} IS NOT DISTINCT FROM ${a.state ?? null}`,
    ),
  });
  const values = {
    recordId,
    kind: a.kind,
    issuer: a.issuer ?? null,
    numberEncrypted: a.number ? encrypt(a.number, deps.encryptionKey) : null,
    state: a.state ?? null,
    issuedAt: a.issued_at ?? null,
    expiresAt: a.expires_at ?? null,
    properties: a.properties ?? {},
    sourceDocId: a.source_doc_id ?? null,
  };
  if (existing) {
    await deps.db.update(attachments).set(values).where(eq(attachments.id, existing.id));
  } else {
    await deps.db.insert(attachments).values(values);
  }
}

/**
 * The write behind `records_upsert`, callable from another tool handler. `documents_extract`
 * uses it so the extraction path and the direct tool obey exactly one set of rules about
 * restricted names, confidence thresholds and verified-field protection.
 */
export async function upsertRecord(deps: ToolDeps, args: UpsertRecordInput): Promise<RecordsUpsertResult> {
  // Checked even when `recordId` short-circuits the match, so a bad kind fails the same way
  // whichever path a caller took.
  packForKind(deps, args.kind);
  const recordId = args.recordId ?? (await findOrCreateRecord(deps, args.kind, args.name, args.external_id)).id;
  let pending = 0;
  let extracted = 0;
  for (const f of args.fields) {
    // A field already verified by a human keeps its value and counts as neither.
    const status = await upsertField(deps, recordId, f);
    if (status === 'pending') pending += 1;
    else if (status === 'extracted') extracted += 1;
  }
  for (const a of args.attachments) {
    await upsertAttachment(deps, recordId, a);
  }
  const count = await deps.db.$count(attachments, eq(attachments.recordId, recordId));
  return { record_id: recordId, fields_pending: pending, fields_extracted: extracted, attachments: count };
}

/** `records_get`: the record with its fields and attachments, restricted values masked. */
export async function readRecord(deps: ToolDeps, recordId: string, kind?: string): Promise<RecordsGetResult> {
  const r = await requireRecord(deps, recordId, kind);
  const fieldRows = await deps.db.select().from(fields).where(eq(fields.recordId, recordId));
  const attachmentRows = await deps.db.select().from(attachments).where(eq(attachments.recordId, recordId));
  return {
    record: { id: r.id, kind: r.kind, name: r.name, external_id: r.externalId, status: r.status },
    fields: fieldRows.map(maskField),
    attachments: attachmentRows.map(maskAttachment),
  };
}

/**
 * `records_search`: name fragment, exact external id, or both, at most 20, scoped to the client.
 *
 * Both given means "either", not "both": that is what reproduces the single-box search the
 * `providers_search` alias offers, where one string is tried as a name and as an NPI at once.
 */
export async function searchRecords(
  deps: ToolDeps,
  args: { kind?: string; name?: string; external_id?: string },
): Promise<RecordsSearchResult> {
  const { kind, name, external_id } = args;
  if (name === undefined && external_id === undefined) {
    throw new ToolError('records_search needs a name or an external_id');
  }
  const matches: SQL[] = [];
  if (name !== undefined) matches.push(ilike(records.name, `%${name}%`));
  if (external_id !== undefined) matches.push(eq(records.externalId, external_id));
  const scope = [eq(records.client, deps.client)];
  if (kind !== undefined) scope.push(eq(records.kind, kind));
  const rows = await deps.db
    .select()
    .from(records)
    .where(and(...scope, or(...matches)))
    .limit(20);
  return { records: rows.map((r) => ({ record_id: r.id, kind: r.kind, name: r.name, external_id: r.externalId })) };
}

/** `records_confirm_field`: a human's value wins and the field becomes verified. */
export async function confirmField(
  deps: ToolDeps,
  args: { record_id: string; field: string; value: string; confirmed_by?: string; kind?: string },
): Promise<void> {
  const { record_id, field, value, confirmed_by, kind } = args;
  await requireRecord(deps, record_id, kind);
  const existing = await deps.db.query.fields.findFirst({
    where: and(eq(fields.recordId, record_id), eq(fields.name, field)),
  });
  const restricted = existing?.restricted === true || isRestrictedName(field);
  const values = {
    recordId: record_id,
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

/** `records_list_pending`: the fields still waiting on a human. */
export async function listPendingFields(
  deps: ToolDeps,
  recordId: string,
  kind?: string,
): Promise<RecordsListPendingResult> {
  await requireRecord(deps, recordId, kind);
  const rows = await deps.db
    .select()
    .from(fields)
    .where(and(eq(fields.recordId, recordId), eq(fields.status, 'pending')));
  return { fields: rows.map((r) => ({ name: r.name, confidence: r.confidence, source_page: r.sourcePage })) };
}
