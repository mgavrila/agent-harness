import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ToolError } from '../registry.js';
import { assertBinary, extractDocumentText, extractPdfText, isPdf, ocrPdf, pdfPageCount } from './text.js';

const run = promisify(execFile);
let dir: string;
let textLayerPdf: string;
let scanPdf: string;

/** A PDF with a real text layer. */
async function makeTextPdf(target: string, pages: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const body of pages) {
    const page = doc.addPage([612, 792]);
    body.split('\n').forEach((line, i) => page.drawText(line, { x: 54, y: 700 - i * 20, size: 14, font }));
  }
  await writeFile(target, await doc.save());
}

/**
 * The same document as an image-only PDF: render each page to PNG with
 * pdftoppm, then rebuild a PDF from the images. This is exactly how the
 * synthetic generator in Task 9 makes its scans, so the OCR path here is tested
 * against the same shape of file the evals use.
 */
async function rasterise(sourcePdf: string, target: string): Promise<void> {
  const prefix = path.join(dir, 'raster');
  await run('pdftoppm', ['-r', '200', '-png', sourcePdf, prefix]);
  const doc = await PDFDocument.create();
  for (let n = 1; ; n += 1) {
    const png = `${prefix}-${n}.png`;
    let bytes: Buffer;
    try {
      bytes = await readFile(png);
    } catch {
      break;
    }
    const image = await doc.embedPng(bytes);
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  await writeFile(target, await doc.save());
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-text-'));
  textLayerPdf = path.join(dir, 'license.pdf');
  scanPdf = path.join(dir, 'license-scan.pdf');
  await makeTextPdf(textLayerPdf, [
    'STATE OF CALIFORNIA\nPHYSICIAN AND SURGEON LICENSE\nLicense Number A98765\nExpires 2027-03-31',
    'Issued to Ada Lovelace MD',
  ]);
  await rasterise(textLayerPdf, scanPdf);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('isPdf and pdfPageCount', () => {
  it('detects a PDF and counts its pages', async () => {
    const bytes = new Uint8Array(await readFile(textLayerPdf));
    expect(isPdf(bytes)).toBe(true);
    await expect(pdfPageCount(bytes)).resolves.toBe(2);
  });

  it('treats a non-PDF as a single page', async () => {
    expect(isPdf(new TextEncoder().encode('hello'))).toBe(false);
    await expect(pdfPageCount(new TextEncoder().encode('hello'))).resolves.toBe(1);
  });
});

describe('extractPdfText', () => {
  it('returns one entry per page, 1-based, with the page text', async () => {
    const bytes = new Uint8Array(await readFile(textLayerPdf));
    const pages = await extractPdfText(bytes);
    expect(pages.map((p) => p.num)).toEqual([1, 2]);
    expect(pages[0].text).toContain('License Number A98765');
    expect(pages[1].text).toContain('Ada Lovelace');
  });

  it('returns empty text for an image-only PDF', async () => {
    const bytes = new Uint8Array(await readFile(scanPdf));
    const pages = await extractPdfText(bytes);
    expect(pages.every((p) => p.text.trim().length < 10)).toBe(true);
  });
});

describe('assertBinary', () => {
  it('passes for installed binaries', async () => {
    await expect(assertBinary('tesseract')).resolves.toBeUndefined();
    await expect(assertBinary('pdftoppm')).resolves.toBeUndefined();
  });
});

describe('ocrPdf', () => {
  it('reads text off a rasterised scan', async () => {
    const pages = await ocrPdf(scanPdf, 2);
    expect(pages.map((p) => p.num)).toEqual([1, 2]);
    expect(pages[0].text.toUpperCase()).toContain('CALIFORNIA');
    expect(pages[0].text).toMatch(/A98765/);
  }, 120_000);
});

describe('extractDocumentText', () => {
  it('uses the text layer when there is one', async () => {
    const out = await extractDocumentText(textLayerPdf);
    expect(out.ocrUsed).toBe(false);
    expect(out.pages[0].text).toContain('A98765');
  });

  it('falls back to OCR for an image-only PDF', async () => {
    const out = await extractDocumentText(scanPdf);
    expect(out.ocrUsed).toBe(true);
    expect(out.pages[0].text.toUpperCase()).toContain('LICENSE');
  }, 120_000);

  it('throws a ToolError for a file that is neither a PDF nor an image', async () => {
    const txt = path.join(dir, 'notes.bin');
    await writeFile(txt, Buffer.from([0, 1, 2, 3]));
    await expect(extractDocumentText(txt)).rejects.toThrow(ToolError);
  });
});
