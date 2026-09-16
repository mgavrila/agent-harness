import { unlink, writeFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod/v4';
import { documents } from '@harness/db';
import { ToolError } from '@harness/shared';
import type {
  DocumentRecordView,
  DocumentsClassifyResult,
  DocumentsExtractResult,
  DocumentsIngestResult,
  RecordKindSpec,
} from '@harness/pack-api';
import type { ToolDeps } from '../tooling/types.js';
import { assertRedacted, redactPages } from '../../shared/redaction/text.js';
import { documentTextPath, toStorageRelative } from '../storage/layout.js';
import { readDocumentBytes, resolveStoragePath, sha256File } from '../storage/file-store.js';
import { callModelJson } from '../models/gateway.js';
import type { ModelMessage } from '../models/types.js';
import { requireRecord, upsertRecord } from '../records/repository.js';
import type { AttachmentInput, FieldInput } from '../records/types.js';
import { extractDocumentText, pdfPageCount } from './text.js';
import { buildClassificationSchema, buildExtractionSchema } from './schema.js';
import { buildClassificationMessages, buildExtractionMessages } from './prompts.js';
import { parseExtraction } from './parse.js';
import type { ExtractedField } from './types.js';

/** One document as the `documents_*` tools report it. */
export function documentView(row: typeof documents.$inferSelect): DocumentRecordView {
  return {
    id: row.id,
    record_id: row.recordId,
    kind: row.kind,
    storage_path: row.storagePath,
    sha256: row.sha256,
    pages: row.pages,
    ocr_used: row.ocrUsed,
    // The text itself is never returned by these tools; only whether it exists.
    has_text: row.textPath !== null,
    ingested_at: row.ingestedAt.toISOString(),
  };
}

/**
 * Load a document, scoped directly to `deps.client` — including one not yet
 * attached to a record, which has no other owner to check against — and, if
 * it is attached, also refusing one whose record belongs to another client.
 */
export async function requireDocument(deps: ToolDeps, documentId: string) {
  const row = await deps.db.query.documents.findFirst({
    where: and(eq(documents.id, documentId), eq(documents.client, deps.client)),
  });
  if (!row) throw new ToolError(`document ${documentId} not found`);
  if (row.recordId) await requireRecord(deps, row.recordId);
  return row;
}

/** `documents_list`: this client's documents, newest first, optionally scoped to one record. */
export async function listDocuments(deps: ToolDeps, recordId?: string): Promise<DocumentRecordView[]> {
  const conditions = [eq(documents.client, deps.client)];
  if (recordId) {
    await requireRecord(deps, recordId);
    conditions.push(eq(documents.recordId, recordId));
  }
  const rows = await deps.db
    .select()
    .from(documents)
    .where(and(...conditions));
  rows.sort((a, b) => b.ingestedAt.getTime() - a.ingestedAt.getTime());
  return rows.map(documentView);
}

/**
 * Reply shape from the classification route. Loose enough that a model
 * returning an unrecognised `document_kind` string does not fail validation —
 * the handler falls back to `other` itself — but strict enough that a
 * non-object reply, or one missing either top-level part, is rejected before
 * it can reach anything downstream.
 */
const ClassificationReply = z.object({
  document_kind: z.string(),
  confidence: z.number(),
});

/**
 * The extraction reply's top-level shape. Deliberately loose on the contents — `parseExtraction`
 * clamps confidence, drops empty values and drops anything the target does not allow — but it
 * still requires an object with all three parts, so a reply that is not shaped like an
 * extraction at all throws here rather than deeper in the pipeline. The attachment key is the
 * target's, because that is the property the model was asked for.
 */
function extractionReplyFor(attachmentsKey: string) {
  return z.object({
    document_kind: z.string(),
    fields: z.record(z.string(), z.unknown()),
    [attachmentsKey]: z.array(z.unknown()),
  });
}

/**
 * The record's stable outside identifier, read out of the extraction the way its kind says: an
 * NPI is ten digits however the page printed it, and a value that does not normalise to the
 * declared length is dropped rather than stored as a near miss.
 */
function externalIdFrom(kind: RecordKindSpec, byName: Map<string, ExtractedField>): string | undefined {
  if (!kind.externalId) return undefined;
  const raw = byName.get(kind.externalId.field)?.value;
  if (raw === undefined) return undefined;
  const value = kind.externalId.digitsOnly ? raw.replace(/\D/g, '') : raw.trim();
  if (value === '') return undefined;
  if (kind.externalId.length !== undefined && value.length !== kind.externalId.length) return undefined;
  return value;
}

/**
 * Read a document's text once: layer or OCR, then redaction. Returns both the
 * text that may be prompted and the restricted hits that may not. Every caller
 * that is about to build a prompt goes through here.
 */
async function readForModel(deps: ToolDeps, row: typeof documents.$inferSelect) {
  const abs = await resolveStoragePath(deps.storageDir, row.storagePath);
  const { pages, ocrUsed } = await extractDocumentText(abs);
  const { pages: redacted, hits } = redactPages(pages);
  // The flag exists so a client with a BAA can opt in; it is off by default and
  // turning it on is a documented decision (spec 4.4).
  const promptPages = deps.restrictedToModel ? pages : redacted;
  return { abs, redacted, promptPages, hits, ocrUsed };
}

/**
 * The last gate before anything leaves the process: checked against the exact
 * content of every message about to be sent, not the page text that fed into
 * building them. Building the messages is a separate step from redacting the
 * pages (a prompt adds its own instructions and field descriptions around the
 * document), so this re-checks what is actually serialized onto the wire
 * rather than trusting that step to have carried the redaction through
 * untouched. A no-op when `restrictedToModel` is on: that path sends the raw
 * pages on purpose.
 */
function assertPromptRedacted(deps: ToolDeps, messages: ModelMessage[]): void {
  if (deps.restrictedToModel) return;
  for (const m of messages) assertRedacted(m.content);
}

/** `documents_ingest`: hash the file, count its pages and record it, idempotent by content hash. */
export async function ingestDocument(
  deps: ToolDeps,
  args: { path: string; record_id?: string; kind?: string },
): Promise<DocumentsIngestResult> {
  const { path: requested, record_id, kind } = args;
  if (record_id) await requireRecord(deps, record_id);
  const abs = await resolveStoragePath(deps.storageDir, requested);
  const relative = toStorageRelative(deps.storageDir, abs);
  const sha256 = await sha256File(abs);

  // Scoped to this client: the same file ingested by two different clients
  // must produce two separate documents rows, not a shared one.
  const existing = await deps.db.query.documents.findFirst({
    where: and(eq(documents.sha256, sha256), eq(documents.client, deps.client)),
  });
  if (existing) {
    // A second ingest may supply the record or kind the first one lacked.
    const patch: Partial<typeof documents.$inferInsert> = {};
    if (record_id && !existing.recordId) patch.recordId = record_id;
    if (kind && !existing.kind) patch.kind = kind;
    if (Object.keys(patch).length > 0) {
      await deps.db.update(documents).set(patch).where(eq(documents.id, existing.id));
    }
    return {
      document_id: existing.id,
      sha256,
      pages: existing.pages ?? 1,
      storage_path: existing.storagePath,
      already_ingested: true,
    };
  }

  const pages = await pdfPageCount(await readDocumentBytes(abs));
  const [row] = await deps.db
    .insert(documents)
    .values({
      client: deps.client,
      recordId: record_id ?? null,
      kind: kind ?? null,
      storagePath: relative,
      sha256,
      pages,
    })
    .returning();
  return { document_id: row.id, sha256, pages, storage_path: relative, already_ingested: false };
}

/** `documents_classify`: ask the model what kind this is; a kind already on file is authoritative. */
export async function classifyDocument(deps: ToolDeps, documentId: string): Promise<DocumentsClassifyResult> {
  const row = await requireDocument(deps, documentId);
  const kinds = deps.packs.documentKinds();
  const { promptPages } = await readForModel(deps, row);
  const messages = buildClassificationMessages(promptPages, deps.packs.manifest().role);
  assertPromptRedacted(deps, messages);
  const { json } = await callModelJson(deps, {
    route: 'extract',
    messages,
    jsonSchema: buildClassificationSchema(kinds),
    validate: ClassificationReply,
    temperature: 0,
  });
  const modelKind = kinds.includes(json.document_kind) ? json.document_kind : 'other';
  const confidence = Math.min(1, Math.max(0, json.confidence));
  // A kind already on file is authoritative, the same rule documents_ingest
  // applies to a declared kind and documents_extract applies by preferring
  // row.kind: classification never overwrites it, even when the model
  // disagrees.
  if (row.kind) {
    return { document_id: documentId, document_kind: row.kind, model_kind: modelKind, confidence };
  }
  await deps.db.update(documents).set({ kind: modelKind }).where(eq(documents.id, documentId));
  return { document_id: documentId, document_kind: modelKind, model_kind: modelKind, confidence };
}

/** `documents_extract`: read the document end to end and write the target's record. */
export async function extractDocument(
  deps: ToolDeps,
  args: { document_id: string; record_id?: string },
): Promise<DocumentsExtractResult> {
  const { document_id, record_id } = args;
  const row = await requireDocument(deps, document_id);
  // Already client-scoped by requireRecord. When given, this is the write target: no name or
  // external-id re-matching, so the extraction cannot silently attach to, rename, or duplicate a
  // different record of this client.
  const named = record_id ? await requireRecord(deps, record_id) : undefined;
  // The kind already on file decides which target this document feeds; an unclassified document
  // falls back to the catch-all target, which is what every single-target pack declares.
  const target = deps.packs.targetFor(row.kind ?? named?.kind ?? undefined);
  const { abs, promptPages, redacted, hits, ocrUsed } = await readForModel(deps, row);

  const modelFields = target.recordKind.fields;
  const messages = buildExtractionMessages(promptPages, modelFields, {
    role: target.role,
    instruction: target.target.instruction,
    attachmentInstruction: target.target.attachment_instruction,
  });
  assertPromptRedacted(deps, messages);
  const { json } = await callModelJson(deps, {
    route: 'extract',
    messages,
    jsonSchema: buildExtractionSchema({
      schemaName: target.target.schema_name,
      documentKinds: deps.packs.documentKinds(),
      fields: modelFields,
      attachmentKinds: target.attachmentKinds,
      attachmentsKey: target.target.attachments_key,
      // The schema's string, not the prompt's: these are two different fields on the target
      // and today's healthcare pipeline puts different text in each place.
      attachmentsDescription: target.target.attachment_schema_description,
      attachmentDescriptions: target.target.attachment_descriptions,
    }),
    validate: extractionReplyFor(target.target.attachments_key),
    temperature: 0,
  });
  const parsed = parseExtraction(json, target);

  const byName = new Map(parsed.fields.map((f) => [f.name, f]));
  // The record's display name is its kind's nameFields, joined and with the empties dropped —
  // `first_name middle_name last_name` for a provider, `title` for an epic.
  const name =
    named?.name ??
    target.recordKind.nameFields
      .map((field) => byName.get(field)?.value)
      .filter((part) => part !== undefined && part !== '')
      .join(' ');
  if (!name) {
    throw new ToolError(
      target.recordKind.missingNameError ??
        `extraction found no name for a ${target.recordKind.kind} record; pass record_id to attach this document to a known record`,
    );
  }
  const externalId = named?.externalId ?? externalIdFrom(target.recordKind, byName);

  const fieldInputs: FieldInput[] = parsed.fields.map((f) => ({
    name: f.name,
    value: f.value,
    confidence: f.confidence,
    source_doc_id: document_id,
    source_page: f.source_page,
  }));
  // Restricted values come from the regex pass, not the model, and carry full confidence: a
  // regex match is not a guess. `restricted: true` is belt and braces; the names also satisfy
  // isRestrictedName.
  const restrictedFields: FieldInput[] = hits.map((h) => ({
    name: h.fieldName,
    value: h.value,
    confidence: 1,
    restricted: true,
    source_doc_id: document_id,
    source_page: h.page,
  }));
  const attachmentInputs: AttachmentInput[] = parsed.attachments.map((a) => ({
    kind: a.kind,
    issuer: a.issuer,
    state: a.state,
    issued_at: a.issued_at,
    expires_at: a.expires_at,
    source_doc_id: document_id,
  }));

  const upserted = await upsertRecord(deps, {
    kind: target.recordKind.kind,
    name,
    external_id: externalId,
    recordId: named?.id,
    fields: [...fieldInputs, ...restrictedFields],
    attachments: attachmentInputs,
  });

  const textAbs = documentTextPath(abs);
  await deps.db
    .update(documents)
    .set({
      recordId: upserted.record_id,
      kind: row.kind ?? parsed.documentKind,
      ocrUsed,
      textPath: toStorageRelative(deps.storageDir, textAbs),
    })
    .where(eq(documents.id, document_id));

  // Only redacted text is ever written to disk, whatever restricted_to_model
  // says, and only now that every database write above has succeeded: a
  // throw above this line rolls the transaction back before the file exists.
  //
  // This write is NOT, however, after the commit. `runAuto` in the kernel's
  // execution.ts runs the handler inside `withTransaction` and inserts the audit row
  // after the handler returns, still inside it, so a failing audit insert or
  // a failing commit rolls the rows back with this file already on disk. The
  // window is narrow and the file holds redacted text only, so the orphan is
  // accepted rather than designed out: a re-run of documents_extract for the
  // same document computes the same path and overwrites it. If the write
  // itself fails partway, remove whatever landed.
  try {
    await writeFile(textAbs, redacted.map((p) => `<<<PAGE ${p.num}>>>\n${p.text}`).join('\n\n'), 'utf8');
  } catch (err) {
    await unlink(textAbs).catch(() => {});
    throw err;
  }

  return {
    document_id,
    record_id: upserted.record_id,
    document_kind: row.kind ?? parsed.documentKind,
    ocr_used: ocrUsed,
    pages: promptPages.length,
    fields_pending: upserted.fields_pending,
    fields_extracted: upserted.fields_extracted,
    attachments: upserted.attachments,
    restricted_fields: hits.map((h) => h.fieldName),
  };
}
