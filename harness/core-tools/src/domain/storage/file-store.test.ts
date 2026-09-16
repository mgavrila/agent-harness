import { mkdir, mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ToolError } from '@harness/shared';
import { contentTag, outRoot, storageRoot } from './layout.js';
import { resolveOutFile, resolveStoragePath, sha256File, writeOutFile } from './file-store.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'harness-storage-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-storage-'));
  await mkdir(path.join(dir, 'incoming'), { recursive: true });
  await writeFile(path.join(dir, 'incoming', 'a.pdf'), 'hello');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('storage paths', () => {
  it('refuses to guess a storage root', () => {
    expect(() => storageRoot(undefined)).toThrow(/HARNESS_STORAGE_DIR/);
    expect(() => storageRoot('   ')).toThrow(/HARNESS_STORAGE_DIR/);
    expect(() => storageRoot('./.harness-storage')).toThrow(/absolute/);
    expect(storageRoot('/srv/x')).toBe('/srv/x');
  });

  it('keeps every generated file under out/', async () => {
    expect(outRoot(root)).toBe(path.join(root, 'out'));
    await expect(resolveOutFile('roster/aetna-abc.csv', root)).resolves.toBe(
      path.join(root, 'out', 'roster', 'aetna-abc.csv'),
    );
  });

  it('rejects a file id that escapes the out tree', async () => {
    for (const bad of ['../secrets.txt', 'roster/../../etc/passwd', '/etc/passwd', '', '   ', '.']) {
      await expect(resolveOutFile(bad, root)).rejects.toThrow(/output directory/);
    }
  });

  it('rejects a file id that reaches outside through a symlink', async () => {
    // A lexical check passes this: `out/escape/secrets.txt` has no `..` and is
    // not absolute. `stat` in forms_release and `readFile` in the Slack sink
    // both follow the link, so only the real path settles it.
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secrets.txt'), 'restricted');
    await mkdir(outRoot(root), { recursive: true });
    await symlink(outside, path.join(outRoot(root), 'escape'));

    await expect(resolveOutFile('escape/secrets.txt', root)).rejects.toThrow(/output directory/);
    // The link itself is refused too, not only a path through it.
    await expect(resolveOutFile('escape', root)).rejects.toThrow(/output directory/);
  });

  it('accepts a symlink that stays inside the out tree', async () => {
    const forms = path.join(outRoot(root), 'forms');
    await mkdir(forms, { recursive: true });
    await writeFile(path.join(forms, 'real.pdf'), 'pdf');
    await symlink(forms, path.join(outRoot(root), 'alias'));
    await expect(resolveOutFile('alias/real.pdf', root)).resolves.toBe(path.join(outRoot(root), 'alias', 'real.pdf'));
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

describe('resolveStoragePath', () => {
  it('accepts a path relative to the storage dir', async () => {
    await expect(resolveStoragePath(dir, 'incoming/a.pdf')).resolves.toBe(path.join(dir, 'incoming', 'a.pdf'));
  });

  it('accepts an absolute path inside the storage dir', async () => {
    const abs = path.join(dir, 'incoming', 'a.pdf');
    await expect(resolveStoragePath(dir, abs)).resolves.toBe(abs);
  });

  it('rejects traversal out of the storage dir', async () => {
    await expect(resolveStoragePath(dir, '../etc/passwd')).rejects.toThrow(ToolError);
    await expect(resolveStoragePath(dir, 'incoming/../../secret')).rejects.toThrow(/outside/);
    await expect(resolveStoragePath(dir, '/etc/passwd')).rejects.toThrow(/outside/);
  });

  it('rejects a sibling directory that merely shares a prefix', async () => {
    await expect(resolveStoragePath(dir, `${dir}-evil/x.pdf`)).rejects.toThrow(/outside/);
  });

  it('rejects an empty path', async () => {
    await expect(resolveStoragePath(dir, '   ')).rejects.toThrow(ToolError);
  });

  it('rejects a symlink under the storage dir that points outside it', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'harness-outside-'));
    try {
      const secret = path.join(outsideDir, 'secret.txt');
      await writeFile(secret, 'top secret');
      const link = path.join(dir, 'incoming', 'escape-link');
      await symlink(secret, link);
      await expect(resolveStoragePath(dir, 'incoming/escape-link')).rejects.toThrow(/outside/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('accepts a symlink under the storage dir that points to a file inside it', async () => {
    const link = path.join(dir, 'incoming', 'inside-link');
    await symlink(path.join(dir, 'incoming', 'a.pdf'), link);
    await expect(resolveStoragePath(dir, 'incoming/inside-link')).resolves.toBe(link);
  });

  it('rejects a non-existent path whose existing ancestor is a symlink pointing outside the root', async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), 'harness-outside-'));
    try {
      const link = path.join(dir, 'incoming', 'escape-dir-link');
      await symlink(outsideDir, link);
      await expect(resolveStoragePath(dir, 'incoming/escape-dir-link/not-yet-written.pdf')).rejects.toThrow(/outside/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('sha256File', () => {
  it('hashes the file contents', async () => {
    // sha256("hello")
    await expect(sha256File(path.join(dir, 'incoming', 'a.pdf'))).resolves.toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('throws a ToolError for a missing file', async () => {
    await expect(sha256File(path.join(dir, 'nope.pdf'))).rejects.toThrow(ToolError);
  });
});
