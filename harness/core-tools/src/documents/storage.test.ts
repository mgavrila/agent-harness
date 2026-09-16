import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ToolError } from '../registry.js';
import { documentTextPath, resolveStoragePath, sha256File } from './storage.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-storage-'));
  await mkdir(path.join(dir, 'incoming'), { recursive: true });
  await writeFile(path.join(dir, 'incoming', 'a.pdf'), 'hello');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
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
