import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { approvals, memoryEntries, messages, runs, threads } from '@harness/db';
import type { Trajectory } from '@harness/runtime-api/testing';
import { COORDINATOR, MEMBER, poolFixture, useTestDb, type PoolFixture } from '../../testing.js';
import { WITHHELD } from '../threads/repository.js';
import { startRunApi } from './server.js';
import { API_MAX_BODY_BYTES, CLIENT_HEADER } from './types.js';
import { USAGE_DEFAULT_DAYS, USAGE_MAX_DAYS, type UsageRow } from './usage.js';

const db = useTestDb();
const TOKEN = 'sk-run-api-test';
/** The client this listener's one tenant serves; every route resolves it before it runs. */
const CLIENT = 'test';
/**
 * A usage window around the moment the case runs, inside the year the route allows.
 *
 * Built from the clock rather than written out, because a run's `started_at` is Postgres' own
 * `now()` — the fixture's frozen clock stamps what a turn decides, never what the database
 * defaults — so a window of fixed dates would age out of the suite.
 */
const WINDOW = (() => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  return `from=${new Date(now - day).toISOString()}&to=${new Date(now + day).toISOString()}`;
})();

interface Api {
  f: PoolFixture;
  url: string;
  open(body: unknown, token?: string): Promise<Response>;
  get(path: string, token?: string, headers?: Record<string, string>): Promise<Response>;
  post(path: string, token?: string): Promise<Response>;
}

/**
 * A dedicated host with one tenant, and the listener over its pool.
 *
 * The run API is per process and the tenants are per client, so the listener takes the pool and
 * resolves a tenant per request — which is why every case here drives a real pool rather than a
 * bare host.
 */
