import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError } from '@harness/shared';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { loadPacks, registryOf } from './registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('loadPacks', () => {
  it('loads the healthcare pack by package name', async () => {
    const packs = await loadPacks(['@harness/pack-healthcare']);
    expect(packs.all.map((p) => p.name)).toEqual(['healthcare']);
    expect(packs.byName('healthcare')).toBe(healthcarePack);
  });

  it('exposes the five document kinds in the manifest order, which the tool schema depends on', async () => {
    const packs = await loadPacks(['@harness/pack-healthcare']);
    expect(packs.documentKinds()).toEqual([
      'state_license',
      'dea_certificate',
      'malpractice_certificate',
      'w9',
      'other',
    ]);
  });

  it('answers for the first pack on manifest, formsDir and skillsDirs', async () => {
    const packs = await loadPacks(['@harness/pack-healthcare']);
    expect(packs.manifest().version).toBe('1.0.0');
    expect(packs.formsDir().endsWith('packs/healthcare/forms')).toBe(true);
    expect(packs.skillsDirs().map((d) => d.endsWith('packs/healthcare/skills'))).toEqual([true]);
  });

  it('names only the module when it cannot be resolved, never the resolver error', async () => {
    await expect(loadPacks(['@harness/pack-nope'])).rejects.toThrow(ConfigError);
    await expect(loadPacks(['@harness/pack-nope'])).rejects.toThrow('cannot load pack "@harness/pack-nope"');
    await expect(loadPacks(['@harness/pack-nope'])).rejects.not.toThrow(/node_modules|ERR_MODULE/);
  });

  it('refuses a module that resolves but exports no pack', async () => {
    await expect(loadPacks(['@harness/shared'])).rejects.toThrow('module "@harness/shared" exports no `pack`');
  });

  it('refuses an empty HARNESS_PACKS rather than starting with no document kinds', async () => {
    await expect(loadPacks([])).rejects.toThrow('HARNESS_PACKS names no pack');
  });
});

describe('byName', () => {
  it('throws ConfigError for a pack that is not loaded', () => {
    expect(() => registryOf([healthcarePack]).byName('scanning')).toThrow('no pack named "scanning" is loaded');
  });
});

describe('registryOf([])', () => {
  it('refuses an empty pack list rather than crashing on manifest() or formsDir() later', () => {
    expect(() => registryOf([])).toThrow(ConfigError);
    expect(() => registryOf([])).toThrow('HARNESS_PACKS names no pack; at least one is required');
  });
});

/**
 * `loadPacks` tells three kinds of `import()` failure apart. Each fixture is a throwaway module
 * written under a temp directory next to this test and loaded by its absolute `file://` URL, so
 * none of them touches a real workspace package. Every temp directory is removed after its test,
 * pass or fail.
 */
describe('loadPacks failure modes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(contents: string): string {
    const dir = mkdtempSync(path.join(here, '.tmp-pack-fixture-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'pack.ts');
    writeFileSync(file, contents, 'utf8');
    return pathToFileURL(file).href;
  }

  it('(a) sanitizes a resolver failure, even one under a temp dir rather than node_modules', async () => {
    const url = pathToFileURL(path.join(here, '.tmp-pack-fixture-does-not-exist', 'pack.ts')).href;
    await expect(loadPacks([url])).rejects.toThrow(ConfigError);
    await expect(loadPacks([url])).rejects.toThrow(`cannot load pack "${url}"`);
    await expect(loadPacks([url])).rejects.not.toThrow(/ERR_MODULE_NOT_FOUND|node_modules/);
  });

  it('(b) re-raises a ConfigError the pack throws while initialising, named', async () => {
    const url = fixture(`
      import { definePack } from '@harness/pack-api';
      export const pack = definePack({
        name: 'broken',
        version: '1.0.0',
        records: [
          {
            kind: 'provider',
            label: 'Provider',
            fields: [{ name: 'last_name', type: 'string', description: 'x', restricted: false, source: 'model' }],
            nameFields: ['last_name'],
          },
        ],
        documentKinds: ['other'],
        extraction: {
          version: '1.0.0',
          document_kinds: ['other'],
          role: 'You read documents.',
          targets: [
            {
              document_kinds: ['*'],
              record_kind: 'provider',
              schema_name: 'provider_extraction',
              attachments_key: 'credentials',
              instruction: 'Extract.',
            },
          ],
        },
        formsDir: 'relative/forms',
        skillsDir: '/abs/skills',
        policy: {},
      });
    `);
    await expect(loadPacks([url])).rejects.toThrow(ConfigError);
    await expect(loadPacks([url])).rejects.toThrow(
      `pack "${url}": pack "broken" formsDir must be an absolute path, got "relative/forms"`,
    );
  });

  it('(c) replaces any other error with a message naming only the pack, and logs the original', async () => {
    const secret = '/etc/only-the-log-should-see-this';
    const url = fixture(`throw new Error('could not read ${secret}');`);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(loadPacks([url])).rejects.toThrow(ConfigError);
      await expect(loadPacks([url])).rejects.toThrow(`pack "${url}" failed to initialise`);
      await expect(loadPacks([url])).rejects.not.toThrow(new RegExp(secret.replace(/\//g, '\\/')));
      expect(errorSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes(secret)))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
