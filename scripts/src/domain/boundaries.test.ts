import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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
 *
 * **Every case here reads the rule objects dependency-cruiser is handed, never the file's text.**
 * A rule carries a `comment` that names all four directories in prose, so a case that searched the
 * rule's *source* for the word `deploy` would go on passing after `deploy` was dropped from the
 * pattern that does the enforcing. Each predicate below therefore parses the alternation out of
 * the pattern itself, and each case proves the predicate bites by applying it a second time to a
 * weakened copy of the same rule.
 */
const PLATFORM_DIRS = ['catalog', 'control-plane', 'apps', 'deploy'];
const KERNEL_TREES = ['harness', 'packs', 'surfaces', 'identities', 'runtimes', 'evals', 'scripts'];
const KERNEL_CONTRACTS = ['config-api', 'identity-api', 'pack-api', 'surface-api', 'shared'];

/** One entry of `forbidden`, narrowed to the fields these cases read. */
interface Rule {
  name: string;
  from: { path?: string };
  to: { path?: string; pathNot?: string[] };
}

const requireCjs = createRequire(import.meta.url);
const config = requireCjs(path.join(repoRoot, '.dependency-cruiser.cjs')) as { forbidden: Rule[] };

function ruleNamed(name: string): Rule {
  const found = config.forbidden.find((rule) => rule.name === name);
  if (found === undefined) throw new Error(`the ${name} rule is gone from .dependency-cruiser.cjs`);
  return found;
}

/** The top-level directories a `^(a|b|c)/` pattern matches, and nothing a comment beside it says. */
function directoriesMatched(pattern: string | undefined): string[] {
  const group = /^\^\(([^)]+)\)\//.exec(pattern ?? '');
  return group === null ? [] : group[1].split('|');
}

/** The `harness/<name>/src/` packages a `^harness/(a|b)/src/` pattern exempts. */
function contractsExempted(pattern: string): string[] {
  const group = /^\^harness\/\(([^)]+)\)\/src\//.exec(pattern);
  return group === null ? [] : group[1].split('|');
}

const bansEveryPlatformDir = (rule: Rule): boolean =>
  PLATFORM_DIRS.every((dir) => directoriesMatched(rule.to.path).includes(dir));

const exemptsEveryContract = (rule: Rule): boolean =>
  KERNEL_CONTRACTS.every((contract) =>
    (rule.to.pathNot ?? []).some((pattern) => contractsExempted(pattern).includes(contract)),
  );

describe('the platform boundary', () => {
  it('bans an import from every kernel tree into every platform directory', () => {
    const ban = ruleNamed('kernel-never-imports-the-platform');
    expect(bansEveryPlatformDir(ban)).toBe(true);
    expect([...directoriesMatched(ban.to.path)].sort()).toEqual([...PLATFORM_DIRS].sort());
    // And the `from` side is every kernel tree, not a subset: a rule that had quietly lost
    // `scripts/` would let the one package that reads the workspace reach into the platform.
    expect([...directoriesMatched(ban.from.path)].sort()).toEqual([...KERNEL_TREES].sort());
    // The predicate bites. Dropping `deploy` from the enforced pattern — and only from there,
    // leaving the comment that names all four untouched — has to fail the same check that just
    // passed, or this case proves nothing about what dependency-cruiser refuses.
    const weakened: Rule = { ...ban, to: { ...ban.to, path: '^(catalog|control-plane|apps)/' } };
    expect(bansEveryPlatformDir(weakened)).toBe(false);
  });

  it('lets the catalogue reach kernel contracts and nothing else', () => {
    const rule = ruleNamed('catalog-imports-kernel-contracts-only');
    // The exemption is a `pathNot` on the contracts' **source paths**: a rule that named packages
    // instead would not fire on a deep import, which is the thing it exists to stop.
    expect(exemptsEveryContract(rule)).toBe(true);
    // And the `from` side is the catalogue's own source tree, not the whole repository.
    expect(rule.from.path).toBe('^catalog/src/');
    // The predicate bites here too: an exemption that had lost `shared` fails it.
    const weakened: Rule = {
      ...rule,
      to: { ...rule.to, pathNot: ['^harness/(config-api|identity-api|pack-api|surface-api)/src/'] },
    };
    expect(exemptsEveryContract(weakened)).toBe(false);
  });

  it('cruises every platform directory that exists, so its rules are not prose', () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    for (const dir of PLATFORM_DIRS) {
      if (!existsSync(path.join(repoRoot, dir, 'src'))) continue;
      // depcruise fails outright on a glob whose parent does not exist, so a directory is added
      // to the globs when it arrives and not before — which is exactly what this asserts.
      expect(manifest.scripts.arch, dir).toContain(`${dir}/src/**/*.ts`);
      expect(manifest.scripts['arch:graph'], dir).toContain(`${dir}/src/**/*.ts`);
    }
  });
});
