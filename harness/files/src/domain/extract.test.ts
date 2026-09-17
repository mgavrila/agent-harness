import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ParseError } from './errors.js';
import { extractDocument, missingBinaries } from './extract.js';

const run = promisify(execFile);
let dir: string;
let textLayerPdf: string;
let scanPdf: string;

async function makeTextPdf(target: string, pages: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const body of pages) {
    const page = doc.addPage([612, 792]);
    body.split('\n').forEach((line, i) => page.drawText(line, { x: 54, y: 700 - i * 20, size: 14, font }));
  }
  await writeFile(target, await doc.save());
}

/** The same document as an image-only PDF: rasterise with pdftoppm, rebuild from the PNGs. */
async function rasterise(sourcePdf: string, target: string): Promise<void> {
  const prefix = path.join(dir, 'raster');
  await run('pdftoppm', ['-r', '200', '-png', sourcePdf, prefix]);
  const doc = await PDFDocument.create();
  for (let n = 1; ; n += 1) {
    let bytes: Buffer;
    try {
      bytes = await readFile(`${prefix}-${n}.png`);
    } catch {
      break;
    }
    const image = await doc.embedPng(bytes);
    doc.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  await writeFile(target, await doc.save());
}

// Probed once, before any `describe` is registered: `it.skipIf`'s condition is evaluated at
// collection time, so it cannot be computed inside `beforeAll`.
const missing = await missingBinaries();
if (missing.length > 0) {
  console.warn(
    `${missing.join(', ')} not installed; run \`brew install tesseract poppler\` — skipping the cases that need them`,
  );
}
const popplerAvailable = !missing.includes('pdfinfo') && !missing.includes('pdftotext');
const ocrAvailable = missing.length === 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-files-'));
  textLayerPdf = path.join(dir, 'license.pdf');
  scanPdf = path.join(dir, 'license-scan.pdf');
  await makeTextPdf(textLayerPdf, [
    'STATE OF CALIFORNIA\nPHYSICIAN AND SURGEON LICENSE\nLicense Number A98765\nExpires 2027-03-31',
    'Issued to Ada Lovelace MD, second page of the same document, with enough text.',
  ]);
  if (ocrAvailable) await rasterise(textLayerPdf, scanPdf);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extractDocument', () => {
  it.skipIf(!popplerAvailable)('reads the text layer page by page and reports no OCR', async () => {
    const out = await extractDocument(textLayerPdf);
    expect(out.pages.map((p) => p.num)).toEqual([1, 2]);
    expect(out.pages[0].text).toContain('A98765');
    expect(out.pages[1].text).toContain('Ada Lovelace');
    expect(out.ocrUsed).toBe(false);
    expect(out.text).toBe(`${out.pages[0].text}\n\n${out.pages[1].text}`);
  });

  it.skipIf(!ocrAvailable)(
    'falls back to OCR for an image-only PDF',
    async () => {
      const out = await extractDocument(scanPdf);
      expect(out.ocrUsed).toBe(true);
      expect(out.pages.map((p) => p.num)).toEqual([1, 2]);
      expect(out.pages[0].text.toUpperCase()).toContain('CALIFORNIA');
    },
    120_000,
  );

  it.skipIf(!ocrAvailable)(
    'reads an image with tesseract as one page',
    async () => {
      const out = await extractDocument(path.join(dir, 'raster-1.png'));
      expect(out.ocrUsed).toBe(true);
      expect(out.pages).toHaveLength(1);
      expect(out.pages[0].text).toMatch(/A98765/);
    },
    60_000,
  );

  it('refuses a file that is neither a PDF nor an image with 415', async () => {
    const bin = path.join(dir, 'notes.bin');
    await writeFile(bin, Buffer.from([0, 1, 2, 3]));
    const err = await extractDocument(bin).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).status).toBe(415);
  });

  it('reports a missing file as 404 without naming its directory', async () => {
    const err = await extractDocument(path.join(dir, 'missing.pdf')).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).status).toBe(404);
    expect((err as Error).message).not.toContain(dir);
  });

  it.skipIf(!ocrAvailable)(
    'reports a timeout as 422 and never quotes the path',
    async () => {
      const err = await extractDocument(scanPdf, { ocrTimeoutMs: 1 }).catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(ParseError);
      expect((err as ParseError).status).toBe(422);
      expect((err as Error).message).toMatch(/timed out/);
      expect((err as Error).message).not.toContain(dir);
    },
    30_000,
  );
});
