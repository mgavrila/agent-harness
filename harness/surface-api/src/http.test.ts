import { describe, expect, it } from 'vitest';
import { SURFACE_HTTP_PATH_PATTERN, SURFACE_REFUSAL_REASON_PATTERN } from './models.js';
import { MEMORY_EVENTS_SUBPATH, MEMORY_FRAME_RETENTION, MemorySurface, bodyText } from './testing.js';
import type { MessageEvent, SurfaceHttpRequest } from './types.js';

const post = (body: string, over: Partial<SurfaceHttpRequest> = {}): SurfaceHttpRequest => ({
  method: 'POST',
  path: '',
  headers: { 'content-type': 'application/json' },
  body,
  // The tenant the host resolved from `/tenants/<clientId>/…` a moment before it called the
  // handler, and a signal it aborts when the caller hangs up. Both are request-scoped, which is
  // why they are on the request rather than on `SurfaceDeps`.
  clientId: 'fixture',
  signal: new AbortController().signal,
  ...over,
});

describe('the mount path pattern', () => {
  it('accepts the shapes a surface asks to be mounted at', () => {
    for (const path of ['messages', 'slack/events', 'a/b/c', 'x-1_2']) {
      expect(SURFACE_HTTP_PATH_PATTERN.test(path), path).toBe(true);
    }
  });

  it('refuses anything that would escape its mount, change case or be empty', () => {
    // A leading slash would make the host's join ambiguous; `..` would climb out of the tenant's
    // prefix; an upper-case letter is a second spelling of one mount; empty is not a path.
    for (const path of ['', '/messages', 'messages/', 'slack/../v1/runs', 'Slack/events', 'a//b', 'a b']) {
      expect(SURFACE_HTTP_PATH_PATTERN.test(path), path).toBe(false);
    }
  });
});

describe('the refusal reason pattern', () => {
  it('accepts a short token and refuses a sentence', () => {
    for (const reason of ['bad_signature', 'stale_timestamp', 'x']) {
      expect(SURFACE_REFUSAL_REASON_PATTERN.test(reason), reason).toBe(true);
    }
    // It goes into an audit row, so it is a token an operator can group by, never free text that
    // could carry a fragment of what was refused.
    for (const reason of ['Bad signature', 'bad signature', '', 'bad-signature', 'a'.repeat(65)]) {
      expect(SURFACE_REFUSAL_REASON_PATTERN.test(reason), reason).toBe(false);
    }
  });
});

describe('the memory surface as an HTTP door', () => {
  it('offers no door until one is mounted', () => {
    expect(new MemorySurface().http).toBeUndefined();
  });

  it('mounts at "messages" by default, and where it is told otherwise', () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    expect(surface.http?.path).toBe('messages');
    surface.mountHttp('inbound/messages');
    expect(surface.http?.path).toBe('inbound/messages');
  });

  it('delivers a posted message to the registered handler and records the request', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const seen: MessageEvent[] = [];
    surface.onMessage(async (event) => {
      seen.push(event);
    });
    const response = await surface.http!.handle(post(JSON.stringify({ userId: 'U012', text: 'hello' })));
    expect(response).toEqual({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
    // Acknowledged first, delivered after: the same shape a real transport needs, so a test of
    // the host's mount waits for the turn rather than for the response.
    await surface.settled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ surface: 'memory', userId: 'U012', text: 'hello', mentioned: true });
    expect(surface.requests).toHaveLength(1);
    expect(surface.requests[0].body).toBe(JSON.stringify({ userId: 'U012', text: 'hello' }));
  });

  it('refuses a method it does not serve, and says so as a reason rather than a sentence', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const response = await surface.http!.handle(post('', { method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.refusal).toEqual({ reason: 'method_not_allowed' });
  });

  it('refuses a body that is not a message, without repeating it', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    for (const body of ['', 'not json', '{}', '{"userId":"U012"}', '{"text":"hello"}']) {
      const response = await surface.http!.handle(post(body));
      expect(response.status, body).toBe(400);
      expect(response.refusal, body).toEqual({ reason: 'bad_request' });
      expect(response.body ?? '', body).not.toContain('U012');
    }
  });

  it('does not deliver a message when nothing is listening, and does not throw at the caller', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const response = await surface.http!.handle(post(JSON.stringify({ userId: 'U012', text: 'hello' })));
    expect(response.status).toBe(200);
    // The door acknowledged; the delivery had nowhere to go. A surface that threw here would
    // turn a race at startup into a 500 the sender retries.
    await expect(surface.settled()).resolves.toBeUndefined();
  });
});

