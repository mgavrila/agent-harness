import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from './log.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('prefixes every line with its scope and writes to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('db').info('pool opened');
    expect(spy).toHaveBeenCalledWith('db: pool opened');
  });

  it('appends an error message without the stack', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('db').error('pool failed', new Error('connection refused'));
    expect(spy).toHaveBeenCalledWith('db: pool failed: connection refused');
  });

  it('describes a thrown non-Error without crashing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('db').warn('odd', 'just a string');
    expect(spy).toHaveBeenCalledWith('db: odd: just a string');
  });
});
