import { createMiddleware } from 'hono/factory';
import type { Organisation, Role } from '../../domain/organisations/types.js';
import { ApiError, notFound } from '../../shared/errors.js';
import type { UserVars } from './session.js';

export type OrgVars = { Variables: UserVars['Variables'] & { org: Organisation; role: Role | 'viewer' } };

/** Resolve `:org`; 404 when invisible (P-1); 403 when visible but below `min`. Viewers pass only GET. */
export const requireOrg = (min: Role) =>
  createMiddleware<OrgVars>(async (c, next) => {
    const deps = c.get('deps');
    const found = await deps.orgs.bySlugFor(c.get('user'), c.req.param('org')!);
    if (!found) throw notFound('organisation');
    const isRead = c.req.method === 'GET';
    if (found.role === 'viewer' ? !isRead : !deps.orgs.atLeast(found.role, min)) {
      if (found.role === 'viewer') throw notFound('organisation');
      throw new ApiError(403, 'forbidden', `this action needs the ${min} role`);
    }
    c.set('org', found.org);
    c.set('role', found.role);
    await next();
  });
