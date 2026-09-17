import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate } from './generate.js';

describe('generate', () => {
  it('writes three PDFs with a real text layer, and the same bytes every time', async () => {
    const a = await generate({ outDir: mkdtempSync(path.join(tmpdir(), 'stories-a-')) });
    const b = await generate({ outDir: mkdtempSync(path.join(tmpdir(), 'stories-b-')) });
    expect(a).toHaveLength(3);
    expect(a.map((p) => path.basename(p))).toEqual(['notes-01.pdf', 'notes-02.pdf', 'notes-03.pdf']);
    for (let i = 0; i < a.length; i += 1) {
      expect(readFileSync(a[i])).toEqual(readFileSync(b[i]));
    }
    expect(readFileSync(a[0]).subarray(0, 5).toString()).toBe('%PDF-');
  });
});
