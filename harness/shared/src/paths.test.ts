import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertInsideRoot, realOrNearestAncestor } from './paths.js';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'harness-paths-root-'));
  outside = await mkdtemp(path.join(tmpdir(), 'harness-paths-outside-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const refuse = (reason: string): never => {
  throw new Error(`refused: ${reason}`);
};

describe('realOrNearestAncestor', () => {
  it('resolves a path that does not exist yet by walking up to one that does', async () => {
    const deep = path.join(root, 'a', 'b', 'c.txt');
    expect(await realOrNearestAncestor(deep)).toBe(path.join(await realOrNearestAncestor(root), 'a', 'b', 'c.txt'));
  });
});

describe('assertInsideRoot', () => {
  it('accepts a path under the root and returns it resolved', async () => {
    await mkdir(path.join(root, 'out'), { recursive: true });
    expect(await assertInsideRoot('out/file.pdf', root, refuse)).toBe(path.join(root, 'out', 'file.pdf'));
  });

  it('refuses a traversal lexically, before touching the filesystem', async () => {
    await expect(assertInsideRoot('../escape.txt', root, refuse)).rejects.toThrow('refused: lexical');
  });

  it('refuses a sibling whose name merely starts with the root', async () => {
    await expect(assertInsideRoot(`${root}-evil/file`, root, refuse)).rejects.toThrow('refused: lexical');
  });

  it('refuses a symlink that lexically sits inside but points out', async () => {
    await writeFile(path.join(outside, 'secret.txt'), 'x', 'utf8');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await expect(assertInsideRoot('link.txt', root, refuse)).rejects.toThrow('refused: real');
  });

  it('accepts the root itself by default and refuses it when allowRoot is false', async () => {
    expect(await assertInsideRoot('.', root, refuse)).toBe(root);
    await expect(assertInsideRoot('.', root, refuse, { allowRoot: false })).rejects.toThrow('refused: lexical');
  });

  it('reports an unreadable path through onEscape only when asked to', async () => {
    const loop = path.join(root, 'loop');
    await symlink(loop, loop);
    await expect(assertInsideRoot('loop', root, refuse, { onUnreadable: 'escape' })).rejects.toThrow(
      'refused: unreadable',
    );
    // The default propagates the original errno error instead, so a caller that can safely
    // surface it keeps the detail.
    await expect(assertInsideRoot('loop', root, refuse)).rejects.toThrow(/ELOOP/);
  });

  it('turns an onEscape that forgets to throw into a loud failure', async () => {
    await expect(
      assertInsideRoot('../escape.txt', root, (() => undefined) as unknown as (reason: string) => never),
    ).rejects.toThrow('it must throw');
  });
});
