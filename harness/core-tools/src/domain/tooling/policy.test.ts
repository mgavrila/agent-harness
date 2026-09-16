import { describe, it, expect } from 'vitest';
import { DEFAULT_POLICY, parsePolicy, decide, loadPolicy } from './policy.js';

describe('policy', () => {
  it('default policy matches the spec table', () => {
    expect(DEFAULT_POLICY).toEqual({
      read: 'auto',
      'write.internal': 'auto',
      external: 'approval',
      financial: 'blocked',
      destructive: 'approval',
    });
  });

  it('parsePolicy merges overrides over defaults', () => {
    const p = parsePolicy('classes:\n  external: auto\n');
    expect(p.external).toBe('auto');
    expect(p.financial).toBe('blocked');
  });

  it('parsePolicy rejects unknown classes and behaviors', () => {
    expect(() => parsePolicy('classes:\n  bogus: auto\n')).toThrow(/bogus/);
    expect(() => parsePolicy('classes:\n  read: maybe\n')).toThrow(/maybe/);
  });

  it('decide returns the behavior for a class', () => {
    expect(decide('financial', DEFAULT_POLICY)).toBe('blocked');
    expect(decide('read', DEFAULT_POLICY)).toBe('auto');
  });

  it('loadPolicy returns defaults when no file is configured', async () => {
    const saved = process.env.HARNESS_POLICY_FILE;
    delete process.env.HARNESS_POLICY_FILE;
    expect(await loadPolicy()).toEqual(DEFAULT_POLICY);
    if (saved !== undefined) process.env.HARNESS_POLICY_FILE = saved;
  });
});
