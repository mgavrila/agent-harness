import { describe, expect, it } from 'vitest';
import { definePack, type Pack } from './pack.js';

const base: Pack = {
  name: 'healthcare',
  version: '0.1.0',
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

  it('refuses a pack with no record kinds', () => {
    expect(() => definePack({ ...base, records: [] })).toThrow(/declares no record kinds/);
  });

  it('accepts a pack with no forms directory, because not every area fills forms', () => {
    const { formsDir: _dropped, ...noForms } = base;
    expect(definePack(noForms).formsDir).toBeUndefined();
  });

  it('refuses documentKinds that name a kind extraction.document_kinds does not', () => {
    const extra = { ...base, documentKinds: ['other', 'w9'] };
    expect(() => definePack(extra)).toThrow(
      /documentKinds \[other, w9\] does not match extraction\.document_kinds \[other\]/,
    );
  });

  it('refuses extraction.document_kinds that name a kind documentKinds does not', () => {
    const extra = { ...base, extraction: { ...base.extraction, document_kinds: ['other', 'w9'] } };
    expect(() => definePack(extra)).toThrow(
      /documentKinds \[other\] does not match extraction\.document_kinds \[other, w9\]/,
    );
  });

  it('refuses an extraction target naming a record kind the pack does not declare', () => {
    const wrong = {
      ...base,
      extraction: { ...base.extraction, targets: [{ ...base.extraction.targets[0], record_kind: 'epic' }] },
    };
    expect(() => definePack(wrong)).toThrow(/names record kind "epic", which the pack does not declare/);
  });

  it('refuses a document kind that reaches no target, and a replaces list with no tools', () => {
    const unreachable = {
      ...base,
      documentKinds: ['other', 'w9'],
      extraction: {
        ...base.extraction,
        document_kinds: ['other', 'w9'],
        targets: [{ ...base.extraction.targets[0], document_kinds: ['other'] }],
      },
    };
    expect(() => definePack(unreachable)).toThrow(/document kind "w9" reaches no extraction target/);
    expect(() => definePack({ ...base, replaces: ['records_get'] })).toThrow(
      /replaces 1 kernel tools but contributes none/,
    );
  });

  /**
   * Every member of `evals.readback` is looked up by exact string while a case runs, so a typo
   * there is not a startup failure by default: the eval calls a tool that does not exist, or
   * reads a key nothing carries, and the case fails as if the model had missed.
   */
  it('refuses a readback tool or key that is not a lowercase snake-case name', () => {
    const evals = { casesFile: '/c.jsonl', intakeSkill: '/s/SKILL.md', judgedFields: [] };
    expect(() => definePack({ ...base, evals: { ...evals, readback: { readTool: 'providers_get ' } } })).toThrow(
      /evals\.readback\.readTool must be lowercase letters, digits and underscores, got "providers_get "/,
    );
    expect(() => definePack({ ...base, evals: { ...evals, readback: { recordIdKey: '' } } })).toThrow(
      /evals\.readback\.recordIdKey must be lowercase/,
    );
    // Absent is legal for every member: that is how a pack takes the kernel's names.
    expect(() => definePack({ ...base, evals: { ...evals, readback: {} } })).not.toThrow();
    expect(() => definePack({ ...base, evals })).not.toThrow();
  });
});
