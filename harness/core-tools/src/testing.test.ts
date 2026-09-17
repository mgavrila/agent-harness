import { describe, expect, it } from 'vitest';
import type { Db } from '@harness/db';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { TEST_PACK_ENV, makeTestDeps } from './testing.js';

/**
 * The pin that keeps the suite off the public NPPES registry.
 *
 * It used to be `ToolDeps.verify`, which core owned and every test therefore inherited. A pack
 * owns its own configuration now and reads it when `tools(deps)` builds the catalogue, so what
 * stops a test reaching a live endpoint is the environment `makeTestDeps` hands over — and the
 * shipped `.env` a developer has on the same machine says the opposite. If this file goes red,
 * the suite is one filled-in `.env` away from making real outbound calls.
 *
 * No database is needed: nothing below calls a handler.
 */
const deps = () => makeTestDeps(null as unknown as Db);

describe('makeTestDeps', () => {
  it('hands a pack a fixed environment with the registry lookup off and the endpoint unroutable', () => {
    const { env } = deps();
    // The base map is empty and the pins come from the loaded pack's own `evals.testEnv`, which
    // is what keeps these four variable names out of the kernel.
    expect(TEST_PACK_ENV).toEqual({});
    expect(env).toEqual(healthcarePack.evals!.testEnv);
    expect(env.VERIFY_NPPES_ENABLED).toBe('false');
    expect(env.VERIFY_STATE_LICENSE_ENABLED).toBe('false');
    // Port 1 on the loopback interface: nothing listens there, so even a lookup that got past
    // the flag could not leave the machine.
    expect(env.NPPES_BASE_URL).toBe('http://127.0.0.1:1/api/');
  });

  it('is what the pack reads, so no ambient variable can switch the lookup back on', async () => {
    const d = deps();
    const verify = healthcarePack.tools!(d).find((t) => t.name === 'verify_nppes');
    expect(verify).toBeDefined();
    await expect(verify!.handler({ npi: '1063837144' }, d)).rejects.toThrow(/VERIFY_NPPES_ENABLED/);
  });

  it('lets a test that starts its own stub override the environment wholesale', () => {
    const env = { ...TEST_PACK_ENV, VERIFY_NPPES_ENABLED: 'true', NPPES_BASE_URL: 'http://127.0.0.1:9/api/' };
    expect(makeTestDeps(null as unknown as Db, { env }).env).toEqual(env);
  });
});
