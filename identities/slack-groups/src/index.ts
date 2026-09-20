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

/** A principal this process minted, and when — the same window bounds it. */
interface Minted {
  principal: Principal;
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
  private readonly minted = new Map<string, Minted>();

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

  /** Whether something decided at `at` may still be served, by the one window this plug-in has. */
  private fresh(at: number): boolean {
    return this.now() - at < this.settings.sync.everySeconds * 1000;
  }

  /**
   * Nobody, remembered as such until the window is over.
   *
   * A caller the groups do not place is asked about again on every message otherwise, and each
   * one is a round trip to the workspace for the same answer.
   */
  private refuse(key: string): null {
    this.decided.set(key, { principal: null, at: this.now() });
    return null;
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
    if (cached && this.fresh(cached.at)) return cached.principal;

    const groups = await this.directory.groupsOf(ref.userId);
    const level = this.levelFor(ref.userId, groups);
    if (level === null || level === 'refuse') return this.refuse(key);
    // A name is cosmetic and a level is not, so a workspace that will not say what somebody is
    // called does not cost them the level it already told us. `principalFromDefault` falls back to
    // the surface user id. A refusal from `groupsOf`, above, is a different matter and escapes.
    const displayName = await this.directory
      .displayNameOf(ref.userId)
      .then((name) => name ?? undefined)
      .catch((err: unknown) => {
        this.log.warn(`slack-groups: no display name for "${ref.userId}": ${String(err)}`);
        return undefined;
      });
    const minted = principalFromDefault(ref.surface, ref.userId, level, displayName);
    if (!minted) return this.refuse(key);
    // A derived id a declared principal already holds would hand one person another's history.
    if (await this.declared.get(minted.id)) {
      this.log.warn(`slack-groups: derived id "${minted.id}" is already declared; refusing the caller`);
      return this.refuse(key);
    }
    this.minted.set(minted.id, { principal: minted, at: this.now() });
    this.decided.set(key, { principal: minted, at: this.now() });
    return minted;
  }

  /**
   * Who a principal id names — and this is an authorisation path, not a lookup.
   *
   * A resumed turn asks by id after an approval decision and then runs as whoever it gets back,
   * so a group-derived level must not outlive the sync window here any more than it does in
   * `resolve`. Past the window the minted entry is skipped and the answer falls to what the id
   * alone can prove: the document's own default for that surface, which cannot drift. That is
   * also the answer a restarted process gives, so how long this one has been up stops mattering.
   */
  async get(principalId: string): Promise<Principal | null> {
    const declared = await this.declared.get(principalId);
    if (declared) return declared;
    const minted = this.minted.get(principalId);
    if (minted && this.fresh(minted.at)) return minted.principal;
    return principalFromDerivedId(principalId, this.defaults);
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
  // `async` with nothing to await is deliberate: both refusals below must reject rather than
  // throw synchronously, which is what `connect(deps): Promise<IdentitySession>` promises.
  // eslint-disable-next-line @typescript-eslint/require-await
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
