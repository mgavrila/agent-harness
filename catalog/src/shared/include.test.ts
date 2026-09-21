import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWithIncludes } from './include.js';

async function dir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'hf1-catalog-'));
}

describe('parseWithIncludes', () => {
  it('replaces !include with the file body, relative to the YAML file', async () => {
    const d = await dir();
    await writeFile(path.join(d, 'persona.md'), '# Hello\n');
    await writeFile(path.join(d, 'b.yaml'), 'persona: !include persona.md\nn: 1\n');
    await expect(parseWithIncludes(path.join(d, 'b.yaml'))).resolves.toEqual({ persona: '# Hello\n', n: 1 });
  });
  it('refuses an include outside the directory, by path and by symlink', async () => {
    const d = await dir();
    const outside = await dir();
    await writeFile(path.join(outside, 'x.md'), 'x');
    await writeFile(path.join(d, 'a.yaml'), 'p: !include ../x.md\n');
    await expect(parseWithIncludes(path.join(d, 'a.yaml'))).rejects.toThrow(/outside the blueprint directory/);
    await mkdir(path.join(d, 'skills'));
    await symlink(path.join(outside, 'x.md'), path.join(d, 'skills', 'link.md'));
    await writeFile(path.join(d, 'b.yaml'), 'p: !include skills/link.md\n');
    await expect(parseWithIncludes(path.join(d, 'b.yaml'))).rejects.toThrow(/outside the blueprint directory/);
  });
  it('refuses a non-scalar !include and a missing file', async () => {
    const d = await dir();
    await writeFile(path.join(d, 'a.yaml'), 'p: !include [a, b]\n');
    await expect(parseWithIncludes(path.join(d, 'a.yaml'))).rejects.toThrow(/one path/);
    await writeFile(path.join(d, 'b.yaml'), 'p: !include nope.md\n');
    await expect(parseWithIncludes(path.join(d, 'b.yaml'))).rejects.toThrow(/cannot be read/);
  });
});
