import { describe, expect, it } from 'vitest';
import { DENY_ALL_WRITES, READ_ONLY_FS_TOOLS, chatModel, kernelToolFilter } from './middleware.js';

describe('the agent configuration', () => {
  it('offers only the four read-only filesystem tools and denies every write', () => {
    expect(READ_ONLY_FS_TOOLS).toEqual(['read_file', 'ls', 'glob', 'grep']);
    expect(DENY_ALL_WRITES).toEqual([{ operations: ['write'], paths: ['/**'], mode: 'deny' }]);
  });

  it('builds a chat model on the gateway route with the principal as the user', () => {
    const model = chatModel({ baseUrl: 'http://gateway', apiKey: 'sk-x', route: 'chat', user: 'u-1' }, 'reason');
    expect(model.model).toBe('reason');
    expect(model.user).toBe('u-1');
    expect(model.clientConfig.baseURL).toBe('http://gateway/v1');
  });

  it('names the tool filter so the middleware order stays readable', () => {
    expect(kernelToolFilter().name).toBe('KernelToolFilter');
  });
});
