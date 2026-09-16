import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonl, writeJsonl } from './jsonl.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-jsonl-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readJsonl', () => {
  it('skips blank lines but keeps the true file line on every row', async () => {
    const file = path.join(dir, 'cases.jsonl');
    await writeFile(file, '{"id":"a"}\n\n{"id":"b"}\n', 'utf8');
    expect(await readJsonl<{ id: string }>(file)).toEqual([
      { value: { id: 'a' }, line: 1 },
      { value: { id: 'b' }, line: 3 },
    ]);
  });

  it('names the file and the line a parse failed on', async () => {
    const file = path.join(dir, 'cases.jsonl');
    await writeFile(file, '{"id":"a"}\n{not json}\n', 'utf8');
    await expect(readJsonl(file)).rejects.toThrow('cases.jsonl line 2 is not valid JSON');
  });

  it('uses the caller label when the file cannot be read', async () => {
    await expect(readJsonl(path.join(dir, 'missing.jsonl'), 'case file')).rejects.toThrow(/^cannot read case file /);
  });
});

describe('writeJsonl', () => {
  it('writes one document per line and ends with a newline', async () => {
    const file = path.join(dir, 'out.jsonl');
    await writeJsonl(file, [{ id: 'a' }, { id: 'b' }]);
    expect(await readJsonl<{ id: string }>(file)).toEqual([
      { value: { id: 'a' }, line: 1 },
      { value: { id: 'b' }, line: 2 },
    ]);
  });
});
