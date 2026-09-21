import type { Db } from '../db/connect.js';
import { findUser, upsertUser } from './repository.js';
import type { User } from './types.js';

export function usersService(db: Db, superadmins: readonly string[]) {
  return {
    upsertFromGoogle: (g: { sub: string; email: string; name: string }): Promise<User> => {
      const email = g.email.trim().toLowerCase();
      return upsertUser(db, {
        sub: g.sub,
        email,
        name: g.name.trim() || email,
        superadmin: superadmins.includes(email),
      });
    },
    byId: (id: string) => findUser(db, id),
  };
}
