/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Pack } from './pack.js';
import type { AttachmentKindSpec, RecordKindSpec } from './records.js';

/**
 * A kernel tool as a pack sees it.
 *
 * `any` on both parameters is load-bearing and is the same concession `AnyToolDef` already
 * makes. core-tools' own definition types the handler `(args: any, deps: ToolDeps)`, and a
 * contract that typed `deps` as this view instead would not accept it: a function parameter is
 * checked contravariantly, and `PackToolDeps` is a *subset* of `ToolDeps`, not a supertype. The
 * alternative is `never`, which is assignable but uncallable. The pack always passes the deps
 * it was handed, which is the `ToolDeps` the handler expects.
 */
export interface CoreToolView {
  readonly name: string;
  handler: (args: any, deps: any) => Promise<any>;
}

/** The loaded packs, as a pack sees them. core-tools' `PackRegistry` satisfies it. */
export interface PackRegistryView {
  byName(name: string): Pack;
  documentKinds(): string[];
  recordKinds(): RecordKindSpec[];
  attachmentKinds(): AttachmentKindSpec[];
}

export interface WriteOutFileInput {
  /** Subdirectory of the client's out tree, e.g. `forms` or `roster`. */
  dir: string;
  name: string;
  ext: string;
  bytes: Uint8Array;
}

export interface WrittenFile {
  /** Content-addressed, and the only thing a caller may pass back to a release. */
  file_id: string;
  path: string;
  bytes: number;
}

export interface StagedRelease {
  effect_id: string;
  staged: boolean;
  file_id: string;
  filename: string;
  bytes: number;
}

/**
 * Kernel operations a pack's tools may call that are not themselves tools.
 *
 * Three things do not belong in an MCP catalogue: a write that takes raw bytes, a predicate,
 * and a sentinel string. A pack cannot import them either — `pnpm arch` forbids a pack any
 * workspace import but this package and `@harness/shared`. So the kernel hands them over on
 * `deps.kernel`, and core-tools' `domain/packs/kernel.ts` is the one implementation.
 */
export interface PackKernel {
  /** The sentinel a read puts in place of a restricted value. Never the value itself. */
  readonly MASKED: string;
  /**
   * Whether the kernel will always encrypt a field of this name, whatever a caller says. A
   * pack's `redact` uses it to mask the arguments a parked approval stores in plaintext jsonb.
   */
  isRestrictedName(name: string): boolean;
  /** Write bytes into this client's out tree under a content-addressed id. */
  writeOutFile(deps: PackToolDeps, input: WriteOutFileInput): Promise<WrittenFile>;
  /** Stage one generated file for delivery through the effects outbox. Sends nothing. */
  stageRelease(deps: PackToolDeps, args: { file_id: string; channel?: string }): Promise<StagedRelease>;
}

/**
 * What a pack's tool handler is given.
 *
 * This is a **structural view** of core-tools' `ToolDeps`: every member below is a member of
 * `ToolDeps` with the same name and a compatible type, so core hands its real dependency bag
 * straight through and no cast happens at the call site. It deliberately does not carry `db`,
 * `policy` or `encryptionKey` — a pack reads and writes through kernel tools, which is what
 * keeps client scoping, the confidence threshold, the verified-field rule and the encryption
 * decision in one place.
 */
export interface PackToolDeps {
  /** The client this process serves. Every kernel call is scoped by it. */
  readonly client: string;
  readonly caller: string;
  readonly now: () => Date;
  readonly storageDir: string;
  /** The directory holding this deployment's `templates.json` and its PDFs. */
  readonly formsDir: string;
  readonly packs: PackRegistryView;
  /**
   * Every kernel tool by its kernel name, filled before any pack replaced one.
   *
   * Not `deps.tools`: that is the *published* catalogue, and after a replacement it holds the
   * pack's own tool under the kernel's name — so a wrapper that looked itself up there would
   * call itself until the stack ran out.
   */
  readonly kernelTools: ReadonlyMap<string, CoreToolView>;
  readonly kernel: PackKernel;
}

/**
 * The result shapes of the kernel tools a wrapper is likely to call. `CoreToolView.handler`
 * returns `any`, so a wrapper casts to one of these; core-tools' repositories are annotated
 * with the same interfaces, so a drift between the two is a compile error in core-tools rather
 * than a runtime surprise in a pack.
 */
export interface RecordsUpsertResult {
  record_id: string;
  fields_pending: number;
  fields_extracted: number;
  attachments: number;
}

export interface RecordFieldView {
  name: string;
  /** `PackKernel.MASKED` when the field is restricted. Never the plaintext. */
  value: string | null;
  restricted: boolean;
  confidence: number | null;
  status: string;
  source_page: number | null;
}

export interface RecordAttachmentView {
  id: string;
  kind: string;
  issuer: string | null;
  /** `PackKernel.MASKED` when a number is on file, null when none is. Never the number. */
  number: string | null;
  state: string | null;
  issued_at: string | null;
  expires_at: string | null;
  properties: Record<string, string>;
}

export interface RecordsGetResult {
  record: { id: string; kind: string; name: string; external_id: string | null; status: string };
  fields: RecordFieldView[];
  attachments: RecordAttachmentView[];
}

export interface RecordsSearchResult {
  records: { record_id: string; kind: string; name: string; external_id: string | null }[];
}

export interface RecordsListPendingResult {
  fields: { name: string; confidence: number | null; source_page: number | null }[];
}

export interface DeadlinesComputeResult {
  deadlines: { attachment_id: string; kind: string; due_at: string }[];
}

export interface DeadlineItem {
  record_id: string;
  record_name: string;
  attachment_id: string;
  attachment_kind: string;
  kind: string;
  due_at: string;
  days_left: number;
  overdue: boolean;
  bucket: string;
}

export interface DeadlinesUpcomingResult {
  items: DeadlineItem[];
  digest_key: string;
}

export interface DocumentRecordView {
  id: string;
  record_id: string | null;
  kind: string | null;
  storage_path: string;
  sha256: string;
  pages: number | null;
  ocr_used: boolean;
  has_text: boolean;
  ingested_at: string;
}

export interface DocumentsIngestResult {
  document_id: string;
  sha256: string;
  pages: number;
  storage_path: string;
  already_ingested: boolean;
}

export interface DocumentsClassifyResult {
  document_id: string;
  document_kind: string;
  model_kind: string;
  confidence: number;
}

export interface DocumentsExtractResult {
  document_id: string;
  record_id: string;
  document_kind: string;
  ocr_used: boolean;
  pages: number;
  fields_pending: number;
  fields_extracted: number;
  attachments: number;
  restricted_fields: string[];
}
