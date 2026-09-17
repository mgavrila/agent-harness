import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * Write a PDF with one page per string, under `root`.
 *
 * One copy, shared by the kernel's document suite and the healthcare one, because the fixture is
 * a property of what `extractDocumentText` reads rather than of either suite: a real text layer
 * in a real PDF, so the pipeline takes the text-layer path instead of falling back to OCR. A
 * caller that wants the OCR path gives a page too short to clear `MIN_CHARS_PER_PAGE` — see
 * `domain/documents/text.ts`.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and the "no test
 * imported by production" architecture rule matches on the name.
 */
export async function writePdf(root: string, relativePath: string, pageTexts: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pageTexts) {
    doc.addPage([612, 792]).drawText(text, { x: 50, y: 700, size: 12, font });
  }
  const abs = path.join(root, relativePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, await doc.save());
}
