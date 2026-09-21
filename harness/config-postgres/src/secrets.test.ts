import { describe, expect, it } from 'vitest';
// No `type Db`: `useTestDb()` hands one back and nothing here writes the type out. An unused
// import is a lint error, not a warning.
import { clientSecrets, decrypt, encrypt, loadKey } from '@harness/db';
import { encryptWith, useTestDb } from '@harness/db/testing';
import { ConfigError } from '@harness/shared';
import { parseClientDocument, resolveSecrets } from '@harness/config-api';
import {
  CONFORMANCE_SECRET_VALUE,
  CONFORMANCE_SECRET_VARIABLE,
  fixtureDocument,
  secretSourceConformance,
} from '@harness/config-api/testing';
import { postgresSecretSource, writeClientSecret } from './secrets.js';

const db = useTestDb();
const log = { info() {}, warn() {}, error() {} };

/** The deployment key every case here encrypts and decrypts with: 32 bytes, base64. */
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const env = { HARNESS_ENCRYPTION_KEY: KEY_B64, [CONFORMANCE_SECRET_VARIABLE]: CONFORMANCE_SECRET_VALUE };

secretSourceConformance(async () => ({
  source: postgresSecretSource({ db, env, log }),
  put: async (clientId, name, value) => {
    await writeClientSecret(db, { clientId, name, value }, loadKey(env));
  },
  close: async () => {},
}));

describe('the envelope', () => {
  /**
   * The vector spec section 4.10 fixes, both ways.
   *
   * It is a test rather than a comment because the platform's control plane encrypts with its own
   * code, in its own language, and only a vector proves the two agree. `encrypt` picks its own IV,
   * so the encrypt half goes through `encryptWith` on `@harness/db/testing`, which is the same
   * function with the IV supplied — that is what makes the assertion about these bytes rather
   * than about a round trip, and it is on a test-only subpath because an IV reused under one key
   * would destroy the envelope's confidentiality and its authentication at once.
   */
  const KEY = Buffer.from('BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=', 'base64');
  const BLOB = '03030303030303030303030338da626a160e623fe0c27fbca31a81945d91db61775c3b310e6d303988259a78';

  const IV = Buffer.alloc(12, 3);

  it('encrypts the vector to the bytes the spec names', () => {
    expect(encryptWith('xoxb-test-secret', KEY, IV).toString('hex')).toBe(BLOB);
  });

  it('decrypts the vector to the plaintext the spec names', () => {
    expect(decrypt(Buffer.from(BLOB, 'hex'), KEY)).toBe('xoxb-test-secret');
  });

  it('round-trips through the shipped pair, with the blob laid out iv || tag || ciphertext', () => {
    const blob = encrypt('xoxb-test-secret', KEY);
    expect(blob).toHaveLength(12 + 16 + 'xoxb-test-secret'.length);
    expect(decrypt(blob, KEY)).toBe('xoxb-test-secret');
  });

  it('stores the raw envelope in the column, not text and not base64', async () => {
    await writeClientSecret(db, { clientId: 'alpha', name: 'web-token', value: 'tok-alpha' }, loadKey(env));
    const [row] = await db.select().from(clientSecrets);
    expect(Buffer.isBuffer(row.ciphertext)).toBe(true);
    expect(row.ciphertext.toString('utf8')).not.toContain('tok-alpha');
    expect(decrypt(row.ciphertext, loadKey(env))).toBe('tok-alpha');
  });
});

describe('postgresSecretSource', () => {
  it('reads only the rows of the client it was asked about (invariant 21)', async () => {
    const key = loadKey(env);
    await writeClientSecret(db, { clientId: 'alpha', name: 'web-token', value: 'tok-alpha' }, key);
    await writeClientSecret(db, { clientId: 'beta', name: 'web-token', value: 'tok-beta' }, key);
    const source = postgresSecretSource({ db, env, log });
    expect(await source.resolve('alpha', { ref: 'web-token' })).toBe('tok-alpha');
    expect(await source.resolve('beta', { ref: 'web-token' })).toBe('tok-beta');
  });

  it('rewrites a secret in place, so a rotation is one row and not two', async () => {
    const key = loadKey(env);
    await writeClientSecret(db, { clientId: 'alpha', name: 'web-token', value: 'first' }, key);
    await writeClientSecret(db, { clientId: 'alpha', name: 'web-token', value: 'second' }, key);
    expect(await db.select().from(clientSecrets)).toHaveLength(1);
    expect(await postgresSecretSource({ db, env, log }).resolve('alpha', { ref: 'web-token' })).toBe('second');
  });

  it('refuses a value the deployment key cannot open, without repeating the ciphertext', async () => {
    await writeClientSecret(
      db,
      { clientId: 'alpha', name: 'web-token', value: 'tok-alpha' },
      // Somebody else's key: what a restored database or a rotated deployment key produces.
      Buffer.alloc(32, 9),
    );
    const failure = (await postgresSecretSource({ db, env, log })
      .resolve('alpha', { ref: 'web-token' })
      .catch((err: unknown) => err)) as Error;
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toContain('HARNESS_ENCRYPTION_KEY');
    expect(failure.message).not.toMatch(/[0-9a-f]{24}/);
  });

  it('a blank row is refused before it reaches a surface, through the real store', async () => {
    // The end of the empty-secret path, over Postgres rather than a fake: the row exists, it
    // decrypts, and what it decrypts to is nothing. `resolveSecrets` is what refuses it, which is
    // why this asserts through `resolveSecrets` rather than through the source — the source's own
    // answer is the blank string it was given, and the rule belongs above every source.
    await writeClientSecret(db, { clientId: 'alpha', name: 'web-token', value: '   ' }, loadKey(env));
    const document = parseClientDocument(
      fixtureDocument({ id: 'alpha', displayName: 'alpha', surfaces: { web: { token: { ref: 'web-token' } } } }),
    );
    await expect(resolveSecrets(document, { source: postgresSecretSource({ db, env, log }), log })).rejects.toThrow(
      'client "alpha" names the secret "web-token" for web.token, and this deployment does not set it',
    );
  });

  it('refuses to be built at all by a deployment with no usable key', () => {
    // At construction rather than on the first tenant that names a stored secret: a bad key is a
    // deployment that is wrong, and it should say so where it is configured.
    expect(() => postgresSecretSource({ db, env: {}, log })).toThrow(/HARNESS_ENCRYPTION_KEY/);
  });
});
