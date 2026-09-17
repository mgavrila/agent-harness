import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError } from '@harness/shared';

/** The client's persona, verbatim: `<clientDir>/SOUL.md`. Every client folder ships one. */
export async function readPersona(clientDir: string): Promise<string> {
  const file = path.join(clientDir, 'SOUL.md');
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new ConfigError(`cannot read ${file}; every client folder needs a SOUL.md`);
  }
}
