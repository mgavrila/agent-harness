import { describe, expect, it } from 'vitest';
import { envSecretSource, parseClientDocument, type ClientDocument, type SecretSource } from '@harness/config-api';
import { MemoryConfigSource, MemorySecretSource, fixtureDocument } from '@harness/config-api/testing';
import { useTestDb } from '../../testing.js';
import { createHost } from './pool.js';

const db = useTestDb();
const log = { info() {}, warn() {}, error() {} };

/**
 * A document that declares the web surface and the run API and nothing else.
 *
 * Every case in this file asserts on what happens **before** a surface is loaded:
 * `resolveSecrets` runs first, so a document whose secret cannot be resolved fails with the
 * secret's own message and `@harness/surface-web` is never reached. That ordering is spec section
 * 4.10's, and it is why these cases can drive the web surface's section of the schema in a task
 * that has not built the adapter yet.
 */
const webTenant = (id: string, token: Record<string, string>): ClientDocument =>
  parseClientDocument(fixtureDocument({ id, displayName: id, surfaces: { web: { token }, http: {} } }));

/** A pooled host over one document, with the secret source a case wants to drive. */
async function host(document: ClientDocument, secrets: SecretSource, env: Record<string, string> = {}) {
  return createHost({
    db,
    env: {
      HARNESS_STORAGE_DIR: '/nonexistent/storage',
      HARNESS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      LITELLM_MASTER_KEY: 'sk-test',
      ...env,
    },
    log,
    now: () => new Date('2026-09-15T12:00:00Z'),
    // One document, and `createHost` opens every client the source lists — so the failure a case
    // asserts on is the one `createHost` itself raises, with this tenant's own message in it.
    source: new MemoryConfigSource([{ document, version: 'v1' }]),
    secrets,
    dedicatedClient: null,
  });
}

describe('resolving a tenant’s secrets when it opens', () => {
  it('refuses a store reference when this deployment has no store', async () => {
    // The env source, not an empty `MemorySecretSource`: an empty store refuses a reference it
    // does not hold, and this case is about the source that has no store to hold one in.
    await expect(host(webTenant('alpha', { ref: 'web-token' }), envSecretSource({}))).rejects.toThrow(
      'client "alpha" names the secret "web-token" for web.token, and this deployment has no secret source',
    );
  });

  it('refuses an environment reference this deployment does not set, naming the surface and the variable', async () => {
    await expect(host(webTenant('alpha', { env: 'WEB_TOKEN' }), new MemorySecretSource())).rejects.toThrow(
      'client "alpha" declares the "web" surface, which needs WEB_TOKEN; this deployment does not set it',
    );
  });

  it('refuses a store reference the store does not hold, naming the client and the name and not the row', async () => {
    // Cast rather than `err as Error` inside the catch: `createHost` answers a pool, so the
    // union a bare catch produces is `HostPool | Error`. A case that opened would fail the
    // assertion below with an undefined message rather than passing silently.
    const failure = (await host(webTenant('alpha', { ref: 'web-token' }), new MemorySecretSource()).catch(
      (err: unknown) => err,
    )) as Error;
    expect(failure.message).toContain('client "alpha"');
    expect(failure.message).toContain('"web-token"');
    expect(failure.message).not.toContain('client_secrets');
  });

  it('resolves before it builds anything, so a broken secret is never a surface’s failure', async () => {
    // The proof that the order changed: `@harness/surface-web` does not exist in this task, so a
    // tenant that got as far as `loadSurfaces` would fail with "cannot load surface". It fails
    // with the secret's message instead.
    const failure = (await host(webTenant('alpha', { ref: 'web-token' }), new MemorySecretSource()).catch(
      (err: unknown) => err,
    )) as Error;
    expect(failure.message).not.toContain('cannot load surface');
  });

  it('keeps two tenants’ secrets apart under one name (invariant 21)', async () => {
    const secrets = new MemorySecretSource();
    secrets.put('alpha', 'web-token', 'tok-alpha');
    secrets.put('beta', 'web-token', 'tok-beta');
    // Resolved through the contract rather than through an open, because opening needs the
    // adapter Task 4 writes. Both halves of invariant 21 are here: each tenant reads its own, and
    // neither reaches the other's.
    expect(await secrets.resolve('alpha', { ref: 'web-token' })).toBe('tok-alpha');
    expect(await secrets.resolve('beta', { ref: 'web-token' })).toBe('tok-beta');
    await expect(secrets.resolve('gamma', { ref: 'web-token' })).rejects.toThrow();
  });

  it('never writes a resolved value into a refusal, however the source failed', async () => {
    const secrets = new MemorySecretSource();
    secrets.put('alpha', 'web-token', 'tok-alpha-supersecret');
    // A document that names a *different* secret: the store holds one value for this tenant and
    // the refusal is about another, so a refusal that leaked anything would leak this.
    const failure = (await host(webTenant('alpha', { ref: 'other-token' }), secrets).catch(
      (err: unknown) => err,
    )) as Error;
    expect(failure.message).toContain('"other-token"');
    expect(failure.message).not.toContain('tok-alpha-supersecret');
  });
});
