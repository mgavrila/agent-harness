import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { RunEvent, RuntimeSession } from '@harness/runtime-api';
import { approvals, auditLog, memoryEntries, messages, runs, threads } from '@harness/db';
import { COORDINATOR, hostFixture, useTestDb, type HostFixture } from '../testing.js';
import {
  TIMEOUT_MARGIN_MS,
  UNAUTHORISED_TEXT,
  attachMessageHandlers,
  cancelRun,
  drainActive,
  runTurn,
  type TurnDelivery,
  type TurnInput,
} from './conversation.js';
import { findOrCreateThread } from './threads/repository.js';
import * as threadsRepository from './threads/repository.js';
import { HISTORY_MAX_CHARS } from './threads/trim.js';

const db = useTestDb();

/** Poll until `ready` holds, so a test waits on the signal it means rather than on a fixed delay. */
async function waitFor(ready: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('a message on a surface', () => {
  it('runs as the resolved principal, replies once on a surface without streaming, and records both turns', async () => {
    const f = await hostFixture(db, {
      trajectory: [{ tool: 'harness_reconcile', args: { stale_after_minutes: 10 } }, { say: 'Nothing was stale.' }],
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'Anything stale?');

    expect(f.surface.texts).toEqual([{ conversation: 'memory', text: 'Nothing was stale.', replyTo: null }]);
    const [thread] = await db.select().from(threads);
    expect(thread).toMatchObject({
      client: 'test',
      surface: 'memory',
      conversation: 'memory',
      principalId: 'u-coordinator',
      kind: 'chat',
    });
    const rows = await db.select().from(messages).where(eq(messages.threadId, thread.id)).orderBy(messages.createdAt);
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ['user', 'Anything stale?'],
      ['assistant', 'Nothing was stale.'],
    ]);
    const [run] = await db.select().from(runs);
    expect(run).toMatchObject({
      principalId: 'u-coordinator',
      threadId: thread.id,
      surface: 'memory',
      conversation: 'memory',
      status: 'done',
    });
    expect(rows.every((r) => r.runId === run.id)).toBe(true);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(audit).toMatchObject({ caller: 'u-coordinator', runId: run.id });
    // The runtime was handed this run's kernel, the persona, the skills and the principal as the model user.
    const request = f.runtime.requests[0];
    expect(request.principal.id).toBe('u-coordinator');
    expect(request.model).toMatchObject({ route: 'chat', fallbackRoute: 'reason', user: 'u-coordinator' });
    expect(request.persona).toBe('You are the test assistant.');
    expect(request.skills.map((s) => s.name)).toEqual(['sample-skill']);
    expect(request.threadId).toBe(thread.id);
    expect(request.runId).toBe(run.id);
  });

  it('refuses a user the identity plug-in does not know, runs nothing, and audits the refusal', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'never' }] });
    attachMessageHandlers(f.host);
    await f.surface.say('U999', 'hello?');
    expect(f.surface.texts).toEqual([{ conversation: 'memory', text: UNAUTHORISED_TEXT, replyTo: null }]);
    expect(f.runtime.requests).toHaveLength(0);
    expect(await db.select().from(runs)).toHaveLength(0);
    const [audit] = await db.select().from(auditLog);
    expect(audit).toMatchObject({ decision: 'unauthorised', caller: 'memory:U999', tool: 'host_message' });
    expect(audit.runId).toBeNull();
  });

  it('stays silent in a group conversation unless mentioned', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'hi' }] });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'chatter', { mentioned: false, conversation: 'C1' });
    expect(f.runtime.requests).toHaveLength(0);
    await f.surface.say('U012', '@bot hi', { mentioned: true, conversation: 'C1' });
    expect(f.runtime.requests).toHaveLength(1);
    expect(f.surface.texts[0]).toMatchObject({ conversation: 'C1', text: 'hi' });
  });

  it('streams when the surface can, and posts the withheld marker in place of a reply that trips the redaction check', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'Part one.' }, { say: 'Part two.' }], streaming: true });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'go');
    expect(f.surface.streams).toEqual([
      { conversation: 'memory', text: 'Part one.Part two.', ended: true, replyTo: null },
    ]);
    expect(f.surface.texts).toHaveLength(1);

    const g = await hostFixture(db, { trajectory: [{ say: 'The SSN is 123-45-6789.' }] });
    attachMessageHandlers(g.host);
    await g.surface.say('U012', 'tell me');
    expect(g.surface.texts.at(-1)?.text).toBe('(withheld: it did not pass the redaction check)');
    const rows = await db.select().from(messages);
    expect(rows.some((r) => r.content.includes('123-45'))).toBe(false);
  });

  it('carries the prior turns of the thread as history, trimmed, and the attachments on the input', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'ok' }], budget: { maxHistoryMessages: 2 } });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'first');
    await f.surface.say('U012', 'second', { attachments: [{ name: 'w9.pdf', path: 'w9.pdf' }] });
    const request = f.runtime.requests[1];
    expect(request.history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
    ]);
    expect(request.input).toEqual({ text: 'second', attachments: [{ name: 'w9.pdf', path: 'w9.pdf' }] });
  });

  it('stamps the skill on the run context when the runtime activates one', async () => {
    const f = await hostFixture(db, {
      trajectory: [
        { skill: 'sample-skill', version: '1.0.0' },
        { tool: 'harness_reconcile', args: { stale_after_minutes: 10 } },
        { say: 'done' },
      ],
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'roster please');
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_reconcile'));
    expect(audit).toMatchObject({ skill: 'sample-skill', skillVersion: '1.0.0' });
  });

  it('parks an action for approval with the thread on the row, and the turn ends normally', async () => {
    const f = await hostFixture(db, {
      trajectory: [
        { tool: 'harness_notify', args: { text: 'roster ready', idempotency_key: 'roster:1' } },
        { say: 'It is waiting for approval.' },
      ],
      principals: [{ ...COORDINATOR, level: 'member' }],
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'send the roster');
    const [parked] = await db.select().from(approvals);
    const [thread] = await db.select().from(threads);
    expect(parked).toMatchObject({ status: 'pending', requestedBy: 'u-coordinator', threadId: thread.id });
    expect(f.surface.texts.at(-1)?.text).toBe('It is waiting for approval.');
  });

  it('cancels a run in flight: no reply, status cancelled', async () => {
    const f = await hostFixture(db, { trajectory: [{ sleep: 10_000 }, { say: 'never' }] });
    attachMessageHandlers(f.host);
    const turn = f.surface.say('U012', 'slow one');
    await new Promise((r) => setTimeout(r, 50));
    const [run] = await db.select().from(runs);
    expect(cancelRun(f.host, run.id)).toBe(true);
    await turn;
    expect(f.surface.texts).toEqual([]);
    const [after] = await db.select().from(runs);
    expect(after.status).toBe('cancelled');
    expect(f.host.active.size).toBe(0);
    expect(cancelRun(f.host, run.id)).toBe(false);
  });

  it('records an error status and tells the human once when the runtime fails', async () => {
    // `timeoutMarginMs: 0` arms the host's backstop at the budget itself: the scripted runtime has
    // no timeout of its own to fire first, so the margin would only make the test wait for it.
    const f = await hostFixture(db, {
      trajectory: [{ sleep: 10_000 }],
      budget: { timeoutMs: 20, timeoutMarginMs: 0 },
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'hang');
    const [run] = await db.select().from(runs);
    expect(run.status).toBe('error');
    expect(f.surface.texts).toHaveLength(1);
    expect(f.surface.texts[0].text).toContain('cancelled');
  });

  it('closes the kernel and marks the run error, leaking neither the controller nor the run, when recording the reply fails', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'hi' }] });
    attachMessageHandlers(f.host);
    const original = threadsRepository.appendMessage;
    const spy = vi.spyOn(threadsRepository, 'appendMessage').mockImplementation(async (dbArg, m) => {
      if (m.role === 'assistant') throw new Error('simulated insert failure');
      return original(dbArg, m);
    });
    try {
      await f.surface.say('U012', 'go');
    } finally {
      spy.mockRestore();
    }
    const [run] = await db.select().from(runs);
    expect(run.status).toBe('error');
    expect(run.endedAt).not.toBeNull();
    expect(f.host.active.size).toBe(0);
  });

  it('posts the stopped notice as a reply once a stream has already begun', async () => {
    const f = await hostFixture(db, {
      trajectory: [{ say: 'Part one.' }, { sleep: 10_000 }],
      streaming: true,
      budget: { timeoutMs: 20, timeoutMarginMs: 0 },
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'go');
    const [run] = await db.select().from(runs);
    expect(run.status).toBe('error');
    expect(f.surface.streams).toEqual([{ conversation: 'memory', text: 'Part one.', ended: true, replyTo: null }]);
    expect(f.surface.texts).toHaveLength(2);
    expect(f.surface.texts[0].text).toBe('Part one.');
    expect(f.surface.texts[1].text).toContain('cancelled');
    expect(f.surface.texts[1].replyTo).toEqual({ surface: 'memory', conversation: 'memory', id: 'm1' });
  });
});

