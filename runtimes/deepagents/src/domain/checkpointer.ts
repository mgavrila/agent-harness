import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

/** The checkpointer keeps its own tables in this schema; kernel code never references them (spec 6). */
export const CHECKPOINT_SCHEMA = 'langgraph';

/** A saver on the host's database, with its schema and tables created if they are not there yet. */
export async function openCheckpointer(databaseUrl: string): Promise<PostgresSaver> {
  const saver = PostgresSaver.fromConnString(databaseUrl, { schema: CHECKPOINT_SCHEMA });
  await saver.setup();
  return saver;
}
