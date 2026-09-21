import { getSignedCookie } from 'hono/cookie';
import { createMiddleware } from 'hono/factory';
import { findSession } from '../../domain/users/repository.js';
import type { User } from '../../domain/users/types.js';
import { unauthorized } from '../../shared/errors.js';
import type { Deps } from '../deps.js';

export const SESSION_COOKIE = 'hf1_session';
export const LOGIN_COOKIE = 'hf1_login';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export type UserVars = { Variables: { deps: Deps; user: User } };

export const requireUser = createMiddleware<UserVars>(async (c, next) => {
  const deps = c.get('deps');
  const id = await getSignedCookie(c, deps.env.SESSION_SECRET, SESSION_COOKIE);
  if (!id) throw unauthorized();
  const session = await findSession(deps.db, id, deps.now());
  if (!session) throw unauthorized();
  const user = await deps.users.byId(session.userId);
  if (!user) throw unauthorized();
  c.set('user', user);
  await next();
});
