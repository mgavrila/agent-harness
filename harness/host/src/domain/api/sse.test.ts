import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sseStream } from './sse.js';

let server: Server;
let url = '';
/**
 * What `stream.open` read either side of `end()`, recorded by the `/open` handler because the
 * stream object itself lives inside the server and a test outside it can only see the bytes.
 */
let openAround: { before: boolean; after: boolean } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const stream = sseStream(res, { keepAliveMs: 0 });
    stream.send('run', { type: 'run', runId: 'r-1' });
    stream.comment('still here');
    if (req.url === '/withend') {
      stream.send('result', { type: 'result', status: 'done' });
      stream.end();
      // Everything after `end` is dropped rather than throwing on a finished response.
      stream.send('result', { type: 'result', status: 'done' });
    } else if (req.url === '/open') {
      const before = stream.open;
      stream.end();
      const after = stream.open;
      // Both kinds of write, after the close: neither may reach the body below.
      stream.send('dropped', { type: 'dropped' });
      stream.comment('dropped');
      openAround = { before, after };
    } else {
      stream.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('sseStream', () => {
  it('answers 202 with the event-stream headers a proxy will not buffer', async () => {
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    await response.text();
  });

  it('writes one named frame per event, with the payload as one line of JSON', async () => {
    const body = await (await fetch(`${url}/withend`)).text();
    expect(body).toBe(
      'event: run\ndata: {"type":"run","runId":"r-1"}\n\n: still here\n\nevent: result\ndata: {"type":"result","status":"done"}\n\n',
    );
  });

  it('reports whether it is still open, and drops every write after it closes', async () => {
    const body = await (await fetch(`${url}/open`)).text();
    // `open` is the flag the run API's writer reads before it bothers to build a frame.
    expect(openAround).toEqual({ before: true, after: false });
    // And the drop is real, not just reported: the frame and the comment written after `end`
    // are absent, and nothing threw on a finished response.
    expect(body).toBe('event: run\ndata: {"type":"run","runId":"r-1"}\n\n: still here\n\n');
    expect(body).not.toContain('dropped');
  });
});
