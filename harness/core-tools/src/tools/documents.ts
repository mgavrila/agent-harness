import * as z from 'zod/v4';
import { and, eq } from 'drizzle-orm';
import { documents } from '@harness/db';
import { defineTool, ToolError, type AnyToolDef, type ToolDeps } from '../registry.js';
import { requireProvider } from './providers.js';
import {
  DOCUMENT_KINDS,
  documentTextPath,
  readDocumentBytes,
  resolveStoragePath,
  sha256File,
  toStorageRelative,
} from '../documents/storage.js';
import { pdfPageCount } from '../documents/text.js';

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
    kind: z.enum(DOCUMENT_KINDS).optional().describe('Declare the kind when it is already known; otherwise documents_classify sets it'),
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
      .values({ client: deps.client, providerId: provider_id ?? null, kind: kind ?? null, storagePath: relative, sha256, pages })
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
    const rows = await deps.db.select().from(documents).where(and(...conditions));
    rows.sort((a, b) => b.ingestedAt.getTime() - a.ingestedAt.getTime());
    return { documents: rows.map(viewOf) };
  },
  recordIds: ({ provider_id }) => (provider_id ? [provider_id] : []),
});

/** Task 7 appends documents_classify and documents_extract to this array. */
export const documentTools: AnyToolDef[] = [documentsIngest, documentsGet, documentsList];
