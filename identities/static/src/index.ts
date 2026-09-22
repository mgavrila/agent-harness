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
import { describeError, type Logger, type SurfaceDirectory } from '@harness/shared';

/**
 * The declared principals, plus the `defaults` rule for everyone else.
 *
 * A surface named in `defaults` admits someone the document never mentions, at the level the
 * document chose, under an id derived from theirs — `principalFromDefault` derives it, so the
 * same person is the same principal tomorrow and in the next process. A surface with no default
 * refuses an unknown user exactly as this plug-in always has: null is "not authorised", never a
 * guest.
 *
 * `list()` stays the document's own answer, because that is the question preflight and the
 * scaffolder's check are asking: who does this client declare. `get()` does answer for a minted
 * principal, because an approval or an audit row that carries its id has to resolve — including
 * one minted before this process started, which is what `principalFromDerivedId` is for: the map
 * below is lost on every restart, and an approval outlives one.
 */
class IdentityWithDefaults implements IdentitySession {
  readonly name: string;

  private readonly declared: StaticIdentity;
  private readonly defaults: Readonly<Record<string, UserLevel>>;
  /** The directories the loaded surfaces offer, by surface name. A surface with none is absent. */
  private readonly directories: Readonly<Record<string, SurfaceDirectory>>;
  private readonly log: Logger;
  /** Minted principals, keyed by their own id, so each one is logged and derived once. */
  private readonly minted = new Map<string, Principal>();
  /** Derived ids a declared principal already holds: refused once with a warning, then silently. */
  private readonly refused = new Set<string>();

  constructor(
    declared: StaticIdentity,
    defaults: Readonly<Record<string, UserLevel>>,
    directories: Readonly<Record<string, SurfaceDirectory>>,
    log: Logger,
  ) {
    this.declared = declared;
    this.defaults = defaults;
    this.directories = directories;
    this.log = log;
    this.name = declared.name;
  }

  async resolve(ref: { surface: string; userId: string }): Promise<Principal | null> {
    const declared = await this.declared.resolve(ref);
    if (declared) return declared;
    const level = this.defaults[ref.surface];
    if (level === undefined) return null;
    // What the surface calls this person, when it has a directory and will say. A name is
    // cosmetic and a level is not, so neither a refusal nor a silence costs them the level the
    // document already gave them — the ruling `identities/slack-groups` already follows.
    // `principalFromDefault` falls back to the surface user id, which is what a person was
    // addressed as before this line existed.
    const displayName = await (this.directories[ref.surface]?.displayNameOf(ref.userId) ?? Promise.resolve(null))
      .then((name) => name ?? undefined)
      .catch((err: unknown) => {
        this.log.warn(`static identity: no display name for "${ref.userId}": ${describeError(err)}`);
        return undefined;
      });
    const minted = principalFromDefault(ref.surface, ref.userId, level, displayName);
    if (!minted) return null;
    const already = this.minted.get(minted.id);
    if (already) return already;
    if (this.refused.has(minted.id)) return null;
    // A derived id that a declared principal already holds would hand one person another's
    // history, so this caller is refused rather than admitted. It stays a refusal here rather
    // than a load-time error because nothing at load knows which ids will be derived: a check
    // over the declared ids could only guess from their shape, and would refuse a document whose
    // author happened to end an id in eight hex characters. The warning is written once per
    // colliding id, not once per message, so a person who keeps typing does not fill the log.
    if (await this.declared.get(minted.id)) {
      this.refused.add(minted.id);
      this.log.warn(`static identity: derived id "${minted.id}" is already declared; refusing the caller`);
      return null;
    }
    this.minted.set(minted.id, minted);
    this.log.info(`static identity: "${minted.id}" is not declared on ${ref.surface}; acting at level ${level}`);
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

/**
 * Principals from the client document's identity section.
 *
 * It reads no file and no environment variable: the host resolved the document through its
 * `ConfigSource` and handed this plug-in the one section that is its business. That is why a
 * client can live in a directory outside this repository, or in a table, without this plug-in
 * knowing either.
 */
export const identity: IdentityProvider = defineIdentityProvider({
  name: 'static',
  version: '0.2.0',
  secrets: [],
  connect: (deps) => {
    const { principals, defaults } = deps.identity;
    const surfaces = Object.keys(defaults);
    deps.log.info(
      `static identity: ${principals.length} principals` +
        (surfaces.length > 0 ? `, and a default level on ${surfaces.join(', ')}` : ''),
    );
    return Promise.resolve(
      new IdentityWithDefaults(new StaticIdentity(principals, 'static'), defaults, deps.directories, deps.log),
    );
  },
});
