import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

beforeAll(async () => {
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
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
    expect(await sent('{"text":"hello"}')).toEqual({ ok: true, text: '{"text":"hello"}' });
    // Comfortably more than one TCP segment, so the `data` handler really is accumulating.
    const long = JSON.stringify({ text: 'y'.repeat(200_000) });
    expect(await sent(long)).toEqual({ ok: true, text: long });
  });

  it('reads an empty body as an empty string, which is a 400 upstream and not a 413', async () => {
    expect(await sent('')).toEqual({ ok: true, text: '' });
  });

  it('refuses a body past the cap while it is still arriving, rather than after', async () => {
    expect(await sent('y'.repeat(API_MAX_BODY_BYTES + 1_024))).toEqual({ ok: false });
  });
});
