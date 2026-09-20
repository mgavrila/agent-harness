import type { Db } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { PACK_KERNEL } from '../packs/kernel.js';
import type { RunContext, ToolDeps } from './types.js';

/**
 * The startup-only part of `ToolDeps`: what `buildKernelConfig` reads and loads once per **tenant**
 * — packs, policy, the key, the gateway, the storage root — and every run of that tenant shares.
 *
 * Once per tenant and no longer once per process: a pooled host holds one of these per client it
 * serves, and `depsForRun` clones the tenant's own rather than a process-wide one.
 */
export type KernelConfig = Omit<
  ToolDeps,
  'db' | 'principal' | 'context' | 'sinks' | 'tools' | 'kernelTools' | 'kernel'
>;

/** What only one run knows. */
export interface RunDeps {
  db: Db;
  principal: Principal;
  context: RunContext;
}

/**
 * One `ToolDeps` for one run. The tool maps are fresh because `createCoreToolsServer` fills them
 * per server, and a second run's server must not find the first one's catalogue already there.
 */
export function depsForRun(config: KernelConfig, run: RunDeps): ToolDeps {
  return {
    ...config,
    db: run.db,
    principal: run.principal,
    context: run.context,
    sinks: {},
    tools: new Map(),
    kernelTools: new Map(),
    kernel: PACK_KERNEL,
  };
}
