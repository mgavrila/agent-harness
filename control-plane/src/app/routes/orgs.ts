import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import * as z from 'zod/v4';
import type { Invitation } from '../../domain/organisations/types.js';
import { requireOrg } from '../middleware/org.js';
import { requireUser, type UserVars } from '../middleware/session.js';

const createOrgShape = z.object({ slug: z.string(), name: z.string().min(1) });
const setRoleShape = z.object({ role: z.enum(['owner', 'admin', 'member']) });
const inviteShape = z.object({ email: z.email(), role: z.enum(['admin', 'member']) });

/** The public invitation shape: `{ id, email, role, token, expiresAt }`, no internal organisation id. */
const asInvitation = (inv: Invitation) => ({
  id: inv.id,
  email: inv.email,
  role: inv.role,
  token: inv.token,
  expiresAt: inv.expiresAt,
});

export const orgsRoutes = new Hono<UserVars>()
  .post('/orgs', requireUser, zValidator('json', createOrgShape), async (c) => {
    const deps = c.get('deps');
    const org = await deps.orgs.create(c.get('user'), c.req.valid('json'));
    return c.json(org, 201);
  })
  .get('/orgs', requireUser, async (c) => {
    const deps = c.get('deps');
    const orgs = await deps.orgs.listFor(c.get('user'));
    return c.json(orgs);
  })
  .get('/orgs/:org', requireUser, requireOrg('member'), (c) => {
    return c.json({ ...c.get('org'), role: c.get('role') });
  })
  .get('/orgs/:org/members', requireUser, requireOrg('member'), async (c) => {
    const deps = c.get('deps');
    const members = await deps.orgs.members(c.get('org').id);
    return c.json(members);
  })
  .put('/orgs/:org/members/:userId', requireUser, requireOrg('owner'), zValidator('json', setRoleShape), async (c) => {
    const deps = c.get('deps');
    const { role } = c.req.valid('json');
    await deps.orgs.setRole(c.get('user'), c.get('org'), c.req.param('userId'), role);
    return c.json({ userId: c.req.param('userId'), role });
  })
  .delete('/orgs/:org/members/:userId', requireUser, requireOrg('owner'), async (c) => {
    const deps = c.get('deps');
    await deps.orgs.removeMember(c.get('user'), c.get('org'), c.req.param('userId'));
    return c.body(null, 204);
  })
  .post('/orgs/:org/invitations', requireUser, requireOrg('admin'), zValidator('json', inviteShape), async (c) => {
    const deps = c.get('deps');
    const inv = await deps.orgs.invite(c.get('user'), c.get('org'), c.req.valid('json'));
    return c.json(asInvitation(inv), 201);
  })
  .get('/orgs/:org/invitations', requireUser, requireOrg('owner'), async (c) => {
    const deps = c.get('deps');
    const invitations = await deps.orgs.listInvitations(c.get('org').id);
    return c.json(invitations.map(asInvitation));
  })
  .post('/invitations/:token/accept', requireUser, async (c) => {
    const deps = c.get('deps');
    const org = await deps.orgs.accept(c.get('user'), c.req.param('token'));
    return c.json(org);
  });
