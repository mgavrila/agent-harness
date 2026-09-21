import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratchDatabase } from '../../testing/db.js';

let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
beforeAll(async () => {
  scratch = await scratchDatabase();
});
afterAll(() => scratch.close());

describe('migrations', () => {
  it('create every table of spec §6 and the three kernel contract tables', async () => {
    const rows = await scratch.db.execute(
      sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const names = rows.rows.map((r) => r.tablename);
    for (const t of [
      'users',
      'sessions',
      'organisations',
      'memberships',
      'invitations',
      'agents',
      'agent_releases',
      'secrets',
      'knowledge_files',
      'audit',
      'client_documents',
      'client_document_versions',
      'client_secrets',
    ]) {
      expect(names).toContain(t);
    }
  });
});
