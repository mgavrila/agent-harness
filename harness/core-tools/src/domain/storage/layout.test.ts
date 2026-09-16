import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documentTextPath, outRoot } from './layout.js';
import { fileStorage } from './file-store.js';

describe('documentTextPath', () => {
  it('puts the redacted text beside the document, keeping the full file name', () => {
    expect(documentTextPath('/s/incoming/a.pdf')).toBe('/s/incoming/a.pdf.redacted.txt');
    expect(documentTextPath('/s/incoming/scan')).toBe('/s/incoming/scan.redacted.txt');
  });

  it('gives two documents that differ only by extension different text paths', () => {
    // Replacing the extension collapsed these onto one file: the second
    // extraction overwrote the first while both `documents` rows pointed at it.
    expect(documentTextPath('/s/incoming/a.pdf')).not.toBe(documentTextPath('/s/incoming/a.png'));
  });
});

describe('fileStorage', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harness-file-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('binds one root to the five operations a domain needs', async () => {
    const store = fileStorage(root);
    const written = await store.write({
      dir: 'forms',
      name: 'demo',
      ext: 'pdf',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(written.path.startsWith(outRoot(root))).toBe(true);
    expect(await store.resolveOut(written.file_id)).toBe(written.path);
    expect(Array.from(await store.read(written.path))).toEqual([1, 2, 3]);
    expect(store.textPathFor('/a/b.pdf')).toBe('/a/b.pdf.redacted.txt');
  });

  it('refuses a file id that leaves the out tree', async () => {
    await expect(fileStorage(root).resolveOut('../escape.pdf')).rejects.toThrow('outside the output directory');
  });
});
