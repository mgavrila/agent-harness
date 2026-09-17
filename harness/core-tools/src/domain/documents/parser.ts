import { resolveStoragePath } from '../storage/file-store.js';
import { extractDocumentText } from './text.js';
import type { DocumentParser, PageText } from './types.js';

/** The pages as one string, a blank line between them. What `ParsedDocument.text` carries. */
export function joinPages(pages: PageText[]): string {
  return pages.map((p) => p.text).join('\n\n');
}

/**
 * Parsing in this process: today's `extractDocumentText` behind the seam. The containment check
 * is the same one `documents_ingest` applies, so a path the pipeline was told about is checked
 * twice — once when the row was written, once when its bytes are read.
 */
export function localParser(storageDir: string): DocumentParser {
  return {
    async extract(relPath) {
      const abs = await resolveStoragePath(storageDir, relPath);
      const { pages, ocrUsed } = await extractDocumentText(abs);
      return { pages, text: joinPages(pages), ocrUsed };
    },
  };
}
