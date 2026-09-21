import { createLogger } from '@harness/shared';
import { describe, expect, it } from 'vitest';
import { surface } from './index.js';

describe('the Slack surface declaration', () => {
  it('declares its name and the credentials the host must never forward or log', () => {
    expect(surface.name).toBe('slack');
    expect([...surface.secrets].sort()).toEqual(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
  });

  it("uses the values this client's document named, and falls back to the conventional variables", async () => {
    // Two tenants in one process hold two apps, so what an adapter posts as is what its own
    // document named — resolved by the host, from an environment variable or from a store, and
    // handed over as a value.
    const deps = {
      env: { SLACK_APPROVALS_CHANNEL: 'C0TEST' },
      log: createLogger('test'),
      storageDir: '/nonexistent',
      secretValues: { botToken: 'xoxb-tenant-a', signingSecret: 'tenant-a-signing' },
    };
    // Neither conventional variable is in this environment at all, so a `connect` that reached
    // for one would throw a ConfigError naming it.
    await expect(surface.connect(deps)).resolves.toMatchObject({ name: 'slack' });
    // And a deployment that resolved nothing falls back to them, and says which one is missing.
    // Wrapped, because `connect` reads its configuration before it has anything to await and so
    // raises where it stands: the contract says a caller gets a promise, and this asserts what
    // that caller sees whichever way the failure arrives.
    await expect((async () => surface.connect({ ...deps, secretValues: {} }))()).rejects.toThrow(/SLACK_BOT_TOKEN/);
  });
});
