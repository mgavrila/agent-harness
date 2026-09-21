import { describe, expect, it } from 'vitest';
import { ToolError } from '@harness/shared';
import type { ExecOptions, ExecResult, Sandbox, SandboxProvider, SandboxSession } from './types.js';

const session: SandboxSession = { client: 'leaky', runId: 'r-leaky', principalId: 'u-leaky' };

/**
 * Deliberately breaks the contract `sandboxProviderConformance` exists to pin: `terminate` stops
 * `exec`, but a caller can still read and write files afterward. Exists only so the test below can
 * prove the suite's post-terminate check is strict enough to catch it — round 1 review found that
 * it checked only `exec`, so a provider this permissive would have passed conformance.
 */
class LeakyTerminateProvider implements SandboxProvider {
  readonly name = 'leaky-terminate';

  async acquire(_session: SandboxSession): Promise<Sandbox> {
    const files = new Map<string, Uint8Array>();
    let live = true;
    return {
      exec: async (_command: string, _opts: ExecOptions): Promise<ExecResult> => {
        if (!live) throw new ToolError('this sandbox has been terminated and cannot run a command');
        return { exitCode: 0, stdout: '', stderr: '', durationMs: 0 };
      },
      // Neither of these checks `live`: the leak this fixture exists to demonstrate.
      putFile: async (path: string, bytes: Uint8Array): Promise<void> => {
        files.set(path, bytes);
      },
      getFile: async (path: string): Promise<Uint8Array> => {
        const bytes = files.get(path);
        if (!bytes) throw new ToolError('no such file in this sandbox');
        return bytes;
      },
      terminate: async (): Promise<void> => {
        live = false;
      },
    };
  }
}

describe('the conformance suite catches a leaky terminate', () => {
  // `it.fails`: this is the same check `sandboxProviderConformance` runs on every provider — it
  // must not hold for a provider that only guards `exec`. If a future edit weakens the suite back
  // to checking `exec` alone, this stops failing and the run turns red, exactly backwards from
  // what a passing suite over a broken provider would mean.
  it.fails('does not hold for a provider that only guards exec', async () => {
    const sandbox = await new LeakyTerminateProvider().acquire(session);
    await sandbox.terminate();
    await sandbox.terminate();
    await expect(sandbox.exec('true', {})).rejects.toBeInstanceOf(ToolError);
    await expect(sandbox.putFile('/work/a', new Uint8Array())).rejects.toBeInstanceOf(ToolError);
    await expect(sandbox.getFile('/work/a')).rejects.toBeInstanceOf(ToolError);
  });
});
