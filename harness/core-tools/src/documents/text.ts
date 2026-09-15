import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFParse } from 'pdf-parse';
import { ToolError } from '../registry.js';

const run = promisify(execFile);

export interface PageText {
  /** 1-based page number, matching what a reviewer sees and what `fields.source_page` stores. */
  num: number;
  text: string;
}

export interface ExtractedText {
  pages: PageText[];
  ocrUsed: boolean;
}

/** Below this many characters a page is treated as having no usable text layer. */
export const MIN_CHARS_PER_PAGE = 40;

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
 * inspected, only the exit.
 */
export async function assertBinary(name: 'tesseract' | 'pdftoppm'): Promise<void> {
  const args = name === 'tesseract' ? ['--version'] : ['-v'];
  try {
    await run(name, args);
  } catch {
    throw new ToolError(`${name} is not installed; OCR is unavailable. Install it: ${INSTALL_HINT[name]}`);
  }
}

async function tesseractOnImage(imagePath: string, lang: string): Promise<string> {
  try {
    const { stdout } = await run('tesseract', [imagePath, 'stdout', '-l', lang, '--psm', '6'], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    // A tesseract failure message can quote the file path but never its
    // contents, so naming the page is safe and the raw stderr is dropped.
    throw new ToolError(`OCR failed on ${path.basename(imagePath)}`);
  }
}

/**
 * Render each page to a PNG with pdftoppm, then OCR it with tesseract. Pages
 * are done one at a time and the PNG is discarded with the scratch directory,
 * so a hundred-page scan does not hold a hundred bitmaps in memory.
 */
export async function ocrPdf(
  absPath: string,
  pageCount: number,
  opts: { dpi?: number; lang?: string } = {},
): Promise<PageText[]> {
  await assertBinary('pdftoppm');
  await assertBinary('tesseract');
  const dpi = opts.dpi ?? 300;
  const lang = opts.lang ?? 'eng';
  const scratch = await mkdtemp(path.join(tmpdir(), 'harness-ocr-'));
  try {
    const pages: PageText[] = [];
    for (let num = 1; num <= pageCount; num += 1) {
      const prefix = path.join(scratch, `p${num}`);
      try {
        await run('pdftoppm', ['-r', String(dpi), '-png', '-f', String(num), '-l', String(num), absPath, prefix]);
      } catch {
        throw new ToolError(`could not rasterise page ${num} of the document`);
      }
      // pdftoppm appends a zero-padded page suffix whose width depends on the
      // page count, so the file is found by listing rather than guessed.
      const produced = (await readdir(scratch)).filter((f) => f.startsWith(`p${num}-`) && f.endsWith('.png')).sort();
      if (produced.length === 0) throw new ToolError(`page ${num} produced no image`);
      pages.push({ num, text: await tesseractOnImage(path.join(scratch, produced[0]), lang) });
    }
    return pages;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function ocrImage(absPath: string, opts: { lang?: string } = {}): Promise<PageText[]> {
  await assertBinary('tesseract');
  return [{ num: 1, text: await tesseractOnImage(absPath, opts.lang ?? 'eng') }];
}

/**
 * The pipeline's entry point: text layer when the PDF has one, OCR otherwise.
 * The decision is per document, not per page — a scan with one stamped page of
 * real text would otherwise mix extraction qualities within one record.
 */
export async function extractDocumentText(
  absPath: string,
  opts: { minCharsPerPage?: number; dpi?: number; lang?: string } = {},
): Promise<ExtractedText> {
  const bytes = new Uint8Array(await readFile(absPath));

  if (!isPdf(bytes)) {
    if (!IMAGE_EXTENSIONS.has(path.extname(absPath).toLowerCase())) {
      throw new ToolError(`unsupported document type ${path.extname(absPath) || '(none)'}; expected a PDF or an image`);
    }
    return { pages: await ocrImage(absPath, opts), ocrUsed: true };
  }

  const layer = await extractPdfText(bytes);
  const total = layer.reduce((sum, p) => sum + p.text.trim().length, 0);
  const threshold = (opts.minCharsPerPage ?? MIN_CHARS_PER_PAGE) * Math.max(layer.length, 1);
  if (total >= threshold) return { pages: layer, ocrUsed: false };

  return { pages: await ocrPdf(absPath, layer.length || (await pdfPageCount(bytes)), opts), ocrUsed: true };
}
