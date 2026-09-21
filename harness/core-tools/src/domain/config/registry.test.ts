import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { configSourceNameFrom, loadConfigSource, loadSecretSource, secretSourceNameFrom } from './registry.js';

const log = { info() {}, warn() {}, error() {} };
/** A stand-in handle: the registry hands it to a source and neither of them reads it here. */
const db = {} as never;

describe('configSourceNameFrom', () => {
  it("has no default, because where a client comes from is a deployment's decision", () => {
    expect(() => configSourceNameFrom({})).toThrow(ConfigError);
    expect(() => configSourceNameFrom({})).toThrow(/HARNESS_CONFIG_SOURCE/);
    expect(configSourceNameFrom({ HARNESS_CONFIG_SOURCE: 'files' })).toBe('files');
  });

  it('refuses a name that is not one of the two, naming both', () => {
    expect(() => configSourceNameFrom({ HARNESS_CONFIG_SOURCE: 'etcd' })).toThrow(/files.*postgres/);
  });
});

describe('loadConfigSource', () => {
  it('loads the files source, and refuses one with no directory to read (invariant 18)', async () => {
    await expect(loadConfigSource('files', { env: {}, log, db })).rejects.toThrow(ConfigError);
    await expect(loadConfigSource('files', { env: {}, log, db })).rejects.toThrow(/HARNESS_CLIENTS_DIR/);
    const source = await loadConfigSource('files', { env: { HARNESS_CLIENTS_DIR: '/srv/tenants' }, log, db });
    expect(source.name).toBe('files');
  });

  it('loads the postgres source', async () => {
    expect((await loadConfigSource('postgres', { env: {}, log, db })).name).toBe('postgres');
  });

  it('refuses a source nobody ships', async () => {
    await expect(loadConfigSource('etcd', { env: {}, log, db })).rejects.toThrow(ConfigError);
  });
});

describe('secretSourceNameFrom', () => {
  it('has no default, because guessing would refuse a tenant whose secrets are in a store', () => {
    expect(() => secretSourceNameFrom({})).toThrow(ConfigError);
    expect(() => secretSourceNameFrom({})).toThrow(/HARNESS_SECRET_SOURCE/);
    expect(secretSourceNameFrom({ HARNESS_SECRET_SOURCE: 'env' })).toBe('env');
    expect(secretSourceNameFrom({ HARNESS_SECRET_SOURCE: 'postgres' })).toBe('postgres');
  });

  it('refuses a name that is not one of the two, naming both', () => {
    expect(() => secretSourceNameFrom({ HARNESS_SECRET_SOURCE: 'vault' })).toThrow(/env.*postgres/);
  });
});

describe('loadSecretSource', () => {
  it('loads the env source, which needs nothing but the environment it was handed', async () => {
    expect((await loadSecretSource('env', { env: {}, log, db })).name).toBe('env');
  });

  it('loads the postgres source, which needs a key', async () => {
    const env = { HARNESS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    expect((await loadSecretSource('postgres', { env, log, db })).name).toBe('postgres');
    await expect(loadSecretSource('postgres', { env: {}, log, db })).rejects.toThrow(/HARNESS_ENCRYPTION_KEY/);
  });

  it('refuses a source nobody ships', async () => {
    await expect(loadSecretSource('vault', { env: {}, log, db })).rejects.toThrow(ConfigError);
  });
});
