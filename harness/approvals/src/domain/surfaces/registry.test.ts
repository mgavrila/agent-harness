import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, createLogger } from '@harness/shared';
import { MemorySurface } from '@harness/surface-api/testing';
import { loadSurfaces, surfacesOf } from './registry.js';

const deps = { env: {}, log: createLogger('test'), storageDir: '/nonexistent' };
const here = path.dirname(fileURLToPath(import.meta.url));

describe('loadSurfaces', () => {
  it('loads an adapter by name and makes the first one primary', async () => {
    const surfaces = await loadSurfaces(['@harness/surface-memory'], deps);
    expect(surfaces.all).toHaveLength(1);
    expect(surfaces.primary.name).toBe('memory');
    expect(surfaces.find('memory')).toBe(surfaces.primary);
  });

  it('refuses an empty list rather than starting a host nobody can answer', async () => {
    await expect(loadSurfaces([], deps)).rejects.toThrow(ConfigError);
    await expect(loadSurfaces([], deps)).rejects.toThrow(/declares no surface/);
  });

  it('names the module, and nothing about the filesystem, when one cannot be resolved', async () => {
    const err = await loadSurfaces(['@harness/surface-nope'], deps).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(
      'cannot load surface "@harness/surface-nope"; add it to @harness/approvals dependencies and run pnpm install',
    );
    expect((err as Error).message).not.toContain('node_modules');
  });

  it('refuses two adapters that answer to the same name', async () => {
    await expect(loadSurfaces(['@harness/surface-memory', '@harness/surface-memory'], deps)).rejects.toThrow(
      /both named "memory"/,
    );
  });

  it('loads the http surface by name', async () => {
    const surfaces = await loadSurfaces(['@harness/surface-http'], deps);
    expect(surfaces.all).toHaveLength(1);
    expect(surfaces.primary.name).toBe('http');
  });

  it('loads slack and http together, in the documented order, with slack primary', async () => {
    // Slack's `connect` builds a transport from env and opens nothing: there is no socket to
    // open any more, and `start()` — which `loadSurfaces` never calls — is the only thing that
    // reaches Slack at all. A fake token is enough to prove the two load together.
    const slackDeps = {
      ...deps,
      env: {
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_SIGNING_SECRET: 'a-signing-secret',
        SLACK_APPROVALS_CHANNEL: 'C0TEST',
      },
    };
    const surfaces = await loadSurfaces(['@harness/surface-slack', '@harness/surface-http'], slackDeps);
    expect(surfaces.all).toHaveLength(2);
    expect(surfaces.primary.name).toBe('slack');
    expect(surfaces.find('http')).toBeDefined();
  });
});

describe('surfacesOf', () => {
  it('answers by name and reports an unknown one as undefined', () => {
    const memory = new MemorySurface();
    const other = new MemorySurface({ name: 'other', conversation: 'other' });
    const surfaces = surfacesOf([memory, other]);
    expect(surfaces.primary).toBe(memory);
    expect(surfaces.find('other')).toBe(other);
    expect(surfaces.find('teams')).toBeUndefined();
  });

  it('refuses an empty list, because `primary` would be undefined and every caller assumes it', () => {
    expect(() => surfacesOf([])).toThrow(ConfigError);
  });
});

/**
 * Connecting fails the same three ways importing does, and an adapter that cannot reach its
 * transport must say so at startup rather than leave an approval nobody sees. Each fixture is a
 * throwaway module written under a temp directory next to this test and loaded by its absolute
 * `file://` URL, so none of them touches a real workspace package. Every temp directory is
 * removed after its test, pass or fail.
 */
describe('loadSurfaces when an adapter cannot connect', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(connectBody: string): string {
    const dir = mkdtempSync(path.join(here, '.tmp-surface-fixture-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'surface.ts');
    writeFileSync(
      file,
      `
      import { ConfigError } from '@harness/shared';
      import { defineSurface } from '@harness/surface-api';
      export const surface = defineSurface({
        name: 'unreachable',
        version: '0.0.0',
        secrets: [],
        connect: () => { ${connectBody} },
      });
      `,
      'utf8',
    );
    return pathToFileURL(file).href;
  }

  it('re-raises a ConfigError from connect with the adapter named in front', async () => {
    // A missing credential is the ordinary way this happens, and the operator needs to know
    // which of the surfaces they listed is the one complaining.
    const url = fixture(`throw new ConfigError('MY_ADAPTER_TOKEN is not set');`);
    await expect(loadSurfaces([url], deps)).rejects.toThrow(ConfigError);
    await expect(loadSurfaces([url], deps)).rejects.toThrow(`surface "${url}": MY_ADAPTER_TOKEN is not set`);
  });

  it('replaces any other connect failure with a message naming only the adapter, and logs the original', async () => {
    const secret = '/etc/only-the-log-should-see-this';
    const url = fixture(`throw new Error('could not read ${secret}');`);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(loadSurfaces([url], deps)).rejects.toThrow(ConfigError);
      await expect(loadSurfaces([url], deps)).rejects.toThrow(`surface "${url}" failed to connect`);
      await expect(loadSurfaces([url], deps)).rejects.not.toThrow(new RegExp(secret.replace(/\//g, '\\/')));
      expect(errorSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes(secret)))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
