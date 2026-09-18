import { describe, expect, it } from 'vitest';
import { messages, threads, type Db } from '@harness/db';
import { TEST_PRINCIPAL, makeTestDeps, useTestDb } from '../../testing.js';
import { searchSessions } from './search.js';

const db = useTestDb();

async function thread(
  dbh: Db,
  principalId: string,
  conversation: string,
  kind: 'chat' | 'playbook' = 'chat',
): Promise<string> {
  const [row] = await dbh
    .insert(threads)
    .values({ client: 'test', surface: 'memory', conversation, principalId, kind })
    .returning({ id: threads.id });
  return row.id;
}

async function say(
  dbh: Db,
  threadId: string,
  role: string,
  content: string,
  at = '2026-09-15T12:00:00Z',
): Promise<void> {
  await dbh.insert(messages).values({ threadId, role, principalId: 'u-any', content, createdAt: new Date(at) });
}

describe('searchSessions', () => {
  it('finds only the caller threads for a member, ranked, with a snippet around the match (invariant 7)', async () => {
    const mine = await thread(db, 'u-test', 'c1');
    const theirs = await thread(db, 'u-other', 'c2');
    const nightly = await thread(db, 'svc-playbooks', 'playbook:nightly', 'playbook');
    await say(
      db,
      mine,
      'user',
      'When does the Aetna roster go out? It expires soon and the roster is due next week.',
      '2026-09-14T09:00:00Z',
    );
    await say(
      db,
      mine,
      'assistant',
      'The roster goes out on the first business day; nothing expires before then.',
      '2026-09-14T09:01:00Z',
    );
    await say(db, theirs, 'user', 'roster roster roster: the roster is late');
    await say(db, nightly, 'assistant', 'Renewals inside 90 days: the roster is unaffected.');

    const member = makeTestDeps(db, { principal: { ...TEST_PRINCIPAL, level: 'member' } });
    const { hits } = await searchSessions(member, { query: 'roster', limit: 20 });
    expect(hits.map((h) => h.thread_id)).toEqual([mine, mine]);
    expect(hits[0]).toMatchObject({ role: 'user', created_at: '2026-09-14T09:00:00.000Z' });
    expect(hits[0].snippet).toContain('roster');
    expect(hits[0].snippet.split(' ').length).toBeLessThanOrEqual(25);
  });

  it('adds the playbook threads for a lead and above, and nothing else', async () => {
    const mine = await thread(db, 'u-test', 'c1');
    const theirs = await thread(db, 'u-other', 'c2');
    const nightly = await thread(db, 'svc-playbooks', 'playbook:nightly', 'playbook');
    await say(db, mine, 'user', 'the roster question');
    await say(db, theirs, 'user', 'the roster answer');
    await say(db, nightly, 'assistant', 'the roster digest');
    const lead = makeTestDeps(db, { principal: { ...TEST_PRINCIPAL, level: 'lead' } });
    expect((await searchSessions(lead, { query: 'roster', limit: 20 })).hits.map((h) => h.thread_id).sort()).toEqual(
      [mine, nightly].sort(),
    );
    const admin = makeTestDeps(db, { principal: { ...TEST_PRINCIPAL, level: 'admin' } });
    expect((await searchSessions(admin, { query: 'roster', limit: 20 })).hits).toHaveLength(2);
    // A service sees its own threads only: `service` clears no user level.
    const service = makeTestDeps(db, {
      principal: { ...TEST_PRINCIPAL, id: 'svc-playbooks', kind: 'service', level: 'service' },
    });
    expect((await searchSessions(service, { query: 'roster', limit: 20 })).hits.map((h) => h.thread_id)).toEqual([
      nightly,
    ]);
  });

  it('caps the hits at the limit and answers a stop-words-only query with nothing', async () => {
    const mine = await thread(db, 'u-test', 'c1');
    for (let i = 0; i < 25; i += 1)
      await say(db, mine, 'user', `renewal ${i}`, `2026-09-01T00:${String(i).padStart(2, '0')}:00Z`);
    const deps = makeTestDeps(db);
    expect((await searchSessions(deps, { query: 'renewal', limit: 20 })).hits).toHaveLength(20);
    expect((await searchSessions(deps, { query: 'renewal', limit: 5 })).hits).toHaveLength(5);
    // Clamped, not just capped: the tool's schema stops a zero, but a direct caller can pass one.
    expect((await searchSessions(deps, { query: 'renewal', limit: 0 })).hits).toHaveLength(1);
    expect((await searchSessions(deps, { query: 'the of', limit: 20 })).hits).toEqual([]);
  });

  it('stays inside the client', async () => {
    const [foreign] = await db
      .insert(threads)
      .values({ client: 'someone-else', surface: 'memory', conversation: 'c9', principalId: 'u-test' })
      .returning({ id: threads.id });
    await say(db, foreign.id, 'user', 'a roster in another deployment');
    expect((await searchSessions(makeTestDeps(db), { query: 'roster', limit: 20 })).hits).toEqual([]);
  });
});
