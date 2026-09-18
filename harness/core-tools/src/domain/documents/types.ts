/**
 * The document domain's vocabulary. Interfaces only, so that `manifest.ts`, `schema.ts`,
 * `prompts.ts`, `parse.ts` and `text.ts` can all name the same shapes without importing each
 * other — the zod schemas that validate a pack's manifest live in `manifest.ts`, because a
 * schema is a value and this file holds no values but the one frozen list.
 *
 * `PageText` is structurally identical to `RedactablePage` in shared/redaction/text.ts, which
 * is deliberate and is why redaction can run over a page without the shared layer importing a
 * domain.
 *
 * The document kinds themselves are not here any more: the loaded pack declares them and
 * `deps.packs.documentKinds()` is what answers for them, so a kind is a plain `string` to
 * everything below — which is what the `documents.kind` text column always stored anyway.
 */

export interface PageText {
  /** 1-based page number, matching what a reviewer sees and what `fields.source_page` stores. */
  num: number;
  text: string;
}

export interface ExtractedText {
  pages: PageText[];
  ocrUsed: boolean;
}

/**
 * What `documents_read` answers with. Declared here rather than in the pack contract, unlike the
 * ingest, classify and extract results: no pack wraps this tool, because a file's own text is
 * the kernel's business and belongs to a client whether or not one is loaded.
 *
 * `from` and `to` are the range actually read, which is not always the range asked for: a
 * caller that named no end gets the last page, and one that named a page past the end is
 * refused rather than quietly clamped.
 */
export interface DocumentsReadResult {
  id: string;
  /** How many pages of text the document has, whatever range was read. */
  pages: number;
  from: number;
  to: number;
  /** True when the text was cut at `max_chars`; ask for the next range to see the rest. */
  truncated: boolean;
  text: string;
}

export interface ExtractedField {
  name: string;
  value: string;
  confidence: number;
  source_page?: number;
}

export interface ExtractedAttachment {
  kind: string;
  issuer?: string;
  state?: string;
  issued_at?: string;
  expires_at?: string;
  confidence: number;
  source_page?: number;
}

export interface ParsedExtraction {
  documentKind: string;
  fields: ExtractedField[];
  attachments: ExtractedAttachment[];
}

/**
 * What a parser answers with, whichever process did the parsing: the pages, the same pages
 * joined by a blank line for a caller that wants one string, and whether OCR was needed. The
 * same three fields the files worker sends over HTTP, declared here again rather than imported
 * because core-tools does not depend on the worker.
 */
export interface ParsedDocument extends ExtractedText {
  text: string;
}

/**
 * The seam between the pipeline and whatever turns document bytes into text.
 *
 * Two implementations: `localParser` runs the subprocesses in this process, for tests and a
 * bare-metal run; `remoteParser` sends the path to the files worker, a process with no key, no
 * database and no outbound network, which is where an untrusted PDF belongs (spec decision 11).
 * `relPath` is relative to the storage root and is refused, with a `ToolError`, when it resolves
 * outside it — by both implementations, before anything is read or sent.
 */
export interface DocumentParser {
  extract(relPath: string): Promise<ParsedDocument>;
}
