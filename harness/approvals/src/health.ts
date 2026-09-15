import { createServer, type Server } from 'node:http';
import type { HealthSnapshot } from './runner.js';

/**
 * A one-route HTTP server on localhost for the cron watchdogs. It exposes
 * counts and timestamps only — never an approval summary, a payload, or a file
 * name — because anything reachable over HTTP is outside the audit trail.
 */
export function startHealthServer(opts: { port: number; snapshot: () => Promise<HealthSnapshot> }): { close(): Promise<void> } {
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
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      });
  });
  server.listen(opts.port, '127.0.0.1');
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
