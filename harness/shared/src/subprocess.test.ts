import { describe, expect, it } from 'vitest';
import { runBounded } from './subprocess.js';

describe('runBounded', () => {
  it('returns stdout on success', async () => {
    const outcome = await runBounded('node', ['-e', 'process.stdout.write("hello")'], { timeoutMs: 10_000 });
    expect(outcome).toEqual({ ok: true, stdout: 'hello', stderr: '' });
  });

  it('reports a non-zero exit as failed, with no output attached', async () => {
    const outcome = await runBounded('node', ['-e', 'process.stdout.write("secret"); process.exit(3)'], {
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ ok: false, reason: 'failed' });
  });

  it('reports a missing binary as failed rather than throwing ENOENT', async () => {
    const outcome = await runBounded('harness-no-such-binary', [], { timeoutMs: 10_000 });
    expect(outcome).toEqual({ ok: false, reason: 'failed' });
  });

  it('kills a process that runs past its limit and reports a timeout', async () => {
    const outcome = await runBounded('node', ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 200 });
    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
  }, 15_000);
});
