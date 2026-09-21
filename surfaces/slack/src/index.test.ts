import { createLogger } from '@harness/shared';
import { describe, expect, it } from 'vitest';
import { surface } from './index.js';

describe('the Slack surface declaration', () => {
  it('declares its name and the credentials the host must never forward or log', () => {
    expect(surface.name).toBe('slack');
    expect([...surface.secrets].sort()).toEqual(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
  });

  it("reads the variables this client's document named, not the conventional ones", async () => {
    // Two tenants in one process hold two apps, so the variable an adapter reads is the one its
    // own document named. `deps.secrets` is field name to variable name, built in the host from
    // `surfaceSecretsOf`, and absent for a deployment that named nothing.
    const deps = {
      env: {
        TENANT_A_BOT: 'xoxb-tenant-a',
        TENANT_A_SIGNING: 'tenant-a-signing',
        SLACK_APPROVALS_CHANNEL: 'C0TEST',
      },
      log: createLogger('test'),
      storageDir: '/nonexistent',
      secrets: { botToken: 'TENANT_A_BOT', signingSecret: 'TENANT_A_SIGNING' },
    };
    // It connects on those two names alone: the conventional ones are not in this environment at
    // all, so a `connect` that reached for them would throw a ConfigError naming them.
    await expect(surface.connect(deps)).resolves.toMatchObject({ name: 'slack' });
    // And a document that named one variable this deployment does not set fails with that name.
    // Wrapped, because `connect` reads its configuration before it has anything to await and so
    // raises where it stands: the contract says a caller gets a promise, and this asserts what
    // that caller sees whichever way the failure arrives.
    await expect(
      (async () => surface.connect({ ...deps, secrets: { ...deps.secrets, signingSecret: 'TENANT_B_SIGNING' } }))(),
    ).rejects.toThrow(/TENANT_B_SIGNING/);
  });
});
