import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { messages, threads } from '@harness/db';
import type { Trajectory } from '@harness/runtime-api/testing';
import { COORDINATOR, MEMBER, hostFixture, useTestDb, type HostFixture } from '../../testing.js';
import { WITHHELD } from '../threads/repository.js';
import { startRunApi } from './server.js';
import { API_MAX_BODY_BYTES } from './types.js';

const db = useTestDb();
const TOKEN = 'sk-run-api-test';

interface Api {
  f: HostFixture;
  url: string;
  open(body: unknown, token?: string): Promise<Response>;
  get(path: string, token?: string): Promise<Response>;
  post(path: string, token?: string): Promise<Response>;
}

async function api(trajectory: Trajectory): Promise<Api> {
  const f = await hostFixture(db, { trajectory });
  const server = startRunApi(f.host, { token: TOKEN, bind: '127.0.0.1', port: 0 });
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
    get: (p, token) => fetch(`${url}${p}`, { headers: auth(token) }),
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
    expect(a.f.surface.texts).toEqual([]);
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
      client: 'test',
      surfaces: ['memory'],
      primary_surface: 'memory',
      runs_in_flight: 0,
      draining: false,
      scheduler: null,
    });
  });

  it('answers "no such route" for anything else', async () => {
    const a = await api([]);
    expect((await a.get('/v1/nothing')).status).toBe(404);
    expect((await a.get('/')).status).toBe(404);
  });
});
