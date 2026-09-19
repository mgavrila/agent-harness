import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseWithIncludes } from './include.js';

async function clientDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-config-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text, 'utf8');
  }
  return dir;
}

describe('parseWithIncludes', () => {
  it('replaces an include with the file it names, at any depth', async () => {
    const dir = await clientDir({
      'client.yaml': 'persona: !include persona.md\nskills:\n  onboarding: !include skills/onboarding.md\n',
      'persona.md': '# Persona\n',
      'skills/onboarding.md': '---\nname: onboarding\n---\n',
    });
    expect(await parseWithIncludes(path.join(dir, 'client.yaml'))).toEqual({
      persona: '# Persona\n',
      skills: { onboarding: '---\nname: onboarding\n---\n' },
    });
  });

  it('leaves a document with no include exactly as it parsed', async () => {
    const dir = await clientDir({ 'client.yaml': 'id: fixture\npacks: []\n' });
    expect(await parseWithIncludes(path.join(dir, 'client.yaml'))).toEqual({ id: 'fixture', packs: [] });
  });

  it('refuses an include that climbs out of the client directory', async () => {
    const dir = await clientDir({ 'client.yaml': 'persona: !include ../../../etc/passwd\n' });
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(ConfigError);
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(/outside/);
  });

  it('refuses an absolute include for the same reason', async () => {
    const dir = await clientDir({ 'client.yaml': 'persona: !include /etc/passwd\n' });
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(ConfigError);
  });

  it('refuses an include that reaches out of the client directory through a symlink inside it', async () => {
    // The one a resolved-string check misses: every path here is under the client directory, and
    // the file the persona would become is not.
    const dir = await clientDir({ 'client.yaml': 'persona: !include persona.md\n' });
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'harness-elsewhere-'));
    await writeFile(path.join(elsewhere, 'secrets.md'), 'whatever the host can read\n', 'utf8');
    await symlink(path.join(elsewhere, 'secrets.md'), path.join(dir, 'persona.md'));
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(ConfigError);
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(/outside/);
  });

  it('follows a symlink that stays inside the client directory', async () => {
    const dir = await clientDir({
      'client.yaml': 'persona: !include persona.md\n',
      'content/real-persona.md': '# Persona\n',
    });
    await symlink(path.join(dir, 'content', 'real-persona.md'), path.join(dir, 'persona.md'));
    expect(await parseWithIncludes(path.join(dir, 'client.yaml'))).toEqual({ persona: '# Persona\n' });
  });

  it('names the file an include points at when it is not there', async () => {
    const dir = await clientDir({ 'client.yaml': 'persona: !include missing.md\n' });
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(/missing\.md/);
  });

  it('refuses an include whose value is not a path', async () => {
    const dir = await clientDir({ 'client.yaml': 'persona: !include\n  - a\n' });
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(ConfigError);
  });
});
