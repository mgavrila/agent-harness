import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { providers, auditLog } from './schema.js';
import { TEST_DATABASE_URL, resetDatabase } from './testing.js';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
  ({ db, close } = createDb(TEST_DATABASE_URL));
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetDatabase(db);
});

describe('schema', () => {
  it('inserts and reads a provider', async () => {
    const [row] = await db.insert(providers).values({ client: 'test', name: 'Dr. Ada Lovelace', npi: '1234567890' }).returning();
    const found = await db.query.providers.findFirst({ where: eq(providers.id, row.id) });
    expect(found?.name).toBe('Dr. Ada Lovelace');
    expect(found?.status).toBe('active');
  });

  it('rejects a duplicate npi within a client', async () => {
    await db.insert(providers).values({ client: 'test', name: 'A', npi: '1' });
    await expect(db.insert(providers).values({ client: 'test', name: 'B', npi: '1' })).rejects.toThrow();
  });

  it('audit_log rejects UPDATE and DELETE', async () => {
    const [row] = await db.insert(auditLog).values({
      client: 'test', caller: 'test', tool: 't', actionClass: 'read', argsHash: 'h', decision: 'auto',
    }).returning();
    // drizzle-orm wraps the driver error as "Failed query: ..." and puts the
    // underlying Postgres error (our RAISE EXCEPTION message) on `.cause`.
    const updateErr: any = await db.update(auditLog).set({ decision: 'blocked' }).where(eq(auditLog.id, row.id)).catch((e) => e);
    expect(String(updateErr?.cause?.message ?? updateErr)).toMatch(/append-only/);
    const deleteErr: any = await db.delete(auditLog).where(eq(auditLog.id, row.id)).catch((e) => e);
    expect(String(deleteErr?.cause?.message ?? deleteErr)).toMatch(/append-only/);
  });

  it('audit_log rejects TRUNCATE', async () => {
    await db.insert(auditLog).values({
      client: 'test', caller: 'test', tool: 't', actionClass: 'read', argsHash: 'h', decision: 'auto',
    });
    const err: any = await db.execute(sql`TRUNCATE TABLE audit_log`).catch((e) => e);
    expect(String(err?.cause?.message ?? err?.message ?? err)).toMatch(/append-only/);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });
});
