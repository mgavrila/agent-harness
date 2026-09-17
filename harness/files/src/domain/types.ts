/**
 * The worker's answer, which is also the wire shape core-tools' `remoteParser` validates: the
 * pages, the same pages joined by a blank line for a caller that wants one string, and whether
 * OCR was needed. Declared here and again in core-tools' `domain/documents/types.ts` — three
 * fields, structurally identical — because this package imports `@harness/shared` only and
 * core-tools does not import this package.
 */
export interface PageText {
  /** 1-based, matching what a reviewer sees. */
  num: number;
  text: string;
}

export interface ParsedDocument {
  pages: PageText[];
  text: string;
  ocrUsed: boolean;
}
