/**
 * The five `documents_*` wrappers, published under the kernel's own names.
 *
 * All five are in `HEALTHCARE_REPLACES`, and `replaces` is process-wide: once this pack loads,
 * every document in the process reaches these wrappers, including one on its way to another
 * pack's extraction target. Renaming such a document's record id to `provider_id` and its
 * attachment count to `credentials` would be this pack answering for records it does not own, so
 * a foreign document's result is returned exactly as the kernel produced it and the schemas below
 * widen to say both shapes are possible. Every widening is conditional on some other pack having
 * declared a document kind, which is what keeps the schemas byte-identical to the ones
 * `docs/architecture/tool-surface.json` records: that snapshot is taken for
 * `HARNESS_PACKS=@harness/pack-healthcare` alone.
 *
 * Otherwise every schema here is the object the pre-Plan-5 `tools/documents.ts` declared, copied
 * without an edit, down to the order of its members.
 */
import * as z from 'zod/v4';
import {
  definePackTool,
  type AnyToolDef,
  type DocumentRecordView,
  type DocumentsClassifyResult,
  type DocumentsExtractResult,
  type DocumentsIngestResult,
  type PackToolDeps,
} from '@harness/pack-api';
import { PACK_NAME } from '../../pack-name.js';
import { callKernel } from './kernel-call.js';

/** One document as this pack has always reported it: `provider_id` for the owner. */
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

