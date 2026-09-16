import { describe, it, expect } from 'vitest';
import { coreToolsChildEnv, NEVER_FORWARDED } from './child-env.js';

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

  it('is an allowlist: no Slack token and no provider key reaches the child', () => {
    const secrets = Object.fromEntries(NEVER_FORWARDED.map((name) => [name, `secret-${name}`]));
    const env = coreToolsChildEnv(input(secrets));
    for (const name of NEVER_FORWARDED) expect(env).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toContain('secret-');
  });

  it('refuses to launch a child with no database or no key', () => {
    expect(() => coreToolsChildEnv(input({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL is not set/);
    expect(() => coreToolsChildEnv(input({ HARNESS_ENCRYPTION_KEY: undefined }))).toThrow(
      /HARNESS_ENCRYPTION_KEY is not set/,
    );
  });
});
