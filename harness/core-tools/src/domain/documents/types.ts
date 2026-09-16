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
