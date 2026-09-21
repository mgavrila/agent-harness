import { describe, expect, it } from 'vitest';
import { playbookRuns, playbooks } from '@harness/db';
import { useTestDb } from '../../testing.js';
import { findPlaybook, listPlaybooks, requestPlaybookRun, summarisePlaybook } from './repository.js';

const db = useTestDb();

async function seed(name: string, client = 'test') {
  const [row] = await db
    .insert(playbooks)
    .values({
      client,
      name,
      schedule: '0 7 * * *',
      skill: 'a-skill',
      prompt: 'run it',
      principalId: 'svc-playbooks',
      costCapUsd: 0.5,
    })
    .returning();
  return row;
}

describe('playbooks repository', () => {
  it('lists a client playbooks by name and finds one, never another client one', async () => {
    await seed('zeta');
    await seed('alpha');
    await seed('alpha', 'someone-else');
    expect((await listPlaybooks(db, 'test')).map((p) => p.name)).toEqual(['alpha', 'zeta']);
    expect((await findPlaybook(db, 'test', 'alpha'))?.client).toBe('test');
    expect(await findPlaybook(db, 'test', 'missing')).toBeNull();
  });

  it('requests a run: a playbook_runs row waiting for the scheduler, stamped with who asked', async () => {
    const playbook = await seed('nightly');
    const now = new Date('2026-09-15T12:00:00Z');
    const run = await requestPlaybookRun(db, {
      client: 'test',
      playbookId: playbook.id,
      now,
      requestedBy: 'u-practice-manager',
    });
    expect(run).toMatchObject({
      playbookId: playbook.id,
      status: 'requested',
      attempts: 0,
      requestedBy: 'u-practice-manager',
      runId: null,
    });
    expect(run.scheduledAt.toISOString()).toBe('2026-09-15T12:00:00.000Z');
    expect(await db.select().from(playbookRuns)).toHaveLength(1);
  });

  it('summarises a row for the model without its prompt', async () => {
    const playbook = await seed('nightly');
    const summary = summarisePlaybook(playbook);
    expect(summary).toEqual({
      name: 'nightly',
      schedule: '0 7 * * *',
      skill: 'a-skill',
      principal_id: 'svc-playbooks',
      surface: null,
      conversation: null,
      deliver: 'none',
      cost_cap_usd: 0.5,
      timeout_s: 600,
      enabled: true,
      next_run_at: null,
      last_run_at: null,
      last_status: null,
    });
    expect('prompt' in summary).toBe(false);
  });
});
