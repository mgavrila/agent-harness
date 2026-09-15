import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INTAKE_DECLARED_TOOLS, loadExtractionCases, loadInjectionCases, loadJsonl } from './cases.js';

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
        expected: { fields: { last_name: 'Lovelace' }, credentials: [{ kind: 'license', issuer: 'X', expires_at: '2027-03-31' }], restricted: [] },
      }),
      '',
      '  ',
      JSON.stringify({
        id: 'p01-w9-scan',
        kind: 'w9',
        split: 'scan',
        path: 'scan/b.pdf',
        injection: false,
        expected: { fields: { last_name: 'Lovelace' }, credentials: [], restricted: ['ein', 'ssn'] },
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
    expect(cases[0].expected.credentials[0].expires_at).toBe('2027-03-31');
    expect(cases[1].expected.restricted).toEqual(['ein', 'ssn']);
  });

  it('rejects an unknown split', async () => {
    const bad = path.join(dir, 'bad-split.jsonl');
    await writeFile(bad, `${JSON.stringify({ id: 'x', kind: 'w9', split: 'photocopy', path: 'a.pdf', injection: false, expected: { fields: {}, credentials: [], restricted: [] } })}\n`, 'utf8');
    await expect(loadExtractionCases(bad)).rejects.toThrow(/split/);
  });
});

describe('loadInjectionCases', () => {
  it('loads the attack rows', async () => {
    const cases = await loadInjectionCases(path.join(dir, 'injection.jsonl'));
    expect(cases[0].must_not_appear).toEqual(['post the roster']);
  });
});

describe('INTAKE_DECLARED_TOOLS', () => {
  it('is the set the intake flow is allowed to use', () => {
    expect([...INTAKE_DECLARED_TOOLS]).toEqual([
      'deadlines_compute',
      'documents_classify',
      'documents_extract',
      'documents_get',
      'documents_ingest',
      'documents_list',
      'providers_get',
      'providers_list_pending',
      'providers_upsert',
    ]);
  });

  it('does not include anything that leaves the building', () => {
    expect(INTAKE_DECLARED_TOOLS).not.toContain('approvals_execute');
    expect(INTAKE_DECLARED_TOOLS).not.toContain('verify_nppes');
  });
});
