import { connect, type AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseClientDocument, type ClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { auditLog } from '@harness/db';
import type { Trajectory } from '@harness/runtime-api/testing';
import { MemorySurface } from '@harness/surface-api/testing';
import { ConfigError, type Logger } from '@harness/shared';
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

/**
 * One request written straight onto the socket, answered with its status line.
 *
 * `fetch` folds a header given twice into one value before it leaves, so a case about what a
 * duplicated header becomes would be proving its HTTP client's behaviour rather than the host's.
 * These bytes are what a transport that repeats a header actually puts on the wire.
 */
async function rawPost(base: string, path: string, headerLines: readonly string[], body: string): Promise<string> {
  const target = new URL(base);
  return new Promise<string>((resolve, reject) => {
    const socket = connect(Number(target.port), target.hostname, () => {
      socket.write(
        [
          `POST ${path} HTTP/1.1`,
          `host: ${target.host}`,
          ...headerLines,
          `content-length: ${Buffer.byteLength(body, 'utf8')}`,
          'connection: close',
          '',
          body,
        ].join('\r\n'),
      );
    });
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(received.split('\r\n')[0]));
    socket.on('error', reject);
  });
}

/** Every line this pool logged, per level, so a case can assert what a refusal did and did not say. */
interface Captured {
  info: string[];
  warn: string[];
  error: string[];
}

function capture(f: PoolFixture): Captured {
  const lines: Captured = { info: [], warn: [], error: [] };
  const log: Logger = {
    info: (message) => lines.info.push(message),
    warn: (message) => lines.warn.push(message),
    error: (message) => lines.error.push(message),
  };
  f.pool.log = log;
  return lines;
}

/**
 * Record every client id this pool is *asked* about, through the two entry points a request has.
 *
 * The shape check on the path segment has to happen before either of them: a config source is
 * entitled to throw on a string it cannot spell (the files source does), and a resolver is not
 * the place to bound a caller's input. Asserting the status alone would pass either way, because
 * the in-memory source a test runs on answers null rather than throwing.
 */
