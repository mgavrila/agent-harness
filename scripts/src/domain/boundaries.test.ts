import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './workspace.test-helpers.js';

/**
 * The boundary decision 1b as amended draws, read off the two files that enforce it.
 *
 * One repository, four enforced boundaries: the platform lives in `catalog/`, `control-plane/`,
 * `apps/` and `deploy/`, no kernel package may import any of them, and `catalog/` may import
 * kernel *contracts* only. The rules themselves are in `.dependency-cruiser.cjs`; this asserts
 * that they are there, that they name all four directories, and that everything which exists is
 * actually cruised — because a rule that names a directory nobody cruises is prose, and a
 * directory that is cruised by no glob is invisible to every rule in that file.
 */
const PLATFORM_DIRS = ['catalog', 'control-plane', 'apps', 'deploy'];

const read = (file: string): string => readFileSync(path.join(repoRoot, file), 'utf8');

describe('the platform boundary', () => {
  it('bans an import from every kernel tree into every platform directory', () => {
    const rules = read('.dependency-cruiser.cjs');
    const ban = /name: 'kernel-never-imports-the-platform'[\s\S]*?\n {2}\},/.exec(rules);
    expect(ban, 'the kernel-never-imports-the-platform rule is gone').not.toBeNull();
    for (const dir of PLATFORM_DIRS) {
      expect(ban![0], dir).toContain(dir);
    }
    // And the `from` side is every kernel tree, not a subset: a rule that had quietly lost
    // `scripts/` would let the one package that reads the workspace reach into the platform.
    for (const tree of ['harness', 'packs', 'surfaces', 'identities', 'runtimes', 'evals', 'scripts']) {
      expect(ban![0], tree).toContain(tree);
    }
  });

  it('lets the catalogue reach kernel contracts and nothing else', () => {
    const rules = read('.dependency-cruiser.cjs');
    // Anchored to the rule, the way the ban above is. Grepping the whole file for these five
    // names would pass on the `PACKAGES` array alone and prove nothing about the exemption.
    const rule = /name: 'catalog-imports-kernel-contracts-only'[\s\S]*?\n {2}\},/.exec(rules);
    expect(rule, 'the catalog-imports-kernel-contracts-only rule is gone').not.toBeNull();
    // The exemption is a `pathNot` on the contracts' **source paths**: a rule that named packages
    // instead would not fire on a deep import, which is the thing it exists to stop. The rule
    // holds them in one constant, so the assertion follows the constant to its definition.
    const exemption = /pathNot: \[([^\]]*)\]/.exec(rule![0]);
    expect(exemption, 'the rule exempts nothing').not.toBeNull();
    const contracts = new RegExp(`const ${exemption![1].trim()} = '([^']+)'`).exec(rules)?.[1] ?? exemption![1];
    for (const contract of ['config-api', 'identity-api', 'pack-api', 'surface-api', 'shared']) {
      expect(contracts, contract).toContain(contract);
    }
    // And the `from` side is the catalogue's own source tree, not the whole repository.
    expect(rule![0]).toContain("from: { path: '^catalog/src/' }");
  });

  it('cruises every platform directory that exists, so its rules are not prose', () => {
    const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    for (const dir of PLATFORM_DIRS) {
      if (!existsSync(path.join(repoRoot, dir, 'src'))) continue;
      // depcruise fails outright on a glob whose parent does not exist, so a directory is added
      // to the globs when it arrives and not before — which is exactly what this asserts.
      expect(manifest.scripts.arch, dir).toContain(`${dir}/src/**/*.ts`);
      expect(manifest.scripts['arch:graph'], dir).toContain(`${dir}/src/**/*.ts`);
    }
  });
});
