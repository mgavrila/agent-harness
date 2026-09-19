import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import { ToolError, runBounded } from '@harness/shared';
import type { ExtractedText, PageRange, PageText } from './types.js';

/** Below this many characters a page is treated as having no usable text layer. */
export const MIN_CHARS_PER_PAGE = 40;

/**
 * The most pages this process will parse in one call.
 *
 * The files worker has enforced the same number since it was written, and this module did not,
 * so a deployment that ran the parser in-process — which is every bare-metal one, since
 * `parserFromEnv` picks `localParser` whenever `HARNESS_FILES_URL` is unset — had no ceiling at
 * all. Rasterising and reading is bounded per page and sequential, so with no ceiling the wall
 * clock for one call is the page count times those bounds. The two numbers are deliberately
 * equal: a document that Compose refuses must not be a document bare metal accepts.
 */
export const MAX_PARSE_PAGES = 500;

/** Bounds for the child processes this module shells out to. All overridable per call so a hung process cannot block the pipeline indefinitely, and so tests can force a timeout without waiting for the real default. */
const DEFAULT_ASSERT_TIMEOUT_MS = 10_000;
const DEFAULT_RASTERISE_TIMEOUT_MS = 120_000;
const DEFAULT_OCR_TIMEOUT_MS = 60_000;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp']);

/** True when the bytes begin with the PDF magic number. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
}

/**
 * Page count from the PDF catalogue. Images count as one page, which is what
 * the `documents.pages` column means: how many pages a reviewer would see.
 */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  if (!isPdf(bytes)) return 1;
  const parser = new PDFParse({ data: bytes });
  try {
    const info = await parser.getInfo();
    return info.total;
  } catch {
    throw new ToolError('document is not a readable PDF');
  } finally {
    await parser.destroy();
  }
}

export async function extractPdfText(bytes: Uint8Array): Promise<PageText[]> {
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return result.pages.map((p) => ({ num: p.num, text: p.text }));
  } catch {
    throw new ToolError('document is not a readable PDF');
  } finally {
    await parser.destroy();
  }
}

const INSTALL_HINT: Record<string, string> = {
  tesseract: 'brew install tesseract   (Debian: apt-get install -y tesseract-ocr)',
  pdftoppm: 'brew install poppler      (Debian: apt-get install -y poppler-utils)',
};

/**
 * Fail early and legibly when an OCR binary is missing, instead of surfacing a
 * bare ENOENT from deep inside a page loop. `pdftoppm -v` writes its banner to
 * stderr and exits 0; `tesseract --version` writes to stdout. Neither stream is
 * inspected, only the exit. Bounded by `timeoutMs` so a wedged binary cannot
 * hang the check itself.
 */
export async function assertBinary(
  name: 'tesseract' | 'pdftoppm',
  timeoutMs = DEFAULT_ASSERT_TIMEOUT_MS,
): Promise<void> {
  const args = name === 'tesseract' ? ['--version'] : ['-v'];
  const outcome = await runBounded(name, args, { timeoutMs });
  if (outcome.ok) return;
  if (outcome.reason === 'timeout') {
    throw new ToolError(`${name} did not respond within ${timeoutMs}ms while checking it is installed`);
  }
  throw new ToolError(`${name} is not installed; OCR is unavailable. Install it: ${INSTALL_HINT[name]}`);
}

/**
 * OCR one already-rendered image. `page` is only used to name the page in a
 * timeout or failure message; `imagePath` is a filesystem path (a caller
 * document or a scratch PNG derived from one), so only its basename — never
 * the full path, and never stdout/stderr, which could contain restricted
 * values read off the page — is ever quoted back.
 */
async function tesseractOnImage(imagePath: string, lang: string, timeoutMs: number, page: number): Promise<string> {
  const outcome = await runBounded('tesseract', [imagePath, 'stdout', '-l', lang, '--psm', '6'], {
    maxBuffer: 32 * 1024 * 1024,
    timeoutMs,
  });
  if (outcome.ok) return outcome.stdout;
  if (outcome.reason === 'timeout') throw new ToolError(`ocr timed out on page ${page} of ${path.basename(imagePath)}`);
  throw new ToolError(`OCR failed on ${path.basename(imagePath)}`);
}

/**
 * Render each page to a PNG with pdftoppm, then OCR it with tesseract. Pages
 * are done one at a time and the PNG is discarded with the scratch directory,
 * so a hundred-page scan does not hold a hundred bitmaps in memory.
 */
