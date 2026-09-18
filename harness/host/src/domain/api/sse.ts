import type { ServerResponse } from 'node:http';
import { SSE_KEEPALIVE_MS } from './types.js';

export interface SseStream {
  /** False once `end` has run or the client hung up. Everything written after that is dropped. */
  readonly open: boolean;
  send(event: string, data: unknown): void;
  /** A comment line: ignored by every client, and what keeps an idle connection alive. */
  comment(text: string): void;
  end(): void;
}

/**
 * Server-Sent Events, by hand.
 *
 * The whole format is `event: <name>\ndata: <one line>\n\n`, with `: <text>\n\n` for a comment, so
 * a library would be a dependency for forty lines of string building. The payload is JSON on one
 * line, which is what makes that true: a multi-line payload would need a `data:` prefix per line.
 *
 * `202` because spec 5.8 says so: the run is accepted, and what follows is the run happening. The
 * three headers are the ones that stop something in between buffering the stream into a single
 * response — which is the failure mode that makes a streaming API look merely slow.
 *
 * The keep-alive timer is `unref`ed: an open stream must not be the reason a process will not
 * exit, and the shutdown path closes the connections anyway.
 */
export function sseStream(res: ServerResponse, opts: { keepAliveMs?: number } = {}): SseStream {
  res.writeHead(202, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // nginx and friends buffer an unknown-length response by default, which turns a stream into
    // one delivery at the end.
    'x-accel-buffering': 'no',
  });
  let open = true;
  const keepAliveMs = opts.keepAliveMs ?? SSE_KEEPALIVE_MS;
  const timer =
    keepAliveMs > 0
      ? setInterval(() => {
          if (open) res.write(': keep-alive\n\n');
        }, keepAliveMs)
      : undefined;
  timer?.unref();
  const stop = (): void => {
    open = false;
    if (timer) clearInterval(timer);
  };
  res.on('close', stop);
  return {
    get open() {
      return open;
    },
    send(event, data) {
      if (!open) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (!open) return;
      res.write(`: ${text}\n\n`);
    },
    end() {
      if (!open) return;
      stop();
      res.end();
    },
  };
}
