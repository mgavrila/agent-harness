import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { readPersona } from './persona.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-host-persona-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('readPersona', () => {
  it('reads the client SOUL.md', async () => {
    await writeFile(path.join(dir, 'SOUL.md'), 'You are the front desk assistant.\n');
    expect(await readPersona(dir)).toBe('You are the front desk assistant.\n');
  });

  it('refuses a client folder with no SOUL.md, naming the file it needed', async () => {
    await expect(readPersona(dir)).rejects.toThrow(ConfigError);
    await expect(readPersona(dir)).rejects.toThrow(/SOUL\.md/);
  });
});
