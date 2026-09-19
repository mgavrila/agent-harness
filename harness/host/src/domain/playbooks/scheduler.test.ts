import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it, onTestFinished } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  auditLog,
  decrypt,
  knowledgeDocuments,
  messages,
  playbookRuns,
  playbooks,
  runs,
  threads,
  toolEffects,
  type Db,
} from '@harness/db';
import { DEFAULT_POLICY, mergePolicy, requestPlaybookRun } from '@harness/core-tools';
import { parsePlaybooksFile, type PlaybookDefinition } from '@harness/config-api';
import { RUN_FAILED_MESSAGE, type RunEvent, type RuntimeSession } from '@harness/runtime-api';
import { startFakeGateway } from '@harness/runtime-api/testing';
import { hostFixture, testKernelConfig, useTestDb, waitFor, type HostFixture } from '../../testing.js';
import { drainActive } from '../conversation.js';
import { kernelSkillsDir, readSkillCatalogue } from '../skills.js';
import { stagePlaybookNotice } from './notice.js';
import { syncPlaybooks } from './repository.js';
import { SCHEDULER_TICK_MS, startScheduler } from './scheduler.js';

// src/domain/playbooks -> src -> host -> harness -> <repo>. The same resolution main.ts uses.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

const db = useTestDb();

const NIGHTLY: PlaybookDefinition = {
  name: 'nightly',
  schedule: '0 7 * * *',
  timezone: 'UTC',
  skill: 'credentialing-expirations',
  prompt: 'Run the credentialing-expirations playbook for today. Follow the skill exactly, including its silence rule.',
  principal: 'svc-playbooks',
  surface: undefined,
  conversation: undefined,
  deliver: 'none',
  cost_cap_usd: 0.5,
  timeout_s: 300,
  enabled: true,
};

/** The shipped skills, so the preflight finds the one the nightly playbook names. */
const shippedSkills = () => readSkillCatalogue(testKernelConfig(db).packs.skillsDirs());

/** Sync one playbook and make it due now: the fixture clock is frozen, so the test moves the row, not the clock. */
async function due(f: HostFixture, definition: PlaybookDefinition = NIGHTLY): Promise<void> {
  await syncPlaybooks(db, { client: 'test', now: f.host.now() }, [definition]);
  await db.update(playbooks).set({ nextRunAt: f.host.now() }).where(eq(playbooks.name, definition.name));
}

/** A runtime whose answer is scripted per request number. */
function sequenced(...outcomes: (readonly RunEvent[])[]): RuntimeSession {
  let calls = 0;
  return {
    name: 'sequenced',
    run: () => {
      const events = outcomes[Math.min(calls, outcomes.length - 1)];
      calls += 1;
      return {
        events: (async function* (): AsyncGenerator<RunEvent> {
          for (const event of events) yield event;
        })(),
      };
    },
    stop: async () => {},
  };
}

/**
 * A database whose next transaction fails the way Postgres fails the one it picks as the victim
 * of a deadlock — a sync and a claim reaching for the same two rows in the other order. Every
 * transaction after it runs for real.
 */
