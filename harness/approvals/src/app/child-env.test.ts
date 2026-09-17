import { describe, it, expect } from 'vitest';
import { surface as slackSurface } from '@harness/surface-slack';
import { STUB_SECRET, stubSurface } from '../domain/surfaces/stub-surface.test-helpers.js';
import { coreToolsChildEnv, neverForwarded } from './child-env.js';

/**
 * The names the real adapter declares, read off its own `Surface.secrets` rather than written out
 * here. A hand-written array would keep passing on the day someone adds a fifth credential to the
 * adapter and forgets this list, which is the failure the test exists to catch.
 */
const declared = [...slackSurface.secrets];

const base: NodeJS.ProcessEnv = {
  PATH: '/usr/bin',
  HOME: '/home/node',
  DATABASE_URL: 'postgres://harness:harness@postgres:5432/harness',
  HARNESS_ENCRYPTION_KEY: 'a'.repeat(44),
  LITELLM_MASTER_KEY: 'sk-test',
};

const input = (over: NodeJS.ProcessEnv = {}) => ({
  env: { ...base, ...over },
  client: 'demo-practice',
  storageRoot: '/srv/harness-storage',
  surfaceSecrets: declared,
});

describe('coreToolsChildEnv', () => {
  it('carries what core-tools needs to start', () => {
    const env = coreToolsChildEnv(input());
    expect(env.DATABASE_URL).toBe(base.DATABASE_URL);
    expect(env.HARNESS_CLIENT).toBe('demo-practice');
    expect(env.HARNESS_STORAGE_DIR).toBe('/srv/harness-storage');
    expect(env.CORE_TOOLS_CALLER).toBe('approvals-app');
  });

  it('carries the gateway key, without which the child refuses to start', () => {
    // buildDepsFromEnv calls gatewayFromEnv, which throws on a missing key. A
    // child that cannot start turns every approved action into a failure, so
    // this is checked at launch rather than discovered on the first click.
    expect(coreToolsChildEnv(input()).LITELLM_MASTER_KEY).toBe('sk-test');
    expect(() => coreToolsChildEnv(input({ LITELLM_MASTER_KEY: '' }))).toThrow(/LITELLM_MASTER_KEY is not set/);
    expect(() => coreToolsChildEnv(input({ LITELLM_MASTER_KEY: undefined }))).toThrow(/LITELLM_MASTER_KEY is not set/);
  });

  it('forwards the gateway URL only when the deployment sets one', () => {
    expect(coreToolsChildEnv(input())).not.toHaveProperty('HARNESS_GATEWAY_URL');
    expect(coreToolsChildEnv(input({ HARNESS_GATEWAY_URL: 'http://litellm:4000' })).HARNESS_GATEWAY_URL).toBe(
      'http://litellm:4000',
    );
  });

  it('is an allowlist: no credential an adapter declared, and no provider key, reaches the child', () => {
    // A guard against the vacuous version of this test: an adapter declaring nothing would make
    // every assertion below pass over an empty list.
    expect(declared.length).toBeGreaterThan(0);
    const secrets = Object.fromEntries(neverForwarded(declared).map((name) => [name, `secret-${name}`]));
    const env = coreToolsChildEnv({ ...input(secrets), surfaceSecrets: declared });
    for (const name of neverForwarded(declared)) expect(env).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toContain('secret-');
  });

  /**
   * The same property with two adapters loaded, which is the arrangement `LoadedSurfaces.secrets`
   * exists for: the union of what both declared is what the child does not get. The second
   * adapter is a stub rather than the memory one because the memory adapter declares nothing, so
   * the union would be Slack's list and a host that kept only the first list would pass.
   */
  it('strips the union of two loaded adapters, not one adapter it happens to know about', () => {
    const union = [...new Set([...slackSurface.secrets, ...stubSurface.secrets])];
    expect(union).toContain(STUB_SECRET);
    expect(union).toEqual(expect.arrayContaining([...slackSurface.secrets]));
    const secrets = Object.fromEntries(neverForwarded(union).map((name) => [name, `secret-${name}`]));
    const env = coreToolsChildEnv({ ...input(secrets), surfaceSecrets: union });
    for (const name of neverForwarded(union)) expect(env).not.toHaveProperty(name);
    // Named on its own, because it is the one the first adapter does not declare: this is the
    // assertion that fails if the host ever strips only `surfaceSecrets[0]`'s list.
    expect(env).not.toHaveProperty(STUB_SECRET);
    expect(JSON.stringify(env)).not.toContain('secret-');
  });

  it('refuses to launch a child with no database or no key', () => {
    expect(() => coreToolsChildEnv(input({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL is not set/);
    expect(() => coreToolsChildEnv(input({ HARNESS_ENCRYPTION_KEY: undefined }))).toThrow(
      /HARNESS_ENCRYPTION_KEY is not set/,
    );
  });
});
