import { describe, expect, it } from 'vitest';
import { ConfigError, createLogger } from '@harness/shared';
import { MemorySurface } from '@harness/surface-api/testing';
import { loadSurfaces, surfacesOf } from './registry.js';

const deps = { env: {}, log: createLogger('test'), storageDir: '/nonexistent' };

describe('loadSurfaces', () => {
  it('loads an adapter by name and makes the first one primary', async () => {
    const surfaces = await loadSurfaces(['@harness/surface-memory'], deps);
    expect(surfaces.all).toHaveLength(1);
    expect(surfaces.primary.name).toBe('memory');
    expect(surfaces.byName('memory')).toBe(surfaces.primary);
    expect(surfaces.secrets).toEqual([]);
  });

  it('refuses an empty list rather than starting a host nobody can answer', async () => {
    await expect(loadSurfaces([], deps)).rejects.toThrow(ConfigError);
    await expect(loadSurfaces([], deps)).rejects.toThrow(/HARNESS_SURFACES/);
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
});

describe('surfacesOf', () => {
  it('answers by name and reports an unknown one as undefined, or throws when asked to insist', () => {
    const memory = new MemorySurface();
    const other = new MemorySurface({ name: 'other', conversation: 'other' });
    const surfaces = surfacesOf([memory, other], ['A_TOKEN']);
    expect(surfaces.primary).toBe(memory);
    expect(surfaces.find('other')).toBe(other);
    expect(surfaces.find('teams')).toBeUndefined();
    expect(() => surfaces.byName('teams')).toThrow(/no surface named "teams" is loaded/);
    expect(surfaces.secrets).toEqual(['A_TOKEN']);
  });

  it('refuses an empty list, because `primary` would be undefined and every caller assumes it', () => {
    expect(() => surfacesOf([])).toThrow(ConfigError);
  });
});