function deadlockOnce(real: Db): Db {
  let failed = false;
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'transaction' && !failed) {
        failed = true;
        return () => Promise.reject(new Error('deadlock detected'));
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

describe('the scheduler', () => {
  it('ticks every thirty seconds in production', () => {
    expect(SCHEDULER_TICK_MS).toBe(30_000);
  });

  it('runs the nightly playbook as its service principal, on its own playbook thread, posting nothing (the exit criterion)', async () => {
    const f = await hostFixture(db, {
      trajectory: [
        { skill: 'credentialing-expirations', version: '1.0.0' },
        { tool: 'deadlines_upcoming', args: { within_days: 90 } },
        { say: 'Nothing to report.' },
      ],
      skills: await shippedSkills(),
    });
    await due(f);
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toEqual({ claimed: 1, done: 1, failed: 0, preflightFailed: 0 });
      expect(await scheduler.tick()).toEqual({ claimed: 0, done: 0, failed: 0, preflightFailed: 0 });
      expect(scheduler.status()).toMatchObject({ lastError: null, ticking: false });
      expect(scheduler.status().lastOkAt).toBe('2026-09-15T12:00:00.000Z');
    } finally {
      await scheduler.stop();
    }

    const [thread] = await db.select().from(threads);
    expect(thread).toMatchObject({
      kind: 'playbook',
      principalId: 'svc-playbooks',
      surface: 'memory',
      conversation: 'playbook:nightly',
    });
    const [run] = await db.select().from(runs);
    expect(run).toMatchObject({ principalId: 'svc-playbooks', threadId: thread.id, status: 'done' });
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.tool, 'deadlines_upcoming'));
    expect(audit).toMatchObject({
      caller: 'svc-playbooks',
      runId: run.id,
      skill: 'credentialing-expirations',
      skillVersion: '1.0.0',
    });
    // deliver: none — recorded, posted nowhere.
    expect(f.surface.texts).toEqual([]);
    expect(f.surface.streams).toEqual([]);
    const stored = await db.select().from(messages).where(eq(messages.threadId, thread.id)).orderBy(messages.seq);
    expect(stored.map((m) => [m.role, m.principalId])).toEqual([
      ['host', 'svc-playbooks'],
      ['assistant', 'svc-playbooks'],
    ]);
    expect(stored[0].content).toBe(NIGHTLY.prompt);
    const request = f.runtime.requests[0];
    expect(request.principal.id).toBe('svc-playbooks');
    expect(request.skills.map((s) => s.name)).toEqual(['credentialing-expirations']);
    expect(request.budget.timeoutMs).toBe(300_000);
    expect(request.model.user).toBe('svc-playbooks');
    const [firing] = await db.select().from(playbookRuns);
    expect(firing).toMatchObject({ status: 'done', attempts: 1, runId: run.id, error: null });
    expect(firing.scheduledAt.toISOString()).toBe('2026-09-15T12:00:00.000Z');
    const [row] = await db.select().from(playbooks);
    expect(row.lastStatus).toBe('done');
    expect(row.nextRunAt?.toISOString()).toBe('2026-09-16T07:00:00.000Z');
    expect(await db.select().from(toolEffects)).toEqual([]);
  });

  it('records a failed preflight, makes no model call, and stages exactly one notice', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'never' }] });
    await due(f, { ...NIGHTLY, skill: 'no-such-skill' });
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toEqual({ claimed: 1, done: 0, failed: 0, preflightFailed: 1 });
    } finally {
      await scheduler.stop();
    }
    expect(f.runtime.requests).toHaveLength(0);
    expect(await db.select().from(runs)).toHaveLength(0);
    const [firing] = await db.select().from(playbookRuns);
    expect(firing).toMatchObject({
      status: 'preflight_failed',
      attempts: 0,
      runId: null,
      error: 'skill "no-such-skill" is not in the loaded skill catalogue',
    });
    const [effect] = await db.select().from(toolEffects);
    expect(effect).toMatchObject({
      sink: 'surface_message',
      tool: 'scheduler',
      status: 'staged',
      idempotencyKey: 'test:playbook:nightly:2026-09-15T12:00:00.000Z',
      runId: null,
    });
    expect(effect.summary).toBe('Playbook "nightly" failure notice');
    // The same firing, noticed again, stages nothing new.
    const [playbook] = await db.select().from(playbooks);
    const again = await stagePlaybookNotice(f.host, {
      playbook,
      scheduledAt: firing.scheduledAt,
      runId: null,
      threadId: null,
      text: 'Playbook "nightly" scheduled for 2026-09-15T12:00:00.000Z did not run: skill "no-such-skill" is not in the loaded skill catalogue.',
    });
    expect(again.staged).toBe(false);
    expect(await db.select().from(toolEffects)).toHaveLength(1);
  });

  it('retries once when the runtime fails, and records both runs', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'unused' }] });
    f.host.runtime = sequenced(
      [{ type: 'error', message: RUN_FAILED_MESSAGE }],
      [
        { type: 'text', delta: 'Nothing to report.' },
        { type: 'done', text: 'Nothing to report.' },
      ],
    );
    await due(f, { ...NIGHTLY, skill: 'sample-skill' });
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toEqual({ claimed: 1, done: 1, failed: 0, preflightFailed: 0 });
    } finally {
      await scheduler.stop();
    }
    const all = await db.select().from(runs).orderBy(runs.startedAt);
    expect(all.map((r) => r.status)).toEqual(['error', 'done']);
    const [firing] = await db.select().from(playbookRuns);
    expect(firing).toMatchObject({ status: 'done', attempts: 2, runId: all[1].id, error: null });
    expect(await db.select().from(toolEffects)).toEqual([]);
  });

  it('does not retry a run that spent its budget, records the failure, and stages one notice', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'unused' }] });
    f.host.runtime = sequenced([{ type: 'error', message: 'the run exceeded its budget' }]);
    await due(f, { ...NIGHTLY, skill: 'sample-skill' });
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toEqual({ claimed: 1, done: 0, failed: 1, preflightFailed: 0 });
    } finally {
      await scheduler.stop();
    }
    expect(await db.select().from(runs)).toHaveLength(1);
    const [firing] = await db.select().from(playbookRuns);
    expect(firing).toMatchObject({ status: 'failed', attempts: 1, error: 'the run exceeded its budget' });
    const [effect] = await db.select().from(toolEffects);
    expect(effect).toMatchObject({
      sink: 'surface_message',
      idempotencyKey: 'test:playbook:nightly:2026-09-15T12:00:00.000Z',
    });
    expect(effect.runId).toBe(firing.runId);
    expect((await db.select().from(playbooks))[0].lastStatus).toBe('failed');
  });

  it('gives up after the second failure with one notice, not two', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'unused' }] });
    f.host.runtime = sequenced([{ type: 'error', message: RUN_FAILED_MESSAGE }]);
    await due(f, { ...NIGHTLY, skill: 'sample-skill' });
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toEqual({ claimed: 1, done: 0, failed: 1, preflightFailed: 0 });
    } finally {
      await scheduler.stop();
    }
    expect(await db.select().from(runs)).toHaveLength(2);
    expect((await db.select().from(playbookRuns))[0]).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await db.select().from(toolEffects)).toHaveLength(1);
  });

  it('posts the reply to the named conversation under deliver: conversation, and to the primary default without one', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'Two renewals.' }], streaming: true });
    // Both in one sync: a sync is the whole file, and a second sync naming only `weekly` would disable `nightly`.
    await syncPlaybooks(db, { client: 'test', now: f.host.now() }, [
      { ...NIGHTLY, skill: 'sample-skill', deliver: 'conversation', conversation: 'C-ops' },
      { ...NIGHTLY, name: 'weekly', skill: 'sample-skill', deliver: 'conversation' },
    ]);
    await db.update(playbooks).set({ nextRunAt: f.host.now() });
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toMatchObject({ claimed: 2, done: 2 });
    } finally {
      await scheduler.stop();
    }
    expect(f.surface.streams).toEqual([]);
    expect(f.surface.texts.map((t) => [t.conversation, t.text]).sort()).toEqual([
      ['C-ops', 'Two renewals.'],
      ['memory', 'Two renewals.'],
    ]);
  });

  it('keeps the loop when a tick throws, logging it once, so the next tick claims normally', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'ok' }] });
    await due(f, { ...NIGHTLY, skill: 'sample-skill' });
    const errors: string[] = [];
    f.host.log = { info() {}, warn() {}, error: (message: string) => errors.push(message) };
    f.host.db = deadlockOnce(db);
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toEqual({ claimed: 0, done: 0, failed: 0, preflightFailed: 0 });
      expect(scheduler.status()).toMatchObject({
        lastError: 'deadlock detected',
        lastErrorAt: '2026-09-15T12:00:00.000Z',
        ticking: false,
      });
      expect(errors).toEqual(['scheduler tick failed: deadlock detected']);
      expect(await scheduler.tick()).toEqual({ claimed: 1, done: 1, failed: 0, preflightFailed: 0 });
    } finally {
      await scheduler.stop();
    }
    // A tick that works again clears the error it kept, and the firing the failed tick never claimed ran.
    expect(scheduler.status().lastError).toBe(null);
    expect((await db.select().from(playbookRuns))[0].status).toBe('done');
  });

  it('retries exactly the transport failure the runtime contract names, and no other error', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'unused' }] });
    f.host.runtime = sequenced([{ type: 'error', message: RUN_FAILED_MESSAGE }], [{ type: 'done', text: 'ok' }]);
    await due(f, { ...NIGHTLY, skill: 'sample-skill' });
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toMatchObject({ done: 1 });
      // A message that is not the contract's own is the run's verdict, whatever it resembles.
      f.host.runtime = sequenced([{ type: 'error', message: `${RUN_FAILED_MESSAGE}, reworded` }]);
      await db.update(playbooks).set({ nextRunAt: f.host.now() });
      expect(await scheduler.tick()).toMatchObject({ failed: 1 });
    } finally {
      await scheduler.stop();
    }
    const firings = await db.select().from(playbookRuns);
    expect(firings.map((r) => [r.status, r.attempts]).sort()).toEqual([
      ['done', 2],
      ['failed', 1],
    ]);
    expect(await db.select().from(runs)).toHaveLength(3);
  });

  it('records a firing the host refused because it had begun draining, and never retries it', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'unused' }] });
    await due(f, { ...NIGHTLY, skill: 'sample-skill' });
    // The shutdown has started: `serialize` refuses the turn, so no run opens and no model is called.
    f.host.draining = true;
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toEqual({ claimed: 1, done: 0, failed: 1, preflightFailed: 0 });
    } finally {
      await scheduler.stop();
    }
    expect(f.runtime.requests).toHaveLength(0);
    expect(await db.select().from(runs)).toHaveLength(0);
    const [firing] = await db.select().from(playbookRuns);
    expect(firing).toMatchObject({
      status: 'failed',
      attempts: 1,
      runId: null,
      error: 'the host stopped before the run finished',
    });
    // The one notice says what happened, in the shutdown's own words rather than a crash's.
    const effects = await db.select().from(toolEffects);
    expect(effects).toHaveLength(1);
    expect(JSON.parse(decrypt(effects[0].payloadEncrypted, f.host.config.encryptionKey))).toMatchObject({
      text: 'Playbook "nightly" scheduled for 2026-09-15T12:00:00.000Z failed after 1 attempt(s): the host stopped before the run finished. See the host log and the playbook_runs table.',
    });
  });

  it("records a firing whose turn was already running when the drain aborted it mid-run, under the drain's own words (I2)", async () => {
    const f = await hostFixture(db, { trajectory: [{ sleep: 150 }, { say: 'late' }] });
    await due(f, { ...NIGHTLY, skill: 'sample-skill' });
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    const tick = scheduler.tick();
    await waitFor(() => f.host.active.size === 1);
    expect(f.host.active.size).toBe(1);
    // The shutdown begins while the turn is already running, unlike the refused-turn case above:
    // `drainActive` aborts it mid-flight, the same as a real shutdown racing a slow tool call.
    await drainActive(f.host, 1_000);
    try {
      expect(await tick).toEqual({ claimed: 1, done: 0, failed: 1, preflightFailed: 0 });
    } finally {
      await scheduler.stop();
    }
    const [firing] = await db.select().from(playbookRuns);
    expect(firing).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: 'the host stopped before the run finished',
    });
    expect(firing.runId).not.toBeNull();
    // The one notice says what happened, in the shutdown's own words rather than "cancelled".
    const effects = await db.select().from(toolEffects);
    expect(effects).toHaveLength(1);
    expect(JSON.parse(decrypt(effects[0].payloadEncrypted, f.host.config.encryptionKey))).toMatchObject({
      text: 'Playbook "nightly" scheduled for 2026-09-15T12:00:00.000Z failed after 1 attempt(s): the host stopped before the run finished. See the host log and the playbook_runs table.',
    });
  });

  it('stop() waits for the tick in flight, so a shutdown never leaves a firing half-recorded', async () => {
    const f = await hostFixture(db, { trajectory: [{ sleep: 150 }, { say: 'late' }] });
    await due(f, { ...NIGHTLY, skill: 'sample-skill' });
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    const tick = scheduler.tick();
    await waitFor(() => scheduler.status().ticking);
    expect(scheduler.status().ticking).toBe(true);
    await scheduler.stop();
    // Before `await tick`: this is the state that exists the instant `stop()` resolves, so a
    // `stop()` that did not wait for the tick in flight fails here rather than passing by luck.
    expect((await db.select().from(playbookRuns))[0].status).toBe('done');
    expect(await tick).toMatchObject({ claimed: 1, done: 1 });
  });

  it('fires from its interval too', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'ok' }] });
    await due(f, { ...NIGHTLY, skill: 'sample-skill' });
    const scheduler = startScheduler(f.host, { tickMs: 20 });
    try {
      await waitFor(() => scheduler.status().lastOkAt !== null);
    } finally {
      await scheduler.stop();
    }
    expect((await db.select().from(playbookRuns))[0].status).toBe('done');
    expect(await db.select().from(runs)).toHaveLength(1);
  });

  it('claims a run requested through playbooks_run_now on its next tick, ahead of the schedule', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'ok' }] });
    // Synced but not due: tomorrow's 07:00.
    await syncPlaybooks(db, { client: 'test', now: f.host.now() }, [{ ...NIGHTLY, skill: 'sample-skill' }]);
    const [playbook] = await db.select().from(playbooks);
    const requested = await requestPlaybookRun(db, {
      client: 'test',
      playbookId: playbook.id,
      now: f.host.now(),
      requestedBy: 'u-practice-manager',
    });
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toEqual({ claimed: 1, done: 1, failed: 0, preflightFailed: 0 });
    } finally {
      await scheduler.stop();
    }
    const [firing] = await db.select().from(playbookRuns);
    expect(firing).toMatchObject({ id: requested.id, status: 'done', attempts: 1, requestedBy: 'u-practice-manager' });
    expect(firing.runId).not.toBeNull();
    // The schedule itself was not consumed.
    expect((await db.select().from(playbooks))[0].nextRunAt?.toISOString()).toBe('2026-09-16T07:00:00.000Z');
  });
});

