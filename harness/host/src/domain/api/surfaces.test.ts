import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseClientDocument, type ClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { auditLog } from '@harness/db';
import type { Trajectory } from '@harness/runtime-api/testing';
import { MemorySurface } from '@harness/surface-api/testing';
import { ConfigError } from '@harness/shared';
import { poolFixture, useTestDb, waitFor, type PoolFixture } from '../../testing.js';
import { assertMounts } from './surfaces.js';
import { startRunApi } from './server.js';
import { API_MAX_BODY_BYTES } from './types.js';

const db = useTestDb();
const TOKEN = 'sk-host-server-test';

/**
 * One tenant, with the memory surface and nothing else: the surface whose door this mounts.
 *
 * `workspace` is the client's own id, and it is not decoration. It becomes this surface's tenant
 * key, which the host splices into `SurfaceDeps.tenantKey`, which `MemorySurface` reports as the
 * `tenantHint` on every event it delivers — and a pooled host **refuses** a surface event that
 * names no workspace (`pooledResolver`), so a door on a surface with no key would have every
 * message it delivered audited `unauthorised` and dropped. The door calls `say(userId, text)`
 * with no override, so this is the only place the key can come from.
 */
const documentFor = (id: string): ClientDocument =>
  parseClientDocument(
    fixtureDocument({ id, displayName: id, runtime: 'scripted', surfaces: { memory: { workspace: id } } }),
  );

/** The fixture's lead, who is `U012` on the memory surface. */
const message = (text: string): string => JSON.stringify({ userId: 'U012', text });

interface Served {
  f: PoolFixture;
  url: string;
  post(path: string, body: string, headers?: Record<string, string>): Promise<Response>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
}

/**
 * A real pool, its tenants' memory doors mounted, and the host's one HTTP server over it.
 *
 * The door is mounted on the session the pool opened rather than on a fixture of one, so what
 * these cases drive is the dispatch that ships: `createHost` loaded `@harness/surface-memory` by
 * the name the document gave, and this is that session.
 */
async function serve(opts: {
  documents: readonly ClientDocument[];
  trajectories?: Readonly<Record<string, Trajectory>>;
  dedicated?: string;
  token?: string;
}): Promise<Served> {
  const f = await poolFixture(db, {
    documents: opts.documents,
    ...(opts.trajectories ? { trajectories: opts.trajectories } : {}),
    ...(opts.dedicated === undefined ? {} : { dedicated: opts.dedicated }),
  });
  for (const tenant of f.pool.tenants.values()) {
    (tenant.host.surfaces.find('memory') as MemorySurface).mountHttp();
  }
  const server = startRunApi(f.pool, { token: opts.token ?? TOKEN, bind: '127.0.0.1', port: 0 });
  await server.ready;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    await server.close();
    await f.close();
  });
  return {
    f,
    url,
    post: (path, body, headers = {}) =>
      fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }),
    get: (path, headers = {}) => fetch(`${url}${path}`, { headers }),
  };
}

const refusals = async (): Promise<(typeof auditLog.$inferSelect)[]> =>
  db.select().from(auditLog).where(eq(auditLog.decision, 'refused'));