describe('the memory surface as a streaming door', () => {
  /** A door with its stream open, and the controller that plays the client hanging up. */
  const opened = async (
    over: Partial<SurfaceHttpRequest> = {},
  ): Promise<{ surface: MemorySurface; chunks: AsyncIterator<string>; hangUp: () => void }> => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const client = new AbortController();
    const response = await surface.http!.handle(
      post('', { method: 'GET', path: MEMORY_EVENTS_SUBPATH, signal: client.signal, ...over }),
    );
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    const body = response.body;
    if (typeof body !== 'object') throw new Error('the events sub-path must answer with a stream');
    return { surface, chunks: body[Symbol.asyncIterator](), hangUp: () => client.abort() };
  };

  it('answers the events sub-path with a stream and the message sub-path with a body', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const message = await surface.http!.handle(post(JSON.stringify({ userId: 'U012', text: 'hi' })));
    expect(typeof message.body).toBe('string');
    const events = await surface.http!.handle(post('', { method: 'GET', path: MEMORY_EVENTS_SUBPATH }));
    expect(typeof events.body).toBe('object');
  });

  it('refuses a method the stream does not serve, and says which one it does', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const response = await surface.http!.handle(post('', { path: MEMORY_EVENTS_SUBPATH }));
    expect(response.status).toBe(405);
    expect(response.headers).toEqual({ allow: 'GET' });
    // No refusal: a wrong method on a route that exists is a caller's mistake, not a door turning
    // somebody away, and it costs no audit row.
    expect(response.refusal).toBeUndefined();
  });

  it('yields one frame per emit, with a monotonic id, and waits between them', async () => {
    const { surface, chunks } = await opened();
    // Pulled before anything is emitted: the generator is parked, which is the property that
    // makes a stream a stream rather than a buffer read at the end.
    const first = chunks.next();
    surface.emit('note', { n: 1 });
    expect((await first).value).toBe('id: 1\nevent: note\ndata: {"n":1}\n\n');
    surface.emit('note', { n: 2 });
    expect((await chunks.next()).value).toBe('id: 2\nevent: note\ndata: {"n":2}\n\n');
  });

  it('resumes after the id a client reports, repeating nothing it already had', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    surface.emit('note', { n: 1 });
    surface.emit('note', { n: 2 });
    surface.emit('note', { n: 3 });
    const response = await surface.http!.handle(
      // Lower-cased, because the host lower-cases every header name before an adapter sees one.
      post('', { method: 'GET', path: MEMORY_EVENTS_SUBPATH, headers: { 'last-event-id': '2' } }),
    );
    const chunks = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    expect((await chunks.next()).value).toBe('id: 3\nevent: note\ndata: {"n":3}\n\n');
  });

  it('starts from what it still holds when a resume asks for a frame it has dropped', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    for (let n = 1; n <= MEMORY_FRAME_RETENTION + 5; n += 1) surface.emit('note', { n });
    expect(surface.frames).toHaveLength(MEMORY_FRAME_RETENTION);
    const response = await surface.http!.handle(
      post('', { method: 'GET', path: MEMORY_EVENTS_SUBPATH, headers: { 'last-event-id': '1' } }),
    );
    const chunks = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    // The oldest it still has, not the one that was asked for. Saying so to the *client* is the
    // web surface's job (spec 4.9); this door is the seam's reference and keeps no vocabulary.
    expect((await chunks.next()).value).toBe('id: 6\nevent: note\ndata: {"n":6}\n\n');
  });

  it('ends the stream when the request is aborted, and lets the producer go', async () => {
    const { surface, chunks, hangUp } = await opened();
    // Pulled before the count is read: an async generator's body — and so `openStreams += 1` —
    // does not run until the first `next()`. Asserting first would read zero and prove nothing.
    const parked = chunks.next();
    expect(surface.openStreams).toBe(1);
    hangUp();
    expect((await parked).done).toBe(true);
    expect(surface.openStreams).toBe(0);
  });

  it('throws out of the stream when the producer fails, rather than ending it quietly', async () => {
    const { surface, chunks } = await opened();
    const parked = chunks.next();
    surface.breakStreams('the producer gave up');
    await expect(parked).rejects.toThrow('the producer gave up');
    expect(surface.openStreams).toBe(0);
  });

  it('collects either shape of body, which is what a test of a door needs', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    expect(await bodyText(await surface.http!.handle(post(JSON.stringify({ userId: 'U012', text: 'hi' }))))).toBe(
      '{"ok":true}',
    );
    surface.emit('note', { n: 1 });
    const stream = await surface.http!.handle(
      post('', { method: 'GET', path: MEMORY_EVENTS_SUBPATH, signal: AbortSignal.abort() }),
    );
    // An already-aborted request: the stream yields what it holds and ends, so `bodyText` returns
    // rather than parking. A test that collected a live stream would never return, and this is
    // the one shape of that call which terminates.
    expect(await bodyText(stream)).toBe('id: 1\nevent: note\ndata: {"n":1}\n\n');
  });
});
