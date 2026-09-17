import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { loadRuntime } from './registry.js';

const deps = {
  env: {},
  log: { info() {}, warn() {}, error() {} },
  databaseUrl: process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_test',
  storageDir: '/nonexistent',
};

describe('loadRuntime', () => {
  it('loads the Deep Agents runtime by its package name and connects it', async () => {
    const session = await loadRuntime('@harness/runtime-deepagents', deps);
    expect(session.name).toBe('deepagents');
    await session.stop();
  });

  it('names an unresolvable specifier without quoting a filesystem path', async () => {
    await expect(loadRuntime('@harness/runtime-nope', deps)).rejects.toThrow(
      /cannot load runtime plug-in "@harness\/runtime-nope"/,
    );
    await expect(loadRuntime('@harness/runtime-nope', deps)).rejects.not.toThrow(/node_modules/);
  });

  it('refuses a module that exports no runtime', async () => {
    await expect(loadRuntime('@harness/shared', deps)).rejects.toThrow(ConfigError);
  });
});
