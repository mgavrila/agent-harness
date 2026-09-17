import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, createLogger } from '@harness/shared';
import { DEFAULT_POLICY, decide } from '../tooling/policy.js';
import { loadIdentity } from './registry.js';

const log = createLogger('test');
let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A client folder holding only an identity file. */
function clientDir(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'harness-identity-registry-'));
  writeFileSync(
    path.join(dir, 'identity.yaml'),
    'principals:\n  - id: u-coordinator\n    kind: user\n    level: lead\n    displayName: Coordinator\n',
  );
  return dir;
}

describe('loadIdentity', () => {
  it('loads a plug-in by package name and connects it to the client folder', async () => {
    const session = await loadIdentity('@harness/identity-static', { env: {}, log, clientDir: clientDir() });
    const lead = await session.get('u-coordinator');
    expect(lead?.level).toBe('lead');
    // The resolved level is what every tool call is decided with.
    expect(decide('financial', lead!.level, DEFAULT_POLICY)).toBe('approval');
    await session.stop();
  });

  it('names the module, and nothing about the filesystem, when one cannot be resolved', async () => {
    const err = await loadIdentity('@harness/identity-nope', { env: {}, log, clientDir: '/nonexistent' }).catch(
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(
      'cannot load identity plug-in "@harness/identity-nope"; add it to @harness/core-tools dependencies and run pnpm install',
    );
    expect((err as Error).message).not.toContain('node_modules');
  });

  it('refuses a module that exports no identity, and re-raises a plug-in ConfigError with its name in front', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-identity-registry-'));
    const empty = path.join(dir, 'empty.mjs');
    writeFileSync(empty, 'export const nothing = 1;\n');
    await expect(loadIdentity(pathToFileURL(empty).href, { env: {}, log, clientDir: dir })).rejects.toThrow(
      /exports no `identity`/,
    );
    // The static plug-in raises a ConfigError for a missing file; the loader prefixes it.
    const err = await loadIdentity('@harness/identity-static', { env: {}, log, clientDir: dir }).catch(
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(
      /^identity plug-in "@harness\/identity-static": cannot read the identity file/,
    );
  });
});
