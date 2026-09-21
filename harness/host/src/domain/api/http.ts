import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_MAX_BODY_BYTES } from './types.js';

/**
 * The two things every handler on this server does with a socket, in a module that imports
 * nothing of the host's.
 *
 * They live here rather than in `routes.ts` because `routes.ts` dispatches to `surfaces.ts` and
 * `surfaces.ts` has to read a body: a helper in either of them would put the two files in a
 * cycle, and `pnpm arch`'s `no-circular` is an error.
 */

/** `then` runs once the body is on the wire: what the 413 path hangs the socket's teardown on. */
export function json(res: ServerResponse, status: number, body: unknown, then?: () => void): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body), then);
}

/**
 * Read the body, refusing past the cap while it arrives rather than after.
 *
 * Past the cap this stops consuming: the `data` handler comes off and the request is paused, so
 * nothing further is read off the socket and what was already held is released. It does not
 * destroy the connection — a 413 cannot be written down a socket this function has torn up, and a
 * caller told nothing learns nothing. The caller answers, and hangs the teardown on the answer
 * being flushed, so the read stays bounded either way.
 */
export async function readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > API_MAX_BODY_BYTES) {
        // Both, because removing the last `data` listener does not by itself stop a flowing stream.
        req.off('data', onData);
        req.pause();
        chunks = [];
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    // Already settled if the cap tripped; a promise keeps its first answer.
    req.on('end', () => resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ ok: false }));
  });
}