describe('two turns on one thread', () => {
  it('runs them one at a time, in the order they arrived, and lets the second see the first in its history', async () => {
    const f = await hostFixture(db, {
      trajectory: (request) => (request.input.text === 'first' ? [{ sleep: 150 }, { say: 'one' }] : [{ say: 'two' }]),
    });
    attachMessageHandlers(f.host);
    // Both messages are in flight at once, the way two Slack messages a moment apart arrive.
    const turns = [f.surface.say('U012', 'first'), f.surface.say('U012', 'second')];
    await new Promise((r) => setTimeout(r, 60));
    // The second turn has not opened a run while the first is still inside the runtime.
    expect(f.runtime.requests.map((r) => r.input.text)).toEqual(['first']);
    await Promise.all(turns);

    expect(f.runtime.requests.map((r) => r.input.text)).toEqual(['first', 'second']);
    expect(f.runtime.requests[1].history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one' },
    ]);
    expect(await db.select().from(threads)).toHaveLength(1);
    expect(f.surface.texts.map((t) => t.text)).toEqual(['one', 'two']);
  });

  it('still runs two conversations at the same time', async () => {
    const f = await hostFixture(db, { trajectory: [{ sleep: 150 }, { say: 'done' }] });
    attachMessageHandlers(f.host);
    const turns = [
      f.surface.say('U012', 'in C1', { conversation: 'C1' }),
      f.surface.say('U012', 'in C2', { conversation: 'C2' }),
    ];
    await new Promise((r) => setTimeout(r, 60));
    expect(f.runtime.requests.map((r) => r.input.text).sort()).toEqual(['in C1', 'in C2']);
    await Promise.all(turns);
    expect(await db.select().from(runs)).toHaveLength(2);
  });
});

