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
  maxHistoryMessages: number;
}

/**
 * Everything the host's flows take: built once by `app/main.ts` (or `hostFixture` in a test) and
 * handed to every function as its first argument, so no module holds process-wide state. `active`
 * is the one mutable member — the runs in flight, by id, so a cancel can find its controller.
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
  active: Map<string, AbortController>;
}
