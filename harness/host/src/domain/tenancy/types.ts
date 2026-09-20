import type { ClientDocument, ConfigSource, LoadedDocument } from '@harness/config-api';
import type { startRunner } from '@harness/approvals';
import type { Db } from '@harness/db';
import type { EnvSource, Logger } from '@harness/shared';
import type { Host } from '../host.js';
import type { SchedulerHandle } from '../playbooks/scheduler.js';
import type { ClientResolver } from './resolver-types.js';

/**
 * `InboundRef` and `ClientResolver` are declared in `./resolver-types.js` and re-exported here, so
 * that a caller has one place to import a tenancy type from while `conversation.ts` — which needs
 * only the resolver — can import the leaf and stay out of the cycle this module is part of (this
 * file reaches `playbooks/scheduler.ts`, which reaches `conversation.ts`).
 */
export type { ClientResolver, InboundRef } from './resolver-types.js';

/**
 * One client, running.
 *
 * `host` is the whole of what every host function already takes: its own database handle, its own
 * `KernelConfig`, its own identity session, its own surfaces with their own primary, its own
 * runtime, persona, skills, model and budget. Two tenants are two of these, which is what makes
 * invariant 13 a property of the structure rather than of a predicate somebody remembered to
 * write. `version` is what the pool caches by and what `ConfigSource.watch` moves.
 */
export interface Tenant {
  readonly clientId: string;
  readonly version: string;
  readonly document: ClientDocument;
  readonly host: Host;
  readonly runner: Awaited<ReturnType<typeof startRunner>>;
  readonly scheduler: SchedulerHandle;
  /**
   * Stop everything that brings work in — the scheduler, the approvals runner and every surface —
   * and leave the rest running so the turns in flight can finish. Idempotent, and never throws.
   *
   * This is the first half of `close`, separated because `invalidate` has to run it *before* it
   * evicts the tenant: a message that arrives while a document is reloading belongs to the tenant
   * that is reloading, and a tenant already out of the map would have it refused as another
   * client's and audited as such.
   */
  quiesce(): Promise<void>;
  /** Stop everything this tenant holds, in the order a shutdown needs. Never throws. */
  close(): Promise<void>;
}

export interface HostDeps {
  db: Db;
  env: EnvSource;
  log: Logger;
  now: () => Date;
  source: ConfigSource;
  /** `HARNESS_CLIENT` when it is set: this host serves that client and refuses every other. */
  dedicatedClient: string | null;
}

/** Every tenant this process is serving, and the one way to reach another. */
export interface HostPool extends HostDeps {
  readonly resolver: ClientResolver;
  readonly tenants: ReadonlyMap<string, Tenant>;
  /** The tenant for a client id, opening it if the source has one. Null when nobody does. */
  tenantFor(clientId: string): Promise<Tenant | null>;
  /** Drop a tenant whose document moved, after its turns in flight have drained. */
  invalidate(clientId: string): Promise<void>;
  /** Abort every tenant's turns in flight and wait for them, bounded. */
  drain(boundMs: number): Promise<void>;
  close(): Promise<void>;
  draining: boolean;
}

export type { LoadedDocument };
