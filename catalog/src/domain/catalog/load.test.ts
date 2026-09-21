import { describe, expect, it } from 'vitest';
import { fixtureBlueprintDir } from '../../testing.js';
import { loadCatalog } from './load.js';

describe('loadCatalog', () => {
  it('loads a directory of blueprints with includes, metadata, changelog and seeds', async () => {
    const root = await fixtureBlueprintDir('one');
    const catalog = await loadCatalog(root);
    expect(catalog.list().map((b) => b.name)).toEqual(['one']);
    const one = catalog.get('one');
    expect(one.version).toBe('1.0.0');
    expect(one.blueprint.document.persona).toContain('You are');
    expect(one.meta.inputs[0]?.pointer).toBe('/playbooks/playbooks/0/timezone');
    expect(one.knowledgeSeeds).toEqual(['welcome.md']);
    expect(one.changelog).toContain('## 1.0.0');
  });
  it('refuses a blueprint whose directory name is not a blueprint name', async () => {
    const root = await fixtureBlueprintDir('Bad Name');
    await expect(loadCatalog(root)).rejects.toThrow(/blueprint name/);
  });
  it('refuses a blueprint.yaml that is not the kernel shape', async () => {
    const root = await fixtureBlueprintDir('one', { blueprintYaml: 'document: {}\n' });
    await expect(loadCatalog(root)).rejects.toThrow(/blueprint one/);
  });
  it('get() on an unknown name is an error, not undefined', async () => {
    const catalog = await loadCatalog(await fixtureBlueprintDir('one'));
    expect(() => catalog.get('two')).toThrow(/no blueprint named "two"/);
  });
});
