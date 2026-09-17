import type { KernelConfig } from '@harness/core-tools';
import { makeTestDeps, type TestDepsOverrides } from '@harness/core-tools/testing';
import type { Db } from '@harness/db';

export { useTestDb } from '@harness/db/testing';

/** The startup-only half of a test bag: `makeTestDeps` less the per-run members. */
export function testKernelConfig(db: Db, overrides: TestDepsOverrides = {}): KernelConfig {
  const {
    db: _db,
    principal: _principal,
    context: _context,
    sinks: _sinks,
    tools: _tools,
    kernelTools: _kernel,
    kernel: _k,
    ...config
  } = makeTestDeps(db, overrides);
  return config;
}
