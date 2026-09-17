import { describe, expect, it } from 'vitest';
import { createLogger } from '@harness/shared';
import { surface } from './index.js';

const deps = (env: Record<string, string> = {}) => ({ env, log: createLogger('test'), storageDir: '/nonexistent' });

describe('the memory surface', () => {
  it('declares no secrets, because it has no transport to hold one for', () => {
    expect(surface.name).toBe('memory');
    expect(surface.secrets).toEqual([]);
  });

  it('connects to a session that can stream, since nothing it posts leaves the process', async () => {
    const session = await surface.connect(deps());
    expect(session.defaultConversation).toBe('memory');
    expect(session.capabilities.streaming).toBe(true);
  });

  it('records a posted card instead of sending it', async () => {
    const session = await surface.connect(deps());
    const ref = await session.postCard('memory', {
      id: 'demo',
      title: 'Approval needed',
      notice: 'Approval needed',
      body: [],
      actions: [],
    });
    expect(ref).toEqual({ surface: 'memory', conversation: 'memory', id: 'm1' });
  });
});
