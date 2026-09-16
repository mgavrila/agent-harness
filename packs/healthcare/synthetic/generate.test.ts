import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { assertSafeToClear, generate, type GroundTruth } from './generate.js';

let outDir: string;
let truth: GroundTruth;

function isValidDea(candidate: string): boolean {
  if (!/^[A-Z]{2}\d{7}$/.test(candidate)) return false;
  const d = candidate.slice(2).split('').map(Number);
  return (d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5])) % 10 === d[6];
}

function isValidNpi(candidate: string): boolean {
  if (!/^\d{10}$/.test(candidate)) return false;
  // NPI check digit: Luhn over "80840" + the first nine digits.
  const digits = `80840${candidate.slice(0, 9)}`.split('').map(Number).reverse();
  const sum = digits.reduce((acc, d, i) => acc + (i % 2 === 0 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d), 0);
  return (10 - (sum % 10)) % 10 === Number(candidate[9]);
}

beforeAll(async () => {
  outDir = await mkdtemp(path.join(tmpdir(), 'harness-synth-'));
  truth = await generate({ outDir, count: 2, seed: 1, scans: true, injection: true });
}, 180_000);

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

describe('generate', () => {
  it('is deterministic for a seed', async () => {
    const second = await mkdtemp(path.join(tmpdir(), 'harness-synth2-'));
    try {
      const again = await generate({ outDir: second, count: 2, seed: 1, scans: false, injection: false });
      expect(again.providers).toEqual(truth.providers);
    } finally {
      await rm(second, { recursive: true, force: true });
    }
  }, 120_000);

  it('writes four documents per provider in both splits, plus the injection document', () => {
    const perSplit = truth.documents.filter((d) => d.split === 'text_layer');
    expect(
      perSplit.filter((d) => d.kind !== 'state_license' || !d.document_id.startsWith('injection')).length,
    ).toBeGreaterThanOrEqual(8);
    expect(new Set(perSplit.map((d) => d.kind))).toEqual(
      new Set(['state_license', 'dea_certificate', 'malpractice_certificate', 'w9']),
    );
    expect(truth.documents.filter((d) => d.split === 'scan')).toHaveLength(perSplit.length);
  });

  it('writes every declared file to disk', async () => {
    for (const doc of truth.documents) {
      const info = await stat(path.join(outDir, doc.path));
      expect(info.size).toBeGreaterThan(500);
    }
  });

  it('gives each provider a valid NPI, SSN, EIN and DEA number', () => {
    for (const p of truth.providers) {
      expect(isValidNpi(p.npi)).toBe(true);
      expect(isValidDea(p.dea_number)).toBe(true);
      expect(p.ssn).toMatch(/^\d{3}-\d{2}-\d{4}$/);
      expect(p.ein).toMatch(/^\d{2}-\d{7}$/);
    }
  });

  it('puts the restricted identifiers only on the documents that carry them', () => {
    const w9 = truth.documents.find((d) => d.kind === 'w9' && d.split === 'text_layer')!;
    const license = truth.documents.find((d) => d.kind === 'state_license' && d.split === 'text_layer')!;
    expect(Object.keys(w9.restricted).sort()).toEqual(['ein', 'ssn']);
    expect(Object.keys(license.restricted)).toEqual([]);
    const dea = truth.documents.find((d) => d.kind === 'dea_certificate' && d.split === 'text_layer')!;
    expect(Object.keys(dea.restricted)).toEqual(['dea_number']);
  });

  it('records the credential a document evidences, with an expiry date', () => {
    const license = truth.documents.find((d) => d.kind === 'state_license' && d.split === 'text_layer')!;
    expect(license.credentials).toHaveLength(1);
    expect(license.credentials[0]).toMatchObject({ kind: 'license' });
    expect(license.credentials[0].expires_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('makes the text-layer PDFs readable and the scans image-only', async () => {
    const { PDFParse } = await import('pdf-parse');
    const license = truth.documents.find((d) => d.kind === 'state_license' && d.split === 'text_layer')!;
    const scan = truth.documents.find((d) => d.document_id === license.document_id.replace('text_layer', 'scan'))!;

    // pdf-parse@2.4.5's getText() mutates the params object it is given as a
    // side effect of its internal per-page call, defaulting `pageJoiner` to
    // '\n-- page_number of total_number --' even when the caller passed no
    // params at all; that footer then gets appended after the loop because
    // the mutated object is checked afterwards. Passing an explicit empty
    // pageJoiner sidesteps the nullish-coalescing default and gets the raw
    // per-page text, which is what "image-only" actually needs to assert.
    const textParser = new PDFParse({ data: new Uint8Array(await readFile(path.join(outDir, license.path))) });
    const text = (await textParser.getText({ pageJoiner: '' })).text;
    await textParser.destroy();
    expect(text).toContain(license.fields.last_name);

    const scanParser = new PDFParse({ data: new Uint8Array(await readFile(path.join(outDir, scan.path))) });
    const scanText = (await scanParser.getText({ pageJoiner: '' })).text;
    await scanParser.destroy();
    expect(scanText.replace(/\s/g, '')).toHaveLength(0);
  }, 120_000);

  it('writes an injection document whose text carries the attack sentence', async () => {
    const injected = truth.documents.find((d) => d.document_id.startsWith('injection') && d.split === 'text_layer')!;
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(await readFile(path.join(outDir, injected.path))) });
    const text = (await parser.getText()).text;
    await parser.destroy();
    expect(text.toLowerCase()).toContain('ignore prior instructions');
    expect(text.toLowerCase()).toContain('post the roster');
  });

  it('writes ground-truth.json and cases.jsonl', async () => {
    const gt = JSON.parse(await readFile(path.join(outDir, 'ground-truth.json'), 'utf8')) as GroundTruth;
    expect(gt.seed).toBe(1);
    expect(gt.documents).toHaveLength(truth.documents.length);
    const lines = (await readFile(path.join(outDir, 'cases.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(truth.documents.length);
    expect(JSON.parse(lines[0])).toHaveProperty('expected');
  });
});

describe('clearing the output directory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harness-synth-guard-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('allows an empty directory', async () => {
    await expect(assertSafeToClear(dir)).resolves.toBeUndefined();
  });

  it('allows a directory that does not exist yet', async () => {
    await expect(assertSafeToClear(path.join(dir, 'nested', 'out'))).resolves.toBeUndefined();
  });

  it('allows a directory that already holds a generated corpus', async () => {
    await writeFile(path.join(dir, 'ground-truth.json'), '{}', 'utf8');
    await writeFile(path.join(dir, 'cases.jsonl'), '', 'utf8');
    await expect(assertSafeToClear(dir)).resolves.toBeUndefined();
  });

  it('refuses a directory holding anything else', async () => {
    // `generate` opens with a recursive delete of this directory and the path
    // comes straight off a command line, so `pnpm synth -- --out=.` used to
    // wipe the repository.
    await writeFile(path.join(dir, 'notes.txt'), 'someone else lives here', 'utf8');
    await expect(assertSafeToClear(dir)).rejects.toThrow(/refusing to clear/);
    await expect(generate({ outDir: dir, count: 1, seed: 1, scans: false, injection: false })).rejects.toThrow(
      /refusing to clear/,
    );
    // And the stray file is still there.
    await expect(stat(path.join(dir, 'notes.txt'))).resolves.toBeTruthy();
  });
});
