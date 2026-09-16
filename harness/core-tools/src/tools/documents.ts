import { unlink, writeFile } from 'node:fs/promises';
import { and, eq } from 'drizzle-orm';
import * as z from 'zod/v4';
import { documents } from '@harness/db';
import { defineTool, ToolError, type AnyToolDef, type ToolDeps } from '../registry.js';
import {
  DOCUMENT_KINDS,
  documentTextPath,
  readDocumentBytes,
  resolveStoragePath,
  sha256File,
  toStorageRelative,
} from '../documents/storage.js';
import { pdfPageCount, extractDocumentText } from '../documents/text.js';
import { assertRedacted, redactPages } from '../shared/redaction/text.js';
import { callModelJson, type ModelMessage } from '../models.js';
import {
  buildClassificationMessages,
  buildClassificationSchema,
  buildExtractionMessages,
  buildExtractionSchema,
  loadHealthcareManifest,
  parseExtraction,
} from '../documents/extract.js';
import { requireProvider, upsertProviderRecord, type CredentialInput, type FieldInput } from './providers.js';

export { DOCUMENT_KINDS, documentTextPath };

const DocumentView = z.object({
  id: z.string(),
  provider_id: z.string().nullable(),
  kind: z.string().nullable(),
  storage_path: z.string(),
  sha256: z.string(),
  pages: z.number().nullable(),
  ocr_used: z.boolean(),
  has_text: z.boolean(),
  ingested_at: z.string(),
});

