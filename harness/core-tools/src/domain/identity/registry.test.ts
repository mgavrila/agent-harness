import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseIdentityFileWithDefaults } from '@harness/identity-api';
import { ConfigError, createLogger } from '@harness/shared';
import { DEFAULT_POLICY, decide } from '../tooling/policy.js';
import { loadIdentity } from './registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('test');

const section = parseIdentityFileWithDefaults({
  principals: [{ id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator' }],
});
const deps = { env: {}, log, identity: section, settings: {} };

describe('loadIdentity', () => {
  it('loads a plug-in by package name and connects it with the identity section it is handed', async () => {
    const session = await loadIdentity('@harness/identity-static', deps);
    const lead = await session.get('u-coordinator');
    expect(lead?.level).toBe('lead');
    // The resolved level is what every tool call is decided with.
    expect(decide('financial', lead!.level, DEFAULT_POLICY)).toBe('approval');
    await session.stop();
  });

  it('names the module, and nothing about the filesystem, when one cannot be resolved', async () => {
    const err = await loadIdentity('@harness/identity-nope', deps).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(
      'cannot load identity plug-in "@harness/identity-nope"; add it to @harness/core-tools dependencies and run pnpm install',
    );
    expect((err as Error).message).not.toContain('node_modules');
  });
});

/**
 * `loadIdentity` tells three kinds of failure apart the way `loadPacks` does. Each fixture is a
 * throwaway module written under a temp directory next to this test and loaded by its absolute
 * `file://` URL, so a fixture can still `import` a workspace package (`@harness/shared`'s
 * `ConfigError`) without touching a real plug-in. Every temp directory is removed after its test,
 * pass or fail.
 */
describe('loadIdentity failure modes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(contents: string): string {
    const dir = mkdtempSync(path.join(here, '.tmp-identity-fixture-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'identity.ts');
    writeFileSync(file, contents, 'utf8');
    return pathToFileURL(file).href;
  }

  it('refuses a module that exports no identity', async () => {
    const url = fixture('export const nothing = 1;\n');
    await expect(loadIdentity(url, deps)).rejects.toThrow(/exports no `identity`/);
  });

  it('re-raises a ConfigError a plug-in throws while connecting, named', async () => {
    const url = fixture(`
      import { ConfigError } from '@harness/shared';
      export const identity = {
        name: 'broken',
        version: '0.0.0',
        secrets: [],
        connect: async () => { throw new ConfigError('directory is unreachable'); },
      };
    `);
    await expect(loadIdentity(url, deps)).rejects.toThrow(ConfigError);
    await expect(loadIdentity(url, deps)).rejects.toThrow(`identity plug-in "${url}": directory is unreachable`);
  });

  it('replaces any other connect failure with a message naming only the plug-in, and logs the original', async () => {
    const secret = '/etc/only-the-log-should-see-this';
    const url = fixture(`
      export const identity = {
        name: 'broken',
        version: '0.0.0',
        secrets: [],
        connect: async () => { throw new Error('could not read ${secret}'); },
      };
    `);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(loadIdentity(url, deps)).rejects.toThrow(ConfigError);
      await expect(loadIdentity(url, deps)).rejects.toThrow(`identity plug-in "${url}" failed to connect`);
      await expect(loadIdentity(url, deps)).rejects.not.toThrow(new RegExp(secret.replace(/\//g, '\\/')));
      expect(errorSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes(secret)))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
