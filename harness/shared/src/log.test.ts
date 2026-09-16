import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './log.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('writes to stderr, never stdout, because stdio carries the MCP frame', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('effects').info('dispatched 3');
    expect(err).toHaveBeenCalledWith('effects: dispatched 3');
    expect(out).not.toHaveBeenCalled();
  });

  it('appends an error message and nothing else from the error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = new Error('connection refused');
    createLogger('effects').error('dispatch failed', thrown);
    expect(err).toHaveBeenCalledWith('effects: dispatch failed: connection refused');
    expect(err.mock.calls[0][0]).not.toContain(thrown.stack?.split('\n')[1] ?? 'at ');
  });

  it('describes a thrown non-Error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('effects').warn('odd', { sink: 'slack' });
    expect(err).toHaveBeenCalledWith('effects: odd: [object Object]');
  });
});
