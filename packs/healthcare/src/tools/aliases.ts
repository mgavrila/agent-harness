/**
 * The healthcare-shaped tool surface, as twelve wrappers over the kernel's generic tools.
 *
 * Every schema below is the object the pre-Plan-5 tool declared, copied without an edit: the
 * resolved JSON Schema an MCP client receives is the same bytes, and `docs/architecture/
 * tool-surface.json` is what proves it. Five of the twelve — the `providers_*` names — are
 * renames over `records_*`; the other seven take the kernel's name and are the whole of
 * `HEALTHCARE_REPLACES`.
 *
 * Each handler reaches its kernel tool through `deps.kernelTools`, never `deps.tools`: the
 * published catalogue holds these wrappers under `documents_ingest` and `deadlines_compute`, so
 * a lookup there would find the wrapper and recurse.
 *
 * One description here is load-bearing in a way that is easy to miss: `documents_ingest`'s
 * `path` input says `e.g. incoming/license.pdf`. The *kernel's* copy of that string reads
 * `incoming/scan.pdf`, because the kernel names no credentialing concept. This copy must keep
 * `license`, because it is the one an MCP client receives and the one `tool-surface.json`
 * records. The two are meant to differ. Do not "fix" this file to match the kernel.
 */
import * as z from 'zod/v4';
import { ToolError } from '@harness/shared';
import {
  definePackTool,
  type AnyToolDef,
  type DeadlinesComputeResult,
  type DeadlinesUpcomingResult,
  type DocumentRecordView,
  type DocumentsClassifyResult,
  type DocumentsExtractResult,
  type DocumentsIngestResult,
  type PackToolDeps,
  type RecordsGetResult,
  type RecordsListPendingResult,
  type RecordsSearchResult,
  type RecordsUpsertResult,
} from '@harness/pack-api';
import { CREDENTIAL_KINDS } from '../domain/credentials/kinds.js';
import { FieldInput, URGENCY_BUCKETS } from './shapes.js';

/**
 * The kernel tools this pack takes over: the **seven same-named** ones, and no others.
 *
 * `replaces` removes a name from the published catalogue for the whole process, so it may only
 * carry names this pack genuinely re-publishes under the same name. The five `providers_*`
 * wrappers are *renames* over `records_*`, not replacements, and the five `records_*` names are
 * hidden from a healthcare-only deployment by `genericTools: false` on the `provider` record
 * kind instead (Decision 3). That second mechanism is what lets a second pack loaded beside
 * this one still reach the generic record tools.
 *
 * `COMPAT_REPLACES`, the transitional list this file carried while it still lived in
 * core-tools, did name twelve; it was not a pack, so it had no `genericTools` gate to lean on.
 * Dropping the five here is the whole difference between the two lists, and the surface
 * snapshot proves it changes nothing for healthcare: 17 kernel tools - 7 replaced - 5 gated off
 * + 18 from this pack = the same 23 names as before.
 */
export const HEALTHCARE_REPLACES = [
  'deadlines_compute',
  'deadlines_upcoming',
  'documents_ingest',
  'documents_get',
  'documents_list',
  'documents_classify',
  'documents_extract',
] as const;

/**
 * The kernel tool this wrapper is a face for. A missing one is a `ToolError` rather than a
 * crash: it can only happen if the catalogue and this list disagree, and the message names the
 * tool so the disagreement is obvious.
 */
async function callKernel<T>(deps: PackToolDeps, name: string, args: unknown): Promise<T> {
  const tool = deps.kernelTools.get(name);
  if (!tool) throw new ToolError(`kernel tool "${name}" is not loaded`);
  return (await tool.handler(args, deps)) as T;
}

/**
 * The credential input, written out rather than derived from `AttachmentInput`.
 *
 * `AttachmentInput.extend({ kind }).omit({ properties })` would produce the same *set* of
 * members and a different *order* — `extend` appends — and JSON Schema property order is part of
 * the bytes `docs/architecture/tool-surface.json` records. So this is `domain/providers/types.ts`
 * character for character, closed enum included; the kernel's `AttachmentInput` takes a plain
 * string and checks it against the loaded packs instead.
 */
const CredentialInput = z.object({
  kind: z.enum(CREDENTIAL_KINDS),
  issuer: z.string().optional(),
  number: z.string().optional(),
  state: z.string().length(2).optional(),
  issued_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  expires_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  source_doc_id: z.string().uuid().optional(),
});

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

