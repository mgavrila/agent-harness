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

  it('waits for an in-flight edit to land before sending the final one, rather than racing it to the same message', async () => {
    const api = new FakeSlack();
    const c = clock();
    // A `chat.update` whose first call blocks until the test releases it, so a periodic edit can
    // be caught mid-flight; the fake still records call order, so a race would show up as the
    // final edit's text landing before, or interleaved with, the in-flight one's.
    const recorded: { text: string }[] = [];
    // A holder object rather than a plain `let`: TS otherwise narrows a closure-captured variable
    // reassigned only inside a nested function to `never` at this scope's later uses.
    const release: { current: (() => void) | null } = { current: null };
    let blockedOnce = false;
    const api2 = {
      chat: {
        postMessage: api.chat.postMessage,
        postEphemeral: api.chat.postEphemeral,
        update: async (args: { channel: string; ts: string; text: string }) => {
          if (!blockedOnce) {
            blockedOnce = true;
            await new Promise<void>((resolve) => {
              release.current = () => resolve();
            });
          }
          recorded.push({ text: args.text });
          return { ok: true, ts: args.ts, channel: args.channel };
        },
      },
      files: api.files,
      views: api.views,
    };
    const stream = createEditStream({ api: api2, conversation: 'C0DEMO', now: c.now, setTimeout: c.setTimeout });
    stream.append('Hel');
    await c.advance(0);
    stream.append('lo');
    await c.advance(0); // lets the trailing edit's timer arm (it waits for the post first)
    await c.advance(STREAM_EDIT_INTERVAL_MS); // fires it; the edit it sends blocks on `release`
    expect(recorded).toHaveLength(0);
    stream.append('!'); // arrives while the periodic edit above is still in flight
    let ended = false;
    const endPromise = stream.end().then((ref) => {
      ended = true;
      return ref;
    });
    // A full macrotask boundary, not just one microtask tick: enough for anything `end()` could
    // finish without our `release`, so a still-false `ended` here means it is genuinely blocked
    // on the in-flight edit rather than merely a few microtask hops from done.
    await new Promise((resolve) => setImmediate(resolve));
    expect(ended).toBe(false); // end() must wait for the in-flight edit, not race past it
    expect(recorded).toHaveLength(0);
    release.current?.();
    const ref = await endPromise;
    expect(recorded).toEqual([{ text: 'Hello' }, { text: 'Hello!' }]);
    expect(ended).toBe(true);
    expect(ref).toEqual({ surface: 'slack', conversation: 'C0DEMO', id: '1789000000.000001' });
  });

  it('rejects end with a SurfaceError when the first post failed, without ever triggering an unhandled rejection', async () => {
    const api = new FakeSlack();
    api.failWith = 'channel_not_found';
    let unhandled = false;
    const onUnhandled = () => {
      unhandled = true;
    };
    process.once('unhandledRejection', onUnhandled);
    const stream = createEditStream({ api, conversation: 'C0DEMO' });
    stream.append('Hel');
    // A real gap before anything awaits the post — "no append/end follows for a while" — so a
    // rejection left with no attached handler at all would already have been flagged by Node
    // well before `end` is ever called.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const err = await stream.end().then(
      () => null,
      (caught: unknown) => caught,
    );
    // Give a stray unhandled rejection a full turn of the event loop to have surfaced.
    await new Promise((resolve) => setImmediate(resolve));
    process.removeListener('unhandledRejection', onUnhandled);
    expect(err).toBeInstanceOf(SurfaceError);
    expect((err as Error).message).toBe('slack: chat.postMessage failed: channel_not_found');
    expect(api.posts).toHaveLength(0);
    expect(unhandled).toBe(false);
  });

  it('swallows a mid-stream chat.update rejection and still performs the final edit', async () => {
    const api = new FakeSlack();
    const c = clock();
    const stream = createEditStream({ api, conversation: 'C0DEMO', now: c.now, setTimeout: c.setTimeout });
    stream.append('Hel');
    await c.advance(0);
    stream.append('lo');
    await c.advance(0); // lets the trailing edit's timer arm (it waits for the post first)
    api.failWith = 'channel_not_found';
    await c.advance(STREAM_EDIT_INTERVAL_MS); // the periodic edit fires, fails, and is swallowed
    expect(api.updates).toHaveLength(0);
    api.failWith = undefined;
    stream.append('!');
    const ref = await stream.end();
    expect(api.updates).toHaveLength(1);
    expect(api.updates[0]).toMatchObject({ text: 'Hello!' });
    expect(ref).toEqual({ surface: 'slack', conversation: 'C0DEMO', id: '1789000000.000001' });
  });
});
