import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { TEST_DATABASE_URL, resetDatabase } from '../testing.js';
import { createDb, type Db } from './client.js';
import {
  records,
  auditLog,
  toolEffects,
  messages,
  memoryEntries,
  playbookRuns,
  playbooks,
  runs,
  threads,
  knowledgeChunks,
  knowledgeDocuments,
  knowledgeSources,
} from './schema.js';

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

/**
 * The message a query's rejection really carries, or a sentence saying it did
 * not reject at all. drizzle-orm wraps the driver error as "Failed query: ..."
 * and puts the underlying Postgres error — the trigger's RAISE EXCEPTION
 * message — on `.cause`, so the cause is what the append-only assertions below
 * have to read.
 */
async function rejectionMessage(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
    return 'the query succeeded';
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
    if (cause instanceof Error) return cause.message;
    return err instanceof Error ? err.message : String(err);
  }
}

describe('schema', () => {
  it('inserts and reads a record', async () => {
    const [row] = await db
      .insert(records)
      .values({
        client: 'test',
        pack: 'healthcare',
        kind: 'provider',
        name: 'Dr. Ada Lovelace',
        externalId: '1234567890',
      })
      .returning();
    const found = await db.query.records.findFirst({ where: eq(records.id, row.id) });
    expect(found?.name).toBe('Dr. Ada Lovelace');
    expect(found?.status).toBe('active');
  });

  it('rejects a duplicate external id within a client', async () => {
    await db
      .insert(records)
      .values({ client: 'test', pack: 'healthcare', kind: 'provider', name: 'A', externalId: '1' });
    await expect(
      db.insert(records).values({ client: 'test', pack: 'healthcare', kind: 'provider', name: 'B', externalId: '1' }),
    ).rejects.toThrow();
  });

  it('scopes a record to a client and a pack-declared kind, and keeps external_id unique per kind', async () => {
    await db
      .insert(records)
      .values({ client: 'a', pack: 'healthcare', kind: 'provider', name: 'Ada', externalId: '1234567890' });
    await db
      .insert(records)
      .values({ client: 'b', pack: 'healthcare', kind: 'provider', name: 'Ada', externalId: '1234567890' });
    // Through `rejectionMessage` because drizzle's own message is only "Failed query: …"; the
    // index name the assertion is about is on the Postgres error it carries as `.cause`.
    const duplicate = db
      .insert(records)
      .values({ client: 'a', pack: 'healthcare', kind: 'provider', name: 'Other', externalId: '1234567890' });
    await expect(rejectionMessage(duplicate)).resolves.toMatch(/records_client_kind_external_id_uq/);
  });

  it('audit_log rejects UPDATE and DELETE', async () => {
    const [row] = await db
      .insert(auditLog)
      .values({
        client: 'test',
        caller: 'test',
        tool: 't',
        actionClass: 'read',
        argsHash: 'h',
        decision: 'auto',
      })
      .returning();
    const updated = db.update(auditLog).set({ decision: 'blocked' }).where(eq(auditLog.id, row.id));
    await expect(rejectionMessage(updated)).resolves.toMatch(/append-only/);
    const deleted = db.delete(auditLog).where(eq(auditLog.id, row.id));
    await expect(rejectionMessage(deleted)).resolves.toMatch(/append-only/);
  });

  it('audit_log rejects TRUNCATE', async () => {
    await db.insert(auditLog).values({
      client: 'test',
      caller: 'test',
      tool: 't',
      actionClass: 'read',
      argsHash: 'h',
      decision: 'auto',
    });
    await expect(rejectionMessage(db.execute(sql`TRUNCATE TABLE audit_log`))).resolves.toMatch(/append-only/);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it('stores a tool effect and an audit row with lineage fields', async () => {
    const [effect] = await db
      .insert(toolEffects)
      .values({
        client: 'test',
        tool: 'send_file',
        sink: 'slack',
        idempotencyKey: 'k1',
        payloadEncrypted: Buffer.from('x'),
        summary: 'send roster',
      })
      .returning();
    expect(effect.status).toBe('staged');
    expect(effect.attempts).toBe(0);
    const [row] = await db
      .insert(auditLog)
      .values({
        client: 'test',
        caller: 'c',
        tool: 't',
        actionClass: 'read',
        argsHash: 'h',
        decision: 'auto',
        skill: 'credentialing-intake',
        skillVersion: '1.0.0',
        derivedFrom: [effect.id],
        inputTokens: 10,
        outputTokens: 5,
        costUsd: 0.001,
      })
      .returning();
    expect(row.derivedFrom).toEqual([effect.id]);
    expect(row.skill).toBe('credentialing-intake');
  });

  it('numbers every message, so two rows with one timestamp still have an order', async () => {
    const [thread] = await db
      .insert(threads)
      .values({ client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-1' })
      .returning();
    const at = new Date('2026-09-15T12:00:00Z');
    await db.insert(messages).values([
      { threadId: thread.id, role: 'user', principalId: 'u-1', content: 'first', createdAt: at },
      { threadId: thread.id, role: 'assistant', principalId: 'u-1', content: 'second', createdAt: at },
    ]);
    const rows = await db.select({ content: messages.content, seq: messages.seq }).from(messages).orderBy(messages.seq);
    expect(rows.map((r) => r.content)).toEqual(['first', 'second']);
    expect(rows[1].seq).toBeGreaterThan(rows[0].seq);
  });

  it('stores a memory entry and a playbook with one run', async () => {
    const [entry] = await db
      .insert(memoryEntries)
      .values({ client: 'test', scope: 'principal', principalId: 'u-1', text: 'prefers bullets', createdBy: 'u-1' })
      .returning();
    expect(entry.threadId).toBeNull();
    const [playbook] = await db
      .insert(playbooks)
      .values({
        client: 'test',
        name: 'nightly',
        schedule: '0 7 * * *',
        skill: 'a-skill',
        prompt: 'run it',
        principalId: 'svc-playbooks',
        costCapUsd: 0.5,
      })
      .returning();
    expect(playbook).toMatchObject({ timezone: 'UTC', deliver: 'none', timeoutS: 600, enabled: true, nextRunAt: null });
    const [run] = await db
      .insert(playbookRuns)
      .values({ playbookId: playbook.id, scheduledAt: new Date('2026-09-16T07:00:00Z') })
      .returning();
    expect(run).toMatchObject({ status: 'requested', attempts: 0, runId: null, requestedBy: null });
    await expect(
      db.insert(playbooks).values({
        client: 'test',
        name: 'nightly',
        schedule: '0 8 * * *',
        skill: 'a-skill',
        prompt: 'again',
        principalId: 'svc-playbooks',
        costCapUsd: 1,
      }),
    ).rejects.toThrow();
  });

  it('stores a knowledge source, a document and its chunks, and drops the chunks with the document', async () => {
    const [source] = await db
      .insert(knowledgeSources)
      .values({ client: 'test', name: 'client-folder', kind: 'folder', location: 'clients/test/knowledge' })
      .returning();
    expect(source.lastSyncedAt).toBeNull();
    const [document] = await db
      .insert(knowledgeDocuments)
      .values({
        client: 'test',
        sourceId: source.id,
        path: 'front-desk.md',
        title: 'Front desk',
        sha256: 'a'.repeat(64),
        minLevel: 'member',
        minRank: 0,
      })
      .returning();
    expect(document).toMatchObject({ principals: [], deletedAt: null });
    await db.insert(knowledgeChunks).values([
      {
        documentId: document.id,
        client: 'test',
        ordinal: 0,
        text: 'the office closes at five',
        embedding: Array.from({ length: 1024 }, () => 0.01),
        minLevel: 'member',
        minRank: 0,
      },
      {
        documentId: document.id,
        client: 'test',
        ordinal: 1,
        text: 'escalate anything urgent',
        embedding: Array.from({ length: 1024 }, () => 0.02),
        minLevel: 'lead',
        minRank: 2,
        principals: ['u-coordinator'],
      },
    ]);
    expect(await db.$count(knowledgeChunks)).toBe(2);
    // The generated tsvector is filled by Postgres, so full-text search needs no writer.
    const matched = await db
      .select({ ordinal: knowledgeChunks.ordinal })
      .from(knowledgeChunks)
      .where(sql`${knowledgeChunks.tsv} @@ plainto_tsquery('english', 'office closes')`);
    expect(matched).toEqual([{ ordinal: 0 }]);
    // And the cascade: deleting the document takes its chunks with it, which is what lets a
    // re-sync replace a document's chunks in one statement.
    await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, document.id));
    expect(await db.$count(knowledgeChunks)).toBe(0);
  });
});

describe('threads and messages', () => {
  async function thread() {
    const [row] = await db
      .insert(threads)
      .values({ client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-1', kind: 'chat' })
      .returning();
    return row;
  }

  it('keys a thread by client, surface, conversation and principal', async () => {
    await thread();
    // Through `rejectionMessage`, as for `records_client_kind_external_id_uq` above: drizzle's
    // own message is only "Failed query: …" and the constraint name is on the Postgres error it
    // carries as `.cause`.
    const duplicate = db
      .insert(threads)
      .values({ client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-1', kind: 'chat' });
    await expect(rejectionMessage(duplicate)).resolves.toMatch(/threads_client_surface_conversation_principal_uq/);
    const [other] = await db
      .insert(threads)
      .values({ client: 'test', surface: 'memory', conversation: 'memory', principalId: 'u-2', kind: 'chat' })
      .returning();
    expect(other.id).toBeTruthy();
  });

  it('indexes message content for full-text search through the generated tsv column', async () => {
    const t = await thread();
    await db.insert(messages).values([
      { threadId: t.id, role: 'user', principalId: 'u-1', content: 'When does the licence for Dr Reyes expire?' },
      { threadId: t.id, role: 'assistant', principalId: 'u-1', content: 'It expires on 2027-03-31.' },
    ]);
    const hits = await db
      .select({ content: messages.content })
      .from(messages)
      .where(sql`${messages.tsv} @@ plainto_tsquery('english', 'licence expire')`);
    expect(hits.map((h) => h.content)).toEqual(['When does the licence for Dr Reyes expire?']);
  });

  it('starts a run as running and has no caller column', async () => {
    const [run] = await db.insert(runs).values({ client: 'test', principalId: 'u-1' }).returning();
    expect(run.status).toBe('running');
    expect('caller' in run).toBe(false);
  });
});
