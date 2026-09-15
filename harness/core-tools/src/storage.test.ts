import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { storageRoot, outRoot, contentTag, resolveOutFile, writeOutFile } from './storage.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'harness-storage-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('storage paths', () => {
  it('refuses to guess a storage root', () => {
    expect(() => storageRoot(undefined)).toThrow(/HARNESS_STORAGE_DIR/);
    expect(() => storageRoot('   ')).toThrow(/HARNESS_STORAGE_DIR/);
    expect(storageRoot('/srv/x')).toBe('/srv/x');
  });

  it('keeps every generated file under out/', () => {
    expect(outRoot(root)).toBe(path.join(root, 'out'));
    expect(resolveOutFile('roster/aetna-abc.csv', root)).toBe(path.join(root, 'out', 'roster', 'aetna-abc.csv'));
  });

  it('rejects a file id that escapes the out tree', () => {
    for (const bad of ['../secrets.txt', 'roster/../../etc/passwd', '/etc/passwd', '', '   ', '.']) {
      expect(() => resolveOutFile(bad, root)).toThrow(/output directory/);
    }
  });

  it('writes a content-addressed file and returns its id', async () => {
    const bytes = new TextEncoder().encode('payer_id,provider_name\naetna,Dr. A\n');
    const written = await writeOutFile({ dir: 'roster', name: 'aetna', ext: 'csv', bytes }, root);
    expect(written.file_id).toBe(`roster/aetna-${contentTag(bytes)}.csv`);
    expect(written.bytes).toBe(bytes.byteLength);
    expect(await readFile(written.path, 'utf8')).toContain('aetna,Dr. A');
  });

  it('gives identical content the same id and changed content a different one', async () => {
    const a = new TextEncoder().encode('one');
    const b = new TextEncoder().encode('two');
    const first = await writeOutFile({ dir: 'forms', name: 'f', ext: 'pdf', bytes: a }, root);
    const same = await writeOutFile({ dir: 'forms', name: 'f', ext: 'pdf', bytes: a }, root);
    const other = await writeOutFile({ dir: 'forms', name: 'f', ext: 'pdf', bytes: b }, root);
    expect(same.file_id).toBe(first.file_id);
    expect(other.file_id).not.toBe(first.file_id);
  });
});
