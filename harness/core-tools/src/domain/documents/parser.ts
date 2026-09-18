import * as z from 'zod/v4';
import { ToolError } from '@harness/shared';
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
    async extract(relPath, range) {
      const abs = await resolveStoragePath(storageDir, relPath);
      // No `text`: building it here is a second complete copy of the document beside the pages
      // that were just returned, and nothing in this package reads it. A caller that wants one
      // string calls `joinPages` on the pages it kept.
      return extractDocumentText(abs, { range });
    },
  };
}

/** Long, because a hundred-page scan is a hundred `pdftoppm | tesseract` passes on the other side. */
export const REMOTE_PARSE_TIMEOUT_MS = 600_000;

/** The worker's answer, checked rather than trusted: it is another process. */
const RemoteReply = z.object({
  pages: z.array(z.object({ num: z.number().int().min(1), text: z.string() })),
  text: z.string(),
  ocrUsed: z.boolean(),
});

/**
 * Parsing in the files worker. The containment check runs here, before the path is sent — the
 * worker checks again, but this process does not rely on it (invariant 5). A refusal comes back
 * as a `ToolError` carrying the worker's message, which names a basename at most; a transport
 * failure and a malformed answer are `ToolError`s of their own, so nothing but a `ToolError`
 * ever reaches the agent from here.
 */
export function remoteParser(baseUrl: string, storageDir: string, timeoutMs = REMOTE_PARSE_TIMEOUT_MS): DocumentParser {
  const origin = baseUrl.replace(/\/+$/, '');
  return {
    async extract(relPath) {
      await resolveStoragePath(storageDir, relPath);
      let response: Response;
      try {
        response = await fetch(`${origin}/extract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: relPath }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new ToolError('document parser is unreachable');
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        const detail = typeof body.error === 'string' ? body.error : 'no detail';
        throw new ToolError(`document parser refused (HTTP ${response.status}): ${detail}`);
      }
      const parsed = RemoteReply.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ToolError('document parser answered with an unexpected shape');
      // `text` is on the worker's wire shape and is checked above, then dropped: it is the pages
      // over again and no caller here reads it. The page range is not sent — the worker's route
      // takes a path and nothing else — so this parser returns the whole document and the range
      // stays the hint it is declared to be. The worker refuses anything over its own page
      // limit and the call is bounded by `REMOTE_PARSE_TIMEOUT_MS`, so ignoring the hint costs
      // time rather than correctness: every caller selects on `num`.
      return { pages: parsed.data.pages, ocrUsed: parsed.data.ocrUsed };
    },
  };
}