describe('drainActive', () => {
  it('cancels every run in flight and returns only once its row is closed', async () => {
    const f = await hostFixture(db, { trajectory: [{ sleep: 10_000 }, { say: 'never' }] });
    attachMessageHandlers(f.host);
    const turn = f.surface.say('U012', 'slow one');
    await new Promise((r) => setTimeout(r, 50));
    expect(f.host.active.size).toBe(1);

    await drainActive(f.host, 10_000);

    // Shutdown stops the runtime next, so the row has to be closed by the time this returns.
    const [run] = await db.select().from(runs);
    expect(run.status).toBe('cancelled');
    expect(run.endedAt).not.toBeNull();
    expect(f.host.active.size).toBe(0);
    await turn;
    expect(f.surface.texts).toEqual([]);
  });

  it('refuses a turn queued behind a draining one instead of opening a run after shutdown', async () => {
    const f = await hostFixture(db, {
      trajectory: (request) => (request.input.text === 'first' ? [{ sleep: 10_000 }] : [{ say: 'two' }]),
    });
    attachMessageHandlers(f.host);
    // Wait for the first turn's run to be in flight rather than for a fixed delay, and only then
    // send the second: under full-suite load the run can take well over 50 ms to open, and both
    // messages started together reach the thread's chain in whichever order their identity and
    // thread lookups finish in, so "second" could be the turn that runs.
    const first = f.surface.say('U012', 'first');
    await waitFor(() => f.host.active.size === 1);
    const second = f.surface.say('U012', 'second');

    await drainActive(f.host, 10_000);
    await Promise.all([first, second]);

    // The second turn was next on the thread's chain; starting it now would open a run against a
    // runtime and a pool the caller is about to stop.
    const rows = await db.select().from(runs);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('cancelled');
    expect(f.runtime.requests.map((r) => r.input.text)).toEqual(['first']);
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(f.surface.texts).toEqual([]);
  });

  it('gives up on a turn that does not end within the bound rather than blocking shutdown', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'unused' }] });
    const controller = new AbortController();
    f.host.active.set('stuck', { controller, done: new Promise<void>(() => {}) });
    const started = Date.now();
    await drainActive(f.host, 50);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(controller.signal.aborted).toBe(true);
  });

  it('returns at once when nothing is in flight', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'unused' }] });
    await expect(drainActive(f.host, 10_000)).resolves.toBeUndefined();
  });
});

