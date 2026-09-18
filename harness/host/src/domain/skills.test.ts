import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { kernelSkillsDir, readSkillCatalogue } from './skills.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-host-skills-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('readSkillCatalogue', () => {
  it('reads name, description and version off every SKILL.md frontmatter, in directory order', async () => {
    await mkdir(path.join(dir, 'b-skill'));
    await writeFile(
      path.join(dir, 'b-skill', 'SKILL.md'),
      '---\nname: b-skill\ndescription: Second.\nversion: 2.0.0\n---\n# B\n',
    );
    await mkdir(path.join(dir, 'a-skill'));
    await writeFile(
      path.join(dir, 'a-skill', 'SKILL.md'),
      '---\nname: a-skill\ndescription: First.\nversion: 1.0.0\n---\n# A\n',
    );
    await writeFile(path.join(dir, 'README.md'), 'not a skill');
    expect(await readSkillCatalogue([dir])).toEqual([
      { name: 'a-skill', version: '1.0.0', description: 'First.', dir: path.join(dir, 'a-skill') },
      { name: 'b-skill', version: '2.0.0', description: 'Second.', dir: path.join(dir, 'b-skill') },
    ]);
  });

  it('refuses a skill whose frontmatter name is not its directory name', async () => {
    await mkdir(path.join(dir, 'x'));
    await writeFile(path.join(dir, 'x', 'SKILL.md'), '---\nname: y\ndescription: d\nversion: 1\n---\n');
    await expect(readSkillCatalogue([dir])).rejects.toThrow(/"y".*"x"/);
  });

  it('reads the shipped healthcare skills', async () => {
    const skills = await readSkillCatalogue([healthcarePack.skillsDir]);
    expect(skills.map((s) => s.name)).toEqual([
      'credentialing-expirations',
      'credentialing-fill-form',
      'credentialing-intake',
      'credentialing-roster',
    ]);
  });

  it('reads the one skill the host itself ships, beside the packs’', async () => {
    const skills = await readSkillCatalogue([kernelSkillsDir()]);
    expect(skills.map((s) => s.name)).toEqual(['knowledge-sync']);
    expect(skills[0]).toMatchObject({ version: '1.0.0' });
    expect(skills[0].description).toContain('knowledge');
  });
});
