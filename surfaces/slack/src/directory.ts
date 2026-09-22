import type { SurfaceDirectory } from '@harness/shared';
import type { SlackApi } from './transport/types.js';

/** How long the whole group membership map is reused before it is fetched again. */
export const DIRECTORY_CACHE_MS = 300_000;

/**
 * How long one person's display name is reused.
 *
 * Twelve times the group window, because the two answer different questions: a membership decides
 * a level and a workspace that has just moved somebody should be at most one window behind, while
 * a name is cosmetic and changes once a career. Every miss here is a `users.info` call on the path
 * that resolves a caller, so a short window is a request per person per turn.
 */
export const DIRECTORY_NAME_CACHE_MS = 3_600_000;

/**
 * How many names are held before the oldest falls out.
 *
 * Unbounded, this is one entry per distinct user for the life of the process — small per entry and
 * with no ceiling, which is the shape of a leak. Five hundred is every person in a large workspace
 * and a few kilobytes.
 */
export const DIRECTORY_NAME_LIMIT = 500;

export interface SlackDirectoryOptions {
  now: () => Date;
  cacheMs?: number;
  nameCacheMs?: number;
}

/**
 * Who belongs to what, according to the workspace.
 *
 * Two calls, not one per person: `usergroups.list` for the groups and `usergroups.users.list`
 * for each one's members, folded into a `userId → groupIds` map and reused for `cacheMs`. Three
 * hundred people and six groups is seven requests every five minutes, where asking per message
 * would be one per message; a workspace that has just moved somebody is at most one window
 * behind, which is what a directory-backed level is for.
 *
 * A display name is fetched per user and held on its own longer window, bounded at
 * `DIRECTORY_NAME_LIMIT` entries: it answers a different question from a membership, and it is
 * read once per person rather than in a loop.
 *
 * Nothing here is refused quietly: a workspace that will not answer — a missing scope, a rate
 * limit — throws, and the identity plug-in above decides what an unanswerable lookup means.
 */
export function slackDirectory(api: SlackApi, opts: SlackDirectoryOptions): SurfaceDirectory {
  const cacheMs = opts.cacheMs ?? DIRECTORY_CACHE_MS;
  const nameCacheMs = opts.nameCacheMs ?? DIRECTORY_NAME_CACHE_MS;
  let groups: Map<string, string[]> | null = null;
  let groupsAt = 0;
  const names = new Map<string, { value: string | null; at: number }>();

  const fresh = (at: number): boolean => opts.now().getTime() - at < cacheMs;

  const loadGroups = async (): Promise<Map<string, string[]>> => {
    if (groups && fresh(groupsAt)) return groups;
    const listed = await api.usergroups.list();
    const map = new Map<string, string[]>();
    for (const group of listed.usergroups ?? []) {
      const members = await api.usergroups.users.list({ usergroup: group.id });
      for (const userId of members.users ?? []) {
        map.set(userId, [...(map.get(userId) ?? []), group.id]);
      }
    }
    groups = map;
    groupsAt = opts.now().getTime();
    return map;
  };

  return {
    async groupsOf(userId) {
      return (await loadGroups()).get(userId) ?? [];
    },
    async displayNameOf(userId) {
      const cached = names.get(userId);
      if (cached && opts.now().getTime() - cached.at < nameCacheMs) return cached.value;
      const info = await api.users.info({ user: userId });
      const raw = info.user?.profile?.display_name || info.user?.real_name || info.user?.profile?.real_name || '';
      // `||` rather than `??`: a name that was nothing but whitespace is a workspace that will
      // not say, which is what null means here.
      const value = raw.trim() || null;
      // Re-inserted rather than updated, so the bound below drops the least recently *fetched*
      // entry: a `Map` keeps insertion order and a plain `set` on an existing key would not move it.
      names.delete(userId);
      names.set(userId, { value, at: opts.now().getTime() });
      if (names.size > DIRECTORY_NAME_LIMIT) {
        const oldest = names.keys().next();
        if (!oldest.done) names.delete(oldest.value);
      }
      return value;
    },
  };
}