function viewOf(row: typeof documents.$inferSelect) {
  return {
    id: row.id,
    provider_id: row.providerId,
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
 * attached to a provider, which has no other owner to check against — and, if
 * it is attached, also refusing one whose provider belongs to another client.
 */
export async function requireDocument(deps: ToolDeps, documentId: string) {
  const row = await deps.db.query.documents.findFirst({
    where: and(eq(documents.id, documentId), eq(documents.client, deps.client)),
  });
  if (!row) throw new ToolError(`document ${documentId} not found`);
  if (row.providerId) await requireProvider(deps, row.providerId);
  return row;
}

const documentsIngest = defineTool({
  name: 'documents_ingest',
  description:
    'Register a file that is already under the harness storage directory: hash it, count its pages, and store a documents row. ' +
    'Idempotent by content hash, so re-ingesting the same file returns the same document id. ' +
    'Does not read the text; call documents_extract for that.',
  actionClass: 'write.internal',
  input: z.object({
    path: z.string().min(1).describe('Path relative to the harness storage directory, e.g. incoming/license.pdf'),
    provider_id: z.string().uuid().optional(),
    kind: z
      .enum(DOCUMENT_KINDS)
      .optional()
      .describe('Declare the kind when it is already known; otherwise documents_classify sets it'),
  }),
  output: z.object({
    document_id: z.string(),
    sha256: z.string(),
    pages: z.number(),
    storage_path: z.string(),
    already_ingested: z.boolean(),
  }),
  handler: async ({ path: requested, provider_id, kind }, deps) => {
    if (provider_id) await requireProvider(deps, provider_id);
    const abs = await resolveStoragePath(deps.storageDir, requested);
    const relative = toStorageRelative(deps.storageDir, abs);
    const sha256 = await sha256File(abs);

    // Scoped to this client: the same file ingested by two different clients
    // must produce two separate documents rows, not a shared one.
    const existing = await deps.db.query.documents.findFirst({
      where: and(eq(documents.sha256, sha256), eq(documents.client, deps.client)),
    });
    if (existing) {
      // A second ingest may supply the provider or kind the first one lacked.
      const patch: Partial<typeof documents.$inferInsert> = {};
      if (provider_id && !existing.providerId) patch.providerId = provider_id;
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
        providerId: provider_id ?? null,
        kind: kind ?? null,
        storagePath: relative,
        sha256,
        pages,
      })
      .returning();
    return { document_id: row.id, sha256, pages, storage_path: relative, already_ingested: false };
  },
  recordIds: (_args, result) => [result.document_id],
});

const documentsGet = defineTool({
  name: 'documents_get',
  description: 'Return one document record. Never returns the document text or any restricted value.',
  actionClass: 'read',
  input: z.object({ document_id: z.string().uuid() }),
  output: z.object({ document: DocumentView }),
  handler: async ({ document_id }, deps) => ({ document: viewOf(await requireDocument(deps, document_id)) }),
  recordIds: ({ document_id }) => [document_id],
});

const documentsList = defineTool({
  name: 'documents_list',
  description:
    'List the documents on file for this client, newest first. Pass provider_id to scope to one provider; ' +
    'omit it to list every document ingested by this client, including ones not yet attached to a provider.',
  actionClass: 'read',
  input: z.object({ provider_id: z.string().uuid().optional() }),
  output: z.object({ documents: z.array(DocumentView) }),
  handler: async ({ provider_id }, deps) => {
    const conditions = [eq(documents.client, deps.client)];
    if (provider_id) {
      await requireProvider(deps, provider_id);
      conditions.push(eq(documents.providerId, provider_id));
    }
    const rows = await deps.db
      .select()
      .from(documents)
      .where(and(...conditions));
    rows.sort((a, b) => b.ingestedAt.getTime() - a.ingestedAt.getTime());
    return { documents: rows.map(viewOf) };
  },
  recordIds: ({ provider_id }) => (provider_id ? [provider_id] : []),
});

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
 * Reply shape from the extraction route. Deliberately loose on the *contents*
 * of `fields` and `credentials` — `parseExtraction` is what clamps confidence,
 * drops empty values, and drops anything the manifest does not allow (a
 * restricted field the model volunteers included) — but this still requires
 * an object with all three top-level parts, so a reply that is not shaped
 * like an extraction at all throws here rather than deeper in the pipeline.
 */
const ExtractionReply = z.object({
  document_kind: z.string(),
  fields: z.record(z.string(), z.unknown()),
  credentials: z.array(z.unknown()),
});

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

const documentsClassify = defineTool({
  name: 'documents_classify',
  description:
    'Decide what kind of credentialing document this is (state licence, DEA certificate, malpractice certificate, W-9 or other) and record it, ' +
    'unless a kind is already on file: a kind declared at ingest, or set by an earlier classification, is authoritative and is never overwritten ' +
    "by a disagreeing model reply — the model's own answer is still returned as model_kind so a human can see the disagreement. " +
    'Reads the document text, redacting restricted identifiers first.',
  actionClass: 'write.internal',
  input: z.object({ document_id: z.string().uuid() }),
  output: z.object({
    document_id: z.string(),
    document_kind: z.string(),
    model_kind: z
      .string()
      .describe('What the model said. Differs from document_kind only when a declared kind was already on file.'),
    confidence: z.number(),
  }),
  handler: async ({ document_id }, deps) => {
    const row = await requireDocument(deps, document_id);
    const manifest = loadHealthcareManifest();
    const { promptPages } = await readForModel(deps, row);
    const messages = buildClassificationMessages(promptPages);
    assertPromptRedacted(deps, messages);
    const { json } = await callModelJson(deps, {
      route: 'extract',
      messages,
      jsonSchema: buildClassificationSchema(manifest),
      validate: ClassificationReply,
      temperature: 0,
    });
    const modelKind = (manifest.document_kinds as string[]).includes(json.document_kind) ? json.document_kind : 'other';
    const confidence = Math.min(1, Math.max(0, json.confidence));
    // A kind already on file is authoritative, the same rule documents_ingest
    // applies to a declared kind and documents_extract applies by preferring
    // row.kind: classification never overwrites it, even when the model
    // disagrees.
    if (row.kind) {
      return { document_id, document_kind: row.kind, model_kind: modelKind, confidence };
    }
    await deps.db.update(documents).set({ kind: modelKind }).where(eq(documents.id, document_id));
    return { document_id, document_kind: modelKind, model_kind: modelKind, confidence };
  },
  recordIds: ({ document_id }) => [document_id],
});

const documentsExtract = defineTool({
  name: 'documents_extract',
  description:
    'Read a document end to end: text layer or OCR, redact SSN/EIN/DEA, ask the extract route for the provider fields and credentials, ' +
    'then write them to the provider record. Fields below the confidence threshold are stored as pending for a human to confirm. ' +
    'Restricted identifiers are stored encrypted straight from the redaction pass and are never sent to a model.',
  actionClass: 'write.internal',
  input: z.object({
    document_id: z.string().uuid(),
    provider_id: z
      .string()
      .uuid()
      .optional()
      .describe('Attach to this provider instead of matching on the extracted name'),
  }),
  output: z.object({
    document_id: z.string(),
    provider_id: z.string(),
    document_kind: z.string(),
    ocr_used: z.boolean(),
    pages: z.number(),
    fields_pending: z.number(),
    fields_extracted: z.number(),
    credentials: z.number(),
    restricted_fields: z.array(z.string()).describe('Names only. The values are encrypted on the provider record.'),
  }),
  handler: async ({ document_id, provider_id }, deps) => {
    const row = await requireDocument(deps, document_id);
    // Already client-scoped by requireProvider. When given, this is the write
    // target: no name/NPI re-matching, so the extraction cannot silently
    // attach to, rename, or duplicate a different provider of this client.
    const named = provider_id ? await requireProvider(deps, provider_id) : undefined;
    const manifest = loadHealthcareManifest();
    const { abs, promptPages, redacted, hits, ocrUsed } = await readForModel(deps, row);

    const messages = buildExtractionMessages(promptPages, manifest);
    assertPromptRedacted(deps, messages);
    const { json } = await callModelJson(deps, {
      route: 'extract',
      messages,
      jsonSchema: buildExtractionSchema(manifest),
      validate: ExtractionReply,
      temperature: 0,
    });
    const parsed = parseExtraction(json, manifest);

    const byName = new Map(parsed.fields.map((f) => [f.name, f]));
    const name =
      named?.name ??
      [byName.get('first_name')?.value, byName.get('middle_name')?.value, byName.get('last_name')?.value]
        .filter((part) => part !== undefined && part !== '')
        .join(' ');
    if (!name) {
      throw new ToolError(
        'extraction found no provider name; pass provider_id to attach this document to a known provider',
      );
    }
    const npiValue = byName.get('npi')?.value?.replace(/\D/g, '');
    const npi = named?.npi ?? (npiValue && npiValue.length === 10 ? npiValue : undefined);

    const modelFields: FieldInput[] = parsed.fields.map((f) => ({
      name: f.name,
      value: f.value,
      confidence: f.confidence,
      source_doc_id: document_id,
      source_page: f.source_page,
    }));
    // Restricted values come from the regex pass, not the model, and carry
    // full confidence: a regex match is not a guess. `restricted: true` is
    // belt and braces; the names also satisfy isRestrictedName.
    const restrictedFields: FieldInput[] = hits.map((h) => ({
      name: h.fieldName,
      value: h.value,
      confidence: 1,
      restricted: true,
      source_doc_id: document_id,
      source_page: h.page,
    }));
    const credentialInputs: CredentialInput[] = parsed.credentials.map((c) => ({
      kind: c.kind,
      issuer: c.issuer,
      state: c.state,
      issued_at: c.issued_at,
      expires_at: c.expires_at,
      source_doc_id: document_id,
    }));

    const upserted = await upsertProviderRecord(deps, {
      name,
      npi,
      providerId: named?.id,
      fields: [...modelFields, ...restrictedFields],
      credentials: credentialInputs,
    });

    const textAbs = documentTextPath(abs);
    await deps.db
      .update(documents)
      .set({
        providerId: upserted.provider_id,
        kind: row.kind ?? parsed.documentKind,
        ocrUsed,
        textPath: toStorageRelative(deps.storageDir, textAbs),
      })
      .where(eq(documents.id, document_id));

    // Only redacted text is ever written to disk, whatever restricted_to_model
    // says, and only now that every database write above has succeeded: a
    // throw above this line rolls the transaction back before the file exists.
    //
    // This write is NOT, however, after the commit. `runAuto` in registry.ts
    // runs the handler inside `withTransaction` and inserts the audit row
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
      provider_id: upserted.provider_id,
      document_kind: row.kind ?? parsed.documentKind,
      ocr_used: ocrUsed,
      pages: promptPages.length,
      fields_pending: upserted.fields_pending,
      fields_extracted: upserted.fields_extracted,
      credentials: upserted.credentials,
      restricted_fields: hits.map((h) => h.fieldName),
    };
  },
  recordIds: (args, result) => [args.document_id, result.provider_id],
});

export const documentTools: AnyToolDef[] = [
  documentsIngest,
  documentsClassify,
  documentsExtract,
  documentsGet,
  documentsList,
];
