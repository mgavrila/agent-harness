import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/** The checkpointer keeps its own tables in this schema; kernel code never references them (spec 6). */
export const CHECKPOINT_SCHEMA = 'langgraph';

/**
 * A saver on the host's database, with its schema and tables created if they are not there yet.
 *
 * `fromConnString` opens a pg pool before `setup()` runs, so a failure there — the wrong URL, a
 * role that may not create a schema — would strand that pool with no session for the host to
 * `stop()`. The pool is closed on the way out and the error re-thrown unchanged.
 */
export async function openCheckpointer(databaseUrl: string): Promise<PostgresSaver> {
  const saver = PostgresSaver.fromConnString(databaseUrl, { schema: CHECKPOINT_SCHEMA });
  try {
    await saver.setup();
  } catch (err) {
    await saver.end();
    throw err;
  }
  return saver;
}
