import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import type { PackRegistry } from '../domain/packs/types.js';
import {
  classifyDocument,
  documentView,
  extractDocument,
  ingestDocument,
  listDocuments,
  requireDocument,
} from '../domain/documents/pipeline.js';

const DocumentView = z.object({
  id: z.string(),
  record_id: z.string().nullable(),
  kind: z.string().nullable(),
  storage_path: z.string(),
  sha256: z.string(),
  pages: z.number().nullable(),
  ocr_used: z.boolean(),
  has_text: z.boolean(),
  ingested_at: z.string(),
});

/**
 * `documents_ingest` is the one tool whose JSON Schema carries the document-kind list, so it is
 * the one definition built from the loaded packs rather than declared as a constant. The cast is
 * needed because `z.enum` wants a non-empty tuple; `definePack` refuses a pack with no kinds, so
 * a loaded pack always contributes at least one.
 *
 * A client with no pack has no kinds at all, and there the argument is left out of the schema
 * altogether rather than published as an enum of nothing: `z.enum([])` renders as `{"not": {}}`,
 * a property a caller can read and never satisfy. Nothing is lost — with no pack there is no
 * kind to declare — and the file still ingests.
 */
function documentsIngestFor(packs: PackRegistry) {
  const kinds = packs.documentKinds();
  const file = {
    path: z.string().min(1).describe('Path relative to the harness storage directory, e.g. incoming/scan.pdf'),
    record_id: z.string().uuid().optional(),
  };
  const input =
    kinds.length === 0
      ? z.object(file)
      : z.object({
          ...file,
          kind: z
            .enum(kinds as [string, ...string[]])
            .optional()
            .describe('Declare the kind when it is already known; otherwise documents_classify sets it'),
        });
  return defineTool({
    name: 'documents_ingest',
    description:
      'Register a file that is already under the harness storage directory: hash it, count its pages, and store a documents row. ' +
      'Idempotent by content hash, so re-ingesting the same file returns the same document id. ' +
      'Does not read the text; call documents_extract for that.',
    actionClass: 'write.internal',
    input,
    output: z.object({
      document_id: z.string(),
      sha256: z.string(),
      pages: z.number(),
      storage_path: z.string(),
      already_ingested: z.boolean(),
    }),
    handler: async (args, deps) => ingestDocument(deps, args),
    recordIds: (_args, result) => [result.document_id],
  });
}

const documentsGet = defineTool({
  name: 'documents_get',
  description: 'Return one document record. Never returns the document text or any restricted value.',
  actionClass: 'read',
  input: z.object({ document_id: z.string().uuid() }),
  output: z.object({ document: DocumentView }),
  handler: async ({ document_id }, deps) => ({ document: documentView(await requireDocument(deps, document_id)) }),
  recordIds: ({ document_id }) => [document_id],
});

const documentsList = defineTool({
  name: 'documents_list',
  description:
    'List the documents on file for this client, newest first. Pass record_id to scope to one record; ' +
    'omit it to list every document ingested by this client, including ones not yet attached to a record.',
  actionClass: 'read',
  input: z.object({ record_id: z.string().uuid().optional() }),
  output: z.object({ documents: z.array(DocumentView) }),
  handler: async ({ record_id }, deps) => ({ documents: await listDocuments(deps, record_id) }),
  recordIds: ({ record_id }) => (record_id ? [record_id] : []),
});

const documentsClassify = defineTool({
  name: 'documents_classify',
  description:
    'Decide what kind of document this is, from the kinds the loaded packs declare, and record it, ' +
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
  handler: async ({ document_id }, deps) => classifyDocument(deps, document_id),
  recordIds: ({ document_id }) => [document_id],
});

const documentsExtract = defineTool({
  name: 'documents_extract',
  description:
    'Read a document end to end: text layer or OCR, redact SSN/EIN/DEA, ask the extract route for the fields and attachments its extraction target declares, ' +
    "then write them to a record of that target's kind. Fields below the confidence threshold are stored as pending for a human to confirm. " +
    'Restricted identifiers are stored encrypted straight from the redaction pass and are never sent to a model.',
  actionClass: 'write.internal',
  input: z.object({
    document_id: z.string().uuid(),
    record_id: z.string().uuid().optional().describe('Attach to this record instead of matching on the extracted name'),
  }),
  output: z.object({
    document_id: z.string(),
    record_id: z.string(),
    document_kind: z.string(),
    ocr_used: z.boolean(),
    pages: z.number(),
    fields_pending: z.number(),
    fields_extracted: z.number(),
    attachments: z.number(),
    restricted_fields: z.array(z.string()).describe('Names only. The values are encrypted on the record.'),
  }),
  handler: async (args, deps) => extractDocument(deps, args),
  recordIds: (args, result) => [args.document_id, result.record_id],
});

/**
 * The two document tools that need a pack to do anything: one asks the model which of the loaded
 * packs' kinds a document is, the other writes a pack's record from it. The publication gate in
 * `tools/catalog.ts` withholds them when no loaded pack declares a document kind, the same way it
 * withholds the generic record tools when no loaded record kind wants them — a tool in the
 * catalogue is a claim to the model that it can be called. Ingesting, getting and listing a file
 * are the kernel's own business and stay published whatever is loaded.
 */
export const PACK_DOCUMENT_TOOLS = ['documents_classify', 'documents_extract'] as const;

export function documentTools(packs: PackRegistry): AnyToolDef[] {
  return [documentsIngestFor(packs), documentsClassify, documentsExtract, documentsGet, documentsList];
}