describe('a surface mounted on the host', () => {
  it('runs a turn for the tenant the path names, and answers before the turn finishes', async () => {
    const s = await serve({
      documents: [documentFor('alpha')],
      trajectories: { alpha: [{ say: 'Hello back.' }] },
    });
    const response = await s.post('/tenants/alpha/messages', message('hello'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('{"ok":true}');
    const surface = s.f.surface('alpha');
    await waitFor(() => surface.texts.length > 0);
    expect(surface.texts[0].text).toBe('Hello back.');
    expect(await refusals()).toEqual([]);
  });

  it('needs no bearer of its own, while the run API still needs one', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // No authorization header at all: the surface's own verification is what protects this path,
    // and a transport that signs its requests cannot also send this deployment's bearer secret.
    expect((await s.post('/tenants/alpha/messages', message('hello'))).status).toBe(200);
    const refused = await s.get('/v1/status');
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'unauthorised' });
  });

  it('serves a surface but closes the run API when this deployment set no bearer secret', async () => {
    const s = await serve({ documents: [documentFor('alpha')], token: '' });
    // The listener now always starts, so "no secret" has to mean "no run API" explicitly: two
    // empty buffers compare equal, and a caller sending `Bearer ` would otherwise be let in.
    const attempts: Record<string, string>[] = [{}, { authorization: 'Bearer ' }, { authorization: 'Bearer anything' }];
    for (const headers of attempts) {
      expect((await s.get('/v1/status', headers)).status, JSON.stringify(headers)).toBe(401);
    }
    expect((await s.post('/tenants/alpha/messages', message('hello'))).status).toBe(200);
  });

  it('audits a refusal exactly once, with the reason and nothing of the body', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // The memory door refuses a body that is not a message. What it refuses is never recorded:
    // a refused request is one nobody has authenticated (invariant 15).
    const response = await s.post('/tenants/alpha/messages', '{"userId":"U012"}');
    expect(response.status).toBe(400);
    const rows = await refusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client: 'alpha',
      caller: 'memory:request',
      tool: 'surface_request',
      actionClass: 'read',
      decision: 'refused',
      error: 'bad_request',
    });
    expect(JSON.stringify(rows[0])).not.toContain('U012');
  });

  it('refuses a client a dedicated host does not serve, and audits that too (invariant 19)', async () => {
    const s = await serve({ documents: [documentFor('alpha')], dedicated: 'alpha' });
    const response = await s.post('/tenants/beta/messages', message('hello'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such route' });
    const rows = await refusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client: 'alpha',
      caller: 'http:request',
      tool: 'surface_request',
      decision: 'refused',
      error: 'foreign_client',
    });
    expect([...s.f.pool.tenants.keys()]).toEqual(['alpha']);
  });

  it('routes by the client id in the path, and one tenant never hears another tenant s message', async () => {
    const s = await serve({
      documents: [documentFor('alpha'), documentFor('beta')],
      trajectories: { alpha: [{ say: 'Alpha here.' }], beta: [{ say: 'Beta here.' }] },
    });
    expect((await s.post('/tenants/beta/messages', message('hello'))).status).toBe(200);
    await waitFor(() => s.f.surface('beta').texts.length > 0);
    expect(s.f.surface('beta').texts[0].text).toBe('Beta here.');
    expect(s.f.surface('alpha').texts).toEqual([]);
    expect(s.f.surface('alpha').requests).toEqual([]);
  });

  it('answers 404 for a path no surface claims, for a prefix with no path, and for an unknown client', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // `/tenants/` and `/tenants` are the same string once the router has stripped the trailing
    // slash, and both are below the prefix: they must not fall through to the bearer check.
    for (const path of ['/tenants/alpha/nope', '/tenants/alpha', '/tenants/', '/tenants']) {
      const response = await s.post(path, message('hello'));
      expect(response.status, path).toBe(404);
    }
    // A pooled host has no tenant for this id and no claim to audit: nobody was refused, there is
    // simply nobody there, and the answer is the one a nonexistent route gets.
    expect((await s.post('/tenants/nobody/messages', message('hello'))).status).toBe(404);
    expect(await refusals()).toEqual([]);
  });

  it('tells nobody which clients it serves, because this path has no bearer in front of it', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // A tenant this host really serves, at a path no surface claims, and a client that does not
    // exist at all. Byte-identical in status and in body: anything else and an unauthenticated
    // caller can enumerate this process's tenants one guess at a time.
    const known = await s.post('/tenants/alpha/nope', message('hello'));
    const unknown = await s.post('/tenants/nobody/nope', message('hello'));
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
    expect(unknown.status).toBe(404);
  });

  it('refuses a body past the cap without ever calling the surface', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    const response = await s.post('/tenants/alpha/messages', 'x'.repeat(API_MAX_BODY_BYTES + 1));
    expect(response.status).toBe(413);
    expect(s.f.surface('alpha').requests).toEqual([]);
  });
});

describe('assertMounts', () => {
  const mounted = (name: string, path: string): MemorySurface => {
    const surface = new MemorySurface({ name, conversation: name });
    surface.mountHttp(path);
    return surface;
  };

  it('accepts a tenant whose surfaces claim different paths, and one that claims none', () => {
    expect(() => assertMounts('alpha', [mounted('memory', 'messages'), new MemorySurface()])).not.toThrow();
    expect(() => assertMounts('alpha', [new MemorySurface()])).not.toThrow();
  });

  it('refuses a mount path that could climb out of its tenant prefix', () => {
    const surface = new MemorySurface();
    // Past `mountHttp`, because a session is an object and a real adapter builds its own.
    (surface as { http?: { path: string } }).http = { path: '/v1/runs' };
    expect(() => assertMounts('alpha', [surface])).toThrow(ConfigError);
    expect(() => assertMounts('alpha', [surface])).toThrow(/mount path/);
  });

  it('refuses two surfaces of one tenant claiming one path, naming both', () => {
    const err = (() => {
      try {
        assertMounts('alpha', [mounted('memory', 'messages'), mounted('other', 'messages')]);
      } catch (caught: unknown) {
        return caught as Error;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.message).toContain('memory');
    expect(err?.message).toContain('other');
  });
});
