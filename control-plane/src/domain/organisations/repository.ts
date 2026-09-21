import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/connect.js';
import { invitations, memberships, organisations, users } from '../db/schema.js';
import type { Invitation, Member, Organisation, Role } from './types.js';

/** The row shape `findInvitationByToken`/`insertInvitation`/`listInvitations` return: an `Invitation`
 * plus the organisation it belongs to, which the public `Invitation` type omits. */
export type InvitationRow = Invitation & { organisationId: string };

const asOrganisation = (row: { id: string; slug: string; name: string }): Organisation => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
});

const asInvitationRow = (row: typeof invitations.$inferSelect): InvitationRow => ({
  id: row.id,
  organisationId: row.organisationId,
  email: row.email,
  role: row.role,
  token: row.token,
  expiresAt: row.expiresAt,
  acceptedAt: row.acceptedAt,
});

export async function insertOrganisation(
  db: Db,
  input: { slug: string; name: string; createdBy: string },
): Promise<Organisation> {
  const [row] = await db.insert(organisations).values(input).returning();
  return asOrganisation(row);
}

export async function findOrganisationBySlug(db: Db, slug: string): Promise<Organisation | null> {
  const row = await db.query.organisations.findFirst({ where: eq(organisations.slug, slug) });
  return row ? asOrganisation(row) : null;
}

export async function findOrganisationById(db: Db, id: string): Promise<Organisation | null> {
  const row = await db.query.organisations.findFirst({ where: eq(organisations.id, id) });
  return row ? asOrganisation(row) : null;
}

export async function listOrganisationsFor(db: Db, userId: string): Promise<(Organisation & { role: Role })[]> {
  const rows = await db
    .select({
      id: organisations.id,
      slug: organisations.slug,
      name: organisations.name,
      role: memberships.role,
    })
    .from(memberships)
    .innerJoin(organisations, eq(memberships.organisationId, organisations.id))
    .where(eq(memberships.userId, userId));
  return rows.map((row) => ({ ...asOrganisation(row), role: row.role }));
}

export async function findMembership(db: Db, organisationId: string, userId: string): Promise<{ role: Role } | null> {
  const row = await db.query.memberships.findFirst({
    where: and(eq(memberships.organisationId, organisationId), eq(memberships.userId, userId)),
  });
  return row ? { role: row.role } : null;
}

export async function listMembers(db: Db, organisationId: string): Promise<Member[]> {
  const rows = await db
    .select({ userId: users.id, email: users.email, name: users.name, role: memberships.role })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.organisationId, organisationId));
  return rows;
}

export async function upsertMembership(db: Db, organisationId: string, userId: string, role: Role): Promise<void> {
  await db
    .insert(memberships)
    .values({ organisationId, userId, role })
    .onConflictDoUpdate({ target: [memberships.organisationId, memberships.userId], set: { role } });
}

export const deleteMembership = (db: Db, organisationId: string, userId: string) =>
  db.delete(memberships).where(and(eq(memberships.organisationId, organisationId), eq(memberships.userId, userId)));

export async function countOwners(db: Db, organisationId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memberships)
    .where(and(eq(memberships.organisationId, organisationId), eq(memberships.role, 'owner')));
  return row?.count ?? 0;
}

export async function insertInvitation(
  db: Db,
  input: {
    organisationId: string;
    email: string;
    role: 'admin' | 'member';
    token: string;
    invitedBy: string;
    expiresAt: Date;
  },
): Promise<InvitationRow> {
  const [row] = await db.insert(invitations).values(input).returning();
  return asInvitationRow(row);
}

export async function findInvitationByToken(db: Db, token: string): Promise<InvitationRow | null> {
  const row = await db.query.invitations.findFirst({ where: eq(invitations.token, token) });
  return row ? asInvitationRow(row) : null;
}

export const markAccepted = (db: Db, id: string, at: Date) =>
  db.update(invitations).set({ acceptedAt: at }).where(eq(invitations.id, id));

export async function listInvitations(db: Db, organisationId: string): Promise<InvitationRow[]> {
  const rows = await db.query.invitations.findMany({
    where: and(eq(invitations.organisationId, organisationId), isNull(invitations.acceptedAt)),
  });
  return rows.map(asInvitationRow);
}
