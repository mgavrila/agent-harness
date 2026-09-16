import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { startHealthServer, type HealthServer } from './health.js';
import type { HealthSnapshot } from './runner.js';

/**
 * These tests go through the real HTTP server rather than calling
 * `collectHealth` in process, because the bug this file exists for was in
 * `listen` and not in the snapshot: a container-loopback bind answers neither
 * the published host port nor `http://approvals:8787` from another service.
 *
 * Port 0 lets the kernel pick a free port, and every server here binds
 * 127.0.0.1 explicitly: a test must not open a port on every interface of the
 * machine it runs on. The default (`0.0.0.0`) is asserted separately, without
 * listening on it.
 */
const snapshot = (ok: boolean): HealthSnapshot => ({
  ok,
  client: 'demo-practice',
  now: '2026-09-15T12:00:00.000Z',
  runner: {
    lastPollAt: null,
    lastDispatchAt: null,
    lastReconcileAt: null,
    lastError: null,
    loops: {
      poll: { lastError: null, lastErrorAt: null, lastOkAt: null },
      dispatch: { lastError: null, lastErrorAt: null, lastOkAt: null },
      reconcile: { lastError: null, lastErrorAt: null, lastOkAt: null },
    },
  },
  effects: { staged: 0, failed: 0, needs_review: 0 },
  approvals: { pending: 0 },
});

let server: HealthServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(opts: { snapshot: () => Promise<HealthSnapshot> }): Promise<number> {
  server = startHealthServer({ port: 0, bind: '127.0.0.1', snapshot: opts.snapshot });
  await server.ready;
  return (server.address() as AddressInfo).port;
}

describe('startHealthServer', () => {
  it('answers /healthz on the address it was told to bind', async () => {
    const port = await start({ snapshot: async () => snapshot(true) });
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, client: 'demo-practice' });
  });

  it('answers 503 when the snapshot is not ok', async () => {
    const port = await start({ snapshot: async () => snapshot(false) });
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ ok: false });
  });

  it('answers 404 on any other route', async () => {
    const port = await start({ snapshot: async () => snapshot(true) });
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(404);
  });

  it('binds every interface when no bind address is given', async () => {
    // Asserted through the bound address rather than by connecting, so the
    // suite never opens a port beyond loopback.
    server = startHealthServer({ port: 0, snapshot: async () => snapshot(true) });
    await server.ready;
    expect((server.address() as AddressInfo).address).toBe('0.0.0.0');
  });

  it('never returns the underlying error text on the 500 path', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const port = await start({
      snapshot: async () => {
        throw new Error('connection to host=db.internal user=harness_app failed');
      },
    });
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ ok: false, error: 'snapshot failed' });
    expect(body).not.toContain('db.internal');
    expect(body).not.toContain('harness_app');
    // The detail is still available to an operator, on stderr.
    expect(stderr.mock.calls.flat().join(' ')).toContain('db.internal');
    stderr.mockRestore();
  });
});