/** One document as the kernel reports it: the same nine members, with `record_id` for the owner. */
const KernelDocumentView = z.object({
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

const asDocumentView = (d: DocumentRecordView) => ({
  id: d.id,
  provider_id: d.record_id,
  kind: d.kind,
  storage_path: d.storage_path,
  sha256: d.sha256,
  pages: d.pages,
  ocr_used: d.ocr_used,
  has_text: d.has_text,
  ingested_at: d.ingested_at,
});

/** The document kinds some other loaded pack declares. Empty for a healthcare-only deployment. */
function foreignDocumentKinds(deps: PackToolDeps): ReadonlySet<string> {
  const own = new Set(deps.packs.byName(PACK_NAME).documentKinds);
  return new Set(deps.packs.documentKinds().filter((kind) => !own.has(kind)));
}

/**
 * The view a `documents_*` wrapper publishes: this pack's alone, or either shape once another
 * pack's documents can reach the tool.
 */
function documentViewFor(foreign: ReadonlySet<string>) {
  return foreign.size === 0 ? DocumentView : z.union([DocumentView, KernelDocumentView]);
}

/** A document this pack owns is renamed; another pack's is returned untouched. */
function viewDocument(foreign: ReadonlySet<string>, d: DocumentRecordView) {
  return d.kind !== null && foreign.has(d.kind) ? d : asDocumentView(d);
}

/** The prose these two definitions share, so the widened one cannot drift from the published one. */
const EXTRACT_DESCRIPTION =
  'Read a document end to end: text layer or OCR, redact SSN/EIN/DEA, ask the extract route for the provider fields and credentials, ' +
  'then write them to the provider record. Fields below the confidence threshold are stored as pending for a human to confirm. ' +
  'Restricted identifiers are stored encrypted straight from the redaction pass and are never sent to a model.';

const EXTRACT_INPUT = z.object({
  document_id: z.string().uuid(),
  provider_id: z
    .string()
    .uuid()
    .optional()
    .describe('Attach to this provider instead of matching on the extracted name'),
});

const extractArgs = (args: { document_id: string; provider_id?: string }) => ({
  document_id: args.document_id,
  record_id: args.provider_id,
});

const asProviderExtract = (r: DocumentsExtractResult) => ({
  document_id: r.document_id,
  provider_id: r.record_id,
  document_kind: r.document_kind,
  ocr_used: r.ocr_used,
  pages: r.pages,
  fields_pending: r.fields_pending,
  fields_extracted: r.fields_extracted,
  credentials: r.attachments,
  restricted_fields: r.restricted_fields,
});

/**
 * `documents_extract`, in the only two shapes a deployment can ask for.
 *
 * Two whole definitions rather than one schema built from a condition, because the difference is
 * at the top level and a tool's output must be a single object schema: the published one names
 * `provider_id` and `credentials` and nothing else, and the widened one has to admit the kernel's
 * `record_id` and `attachments` as well. Writing both out is what lets the first stay the exact
 * object `docs/architecture/tool-surface.json` records while the second exists at all.
 */
function documentsExtractFor(foreign: ReadonlySet<string>): AnyToolDef {
  if (foreign.size === 0) {
    return definePackTool({
      name: 'documents_extract',
      description: EXTRACT_DESCRIPTION,
      actionClass: 'write.internal',
      input: EXTRACT_INPUT,
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
      handler: async (args, deps) =>
        asProviderExtract(await callKernel<DocumentsExtractResult>(deps, 'documents_extract', extractArgs(args))),
      recordIds: (args, result) => [args.document_id, result.provider_id],
    });
  }
  return definePackTool({
    name: 'documents_extract',
    description:
      `${EXTRACT_DESCRIPTION} ` +
      'A document whose kind belongs to another loaded pack is extracted into that pack’s record kind and reported ' +
      'under record_id and attachments instead of provider_id and credentials.',
    actionClass: 'write.internal',
    input: EXTRACT_INPUT,
    output: z.object({
      document_id: z.string(),
      provider_id: z.string().optional().describe('The provider written, when this document is a credentialing one'),
      record_id: z.string().optional().describe('The record written, when this document belongs to another pack'),
      document_kind: z.string(),
      ocr_used: z.boolean(),
      pages: z.number(),
      fields_pending: z.number(),
      fields_extracted: z.number(),
      credentials: z.number().optional(),
      attachments: z.number().optional(),
      restricted_fields: z.array(z.string()).describe('Names only. The values are encrypted on the record.'),
    }),
    handler: async (args, deps) => {
      const r = await callKernel<DocumentsExtractResult>(deps, 'documents_extract', extractArgs(args));
      // Another pack's document was routed to another pack's target and wrote another pack's
      // record kind. Renaming any of that into this pack's vocabulary would be a lie.
      return foreign.has(r.document_kind) ? r : asProviderExtract(r);
    },
    recordIds: (args, result) =>
      [args.document_id, result.provider_id ?? result.record_id].filter((id) => id !== undefined),
  });
}

export function documentAliases(deps: PackToolDeps): AnyToolDef[] {
  const foreign = foreignDocumentKinds(deps);

  const documentsIngest = definePackTool({
    name: 'documents_ingest',
    description:
      'Register a file that is already under the harness storage directory: hash it, count its pages, and store a documents row. ' +
      'Idempotent by content hash, so re-ingesting the same file returns the same document id. ' +
      'Does not read the text; call documents_extract for that.',
    actionClass: 'write.internal',
    input: z.object({
      // The kernel's copy of this string reads `incoming/scan.pdf`, because the kernel names no
      // credentialing concept. This copy must keep `license`: it is the one an MCP client
      // receives and the one `tool-surface.json` records. The two are meant to differ.
      path: z.string().min(1).describe('Path relative to the harness storage directory, e.g. incoming/license.pdf'),
      provider_id: z.string().uuid().optional(),
      kind: z
        .enum(deps.packs.documentKinds() as [string, ...string[]])
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
    handler: async (args, deps) =>
      callKernel<DocumentsIngestResult>(deps, 'documents_ingest', {
        path: args.path,
        record_id: args.provider_id,
        kind: args.kind,
      }),
    recordIds: (_args, result) => [result.document_id],
  });

  const documentsGet = definePackTool({
    name: 'documents_get',
    description: 'Return one document record. Never returns the document text or any restricted value.',
    actionClass: 'read',
    input: z.object({ document_id: z.string().uuid() }),
    output: z.object({ document: documentViewFor(foreign) }),
    handler: async ({ document_id }, deps) => {
      const r = await callKernel<{ document: DocumentRecordView }>(deps, 'documents_get', { document_id });
      return { document: viewDocument(foreign, r.document) };
    },
    recordIds: ({ document_id }) => [document_id],
  });

  const documentsList = definePackTool({
    name: 'documents_list',
    description:
      'List the documents on file for this client, newest first. Pass provider_id to scope to one provider; ' +
      'omit it to list every document ingested by this client, including ones not yet attached to a provider.',
    actionClass: 'read',
    input: z.object({ provider_id: z.string().uuid().optional() }),
    output: z.object({ documents: z.array(documentViewFor(foreign)) }),
    handler: async ({ provider_id }, deps) => {
      const r = await callKernel<{ documents: DocumentRecordView[] }>(deps, 'documents_list', {
        record_id: provider_id,
      });
      // Per document, not per call: one list can hold this pack's documents and another pack's.
      return { documents: r.documents.map((d) => viewDocument(foreign, d)) };
    },
    recordIds: ({ provider_id }) => (provider_id ? [provider_id] : []),
  });

  const documentsClassify = definePackTool({
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
    handler: async ({ document_id }, deps) =>
      callKernel<DocumentsClassifyResult>(deps, 'documents_classify', { document_id }),
    recordIds: ({ document_id }) => [document_id],
  });

  return [documentsIngest, documentsGet, documentsList, documentsClassify, documentsExtractFor(foreign)];
}
