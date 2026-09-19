import {
  defineIdentityProvider,
  principalFromDefault,
  principalFromDerivedId,
  type IdentityProvider,
  type IdentitySession,
  type Principal,
  type UserLevel,
} from '@harness/identity-api';
import { StaticIdentity } from '@harness/identity-api/testing';
import { ConfigError, type Logger, type SurfaceDirectory } from '@harness/shared';
import { parseSlackGroupsSettings, type SlackGroupsSettings } from './settings.js';

/** What a resolution decided, cached until the sync window is over. */
interface Decided {
  principal: Principal | null;
  at: number;
}

/**
 * Levels from group membership, never from a list.
 *
 * Three hundred people are six lines of configuration: a group per level, in order, plus named
 * exceptions and the document's own `defaults` for everyone else. A new hire joins a group and
 * exists; a leaver falls to the default, or to nothing when the document gives none.
 *
 * The order is exceptions, then groups, then the default, because that is the order of how
 * specific each answer is: a person named by id, then a person in a group, then everybody.
 *
 * The plug-in never imports a surface. It receives a `SurfaceDirectory` — two methods, both
 * taking a user id — through `IdentityDeps`, which is what lets one implementation serve any
 * transport whose workspace has a notion of a group, and what `pnpm arch` enforces.
 */
class GroupsIdentity implements IdentitySession {
  readonly name = 'slack-groups';

  private readonly declared: StaticIdentity;
  private readonly defaults: Readonly<Record<string, UserLevel>>;
  private readonly settings: SlackGroupsSettings;
  private readonly directory: SurfaceDirectory;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly decided = new Map<string, Decided>();
  private readonly minted = new Map<string, Principal>();

  constructor(args: {
    declared: StaticIdentity;
    defaults: Readonly<Record<string, UserLevel>>;
    settings: SlackGroupsSettings;
    directory: SurfaceDirectory;
    log: Logger;
    now?: () => number;
  }) {
    this.declared = args.declared;
    this.defaults = args.defaults;
    this.settings = args.settings;
    this.directory = args.directory;
    this.log = args.log;
    this.now = args.now ?? (() => Date.now());
  }

  private levelFor(userId: string, groups: readonly string[]): UserLevel | 'refuse' | null {
    const exception = this.settings.exceptions.find((entry) => entry.userId === userId);
    if (exception) return exception.level;
    const matched = this.settings.groups.find((entry) => groups.includes(entry.id));
    if (matched) return matched.level;
    return this.defaults[this.settings.surface] ?? null;
  }

  async resolve(ref: { surface: string; userId: string }): Promise<Principal | null> {
    const declared = await this.declared.resolve(ref);
    if (declared) return declared;
    if (ref.surface !== this.settings.surface) return null;

    const key = `${ref.surface}:${ref.userId}`;
    const cached = this.decided.get(key);
    if (cached && this.now() - cached.at < this.settings.sync.everySeconds * 1000) return cached.principal;

    const groups = await this.directory.groupsOf(ref.userId);
    const level = this.levelFor(ref.userId, groups);
    if (level === null || level === 'refuse') {
      this.decided.set(key, { principal: null, at: this.now() });
      return null;
    }
    const displayName = (await this.directory.displayNameOf(ref.userId)) ?? undefined;
    const minted = principalFromDefault(ref.surface, ref.userId, level, displayName);
    if (!minted) {
      this.decided.set(key, { principal: null, at: this.now() });
      return null;
    }
    // A derived id a declared principal already holds would hand one person another's history.
    if (await this.declared.get(minted.id)) {
      this.log.warn(`slack-groups: derived id "${minted.id}" is already declared; refusing the caller`);
      this.decided.set(key, { principal: null, at: this.now() });
      return null;
    }
    this.minted.set(minted.id, minted);
    this.decided.set(key, { principal: minted, at: this.now() });
    return minted;
  }

  async get(principalId: string): Promise<Principal | null> {
    return (
      (await this.declared.get(principalId)) ??
      this.minted.get(principalId) ??
      principalFromDerivedId(principalId, this.defaults)
    );
  }

  async list(): Promise<Principal[]> {
    return this.declared.list();
  }

  async stop(): Promise<void> {
    await this.declared.stop();
  }
}

export const identity: IdentityProvider = defineIdentityProvider({
  name: 'slack-groups',
  version: '0.1.0',
  secrets: [],
  connect: async (deps) => {
    const settings = parseSlackGroupsSettings(deps.settings);
    const directory = deps.directories[settings.surface];
    if (!directory) {
      throw new ConfigError(
        `no surface named "${settings.surface}" offers a directory; this provider resolves levels from group membership and cannot without one`,
      );
    }
    const { principals, defaults } = deps.identity;
    deps.log.info(
      `slack-groups identity: ${principals.length} declared, ${settings.groups.length} groups, ${settings.exceptions.length} exceptions, syncing every ${settings.sync.everySeconds}s`,
    );
    return new GroupsIdentity({
      declared: new StaticIdentity(principals, 'slack-groups'),
      defaults,
      settings,
      directory,
      log: deps.log,
    });
  },
});