function watchLookups(f: PoolFixture): string[] {
  const asked: string[] = [];
  const realTenantFor = f.pool.tenantFor.bind(f.pool);
  f.pool.tenantFor = async (clientId: string) => {
    asked.push(clientId);
    return realTenantFor(clientId);
  };
  const resolver = f.pool.resolver;
  const realResolve = resolver.resolve.bind(resolver);
  resolver.resolve = (ref) => {
    if (ref.from === 'api' && ref.clientId !== null) asked.push(ref.clientId);
    return realResolve(ref);
  };
  return asked;
}

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

  it('gives every miss below the prefix one answer, so the kind of miss stays in the audit log', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // A tenant this host really serves, at a path no surface claims, and a client that does not
    // exist at all. Byte-identical in status and in body, so an unauthenticated caller cannot
    // read a wrong id apart from a right id at a wrong path.
    //
    // What this does not claim: that a tenant's existence is hidden. Mount paths are public
    // constants, so a caller who guesses `/tenants/alpha/messages` gets that surface's own answer
    // rather than this 404. Bounding those probes is a rate limit and an ingress in front of the
    // port, not a status code here.
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

  it('hands the surface the header values exactly as Node parsed them, under lower-cased names', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    const status = await rawPost(
      s.url,
      '/tenants/alpha/messages',
      ['content-type: application/json', 'X-Signature: aaa', 'X-Signature: bbb', 'X-Mixed-Case: Zed'],
      message('hello'),
    );
    expect(status).toContain('200');
    const { headers } = s.f.surface('alpha').requests[0];
    // Node joins a repeated header with ", " for every name but `set-cookie`, and the host passes
    // that value through unchanged. An adapter verifying a signature sees the join and refuses,
    // which is the behaviour its contract now states rather than a first value it never gets.
    expect(headers['x-signature']).toBe('aaa, bbb');
    expect(headers['x-mixed-case']).toBe('Zed');
    expect(Object.keys(headers)).toEqual(Object.keys(headers).map((name) => name.toLowerCase()));
    expect(headers).not.toHaveProperty('X-Signature');
  });

  it('refuses a client id that is not one before it asks the pool anything', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    const asked = watchLookups(s.f);
    const logged = capture(s.f);
    // An encoded slash and an encoded traversal, both of which survive `new URL`'s normalisation;
    // then an upper-case letter, a colon, a NUL, one character, and a segment past the bound.
    const malformed = ['a%2Fb', '%2e%2e%2f%2e%2e', 'Alpha', 'a:b', 'a%00b', 'x', 'a'.repeat(300)];
    const bodies = new Set<string>();
    for (const id of malformed) {
      const response = await s.post(`/tenants/${id}/messages`, message('hello'));
      expect(response.status, id).toBe(404);
      bodies.add(await response.text());
    }
    expect([...bodies]).toEqual(['{"error":"no such route"}']);
    // Neither the resolver nor the pool was handed any of them: a config source is entitled to
    // throw on a string it cannot spell, and this route has no bearer in front of it.
    expect(asked).toEqual([]);
    // And nothing a caller sent reached the log, which is the other half of an open port.
    for (const id of malformed) {
      expect([...logged.info, ...logged.warn, ...logged.error].join('\n'), id).not.toContain(id);
    }
    expect(await refusals()).toEqual([]);
    // A well-formed id nobody serves still reaches the pool, so the case above proves the guard
    // rather than a route that never looks anything up.
    expect((await s.post('/tenants/nobody/messages', message('hello'))).status).toBe(404);
    expect(asked).toContain('nobody');
  });

  it('never sees a dot segment, because the URL parser resolves one above the prefix', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // `/tenants/../messages` and its encoded spelling both normalise to `/messages` before the
    // router runs, so they are not requests below this prefix at all and the run API answers
    // them — with the 401 every unauthenticated `/v1`-shaped miss gets. Pinned because it is
    // surprising, not because the host does anything about it.
    for (const path of ['/tenants/../messages', '/tenants/%2E%2E/messages']) {
      expect((await s.post(path, message('hello'))).status, path).toBe(401);
    }
    expect(s.f.surface('alpha').requests).toEqual([]);
  });

  it('answers 500 for a handler that throws, logs it once, and audits nothing', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    const logged = capture(s.f);
    const surface = s.f.surface('alpha');
    // Past `mountHttp`, because what is under test is a door whose handler fails rather than
    // refuses: nobody was turned away, so there is nothing to audit as a refusal.
    surface.http = {
      path: 'messages',
      handle: () => Promise.reject(new Error('the transport died holding U012 and hello')),
    };
    const response = await s.post('/tenants/alpha/messages', message('hello'));
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"surface failure"}');
    expect(logged.error).toHaveLength(1);
    expect(logged.error[0]).toContain('alpha');
    expect(logged.error[0]).toContain('messages');
    // The line names the tenant and the mount and nothing a caller sent.
    expect(logged.error[0]).not.toContain('U012');
    expect(logged.error[0]).not.toContain('hello');
    expect(await refusals()).toEqual([]);
  });

  it('matches a mount by whole segments, so a longer name is not captured by a shorter mount', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    const response = await s.post('/tenants/alpha/messagesfoo', message('hello'));
    expect(response.status).toBe(404);
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

  /** The `ConfigError` a call threw, or null: `toThrow` cannot assert on two substrings at once. */
  const thrownBy = (run: () => void): Error | null => {
    try {
      run();
    } catch (caught: unknown) {
      return caught as Error;
    }
    return null;
  };

  it('refuses two surfaces of one tenant claiming one path, naming both', () => {
    const err = thrownBy(() => assertMounts('alpha', [mounted('memory', 'messages'), mounted('other', 'messages')]));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.message).toContain('memory');
    expect(err?.message).toContain('other');
  });

  it('refuses a mount that shadows another, whichever of the two loaded first', () => {
    // `messages` and `messages/inbound` both pass a duplicate check and neither is reachable
    // past the other: the shorter one claims the longer one's traffic by load order alone.
    for (const pair of [
      [mounted('memory', 'messages'), mounted('other', 'messages/inbound')],
      [mounted('other', 'messages/inbound'), mounted('memory', 'messages')],
    ]) {
      const err = thrownBy(() => assertMounts('alpha', pair));
      expect(err).toBeInstanceOf(ConfigError);
      expect(err?.message).toContain('memory');
      expect(err?.message).toContain('other');
      expect(err?.message).toContain('messages/inbound');
    }
  });

  it('accepts two mounts that merely share a prefix of one segment', () => {
    // `messagesfoo` is not below `messages`: the host matches whole segments, so neither can take
    // the other's traffic and refusing this pair would refuse a tenant that is fine.
    expect(() => assertMounts('alpha', [mounted('memory', 'messages'), mounted('other', 'messagesfoo')])).not.toThrow();
  });
});
