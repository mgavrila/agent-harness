import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from '../../testing.js';
import { readBody } from './http.js';
import { bearerOk } from './routes.js';
import { API_MAX_BODY_BYTES } from './types.js';

describe('bearerOk', () => {
  it('accepts the exact token and nothing else', () => {
    expect(bearerOk('Bearer sk-right', 'sk-right')).toBe(true);
    expect(bearerOk('Bearer sk-wrong', 'sk-right')).toBe(false);
    // A prefix and a suffix both answer false rather than throwing: `timingSafeEqual` rejects a
    // length mismatch, which is why the length is compared before it is called.
    expect(bearerOk('Bearer sk-righ', 'sk-right')).toBe(false);
    expect(bearerOk('Bearer sk-righty', 'sk-right')).toBe(false);
  });

  it('refuses a missing header, an empty one, and every other scheme', () => {
    // `bearer` lowercase is refused too. The scheme is case-insensitive in the HTTP standard and
    // strict here on purpose: this is one deployment's own control plane, the runbook shows the
    // exact header, and a spelling nobody documented is likelier a broken client than a caller.
    for (const header of [undefined, '', 'sk-right', 'bearer sk-right', 'Basic sk-right', 'Bearer']) {
      expect(bearerOk(header, 'sk-right'), String(header)).toBe(false);
    }
  });
});

type Body = Awaited<ReturnType<typeof readBody>>;

let server: Server;
let url = '';
let deliver: ((body: Body) => void) | null = null;
/** Called as a request arrives, for a case that has to act before its body is read. */
let arrived: ((req: IncomingMessage) => void) | null = null;
/** Held by a case that needs the read to start *after* something else has happened. */
let gate: Promise<void> | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    arrived?.(req);
    void (gate ?? Promise.resolve()).then(async () => {
      const body = await readBody(req);
      deliver?.(body);
      try {
        res.writeHead(200).end();
      } catch {
        // A body refused past the cap is answered while the rest of it is still arriving, so the
        // caller may already have hung up by the time the handler gets here.
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** POST a body and hand back what `readBody` made of it, whether or not the request survived. */
async function sent(body: string): Promise<Body> {
  const read = new Promise<Body>((resolve) => {
    deliver = resolve;
  });
  await fetch(url, { method: 'POST', body }).catch(() => undefined);
  return read;
}

describe('readBody', () => {
  it('reads a whole body, over however many chunks it arrives in', async () => {
    expect(await sent('{"text":"hello"}')).toEqual({ kind: 'read', text: '{"text":"hello"}' });
    // Comfortably more than one TCP segment, so the `data` handler really is accumulating.
    const long = JSON.stringify({ text: 'y'.repeat(200_000) });
    expect(await sent(long)).toEqual({ kind: 'read', text: long });
  });

  it('reads an empty body as an empty string, which is a 400 upstream and not a 413', async () => {
    expect(await sent('')).toEqual({ kind: 'read', text: '' });
  });

  it('refuses a body past the cap while it is still arriving, rather than after', async () => {
    expect(await sent('y'.repeat(API_MAX_BODY_BYTES + 1_024))).toEqual({ kind: 'too_large' });
  });
});

describe('readBody when the caller hangs up', () => {
  /** A raw connection, because `fetch` cannot half-send a body and then walk away. */
  async function dial(): Promise<Socket> {
    const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    return socket;
  }

  /** The two promises a hang-up case waits on: the request arriving, and the read settling. */
  function watched(): { here: Promise<IncomingMessage>; read: Promise<Body> } {
    const here = new Promise<IncomingMessage>((resolve) => {
      arrived = resolve;
    });
    const read = new Promise<Body>((resolve) => {
      deliver = resolve;
    });
    return { here, read };
  }

  it('settles as gone when the connection dies with the body half sent', async () => {
    const { here, read } = watched();
    const socket = await dial();
    // A `content-length` the body never reaches, so the read is parked on the rest of it.
    socket.write('POST / HTTP/1.1\r\nHost: x\r\ncontent-length: 64\r\n\r\n{"userId":"U012"');
    await here;
    socket.destroy();
    // Not `{ kind: 'too_large' }`, which is what this answered before there was a third outcome:
    // a mid-body hang-up trips the request's `error`, and folding that into the cap's answer made
    // the host write a 413 for a body that was never too large, into a socket nobody was holding.
    expect(await read).toEqual({ kind: 'gone' });
  });

  it('settles as gone when the request is already dead by the time it is read', async () => {
    // The window the surface route has: the request is accepted, the caller gives up while a
    // tenant is opening, and only afterwards is the body read. Nothing further is emitted for a
    // request that died before anything was listening, so this is the case the up-front check
    // answers and the one that hung before it existed.
    let open = (): void => {};
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    try {
      const { here, read } = watched();
      const socket = await dial();
      socket.write('POST / HTTP/1.1\r\nHost: x\r\ncontent-length: 4\r\n\r\nabcd');
      const request = await here;
      socket.destroy();
      // The server's own view of the request, not this side's: a client that has closed says
      // nothing about whether the host has noticed, and waiting on the wrong one of the two is
      // how this case would come to assert on whichever it happened to see first.
      await waitFor(() => request.destroyed);
      open();
      expect(await read).toEqual({ kind: 'gone' });
    } finally {
      gate = null;
    }
  });

  it('reads a body the caller finished before half-closing, because nothing of it was lost', async () => {
    // A half-close says "I have finished sending", not "I have gone": the body is complete, so it
    // is read as one. What happens to the *answer* is the response's business, and the host's
    // early `close` listener is what hears that.
    const { here, read } = watched();
    const socket = await dial();
    socket.write('POST / HTTP/1.1\r\nHost: x\r\ncontent-length: 4\r\n\r\nabcd');
    await here;
    socket.end();
    expect(await read).toEqual({ kind: 'read', text: 'abcd' });
    socket.destroy();
  });
});
