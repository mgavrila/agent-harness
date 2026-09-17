import { describe, expect, it } from 'vitest';
import { SurfaceError } from '@harness/shared';
import { STREAM_EDIT_INTERVAL_MS, createEditStream } from './stream.js';
import { FakeSlack } from './transport/fake.js';

/** A clock and a timer the test advances by hand. */
function clock() {
  let at = 0;
  const timers: { due: number; fn: () => void }[] = [];
  return {
    now: () => at,
    setTimeout: ((fn: () => void, ms: number) => {
      timers.push({ due: at + ms, fn });
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    async advance(ms: number) {
      at += ms;
      for (const t of timers.splice(0).filter((t) => t.due <= at)) t.fn();
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('createEditStream', () => {
  it('posts the first delta as a message, edits with the accumulated text no more than once per interval, and ends with a final edit', async () => {
    const api = new FakeSlack();
    const c = clock();
    const stream = createEditStream({ api, conversation: 'C0DEMO', now: c.now, setTimeout: c.setTimeout });
    stream.append('Hel');
    await c.advance(0);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]).toMatchObject({ channel: 'C0DEMO', text: 'Hel' });
    stream.append('lo ');
    stream.append('there');
    await c.advance(100);
    expect(api.updates).toHaveLength(0);
    await c.advance(STREAM_EDIT_INTERVAL_MS);
    expect(api.updates).toHaveLength(1);
    // `SlackPostMessageArgs` (what `api.posts` records) never carries `ts` — only the response
    // does — so this is always the fallback; it is spelled out rather than read off `posts[0]`
    // to keep the assertion type-checking under `tsc`.
    expect(api.updates[0]).toMatchObject({ channel: 'C0DEMO', ts: '1789000000.000001', text: 'Hello there' });
    stream.append('!');
    const ref = await stream.end();
    expect(api.updates.at(-1)).toMatchObject({ text: 'Hello there!' });
    expect(ref).toEqual({ surface: 'slack', conversation: 'C0DEMO', id: '1789000000.000001' });
  });

  it('replies in the thread it was asked to', async () => {
    const api = new FakeSlack();
    const stream = createEditStream({ api, conversation: 'C0DEMO', threadTs: '1700000000.000100' });
    stream.append('x');
    await stream.end();
    expect(api.posts[0].thread_ts).toBe('1700000000.000100');
  });

  it('posts nothing for an empty stream and still returns a reference-less end', async () => {
    const api = new FakeSlack();
    const stream = createEditStream({ api, conversation: 'C0DEMO' });
    const ref = await stream.end();
    expect(api.posts).toHaveLength(0);
    expect(ref).toEqual({ surface: 'slack', conversation: 'C0DEMO', id: '' });
  });

  it('folds a trailing edit still waiting on its interval into the final edit, without a leftover timer firing a second one', async () => {
    const api = new FakeSlack();
    const c = clock();
    const stream = createEditStream({ api, conversation: 'C0DEMO', now: c.now, setTimeout: c.setTimeout });
    stream.append('Hel');
    await c.advance(0);
    stream.append('lo'); // arrives inside the interval: a trailing edit is armed, not fired yet
    const ref = await stream.end();
    expect(api.updates).toHaveLength(1);
    expect(api.updates[0]).toMatchObject({ text: 'Hello' });
    expect(ref).toEqual({ surface: 'slack', conversation: 'C0DEMO', id: '1789000000.000001' });
    // The interval the trailing edit was waiting on has long since passed; if its timer had
    // survived `end`, this would fire a second, redundant update.
    await c.advance(STREAM_EDIT_INTERVAL_MS * 2);
    expect(api.updates).toHaveLength(1);
  });

  it('ignores a delta appended after end: the reply already told the world it was done', async () => {
    const api = new FakeSlack();
    const stream = createEditStream({ api, conversation: 'C0DEMO' });
    stream.append('Hel');
    const ref = await stream.end();
    stream.append('lo');
    expect(api.updates).toHaveLength(1);
    expect(api.updates.at(-1)).toMatchObject({ text: 'Hel' });
    expect(ref).toEqual({ surface: 'slack', conversation: 'C0DEMO', id: api.updates[0].ts });
  });

  it('rejects end with a SurfaceError, naming the operation and not the text, when the final edit fails', async () => {
    const api = new FakeSlack();
    const stream = createEditStream({ api, conversation: 'C0DEMO' });
    stream.append('a roster was released');
    api.failWith = 'channel_not_found';
    const err = await stream.end().then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(SurfaceError);
    expect((err as Error).message).toBe('slack: chat.update failed: channel_not_found');
    expect((err as Error).message).not.toContain('roster');
  });
});
