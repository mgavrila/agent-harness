import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The packages the platform consumes, in dependency order.
 *
 * Written out rather than derived, and then checked against what the manifests say: a package
 * that became publishable by accident is exactly what this list is for.
 */
const PUBLISHED = [
  '@harness/shared',
  '@harness/pack-api',
  '@harness/config-api',
  '@harness/surface-api',
  '@harness/identity-api',
  '@harness/runtime-api',
  '@harness/sandbox-api',
];

/** Where the workspace's packages live, as pnpm-workspace.yaml lists them. */
const WORKSPACE_PARENTS = ['harness', 'packs', 'surfaces', 'identities', 'runtimes'];
const WORKSPACE_SINGLES = ['evals', 'scripts'];

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { exports?: Record<string, { types?: string; default?: string }> };
  scripts?: Record<string, string>;
}

async function manifests(): Promise<{ dir: string; manifest: Manifest }[]> {
  const dirs: string[] = [...WORKSPACE_SINGLES];
  for (const parent of WORKSPACE_PARENTS) {
    for (const entry of await readdir(path.join(repoRoot, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(repoRoot, parent, entry.name, 'package.json'))) {
        dirs.push(`${parent}/${entry.name}`);
      }
    }
  }
  return Promise.all(
    dirs.map(async (dir) => ({
      dir,
      manifest: JSON.parse(await readFile(path.join(repoRoot, dir, 'package.json'), 'utf8')) as Manifest,
    })),
  );
}

describe('what this repository publishes', () => {
  it('declares exactly the published set as public, and everything else as private', async () => {
    const all = await manifests();
    const publishable = all.filter(({ manifest }) => manifest.private !== true).map(({ manifest }) => manifest.name);
    expect(publishable.sort()).toEqual([...PUBLISHED].sort());
  });

  it('gives every published package one version, so a consumer can resolve the whole set', async () => {
    // pnpm rewrites `workspace:*` to the exact version at pack time, so two packages at two
    // versions is a tarball that cannot resolve its own dependency.
    const all = await manifests();
    const versions = new Set(all.map(({ manifest }) => manifest.version));
    expect([...versions]).toHaveLength(1);
  });

  it('gives every published package a build, a files list and a publishConfig that points at dist', async () => {
    for (const { dir, manifest } of (await manifests()).filter((m) => PUBLISHED.includes(m.manifest.name))) {
      expect(manifest.scripts?.build, dir).toBe('tsc -p tsconfig.build.json');
      expect(manifest.files, dir).toEqual(['dist', 'README.md']);
      expect(existsSync(path.join(repoRoot, dir, 'tsconfig.build.json')), dir).toBe(true);
      expect(existsSync(path.join(repoRoot, dir, 'README.md')), dir).toBe(true);
      // The source map stays in `exports` so the workspace keeps running from `.ts`; the
      // published map is the same subpaths, pointing at what the build emitted.
      expect(Object.keys(manifest.publishConfig?.exports ?? {}), dir).toEqual(Object.keys(manifest.exports ?? {}));
      for (const [subpath, target] of Object.entries(manifest.publishConfig?.exports ?? {})) {
        expect(target.types, `${dir} ${subpath}`).toMatch(/^\.\/dist\/.+\.d\.ts$/);
        expect(target.default, `${dir} ${subpath}`).toMatch(/^\.\/dist\/.+\.js$/);
      }
    }
  });
});

/**
 * The slow one, and worth its seconds: it builds and packs every published package and reads the
 * tarball.
 *
 * Everything above is a manifest read, and a manifest can be right while the tarball is empty —
 * a build that emitted into the wrong directory, a `files` entry that matches nothing, a
 * `publishConfig` pnpm did not apply. This is the only assertion that what a consumer downloads
 * is what this repository meant to publish.
 */
describe('the tarball a consumer downloads', () => {
  let packed: string;

  beforeAll(async () => {
    await run('pnpm', ['build'], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
    packed = await mkdtemp(path.join(tmpdir(), 'harness-pack-'));
    return async () => {
      await rm(packed, { recursive: true, force: true });
    };
  }, 300_000);

  it.each(PUBLISHED)(
    '%s ships dist, its declarations and its README, and nothing else',
    async (name) => {
      const out = path.join(packed, name.replace('@harness/', ''));
      await run('pnpm', ['--filter', name, 'exec', 'pnpm', 'pack', '--pack-destination', out], {
        cwd: repoRoot,
        maxBuffer: 8 * 1024 * 1024,
      });
      const [tarball] = await readdir(out);
      expect(tarball).toMatch(/\.tgz$/);
      const { stdout } = await run('tar', ['-xzOf', path.join(out, tarball), 'package/package.json']);
      const manifest = JSON.parse(stdout) as Manifest;
      // pnpm applies publishConfig at pack time and drops it from the published manifest.
      expect(manifest.publishConfig).toBeUndefined();
      expect(manifest.private).toBe(false);
      const listing = (await run('tar', ['-tzf', path.join(out, tarball)])).stdout.split('\n').filter(Boolean);
      expect(listing).toContain('package/package.json');
      expect(listing).toContain('package/README.md');
      // No source, no tests, no vitest config: what ships is what runs.
      expect(listing.filter((entry) => entry.startsWith('package/src/'))).toEqual([]);
      expect(listing.filter((entry) => entry.endsWith('.test.js'))).toEqual([]);
      for (const target of Object.values(manifest.exports ?? {}) as { types?: string; default?: string }[]) {
        for (const file of [target.types, target.default]) {
          expect(listing, `${name} ${String(file)}`).toContain(`package/${String(file).replace('./', '')}`);
        }
      }
      // And what a consumer's lockfile will hold: an exact version rather than a workspace link.
      const deps = (JSON.parse(stdout) as { dependencies?: Record<string, string> }).dependencies ?? {};
      for (const [dependency, range] of Object.entries(deps)) {
        if (dependency.startsWith('@harness/')) expect(range, `${name} -> ${dependency}`).toBe(manifest.version);
      }
    },
    120_000,
  );
});
