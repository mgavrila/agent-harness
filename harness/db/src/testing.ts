import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import { createDb, type Db } from './domain/client.js';

/**
 * `encrypt` with the IV supplied, for the one assertion that needs it: the spec's envelope vector
 * fixes the bytes a fixed key, IV and plaintext must produce, and the platform's control plane
 * encrypts with its own code in its own language, so only those bytes prove the two agree.
 *
 * It is on this subpath and not the package's own barrel deliberately. Reusing an IV under one key
 * destroys AES-GCM's confidentiality *and* its authentication, so the only door to an IV-taking
 * encrypt is the one a test comes through; nothing that ships calls it but `encrypt` itself, which
 * passes `randomBytes(12)`.
 */
export { encryptWith } from './shared/crypto.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_test';

/**
 * Wipe every table between tests.
 *
 * `audit_log` carries a BEFORE TRUNCATE trigger that makes it append-only, so
 * the truncate is bracketed by an explicit disable/enable. This is a test-only
 * escape hatch: it works because the test role owns the tables. In production
 * the application role must not own them, so it cannot do this — see the
 * "Database roles" section of docs/runbook.md.
 */
export async function resetDatabase(db: Db): Promise<void> {
  await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER USER`);
  try {
    await db.execute(sql`
      TRUNCATE TABLE client_secrets, client_document_versions, client_documents,
        audit_log, tool_effects, model_calls, playbook_runs, playbooks, memory_entries,
        knowledge_chunks, knowledge_documents, knowledge_sources, runs, messages,
        threads, approvals, deadlines, attachments, fields, documents, records CASCADE
    `);
  } finally {
    await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER USER`);
  }
}

/**
 * The database for one test file: emptied before each test and closed when the
 * file finishes. Call it once at module scope; test files run in their own
 * worker, so each gets its own pool.
 *
 * This is the only copy. @harness/core-tools and @harness/approvals each had a
 * byte-identical one and now re-export this from their own `./testing` subpath, because
 * the truncation list and the append-only bracketing above have to agree with it exactly.
 */
export function useTestDb(): Db {
  const { db, close } = createDb(TEST_DATABASE_URL);
  beforeEach(() => resetDatabase(db));
  afterAll(() => close());
  return db;
}
