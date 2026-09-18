import { describe, expect, it } from 'vitest';
import { SurfaceError } from '@harness/shared';
import { HTTP_SURFACE_CONVERSATION, surface } from './index.js';

const connect = () => surface.connect({ env: {}, log: { info() {}, warn() {}, error() {} }, storageDir: '/tmp' });

describe('the http surface', () => {
  it('is named http, reads no secret, and opens no transport', async () => {
    expect(surface.name).toBe('http');
    expect(surface.secrets).toEqual([]);
    const session = await connect();
    await session.start();
    await session.stop();
    expect(session.name).toBe('http');
    expect(session.defaultConversation).toBe(HTTP_SURFACE_CONVERSATION);
  });

  it('declares every capability false: a request has no conversation that outlives it', async () => {
    const session = await connect();
    expect(session.capabilities).toEqual({
      forms: false,
      privateReply: false,
      update: false,
      streaming: false,
      inlineConfirm: false,
    });
  });

  it('refuses every way of posting, with a message safe to store, naming the surface', async () => {
    const session = await connect();
    const ref = { surface: 'http', conversation: 'api', id: '1' };
    const card = { id: 'c', title: 't', notice: 'n', body: [], actions: [] };
    await expect(session.postText('api', 'hello')).rejects.toThrow(SurfaceError);
    await expect(session.postText('api', 'hello')).rejects.toThrow(
      'surface "http" cannot post outside a request; the run API answers on the caller’s own stream',
    );
    await expect(session.postCard('api', card)).rejects.toThrow(SurfaceError);
    await expect(session.updateCard(ref, card)).rejects.toThrow(SurfaceError);
    await expect(session.postPrivate('api', 'u-1', 'hello')).rejects.toThrow(SurfaceError);
    await expect(session.uploadFile('api', { path: '/tmp/x', filename: 'x' })).rejects.toThrow(SurfaceError);
    await expect(
      session.openForm('trigger', {
        id: 'f',
        title: 't',
        submitLabel: 'go',
        cancelLabel: 'no',
        fields: [],
        metadata: '',
      }),
    ).rejects.toThrow(SurfaceError);
    expect(() => session.startStream('api')).toThrow(SurfaceError);
  });

  it('spells a mention as the principal id, because there is nobody to notify', async () => {
    const session = await connect();
    expect(session.mention('u-coordinator')).toBe('@u-coordinator');
  });

  it('accepts the three handlers and never calls them, because nothing arrives out of band', async () => {
    const session = await connect();
    let called = 0;
    session.onMessage(async () => {
      called += 1;
    });
    session.onAction(async () => {
      called += 1;
    });
    session.onFormSubmit(async () => {
      called += 1;
    });
    await session.start();
    await session.stop();
    expect(called).toBe(0);
  });
});
