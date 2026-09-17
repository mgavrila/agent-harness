import type { IdentitySession, Principal } from './types.js';

/**
 * An identity session over a list that is already in hand.
 *
 * It is two things at once and deliberately so: the whole of `@harness/identity-static`, which
 * wraps it around a parsed `identity.yaml`, and the fake every kernel test drives. One
 * implementation means the thing the suite proves the kernel against is the thing that runs. It
 * lives under the `testing` subpath because that is where a package's fakes live in this
 * repository.
 */
export class StaticIdentity implements IdentitySession {
  readonly name: string;
  stopped = false;

  private readonly principals: readonly Principal[];

  constructor(principals: readonly Principal[], name = 'static') {
    this.principals = principals;
    this.name = name;
  }

  async resolve(ref: { surface: string; userId: string }): Promise<Principal | null> {
    return this.principals.find((p) => p.surfaces[ref.surface] === ref.userId) ?? null;
  }

  async get(principalId: string): Promise<Principal | null> {
    return this.principals.find((p) => p.id === principalId) ?? null;
  }

  async list(): Promise<Principal[]> {
    return [...this.principals];
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
