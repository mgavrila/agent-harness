import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseClientDocument } from './document.js';
import { envSecretSource, envSecretValue, resolveSecrets } from './secrets.js';
import { MemorySecretSource, fixtureDocument } from './testing.js';

const log = { info() {}, warn() {}, error() {} };

/** A document that names one secret per shape, so one call exercises both branches. */
const withSecrets = (over: Record<string, unknown>) => parseClientDocument(fixtureDocument(over));

describe('envSecretValue', () => {
  it('answers what the environment holds, and refuses what it does not', () => {
    expect(envSecretValue({ WEB_TOKEN: 'tok' }, 'WEB_TOKEN')).toBe('tok');
    // Empty is unset, the rule every other reader in this repository follows: a half-filled .env
    // must not start a process that fails later and further from the cause.
    for (const env of [{}, { WEB_TOKEN: '' }, { WEB_TOKEN: '   ' }]) {
      expect(() => envSecretValue(env, 'WEB_TOKEN')).toThrow(ConfigError);
    }
  });
});

describe('the env secret source', () => {
  it('is named for what HARNESS_SECRET_SOURCE calls it', () => {
    expect(envSecretSource({}).name).toBe('env');
  });

  it('resolves an environment reference and refuses a store reference', async () => {
    const source = envSecretSource({ WEB_TOKEN: 'tok' });
    expect(await source.resolve('alpha', { env: 'WEB_TOKEN' })).toBe('tok');
    await expect(source.resolve('alpha', { ref: 'web-token' })).rejects.toThrow(ConfigError);
  });
});

describe('resolveSecrets', () => {
  it('answers a map keyed by surface and by the document’s own field name', async () => {
    const document = withSecrets({
      surfaces: {
        slack: {
          teamId: 'T0ABCDEF',
          signingSecret: { env: 'TENANT_A_SIGNING' },
          botToken: { env: 'TENANT_A_BOT' },
        },
      },
    });
    const source = envSecretSource({ TENANT_A_SIGNING: 'sig', TENANT_A_BOT: 'xoxb' });
    expect(await resolveSecrets(document, { source, log })).toEqual({
      surfaces: { slack: { signingSecret: 'sig', botToken: 'xoxb' } },
    });
  });

  it('answers an empty map for a document that names no secret at all', async () => {
    expect(await resolveSecrets(withSecrets({}), { source: envSecretSource({}), log })).toEqual({ surfaces: {} });
  });

  it('refuses a store reference under the env source, in the words a deployment already knows', async () => {
    const document = withSecrets({ surfaces: { web: { token: { ref: 'web-token' } }, memory: {} } });
    await expect(resolveSecrets(document, { source: envSecretSource({}), log })).rejects.toThrow(
      'client "fixture" names the secret "web-token" for web.token, and this deployment has no secret source',
    );
  });

  it('refuses an environment reference this deployment does not set, naming the surface and the variable', async () => {
    const document = withSecrets({ surfaces: { web: { token: { env: 'WEB_TOKEN' } }, memory: {} } });
    await expect(resolveSecrets(document, { source: envSecretSource({}), log })).rejects.toThrow(
      'client "fixture" declares the "web" surface, which needs WEB_TOKEN; this deployment does not set it',
    );
  });

  it('resolves a store reference through a source that has a store, and keeps two tenants apart', async () => {
    const source = new MemorySecretSource();
    source.put('alpha', 'web-token', 'tok-alpha');
    source.put('beta', 'web-token', 'tok-beta');
    const document = (id: string) =>
      parseClientDocument(
        fixtureDocument({ id, displayName: id, surfaces: { web: { token: { ref: 'web-token' } }, memory: {} } }),
      );
    expect(await resolveSecrets(document('alpha'), { source, log })).toEqual({
      surfaces: { web: { token: 'tok-alpha' } },
    });
    expect(await resolveSecrets(document('beta'), { source, log })).toEqual({
      surfaces: { web: { token: 'tok-beta' } },
    });
  });

  it('never repeats a value, and never repeats what a broken source said (invariant 21)', async () => {
    const lines: unknown[] = [];
    const broken = {
      name: 'broken',
      resolve: async (): Promise<string> => {
        throw new Error('select "ciphertext" from "client_secrets" failed near tok-alpha');
      },
    };
    const document = withSecrets({ surfaces: { web: { token: { ref: 'web-token' } }, memory: {} } });
    // Cast rather than `err as Error` inside the catch: `resolveSecrets` answers a map, so the
    // union a bare catch produces is `ResolvedSecrets | Error`. A call that resolved here would
    // fail the assertions below rather than pass silently.
    const failure = (await resolveSecrets(document, {
      source: broken,
      log: { info() {}, warn() {}, error: (...args: unknown[]) => lines.push(args) },
    }).catch((err: unknown) => err)) as Error;
    // The client and the secret's name, and after that only this source's own name. A driver's
    // message can carry a fragment of a statement and a statement can carry a value, so anything
    // that is not a ConfigError goes to the log and never into a message somebody stores.
    expect(failure.message).toContain('"web-token"');
    expect(failure.message).toContain('the "broken" secret source failed');
    expect(failure.message).not.toContain('tok-alpha');
    expect(failure.message).not.toContain('client_secrets');
    expect(lines).toHaveLength(1);
  });
});
