import { randomBytes } from 'node:crypto';
import { record } from '../audit/repository.js';
import type { Db } from '../db/connect.js';
import type { User } from '../users/types.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { SLUG_PATTERN } from '../../shared/ids.js';
import * as repo from './repository.js';
import { ROLE_RANK, type Organisation, type Role } from './types.js';

export const INVITATION_TTL_MS = 7 * 24 * 3600 * 1000;

export function organisationsService(db: Db, now: () => Date) {
  return {
    async create(user: User, input: { slug: string; name: string }): Promise<Organisation> {
      if (!SLUG_PATTERN.test(input.slug))
        throw badRequest('slug must be lowercase letters, digits and hyphens, 2–32 characters, letter first');
      if (await repo.findOrganisationBySlug(db, input.slug))
        throw conflict(`an organisation with slug "${input.slug}" exists`);
      const org = await repo.insertOrganisation(db, {
        slug: input.slug,
        name: input.name.trim(),
        createdBy: user.id,
      });
      await repo.upsertMembership(db, org.id, user.id, 'owner');
      await record(db, {
        userId: user.id,
        organisationId: org.id,
        action: 'org.create',
        summary: `created organisation ${org.slug}`,
      });
      return org;
    },
    listFor: (user: User) => repo.listOrganisationsFor(db, user.id),
    /** null when the user may not see the organisation at all (P-1). Superadmins see every org as 'viewer'. */
    async bySlugFor(user: User, slug: string): Promise<{ org: Organisation; role: Role | 'viewer' } | null> {
      const org = await repo.findOrganisationBySlug(db, slug);
      if (!org) return null;
      const membership = await repo.findMembership(db, org.id, user.id);
      if (membership) return { org, role: membership.role };
      if (user.superadmin) {
        await record(db, {
          userId: user.id,
          organisationId: org.id,
          action: 'org.superadmin-read',
          summary: `superadmin read ${org.slug}`,
        });
        return { org, role: 'viewer' };
      }
      return null;
    },
    members: (orgId: string) => repo.listMembers(db, orgId),
    async setRole(by: User, org: Organisation, userId: string, role: Role) {
      const current = await repo.findMembership(db, org.id, userId);
      if (!current) throw notFound('member');
      if (current.role === 'owner' && role !== 'owner' && (await repo.countOwners(db, org.id)) === 1)
        throw conflict('the last owner cannot be demoted');
      await repo.upsertMembership(db, org.id, userId, role);
      await record(db, {
        userId: by.id,
        organisationId: org.id,
        action: 'org.role',
        summary: `set role ${role} on a member`,
      });
    },
    async removeMember(by: User, org: Organisation, userId: string) {
      const current = await repo.findMembership(db, org.id, userId);
      if (!current) throw notFound('member');
      if (current.role === 'owner' && (await repo.countOwners(db, org.id)) === 1)
        throw conflict('the last owner cannot be removed');
      await repo.deleteMembership(db, org.id, userId);
      await record(db, {
        userId: by.id,
        organisationId: org.id,
        action: 'org.remove-member',
        summary: 'removed a member',
      });
    },
    async invite(by: User, org: Organisation, input: { email: string; role: 'admin' | 'member' }) {
      const token = randomBytes(24).toString('base64url');
      const inv = await repo.insertInvitation(db, {
        organisationId: org.id,
        email: input.email.trim().toLowerCase(),
        role: input.role,
        token,
        invitedBy: by.id,
        expiresAt: new Date(now().getTime() + INVITATION_TTL_MS),
      });
      await record(db, {
        userId: by.id,
        organisationId: org.id,
        action: 'org.invite',
        summary: `invited ${inv.email} as ${inv.role}`,
      });
      return inv;
    },
    listInvitations: (orgId: string) => repo.listInvitations(db, orgId),
    async accept(user: User, token: string): Promise<Organisation> {
      const inv = await repo.findInvitationByToken(db, token);
      if (!inv || inv.acceptedAt || inv.expiresAt < now() || inv.email !== user.email.trim().toLowerCase())
        throw notFound('invitation');
      await repo.upsertMembership(db, inv.organisationId, user.id, inv.role);
      await repo.markAccepted(db, inv.id, now());
      await record(db, {
        userId: user.id,
        organisationId: inv.organisationId,
        action: 'org.accept',
        summary: `accepted an invitation as ${inv.role}`,
      });
      return (await repo.findOrganisationById(db, inv.organisationId))!;
    },
    atLeast: (role: Role | 'viewer', min: Role) => role !== 'viewer' && ROLE_RANK[role] >= ROLE_RANK[min],
  };
}
export type OrganisationsService = ReturnType<typeof organisationsService>;
