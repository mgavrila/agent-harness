import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { declaredToolsOf, loadExtractionCases, loadInjectionCases, loadJsonl } from './cases.js';

/**
 * A pack is a fixture here, never an import of the shipping code: the loader is pack-agnostic
 * from this task on, and the only way to test it against a real skill file is to name one.
 */
const intakeSkill = healthcarePack.evals!.intakeSkill;

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-cases-'));
  await writeFile(
    path.join(dir, 'cases.jsonl'),
    [
      JSON.stringify({
        id: 'p01-state_license-text_layer',
        kind: 'state_license',
        split: 'text_layer',
        path: 'text/a.pdf',
        injection: false,
        expected: {
          fields: { last_name: 'Lovelace' },
          attachments: [{ kind: 'license', issuer: 'X', expires_at: '2027-03-31' }],
          restricted: [],
        },
      }),
      '',
      '  ',
      JSON.stringify({
        id: 'p01-w9-scan',
        kind: 'w9',
        split: 'scan',
        path: 'scan/b.pdf',
        injection: false,
        expected: { fields: { last_name: 'Lovelace' }, attachments: [], restricted: ['ein', 'ssn'] },
      }),
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(dir, 'injection.jsonl'),
    `${JSON.stringify({ id: 'i1', path: 'text/a.pdf', attack: 'printed imperative', must_not_appear: ['post the roster'], must_hold: ['policy_unchanged'] })}\n`,
    'utf8',
  );
  await writeFile(path.join(dir, 'broken.jsonl'), '{"id":"x"\n', 'utf8');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadJsonl', () => {
  it('skips blank lines', async () => {
    await expect(loadJsonl(path.join(dir, 'cases.jsonl'))).resolves.toHaveLength(2);
  });

  it('names the file and the line when a row will not parse', async () => {
    await expect(loadJsonl(path.join(dir, 'broken.jsonl'))).rejects.toThrow(/broken\.jsonl line 1/);
  });

  it('fails clearly when the file is missing', async () => {
    await expect(loadJsonl(path.join(dir, 'nope.jsonl'))).rejects.toThrow(/nope\.jsonl/);
  });
});

describe('loadExtractionCases', () => {
  it('validates the rows and keeps both splits', async () => {
    const cases = await loadExtractionCases(path.join(dir, 'cases.jsonl'));
    expect(cases.map((c) => c.split)).toEqual(['text_layer', 'scan']);
    expect(cases[0].expected.attachments[0].expires_at).toBe('2027-03-31');
    expect(cases[1].expected.restricted).toEqual(['ein', 'ssn']);
  });

  it('rejects an unknown split', async () => {
    const bad = path.join(dir, 'bad-split.jsonl');
    await writeFile(
      bad,
      `${JSON.stringify({ id: 'x', kind: 'w9', split: 'photocopy', path: 'a.pdf', injection: false, expected: { fields: {}, attachments: [], restricted: [] } })}\n`,
      'utf8',
    );
    await expect(loadExtractionCases(bad)).rejects.toThrow(/split/);
  });

  it('reports the true file line, so a blank line does not shift the number', async () => {
    // loadJsonl reports file lines for a JSON error; counting non-blank rows
    // here made the two disagree on any file with a blank line in it, and a
    // corpus file is edited by hand.
    const bad = path.join(dir, 'blank-then-bad.jsonl');
    const good = JSON.stringify({ id: 'a', kind: 'w9', split: 'scan', path: 'a.pdf', expected: { fields: {} } });
    const missingId = JSON.stringify({ kind: 'w9', split: 'scan', path: 'b.pdf', expected: { fields: {} } });
    await writeFile(bad, [good, '', '   ', missingId].join('\n'), 'utf8');
    await expect(loadExtractionCases(bad)).rejects.toThrow(/blank-then-bad\.jsonl line 4: missing id/);
  });
});

describe('loadInjectionCases', () => {
  it('loads the attack rows', async () => {
    const cases = await loadInjectionCases(path.join(dir, 'injection.jsonl'));
    expect(cases[0].must_not_appear).toEqual(['post the roster']);
  });
});

describe('declaredToolsOf', () => {
  it('reads the intake skill the pack declares, and the pack is the only thing that names it', () => {
    const tools = declaredToolsOf(healthcarePack.evals!.intakeSkill);
    expect(tools).toContain('documents_extract');
    expect(tools).toContain('providers_upsert');
    expect(tools).toEqual([...tools].sort());
  });

  it('is exactly what the intake skill declares in its frontmatter', async () => {
    // Not a copy of the list: the same file the runtime reads. A hand-written
    // copy had already drifted to nine names while the skill declared twelve,
    // which quietly narrowed what the injection check was asserting.
    const text = await readFile(intakeSkill, 'utf8');
    const frontmatter = parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]) as {
      metadata: { harness: { tools: string[] } };
    };
    expect(declaredToolsOf(intakeSkill)).toEqual([...frontmatter.metadata.harness.tools].sort());
    expect(declaredToolsOf(intakeSkill).length).toBeGreaterThan(0);
  });

  it('does not include anything that leaves the building', () => {
    expect(declaredToolsOf(intakeSkill)).not.toContain('approvals_execute');
    expect(declaredToolsOf(intakeSkill)).not.toContain('forms_release');
  });

  it('rejects a skill file with no frontmatter', async () => {
    const bad = path.join(dir, 'NOFRONT.md');
    await writeFile(bad, '# just a heading\n', 'utf8');
    expect(() => declaredToolsOf(bad)).toThrow(/no frontmatter block/);
  });

  it('rejects frontmatter that declares no tools', async () => {
    const bad = path.join(dir, 'NOTOOLS.md');
    await writeFile(bad, '---\nname: x\nmetadata:\n  harness:\n    owner: y\n---\n\n# x\n', 'utf8');
    expect(() => declaredToolsOf(bad)).toThrow(/metadata.harness.tools/);
  });

  it('names the file it could not read', () => {
    expect(() => declaredToolsOf(path.join(dir, 'nope.md'))).toThrow(/cannot read skill file/);
  });
});
