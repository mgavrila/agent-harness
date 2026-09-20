import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify as toYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseClientDocument, type ClientDocument } from '@harness/config-api';
import { configSourceConformance, fixtureDocument } from '@harness/config-api/testing';
import { filesConfigSource } from './source.js';

const log = { info() {}, warn() {}, error() {} };
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-clients-'));
  roots.push(root);
  return root;
}

async function writeDocument(root: string, document: ClientDocument): Promise<void> {
  const dir = path.join(root, document.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'client.yaml'), toYaml(document), 'utf8');
}

configSourceConformance(async () => {
  const root = await newRoot();
  const source = filesConfigSource({ root, log });
  return {
    source,
    // This source derives its version from the document's content rather than taking one, so the
    // version it assigned is the one a load answers with. The suite asserts what a version *is* —
    // stable while the content is, different when it is not — and never a literal string, which is
    // exactly what lets a content-addressed source run the same suite as a versioned one.
    put: async (document) => {
      const parsed = parseClientDocument(document);
      await writeDocument(root, parsed);
      const loaded = await source.load(parsed.id);
      if (!loaded) throw new Error(`wrote ${parsed.id} and the source does not hold it`);
      return loaded.version;
    },
    close: async () => {},
  };
});

describe('filesConfigSource', () => {
  it('pulls the persona and a skill out of the markdown files beside the document', async () => {
    const root = await newRoot();
    const dir = path.join(root, 'fixture');
    await mkdir(path.join(dir, 'skills'), { recursive: true });
    const raw = fixtureDocument();
    delete raw.persona;
    delete raw.skills;
    await writeFile(
      path.join(dir, 'client.yaml'),
      `${toYaml(raw)}persona: !include persona.md\nskills:\n  onboarding: !include skills/onboarding.md\n`,
      'utf8',
    );
    await writeFile(path.join(dir, 'persona.md'), 'You are the fixture assistant.\n', 'utf8');
    await writeFile(path.join(dir, 'skills', 'onboarding.md'), '---\nname: onboarding\n---\nDo the thing.\n', 'utf8');

    const loaded = await filesConfigSource({ root, log }).load('fixture');
    expect(loaded?.document.persona).toBe('You are the fixture assistant.\n');
    expect(loaded?.document.skills.onboarding).toContain('Do the thing.');
  });

  it('resolves a blueprint and an overlay, and refuses one that touches a locked path', async () => {
    const root = await newRoot();
    const dir = path.join(root, 'acme');
    await mkdir(dir, { recursive: true });
    const { id: _id, displayName: _displayName, ...document } = fixtureDocument();
    await writeFile(
      path.join(dir, 'blueprint.yaml'),
      toYaml({ document, lockset: ['/persona'], version: 'bp-1' }),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'overlay.yaml'),
      toYaml({
        version: 'ov-1',
        patch: [
          { op: 'add', path: '/id', value: 'acme' },
          { op: 'add', path: '/displayName', value: 'Acme' },
        ],
      }),
      'utf8',
    );
    expect((await filesConfigSource({ root, log }).load('acme'))?.document.displayName).toBe('Acme');

    await writeFile(
      path.join(dir, 'overlay.yaml'),
      toYaml({
        version: 'ov-2',
        patch: [
          { op: 'add', path: '/id', value: 'acme' },
          { op: 'add', path: '/displayName', value: 'Acme' },
          { op: 'replace', path: '/persona', value: 'Something else.' },
        ],
      }),
      'utf8',
    );
    await expect(filesConfigSource({ root, log }).load('acme')).rejects.toThrow(/which blueprint bp-1 locks/);
  });

  it('refuses a blueprint/overlay document whose overlay claims another client id', async () => {
    const root = await newRoot();
    const dir = path.join(root, 'acme');
    await mkdir(dir, { recursive: true });
    const { id: _id, displayName: _displayName, ...document } = fixtureDocument();
    await writeFile(
      path.join(dir, 'blueprint.yaml'),
      toYaml({ document, lockset: ['/persona'], version: 'bp-1' }),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'overlay.yaml'),
      toYaml({
        version: 'ov-1',
        patch: [
          { op: 'add', path: '/id', value: 'other-tenant' },
          { op: 'add', path: '/displayName', value: 'Acme' },
        ],
      }),
      'utf8',
    );
    await expect(filesConfigSource({ root, log }).load('acme')).rejects.toThrow(ConfigError);
    await expect(filesConfigSource({ root, log }).load('acme')).rejects.toThrow(
      /declares id "other-tenant" but lives in the directory "acme"/,
    );
  });

  it('refuses a document whose id is not the directory it sits in', async () => {
    const root = await newRoot();
    await mkdir(path.join(root, 'alpha'), { recursive: true });
    await writeFile(path.join(root, 'alpha', 'client.yaml'), toYaml(fixtureDocument()), 'utf8');
    await expect(filesConfigSource({ root, log }).load('alpha')).rejects.toThrow(ConfigError);
    await expect(filesConfigSource({ root, log }).load('alpha')).rejects.toThrow(/declares id "fixture"/);
  });

  it('does not publish the host path in the id-mismatch error', async () => {
    const root = await newRoot();
    await mkdir(path.join(root, 'alpha'), { recursive: true });
    await writeFile(path.join(root, 'alpha', 'client.yaml'), toYaml(fixtureDocument()), 'utf8');
    await expect(filesConfigSource({ root, log }).load('alpha')).rejects.toThrow(/alpha\/client\.yaml/);
    await expect(filesConfigSource({ root, log }).load('alpha')).rejects.not.toThrow(
      new RegExp(tmpdir().replace(/[/\\]/g, '\\$&')),
    );
  });

  it('refuses a client id that is not one, rather than joining it into a path', async () => {
    const root = await newRoot();
    await expect(filesConfigSource({ root, log }).load('../escape')).rejects.toThrow(ConfigError);
  });

  it('names the missing directory when the clients root does not exist, rather than a raw ENOENT', async () => {
    const root = path.join(tmpdir(), 'harness-clients-does-not-exist');
    await expect(filesConfigSource({ root, log }).list?.()).rejects.toThrow(ConfigError);
    await expect(filesConfigSource({ root, log }).list?.()).rejects.toThrow(new RegExp(`cannot list ${root}`));
  });

  it('tells a watcher the new version once the writes settle, and only once', async () => {
    const root = await newRoot();
    await writeDocument(root, parseClientDocument(fixtureDocument()));
    const source = filesConfigSource({ root, log, watchDebounceMs: 20 });
    const seen: string[] = [];
    const stop = source.watch?.('fixture', (version) => seen.push(version));
    // Let the seed read settle before the edit, so the first version is the one on disk.
    await new Promise((r) => setTimeout(r, 50));
    await writeDocument(root, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })));
    await writeDocument(root, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })));
    await new Promise((r) => setTimeout(r, 150));
    stop?.();
    expect(seen).toHaveLength(1);
    expect((await source.load('fixture'))?.version).toBe(seen[0]);
  });

  it('resolves a relative knowledge path against the client directory, so the kernel gets an absolute one', async () => {
    const root = await newRoot();
    await writeDocument(
      root,
      parseClientDocument(fixtureDocument({ knowledge: { source: 'dir', path: 'knowledge' } })),
    );
    await mkdir(path.join(root, 'fixture', 'knowledge'), { recursive: true });
    const loaded = await filesConfigSource({ root, log }).load('fixture');
    expect(loaded?.document.knowledge).toEqual({ source: 'dir', path: path.join(root, 'fixture', 'knowledge') });
  });

  it("refuses a knowledge path that is a symlink out of the client's own directory", async () => {
    const root = await newRoot();
    await writeDocument(
      root,
      parseClientDocument(fixtureDocument({ knowledge: { source: 'dir', path: 'knowledge' } })),
    );
    // The escape a string check cannot see: the link sits inside the client's own directory, so
    // the resolved path is under its root while the directory it names is another tenant's.
    await mkdir(path.join(root, 'other-tenant', 'knowledge'), { recursive: true });
    await symlink(path.join(root, 'other-tenant', 'knowledge'), path.join(root, 'fixture', 'knowledge'));
    await expect(filesConfigSource({ root, log }).load('fixture')).rejects.toThrow(ConfigError);
    await expect(filesConfigSource({ root, log }).load('fixture')).rejects.toThrow(/outside the client directory/);
    await expect(filesConfigSource({ root, log }).load('fixture')).rejects.not.toThrow(
      new RegExp(tmpdir().replace(/[/\\]/g, '\\$&')),
    );
  });

  it("accepts a symlink that stays inside the client's own directory, because the target is what is checked", async () => {
    const root = await newRoot();
    await writeDocument(
      root,
      parseClientDocument(fixtureDocument({ knowledge: { source: 'dir', path: 'knowledge' } })),
    );
    await mkdir(path.join(root, 'fixture', 'documents'), { recursive: true });
    await symlink(path.join(root, 'fixture', 'documents'), path.join(root, 'fixture', 'knowledge'));
    const loaded = await filesConfigSource({ root, log }).load('fixture');
    expect(loaded?.document.knowledge).toEqual({ source: 'dir', path: path.join(root, 'fixture', 'knowledge') });
  });

  it('refuses a knowledge directory it cannot resolve, without saying which of the three reasons it is', async () => {
    const root = await newRoot();
    await writeDocument(
      root,
      parseClientDocument(fixtureDocument({ knowledge: { source: 'dir', path: 'knowledge' } })),
    );
    await expect(filesConfigSource({ root, log }).load('fixture')).rejects.toThrow(ConfigError);
    await expect(filesConfigSource({ root, log }).load('fixture')).rejects.toThrow(/cannot be read/);
    await expect(filesConfigSource({ root, log }).load('fixture')).rejects.not.toThrow(
      new RegExp(tmpdir().replace(/[/\\]/g, '\\$&')),
    );
  });

  it("refuses a knowledge path that climbs out of the client's own directory", async () => {
    const root = await newRoot();
    await writeDocument(
      root,
      parseClientDocument(fixtureDocument({ knowledge: { source: 'dir', path: '../other/knowledge' } })),
    );
    await expect(filesConfigSource({ root, log }).load('fixture')).rejects.toThrow(ConfigError);
    await expect(filesConfigSource({ root, log }).load('fixture')).rejects.toThrow(/outside the client directory/);
  });
});