describe("the host's timeout backstop", () => {
  it("is armed a margin after the budget, so the runtime's own timeout is the one that fires", async () => {
    // The runtime arms `AbortSignal.timeout(budget.timeoutMs)`; the host's timer is the backstop
    // for a runtime that ignores it, and firing first would replace "the run timed out" with
    // "cancelled" for the human.
    expect(TIMEOUT_MARGIN_MS).toBe(5_000);
    const f = await hostFixture(db, {
      trajectory: [{ sleep: 120 }, { say: 'in time' }],
      budget: { timeoutMs: 20, timeoutMarginMs: 200 },
    });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'go');
    const [run] = await db.select().from(runs);
    expect(run.status).toBe('done');
    expect(f.surface.texts.map((t) => t.text)).toEqual(['in time']);
  });
});

describe('memory on the run', () => {
  it('hands the runtime the caller snapshot, rendered once before the run and never mid-run', async () => {
    const f = await hostFixture(db, {
      trajectory: [{ tool: 'memory_add', args: { text: 'Prefers bullet points.' } }, { say: 'Noted.' }],
    });
    attachMessageHandlers(f.host);
    await db.insert(memoryEntries).values({
      client: 'test',
      scope: 'client',
      principalId: null,
      text: 'The office closes at five.',
      createdBy: 'u-coordinator',
    });
    await f.surface.say('U012', 'remember that I like bullets');
    expect(f.runtime.requests[0].memory).toContain('- The office closes at five. (id: ');
    // Added during the turn, so not in this turn's snapshot: frozen for the run.
    expect(f.runtime.requests[0].memory).not.toContain('Prefers bullet points.');
    await f.surface.say('U012', 'and now?');
    expect(f.runtime.requests[1].memory).toContain('## Your notes (principal scope)\n- Prefers bullet points. (id: ');
  });

  it('keeps a remembered fact across a restart, and away from another principal (the exit criterion)', async () => {
    const first = await hostFixture(db, {
      trajectory: [{ tool: 'memory_add', args: { text: 'Prefers bullet points.' } }, { say: 'Noted.' }],
    });
    attachMessageHandlers(first.host);
    await first.surface.say('U012', 'remember that I like bullets');
    await first.close();
    // A second host over the same database is a restart: nothing survives but the tables.
    const second = await hostFixture(db, { trajectory: [{ say: 'hi' }] });
    attachMessageHandlers(second.host);
    await second.surface.say('U012', 'hello again');
    expect(second.runtime.requests[0].memory).toContain('Prefers bullet points.');
    await second.surface.say('U345', 'hello from someone else');
    expect(second.runtime.requests[1].memory).toBe('');
  });
});

describe('the history budget', () => {
  it('is spent on history only, never on the message being run', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'ok' }] });
    attachMessageHandlers(f.host);
    await f.surface.say('U012', 'first');
    await f.surface.say('U012', 'x'.repeat(HISTORY_MAX_CHARS + 1_000));
    expect(f.runtime.requests[1].history).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
    ]);
  });
});

