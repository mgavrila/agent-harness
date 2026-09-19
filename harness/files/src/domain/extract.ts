import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBounded } from '@harness/shared';
import { ParseError } from './errors.js';
import type { PageText, ParsedDocument } from './types.js';

/** Below this many characters per page, on average, a PDF is treated as having no usable text layer. */
const MIN_CHARS_PER_PAGE = 40;

/**
 * A document with more pages than this is refused before `pdftotext` or `pdftoppm` ever run on
 * it: `pdfinfo`'s page count comes from an untrusted file, and looping over it unbounded would
 * let one upload buy an arbitrarily long render-and-OCR run.
 */
export const MAX_PAGES = 500;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp']);

const BINARIES = ['pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract'] as const;
/** `pdftoppm -v` and friends write a banner and exit 0; `tesseract --version` too. Only the exit is read. */
const VERSION_FLAG: Record<(typeof BINARIES)[number], string> = {
  pdfinfo: '-v',
  pdftotext: '-v',
  pdftoppm: '-v',
  tesseract: '--version',
};

export interface ExtractOptions {
  dpi?: number;
  lang?: string;
  /** Bound on `pdfinfo` and `pdftotext`. */
  textTimeoutMs?: number;
  /** Bound on one `pdftoppm` page render. */
  rasteriseTimeoutMs?: number;
  /** Bound on one `tesseract` pass. */
  ocrTimeoutMs?: number;
}

const DEFAULTS: Required<ExtractOptions> = {
  dpi: 300,
  lang: 'eng',
  textTimeoutMs: 60_000,
  rasteriseTimeoutMs: 120_000,
  ocrTimeoutMs: 60_000,
};

/** The binaries this worker cannot do without; empty when every one answers its version flag. */
export async function missingBinaries(timeoutMs = 10_000): Promise<string[]> {
  const missing: string[] = [];
  for (const name of BINARIES) {
    const outcome = await runBounded(name, [VERSION_FLAG[name]], { timeoutMs });
    if (!outcome.ok) missing.push(name);
  }
  return missing;
}

/** The pages as one string, a blank line between them. */
function joinPages(pages: PageText[]): string {
  return pages.map((p) => p.text).join('\n\n');
}

/** True when the file begins with the PDF magic number. A missing file is a 404, not a 500. */
async function isPdf(absPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(absPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ParseError(404, 'no such document');
    throw err;
  }
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(5), 0, 5, 0);
    return bytesRead === 5 && buffer.toString('latin1') === '%PDF-';
  } catch (err) {
    // A path that resolved to a directory reads as EISDIR, not ENOENT: the containment check
    // only confirms the path exists and is inside the root, not that it names a regular file.
    if ((err as NodeJS.ErrnoException).code === 'EISDIR') throw new ParseError(404, 'no such document');
    throw err;
  } finally {
    await handle.close();
  }
}

function unreadable(absPath: string, tool: string, reason: 'timeout' | 'failed'): ParseError {
  const name = path.basename(absPath);
  return new ParseError(422, reason === 'timeout' ? `${tool} timed out on ${name}` : `${name} is not a readable PDF`);
}

/** Page count from `pdfinfo`, which prints one `Pages: N` line. */
async function pageCount(absPath: string, timeoutMs: number): Promise<number> {
  const outcome = await runBounded('pdfinfo', [absPath], { timeoutMs });
  if (!outcome.ok) throw unreadable(absPath, 'pdfinfo', outcome.reason);
  const match = /^Pages:\s+(\d+)/m.exec(outcome.stdout);
  if (!match) throw unreadable(absPath, 'pdfinfo', 'failed');
  return Number(match[1]);
}

/**
 * The text layer, one entry per page. `pdftotext` writes a form feed between pages and one after
 * the last, so splitting on it gives the pages in order plus one empty tail that is dropped by
 * counting to `pages`.
 */
