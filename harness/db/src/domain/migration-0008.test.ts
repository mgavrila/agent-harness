import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../shared/crypto.js';
import { TEST_DATABASE_URL } from '../testing.js';
import type { Db } from './client.js';
import { createLegacyDatabase, dropLegacyDatabase } from './legacy-0007.test-helpers.js';
import { migrationStatements } from './migration-sql.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../drizzle/0008_generic_records.sql');

const key = Buffer.alloc(32, 7);
const LICENCE_NUMBER = 'AB1234567';
const SSN = '123-45-6789';

/**
 * Assigned in `beforeAll`, because the handle cannot exist before the database does. Every
 * statement below runs against `harness_test_migration`, never against `harness_test`.
 */
let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createLegacyDatabase(TEST_DATABASE_URL));
});

// Close this file's pool on the scratch database before dropping it, or the drop waits on the
// connection. The drop runs even when the pool is already gone, and even when `beforeAll` threw.
afterAll(async () => {
  await close?.();
  await dropLegacyDatabase(TEST_DATABASE_URL);
});

describe('migration 0008_generic_records', () => {
  it('has a hand-written data section, bracketed by the markers the migration test reads', () => {
    const text = readFileSync(MIGRATION, 'utf8');
    expect(text).toContain('-- harness:data-section:begin');
    expect(text).toContain('-- harness:data-section:end');
    expect(text.indexOf('INSERT INTO "records"')).toBeGreaterThan(text.indexOf('-- harness:data-section:begin'));
    expect(text.indexOf('DROP TABLE "providers"')).toBeGreaterThan(text.indexOf('-- harness:data-section:end'));
  });

  it('copies every provider, credential, field, document and deadline into the record model', async () => {
    // One transaction for the seed, the replay and every assertion. It is not needed for
    // isolation — this is a database of its own and `afterAll` drops it — but it pins a single
    // pooled backend for the whole sequence and it means a half-applied migration cannot be
    // left behind for a re-run to trip over. There is no `search_path` to set: the legacy
    // tables and the migration's `"public"."records"` references are in the same schema.
    //
    // The closing `tx.rollback()` throws drizzle's rollback sentinel and `db.transaction`
    // re-throws it rather than swallowing it, so it is caught here and only here: any other
    // error is rethrown, which is what keeps a failed assertion's own message readable.
    try {
      await db.transaction(async (tx) => {
        // A miniature of the demo database: one provider with an NPI, one without, one belonging
        // to a second client so the copy cannot lose the scoping.
        await tx.execute(
          sql.raw(`
        INSERT INTO providers (id, client, name, npi, status) VALUES
          ('11111111-1111-4111-8111-111111111111', 'demo', 'Ada Reyes', '1234567890', 'active'),
          ('22222222-2222-4222-8222-222222222222', 'demo', 'Bo Lin', NULL, 'active'),
          ('33333333-3333-4333-8333-333333333333', 'other', 'Cai Okafor', '9876543210', 'inactive');
        INSERT INTO documents (id, client, provider_id, kind, storage_path, sha256, pages) VALUES
          ('aaaaaaaa-0000-4000-8000-000000000001', 'demo', '11111111-1111-4111-8111-111111111111', 'state_license', 'incoming/a.pdf', 'sha-a', 2),
          ('aaaaaaaa-0000-4000-8000-000000000002', 'demo', NULL, NULL, 'incoming/b.pdf', 'sha-b', 1);
      `),
        );
        await tx.execute(sql`
        INSERT INTO fields (id, provider_id, name, value, value_encrypted, restricted, confidence, status)
        VALUES
          ('bbbbbbbb-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'specialty', 'Family Medicine', NULL, false, 0.99, 'extracted'),
          ('bbbbbbbb-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'ssn', NULL, ${encrypt(SSN, key)}, true, 1, 'extracted'),
          ('bbbbbbbb-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'specialty', 'Cardiology', NULL, false, 0.4, 'pending')
      `);
        await tx.execute(sql`
        INSERT INTO credentials (id, provider_id, kind, issuer, number_encrypted, state, issued_at, expires_at)
        VALUES
          ('cccccccc-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'license', 'TX Medical Board', ${encrypt(LICENCE_NUMBER, key)}, 'TX', '2022-01-01', '2027-03-31'),
          ('cccccccc-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'dea', 'DEA', NULL, 'TX', '2023-05-01', '2026-11-30'),
          ('cccccccc-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'malpractice', 'MedPro', NULL, NULL, '2024-01-01', '2026-10-01'),
          ('cccccccc-0000-4000-8000-000000000004', '22222222-2222-4222-8222-222222222222', 'board_cert', 'ABIM', NULL, NULL, '2020-01-01', '2030-01-01'),
          ('cccccccc-0000-4000-8000-000000000005', '33333333-3333-4333-8333-333333333333', 'license', 'CA Medical Board', NULL, 'CA', '2021-01-01', '2026-09-20')
      `);
        await tx.execute(
          sql.raw(`
        INSERT INTO deadlines (provider_id, credential_id, kind, due_at)
        SELECT provider_id, id, 'expiration', expires_at FROM credentials;
        INSERT INTO deadlines (provider_id, credential_id, kind, due_at)
        SELECT provider_id, id, 'renewal_start', expires_at - 90 FROM credentials;
      `),
        );

        for (const statement of migrationStatements(MIGRATION)) await tx.execute(sql.raw(statement));

        const one = async (query: string) => Number((await tx.execute(sql.raw(query))).rows[0].n);
        expect(await one('SELECT count(*)::int AS n FROM records')).toBe(3);
        expect(
          await one(`SELECT count(*)::int AS n FROM records WHERE pack = 'healthcare' AND kind = 'provider'`),
        ).toBe(3);
        expect(await one(`SELECT count(*)::int AS n FROM records WHERE client = 'demo'`)).toBe(2);
        expect(await one('SELECT count(*)::int AS n FROM attachments')).toBe(5);
        expect(await one('SELECT count(*)::int AS n FROM deadlines')).toBe(10);
        expect(await one('SELECT count(*)::int AS n FROM fields WHERE record_id IS NOT NULL')).toBe(3);
        expect(await one('SELECT count(*)::int AS n FROM documents WHERE record_id IS NOT NULL')).toBe(1);
        // The re-key must point each row at the record its provider became, not merely at some record.
        expect(
          await one(
            `SELECT count(*)::int AS n FROM fields WHERE name = 'ssn' AND record_id = '11111111-1111-4111-8111-111111111111'`,
          ),
        ).toBe(1);
        expect(
          await one(
            `SELECT count(*)::int AS n FROM documents WHERE id = 'aaaaaaaa-0000-4000-8000-000000000001' AND record_id = '11111111-1111-4111-8111-111111111111'`,
          ),
        ).toBe(1);

        // Ids are preserved, which is what keeps every digest_key a playbook has already sent.
        expect(
          await one(`SELECT count(*)::int AS n FROM attachments WHERE id = 'cccccccc-0000-4000-8000-000000000001'`),
        ).toBe(1);
        expect(
          await one(
            `SELECT count(*)::int AS n FROM deadlines WHERE attachment_id = 'cccccccc-0000-4000-8000-000000000001'`,
          ),
        ).toBe(2);

        const record = (
          await tx.execute(
            sql.raw(`
        SELECT name, external_id, status FROM records WHERE id = '11111111-1111-4111-8111-111111111111'
      `),
          )
        ).rows[0];
        expect(record).toEqual({ name: 'Ada Reyes', external_id: '1234567890', status: 'active' });

        // The encrypted bytes travel verbatim, so the deployment's key still reads them.
        const secrets = (
          await tx.execute(
            sql.raw(`
        SELECT
          (SELECT number_encrypted FROM attachments WHERE id = 'cccccccc-0000-4000-8000-000000000001') AS number,
          (SELECT value_encrypted FROM fields WHERE name = 'ssn') AS ssn
      `),
          )
        ).rows[0] as { number: Buffer; ssn: Buffer };
        expect(decrypt(secrets.number, key)).toBe(LICENCE_NUMBER);
        expect(decrypt(secrets.ssn, key)).toBe(SSN);

        // And the tables the migration replaced are gone. `public` of this database holds only
        // what the legacy fixture created and what 0008 left behind — no approvals, no audit_log,
        // because the fixture does not create them and 0008 does not touch them.
        const remaining = await tx.execute(
          sql.raw(`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name
      `),
        );
        expect(remaining.rows.map((r) => r.table_name)).toEqual([
          'attachments',
          'deadlines',
          'documents',
          'fields',
          'records',
        ]);

        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
  });
});
