import { describe, expect, it } from 'vitest';
import { bodyText } from '@harness/surface-api/testing';
import type { ActionEvent, FormEvent, MessageEvent, SurfaceHttpRequest, SurfaceSession } from '@harness/surface-api';
import { createWebSession } from './session.js';

const TOKEN = 'wt-0123456789abcdef';
const deps = () => ({
  env: {},
  log: { info() {}, warn() {}, error() {} },
  storageDir: '/nonexistent/storage',
  secretValues: { token: TOKEN },
  defaultConversation: 'inbox',
});

/** One request, as the host hands one over: the sub-path below the mount, and the tenant. */
const request = (over: Partial<SurfaceHttpRequest> = {}): SurfaceHttpRequest => ({
  method: 'POST',
  path: 'messages',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: '{}',
  clientId: 'alpha',
  signal: new AbortController().signal,
  ...over,
});

const post = (path: string, body: unknown, over: Partial<SurfaceHttpRequest> = {}): SurfaceHttpRequest =>
  request({ path, body: JSON.stringify(body), ...over });

/** The session, and the events its door delivered, so a case can assert on both sides. */
function open(): {
  session: SurfaceSession;
  messages: MessageEvent[];
  actions: ActionEvent[];
  forms: FormEvent[];
} {
  const session = createWebSession(deps());
  const messages: MessageEvent[] = [];
  const actions: ActionEvent[] = [];
  const forms: FormEvent[] = [];
  session.onMessage(async (event) => {
    messages.push(event);
  });
  session.onAction(async (event) => {
    actions.push(event);
  });
  session.onFormSubmit(async (event) => {
    forms.push(event);
  });
  return { session, messages, actions, forms };
}