async function textLayer(absPath: string, pages: number, timeoutMs: number): Promise<PageText[]> {
  const outcome = await runBounded('pdftotext', ['-layout', absPath, '-'], { timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (!outcome.ok) throw unreadable(absPath, 'pdftotext', outcome.reason);
  const chunks = outcome.stdout.split('\f');
  return Array.from({ length: pages }, (_, i) => ({ num: i + 1, text: chunks[i] ?? '' }));
}

/**
 * OCR one already-rendered image. Only the image's basename is ever quoted back — never
 * stdout or stderr, which could contain restricted values read off the page.
 */
async function ocrImage(imagePath: string, page: number, opts: Required<ExtractOptions>): Promise<string> {
  const outcome = await runBounded('tesseract', [imagePath, 'stdout', '-l', opts.lang, '--psm', '6'], {
    maxBuffer: 32 * 1024 * 1024,
    timeoutMs: opts.ocrTimeoutMs,
  });
  if (outcome.ok) return outcome.stdout;
  const name = path.basename(imagePath);
  throw new ParseError(
    422,
    outcome.reason === 'timeout' ? `ocr timed out on page ${page} of ${name}` : `OCR failed on ${name}`,
  );
}

/**
 * Render each page to a PNG with `pdftoppm`, then OCR it. One page at a time, in a scratch
 * directory that is removed afterwards, so a hundred-page scan never holds a hundred bitmaps.
 */
async function ocrPdf(absPath: string, pages: number, opts: Required<ExtractOptions>): Promise<PageText[]> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'harness-files-ocr-'));
  try {
    const out: PageText[] = [];
    for (let num = 1; num <= pages; num += 1) {
      const prefix = path.join(scratch, `p${num}`);
      const outcome = await runBounded(
        'pdftoppm',
        ['-r', String(opts.dpi), '-png', '-f', String(num), '-l', String(num), absPath, prefix],
        { timeoutMs: opts.rasteriseTimeoutMs },
      );
      if (!outcome.ok) {
        if (outcome.reason === 'timeout') throw new ParseError(422, `rasterise timed out on ${path.basename(absPath)}`);
        throw new ParseError(422, `could not rasterise page ${num} of the document`);
      }
      // pdftoppm zero-pads the page suffix to the page count's width, so the file is found by
      // listing rather than guessed.
      const produced = (await readdir(scratch)).filter((f) => f.startsWith(`p${num}-`) && f.endsWith('.png')).sort();
      if (produced.length === 0) throw new ParseError(422, `page ${num} produced no image`);
      out.push({ num, text: await ocrImage(path.join(scratch, produced[0]), num, opts) });
    }
    return out;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The worker's whole job: text layer when the PDF has one, OCR otherwise, per document rather
 * than per page — a scan with one stamped page of real text would otherwise mix qualities within
 * one record. `absPath` has already been checked against the storage root by the caller.
 */
export async function extractDocument(absPath: string, options: ExtractOptions = {}): Promise<ParsedDocument> {
  const opts = { ...DEFAULTS, ...options };
  if (!(await isPdf(absPath))) {
    const ext = path.extname(absPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new ParseError(415, `unsupported document type ${ext || '(none)'}; expected a PDF or an image`);
    }
    const pages = [{ num: 1, text: await ocrImage(absPath, 1, opts) }];
    return { pages, text: joinPages(pages), ocrUsed: true };
  }
  const count = await pageCount(absPath, opts.textTimeoutMs);
  if (count > MAX_PAGES) {
    throw new ParseError(422, `${path.basename(absPath)} has ${count} pages, over the ${MAX_PAGES}-page limit`);
  }
  const layer = await textLayer(absPath, count, opts.textTimeoutMs);
  const total = layer.reduce((sum, p) => sum + p.text.trim().length, 0);
  if (total >= MIN_CHARS_PER_PAGE * Math.max(count, 1)) return { pages: layer, text: joinPages(layer), ocrUsed: false };
  const pages = await ocrPdf(absPath, count, opts);
  return { pages, text: joinPages(pages), ocrUsed: true };
}
