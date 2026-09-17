import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import type { Db } from './client.js';
import { createLegacy0008Database, dropLegacy0008Database } from './legacy-0008.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../drizzle/0009_surface_addressing.sql');

let db: Db;
let close: () => Promise<void>;

/**
 * The migration, statement by statement, with drizzle's own breakpoint as the separator and its
 * comment lines stripped. Reading the shipped file rather than a copy is the point: the test
 * fails if someone edits the migration and not the expectations.
 */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement !== '');
}

beforeAll(async () => {
  ({ db, close } = await createLegacy0008Database(TEST_DATABASE_URL));
});

afterAll(async () => {
  await close?.();
  await dropLegacy0008Database(TEST_DATABASE_URL);
});

describe('migration 0009_surface_addressing', () => {
  it('has a hand-written data section, bracketed by the markers this test reads', () => {
    const text = readFileSync(MIGRATION, 'utf8');
    expect(text).toContain('-- harness:data-section:begin');
    expect(text).toContain('-- harness:data-section:end');
    expect(text.indexOf('UPDATE "approvals"')).toBeGreaterThan(text.indexOf('-- harness:data-section:begin'));
    expect(text.indexOf('DROP COLUMN "slack_channel"')).toBeGreaterThan(text.indexOf('-- harness:data-section:end'));
  });

  it('moves the Slack addressing onto the neutral columns and renames the in-flight sinks', async () => {
    try {
      await db.transaction(async (tx) => {
        // Four approvals: one posted and decided, one posted but not yet answered, one claimed
        // whose post never recorded a timestamp, and one nobody has picked up. Then six effects,
        // one per status the rename has to decide about.
        await tx.execute(
          sql.raw(`
        INSERT INTO approvals (id, client, action, payload, summary, requested_by, status, expires_at, idempotency_key, slack_channel, slack_ts, claimed_at) VALUES
          ('11111111-1111-4111-8111-111111111111', 'demo', 'forms_release', '{}'::jsonb, 'released', 'hermes', 'approved', now() + interval '1 day', 'k1', 'C0DEMO', '1789000000.000001', now()),
          ('22222222-2222-4222-8222-222222222222', 'demo', 'forms_release', '{}'::jsonb, 'pending one', 'hermes', 'pending', now() + interval '1 day', 'k2', 'C0DEMO', '1789000000.000002', now()),
          ('33333333-3333-4333-8333-333333333333', 'demo', 'forms_release', '{}'::jsonb, 'claimed, never posted', 'hermes', 'pending', now() + interval '1 day', 'k3', 'C0DEMO', NULL, now() - interval '5 minutes'),
          ('44444444-4444-4444-8444-444444444444', 'demo', 'forms_release', '{}'::jsonb, 'never claimed', 'hermes', 'pending', now() + interval '1 day', 'k4', NULL, NULL, NULL);
        INSERT INTO tool_effects (id, client, tool, sink, idempotency_key, payload_encrypted, summary, status) VALUES
          ('aaaaaaaa-0000-4000-8000-000000000001', 'demo', 'harness_notify', 'slack_message', 'demo:n1', '\\x00'::bytea, 'digest', 'staged'),
          ('aaaaaaaa-0000-4000-8000-000000000002', 'demo', 'forms_release', 'slack_file', 'demo:f1', '\\x00'::bytea, 'release', 'needs_review'),
          ('aaaaaaaa-0000-4000-8000-000000000003', 'demo', 'harness_notify', 'slack_message', 'demo:n2', '\\x00'::bytea, 'already sent', 'dispatched'),
          ('aaaaaaaa-0000-4000-8000-000000000004', 'demo', 'other_tool', 'email', 'demo:e1', '\\x00'::bytea, 'an email', 'staged'),
          ('aaaaaaaa-0000-4000-8000-000000000005', 'demo', 'harness_notify', 'slack_message', 'demo:d1', '\\x00'::bytea, 'in flight', 'dispatching'),
          ('aaaaaaaa-0000-4000-8000-000000000006', 'demo', 'forms_release', 'slack_file', 'demo:x1', '\\x00'::bytea, 'gave up', 'failed');
      `),
        );

        for (const statement of migrationStatements()) await tx.execute(sql.raw(statement));

        const one = async (query: string) => Number((await tx.execute(sql.raw(query))).rows[0].n);

        // Every posted row carries its surface, and the row nobody posted carries none.
        expect(await one(`SELECT count(*)::int AS n FROM approvals WHERE surface = 'slack'`)).toBe(3);
        expect(
          await one(
            `SELECT count(*)::int AS n FROM approvals WHERE surface IS NULL AND conversation_id IS NULL AND message_ref IS NULL`,
          ),
        ).toBe(1);

        const decided = (
          await tx.execute(
            sql.raw(
              `SELECT surface, conversation_id, message_ref FROM approvals WHERE id = '11111111-1111-4111-8111-111111111111'`,
            ),
          )
        ).rows[0];
        expect(decided).toEqual({ surface: 'slack', conversation_id: 'C0DEMO', message_ref: '1789000000.000001' });

        // The stale-claim state survives: claimed, addressed, no message yet. This is exactly
        // what the poller's sweep looks for, so a claim taken before the upgrade is still
        // recovered after it.
        const stranded = (
          await tx.execute(
            sql.raw(
              `SELECT conversation_id, message_ref, (claimed_at IS NOT NULL) AS claimed FROM approvals WHERE id = '33333333-3333-4333-8333-333333333333'`,
            ),
          )
        ).rows[0];
        expect(stranded).toEqual({ conversation_id: 'C0DEMO', message_ref: null, claimed: true });

        // Every status decision 7 names, proved in both directions: the three sendable statuses
        // are renamed, the two terminal ones keep the name they were sent under, and a sink
        // nobody renamed is untouched.
        const sinks = (
          await tx.execute(sql.raw(`SELECT id, sink FROM tool_effects ORDER BY idempotency_key`))
        ).rows.map((r) => r.sink);
        expect(sinks).toEqual([
          'surface_message', // demo:d1, dispatching
          'email', // demo:e1, a sink this migration does not touch
          'surface_file', // demo:f1, needs_review
          'surface_message', // demo:n1, staged
          'slack_message', // demo:n2, dispatched — history, left alone
          'slack_file', // demo:x1, failed — terminal, left alone
        ]);

        // And the two columns the migration replaced are gone.
        const columns = (
          await tx.execute(
            sql.raw(
              `SELECT column_name FROM information_schema.columns WHERE table_name = 'approvals' AND column_name LIKE 'slack%'`,
            ),
          )
        ).rows;
        expect(columns).toEqual([]);

        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
  });
});
