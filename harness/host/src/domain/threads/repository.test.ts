import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { messages } from '@harness/db';
import { useTestDb } from '../../testing.js';
import { WITHHELD, appendMessage, findOrCreateThread, recentHistory } from './repository.js';

const db = useTestDb();
const key = { client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-1' };

describe('threads', () => {
  it('creates a thread once per key and finds it afterwards', async () => {
    const a = await findOrCreateThread(db, key);
    const b = await findOrCreateThread(db, key);
    expect(b.id).toBe(a.id);
    expect(a.kind).toBe('chat');
    const other = await findOrCreateThread(db, { ...key, principalId: 'u-2' });
    expect(other.id).not.toBe(a.id);
  });

  it('appends messages and reads them back oldest first, capped to the newest N', async () => {
    const t = await findOrCreateThread(db, key);
    for (const [role, content] of [
      ['user', 'one'],
      ['assistant', 'two'],
      ['host', 'three'],
      ['user', 'four'],
    ] as const) {
      await appendMessage(db, { client: 'test', threadId: t.id, runId: null, role, principalId: 'u-1', content });
    }
    expect(await recentHistory(db, 'test', t.id, 3)).toEqual([
      { role: 'assistant', content: 'two' },
      { role: 'host', content: 'three' },
      { role: 'user', content: 'four' },
    ]);
  });

  it('writes the tenant on a message and hands back no history from another', async () => {
    const thread = await findOrCreateThread(db, {
      client: 'alpha',
      surface: 'memory',
      conversation: 'C1',
      principalId: 'u-one',
    });
    await appendMessage(db, {
      client: 'alpha',
      threadId: thread.id,
      runId: null,
      role: 'user',
      principalId: 'u-one',
      content: 'hello',
    });
    const [row] = await db.select().from(messages).where(eq(messages.threadId, thread.id));
    expect(row.client).toBe('alpha');
    expect(await recentHistory(db, 'alpha', thread.id, 10)).toHaveLength(1);
    // The same thread id, asked for as somebody else: nothing, not an error.
    expect(await recentHistory(db, 'beta', thread.id, 10)).toEqual([]);
  });

  it('withholds a message that carries a restricted identifier instead of storing it', async () => {
    const t = await findOrCreateThread(db, key);
    const stored = await appendMessage(db, {
      client: 'test',
      threadId: t.id,
      runId: null,
      role: 'assistant',
      principalId: 'u-1',
      content: 'The SSN is 123-45-6789.',
    });
    expect(stored).toBe(WITHHELD);
    const rows = await db.select().from(messages).where(eq(messages.threadId, t.id));
    expect(rows.map((r) => r.content)).toEqual([WITHHELD]);
  });

  it('orders two turns written at one timestamp by insertion, not by their random ids', async () => {
    const t = await findOrCreateThread(db, key);
    const at = new Date('2026-09-15T12:00:00Z');
    // Straight into the table with one clock value, which is what one transaction does.
    for (const content of ['one', 'two', 'three', 'four', 'five', 'six']) {
      await db
        .insert(messages)
        .values({ client: 'test', threadId: t.id, role: 'user', principalId: 'u-1', content, createdAt: at });
    }
    expect((await recentHistory(db, 'test', t.id, 3)).map((m) => m.content)).toEqual(['four', 'five', 'six']);
  });
});
