import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { readSkillCatalogue } from '../skills.js';
import { materialiseSkills } from './skills.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-skills-'));
  roots.push(dir);
  return dir;
}

const SKILL = '---\nname: onboarding\ndescription: Do the thing\nversion: 1.0.0\n---\n\nSteps.\n';

describe('materialiseSkills', () => {
  it('writes one directory per skill, which readSkillCatalogue then reads', async () => {
    const document = parseClientDocument(fixtureDocument({ skills: { onboarding: SKILL } }));
    const dir = await materialiseSkills(document, await root());
    expect(await readFile(path.join(dir, 'onboarding', 'SKILL.md'), 'utf8')).toBe(SKILL);
    const catalogue = await readSkillCatalogue([dir]);
    expect(catalogue.map((skill) => skill.name)).toEqual(['onboarding']);
    expect(catalogue[0].version).toBe('1.0.0');
  });

  it('gives a client with no skill an empty directory rather than no directory', async () => {
    const dir = await materialiseSkills(parseClientDocument(fixtureDocument()), await root());
    expect(await readSkillCatalogue([dir])).toEqual([]);
  });

  it('refuses a skill whose frontmatter name is not the key it was filed under', async () => {
    const document = parseClientDocument(fixtureDocument({ skills: { intake: SKILL } }));
    const dir = await materialiseSkills(document, await root());
    // `readSkillCatalogue` is what catches it, which is the point: a document's skill is validated
    // exactly as a pack's is (spec section 12, item 8).
    await expect(readSkillCatalogue([dir])).rejects.toThrow(ConfigError);
  });

  it('rebuilds the directory, so a skill the document dropped is gone from disk', async () => {
    const base = await root();
    const before = await materialiseSkills(
      parseClientDocument(fixtureDocument({ skills: { onboarding: SKILL } })),
      base,
    );
    expect(await readSkillCatalogue([before])).toHaveLength(1);
    const after = await materialiseSkills(parseClientDocument(fixtureDocument()), base);
    expect(after).toBe(before);
    expect(await readSkillCatalogue([after])).toEqual([]);
  });

  it("writes one client's skills where another client's cannot be read", async () => {
    const base = await root();
    const alpha = await materialiseSkills(
      parseClientDocument(fixtureDocument({ id: 'alpha', displayName: 'A', skills: { onboarding: SKILL } })),
      base,
    );
    const beta = await materialiseSkills(parseClientDocument(fixtureDocument({ id: 'beta', displayName: 'B' })), base);
    expect(alpha).not.toBe(beta);
    expect(await readSkillCatalogue([beta])).toEqual([]);
  });
});
