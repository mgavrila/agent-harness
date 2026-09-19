/**
 * What a resolver is, and what it is handed — and **nothing else**.
 *
 * This module is a leaf: it imports no host module, not even a type. That is what lets
 * `conversation.ts` name a `ClientResolver` without the graph closing on itself.
 * `tenancy/types.ts` imports `playbooks/scheduler.ts` for `SchedulerHandle`, and
 * `playbooks/scheduler.ts` imports `conversation.ts` for `runTurn`; `.dependency-cruiser.cjs`
 * sets `tsPreCompilationDeps: true`, so a type-only import is an edge like any other, and
 * `no-circular` is an error. Keeping these two declarations out here is what keeps `pnpm arch`
 * green.
 */

/** Where an inbound thing came from, and what it said about which tenant it belongs to. */
export type InboundRef =
  | {
      from: 'surface';
      surface: string;
      /**
       * Whatever identifies the workspace the event came from, in that surface's own terms, or
       * null for a surface that has no such notion. Opaque here on purpose.
       */
      tenantHint: string | null;
    }
  | { from: 'api'; clientId: string | null };

export interface ClientResolver {
  readonly mode: 'dedicated' | 'pooled';
  /** The client this belongs to, or null — which is a refusal, and is audited. */
  resolve(ref: InboundRef): string | null;
}