describe('cancelRun after the backstop', () => {
  it('refuses to cancel a run the host timeout already ended', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'unused' }] });
    const controller = new AbortController();
    controller.abort('timeout');
    f.host.active.set('r1', { controller, done: Promise.resolve() });
    expect(cancelRun(f.host, 'r1')).toBe(false);
    // The turn's own `finally` removes the entry; a refused cancel leaves it alone.
    expect(f.host.active.has('r1')).toBe(true);
  });
});

/** A runtime that reports spend, then waits for the abort the host owes it, then ends cancelled. */
function spender(costUsd: number): RuntimeSession {
  return {
    name: 'spender',
    run: (request) => ({
      events: (async function* (): AsyncGenerator<RunEvent> {
        yield { type: 'usage', inputTokens: 1, outputTokens: 1, costUsd };
        if (!request.signal.aborted) {
          await new Promise<void>((resolve) =>
            request.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
        yield { type: 'error', message: 'cancelled' };
      })(),
    }),
    stop: async () => {},
  };
}

describe('where a turn delivers', () => {
  async function turnOn(f: HostFixture, deliver: TurnDelivery, extra: Partial<TurnInput> = {}) {
    const thread = await findOrCreateThread(db, {
      client: 'test',
      surface: 'memory',
      conversation: 'memory',
      principalId: 'u-coordinator',
    });
    return runTurn(f.host, {
      thread,
      principal: COORDINATOR,
      role: 'host',
      text: 'go',
      attachments: [],
      replyTo: null,
      deliver,
      ...extra,
    });
  }

  it("'none' records the reply and posts nothing, not even on a streaming surface", async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'Nothing to report.' }], streaming: true });
    const result = await turnOn(f, 'none');
    expect(result).toMatchObject({ status: 'done', text: 'Nothing to report.', error: null });
    expect(f.surface.texts).toEqual([]);
    expect(f.surface.streams).toEqual([]);
    expect((await db.select().from(messages)).map((m) => [m.role, m.content])).toEqual([
      ['host', 'go'],
      ['assistant', 'Nothing to report.'],
    ]);
  });

  it('a named conversation gets one post and no stream', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'Two renewals.' }], streaming: true });
    await turnOn(f, { surface: 'memory', conversation: 'C-ops' });
    expect(f.surface.streams).toEqual([]);
    expect(f.surface.texts).toEqual([{ conversation: 'C-ops', text: 'Two renewals.', replyTo: null }]);
  });

  it('a surface that is not loaded is refused before a run opens', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'never' }] });
    await expect(turnOn(f, { surface: 'nowhere', conversation: 'x' })).rejects.toThrow('which is not loaded');
    expect(await db.select().from(runs)).toHaveLength(0);
  });

  it('offers only the skills the turn names, and uses the turn timeout', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'ok' }] });
    const one = { name: 'only-this', version: '2.0.0', description: 'one skill', dir: '/nonexistent' };
    await turnOn(f, 'none', { skills: [one], timeoutMs: 45_000 });
    expect(f.runtime.requests[0].skills).toEqual([one]);
    expect(f.runtime.requests[0].budget.timeoutMs).toBe(45_000);
  });

  it('aborts a run whose reported spend passes the cost cap, and says so', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'unused' }] });
    f.host.runtime = spender(0.75);
    const result = await turnOn(f, 'none', { costCapUsd: 0.5 });
    expect(result).toMatchObject({
      status: 'error',
      error: 'the run exceeded its cost cap',
      text: 'The run stopped: the run exceeded its cost cap.',
    });
    const [run] = await db.select().from(runs);
    expect(run.status).toBe('error');
    expect(f.host.active.size).toBe(0);
  });

  it('reports the runtime fixed message on error, so a caller can decide on it', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'unused' }] });
    f.host.runtime = {
      name: 'broken',
      run: () => ({
        events: (async function* (): AsyncGenerator<RunEvent> {
          yield { type: 'error', message: 'the run failed; see the host log' };
        })(),
      }),
      stop: async () => {},
    };
    const result = await turnOn(f, 'none');
    expect(result).toMatchObject({ status: 'error', error: 'the run failed; see the host log' });
  });
});
