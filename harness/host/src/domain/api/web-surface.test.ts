import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  APPROVE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_FORM_ID,
  EDIT_NOTE_FIELD_ID,
  postPendingApprovals,
} from '@harness/approvals';
import { parseClientDocument, type ClientDocument } from '@harness/config-api';
import { MemorySecretSource, fixtureDocument } from '@harness/config-api/testing';
import { hashArgs } from '@harness/core-tools';
import { approvals, auditLog } from '@harness/db';
import type { Trajectory } from '@harness/runtime-api/testing';
import { poolFixture, useTestDb, waitFor, type PoolFixture } from '../../testing.js';
import { startRunApi } from './server.js';

const db = useTestDb();
/** The bearer one tenant's document names; each tenant gets its own, stored under one name. */
const tokenFor = (clientId: string): string => `wt-${clientId}-0123456789`;

/**
 * A tenant with a web surface and the run API, and nobody on a chat transport.
 *
 * `surfaces.web` is first in `SURFACE_ORDER`, so it is the primary surface and its inbox is where
 * approval cards go. The principals are declared on `web` rather than on `memory`: this document
 * loads no memory surface at all, which is what a real workspace tenant looks like.
 */
const webTenant = (id: string): ClientDocument =>
  parseClientDocument(
    fixtureDocument({
      id,
      displayName: id,
      runtime: 'scripted',
      surfaces: { web: { token: { ref: 'web-token' } }, http: {} },
      identity: {
        principals: [
          { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: { web: 'U012' } },
          { id: 'u-member', kind: 'user', level: 'member', displayName: 'Member', surfaces: { web: 'U345' } },
          { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host' },
          { id: 'svc-playbooks', kind: 'service', level: 'service', displayName: 'Nightly playbooks' },
        ],
      },
    }),
  );

interface Served {
  f: PoolFixture;
  url: string;
  post(clientId: string, path: string, body: unknown, token?: string): Promise<Response>;
  events(clientId: string, conversation: string, headers?: Record<string, string>): Promise<Response>;
}

/** A pooled host over these tenants, each with its bearer in the store, and the listener over it. */
async function serve(ids: readonly string[], trajectories: Record<string, Trajectory> = {}): Promise<Served> {
  const secrets = new MemorySecretSource();
  for (const id of ids) secrets.put(id, 'web-token', tokenFor(id));
  const f = await poolFixture(db, { documents: ids.map(webTenant), trajectories, secrets });
  const server = startRunApi(f.pool, { token: 'sk-web-surface-test', bind: '127.0.0.1', port: 0 });
  await server.ready;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    await server.close();
    await f.close();
  });
  return {
    f,
    url,
    post: (clientId, path, body, token = tokenFor(clientId)) =>
      fetch(`${url}/tenants/${clientId}/web/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    events: (clientId, conversation, headers = {}) =>
      fetch(`${url}/tenants/${clientId}/web/conversations/${conversation}/events`, {
        headers: { authorization: `Bearer ${tokenFor(clientId)}`, ...headers },
      }),
  };
}

/** One read off a live stream, so a case can act while the turn is still running. */
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  return done ? '' : new TextDecoder().decode(value);
}

/** Read frames until one matches, so a case is not sensitive to a keep-alive landing first. */
async function frameMatching(reader: ReadableStreamDefaultReader<Uint8Array>, what: string): Promise<string> {
  for (let read = 0; read < 20; read += 1) {
    const chunk = await frame(reader);
    if (chunk.includes(what)) return chunk;
    if (chunk === '') break;
  }
  throw new Error(`no frame carrying "${what}" arrived`);
}

/**
 * Everything a stream delivered up to and including the frame that carries `what`, joined.
 *
 * `frameMatching` throws away the reads before the match, which is exactly what a case asking
 * "and nothing of the other tenant arrived" needs to see.
 */
async function framesUntil(reader: ReadableStreamDefaultReader<Uint8Array>, what: string): Promise<string> {
  let seen = '';
  for (let read = 0; read < 20; read += 1) {
    const chunk = await frame(reader);
    if (chunk === '') break;
    seen += chunk;
    if (chunk.includes(what)) return seen;
  }
  throw new Error(`no frame carrying "${what}" arrived`);
}

/**
 * The id of the frame in one read that carries `what`.
 *
 * One read is not one frame: the producer yields a turn's delta and its closing message back to
 * back, and the socket may hand both over together. Reading the id off the start of the chunk
 * would take the delta's, and a resume from there would replay the message the client has seen.
 */
function idOfFrame(chunk: string, what: string): string {
  const carrying = chunk.split('\n\n').find((framed) => framed.includes(what));
  const id = carrying === undefined ? null : /^id: (\d+)/.exec(carrying);
  if (!id) throw new Error(`no frame carrying "${what}" has an id in that read`);
  return id[1];
}

/**
 * The frames carrying `what`, one entry each, once `count` of them have arrived.
 *
 * One read may hand over several frames, so this splits every read rather than counting reads —
 * which is what a case watching for two cards in one inbox needs.
 */
async function framesCarrying(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  what: string,
  count: number,
): Promise<string[]> {
  const found: string[] = [];
  for (let read = 0; read < 40 && found.length < count; read += 1) {
    const chunk = await frame(reader);
    if (chunk === '') break;
    for (const framed of chunk.split('\n\n')) if (framed.includes(what)) found.push(framed);
  }
  if (found.length < count) throw new Error(`only ${found.length} frames carrying "${what}" arrived`);
  return found;
}

/** The reference a `card` frame carries, which is what a button press names back. */
function messageRefOf(chunk: string): Record<string, string> {
  const frame = JSON.parse(chunk.slice(chunk.indexOf('data: ') + 6)) as { message: Record<string, string> };
  return frame.message;
}

/**
 * One pending approval for alpha, as a tool that needed one would have staged it.
 *
 * `idempotencyKey` is the only thing that differs between them, and two rows in one case need two
 * keys: the column is unique per client.
 */
async function pendingApproval(key: string): Promise<typeof approvals.$inferSelect> {
  const [row] = await db
    .insert(approvals)
    .values({
      client: 'alpha',
      action: 'forms_release',
      payload: { tool: 'forms_release', args: {} },
      summary: `forms_release (external) requested by u-coordinator (${key})`,
      requestedBy: 'u-coordinator',
      idempotencyKey: key,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  return row;
}

const refusals = async (): Promise<(typeof auditLog.$inferSelect)[]> =>
  db.select().from(auditLog).where(eq(auditLog.decision, 'refused'));

/**
 * Poll one approval until its status moves off `pending`, and answer with what it moved to.
 *
 * A decision arrives through the door, is acknowledged, and is decided on a later tick, so a case
 * that read the row straight after the 202 would read it before the decision path had run.
 * `waitFor` takes a synchronous predicate and this has to `await` a query, which is why it polls
 * here instead: five milliseconds at a time, bounded by vitest's own test timeout.
 */
async function decidedStatus(id: string): Promise<string> {
  for (;;) {
    const [row] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, id));
    if (row.status !== 'pending') return row.status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('a tenant with no chat transport, talking to its agent over the web surface', () => {
  it('runs a turn from a posted message and puts the reply on the conversation’s stream', async () => {
    const s = await serve(['alpha'], { alpha: [{ say: 'Hello back.' }] });
    const stream = await s.events('alpha', 'inbox');
    expect(stream.status).toBe(202);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    const reader = stream.body!.getReader();
    const response = await s.post('alpha', 'messages', { userId: 'U012', conversation: 'inbox', text: 'hello' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ message: { surface: 'web', conversation: 'inbox', id: 'w1' } });
    const reply = await frameMatching(reader, 'event: message');
    expect(reply).toContain('Hello back.');
    // Every frame carries an id, which is what makes the stream resumable.
    expect(reply).toMatch(/^id: \d+\n/);
    await reader.cancel();
  });

  it('resumes a stream after the last id a client saw, and repeats nothing before it', async () => {
    // A step per *turn*, not a script of two: `ScriptedRuntime` replays its whole trajectory on
    // every run, so a two-step list would answer both turns with both sentences and the closing
    // message of the first would read `"text":"First.\n\nSecond."`. A trajectory may be a function
    // of the request, which is how one runtime answers two turns differently.
    const s = await serve(['alpha'], {
      alpha: (request) => [{ say: request.input.text === 'one' ? 'First.' : 'Second.' }],
    });
    const first = await s.events('alpha', 'inbox');
    const firstReader = first.body!.getReader();
    await s.post('alpha', 'messages', { userId: 'U012', conversation: 'inbox', text: 'one' });
    // The **closing** frame of that turn, not the delta before it. A `{ say }` step yields a
    // `text` event and then `done` (`scripted.ts`), and this surface declares `streaming: true`,
    // so `runTurn` opens a stream: `First.` arrives twice, once as a `delta` and once inside the
    // `message` that ends the turn. Resuming after the delta would replay the message and the
    // last assertion below would fail on a frame that is not a second answer.
    const seen = await frameMatching(firstReader, '"text":"First."');
    const lastId = idOfFrame(seen, '"text":"First."');
    await firstReader.cancel();
    // A second turn with the first reader gone. Whether its frames are held for the resume or
    // arrive live on it, what the resumed stream must never carry is the first turn's.
    await s.post('alpha', 'messages', { userId: 'U012', conversation: 'inbox', text: 'two' });
    const resumed = await s.events('alpha', 'inbox', { 'last-event-id': lastId });
    const resumedReader = resumed.body!.getReader();
    // Whatever arrives first on the resumed stream: the delta of the second turn, never anything
    // of the first. `frameMatching` would scan past a stale frame, so this reads one.
    const next = await frame(resumedReader);
    expect(next).not.toContain('First.');
    // Both frames of the second turn were produced while nobody was reading, so the resumed
    // stream yields them back to back and the socket may hand them over in one read. The closing
    // message is looked for in what has already arrived before another read is waited on.
    const second = next.includes('"text":"Second."') ? next : await frameMatching(resumedReader, '"text":"Second."');
    expect(second).toContain('Second.');
    await resumedReader.cancel();
  });

  it('refuses a wrong bearer and a missing one with 401, and audits each exactly once', async () => {
    const s = await serve(['alpha']);
    const wrong = await s.post('alpha', 'messages', { userId: 'U012', conversation: 'inbox', text: 'hi' }, 'wrong');
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'unauthorised' });
    expect(await refusals()).toHaveLength(1);
    const missing = await fetch(`${s.url}/tenants/alpha/web/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(401);
    const rows = await refusals();
    // Counted, not merely found (invariant 20): one request, one row.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      client: 'alpha',
      caller: 'web:request',
      tool: 'surface_request',
      actionClass: 'read',
      decision: 'refused',
      error: 'bad_bearer',
    });
    // Both halves of invariant 20's sentence. The method and the path **are in** the row, which
    // this recomputes and compares; and they are **not readable from** it, which is the negative
    // below. A row that carried either in the clear would pass one of these and fail the other.
    expect(rows[0].argsHash).toBe(hashArgs({ asked: 'alpha', method: 'POST', path: 'web/messages' }));
    expect(JSON.stringify(rows[0])).not.toContain('messages');
  });

  it('decides an approval from a button press, and updates the card on the stream', async () => {
    const s = await serve(['alpha']);
    const tenant = s.f.tenant('alpha');
    const row = await pendingApproval('k-web-1');
    const stream = await s.events('alpha', 'inbox');
    const reader = stream.body!.getReader();
    // The poller posts to the primary surface's `defaultConversation`, which for this tenant is
    // the inbox its document named — that is what makes the web surface a place a card can go.
    await postPendingApprovals({ db, surface: tenant.host.surfaces.primary, client: 'alpha', now: () => new Date() });
    const card = await frameMatching(reader, 'event: card');
    expect(card).toContain(APPROVE_ACTION_ID);
    const ref = messageRefOf(card);
    const response = await s.post('alpha', 'actions', {
      userId: 'U012',
      actionId: APPROVE_ACTION_ID,
      value: row.id,
      messageRef: ref,
    });
    expect(response.status).toBe(202);
    expect(await decidedStatus(row.id)).toBe('approved');
    // The card the workspace is looking at is edited in place, with its buttons taken away.
    expect(await frameMatching(reader, 'event: card_update')).toContain('"actions":[]');
    await reader.cancel();
  });

  it('declines through the edit form, carrying the note the workspace submitted', async () => {
    const s = await serve(['alpha']);
    const tenant = s.f.tenant('alpha');
    const row = await pendingApproval('k-web-2');
    const stream = await s.events('alpha', 'inbox');
    const reader = stream.body!.getReader();
    await postPendingApprovals({ db, surface: tenant.host.surfaces.primary, client: 'alpha', now: () => new Date() });
    const card = await frameMatching(reader, 'event: card');
    const ref = messageRefOf(card);
    // Edit opens the form, which the adapter sends as a frame and remembers the metadata of.
    await s.post('alpha', 'actions', { userId: 'U012', actionId: EDIT_ACTION_ID, value: row.id, messageRef: ref });
    await frameMatching(reader, EDIT_FORM_ID);
    await s.post('alpha', 'forms', {
      userId: 'U012',
      formId: EDIT_FORM_ID,
      values: { [EDIT_NOTE_FIELD_ID]: 'not this week' },
      messageRef: ref,
    });
    expect(await decidedStatus(row.id)).toBe('declined');
    const [decided] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    // The note the workspace typed reached the decision path, through the metadata the adapter
    // remembered when the form was opened and handed back untouched.
    expect(decided.decisionNote).toBe('not this week');
    await reader.cancel();
  });

  it('keeps two edit dialogues in one inbox apart, so a note declines the approval it was written for', async () => {
    const s = await serve(['alpha']);
    const tenant = s.f.tenant('alpha');
    // Two approvals waiting is the ordinary case, not an exotic one: both cards go to the one
    // inbox and the host's edit dialogue has a single constant form id, so the two dialogues are
    // told apart only by the card each was opened from.
    const first = await pendingApproval('k-web-3');
    const second = await pendingApproval('k-web-4');
    const stream = await s.events('alpha', 'inbox');
    const reader = stream.body!.getReader();
    await postPendingApprovals({ db, surface: tenant.host.surfaces.primary, client: 'alpha', now: () => new Date() });
    const cards = await framesCarrying(reader, 'event: card\n', 2);
    const cardFor = (id: string): string => {
      const found = cards.find((framed) => framed.includes(id));
      if (found === undefined) throw new Error(`no card was posted for approval ${id}`);
      return found;
    };
    const refFirst = messageRefOf(cardFor(first.id));
    const refSecond = messageRefOf(cardFor(second.id));
    // Edit on both, in order, before either is submitted: this is the state that used to lose the
    // first dialogue's metadata to the second's.
    await s.post('alpha', 'actions', {
      userId: 'U012',
      actionId: EDIT_ACTION_ID,
      value: first.id,
      messageRef: refFirst,
    });
    await s.post('alpha', 'actions', {
      userId: 'U012',
      actionId: EDIT_ACTION_ID,
      value: second.id,
      messageRef: refSecond,
    });
    await framesCarrying(reader, EDIT_FORM_ID, 2);
    await s.post('alpha', 'forms', {
      userId: 'U012',
      formId: EDIT_FORM_ID,
      values: { [EDIT_NOTE_FIELD_ID]: 'not this one' },
      messageRef: refFirst,
    });
    expect(await decidedStatus(first.id)).toBe('declined');
    const [declined] = await db.select().from(approvals).where(eq(approvals.id, first.id));
    expect(declined.decisionNote).toBe('not this one');
    // And the approval nobody answered is still waiting, with no note of somebody else's.
    const [untouched] = await db.select().from(approvals).where(eq(approvals.id, second.id));
    expect(untouched.status).toBe('pending');
    expect(untouched.decisionNote).toBeNull();
    await reader.cancel();
  });

  it('ends an open stream when the tenant is reloaded, and tells the client that reconnects', async () => {
    const s = await serve(['alpha']);
    const reader = (await s.events('alpha', 'inbox')).body!.getReader();
    // A document edit quiesces this tenant and opens a new one, whose session holds a stream
    // register of its own. A stream left parked on the old session would show the workspace a
    // live connection that nothing will ever post to again.
    s.f.source.put(parseClientDocument({ ...webTenant('alpha'), persona: 'Something else.' }), 'v2');
    await waitFor(() => s.f.pool.tenants.get('alpha')?.version === 'v2');
    expect((await reader.read()).done).toBe(true);
    // The client reconnects with the id it last saw, which the new session has never minted: it
    // is told so, and then given everything that session holds, rather than being filtered into
    // silence.
    const resumed = (await s.events('alpha', 'inbox', { 'last-event-id': '7' })).body!.getReader();
    const notice = await frameMatching(resumed, 'event: notice');
    expect(notice).toContain('"dropped":true');
    expect(notice).toContain('"reason":"unknown"');
    // No id on that frame, so the client's resume point does not move to an apology.
    expect(notice).not.toMatch(/^id: /);
    await resumed.cancel();
  });

  it('answers a caller the identity plug-in does not know with 202, and a notice on the stream', async () => {
    const s = await serve(['alpha']);
    const stream = await s.events('alpha', 'inbox');
    const reader = stream.body!.getReader();
    // The door has already answered by the time identity is consulted: `handleMessage` resolves
    // the principal, and `SurfaceDeps` has no identity access at all (spec section 4.9).
    const response = await s.post('alpha', 'messages', { userId: 'U999', conversation: 'inbox', text: 'let me in' });
    expect(response.status).toBe(202);
    const notice = await frameMatching(reader, 'event: notice');
    expect(notice).toContain('You are not authorised to use this assistant.');
    await reader.cancel();
  });

  it('refuses an attachment outside the incoming directory, and opens no run', async () => {
    const s = await serve(['alpha'], { alpha: [{ say: 'never' }] });
    const response = await s.post('alpha', 'messages', {
      userId: 'U012',
      conversation: 'inbox',
      text: 'here it is',
      attachments: [{ name: 'passwd', path: '../../../../etc/passwd' }],
    });
    expect(response.status).toBe(400);
    expect(await refusals()).toEqual([]);
    // Nothing started: a 400 from the adapter means the run never opened.
    expect(s.f.tenant('alpha').host.active.size).toBe(0);
  });

  it('keeps two tenants on one pooled host apart, in both directions', async () => {
    const s = await serve(['alpha', 'beta'], { alpha: [{ say: 'Alpha here.' }], beta: [{ say: 'Beta here.' }] });
    const alpha = (await s.events('alpha', 'inbox')).body!.getReader();
    const beta = (await s.events('beta', 'inbox')).body!.getReader();
    await s.post('beta', 'messages', { userId: 'U012', conversation: 'inbox', text: 'hello' });
    const betaReply = await frameMatching(beta, 'event: message');
    expect(betaReply).toContain('Beta here.');
    expect(betaReply).not.toContain('Alpha here.');
    // A message for one tenant is never refused for a missing hint — the adapter reports the
    // client id the host routed on — and it never reaches the other.
    expect(await refusals()).toEqual([]);
    // And the other tenant's stream is **read**, not merely opened: beta's turn has finished, so
    // anything of it that was going to reach alpha has been produced already. Alpha's own turn is
    // what its stream carries, and nothing of beta's is in front of it.
    await s.post('alpha', 'messages', { userId: 'U012', conversation: 'inbox', text: 'hello' });
    const alphaFrames = await framesUntil(alpha, 'event: message');
    expect(alphaFrames).toContain('Alpha here.');
    expect(alphaFrames).not.toContain('Beta here.');
    // Alpha's bearer on beta's mount is one tenant reaching for another, and it is refused.
    const crossed = await s.post(
      'beta',
      'messages',
      { userId: 'U012', conversation: 'inbox', text: 'hi' },
      tokenFor('alpha'),
    );
    expect(crossed.status).toBe(401);
    expect(await refusals()).toHaveLength(1);
    await alpha.cancel();
    await beta.cancel();
  });

  it('never writes a resolved secret into an audit row, a log line or a response (invariant 21)', async () => {
    const lines: string[] = [];
    const secrets = new MemorySecretSource();
    secrets.put('alpha', 'web-token', tokenFor('alpha'));
    const f = await poolFixture(db, {
      documents: [webTenant('alpha')],
      trajectories: { alpha: [{ say: 'Hello back.' }] },
      secrets,
      log: {
        info: (text: string) => lines.push(text),
        warn: (text: string) => lines.push(text),
        error: (text: string) => lines.push(text),
      },
    });
    const server = startRunApi(f.pool, { token: 'sk-web-surface-test', bind: '127.0.0.1', port: 0 });
    await server.ready;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    onTestFinished(async () => {
      await server.close();
      await f.close();
    });
    const stream = await fetch(`${url}/tenants/alpha/web/conversations/inbox/events`, {
      headers: { authorization: `Bearer ${tokenFor('alpha')}` },
    });
    const reader = stream.body!.getReader();
    const response = await fetch(`${url}/tenants/alpha/web/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('alpha')}` },
      body: JSON.stringify({ userId: 'U012', conversation: 'inbox', text: 'hello' }),
    });
    const reply = await frameMatching(reader, 'event: message');
    await reader.cancel();
    // A turn ran, a refusal was audited, and the tenant opened — three paths that each had the
    // token in hand. None of them may have written it anywhere a person or a table can read.
    await fetch(`${url}/tenants/alpha/web/messages`, { method: 'POST', body: '{}' });
    const rows = await db.select().from(auditLog);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(tokenFor('alpha'));
    expect(lines.join('\n')).not.toContain(tokenFor('alpha'));
    expect(await response.text()).not.toContain(tokenFor('alpha'));
    expect(reply).not.toContain(tokenFor('alpha'));
  });
});
