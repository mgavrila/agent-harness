export type Role = 'owner' | 'admin' | 'member';
export const ROLE_RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };
export interface Organisation {
  id: string;
  slug: string;
  name: string;
}
export interface Member {
  userId: string;
  email: string;
  name: string;
  role: Role;
}
export interface Invitation {
  id: string;
  email: string;
  role: 'admin' | 'member';
  token: string;
  expiresAt: Date;
  acceptedAt: Date | null;
}
