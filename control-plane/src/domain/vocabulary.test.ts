import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const FORBIDDEN = /hf1-labs|demo-practice|river-clinic|alliance|weave|andrei/i;

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('vocabulary', () => {
  it('no domain module names a tenant, an organisation or a person', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const f of [...(await files(here)), ...(await files(path.resolve(here, '../../../catalog/src')))]) {
      expect(await readFile(f, 'utf8'), f).not.toMatch(FORBIDDEN);
    }
  });
});
