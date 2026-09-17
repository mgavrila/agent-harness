import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { KernelConfig } from '@harness/core-tools';
import { makeTestDeps, type TestDepsOverrides } from '@harness/core-tools/testing';
import type { Db } from '@harness/db';
import { surfacesOf } from '@harness/approvals';
import type { Principal } from '@harness/identity-api';
import { StaticIdentity } from '@harness/identity-api/testing';
import { ScriptedRuntime, type Trajectory } from '@harness/runtime-api/testing';
import { MemorySurface } from '@harness/surface-api/testing';
import type { Host, HostBudget } from './domain/host.js';

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

export const HOST_PRINCIPAL: Principal = {
  id: 'svc-host',
  kind: 'service',
  level: 'service',
  displayName: 'Host',
  surfaces: {},
  attributes: {},
};
export const COORDINATOR: Principal = {
  id: 'u-coordinator',
  kind: 'user',
  level: 'lead',
  displayName: 'Coordinator',
  surfaces: { memory: 'U012' },
  attributes: {},
};
export const MEMBER: Principal = {
  id: 'u-member',
  kind: 'user',
  level: 'member',
  displayName: 'Member',
  surfaces: { memory: 'U345' },
  attributes: {},
};

export interface HostFixture {
  host: Host;
  surface: MemorySurface;
  identity: StaticIdentity;
  runtime: ScriptedRuntime;
  close(): Promise<void>;
}

/**
 * A whole host over the real kernel and Postgres, with the memory surface, a static identity
 * and a scripted runtime: what every flow test drives. The persona and skills are small
 * literals; a test that needs the shipped skills passes them through `testKernelConfig`'s packs
 * and `readSkillCatalogue`.
 */
export async function hostFixture(
  db: Db,
  opts: { trajectory: Trajectory; principals?: Principal[]; budget?: Partial<HostBudget>; streaming?: boolean },
): Promise<HostFixture> {
  const surface = new MemorySurface({ capabilities: { streaming: opts.streaming ?? false } });
  const identity = new StaticIdentity(opts.principals ?? [COORDINATOR, MEMBER, HOST_PRINCIPAL]);
  const runtime = new ScriptedRuntime(opts.trajectory);
  const host: Host = {
    db,
    config: testKernelConfig(db, { storageDir: mkdtempSync(path.join(tmpdir(), 'harness-host-')) }),
    client: 'test',
    identity,
    surfaces: surfacesOf([surface]),
    runtime,
    persona: 'You are the test assistant.',
    // A plain fixture name: the vocabulary scan of `harness/host/src` (kernel-vocabulary.test.ts)
    // forbids the product's own skill names in anything that is not itself a `*.test.ts` file.
    skills: [{ name: 'sample-skill', version: '1.0.0', description: 'a skill for tests', dir: '/nonexistent' }],
    model: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', route: 'chat', fallbackRoute: 'reason' },
    budget: { maxModelCalls: 30, maxToolCalls: 60, timeoutMs: 30_000, maxHistoryMessages: 40, ...opts.budget },
    servicePrincipal: HOST_PRINCIPAL,
    log: { info() {}, warn() {}, error() {} },
    // The same frozen clock `testKernelConfig`'s `now` carries (core-tools' `makeTestDeps`), so a
    // row an approval tool stages under one and a decision taken under the other agree on
    // whether it has expired — real wall-clock time would drift out of the TTL window depending
    // on when the suite happens to run, exactly the flakiness a frozen test clock exists to avoid.
    now: () => new Date('2026-09-15T12:00:00Z'),
    active: new Map(),
  };
  return {
    host,
    surface,
    identity,
    runtime,
    close: async () => {
      await runtime.stop();
    },
  };
}
