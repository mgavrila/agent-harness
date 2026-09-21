import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../testing/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(() => t.close());

/** Pick the one Set-Cookie header for the given cookie name out of a response's full set. */
function cookieNamed(response: Response, name: string): string {
  const entry = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  if (!entry) throw new Error(`no ${name} cookie in response`);
  return entry.split(';')[0];
}

/** Follow the login redirect to the fake issuer, then bring its redirect back to the callback. */
async function signInThroughGoogle(user: { sub: string; email: string; name: string }): Promise<string> {
  t.issuer.nextUser(user);
  const login = await t.app.request('/api/v1/auth/login');
  expect(login.status).toBe(302);
  const loginCookie = cookieNamed(login, 'hf1_login');
  expect(login.headers.get('set-cookie')).toMatch(/hf1_login=.*HttpOnly/);
  const atIssuer = await fetch(login.headers.get('location')!, { redirect: 'manual' });
  const back = new URL(atIssuer.headers.get('location')!);
  const callback = await t.app.request(back.pathname + back.search, {
    headers: { cookie: loginCookie },
  });
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toBe('/');
  const sessionCookie = cookieNamed(callback, 'hf1_session');
  expect(sessionCookie).toMatch(/hf1_session=/);
  expect(callback.headers.getSetCookie().join(' ')).toMatch(/hf1_session=.*HttpOnly/);
  return sessionCookie;
}

describe('auth', () => {
  it('signs a new Google account in, creates the user, and /me answers', async () => {
    const cookie = await signInThroughGoogle({ sub: 'g-1', email: 'Jane@Example.com', name: 'Jane' });
    const me = await t.app.request('/api/v1/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'jane@example.com', name: 'Jane', superadmin: false });
  });
  it('the same sub signs in as the same user; a superadmin e-mail gets the flag', async () => {
    const a = await signInThroughGoogle({ sub: 'g-2', email: 'root@example.com', name: 'Root' });
    const b = await signInThroughGoogle({ sub: 'g-2', email: 'root@example.com', name: 'Root R.' });
    const [ma, mb] = await Promise.all([
      t.app.request('/api/v1/me', { headers: { cookie: a } }),
      t.app.request('/api/v1/me', { headers: { cookie: b } }),
    ]);
    const [ja, jb] = (await Promise.all([ma.json(), mb.json()])) as { id: string; superadmin: boolean }[];
    expect(ja.id).toBe(jb.id);
    expect(jb.superadmin).toBe(true);
  });
  it('a callback with the wrong state is refused; no cookie is a 401; logout clears the session', async () => {
    const bad = await t.app.request('/api/v1/auth/callback?code=x&state=y');
    expect(bad.status).toBe(400);
    expect((await t.app.request('/api/v1/me')).status).toBe(401);
    const cookie = await signInThroughGoogle({ sub: 'g-3', email: 'c@example.com', name: 'C' });
    const out = await t.app.request('/api/v1/auth/logout', { method: 'POST', headers: { cookie } });
    expect(out.status).toBe(204);
    expect((await t.app.request('/api/v1/me', { headers: { cookie } })).status).toBe(401);
  });
  it('a callback with a valid login cookie but a state that does not match it is refused', async () => {
    t.issuer.nextUser({ sub: 'g-4', email: 'd@example.com', name: 'D' });
    const login = await t.app.request('/api/v1/auth/login');
    expect(login.status).toBe(302);
    const loginCookie = cookieNamed(login, 'hf1_login');
    const atIssuer = await fetch(login.headers.get('location')!, { redirect: 'manual' });
    const back = new URL(atIssuer.headers.get('location')!);
    back.searchParams.set('state', 'not-the-real-state');
    const callback = await t.app.request(back.pathname + back.search, {
      headers: { cookie: loginCookie },
    });
    expect(callback.status).toBe(400);
  });
});
