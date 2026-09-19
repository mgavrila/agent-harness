/**
 * Who a surface's users are, in the two questions a caller may ask about one.
 *
 * It lives here rather than in either contract because both `@harness/surface-api` and
 * `@harness/identity-api` need it and neither may import the other — the same reason the five
 * levels and the two id patterns live here.
 *
 * Both methods take the surface's own user id, which is the only name a surface and an identity
 * plug-in can both say. Neither answers a list of everybody: a directory is asked about the
 * person who just wrote, never enumerated.
 */
export interface SurfaceDirectory {
  /** The group ids this user belongs to on that surface. Empty when the user is in none. */
  groupsOf(userId: string): Promise<string[]>;
  /** How that surface says this user is called, or null when it will not say. */
  displayNameOf(userId: string): Promise<string | null>;
}
