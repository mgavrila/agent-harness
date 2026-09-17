import { describe, expect, it } from 'vitest';
import { createLogger } from '@harness/shared';
import { allowsUser } from '@harness/surface-api';
import { surface } from './index.js';

const deps = (env: Record<string, string> = {}) => ({ env, log: createLogger('test'), storageDir: '/nonexistent' });

describe('the memory surface', () => {
  it('declares no secrets, because it has no transport to hold one for', () => {
    expect(surface.name).toBe('memory');
    expect(surface.secrets).toEqual([]);
  });

  it('connects to a session that lets everyone in by default', async () => {
    const session = await surface.connect(deps());
    expect(session.defaultConversation).toBe('memory');
    expect(allowsUser(session.allowedUsers, 'anyone')).toBe(true);
  });

  it('honours an allowlist when the deployment sets one, and still fails closed on an empty one', async () => {
    const listed = await surface.connect(deps({ MEMORY_ALLOWED_USERS: 'U012, U345' }));
    expect(allowsUser(listed.allowedUsers, 'U012')).toBe(true);
    expect(allowsUser(listed.allowedUsers, 'U999')).toBe(false);
    const empty = await surface.connect(deps({ MEMORY_ALLOWED_USERS: '' }));
    expect(allowsUser(empty.allowedUsers, 'U012')).toBe(false);
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
