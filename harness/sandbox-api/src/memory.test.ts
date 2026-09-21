import { describe, expect, it } from 'vitest';
import { ToolError } from '@harness/shared';
import { MemorySandboxProvider, sandboxProviderConformance } from './testing.js';
import type { SandboxSession } from './types.js';

const session: SandboxSession = { client: 'alpha', runId: 'r-1', principalId: 'u-coordinator' };

// Every provider runs this, and today there is one. It is here at all so that the first real
// implementation — agent-sandbox, in its own plan — inherits a suite rather than writing one.
sandboxProviderConformance(() => new MemorySandboxProvider());

describe('MemorySandboxProvider', () => {
  it('plays back the exits a test scripted, in order, and reports what was run', async () => {
    const provider = new MemorySandboxProvider();
    provider.script('node --version', { exitCode: 0, stdout: 'v22.0.0', stderr: '', durationMs: 3 });
    const sandbox = await provider.acquire(session);
    expect(await sandbox.exec('node --version', {})).toEqual({
      exitCode: 0,
      stdout: 'v22.0.0',
      stderr: '',
      durationMs: 3,
    });
    expect(provider.commands).toEqual([{ session, command: 'node --version' }]);
  });

  it('answers a command nobody scripted with a non-zero exit rather than a throw', async () => {
    const sandbox = await new MemorySandboxProvider().acquire(session);
    const result = await sandbox.exec('rm -rf /', {});
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('not scripted');
    // The command itself is not repeated: it is a model's argument, and this string is the kind
    // of thing that ends up in an error column.
    expect(result.stderr).not.toContain('rm -rf');
  });

  it('round-trips a file, and refuses to read one nobody wrote', async () => {
    const sandbox = await new MemorySandboxProvider().acquire(session);
    await sandbox.putFile('/work/in.csv', new TextEncoder().encode('a,b\n1,2\n'));
    expect(new TextDecoder().decode(await sandbox.getFile('/work/in.csv'))).toBe('a,b\n1,2\n');
    await expect(sandbox.getFile('/work/missing.csv')).rejects.toBeInstanceOf(ToolError);
  });

  it('refuses everything once it has been terminated', async () => {
    const sandbox = await new MemorySandboxProvider().acquire(session);
    await sandbox.terminate();
    await sandbox.terminate(); // idempotent: a caller that unwinds twice is not an error
    await expect(sandbox.exec('ls', {})).rejects.toBeInstanceOf(ToolError);
    await expect(sandbox.putFile('/work/a', new Uint8Array())).rejects.toBeInstanceOf(ToolError);
    await expect(sandbox.getFile('/work/a')).rejects.toBeInstanceOf(ToolError);
  });

  it('gives each session its own filesystem, because two runs are two tenants', async () => {
    const provider = new MemorySandboxProvider();
    const mine = await provider.acquire(session);
    const theirs = await provider.acquire({ client: 'beta', runId: 'r-2', principalId: 'u-other' });
    await mine.putFile('/work/secret', new TextEncoder().encode('alpha'));
    await expect(theirs.getFile('/work/secret')).rejects.toBeInstanceOf(ToolError);
  });
});
