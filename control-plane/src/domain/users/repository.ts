import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/connect.js';
import { sessions, users } from '../db/schema.js';
import type { User } from './types.js';

export async function upsertUser(
  db: Db,
  g: { sub: string; email: string; name: string; superadmin: boolean },
): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({ googleSub: g.sub, email: g.email, name: g.name, superadmin: g.superadmin })
    .onConflictDoUpdate({
      target: users.googleSub,
      set: { email: g.email, name: g.name, superadmin: g.superadmin },
    })
    .returning();
  return { id: row.id, email: row.email, name: row.name, superadmin: row.superadmin };
}

export async function findUser(db: Db, id: string): Promise<User | null> {
  const row = await db.query.users.findFirst({ where: eq(users.id, id) });
  return row ? { id: row.id, email: row.email, name: row.name, superadmin: row.superadmin } : null;
}

export async function createSession(
  db: Db,
  userId: string,
  ttlMs: number,
  now: Date,
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ttlMs);
  await db.insert(sessions).values({ id, userId, expiresAt });
  return { id, expiresAt };
}

export async function findSession(db: Db, id: string, now: Date): Promise<{ userId: string } | null> {
  const row = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
  return row && row.expiresAt > now ? { userId: row.userId } : null;
}

export const deleteSession = (db: Db, id: string) => db.delete(sessions).where(eq(sessions.id, id));
