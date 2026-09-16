export type {
  CoreToolView,
  PackKernel,
  PackRegistryView,
  PackToolDeps,
  StagedRelease,
  WriteOutFileInput,
  WrittenFile,
} from './types.js';

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
