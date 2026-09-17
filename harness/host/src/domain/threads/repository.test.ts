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
      await appendMessage(db, { threadId: t.id, runId: null, role, principalId: 'u-1', content });
    }
    expect(await recentHistory(db, t.id, 3)).toEqual([
      { role: 'assistant', content: 'two' },
      { role: 'host', content: 'three' },
      { role: 'user', content: 'four' },
    ]);
  });

  it('withholds a message that carries a restricted identifier instead of storing it', async () => {
    const t = await findOrCreateThread(db, key);
    const stored = await appendMessage(db, {
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
});
