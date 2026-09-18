/**
 * The chunker (spec 5.7): a splitter equivalent to a well-known recursive text splitter, at 1,000
 * characters with 200 of overlap, written here rather than imported.
 *
 * Written rather than pulled from a framework, because the kernel-vocabulary test forbids naming
 * one in this package — the kernel holds a runtime *contract*, not a framework, and only one
 * runtime plug-in directory outside the kernel may name one. What the splitter actually does is
 * thirty lines, so it is thirty lines.
 *
 * The method: try to break on the largest separator that appears — a blank line, then a line, then
 * a sentence, then a word, then any character at all — and recurse into any piece still too long.
 * The pieces are then greedily packed into chunks, and each chunk after the first begins with the
 * tail of the one before it, cut at the first space inside that tail so a chunk never starts
 * mid-word. That cut is why a chunk's real bound is `size + overlap` and not `size`.
 */
export const CHUNK_SIZE = 1_000;
export const CHUNK_OVERLAP = 200;

/**
 * Largest unit first. The empty string is the last resort and means "split by character": without
 * it a single 3,000-character word would come back as one chunk, and a chunk larger than the
 * embedder's own limit is a failure in the middle of a sync rather than here.
 */
const SEPARATORS = ['\n\n', '\n', '. ', ' ', ''] as const;

/** Split, keeping the separator on the end of each piece so rejoining is lossless. */
function splitKeeping(text: string, separator: string): string[] {
  if (separator === '') return [...text];
  const parts = text.split(separator);
  return parts.map((part, i) => (i === parts.length - 1 ? part : part + separator));
}

/** Break `text` down until every piece is at most `size`, using the first separator that helps. */
function pieces(text: string, size: number, separators: readonly string[]): string[] {
  if (text === '') return [];
  if (text.length <= size) return [text];
  const [head, ...rest] = separators;
  if (head === undefined) return [text];
  const parts = splitKeeping(text, head);
  // A separator that did not appear splits nothing; try the next one on the whole text rather
  // than recursing on a single piece that is the text again, which would not terminate.
  if (parts.length <= 1) return pieces(text, size, rest);
  return parts.flatMap((part) => pieces(part, size, rest));
}

/** The last `overlap` characters of `text`, from the first space inside them, so a word stays whole. */
function tailOf(text: string, overlap: number): string {
  if (overlap <= 0) return '';
  const cut = text.slice(Math.max(0, text.length - overlap));
  const space = cut.indexOf(' ');
  return space === -1 ? cut : cut.slice(space + 1);
}

export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): string[] {
  const size = opts.size ?? CHUNK_SIZE;
  const overlap = opts.overlap ?? CHUNK_OVERLAP;
  const parts = pieces(text.trim(), size, SEPARATORS);
  const chunks: string[] = [];
  let current = '';
  for (const part of parts) {
    if (current !== '' && current.length + part.length > size) {
      chunks.push(current.trim());
      current = tailOf(current, overlap) + part;
    } else {
      current += part;
    }
  }
  if (current.trim() !== '') chunks.push(current.trim());
  return chunks;
}
