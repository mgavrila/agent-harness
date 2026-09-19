import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  defineIdentityProvider,
  parseIdentityFileWithDefaults,
  principalFromDefault,
  principalFromDerivedId,
  type IdentityProvider,
  type IdentitySession,
  type Principal,
  type UserLevel,
} from '@harness/identity-api';
import { StaticIdentity } from '@harness/identity-api/testing';
import { ConfigError, describeError, optionalEnv, type Logger } from '@harness/shared';

/**
 * The declared principals, plus the `defaults` rule for everyone else.
 *
 * A surface named in `defaults` admits someone the file never mentions, at the level the file
 * chose, under an id derived from theirs — `principalFromDefault` derives it, so the same person
 * is the same principal tomorrow and in the next process. A surface with no default refuses an
 * unknown user exactly as this plug-in always has: null is "not authorised", never a guest.
 *
 * `list()` stays the file's own answer, because that is the question preflight and the
 * scaffolder's check are asking: who does this deployment declare. `get()` does answer for a
 * minted principal, because an approval or an audit row that carries its id has to resolve —
 * including one minted before this process started, which is what `principalFromDerivedId` is
 * for: the map below is lost on every restart, and an approval outlives one.
 */
class IdentityWithDefaults implements IdentitySession {
  readonly name: string;

  private readonly declared: StaticIdentity;
  private readonly defaults: Readonly<Record<string, UserLevel>>;
  private readonly log: Logger;
  /** Minted principals, keyed by their own id, so each one is logged and derived once. */
  private readonly minted = new Map<string, Principal>();
  /** Derived ids a declared principal already holds: refused once with a warning, then silently. */
  private readonly refused = new Set<string>();

  constructor(declared: StaticIdentity, defaults: Readonly<Record<string, UserLevel>>, log: Logger) {
    this.declared = declared;
    this.defaults = defaults;
    this.log = log;
    this.name = declared.name;
  }

  async resolve(ref: { surface: string; userId: string }): Promise<Principal | null> {
    const declared = await this.declared.resolve(ref);
    if (declared) return declared;
    const level = this.defaults[ref.surface];
    if (level === undefined) return null;
    const minted = principalFromDefault(ref.surface, ref.userId, level);
    if (!minted) return null;
    const already = this.minted.get(minted.id);
    if (already) return already;
    if (this.refused.has(minted.id)) return null;
    // A derived id that a declared principal already holds would hand one person another's
    // history, so this caller is refused rather than admitted. It stays a refusal here rather
    // than a startup error because nothing at load knows which ids will be derived: a check over
    // the declared ids could only guess from their shape, and would refuse a file whose author
    // happened to end an id in eight hex characters. The warning is written once per colliding
    // id, not once per message, so a person who keeps typing does not fill the log.
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
 * Principals from a file in the client folder.
 *
 * `HARNESS_IDENTITY_FILE` overrides the location, for a test that spawns a server under a
 * client name that has no folder and for a bare-metal run whose client folder lives elsewhere.
 * Read off `deps.env`, never the ambient environment, for the same reason a pack reads
 * `deps.env`: whoever builds the bag decides what the plug-in can see.
 */
export const identity: IdentityProvider = defineIdentityProvider({
  name: 'static',
  version: '0.1.0',
  secrets: [],
  connect: async (deps) => {
    const file = optionalEnv('HARNESS_IDENTITY_FILE', deps.env) ?? path.join(deps.clientDir, 'identity.yaml');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      throw new ConfigError(
        `cannot read the identity file ${file} (${describeError(err)}); every client folder needs an identity.yaml`,
      );
    }
    const { principals, defaults } = parseIdentityFileWithDefaults(parseYaml(text));
    const surfaces = Object.keys(defaults);
    deps.log.info(
      `static identity: ${principals.length} principals from ${file}` +
        (surfaces.length > 0 ? `, and a default level on ${surfaces.join(', ')}` : ''),
    );
    return new IdentityWithDefaults(new StaticIdentity(principals, 'static'), defaults, deps.log);
  },
});
