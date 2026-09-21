import { createLogger } from '@harness/shared';
import { describe, expect, it } from 'vitest';
import { slackConfig } from './config.js';
import { surface } from './index.js';

describe('the Slack surface declaration', () => {
  it('declares its name and the credentials the host must never forward or log', () => {
    expect(surface.name).toBe('slack');
    expect([...surface.secrets].sort()).toEqual(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
  });

  it("takes all three values from this client's document, and reads no environment variable", async () => {
    // Two tenants in one process hold two apps and two channels, so everything an adapter posts
    // with is what its own document named — the secrets resolved by the host, the channel copied
    // through it. The environment here is empty, and that is the assertion.
    const deps = {
      env: {},
      log: createLogger('test'),
      storageDir: '/nonexistent',
      secretValues: { botToken: 'xoxb-tenant-a', signingSecret: 'tenant-a-signing' },
      defaultConversation: 'C0ALPHA',
    };
    await expect(surface.connect(deps)).resolves.toMatchObject({ name: 'slack', defaultConversation: 'C0ALPHA' });
    // And a tenant whose secrets resolved to nothing is refused by the field the document names,
    // never by a variable it might have set. Wrapped, because `connect` reads its configuration
    // before it has anything to await and so raises where it stands: the contract says a caller
    // gets a promise, and this asserts what that caller sees whichever way the failure arrives.
    await expect((async () => surface.connect({ ...deps, secretValues: {} }))()).rejects.toThrow(
      /surfaces\.slack\.botToken/,
    );
  });

  it('refuses a tenant with no channel rather than falling back to a deployment-wide one', () => {
    // The fallback this replaces was `requiredEnv('SLACK_APPROVALS_CHANNEL')`: on a pooled host
    // that is one tenant's cards arriving in another tenant's workspace.
    expect(() => slackConfig({ botToken: 'xoxb-a', signingSecret: 'sig-a' })).toThrow(
      /surfaces\.slack\.approvalsChannel/,
    );
    expect(slackConfig({ botToken: 'xoxb-a', signingSecret: 'sig-a' }, 'C0ALPHA')).toEqual({
      botToken: 'xoxb-a',
      signingSecret: 'sig-a',
      defaultConversation: 'C0ALPHA',
    });
    // An empty value is as absent as a missing one: `resolveSecrets` refuses a blank secret for
    // every source, and a blank channel would post nowhere.
    expect(() => slackConfig({ botToken: '', signingSecret: 'sig-a' }, 'C0ALPHA')).toThrow(/botToken/);
  });
});
