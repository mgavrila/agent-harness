import { describe, expect, it } from 'vitest';
import { SURFACE_HTTP_PATH_PATTERN, SURFACE_REFUSAL_REASON_PATTERN } from './models.js';
import { MemorySurface } from './testing.js';
import type { MessageEvent, SurfaceHttpRequest } from './types.js';

const post = (body: string, over: Partial<SurfaceHttpRequest> = {}): SurfaceHttpRequest => ({
  method: 'POST',
  path: '',
  headers: { 'content-type': 'application/json' },
  body,
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
