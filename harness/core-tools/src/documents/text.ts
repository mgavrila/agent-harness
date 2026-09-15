import { PDFParse } from 'pdf-parse';
import { ToolError } from '../registry.js';

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
