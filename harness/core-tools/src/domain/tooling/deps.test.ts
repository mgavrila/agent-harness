import { describe, expect, it } from 'vitest';
import type { Db } from '@harness/db';
import { PACK_KERNEL } from '../packs/kernel.js';
import { TEST_CONTEXT, TEST_PRINCIPAL, makeTestDeps } from '../../testing.js';
import { depsForRun, type KernelConfig } from './deps.js';

/** A config good enough to clone: `makeTestDeps` minus the per-run members. */
function config(): KernelConfig {
  const {
    db: _db,
    principal: _p,
    context: _c,
    sinks: _s,
    tools: _t,
    kernelTools: _k,
    kernel: _kn,
    ...rest
  } = makeTestDeps(null as unknown as Db);
  return rest;
}

describe('depsForRun', () => {
  it('clones the shared configuration and adds what only this run knows', () => {
    const shared = config();
    const db = { marker: 'db' } as unknown as Db;
    const deps = depsForRun(shared, { db, principal: TEST_PRINCIPAL, context: { ...TEST_CONTEXT, runId: 'r1' } });
    expect(deps.db).toBe(db);
    expect(deps.principal).toBe(TEST_PRINCIPAL);
    expect(deps.context.runId).toBe('r1');
    expect(deps.policy).toBe(shared.policy);
    expect(deps.packs).toBe(shared.packs);
    expect(deps.kernel).toBe(PACK_KERNEL);
    expect(deps.sinks).toEqual({});
  });

  it('gives every run its own tool maps, so two servers built from one config never share a catalogue', () => {
    const shared = config();
    const db = {} as Db;
    const one = depsForRun(shared, { db, principal: TEST_PRINCIPAL, context: TEST_CONTEXT });
    const two = depsForRun(shared, { db, principal: TEST_PRINCIPAL, context: TEST_CONTEXT });
    expect(one.tools).not.toBe(two.tools);
    expect(one.kernelTools).not.toBe(two.kernelTools);
    expect(one.context).toBe(TEST_CONTEXT);
  });
});