async function api(trajectory: Trajectory): Promise<Api> {
  const f = await poolFixture(db, {
    documents: [
      parseClientDocument(
        fixtureDocument({ id: CLIENT, displayName: 'Test', runtime: 'scripted', surfaces: { memory: {} } }),
      ),
    ],
    trajectories: { [CLIENT]: trajectory },
    dedicated: CLIENT,
  });
  const server = startRunApi(f.pool, { token: TOKEN, bind: '127.0.0.1', port: 0 });
  await server.ready;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    await server.close();
    await f.close();
  });
  const auth = (token = TOKEN): Record<string, string> => ({ authorization: `Bearer ${token}` });
  return {
    f,
    url,
    open: (body, token) =>
      fetch(`${url}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(token) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    get: (p, token, headers = {}) => fetch(`${url}${p}`, { headers: { ...auth(token), ...headers } }),
    post: (p, token) => fetch(`${url}${p}`, { method: 'POST', headers: auth(token) }),
  };
}

/** Frames as they arrive, so a test can act while the run is still in flight. */
async function* frames(response: Response): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const name = /^event: (.+)$/m.exec(frame);
      const data = /^data: (.+)$/m.exec(frame);
      if (name && data) yield { event: name[1], data: JSON.parse(data[1]) as Record<string, unknown> };
      end = buffer.indexOf('\n\n');
    }
  }
}

const collect = async (response: Response): Promise<{ event: string; data: Record<string, unknown> }[]> => {
  const all: { event: string; data: Record<string, unknown> }[] = [];
  for await (const frame of frames(response)) all.push(frame);
  return all;
};

/** The body a run is opened with: the coordinator, on the memory surface, in one conversation. */
const asCoordinator = (text: string): Record<string, unknown> => ({
  surface: 'memory',
  userId: COORDINATOR.surfaces.memory,
  conversation: 'memory',
  text,
});

describe('the run API: authorisation', () => {
  it('refuses every route without a token, and with the wrong one', async () => {
    const a = await api([]);
    for (const response of [
      await fetch(`${a.url}/v1/status`),
      await a.get('/v1/status', 'sk-wrong'),
      await a.open(asCoordinator('hello'), 'sk-wrong'),
    ]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorised' });
    }
  });

  it('refuses a surface user the identity plug-in does not know, without saying who does exist', async () => {
    const a = await api([]);
    const response = await a.open({ ...asCoordinator('hello'), userId: 'U-nobody' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'that surface user is not a principal of this deployment' });
  });

  it('refuses a surface that is not loaded, and a body that is not the shape', async () => {
    const a = await api([]);
    expect((await a.open({ ...asCoordinator('hello'), surface: 'nowhere' })).status).toBe(400);
    expect((await a.open({ surface: 'memory', userId: 'U012' })).status).toBe(400);
    expect((await a.open('not json')).status).toBe(400);
  });

  it('refuses a body over the cap', async () => {
    const a = await api([]);
    const huge = await a.open({ ...asCoordinator('x'), text: 'y'.repeat(API_MAX_BODY_BYTES + 10) });
    expect(huge.status).toBe(413);
  });

  it('refuses an attachment path that leaves the incoming directory', async () => {
    const a = await api([]);
    const escaping = await a.open({
      ...asCoordinator('here is a file'),
      attachments: [{ name: 'passwd', path: '../../../../etc/passwd' }],
    });
    expect(escaping.status).toBe(400);
    expect(await escaping.json()).toEqual({
      error: 'attachment "passwd" is not a path inside the incoming directory',
    });
  });
});

describe('the run API: a run', () => {
  it('streams the run id, the runtime events and the outcome, and records the turn on a thread', async () => {
    const a = await api([{ tool: 'audit_query', args: {} }, { say: 'nothing is overdue' }]);
    const response = await a.open(asCoordinator('anything overdue?'));
    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const all = await collect(response);
    expect(all[0].event).toBe('run');
    expect(typeof all[0].data.runId).toBe('string');
    expect(all.map((f) => f.event)).toEqual(['run', 'tool_call', 'tool_result', 'text', 'done', 'result']);
    expect(all.at(-1)!.data).toMatchObject({ status: 'done', text: 'nothing is overdue', error: null });

    // Recorded on a thread of its own, and posted to no surface: the stream is the reply.
    const [thread] = await db.select().from(threads).where(eq(threads.principalId, COORDINATOR.id));
    expect(thread).toMatchObject({ surface: 'memory', conversation: 'memory', kind: 'chat' });
    const rows = await db.select().from(messages).where(eq(messages.threadId, thread.id));
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(a.f.surface(CLIENT).texts).toEqual([]);
  });

  it('cancels a run in flight, by the id the first frame carried', async () => {
    const a = await api([{ sleep: 200 }, { say: 'too late' }]);
    const response = await a.open(asCoordinator('start something slow'));
    const seen: { event: string; data: Record<string, unknown> }[] = [];
    let runId = '';
    for await (const frame of frames(response)) {
      seen.push(frame);
      if (frame.event === 'run') {
        runId = frame.data.runId as string;
        const cancelled = await a.post(`/v1/runs/${runId}/cancel?surface=memory&userId=${COORDINATOR.surfaces.memory}`);
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toEqual({ run_id: runId, cancelled: true });
      }
    }
    expect(seen.at(-1)).toMatchObject({ event: 'result', data: { status: 'cancelled', error: 'cancelled' } });
  });

  it("answers 'no such run' for another principal's run, and for a malformed id", async () => {
    const a = await api([{ say: 'done' }]);
    const opened = await collect(await a.open(asCoordinator('hello')));
    const runId = opened[0].data.runId as string;
    const asMember = await a.post(`/v1/runs/${runId}/cancel?surface=memory&userId=${MEMBER.surfaces.memory}`);
    expect(asMember.status).toBe(404);
    expect(await asMember.json()).toEqual({ error: 'no such run' });
    expect(
      (await a.post(`/v1/runs/not-a-uuid/cancel?surface=memory&userId=${COORDINATOR.surfaces.memory}`)).status,
    ).toBe(404);
  });

  it('withholds a restricted value from the streamed text and from the outcome', async () => {
    // Invariant 10: a restricted value never leaves the process, on a `RunEvent` or anywhere else.
    // The delta is checked as it goes out and the outcome carries the reply already withheld, so
    // the digits appear in neither frame.
    const a = await api([{ say: 'the number is 123-45-6789' }]);
    const all = await collect(await a.open(asCoordinator('what is it?')));
    const text = all.find((f) => f.event === 'text');
    expect(text!.data.delta).toBe(WITHHELD);
    expect(all.at(-1)!.data.text).toBe(WITHHELD);
    // And nowhere else in the stream either, whatever frame it might have ridden out on.
    expect(JSON.stringify(all)).not.toContain('123-45-6789');
  });
});

describe('the run API: a thread and the status', () => {
  it("reads back the caller's own thread, newest message last", async () => {
    const a = await api([{ say: 'nothing is overdue' }]);
    await collect(await a.open(asCoordinator('anything overdue?')));
    const [thread] = await db.select().from(threads).where(eq(threads.principalId, COORDINATOR.id));

    const response = await a.get(`/v1/threads/${thread.id}?surface=memory&userId=${COORDINATOR.surfaces.memory}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      thread: { id: string; surface: string; conversation: string; kind: string };
      messages: { role: string; content: string }[];
    };
    expect(body.thread).toMatchObject({ id: thread.id, surface: 'memory', conversation: 'memory', kind: 'chat' });
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'anything overdue?'],
      ['assistant', 'nothing is overdue'],
    ]);
  });

  it("answers 'no such thread' for another principal's thread, never 403", async () => {
    const a = await api([{ say: 'done' }]);
    await collect(await a.open(asCoordinator('hello')));
    const [thread] = await db.select().from(threads).where(eq(threads.principalId, COORDINATOR.id));
    const response = await a.get(`/v1/threads/${thread.id}?surface=memory&userId=${MEMBER.surfaces.memory}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such thread' });
  });

  it('reports the surfaces, the runs in flight and the scheduler, and nothing about anyone', async () => {
    const a = await api([]);
    const response = await a.get('/v1/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      client: CLIENT,
      surfaces: ['memory'],
      primary_surface: 'memory',
      runs_in_flight: 0,
      draining: false,
      // The tenant's own scheduler, which is where it is reachable from now that there is one per
      // tenant rather than one per process. It has not ticked: the interval is thirty seconds.
      scheduler: { lastTickAt: null, lastOkAt: null, lastError: null, lastErrorAt: null, ticking: false },
    });
  });

  it('answers the tenant it serves when a caller names it, and 404 when a caller names another', async () => {
    const a = await api([]);
    // Naming this host's own client is the same request as naming none.
    expect((await a.get('/v1/status', TOKEN, { [CLIENT_HEADER]: CLIENT })).status).toBe(200);
    // Invariant 19 at the control plane: another client is "no such client", never this one's
    // status under another name, and never a 403 that would confirm the client exists.
    const other = await a.get('/v1/status', TOKEN, { [CLIENT_HEADER]: 'beta' });
    expect(other.status).toBe(404);
    expect(await other.json()).toEqual({ error: 'no such client' });
  });

  it('exports what this tenant used, per principal per day, and not a word of what anybody wrote', async () => {
    const a = await api([
      { usage: { inputTokens: 120, outputTokens: 34, costUsd: 0.002 } },
      { say: 'nothing is overdue' },
    ]);
    await collect(await a.open(asCoordinator('anything overdue?')));

    const response = await a.get(`/v1/usage?${WINDOW}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { client: string; from: string; to: string; rows: UsageRow[] };
    expect(body.client).toBe(CLIENT);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      client: CLIENT,
      principal_id: COORDINATOR.id,
      runs: 1,
      input_tokens: 120,
      output_tokens: 34,
      runs_done: 1,
    });
    // Invariant 16 on the wire, not just in the view: the question that was asked and the answer
    // that was given are both on the thread, and neither is in the export.
    expect(JSON.stringify(body)).not.toContain('anything overdue?');
    expect(JSON.stringify(body)).not.toContain('nothing is overdue');
  });

  it('reads whole UTC days, so a from inside today does not drop today', async () => {
    const a = await api([{ usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 } }, { say: 'done' }]);
    await collect(await a.open(asCoordinator('anything overdue?')));

    // Noon today and midnight tomorrow. The run's bucket is today's midnight, which is *before*
    // this `from` read as a timestamp and inside it read as a day — the whole of today's usage
    // would otherwise vanish from an invoice for anybody who asked after breakfast.
    const now = new Date();
    const utc = (dayOffset: number, hour = 0): Date =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, hour));
    const response = await a.get(`/v1/usage?from=${utc(0, 12).toISOString()}&to=${utc(1).toISOString()}`);
    const body = (await response.json()) as { from: string; to: string; rows: UsageRow[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // And the window the answer reports is the one it read: whole days, `to` still exclusive.
    expect(body.from).toBe(utc(0).toISOString());
    expect(body.to).toBe(utc(1).toISOString());
  });

  it('includes today in the window a request that names none gets', async () => {
    const a = await api([{ usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.001 } }, { say: 'done' }]);
    await collect(await a.open(asCoordinator('anything overdue?')));

    // No `from`, no `to`: the last thirty days, which has to end *after* today rather than at this
    // morning's midnight. A caller who asks at noon is asking about a day that is under way.
    const body = (await (await a.get('/v1/usage')).json()) as { from: string; to: string; rows: UsageRow[] };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ input_tokens: 10, output_tokens: 2 });
    const now = new Date();
    const utcDay = (offset: number): string =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString();
    expect(body.to).toBe(utcDay(1));
    expect(body.from).toBe(utcDay(-USAGE_DEFAULT_DAYS));
  });

  it('refuses a window that is not one, and one wider than a year', async () => {
    const a = await api([]);
    expect((await a.get('/v1/usage?from=not-a-date&to=2030-01-01')).status).toBe(400);
    expect((await a.get('/v1/usage?from=2030-01-01&to=2020-01-01')).status).toBe(400);
    const tooWide = await a.get('/v1/usage?from=2020-01-01&to=2026-01-01');
    expect(tooWide.status).toBe(400);
    expect(await tooWide.json()).toEqual({ error: `the window may not exceed ${USAGE_MAX_DAYS} days` });
  });

  it('reads no usage without a token', async () => {
    const a = await api([]);
    // Before anything is read: the bearer check is in front of every route, so a caller with no
    // token is told "unauthorised" and not how many rows there were to refuse.
    const response = await fetch(`${a.url}/v1/usage?${WINDOW}`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorised' });
  });

  it("answers 404 for a caller naming another client, and none of that client's usage", async () => {
    const a = await api([]);
    // A row that exists and belongs to somebody else. Naming that client is "no such client" on
    // this host, and the answer carries nothing of theirs (invariant 19).
    await db
      .insert(runs)
      .values({ client: 'beta', principalId: 'u-beta', status: 'done', inputTokens: 999, outputTokens: 999 });
    const response = await a.get(`/v1/usage?${WINDOW}`, TOKEN, { [CLIENT_HEADER]: 'beta' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such client' });
  });

  it('answers "no such route" for anything else', async () => {
    const a = await api([]);
    expect((await a.get('/v1/nothing')).status).toBe(404);
    expect((await a.get('/')).status).toBe(404);
  });
});

describe('the read routes', () => {
  /** One approval of the served client, and one of somebody else. */
  async function seed(): Promise<void> {
    for (const client of [CLIENT, 'other']) {
      await db.insert(approvals).values({
        client,
        action: 'forms_release',
        payload: { tool: 'forms_release', args: { file_id: 'roster/secret.csv' } },
        summary: `forms_release (external) requested by u-coordinator`,
        requestedBy: 'u-coordinator',
        idempotencyKey: `k-${client}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      await db.insert(memoryEntries).values({
        client,
        scope: 'client',
        text: `a note belonging to ${client}`,
        createdBy: 'u-coordinator',
      });
    }
  }

  it('answers both routes behind the bearer, and neither without it', async () => {
    const a = await api([]);
    for (const route of ['/v1/approvals', '/v1/memory']) {
      expect((await a.get(route)).status, route).toBe(200);
      expect((await a.get(route, 'wrong')).status, route).toBe(401);
      expect((await fetch(`${a.url}${route}`)).status, route).toBe(401);
    }
  });

  it('answers this tenant’s rows and none of another’s, in the envelope the platform pages on', async () => {
    const a = await api([]);
    await seed();
    const body = (await (await a.get('/v1/approvals')).json()) as {
      client: string;
      rows: { summary: string }[];
      next_cursor: string | null;
    };
    expect(body.client).toBe(CLIENT);
    expect(body.rows).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
    expect(JSON.stringify(body)).not.toContain('roster/secret.csv');
    const memory = (await (await a.get('/v1/memory')).json()) as { rows: { text: string }[] };
    expect(memory.rows.map((row) => row.text)).toEqual([`a note belonging to ${CLIENT}`]);
  });

  it('accepts the four status values, one or several, and refuses a fifth with a 400 naming them', async () => {
    const a = await api([]);
    for (const status of ['pending', 'approved', 'declined', 'expired', 'approved,declined']) {
      expect((await a.get(`/v1/approvals?status=${status}`)).status, status).toBe(200);
    }
    // There is no `decided` alias: a filter vocabulary that differs from the column is a second
    // spelling of one fact, and a platform engineer asking the obvious must not get a 400 for it.
    const refused = await a.get('/v1/approvals?status=decided');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain('pending');
  });

  it('refuses a scope that is not one, a cursor that does not decode and a limit out of bounds', async () => {
    const a = await api([]);
    expect((await a.get('/v1/memory?scope=everything')).status).toBe(400);
    expect((await a.get('/v1/approvals?cursor=nonsense')).status).toBe(400);
    for (const limit of ['0', '-1', '1.5', 'many', '501']) {
      expect((await a.get(`/v1/approvals?limit=${limit}`)).status, limit).toBe(400);
    }
    expect((await a.get('/v1/approvals?limit=500')).status).toBe(200);
  });

  it('pages, and hands back a cursor that fetches the rest', async () => {
    const a = await api([]);
    for (const n of [1, 2, 3]) {
      await db.insert(memoryEntries).values({
        client: CLIENT,
        scope: 'client',
        text: `note ${n}`,
        createdBy: 'u-coordinator',
      });
    }
    const first = (await (await a.get('/v1/memory?limit=2')).json()) as {
      rows: { text: string }[];
      next_cursor: string;
    };
    expect(first.rows).toHaveLength(2);
    const second = (await (
      await a.get(`/v1/memory?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`)
    ).json()) as {
      rows: { text: string }[];
      next_cursor: string | null;
    };
    expect(second.rows).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
  });

  it('answers 404 for a client this host does not serve, the way every /v1 route does', async () => {
    const a = await api([]);
    const response = await a.get('/v1/approvals', undefined, { [CLIENT_HEADER]: 'somebody-else' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such client' });
  });
});
