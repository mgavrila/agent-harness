import { Hono } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { createSession, deleteSession } from '../../domain/users/repository.js';
import { badRequest } from '../../shared/errors.js';
import { randomState, randomVerifier } from '../auth/oidc.js';
import type { Deps } from '../deps.js';
import { LOGIN_COOKIE, requireUser, SESSION_COOKIE, SESSION_TTL_MS, type UserVars } from '../middleware/session.js';

const redirectUriOf = (deps: Deps) => `${deps.env.PLATFORM_URL}/api/v1/auth/callback`;
const cookieOpts = (deps: Deps, maxAge: number) => ({
  httpOnly: true,
  sameSite: 'Lax' as const,
  path: '/',
  secure: deps.env.PLATFORM_URL.startsWith('https://'),
  maxAge,
});

export const authRoutes = new Hono<UserVars>()
  .get('/auth/login', async (c) => {
    const deps = c.get('deps');
    const state = randomState();
    const verifier = randomVerifier();
    await setSignedCookie(
      c,
      LOGIN_COOKIE,
      JSON.stringify({ state, verifier }),
      deps.env.SESSION_SECRET,
      cookieOpts(deps, 600),
    );
    return c.redirect((await deps.oidc.authorizationUrl(state, verifier, redirectUriOf(deps))).href);
  })
  .get('/auth/callback', async (c) => {
    const deps = c.get('deps');
    const raw = await getSignedCookie(c, deps.env.SESSION_SECRET, LOGIN_COOKIE);
    if (!raw) throw badRequest('sign-in failed: no login in progress');
    let state: string;
    let verifier: string;
    try {
      ({ state, verifier } = JSON.parse(raw) as { state: string; verifier: string });
    } catch {
      throw badRequest('sign-in failed: malformed login state');
    }
    const current = new URL(c.req.url);
    const google = await deps.oidc.exchange(current, verifier, state, redirectUriOf(deps));
    const user = await deps.users.upsertFromGoogle(google);
    const session = await createSession(deps.db, user.id, SESSION_TTL_MS, deps.now());
    deleteCookie(c, LOGIN_COOKIE, { path: '/' });
    await setSignedCookie(
      c,
      SESSION_COOKIE,
      session.id,
      deps.env.SESSION_SECRET,
      cookieOpts(deps, SESSION_TTL_MS / 1000),
    );
    return c.redirect('/');
  })
  .post('/auth/logout', requireUser, async (c) => {
    const deps = c.get('deps');
    const id = await getSignedCookie(c, deps.env.SESSION_SECRET, SESSION_COOKIE);
    if (id) await deleteSession(deps.db, id);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  })
  .get('/me', requireUser, (c) => c.json(c.get('user')));
