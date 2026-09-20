import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLogger } from '@harness/shared';
import type { HealthSnapshot } from './runner.js';

/**
 * What the route answers with: one client's snapshot, or one per tenant.
 *
 * A dedicated process has exactly one client and answers what it always answered, which is what
 * a container health check and the runbook both read. A pooled process has no single client to
 * report, so it answers a snapshot per tenant under `tenants` and an `ok` that is false when any
 * of them is. The server itself reads `ok` and nothing else, so both shapes are one route.
 */
export type HealthPayload = HealthSnapshot | { ok: boolean; tenants: Record<string, HealthSnapshot> };

const log = createLogger('approvals');

/** Bind every interface by default: see the `bind` note on `startHealthServer`. */
export const DEFAULT_HEALTH_BIND = '0.0.0.0';

export interface HealthServer {
  /** Resolves once the socket is bound; `address()` is null before that. */
  ready: Promise<void>;
  /** The bound address, so a caller can pass port 0 and discover what it got. */
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}

/**
 * A one-route HTTP server for the cron watchdogs. It exposes counts and
 * timestamps only — never an approval summary, a payload, or a file name —
 * because anything reachable over HTTP is outside the audit trail.
 *
 * `bind` defaults to every interface. In Compose that is the only bind that
 * works: Docker's port publish DNATs to the container's bridge address, which
 * a container-loopback listener cannot answer. Exposure is controlled one
 * layer out, by the port mapping, which is pinned to `127.0.0.1` on the host.
 * Pass `127.0.0.1` for a bare-metal run (and in tests) where the process, not
 * Compose, is the boundary.
 */
export function startHealthServer(opts: {
  port: number;
  bind?: string;
  snapshot: () => Promise<HealthPayload>;
}): HealthServer {
  const server: Server = createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    void opts
      .snapshot()
      .then((snapshot) => {
        res.writeHead(snapshot.ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(snapshot));
      })
      .catch((err: unknown) => {
        // A fixed body. `collectHealth` runs four count queries and a
        // `runner.status()`, so a failure here is a driver or Postgres error,
        // and those carry fragments of the statement or of the connection
        // target. This route is unauthenticated and outside the audit trail;
        // the detail goes to stderr, where an operator can read it.
        log.error('health snapshot failed', err);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"snapshot failed"}');
      });
  });
  // Resolve-only: a bind failure still surfaces as the server's own 'error'
  // event, so awaiting `ready` never turns a startup crash into a silent
  // rejection nobody handled.
  const ready = new Promise<void>((resolve) => server.once('listening', () => resolve()));
  server.listen(opts.port, opts.bind ?? DEFAULT_HEALTH_BIND);
  return {
    ready,
    address: () => server.address(),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
