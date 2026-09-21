/**
 * Reading this workspace's own package manifests.
 *
 * Shared by `packaging.test.ts` and `release-workflow.test.ts`, which both have to answer "what
 * does this repository publish?" and had grown two answers: one walked a list of parent
 * directories written into the test, the other expanded the globs in `pnpm-workspace.yaml`. Two
 * enumerations can disagree, and the day they do, one of the two suites is quietly asserting
 * about a set the release does not use. This is the second one, because pnpm's own file is what
 * the release actually packs from.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** A package manifest, narrowed to the fields these tests read. */
export interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { exports?: Record<string, { types?: string; default?: string }> };
  scripts?: Record<string, string>;
}

/**
 * Every directory `pnpm-workspace.yaml` calls a package.
 *
 * Read from the workspace file rather than from a list written here, so a package added under a
 * new top-level parent — or the two single-directory packages, `evals` and `scripts` — is covered
 * without anyone remembering to edit a test.
 */
export async function workspaceDirs(): Promise<string[]> {
  const workspace = parseYaml(await readFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')) as {
    packages?: string[];
  };
  const dirs: string[] = [];
  for (const glob of workspace.packages ?? []) {
    if (!glob.includes('*')) {
      dirs.push(glob);
      continue;
    }
    if (!glob.endsWith('/*')) throw new Error(`pnpm-workspace.yaml has a glob this test cannot expand: ${glob}`);
    const parent = glob.slice(0, -2);
    for (const entry of await readdir(path.join(repoRoot, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`);
    }
  }
  return dirs;
}

/** Every workspace package's manifest, with the directory it was read from. */
export async function workspaceManifests(): Promise<{ dir: string; manifest: Manifest }[]> {
  const found: { dir: string; manifest: Manifest }[] = [];
  for (const dir of await workspaceDirs()) {
    const file = path.join(repoRoot, dir, 'package.json');
    // A directory under a workspace parent that holds no manifest is not a package: a scratch
    // directory, or one a package was deleted out of.
    if (!existsSync(file)) continue;
    found.push({ dir, manifest: JSON.parse(await readFile(file, 'utf8')) as Manifest });
  }
  return found;
}

/** Every workspace package that is not private: what a release is expected to carry. */
export async function publicPackageNames(): Promise<string[]> {
  return (await workspaceManifests()).filter(({ manifest }) => manifest.private !== true).map((m) => m.manifest.name);
}
