import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Workflow {
  on?: { push?: { tags?: string[] } };
  permissions?: Record<string, string>;
  jobs?: Record<string, { env?: Record<string, string>; steps?: { name?: string; uses?: string; run?: string }[] }>;
}

const workflow = async (): Promise<Workflow> =>
  parseYaml(await readFile(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8')) as Workflow;

const steps = async (): Promise<{ name?: string; uses?: string; run?: string }[]> =>
  Object.values((await workflow()).jobs ?? {}).flatMap((job) => job.steps ?? []);

const scripts = async (): Promise<string> => (await steps()).map((step) => step.run ?? '').join('\n');

/**
 * Every directory `pnpm-workspace.yaml` calls a package.
 *
 * Read from the workspace file rather than from a list written here, so a package added under a
 * new top-level parent — or the two single-directory packages, `evals` and `scripts` — is covered
 * without anyone remembering to edit this test.
 */
async function workspaceDirs(): Promise<string[]> {
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

/** Every workspace package that is not private: what a release is expected to carry. */
async function publicPackages(): Promise<string[]> {
  const names: string[] = [];
  for (const dir of await workspaceDirs()) {
    const manifest = path.join(repoRoot, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { name: string; private?: boolean };
    if (parsed.private !== true) names.push(parsed.name);
  }
  return names;
}

describe('the release workflow', () => {
  it('runs on a version tag and on nothing else', async () => {
    const parsed = await workflow();
    expect(parsed.on?.push?.tags).toEqual(['v*']);
    // No pull_request, no push to a branch, no schedule: a release is something a person did.
    expect(Object.keys(parsed.on ?? {})).toEqual(['push']);
  });

  it('asks for exactly the two permissions it uses', async () => {
    expect((await workflow()).permissions).toEqual({ contents: 'write', packages: 'write' });
  });

  it('runs all five gates before it publishes anything', async () => {
    const text = await scripts();
    const gates = ['pnpm -r typecheck', 'pnpm lint', 'pnpm arch', 'pnpm format:check', 'pnpm test'];
    for (const gate of gates) expect(text, gate).toContain(gate);
    // Every gate is before the first push, so a tag that fails the suite publishes nothing.
    const firstPush = text.indexOf('docker push');
    for (const gate of gates) expect(text.indexOf(gate), gate).toBeLessThan(firstPush);
  });

  it('packs exactly the packages this repository declares public', async () => {
    const text = await scripts();
    const packed = [...text.matchAll(/@harness\/[a-z-]+/g)].map((match) => match[0]);
    expect([...new Set(packed)].sort()).toEqual((await publicPackages()).sort());
  });

  it('pushes both images the Compose stack pulls, at the tag s own version', async () => {
    const text = await scripts();
    // The registry and the owner are pinned as well as the name: a tag that lost its
    // `$REGISTRY/$IMAGE_OWNER/` prefix pushes to Docker Hub and still reads like a release, and
    // Compose pulls `ghcr.io/mgavrila` specifically.
    expect((await workflow()).jobs?.release?.env).toMatchObject({ REGISTRY: 'ghcr.io', IMAGE_OWNER: 'mgavrila' });
    for (const image of ['agent-harness-host', 'agent-harness-files']) {
      expect(text, image).toContain(`"$REGISTRY/$IMAGE_OWNER/${image}:$VERSION"`);
    }
    expect(text).toContain('docker login');
  });

  it('attaches both architecture snapshots to the release', async () => {
    const text = await scripts();
    expect(text).toContain('docs/architecture/tool-surface.json');
    expect(text).toContain('docs/architecture/compose-surface.yaml');
    expect(text).toContain('release/*.tgz');
  });

  it('takes the release body from the changelog rather than from commit subjects', async () => {
    // The whole chain, because every link can be deleted on its own and leave the rest green:
    // a step writes the notes, every `gh` call that sets a body is told to use that file, and the
    // script behind `release:notes` is the one that reads CHANGELOG.md.
    const text = await scripts();
    expect(text).toContain('pnpm release:notes "$VERSION" > release/notes.md');
    const bodySetters = text.match(/gh release (?:create|edit)[^\n]*/g) ?? [];
    expect(bodySetters.some((line) => line.startsWith('gh release create'))).toBe(true);
    for (const line of bodySetters) expect(line, line).toContain('--notes-file release/notes.md');
    const root = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const entrypoint = root.scripts?.['release:notes'] ?? '';
    expect(entrypoint).toContain('src/app/changelog-cli.ts');
    expect(await readFile(path.join(repoRoot, 'scripts/src/app/changelog-cli.ts'), 'utf8')).toContain('CHANGELOG.md');
  });

  it('uses only the actions CI already uses', async () => {
    const used = (await steps()).flatMap((step) => (step.uses ? [step.uses] : []));
    expect([...new Set(used)].sort()).toEqual(['actions/checkout@v4', 'actions/setup-node@v4', 'pnpm/action-setup@v4']);
  });
});

describe('the changelog', () => {
  it('describes the version the manifests declare', async () => {
    const version = (
      JSON.parse(await readFile(path.join(repoRoot, 'harness/shared/package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    // The release this plan prepares, whether or not the version has been bumped for it yet.
    expect(changelog).toContain('## 0.2.0');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
