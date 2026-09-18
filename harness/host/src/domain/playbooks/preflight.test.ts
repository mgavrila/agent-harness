import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decide, loadIdentity, loadPolicy, type PlaybookRow } from '@harness/core-tools';
import { createLogger } from '@harness/shared';
import { COORDINATOR, PLAYBOOKS_PRINCIPAL, hostFixture, testKernelConfig, useTestDb } from '../../testing.js';
import { kernelSkillsDir, readSkillCatalogue } from '../skills.js';
import { preflightPlaybook } from './preflight.js';
import { readPlaybooksFile } from './schema.js';

// src/domain/playbooks -> src -> host -> harness -> <repo>. The same resolution main.ts uses.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

const db = useTestDb();

const row = (overrides: Partial<PlaybookRow> = {}): PlaybookRow => ({
  id: '33333333-3333-4333-8333-333333333333',
  client: 'test',
  name: 'nightly',
  schedule: '0 7 * * *',
  timezone: 'UTC',
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

describe('the shipped demo playbooks (I1)', () => {
  const demoClientDir = path.join(repoRoot, 'clients', 'demo-practice');

  it('are valid entries, and pass preflight against the shipped skills and identity', async () => {
    const { playbooks } = await readPlaybooksFile(demoClientDir);
    expect(playbooks.map((p) => p.name)).toEqual(['credentialing-expirations', 'knowledge-sync']);
    for (const playbook of playbooks) {
      expect(playbook).toMatchObject({
        timezone: 'America/New_York',
        principal: 'svc-playbooks',
        deliver: 'none',
        cost_cap_usd: 0.5,
        timeout_s: 300,
      });
    }

    const f = await hostFixture(db, { trajectory: [] });
    // Identity, loaded the way main.ts loads it: the static plug-in over the demo's own file.
    f.host.identity = await loadIdentity('@harness/identity-static', {
      env: {},
      log: f.host.log,
      clientDir: demoClientDir,
    });
    // Skills, loaded the way main.ts loads them — the kernel's own directory first, then the
    // shipped pack's. `knowledge-sync` lives in the first and `credentialing-expirations` in the
    // second, so a catalogue built from either alone would fail one of these two playbooks.
    f.host.skills = await readSkillCatalogue([kernelSkillsDir(), ...testKernelConfig(db).packs.skillsDirs()]);

    for (const playbook of playbooks) {
      const result = await preflightPlaybook(
        f.host,
        row({
          name: playbook.name,
          skill: playbook.skill,
          principalId: playbook.principal,
          surface: playbook.surface ?? null,
          costCapUsd: playbook.cost_cap_usd,
        }),
      );
      expect(result, playbook.name).toMatchObject({ ok: true });
    }
  });
});

describe('the shipped hf1-labs client', () => {
  const clientDir = path.join(repoRoot, 'clients', 'hf1-labs');

  it('schedules nothing yet, and says so in the form the host parses', async () => {
    const { playbooks } = await readPlaybooksFile(clientDir);
    expect(playbooks).toEqual([]);
  });

  it('declares its three admins and admits everyone else in the workspace as a member', async () => {
    const log = createLogger('test');
    const session = await loadIdentity('@harness/identity-static', { env: {}, log, clientDir });

    const admins = await Promise.all(
      ['U0C0KEB8W3X', 'U0C0Q8EU8BC', 'U0C0HQHGY8K'].map((userId) => session.resolve({ surface: 'slack', userId })),
    );
    expect(admins.map((p) => `${p?.id}:${p?.level}`)).toEqual(['u-andrei:admin', 'u-admin-2:admin', 'u-admin-3:admin']);

    // Anyone else in the workspace: a member, under an id derived from their member id, so the
    // same teammate is the same principal on Monday as on Friday.
    const teammate = await session.resolve({ surface: 'slack', userId: 'U07NEWJOINER' });
    expect(teammate).toMatchObject({ id: 'u-slack-u07newjoiner-9c7b8d95', kind: 'user', level: 'member' });
    expect(await session.resolve({ surface: 'slack', userId: 'U07NEWJOINER' })).toEqual(teammate);

    // The run API can have no default at all, so a caller the file does not name drives nothing.
    expect(await session.resolve({ surface: 'http', userId: 'nobody' })).toBeNull();
    expect((await session.resolve({ surface: 'http', userId: 'andrei' }))?.id).toBe('u-andrei');
  });

  it("parks a member's shared write for an admin, and lets an admin's through", async () => {
    const policy = await loadPolicy(path.join(clientDir, 'policy.yaml'));
    expect(decide('write.internal', 'member', policy)).toBe('approval');
    expect(decide('write.internal', 'admin', policy)).toBe('auto');
    // What the file itself says, over the kernel's defaults.
    expect(decide('external', 'admin', policy)).toBe('approval');
    // And the rule that surprises everyone once: `financial: blocked` in `classes` blocks a
    // member, but the kernel gives lead and admin their own `financial` cell and a level cell
    // always wins — so an admin's would be parked, not refused.
    expect(decide('financial', 'member', policy)).toBe('blocked');
    expect(decide('financial', 'admin', policy)).toBe('approval');
  });
});
