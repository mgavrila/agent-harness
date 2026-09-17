import { optionalEnv } from '@harness/shared';
import pg from 'pg';

/**
 * Prove the test database is up before a suite in this package runs.
 *
 * `@harness/approvals` runs the migrations here instead. This package may not: a runtime plug-in
 * depends on `@harness/runtime-api` and `@harness/shared` and nothing else in the workspace, and
 * `@harness/db` is on the wrong side of that line. It needs no migration either — the checkpointer
 * owns its own schema and creates it in `PostgresSaver.setup()`, and `harness_test` itself is
 * created by the Postgres container's init script. So this checks the one thing the suite cannot
 * create for itself, and says so plainly when it is missing rather than failing inside a saver.
 */
export default async function setup(): Promise<void> {
  const connectionString =
    optionalEnv('TEST_DATABASE_URL') ?? 'postgres://harness:harness@localhost:15432/harness_test';
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await pool.query('select 1');
  } catch (err) {
    throw new Error(
      `the test database is not reachable at ${connectionString.replace(/:[^:@/]*@/, ':***@')}; start it with \`pnpm db:up\` (${err instanceof Error ? err.message : String(err)})`,
    );
  } finally {
    await pool.end();
  }
}
