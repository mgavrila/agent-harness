import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../testing/app.js';

let t: TestApp;
let owner: { cookie: string; user: { id: string } };
let stranger: { cookie: string; user: { id: string } };
let root: { cookie: string };
beforeAll(async () => {
  t = await testApp();
  owner = await t.sessionFor({ sub: 'o', email: 'owner@example.com', name: 'Owner' });
  stranger = await t.sessionFor({ sub: 's', email: 'stranger@example.com', name: 'Stranger' });
  root = await t.sessionFor({ sub: 'r', email: 'root@example.com', name: 'Root' });
});
afterAll(() => t.close());

const json = (cookie: string, method: string, body?: unknown) => ({
  method,
  headers: { cookie, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

describe('organisations', () => {
  it('a signed-in user creates an organisation and is its owner', async () => {
    const res = await t.app.request('/api/v1/orgs', json(owner.cookie, 'POST', { slug: 'acme', name: 'Acme' }));
    expect(res.status).toBe(201);
    const list = (await (await t.app.request('/api/v1/orgs', { headers: { cookie: owner.cookie } })).json()) as {
      id: string;
      slug: string;
      name: string;
      role: string;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ slug: 'acme', name: 'Acme', role: 'owner' });
    expect(typeof list[0].id).toBe('string');
  });

  it('a slug must be a slug and unique', async () => {
    expect((await t.app.request('/api/v1/orgs', json(owner.cookie, 'POST', { slug: 'Acme!', name: 'x' }))).status).toBe(
      400,
    );
    expect((await t.app.request('/api/v1/orgs', json(owner.cookie, 'POST', { slug: 'acme', name: 'x' }))).status).toBe(
      409,
    );
  });

  it('a non-member gets 404 on every org route, a superadmin reads but cannot write', async () => {
    expect((await t.app.request('/api/v1/orgs/acme', { headers: { cookie: stranger.cookie } })).status).toBe(404);
    expect((await t.app.request('/api/v1/orgs/acme/members', { headers: { cookie: stranger.cookie } })).status).toBe(
      404,
    );
    expect((await t.app.request('/api/v1/orgs/acme', { headers: { cookie: root.cookie } })).status).toBe(200);
    expect(
      (
        await t.app.request(
          '/api/v1/orgs/acme/invitations',
          json(root.cookie, 'POST', { email: 'x@y.z', role: 'member' }),
        )
      ).status,
    ).toBe(404);
  });

  it('invite → accept as the invited e-mail → member; wrong e-mail is a 404; second accept is a 404', async () => {
    const inv = (await (
      await t.app.request(
        '/api/v1/orgs/acme/invitations',
        json(owner.cookie, 'POST', { email: 'new@example.com', role: 'admin' }),
      )
    ).json()) as { token: string };
    const other = await t.sessionFor({ sub: 'x', email: 'other@example.com', name: 'X' });
    expect((await t.app.request(`/api/v1/invitations/${inv.token}/accept`, json(other.cookie, 'POST'))).status).toBe(
      404,
    );
    const invited = await t.sessionFor({ sub: 'n', email: 'new@example.com', name: 'New' });
    expect((await t.app.request(`/api/v1/invitations/${inv.token}/accept`, json(invited.cookie, 'POST'))).status).toBe(
      200,
    );
    expect((await t.app.request(`/api/v1/invitations/${inv.token}/accept`, json(invited.cookie, 'POST'))).status).toBe(
      404,
    );
    const members = (await (
      await t.app.request('/api/v1/orgs/acme/members', { headers: { cookie: invited.cookie } })
    ).json()) as { role: string }[];
    expect(members.map((m) => m.role).sort()).toEqual(['admin', 'owner']);
  });

  it('an admin cannot change roles; an owner can; the last owner cannot be demoted or removed', async () => {
    const invited = await t.sessionFor({ sub: 'n', email: 'new@example.com', name: 'New' });
    expect(
      (
        await t.app.request(
          `/api/v1/orgs/acme/members/${owner.user.id}`,
          json(invited.cookie, 'PUT', { role: 'member' }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await t.app.request(`/api/v1/orgs/acme/members/${owner.user.id}`, json(owner.cookie, 'PUT', { role: 'member' })))
        .status,
    ).toBe(409);
    expect(
      (await t.app.request(`/api/v1/orgs/acme/members/${owner.user.id}`, json(owner.cookie, 'DELETE'))).status,
    ).toBe(409);
    expect(
      (
        await t.app.request(
          `/api/v1/orgs/acme/members/${invited.user.id}`,
          json(owner.cookie, 'PUT', { role: 'owner' }),
        )
      ).status,
    ).toBe(200);
  });

  it('GET /orgs/:org/invitations is owner-only and returns the token to copy; a superadmin reads as viewer', async () => {
    const inv = (await (
      await t.app.request(
        '/api/v1/orgs/acme/invitations',
        json(owner.cookie, 'POST', { email: 'admin2@example.com', role: 'admin' }),
      )
    ).json()) as { token: string };
    const admin2 = await t.sessionFor({ sub: 'a2', email: 'admin2@example.com', name: 'Admin2' });
    expect((await t.app.request(`/api/v1/invitations/${inv.token}/accept`, json(admin2.cookie, 'POST'))).status).toBe(
      200,
    );
    expect((await t.app.request('/api/v1/orgs/acme/invitations', { headers: { cookie: admin2.cookie } })).status).toBe(
      403,
    );
    const list = (await (
      await t.app.request('/api/v1/orgs/acme/invitations', { headers: { cookie: owner.cookie } })
    ).json()) as { token: string }[];
    expect(list.every((i) => typeof i.token === 'string' && i.token.length > 0)).toBe(true);
    expect((await t.app.request('/api/v1/orgs/acme/invitations', { headers: { cookie: root.cookie } })).status).toBe(
      200,
    );
  });

  it('every write is audited with the user and a summary that names no secret', async () => {
    const rows = await t.db.query.audit.findMany();
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['org.create', 'org.invite', 'org.accept', 'org.role', 'org.superadmin-read']),
    );
    for (const row of rows) expect(row.summary).not.toMatch(/[A-Za-z0-9_-]{20,}/);
  });
});
