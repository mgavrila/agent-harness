import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

const good = {
  DATABASE_URL: 'postgres://x',
  KERNEL_DATABASE_URL: 'postgres://y',
  HOST_URL: 'http://host:8788',
  HARNESS_HOST_TOKEN: 'tok',
  HARNESS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  SESSION_SECRET: 'x'.repeat(32),
  PLATFORM_URL: 'https://platform.example',
  KNOWLEDGE_DIR: '/tmp/k',
};

describe('loadEnv', () => {
  it('parses the required variables and applies the defaults', () => {
    const env = loadEnv(good);
    expect(env.OIDC_ISSUER).toBe('https://accounts.google.com');
    expect(env.KNOWLEDGE_MOUNT).toBe('/srv/knowledge');
    expect(env.PORT).toBe(8790);
    expect(env.PLATFORM_SUPERADMINS).toEqual([]);
  });
  it('refuses a key that is not 32 bytes and a short session secret', () => {
    expect(() => loadEnv({ ...good, HARNESS_ENCRYPTION_KEY: 'AAAA' })).toThrow(/HARNESS_ENCRYPTION_KEY/);
    expect(() => loadEnv({ ...good, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
  it('splits superadmins on commas and lowercases them', () => {
    expect(loadEnv({ ...good, PLATFORM_SUPERADMINS: 'A@x.com, b@y.com' }).PLATFORM_SUPERADMINS).toEqual([
      'a@x.com',
      'b@y.com',
    ]);
  });
});
