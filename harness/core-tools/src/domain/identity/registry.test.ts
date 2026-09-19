import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseIdentityFileWithDefaults } from '@harness/identity-api';
import { ConfigError, createLogger } from '@harness/shared';
import { DEFAULT_POLICY, decide } from '../tooling/policy.js';
import { loadIdentity } from './registry.js';

const log = createLogger('test');
let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

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

  it('refuses a module that exports no identity', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-identity-registry-'));
    const empty = path.join(dir, 'empty.mjs');
    writeFileSync(empty, 'export const nothing = 1;\n');
    await expect(loadIdentity(pathToFileURL(empty).href, deps)).rejects.toThrow(/exports no `identity`/);
  });

  it('re-raises a plug-in ConfigError with its name in front when connect throws', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-identity-registry-'));
    const throwing = path.join(dir, 'throwing.mjs');
    const specifier = pathToFileURL(throwing).href;
    writeFileSync(
      throwing,
      "export const identity = { name: 'throwing', version: '0.0.0', secrets: [], connect: async () => { throw new Error('boom'); } };\n",
    );
    const err = await loadIdentity(specifier, deps).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(`identity plug-in "${specifier}" failed to connect`);
  });
});
