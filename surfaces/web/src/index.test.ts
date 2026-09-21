import { describe, expect, it } from 'vitest';
import { surface } from './index.js';

describe('the web surface declaration', () => {
  it('declares its name and no environment credential at all', () => {
    expect(surface.name).toBe('web');
    // Its one credential is its tenant's, resolved by the host. A name here would be a
    // deployment-wide variable, which is exactly what a pooled host cannot have.
    expect(surface.secrets).toEqual([]);
  });

  it('connects from the document alone, and refuses a tenant whose token resolved to nothing', async () => {
    const deps = {
      env: {},
      log: { info() {}, warn() {}, error() {} },
      storageDir: '/nonexistent',
      secretValues: { token: 'wt-0123456789abcdef' },
      defaultConversation: 'inbox',
    };
    const session = await surface.connect(deps);
    expect(session.name).toBe('web');
    expect(session.defaultConversation).toBe('inbox');
    expect(session.http?.path).toBe('web');
    // Wrapped, because `connect` reads its configuration before it has anything to await and so
    // raises where it stands; the contract says a caller gets a promise.
    await expect((async () => surface.connect({ ...deps, secretValues: {} }))()).rejects.toThrow(/token/);
  });
});
