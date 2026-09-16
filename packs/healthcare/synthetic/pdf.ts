import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import { runBounded } from '@harness/shared';
import type { PageSpec } from './types.js';

export async function writeTextPdf(target: string, pages: PageSpec[]): Promise<void> {
  const doc = await PDFDocument.create();
  const body: PDFFont = await doc.embedFont(StandardFonts.Helvetica);
  const bold: PDFFont = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const spec of pages) {
    const page = doc.addPage([612, 792]);
    page.drawText(spec.title, { x: 54, y: 720, size: 16, font: bold, color: rgb(0.1, 0.1, 0.25) });
    page.drawLine({ start: { x: 54, y: 712 }, end: { x: 558, y: 712 }, thickness: 1, color: rgb(0.6, 0.6, 0.7) });
    spec.lines.forEach((line, i) => {
      // 14pt Helvetica survives the 200 dpi rasterisation writeScanPdf does
      // and tesseract reads it cleanly; smaller type turns the eval's OCR
      // split into a measure of font size.
      page.drawText(line, { x: 54, y: 680 - i * 22, size: 14, font: body });
    });
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await doc.save());
}

/**
 * The scanned twin: render each page to a 200 dpi PNG with pdftoppm and put the
 * images back in a PDF. The result has no text layer at all, which is exactly
 * what a faxed or photographed credential file looks like and is what the
 * `scan` eval split measures.
 */
export async function writeScanPdf(sourcePdf: string, target: string, scratchDir: string): Promise<void> {
  const prefix = path.join(scratchDir, path.basename(target, '.pdf'));
  const outcome = await runBounded('pdftoppm', ['-r', '200', '-png', sourcePdf, prefix], { timeoutMs: 60_000 });
  if (!outcome.ok) {
    throw new Error(`pdftoppm ${outcome.reason} while rasterising ${path.basename(sourcePdf)}`);
  }
  const produced = (await readdir(scratchDir))
    .filter((f) => f.startsWith(`${path.basename(target, '.pdf')}-`) && f.endsWith('.png'))
    .sort();
  if (produced.length === 0) throw new Error(`pdftoppm produced no pages for ${sourcePdf}`);
  const doc = await PDFDocument.create();
  for (const file of produced) {
    const image = await doc.embedPng(await readFile(path.join(scratchDir, file)));
    const page = doc.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    await rm(path.join(scratchDir, file), { force: true });
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await doc.save());
}
