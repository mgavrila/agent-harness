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
 * The 413 every body-reading route gives: the cap in a sentence, then the socket.
 *
 * Answered first and torn up once the answer is flushed, so the caller is told why and a caller
 * that keeps sending anyway is cut off rather than read and discarded for as long as it likes.
 * Destroying before the flush would answer nothing; not destroying at all would let one
 * authenticated connection stream gigabytes past a cap that had already refused it.
 */
export function tooLarge(req: IncomingMessage, res: ServerResponse): void {
  json(res, 413, { error: `a request body may be at most ${API_MAX_BODY_BYTES} bytes` }, () => req.destroy());
}

/**
 * What reading a request body came to.
 *
 * Three outcomes rather than two, because **a caller that went away is not a caller that was
 * refused**. There is nobody left to answer, so a status written for one would go into a dead
 * socket and an audit row recorded for one would name a request nobody made. Naming the three
 * rather than folding two of them behind an `ok: false` is what makes a caller say which it meant.
 */
export type BodyRead =
  /** The whole body, exactly as it arrived, decoded as UTF-8. */
  | { kind: 'read'; text: string }
  /** Past `API_MAX_BODY_BYTES`, refused while it was still arriving. The caller is still there. */
  | { kind: 'too_large' }
  /** The connection closed before the body ended. Nothing to answer and nothing to record. */
  | { kind: 'gone' };

/**
 * Read the body, refusing past the cap while it arrives rather than after, and settling when the
 * caller hangs up.
 *
 * Past the cap this stops consuming: the `data` handler comes off and the request is paused, so
 * nothing further is read off the socket and what was already held is released. It does not
 * destroy the connection — a 413 cannot be written down a socket this function has torn up, and a
 * caller told nothing learns nothing. The caller answers, and hangs the teardown on the answer
 * being flushed, so the read stays bounded either way.
 *
 * **A hang-up settles it as `gone`**, and that is not a nicety. A destroyed request emits neither
 * `end` nor, in the ordinary case, `error`: it emits `aborted` and `close`. A read that waited
 * only for the first two would never settle, so the handler awaiting it would never return and the
 * request, the response and this promise would be held for as long as the process ran — once per
 * abandoned request, on a route that sits in front of the bearer.
 */
export async function readBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    // Hoisted, so the handlers below can name it and it can name them. Every listener comes off on
    // every path: neither a request that ended nor one that died leaves this holding the body it
    // read or the request it read it from.
    function settle(result: BodyRead): void {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onGone);
      req.off('close', onGone);
      req.off('error', onGone);
      chunks = [];
      resolve(result);
    }
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > API_MAX_BODY_BYTES) {
        // Paused as well as unhooked, because removing the last `data` listener does not by itself
        // stop a flowing stream.
        req.pause();
        settle({ kind: 'too_large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => settle({ kind: 'read', text: Buffer.concat(chunks).toString('utf8') });
    const onGone = (): void => settle({ kind: 'gone' });
    // It can be over before this even runs — a caller that hung up while a tenant was opening
    // leaves exactly that — and a request that is already dead emits nothing further to wait for.
    if (req.destroyed || req.closed) {
      resolve({ kind: 'gone' });
      return;
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('aborted', onGone);
    req.on('close', onGone);
    req.on('error', onGone);
  });
}
