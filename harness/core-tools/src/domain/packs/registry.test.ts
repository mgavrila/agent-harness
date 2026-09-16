import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { loadPacks, registryOf } from './registry.js';

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
