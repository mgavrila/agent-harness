import { describe, expect, it } from 'vitest';
import { DENY_ALL_WRITES, READ_ONLY_FS_TOOLS, chatModel, kernelToolFilter } from './middleware.js';

describe('the agent configuration', () => {
  it('offers only the four read-only filesystem tools and denies every write', () => {
    expect(READ_ONLY_FS_TOOLS).toEqual(['read_file', 'ls', 'glob', 'grep']);
    expect(DENY_ALL_WRITES).toEqual([{ operations: ['write'], paths: ['/**'], mode: 'deny' }]);
  });

  it('builds a chat model on the named deployment with the principal as the user', () => {
    const model = chatModel(
      { baseUrl: 'http://gateway', apiKey: 'sk-x', route: 'chat', model: 'acme/gemini/flash', user: 'u-1' },
      'acme/groq/spare',
    );
    // The deployment the caller named, not the route the run is on.
    expect(model.model).toBe('acme/groq/spare');
    expect(model.user).toBe('u-1');
    expect(model.clientConfig.baseURL).toBe('http://gateway/v1');
  });

  it('names the tool filter so the middleware order stays readable', () => {
    expect(kernelToolFilter().name).toBe('KernelToolFilter');
  });
});
