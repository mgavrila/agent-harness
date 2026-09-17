import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKPOINT_SCHEMA, openCheckpointer } from './checkpointer.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_test';

afterEach(() => vi.restoreAllMocks());

describe('openCheckpointer', () => {
  it('creates its tables in the langgraph schema and hands back a saver that closes', async () => {
    expect(CHECKPOINT_SCHEMA).toBe('langgraph');
    const saver = await openCheckpointer(url);
    await saver.end();
  });

  it('closes the pool it opened when setup fails, rather than leaking it', async () => {
    const ended: string[] = [];
    const broken = {
      setup: () => Promise.reject(new Error('relation does not exist')),
      end: () => {
        ended.push('end');
        return Promise.resolve();
      },
    } as unknown as PostgresSaver;
    // `fromConnString` builds a pg pool before `setup` runs, so a throw there strands it: there is
    // no session yet for the host to `stop()`. The stub is the only way to see the pool closed,
    // because a real saver hands out no handle to assert on.
    vi.spyOn(PostgresSaver, 'fromConnString').mockReturnValue(broken);
    await expect(openCheckpointer(url)).rejects.toThrow('relation does not exist');
    expect(ended).toEqual(['end']);
  });

  it('rejects on a database that is not there, and leaves no handle behind', async () => {
    await expect(openCheckpointer('postgres://harness:harness@localhost:15432/harness_no_such_db')).rejects.toThrow();
  });
});
