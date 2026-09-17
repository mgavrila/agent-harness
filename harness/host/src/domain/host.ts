import type { LoadedSurfaces } from '@harness/approvals';
import type { KernelConfig } from '@harness/core-tools';
import type { Db } from '@harness/db';
import type { IdentitySession, Principal } from '@harness/identity-api';
import type { RunSkill, RuntimeSession } from '@harness/runtime-api';
import type { Logger } from '@harness/shared';

export interface HostBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  timeoutMs: number;
  /**
   * How long after `timeoutMs` the host's own abort fires. The runtime arms a timeout on the same
   * budget; the margin is what keeps the two from racing, so the runtime's own "the run timed out"
   * is what the human reads rather than the host's "cancelled". `TIMEOUT_MARGIN_MS` in production.
   */
  timeoutMarginMs: number;
  maxHistoryMessages: number;
}

/** A turn in flight: the controller a cancel aborts, and the promise a shutdown drain waits on. */
export interface ActiveRun {
  controller: AbortController;
  /** Resolves — never rejects — once the turn has closed its run row and its kernel. */
  done: Promise<void>;
}

/**
 * Everything the host's flows take: built once by `app/main.ts` (or `hostFixture` in a test) and
 * handed to every function as its first argument, so no module holds process-wide state. `active`
 * and `turns` are the two mutable members — the runs in flight, by id, so a cancel can find its
 * controller and a shutdown can wait for them, and the turn chain per thread, so two messages in
 * one conversation run one after the other.
 */
export interface Host {
  db: Db;
  config: KernelConfig;
  client: string;
  identity: IdentitySession;
  surfaces: LoadedSurfaces;
  runtime: RuntimeSession;
  persona: string;
  skills: readonly RunSkill[];
  model: { baseUrl: string; apiKey: string; route: string; fallbackRoute?: string };
  budget: HostBudget;
  /** The host's own identity, for reconcile and, from Plan 9, for playbooks. */
  servicePrincipal: Principal;
  log: Logger;
  now: () => Date;
  active: Map<string, ActiveRun>;
  /** The tail of each thread's turn chain, by thread id; the entry is dropped when the chain drains. */
  turns: Map<string, Promise<void>>;
}