function documentsIngestFor(deps: PackToolDeps) {
  return definePackTool({
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
    handler: async (args, d) =>
      callKernel<DocumentsIngestResult>(d, 'documents_ingest', {
        path: args.path,
        record_id: args.provider_id,
        kind: args.kind,
      }),
    recordIds: (_args, result) => [result.document_id],
  });
}

/**
 * The twelve wrappers, built once per server from the live dependency bag.
 *
 * A factory rather than a module-level array because `redact` takes only the tool's arguments:
 * it has no `deps` of its own, so the two redaction primitives it needs have to be closed over
 * from the bag this was handed.
 */
export function aliasTools(deps: PackToolDeps): AnyToolDef[] {
  const { MASKED, isRestrictedName } = deps.kernel;

  const providersUpsert = definePackTool({
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
    handler: async (args, deps) => {
      const r = await callKernel<RecordsUpsertResult>(deps, 'records_upsert', {
        kind: 'provider',
        name: args.name,
        external_id: args.npi,
        fields: args.fields,
        attachments: args.credentials,
      });
      return {
        provider_id: r.record_id,
        fields_pending: r.fields_pending,
        fields_extracted: r.fields_extracted,
        credentials: r.attachments,
      };
    },
    recordIds: (_args, result) => [result.provider_id],
    redact: (args) => ({
      ...args,
      fields: args.fields.map((f) => (f.restricted === true || isRestrictedName(f.name) ? { ...f, value: MASKED } : f)),
      credentials: args.credentials.map((c) => (c.number === undefined ? c : { ...c, number: MASKED })),
    }),
  });

  const providersGet = definePackTool({
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
      const r = await callKernel<RecordsGetResult>(deps, 'records_get', { record_id: provider_id });
      return {
        provider: { id: r.record.id, name: r.record.name, npi: r.record.external_id, status: r.record.status },
        fields: r.fields,
        // Projected down to the six members the credential view has always had: `issued_at` and
        // `properties` are on the kernel's view and were never on this one.
        credentials: r.attachments.map((a) => ({
          id: a.id,
          kind: a.kind,
          issuer: a.issuer,
          number: a.number,
          state: a.state,
          expires_at: a.expires_at,
        })),
      };
    },
    recordIds: ({ provider_id }) => [provider_id],
  });

  const providersSearch = definePackTool({
    name: 'providers_search',
    description: 'Search providers by name fragment or exact NPI.',
    actionClass: 'read',
    input: z.object({ query: z.string().min(1) }),
    output: z.object({
      providers: z.array(z.object({ provider_id: z.string(), name: z.string(), npi: z.string().nullable() })),
    }),
    handler: async ({ query }, deps) => {
      // One box, two meanings: the kernel ORs a name fragment with an exact external id, which is
      // the `ilike(name) OR npi =` this tool has always run.
      const r = await callKernel<RecordsSearchResult>(deps, 'records_search', {
        kind: 'provider',
        name: query,
        external_id: query,
      });
      return { providers: r.records.map((x) => ({ provider_id: x.record_id, name: x.name, npi: x.external_id })) };
    },
  });

  const providersConfirmField = definePackTool({
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
      await callKernel(deps, 'records_confirm_field', {
        record_id: args.provider_id,
        field: args.field,
        value: args.value,
        confirmed_by: args.confirmed_by,
      });
      return { provider_id: args.provider_id, field: args.field, status: 'verified' as const };
    },
    recordIds: ({ provider_id }) => [provider_id],
    redact: (args) => (isRestrictedName(args.field) ? { ...args, value: MASKED } : args),
  });

  const providersListPending = definePackTool({
    name: 'providers_list_pending',
    description: 'List fields that still need human confirmation for a provider.',
    actionClass: 'read',
    input: z.object({ provider_id: z.string().uuid() }),
    output: z.object({
      fields: z.array(
        z.object({ name: z.string(), confidence: z.number().nullable(), source_page: z.number().nullable() }),
      ),
    }),
    handler: async ({ provider_id }, deps) =>
      callKernel<RecordsListPendingResult>(deps, 'records_list_pending', { record_id: provider_id }),
  });

  const deadlinesCompute = definePackTool({
    name: 'deadlines_compute',
    description:
      'Recompute expiration and renewal-start deadlines for a provider from its credentials. Deterministic, no model call.',
    actionClass: 'write.internal',
    input: z.object({ provider_id: z.string().uuid() }),
    output: z.object({
      deadlines: z.array(z.object({ credential_id: z.string(), kind: z.string(), due_at: z.string() })),
    }),
    handler: async ({ provider_id }, deps) => {
      const r = await callKernel<DeadlinesComputeResult>(deps, 'deadlines_compute', { record_id: provider_id });
      return {
        deadlines: r.deadlines.map((d) => ({ credential_id: d.attachment_id, kind: d.kind, due_at: d.due_at })),
      };
    },
    recordIds: ({ provider_id }) => [provider_id],
  });

  const deadlinesUpcoming = definePackTool({
    name: 'deadlines_upcoming',
    description:
      'List deadlines due within a window (default 90 days), including overdue ones, sorted by due date. ' +
      'At most `limit` rows (default 200).',
    actionClass: 'read',
    input: z.object({
      window_days: z.number().int().min(1).max(730).default(90),
      today: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      limit: z.number().int().min(1).max(1000).default(200),
    }),
    output: z.object({
      items: z.array(
        z.object({
          provider_id: z.string(),
          provider_name: z.string(),
          credential_id: z.string(),
          credential_kind: z.string(),
          kind: z.string(),
          due_at: z.string(),
          days_left: z.number(),
          overdue: z.boolean(),
          bucket: z.enum([...URGENCY_BUCKETS]),
        }),
      ),
      /**
       * Fingerprint of this exact set of (credential, deadline kind, bucket) triples, independent
       * of item order. A playbook passes this straight through as `harness_notify`'s idempotency
       * key: the same set of items in the same buckets produces the same key, so a re-run digest
       * is a no-op, and an item moving to a tighter bucket changes the key so the next run speaks
       * again. `expirations:none` when there are no items.
       */
      digest_key: z.string(),
    }),
    handler: async (args, deps) => {
      // `record_kind: 'provider'` so a deployment that also loads another pack does not list its
      // records under `provider_name`. With one pack loaded the result is unchanged.
      const r = await callKernel<DeadlinesUpcomingResult>(deps, 'deadlines_upcoming', {
        within_days: args.window_days,
        today: args.today,
        limit: args.limit,
        record_kind: 'provider',
      });
      return {
        items: r.items.map((i) => ({
          provider_id: i.record_id,
          provider_name: i.record_name,
          credential_id: i.attachment_id,
          credential_kind: i.attachment_kind,
          kind: i.kind,
          due_at: i.due_at,
          days_left: i.days_left,
          overdue: i.overdue,
          bucket: i.bucket as (typeof URGENCY_BUCKETS)[number],
        })),
        digest_key: r.digest_key,
      };
    },
  });

  const documentsGet = definePackTool({
    name: 'documents_get',
    description: 'Return one document record. Never returns the document text or any restricted value.',
    actionClass: 'read',
    input: z.object({ document_id: z.string().uuid() }),
    output: z.object({ document: DocumentView }),
    handler: async ({ document_id }, deps) => {
      const r = await callKernel<{ document: DocumentRecordView }>(deps, 'documents_get', { document_id });
      return { document: asDocumentView(r.document) };
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
    output: z.object({ documents: z.array(DocumentView) }),
    handler: async ({ provider_id }, deps) => {
      const r = await callKernel<{ documents: DocumentRecordView[] }>(deps, 'documents_list', {
        record_id: provider_id,
      });
      return { documents: r.documents.map(asDocumentView) };
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

  const documentsExtract = definePackTool({
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
    handler: async (args, deps) => {
      const r = await callKernel<DocumentsExtractResult>(deps, 'documents_extract', {
        document_id: args.document_id,
        record_id: args.provider_id,
      });
      return {
        document_id: r.document_id,
        provider_id: r.record_id,
        document_kind: r.document_kind,
        ocr_used: r.ocr_used,
        pages: r.pages,
        fields_pending: r.fields_pending,
        fields_extracted: r.fields_extracted,
        credentials: r.attachments,
        restricted_fields: r.restricted_fields,
      };
    },
    recordIds: (args, result) => [args.document_id, result.provider_id],
  });

  return [
    providersUpsert,
    providersGet,
    providersSearch,
    providersConfirmField,
    providersListPending,
    deadlinesCompute,
    deadlinesUpcoming,
    documentsIngestFor(deps),
    documentsGet,
    documentsList,
    documentsClassify,
    documentsExtract,
  ];
}
