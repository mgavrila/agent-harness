import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { configSourceNameFrom, loadConfigSource } from './registry.js';

const log = { info() {}, warn() {}, error() {} };
const db = null as never;

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
