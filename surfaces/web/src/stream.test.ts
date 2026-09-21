import { describe, expect, it } from 'vitest';
import { ConversationStreams, WEB_FRAME_RETENTION } from './stream.js';

/** Read the frames a stream has ready, then stop: every case here drives a finite stream. */
async function drain(stream: AsyncIterable<string>, take: number): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    if (chunks.length >= take) break;
  }
  return chunks;
}

describe('ConversationStreams', () => {
  it('frames an event as Server-Sent Events, with an id that counts from one per conversation', async () => {
    const streams = new ConversationStreams();
    const open = streams.open('inbox', new AbortController().signal, null);
    streams.emit('inbox', 'message', { text: 'hello' });
    streams.emit('inbox', 'message', { text: 'again' });
    // A second conversation counts from one of its own: an id is per conversation, so two pages
    // of the workspace resume independently.
    streams.emit('other', 'message', { text: 'elsewhere' });
    expect(await drain(open, 2)).toEqual([
      'id: 1\nevent: message\ndata: {"text":"hello"}\n\n',
      'id: 2\nevent: message\ndata: {"text":"again"}\n\n',
    ]);
    const second = streams.open('other', new AbortController().signal, null);
    expect(await drain(second, 1)).toEqual(['id: 1\nevent: message\ndata: {"text":"elsewhere"}\n\n']);
  });

  it('replays what a resuming client has not seen, and repeats nothing it has', async () => {
    const streams = new ConversationStreams();
    for (const n of [1, 2, 3]) streams.emit('inbox', 'message', { n });
    expect(await drain(streams.open('inbox', new AbortController().signal, '2'), 1)).toEqual([
      'id: 3\nevent: message\ndata: {"n":3}\n\n',
    ]);
  });

  it('opens a resume past the window with a notice, before the first frame it can still send', async () => {
    const streams = new ConversationStreams();
    for (let n = 1; n <= WEB_FRAME_RETENTION + 3; n += 1) streams.emit('inbox', 'message', { n });
    const frames = await drain(streams.open('inbox', new AbortController().signal, '1'), 2);
    // The notice carries **no id**, deliberately: a client's `Last-Event-ID` must not move to a
    // frame that is an apology rather than a message, or a second reconnection would skip a real
    // one. The workspace has to be able to tell a resumed stream from a complete one, and this is
    // that signal.
    expect(frames[0]).toBe(
      `event: notice\ndata: {"text":"Some earlier messages are no longer available.","dropped":true,"reason":"window"}\n\n`,
    );
    expect(frames[1]).toBe(`id: 4\nevent: message\ndata: {"n":4}\n\n`);
  });

  it('tells a client resuming on a conversation this host has never written to, and holds nothing back', async () => {
    const streams = new ConversationStreams();
    // The reconnection after a restart, a tenant reload, or an ingress that chose another host:
    // the client is holding an id from a history this instance does not have. Withholding every
    // frame below it — which is what filtering on an unplaceable id does — leaves a workspace
    // watching a live connection that never speaks again, with nothing to tell it why.
    const stream = streams.open('inbox', new AbortController().signal, '7')[Symbol.asyncIterator]();
    // Pulled before anything is written, because that is the case being named: this host has no
    // such conversation at all. (A stream is lazy, so writing first would make the same resume
    // land on the `ahead` reason below.)
    expect((await stream.next()).value).toBe(
      `event: notice\ndata: {"text":"Some earlier messages are no longer available.","dropped":true,"reason":"unknown"}\n\n`,
    );
    streams.emit('inbox', 'message', { text: 'after the restart' });
    streams.emit('inbox', 'message', { text: 'and again' });
    expect((await stream.next()).value).toBe('id: 1\nevent: message\ndata: {"text":"after the restart"}\n\n');
    expect((await stream.next()).value).toBe('id: 2\nevent: message\ndata: {"text":"and again"}\n\n');
  });

  it('tells a client whose id is ahead of the conversation, then replays the whole window', async () => {
    const streams = new ConversationStreams();
    streams.emit('inbox', 'message', { n: 1 });
    const frames = await drain(streams.open('inbox', new AbortController().signal, '50'), 2);
    expect(frames[0]).toBe(
      `event: notice\ndata: {"text":"Some earlier messages are no longer available.","dropped":true,"reason":"ahead"}\n\n`,
    );
    // Everything held, from the beginning: a fresh open's answer, which is the only honest one
    // for a cursor that was minted somewhere this host cannot see.
    expect(frames[1]).toBe('id: 1\nevent: message\ndata: {"n":1}\n\n');
  });

  it('ends every open stream when the session closes, and ends one opened afterwards at once', async () => {
    const streams = new ConversationStreams();
    const open = streams.open('inbox', new AbortController().signal, null)[Symbol.asyncIterator]();
    const parked = open.next();
    expect(streams.openCount).toBe(1);
    streams.close();
    expect((await parked).done).toBe(true);
    expect(streams.openCount).toBe(0);
    // And a request that arrives between the stop and the eviction is answered rather than
    // parked: what is held goes out, and the stream ends.
    streams.emit('inbox', 'message', { text: 'held' });
    expect(await drain(streams.open('inbox', new AbortController().signal, null), 5)).toEqual([
      'id: 1\nevent: message\ndata: {"text":"held"}\n\n',
    ]);
  });

  it('sends no notice to a client that resumes inside the window', async () => {
    const streams = new ConversationStreams();
    for (const n of [1, 2]) streams.emit('inbox', 'message', { n });
    const frames = await drain(streams.open('inbox', new AbortController().signal, '1'), 1);
    expect(frames[0]).toBe('id: 2\nevent: message\ndata: {"n":2}\n\n');
  });

  it('sends a keep-alive comment on an idle stream, and counts it as no frame', async () => {
    const streams = new ConversationStreams({ keepAliveMs: 20 });
    const frames = await drain(streams.open('inbox', new AbortController().signal, null), 2);
    // A comment line, which every Server-Sent Events client ignores: two bytes of nothing that
    // stop an idle-timeout proxy closing a conversation nobody has spoken in.
    expect(frames).toEqual([': keep-alive\n\n', ': keep-alive\n\n']);
  });

  it('ends a stream when its request is aborted, and forgets it', async () => {
    const streams = new ConversationStreams();
    const client = new AbortController();
    const stream = streams.open('inbox', client.signal, null);
    const iterator = stream[Symbol.asyncIterator]();
    const parked = iterator.next();
    expect(streams.openCount).toBe(1);
    client.abort();
    expect((await parked).done).toBe(true);
    expect(streams.openCount).toBe(0);
  });

  it('drops the oldest frames of a conversation rather than growing without a bound', () => {
    const streams = new ConversationStreams();
    for (let n = 1; n <= WEB_FRAME_RETENTION + 10; n += 1) streams.emit('inbox', 'message', { n });
    expect(streams.held('inbox')).toBe(WEB_FRAME_RETENTION);
    // And a conversation nobody has written to holds nothing at all: a tenant's memory is the
    // conversations it has used, not the ones it could.
    expect(streams.held('never-used')).toBe(0);
  });
});
