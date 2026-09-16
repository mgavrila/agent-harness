import { describe, it, expect } from 'vitest';
import { ConfigError, ModelOutputError, ToolError, describeError } from './errors.js';

describe('the three error types', () => {
  it('names itself, so an audit row says which kind it was', () => {
    expect(new ToolError('nope').name).toBe('ToolError');
    expect(new ConfigError('nope').name).toBe('ConfigError');
    expect(new ModelOutputError('extract', 'npi: expected string').name).toBe('ModelOutputError');
  });

  it('makes ModelOutputError a ToolError, so its message reaches the agent', () => {
    expect(new ModelOutputError('extract', 'npi: expected string')).toBeInstanceOf(ToolError);
    expect(new ModelOutputError('extract', 'npi: expected string').message).toBe(
      'model output invalid on route extract: npi: expected string',
    );
  });

  it('keeps ConfigError out of the ToolError family, so the kernel never surfaces it', () => {
    expect(new ConfigError('HARNESS_STORAGE_DIR must be set')).not.toBeInstanceOf(ToolError);
  });
});

describe('describeError', () => {
  it('takes an Error apart to its message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything else rather than printing [object Object]', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(42)).toBe('42');
    expect(describeError(null)).toBe('null');
  });
});