/**
 * The end of the chain the shipped demo actually runs, over the shipped files rather than fixtures.
 *
 * `preflightPlaybook` asks whether the skill, the principal and the surface exist; it never asks
 * whether policy will let the run's tool call through. So a playbook can pass preflight, start on
 * schedule, have its one tool call refused, and — with `deliver: none` — tell nobody. That is
 * exactly what `knowledge_sync` did while it was an `admin`-class tool, because `admin` is
 * `blocked` for `service` and `service` is the level every scheduled job runs at.
 *
 * This ties the three shipped files together: the playbook entry from `playbooks.yaml`, the policy
 * from `policy.yaml`, and the knowledge folder the sync reads. It fails if any one of them moves
 * out from under the other two.
 */
describe('the shipped knowledge-sync playbook (I1)', () => {
  const demoClientDir = path.join(repoRoot, 'clients', 'demo-practice');

  it('runs its sync unattended as svc-playbooks, with the shipped policy deciding auto', async () => {
    // The embedder the sync calls. Nothing else in this test reaches the gateway.
    const fake = await startFakeGateway();
    onTestFinished(() => fake.close());

    const text = await readFile(path.join(demoClientDir, 'playbooks.yaml'), 'utf8');
    const shipped = parsePlaybooksFile(parseYaml(text));
    const definition = shipped.find((p) => p.name === 'knowledge-sync');
    expect(definition, 'clients/demo-practice/playbooks.yaml must still ship knowledge-sync').toBeDefined();

    const f = await hostFixture(db, {
      trajectory: [
        { skill: 'knowledge-sync', version: '1.0.0' },
        { tool: 'knowledge_sync', args: {} },
        { say: 'Nothing to report.' },
      ],
      // Built the way main.ts builds it, because the skill this playbook names is the kernel's own.
      skills: await readSkillCatalogue([kernelSkillsDir(), ...testKernelConfig(db).packs.skillsDirs()]),
    });
    // The deployment's own policy and its own knowledge folder, so the decision under test is the
    // one a deployment makes rather than the fixture default.
    f.host.config = {
      ...f.host.config,
      // The deployment's `policy.classes`, as a literal: `@harness/config-api` validates that
      // section and `mergePolicy` applies it, so nothing here reads a policy file.
      policy: mergePolicy(DEFAULT_POLICY, {
        classes: {
          read: 'auto',
          'write.internal': 'auto',
          external: 'approval',
          financial: 'blocked',
          destructive: 'approval',
        },
      }),
      knowledgeDir: path.join(demoClientDir, 'knowledge'),
      gateway: { ...f.host.config.gateway, baseUrl: fake.url },
    };

    await due(f, definition);
    const scheduler = startScheduler(f.host, { tickMs: 3_600_000 });
    try {
      expect(await scheduler.tick()).toEqual({ claimed: 1, done: 1, failed: 0, preflightFailed: 0 });
    } finally {
      await scheduler.stop();
    }

    const [run] = await db.select().from(runs);
    expect(run).toMatchObject({ principalId: 'svc-playbooks', status: 'done' });
    // The assertion that would have failed before the class moved: `auto`, not `blocked`.
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.tool, 'knowledge_sync'));
    expect(audit).toMatchObject({
      caller: 'svc-playbooks',
      runId: run.id,
      decision: 'auto',
      actionClass: 'write.internal',
      skill: 'knowledge-sync',
      error: null,
    });
    // And it did the work, rather than merely being permitted to: both shipped documents indexed.
    const indexed = await db.select().from(knowledgeDocuments);
    expect(indexed.map((d) => d.path).sort()).toEqual(['escalation-and-billing.md', 'front-desk.md']);
    // deliver: none — recorded, posted nowhere, exactly as the silence doctrine requires.
    expect(f.surface.texts).toEqual([]);
  });
});