/** The door answers before it delivers, so a case waits a tick rather than asserting into a race. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe('the web surface as a door', () => {
  it('is mounted at one path, under which every route hangs', () => {
    expect(createWebSession(deps()).http?.path).toBe('web');
  });

  it('takes a message, answers with its reference, and delivers it afterwards', async () => {
    const { session, messages } = open();
    const response = await session.http!.handle(
      post('messages', { userId: 'U012', conversation: 'inbox', text: 'hello' }),
    );
    expect(response.status).toBe(202);
    expect(response.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(await bodyText(response))).toEqual({
      message: { surface: 'web', conversation: 'inbox', id: 'w1' },
    });
    // Acknowledged first, delivered after: a turn takes seconds to minutes and the caller is not
    // waiting for it — the reply arrives on the conversation's stream.
    expect(messages).toEqual([]);
    await settle();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      surface: 'web',
      userId: 'U012',
      conversation: 'inbox',
      text: 'hello',
      mentioned: true,
      // The tenant the host resolved from the path, not the key the document declared: it is what
      // the request actually routed on, so the two cannot drift (spec section 4.9).
      tenantHint: 'alpha',
      message: { surface: 'web', conversation: 'inbox', id: 'w1' },
    });
  });

  it('refuses a missing, malformed or wrong bearer with one reason, before it parses anything', async () => {
    const { session, messages } = open();
    const attempts: Record<string, string>[] = [
      { 'content-type': 'application/json' },
      { authorization: 'Bearer' },
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { authorization: `Basic ${TOKEN}` },
    ];
    for (const headers of attempts) {
      const response = await session.http!.handle(
        post('messages', { userId: 'U012', conversation: 'inbox', text: 'hello' }, { headers }),
      );
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(response.refusal, JSON.stringify(headers)).toEqual({ reason: 'bad_bearer' });
      expect(response.headers?.['content-type']).toBe('application/json');
      // Nothing of the body is read, repeated or delivered: a refused request is one nobody has
      // authenticated (invariant 20).
      expect(await bodyText(response)).toBe('{"error":"unauthorised"}');
    }
    await settle();
    expect(messages).toEqual([]);
  });

  it('refuses a body that is not JSON and a body the route will not take, with no refusal', async () => {
    const { session } = open();
    const notJson = await session.http!.handle(request({ body: 'not json' }));
    expect(notJson.status).toBe(400);
    expect(notJson.refusal).toBeUndefined();
    expect(JSON.parse(await bodyText(notJson))).toEqual({ error: 'the request body is not JSON' });
    for (const body of [
      {},
      { userId: 'U012' },
      { userId: 'U012', conversation: 'inbox' },
      { conversation: 'inbox', text: 'hi' },
      { userId: 'U012', conversation: 'in box', text: 'hi' },
    ]) {
      const response = await session.http!.handle(post('messages', body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.refusal, JSON.stringify(body)).toBeUndefined();
      // The message says what was wrong and repeats nothing of what was sent.
      expect(await bodyText(response), JSON.stringify(body)).not.toContain('U012');
    }
  });

  it('refuses an attachment outside the incoming directory, and delivers nothing', async () => {
    const { session, messages } = open();
    const response = await session.http!.handle(
      post('messages', {
        userId: 'U012',
        conversation: 'inbox',
        text: 'here',
        attachments: [{ name: 'passwd', path: '../../../../etc/passwd' }],
      }),
    );
    expect(response.status).toBe(400);
    expect(response.refusal).toBeUndefined();
    await settle();
    expect(messages).toEqual([]);
  });

  it('answers a known path with the wrong method with 405 and the method it serves', async () => {
    const { session } = open();
    const get = await session.http!.handle(request({ method: 'GET', path: 'messages' }));
    expect(get.status).toBe(405);
    expect(get.headers?.allow).toBe('POST');
    expect(get.refusal).toBeUndefined();
    const stream = await session.http!.handle(request({ path: 'conversations/inbox/events' }));
    expect(stream.status).toBe(405);
    expect(stream.headers?.allow).toBe('GET');
  });

  it('answers a sub-path no route claims with 404 and no refusal', async () => {
    const { session } = open();
    for (const path of ['', 'nope', 'conversations', 'conversations/inbox', 'messages/extra']) {
      const response = await session.http!.handle(request({ path }));
      expect(response.status, path).toBe(404);
      expect(response.refusal, path).toBeUndefined();
    }
  });

  it('opens a conversation stream, and replies land on it', async () => {
    const { session } = open();
    const response = await session.http!.handle(request({ method: 'GET', path: 'conversations/inbox/events' }));
    expect(response.status).toBe(202);
    expect(response.headers).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    const chunks = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    const first = chunks.next();
    await session.postText('inbox', 'the answer');
    expect((await first).value).toBe(
      'id: 1\nevent: message\ndata: {"message":{"surface":"web","conversation":"inbox","id":"w1"},"text":"the answer","replyTo":null}\n\n',
    );
  });

  it('streams a reply as deltas and closes it with the whole message', async () => {
    const { session } = open();
    const response = await session.http!.handle(request({ method: 'GET', path: 'conversations/inbox/events' }));
    const chunks = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    const stream = session.startStream('inbox');
    stream.append('par');
    expect((await chunks.next()).value).toContain('event: delta');
    stream.append('tial');
    expect((await chunks.next()).value).toContain('"delta":"tial"');
    // `message` is what says the reply ended, and it carries the whole text: a client reading only
    // deltas could not tell a finished answer from a pause (plan decision 6).
    await stream.end();
    const last = (await chunks.next()).value as string;
    expect(last).toContain('event: message');
    expect(last).toContain('"text":"partial"');
  });

  it('carries a card, a card update and a private note as their own frames', async () => {
    const { session } = open();
    const response = await session.http!.handle(request({ method: 'GET', path: 'conversations/inbox/events' }));
    const chunks = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    const card = {
      id: 'harness_approval',
      title: 'Approve?',
      notice: 'An approval is waiting.',
      body: [],
      actions: [{ id: 'harness_approval_approve', label: 'Approve', style: 'primary' as const, value: 'a-1' }],
    };
    const ref = await session.postCard('inbox', card);
    expect((await chunks.next()).value).toContain('event: card');
    await session.updateCard(ref, { ...card, actions: [] });
    expect((await chunks.next()).value).toContain('event: card_update');
    await session.postPrivate('inbox', 'U012', 'You are not an approver.');
    const note = (await chunks.next()).value as string;
    expect(note).toContain('event: notice');
    // The note names who it is for. The stream is per conversation and is read by the workspace,
    // not by one person's browser, so the workspace routes it — which is exactly what
    // `postPrivate` means on a surface whose client is a server.
    expect(note).toContain('"userId":"U012"');
  });

  it('delivers a button press, with the card it was on', async () => {
    const { session, actions } = open();
    const ref = await session.postCard('inbox', {
      id: 'harness_approval',
      title: 'Approve?',
      notice: 'An approval is waiting.',
      body: [],
      actions: [],
    });
    const response = await session.http!.handle(
      post('actions', { userId: 'U012', actionId: 'harness_approval_approve', value: 'a-1', messageRef: ref }),
    );
    expect(response.status).toBe(202);
    expect(JSON.parse(await bodyText(response))).toEqual({});
    await settle();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      surface: 'web',
      userId: 'U012',
      conversation: 'inbox',
      actionId: 'harness_approval_approve',
      value: 'a-1',
      message: ref,
    });
    expect(actions[0].trigger).not.toBeNull();
  });

  it('opens a form on the trigger it handed out, and hands its metadata back on submission', async () => {
    const { session, actions, forms } = open();
    const ref = await session.postCard('inbox', {
      id: 'harness_approval',
      title: 'Approve?',
      notice: 'An approval is waiting.',
      body: [],
      actions: [],
    });
    await session.http!.handle(
      post('actions', { userId: 'U012', actionId: 'harness_approval_edit', value: 'a-1', messageRef: ref }),
    );
    await settle();
    const trigger = actions[0].trigger!;
    await session.openForm(trigger, {
      id: 'harness_approval_edit_modal',
      title: 'Decline with a note',
      submitLabel: 'Decline',
      cancelLabel: 'Cancel',
      fields: [{ id: 'harness_approval_note', label: 'Note', multiline: true, optional: true }],
      metadata: '{"approvalId":"a-1","conversation":"inbox"}',
    });
    const response = await session.http!.handle(
      post('forms', {
        userId: 'U012',
        formId: 'harness_approval_edit_modal',
        values: { harness_approval_note: 'not this week' },
        messageRef: ref,
      }),
    );
    expect(response.status).toBe(202);
    await settle();
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({
      surface: 'web',
      userId: 'U012',
      conversation: 'inbox',
      formId: 'harness_approval_edit_modal',
      // The host's own string, carried out with the form and handed back untouched. The adapter
      // remembers it against the conversation the form was opened in; it never reads it.
      metadata: '{"approvalId":"a-1","conversation":"inbox"}',
      values: { harness_approval_note: 'not this week' },
    });
  });

  it('accepts an action and a form this host never posted, because a card it did not post is not an error', async () => {
    const { session, actions, forms } = open();
    const ref = { surface: 'web', conversation: 'inbox', id: 'w99' };
    expect(
      (await session.http!.handle(post('actions', { userId: 'U012', actionId: 'nope', value: 'x', messageRef: ref })))
        .status,
    ).toBe(202);
    expect(
      (await session.http!.handle(post('forms', { userId: 'U012', formId: 'nope', values: {}, messageRef: ref })))
        .status,
    ).toBe(202);
    await settle();
    // Delivered, and the handlers ignore an id they do not know — which is where that decision
    // already lives, for every surface.
    expect(actions).toHaveLength(1);
    expect(forms).toHaveLength(1);
    expect(forms[0].metadata).toBe('');
  });

  it('refuses to connect at all when the document named a token that resolved to nothing', () => {
    expect(() => createWebSession({ ...deps(), secretValues: {} })).toThrow(/token/);
    expect(() => createWebSession({ ...deps(), secretValues: { token: '' } })).toThrow(/token/);
  });

  it('posts where the document said, and to "inbox" when it said nothing', () => {
    expect(createWebSession(deps()).defaultConversation).toBe('inbox');
    expect(createWebSession({ ...deps(), defaultConversation: 'reception' }).defaultConversation).toBe('reception');
  });

  it('declares what it can do, and reads no environment variable to do any of it', () => {
    const session = createWebSession({ ...deps(), env: {} });
    expect(session.capabilities).toEqual({
      streaming: true,
      update: true,
      forms: true,
      privateReply: true,
      inlineConfirm: false,
    });
    expect(session.mention('U012')).toBe('@U012');
  });
});
