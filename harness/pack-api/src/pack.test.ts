import { describe, expect, it } from 'vitest';
import { definePack, type Pack } from './pack.js';

const base: Pack = {
  name: 'healthcare',
  version: '0.1.0',
  documentKinds: ['other'],
  extraction: { version: '1.0.0', fields: [], credentials: [], document_kinds: ['other'] },
  formsDir: '/srv/pack/forms',
  skillsDir: '/srv/pack/skills',
  policy: {},
};

describe('definePack', () => {
  it('returns the pack unchanged when it is well formed', () => {
    expect(definePack(base)).toBe(base);
  });

  it('refuses a relative directory, because it would resolve against the process cwd', () => {
    expect(() => definePack({ ...base, formsDir: 'forms' })).toThrow(/formsDir must be an absolute path/);
    expect(() => definePack({ ...base, skillsDir: './skills' })).toThrow(/skillsDir must be an absolute path/);
  });

  it('refuses a pack with no name, no version or no document kinds', () => {
    expect(() => definePack({ ...base, name: 'Health Care' })).toThrow(/must be lowercase/);
    expect(() => definePack({ ...base, version: '' })).toThrow(/has no version/);
    expect(() => definePack({ ...base, documentKinds: [] })).toThrow(/declares no document kinds/);
  });
});
