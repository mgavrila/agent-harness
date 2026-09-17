import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '@harness/shared';
import { writePdf } from './pdf.test-helpers.js';
import { localParser } from './parser.js';

let storageDir: string;

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'harness-parser-'));
  // Enough text per page to clear MIN_CHARS_PER_PAGE, so the text layer is read and no OCR runs.
  await writePdf(storageDir, 'incoming/two-pages.pdf', [
    'Page one. The quick brown fox jumps over the lazy dog, twice over, for good measure.',
    'Page two. Expiration Date: 2027-03-31 and a licence number A98765 printed in full.',
  ]);
});
afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('localParser', () => {
  it('reads a text-layer PDF under the storage root, page by page', async () => {
    const out = await localParser(storageDir).extract('incoming/two-pages.pdf');
    expect(out.pages.map((p) => p.num)).toEqual([1, 2]);
    expect(out.pages[1].text).toContain('A98765');
    expect(out.ocrUsed).toBe(false);
    expect(out.text).toBe(`${out.pages[0].text}\n\n${out.pages[1].text}`);
  });

  it('refuses a path outside the storage root before touching the filesystem', async () => {
    const parser = localParser(storageDir);
    await expect(parser.extract('../outside.pdf')).rejects.toThrow(ToolError);
    await expect(parser.extract('../outside.pdf')).rejects.toThrow(/outside HARNESS_STORAGE_DIR/);
    await expect(parser.extract('/etc/hostname')).rejects.toThrow(/outside HARNESS_STORAGE_DIR/);
  });
});
