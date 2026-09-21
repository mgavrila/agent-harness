import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadIdentity, type PlaybookRow } from '@harness/core-tools';
import { filesConfigSource } from '@harness/config-files';
import type { PlaybookDefinition } from '@harness/config-api';
import { parseIdentityFileWithDefaults } from '@harness/identity-api';
import { COORDINATOR, PLAYBOOKS_PRINCIPAL, hostFixture, useTestDb } from '../../testing.js';
import { kernelSkillsDir, readSkillCatalogue } from '../skills.js';
import { materialiseSkills } from '../tenancy/skills.js';
import { preflightPlaybook } from './preflight.js';

// src/domain/playbooks -> src -> host -> harness -> <repo>. The same resolution main.ts uses.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

const db = useTestDb();

const row = (overrides: Partial<PlaybookRow> = {}): PlaybookRow => ({
  id: '33333333-3333-4333-8333-333333333333',
  client: 'test',
  name: 'nightly',
  schedule: '0 7 * * *',
  skill: 'sample-skill',
  prompt: 'Run it.',
  principalId: 'svc-playbooks',
  surface: null,
  conversation: null,
  deliver: 'none',
  costCapUsd: 0.5,
  timeoutS: 300,
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  createdAt: new Date('2026-09-15T12:00:00Z'),
  updatedAt: new Date('2026-09-15T12:00:00Z'),
  ...overrides,
});

/** The row the scheduler writes for one of the document's playbook entries. */
const rowFor = (playbook: PlaybookDefinition): PlaybookRow =>
  row({
    name: playbook.name,
    skill: playbook.skill,
    principalId: playbook.principal,
    surface: playbook.surface ?? null,
    costCapUsd: playbook.cost_cap_usd,
  });

const log = { info() {}, warn() {}, error() {} };

describe('preflightPlaybook', () => {
  it('passes a playbook whose skill, service principal and surface are all present', async () => {
    const f = await hostFixture(db, { trajectory: [] });
    const result = await preflightPlaybook(f.host, row());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.skill.name).toBe('sample-skill');
      expect(result.principal).toEqual(PLAYBOOKS_PRINCIPAL);
      expect(result.surface.name).toBe('memory');
    }
  });

  it('fails, in spec order, with a fixed reason naming only the thing that is missing', async () => {
    const f = await hostFixture(db, { trajectory: [] });
    expect(await preflightPlaybook(f.host, row({ skill: 'no-such-skill' }))).toEqual({
      ok: false,
      reason: 'skill "no-such-skill" is not in the loaded skill catalogue',
    });
    expect(await preflightPlaybook(f.host, row({ principalId: 'svc-nobody' }))).toEqual({
      ok: false,
      reason: 'principal "svc-nobody" is not declared by the identity plug-in',
    });
    expect(await preflightPlaybook(f.host, row({ principalId: COORDINATOR.id }))).toEqual({
      ok: false,
      reason: 'principal "u-coordinator" is not a service',
    });
    expect(await preflightPlaybook(f.host, row({ surface: 'nowhere' }))).toEqual({
      ok: false,
      reason: 'surface "nowhere" is not loaded',
    });
    expect(await preflightPlaybook(f.host, row({ costCapUsd: 0 }))).toEqual({
      ok: false,
      reason: 'cost_cap_usd is not a positive number',
    });
    expect(await preflightPlaybook(f.host, row({ costCapUsd: Number.NaN }))).toEqual({
      ok: false,
      reason: 'cost_cap_usd is not a positive number',
    });
  });

  it('fails closed when the identity plug-in itself fails', async () => {
    const f = await hostFixture(db, { trajectory: [] });
    f.host.identity = {
      ...f.identity,
      name: 'broken',
      get: async () => {
        throw new Error('directory unreachable');
      },
      resolve: async () => null,
      list: async () => [],
      stop: async () => {},
    };
    expect(await preflightPlaybook(f.host, row())).toEqual({
      ok: false,
      reason: 'the identity plug-in could not answer for principal "svc-playbooks"',
    });
  });
});

describe('the shipped fixture client (I1)', () => {
  const clientsDir = path.join(repoRoot, 'clients');

  it('is a valid document whose playbooks pass preflight against the shipped skills and identity', async () => {
    const loaded = await filesConfigSource({ root: clientsDir, log }).load('fixture');
    expect(loaded, 'clients/fixture/client.yaml must load').toBeTruthy();
    const document = loaded!.document;
    expect(document.playbooks.playbooks.map((p) => p.name)).toEqual(['knowledge-refresh']);
    for (const playbook of document.playbooks.playbooks) {
      expect(playbook).toMatchObject({ principal: 'svc-playbooks', deliver: 'none' });
    }

    const f = await hostFixture(db, { trajectory: [] });
    // Identity, loaded the way main.ts loads it: the plug-in the document's `identityPlugin`
    // names, over the document's own `identity` section.
    f.host.identity = await loadIdentity('@harness/identity-static', {
      env: {},
      log: f.host.log,
      identity: parseIdentityFileWithDefaults(document.identity),
      settings: {},
      directories: {},
    });
    // Skills, the way a tenant gets them: the kernel's own directory, the document's own skills
    // written out, and the packs the document names.
    const skillsDir = await materialiseSkills(document, await mkdtemp(path.join(tmpdir(), 'harness-fixture-')));
    f.host.skills = await readSkillCatalogue([kernelSkillsDir(), skillsDir, ...f.host.config.packs.skillsDirs()]);
    for (const playbook of document.playbooks.playbooks) {
      expect(await preflightPlaybook(f.host, rowFor(playbook)), playbook.name).toMatchObject({ ok: true });
    }
    await f.close();
  });
});
