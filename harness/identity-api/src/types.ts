import type { EnvSource, Level, Logger } from '@harness/shared';

/** The four levels a person may hold. A `service` level belongs to a declared service, never to a default. */
export type UserLevel = Exclude<Level, 'service'>;

/**
 * Every declaration of the identity contract, in one leaf module.
 *
 * The same arrangement `@harness/pack-api` and `@harness/surface-api` use: `identity.ts`,
 * `principals.ts` and `testing.ts` re-export from here and keep their own runtime functions, so no
 * two modules of this package can end up importing each other. It imports types from
 * `@harness/shared` and nothing else.
 */

/**
 * Who a run acts as. Resolved by an identity plug-in, bound by whoever opens the run, read by a
 * tool off `deps.principal`; nothing a model sends can set it.
 */
export interface Principal {
  /**
   * Stable, opaque, lowercase: `u-` prefix for a person, `svc-` for a service. Stored on `runs`,
   * `approvals.requested_by` and `audit_log.caller`, so it never changes for a person.
   */
  readonly id: string;
  readonly kind: 'user' | 'service';
  readonly level: Level;
  readonly displayName: string;
  /**
   * This principal's user id on each surface it may speak from, keyed by the surface's name as
   * `HARNESS_SURFACES` and `approvals.surface` spell it. Empty for a service.
   */
  readonly surfaces: Readonly<Record<string, string>>;
  /** Free-form, plug-in-defined: department, role, groups. Never a restricted value. */
  readonly attributes: Readonly<Record<string, string>>;
}

/** A connected identity plug-in. */
export interface IdentitySession {
  /** The plug-in's name, as the client document's `identityPlugin.kind` named it. */
  readonly name: string;
  /**
   * The principal behind a surface user id, or null. **Null is "not authorised", never a guest**:
   * a caller that gets null runs nothing.
   */
  resolve(ref: { surface: string; userId: string }): Promise<Principal | null>;
  get(principalId: string): Promise<Principal | null>;
  /** Every principal this plug-in knows; used by preflight and by the scaffolder's check. */
  list(): Promise<Principal[]>;
  stop(): Promise<void>;
}

/** A parsed identity section: who is declared, and what each surface gives everyone else. */
export interface IdentityFile {
  principals: Principal[];
  defaults: Record<string, UserLevel>;
}

/**
 * What a plug-in is handed when it connects.
 *
 * `env` is the only environment it may read — never the ambient one — for the same reason a pack
 * reads `deps.env`. `identity` is this client's own section of the client document, already
 * validated: the declared principals and the level each surface gives everyone else. **A plug-in
 * is never handed a path**, because a client is not a folder any more, and never handed the whole
 * document, because who is asking is the only part of it that is a plug-in's business.
 * `settings` is whatever the document's `identityPlugin.settings` held, which the plug-in
 * validates with its own schema.
 */
export interface IdentityDeps {
  env: EnvSource;
  log: Logger;
  identity: IdentityFile;
  settings: Readonly<Record<string, unknown>>;
}

/** What an `identities/*` package exports as `identity`. */
export interface IdentityProvider {
  /** Lowercase, stable. */
  name: string;
  version: string;
  /** The environment variable names this plug-in reads that are credentials. */
  secrets: readonly string[];
  connect(deps: IdentityDeps): Promise<IdentitySession>;
}

/**
 * The module shape the kernel loads by name: `import(name)` resolves to `{ identity }`.
 *
 * Named separately so the kernel can type the dynamic import without spelling the word this
 * interface's name carries — `harness/core-tools/src/kernel-vocabulary.test.ts` forbids it there,
 * because it is also what one area of the product calls its records.
 */
export interface IdentityModule {
  identity: IdentityProvider;
}
