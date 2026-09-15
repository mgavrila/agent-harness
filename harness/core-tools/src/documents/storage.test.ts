import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  it('accepts a path relative to the storage dir', () => {
    expect(resolveStoragePath(dir, 'incoming/a.pdf')).toBe(path.join(dir, 'incoming', 'a.pdf'));
  });

  it('accepts an absolute path inside the storage dir', () => {
    const abs = path.join(dir, 'incoming', 'a.pdf');
    expect(resolveStoragePath(dir, abs)).toBe(abs);
  });

  it('rejects traversal out of the storage dir', () => {
    expect(() => resolveStoragePath(dir, '../etc/passwd')).toThrow(ToolError);
    expect(() => resolveStoragePath(dir, 'incoming/../../secret')).toThrow(/outside/);
    expect(() => resolveStoragePath(dir, '/etc/passwd')).toThrow(/outside/);
  });

  it('rejects a sibling directory that merely shares a prefix', () => {
    expect(() => resolveStoragePath(dir, `${dir}-evil/x.pdf`)).toThrow(/outside/);
  });

  it('rejects an empty path', () => {
    expect(() => resolveStoragePath(dir, '   ')).toThrow(ToolError);
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
  it('puts the redacted text beside the document', () => {
    expect(documentTextPath('/s/incoming/a.pdf')).toBe('/s/incoming/a.redacted.txt');
    expect(documentTextPath('/s/incoming/scan')).toBe('/s/incoming/scan.redacted.txt');
  });
});
