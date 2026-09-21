import { describe, expect, it } from 'vitest';
import { ToolError } from '@harness/shared';
import type { ExecOptions, ExecResult, Sandbox, SandboxProvider, SandboxSession } from './types.js';

/** The key a session's own filesystem is kept under: one run of one client, never shared. */
const keyOf = (session: SandboxSession): string => `${session.client}:${session.runId}:${session.principalId}`;

/**
 * A sandbox that runs nothing.
 *
 * Files are a map and commands are a script a test writes: what it proves is that a caller's
 * *sequence* is right — acquire, put, exec, get, terminate — not that anything executed. The
 * first real provider is a later plan's, and this is what its conformance run starts from.
 */
export class MemorySandboxProvider implements SandboxProvider {
  readonly name = 'memory';
  /** Every command any session of this provider was asked to run, in order. */
  readonly commands: { session: SandboxSession; command: string }[] = [];

  private readonly scripted = new Map<string, ExecResult>();
  private readonly files = new Map<string, Map<string, Uint8Array>>();

  /** What `exec` answers for this exact command, whichever session runs it. */
  script(command: string, result: ExecResult): void {
    this.scripted.set(command, result);
  }

  async acquire(session: SandboxSession): Promise<Sandbox> {
    const key = keyOf(session);
    // Per session, which is what makes "one run cannot read another's files" a property of the
    // fake rather than a promise in a comment.
    const files = this.files.get(key) ?? new Map<string, Uint8Array>();
    this.files.set(key, files);
    let live = true;
    const assertLive = (what: string): void => {
      if (!live) throw new ToolError(`this sandbox has been terminated and cannot ${what}`);
    };
    return {
      exec: async (command: string, _opts: ExecOptions): Promise<ExecResult> => {
        assertLive('run a command');
        this.commands.push({ session, command });
        const result = this.scripted.get(command);
        // A command nobody scripted is a command that is not there: an exit code, like a shell's,
        // rather than a throw — a provider that threw would make a test of a caller's error
        // handling impossible. The command is not repeated in the message: it is a model's
        // argument and this string is the kind of thing that lands in an error column.
        return result ?? { exitCode: 127, stdout: '', stderr: 'that command is not scripted', durationMs: 0 };
      },
      putFile: async (path: string, bytes: Uint8Array): Promise<void> => {
        assertLive('take a file');
        files.set(path, bytes);
      },
      getFile: async (path: string): Promise<Uint8Array> => {
        assertLive('give a file back');
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

/**
 * The suite every `SandboxProvider` runs.
 *
 * Called at the top level of a provider's own test file with a factory, exactly as
 * `configSourceConformance` is: what it pins is the contract's promises — a session's files are
 * its own, a terminated sandbox refuses everything, `terminate` is idempotent — so that the
 * second implementation cannot quietly mean something else by them.
 */
export function sandboxProviderConformance(makeProvider: () => SandboxProvider): void {
  const session: SandboxSession = { client: 'conformance', runId: 'r-conformance', principalId: 'u-conformance' };

  describe(`the sandbox provider contract`, () => {
    it('acquires a sandbox for a session and reports a name', async () => {
      const provider = makeProvider();
      expect(provider.name).not.toBe('');
      const sandbox = await provider.acquire(session);
      expect(typeof sandbox.exec).toBe('function');
      await sandbox.terminate();
    });

    it('gives a file back byte for byte', async () => {
      const sandbox = await makeProvider().acquire(session);
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
      await sandbox.putFile('/work/bytes.bin', bytes);
      expect([...(await sandbox.getFile('/work/bytes.bin'))]).toEqual([...bytes]);
      await sandbox.terminate();
    });

    it('refuses a file nobody put there, with a ToolError', async () => {
      const sandbox = await makeProvider().acquire(session);
      await expect(sandbox.getFile('/work/nothing')).rejects.toBeInstanceOf(ToolError);
      await sandbox.terminate();
    });

    it('refuses everything after terminate, and terminates idempotently', async () => {
      const sandbox = await makeProvider().acquire(session);
      await sandbox.terminate();
      await sandbox.terminate();
      await expect(sandbox.exec('true', {})).rejects.toBeInstanceOf(ToolError);
    });

    it('keeps one session s files away from another s', async () => {
      const provider = makeProvider();
      const mine = await provider.acquire(session);
      const theirs = await provider.acquire({ client: 'other', runId: 'r-other', principalId: 'u-other' });
      await mine.putFile('/work/mine', new Uint8Array([1]));
      await expect(theirs.getFile('/work/mine')).rejects.toBeInstanceOf(ToolError);
      await mine.terminate();
      await theirs.terminate();
    });
  });
}
