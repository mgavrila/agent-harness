import { createServer, type Server } from 'node:http';
import type { HostPool } from '../tenancy/types.js';
import { handleApiRequest } from './routes.js';
import { DEFAULT_HOST_BIND, DEFAULT_HOST_PORT, type RunApiOptions, type RunApiServer } from './types.js';

/**
 * The host's HTTP server: the run API (spec 5.8) and every tenant's surface mounts (section 4.6).
 *
 * One listener, because they are one deployment's front door on one port, and a second server
 * would be a second port to publish, a second bind to configure and a second thing to shut down.
 * The name is the run API's because that is what it was; what it serves is in `handleApiRequest`.
 *
 * Shaped like `startHealthServer`, and for the same reasons: `ready` resolves on `'listening'` so a
 * test can bind port 0 and read back what it got, and a bind failure still surfaces as the
 * server's own `'error'` event rather than a rejection nobody handled.
 *
 * `close` closes the open connections first. A Server-Sent Events response is open by design, so a
 * plain `close()` would wait for every listening caller to hang up — and shutdown calls this
 * *before* the drain, so nothing new is accepted while the turns in flight unwind.
 *
 * It takes the pool rather than one host: which tenant a request belongs to is the resolver's
 * answer, per request, and one listener serves every tenant this process has open.
 */
export function startRunApi(pool: HostPool, opts: RunApiOptions): RunApiServer {
  const server: Server = createServer((req, res) => {
    void handleApiRequest(pool, req, res, opts).catch((err: unknown) => {
      // A fixed body. Anything thrown this far is a driver, filesystem or socket error, and those
      // carry fragments of a statement or a path; the detail goes to the log, where an operator
      // can read it.
      pool.log.error('the run API failed a request', err);
      if (res.headersSent) res.end();
      else {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"the request failed"}');
      }
    });
  });
  const ready = new Promise<void>((resolve) => server.once('listening', () => resolve()));
  server.listen(opts.port ?? DEFAULT_HOST_PORT, opts.bind ?? DEFAULT_HOST_BIND);
  return {
    ready,
    address: () => server.address(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
