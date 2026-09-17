import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureRequest } from '@harness/runtime-api/testing';
import { inputText, seedFiles } from './files.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-skills-'));
  await mkdir(path.join(dir, 'credentialing-intake'));
  await writeFile(
    path.join(dir, 'credentialing-intake', 'SKILL.md'),
    '---\nname: credentialing-intake\n---\n# Intake\n',
  );
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const tools = null as never;

describe('seedFiles', () => {
  it('puts every skill body under /skills/<name>/SKILL.md and the memory under /memories/MEMORY.md', async () => {
    const files = await seedFiles(
      fixtureRequest({
        tools,
        skills: [
          {
            name: 'credentialing-intake',
            version: '1.0.0',
            description: 'x',
            dir: path.join(dir, 'credentialing-intake'),
          },
        ],
        memory: '# Memory\n- prefers short answers',
      }),
    );
    expect(Object.keys(files).sort()).toEqual(['/memories/MEMORY.md', '/skills/credentialing-intake/SKILL.md']);
    expect(files['/skills/credentialing-intake/SKILL.md'].content).toEqual([
      '---',
      'name: credentialing-intake',
      '---',
      '# Intake',
    ]);
    expect(files['/memories/MEMORY.md'].content).toEqual(['# Memory', '- prefers short answers']);
  });

  it('seeds an empty memory as a placeholder line, so the memory file always exists', async () => {
    const files = await seedFiles(fixtureRequest({ tools, memory: '' }));
    expect(files['/memories/MEMORY.md'].content).toEqual(['(no memories yet)']);
  });
});

describe('inputText', () => {
  it('is the text alone when nothing was attached', () => {
    expect(inputText(fixtureRequest({ tools, input: { text: 'hi', attachments: [] } }))).toBe('hi');
  });

  it('lists attachments as storage-relative paths the ingest tool takes', () => {
    const text = inputText(
      fixtureRequest({
        tools,
        input: { text: 'File these.', attachments: [{ name: 'licence.pdf', path: 'licence.pdf' }] },
      }),
    );
    expect(text).toBe(
      'File these.\n\nAttachments (pass the path to documents_ingest):\n- incoming/licence.pdf (licence.pdf)',
    );
  });
});