export async function ocrPdf(
  absPath: string,
  pageCount: number,
  opts: { dpi?: number; lang?: string; rasteriseTimeoutMs?: number; timeoutMs?: number; range?: PageRange } = {},
): Promise<PageText[]> {
  await assertBinary('pdftoppm');
  await assertBinary('tesseract');
  // The range is why this loop is worth ranging at all: each turn of it is one `pdftoppm` and
  // one `tesseract`, so reading page 3 of a long scan does three minutes of work instead of
  // three minutes times the page count.
  const first = Math.max(1, opts.range?.from ?? 1);
  const last = Math.min(pageCount, opts.range?.to ?? pageCount);
  const dpi = opts.dpi ?? 300;
  const lang = opts.lang ?? 'eng';
  const rasteriseTimeoutMs = opts.rasteriseTimeoutMs ?? DEFAULT_RASTERISE_TIMEOUT_MS;
  const ocrTimeoutMs = opts.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
  const scratch = await mkdtemp(path.join(tmpdir(), 'harness-ocr-'));
  try {
    const pages: PageText[] = [];
    for (let num = first; num <= last; num += 1) {
      const prefix = path.join(scratch, `p${num}`);
      const outcome = await runBounded(
        'pdftoppm',
        ['-r', String(dpi), '-png', '-f', String(num), '-l', String(num), absPath, prefix],
        { timeoutMs: rasteriseTimeoutMs },
      );
      if (!outcome.ok) {
        if (outcome.reason === 'timeout') throw new ToolError(`rasterise timed out for ${path.basename(absPath)}`);
        throw new ToolError(`could not rasterise page ${num} of the document`);
      }
      // pdftoppm appends a zero-padded page suffix whose width depends on the
      // page count, so the file is found by listing rather than guessed.
      const produced = (await readdir(scratch)).filter((f) => f.startsWith(`p${num}-`) && f.endsWith('.png')).sort();
      if (produced.length === 0) throw new ToolError(`page ${num} produced no image`);
      pages.push({ num, text: await tesseractOnImage(path.join(scratch, produced[0]), lang, ocrTimeoutMs, num) });
    }
    return pages;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function ocrImage(absPath: string, opts: { lang?: string; timeoutMs?: number } = {}): Promise<PageText[]> {
  await assertBinary('tesseract');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OCR_TIMEOUT_MS;
  return [{ num: 1, text: await tesseractOnImage(absPath, opts.lang ?? 'eng', timeoutMs, 1) }];
}

/**
 * The pipeline's entry point: text layer when the PDF has one, OCR otherwise.
 * The decision is per document, not per page — a scan with one stamped page of
 * real text would otherwise mix extraction qualities within one record.
 */
export async function extractDocumentText(
  absPath: string,
  opts: {
    minCharsPerPage?: number;
    dpi?: number;
    lang?: string;
    rasteriseTimeoutMs?: number;
    timeoutMs?: number;
    /** Parse only these pages. What it saves is the OCR path, which works one page at a time. */
    range?: PageRange;
  } = {},
): Promise<ExtractedText> {
  const bytes = new Uint8Array(await readFile(absPath));

  if (!isPdf(bytes)) {
    if (!IMAGE_EXTENSIONS.has(path.extname(absPath).toLowerCase())) {
      throw new ToolError(`unsupported document type ${path.extname(absPath) || '(none)'}; expected a PDF or an image`);
    }
    return { pages: await ocrImage(absPath, opts), ocrUsed: true };
  }

  // The text layer comes out of one pass over the file whatever range was asked for, so it is
  // read whole and sliced afterwards. The decision below is per document on purpose — a range
  // that saw only its own pages could call a document scanned when the rest of it is typed.
  //
  // `pdfPageCount` is deliberately not asked first: the PDF reader takes the byte buffer over and
  // leaves it detached, so a count taken before this line makes the parse below fail on its own
  // document.
  const layer = await extractPdfText(bytes);
  const count = layer.length || (await pdfPageCount(bytes));
  if (count > MAX_PARSE_PAGES) {
    throw new ToolError(`${path.basename(absPath)} has ${count} pages, over the ${MAX_PARSE_PAGES}-page limit`);
  }

  const total = layer.reduce((sum, p) => sum + p.text.trim().length, 0);
  const threshold = (opts.minCharsPerPage ?? MIN_CHARS_PER_PAGE) * Math.max(layer.length, 1);
  if (total >= threshold) return { pages: inRange(layer, opts.range), ocrUsed: false };

  return { pages: await ocrPdf(absPath, count, opts), ocrUsed: true };
}

/** The pages of `range`, or all of them when none was asked for. */
function inRange(pages: PageText[], range: PageRange | undefined): PageText[] {
  return range === undefined ? pages : pages.filter((p) => p.num >= range.from && p.num <= range.to);
}
