import { describe, expect, it } from 'vitest';
import { messages } from '@harness/db';
import { useTestDb } from '../../testing.js';
import { appendMessage, findOrCreateThread } from '../threads/repository.js';
import { readThreadFor } from './repository.js';

const db = useTestDb();

describe('readThreadFor', () => {
  it("hands back the thread's own messages and none another tenant's writer left behind", async () => {
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
      content: 'mine',
    });
    // A writer that was not correct: a message under alpha's thread carrying another tenant's id.
    await db
      .insert(messages)
      .values({ client: 'beta', threadId: thread.id, role: 'user', principalId: 'u-one', content: 'theirs' });

    const found = await readThreadFor(db, { client: 'alpha', principalId: 'u-one', threadId: thread.id });
    expect(found?.messages.map((m) => m.content)).toEqual(['mine']);
  });

  it('answers nothing for a thread of another tenant, the same as for one that never existed', async () => {
    const thread = await findOrCreateThread(db, {
      client: 'alpha',
      surface: 'memory',
      conversation: 'C1',
      principalId: 'u-one',
    });
    expect(await readThreadFor(db, { client: 'beta', principalId: 'u-one', threadId: thread.id })).toBeNull();
  });
});
