import { describe, expect, it } from 'vitest';
import { createLogger } from '@harness/shared';
import type { MessageEvent } from '@harness/surface-api';
import { MemorySurface } from '@harness/surface-api/testing';
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

  it('reports the workspace the client document declared, as the tenant hint on every event', async () => {
    // The document's `surfaces.memory.workspace` is this surface's tenant key; the host hands it
    // over as `tenantKey` and never reads the field itself. A client that declared none has a
    // surface that names no workspace, and a pooled host refuses an event that names none.
    const session = await surface.connect({ ...deps(), tenantKey: 'W-ALPHA' });
    const seen: MessageEvent[] = [];
    session.onMessage(async (e) => {
      seen.push(e);
    });
    await (session as MemorySurface).say('u-one', 'hello');
    expect(seen[0].tenantHint).toBe('W-ALPHA');

    const anonymous = await surface.connect(deps());
    anonymous.onMessage(async (e) => {
      seen.push(e);
    });
    await (anonymous as MemorySurface).say('u-one', 'hello');
    expect(seen[1]).not.toHaveProperty('tenantHint');
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

  it('ships with no inbound door: this surface authenticates nobody', async () => {
    // `MemorySurface.mountHttp()` exists for a host test, which mounts it on the session the pool
    // opened. This wrapper must never call it: anyone who can reach the port would be able to
    // speak as any user id this client's identity plug-in knows.
    const session = await surface.connect(deps());
    expect(session.http).toBeUndefined();
    const keyed = await surface.connect({ ...deps(), tenantKey: 'W-ALPHA' });
    expect(keyed.http).toBeUndefined();
  });
});
