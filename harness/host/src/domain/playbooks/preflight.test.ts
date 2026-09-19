import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { loadIdentity, type PlaybookRow } from '@harness/core-tools';
import { parsePlaybooksFile } from '@harness/config-api';
import { COORDINATOR, PLAYBOOKS_PRINCIPAL, hostFixture, testKernelConfig, useTestDb } from '../../testing.js';
import { kernelSkillsDir, readSkillCatalogue } from '../skills.js';
import { preflightPlaybook } from './preflight.js';

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
    const text = await readFile(path.join(demoClientDir, 'playbooks.yaml'), 'utf8');
    const playbooks = parsePlaybooksFile(parseYaml(text));
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
