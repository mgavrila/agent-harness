import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { approvals, memoryEntries } from '@harness/db';
import { useTestDb } from '../../testing.js';
import { decodeCursor, encodeCursor, readApprovals, readMemory } from './reads.js';

const db = useTestDb();

/** One approval of a client, at a known moment, so ordering and paging are assertable. */
async function approval(client: string, at: string, over: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(approvals)
    .values({
      client,
      action: 'forms_release',
      payload: { tool: 'forms_release', args: { file_id: 'roster/secret.csv' } },
      payloadEncrypted: Buffer.from('not readable'),
      summary: 'forms_release (external) requested by u-coordinator',
      requestedBy: 'u-coordinator',
      idempotencyKey: `k-${client}-${at}`,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      createdAt: new Date(at),
      ...over,
    })
    .returning();
  return row.id;
}

async function memory(client: string, at: string, over: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(memoryEntries)
    .values({
      client,
      scope: 'client',
      text: 'the practice closes at four on Fridays',
      createdBy: 'u-coordinator',
      createdAt: new Date(at),
      ...over,
    })
    .returning();
  return row.id;
}

describe('the cursor', () => {
  it('round-trips a sort key and refuses anything that is not one', () => {
    const at = new Date('2026-09-10T09:00:00Z');
    const id = '11111111-2222-3333-4444-555555555555';
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ at, id });
    // Opaque to a caller, and checked rather than trusted: a cursor that does not decode is a
    // 400, never a silent first page.
    for (const raw of [
      '',
      'nonsense',
      Buffer.from('no-separator').toString('base64url'),
      Buffer.from('notadate|x').toString('base64url'),
    ]) {
      expect(decodeCursor(raw), raw).toBeNull();
    }
  });
});

describe('readApprovals', () => {
  it('answers this tenant’s rows, newest first, and no column the export excludes', async () => {
    await approval('alpha', '2026-09-10T09:00:00Z');
    const newest = await approval('alpha', '2026-09-11T09:00:00Z');
    await approval('beta', '2026-09-12T09:00:00Z');
    const page = await readApprovals(db, { client: 'alpha', limit: 100 });
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0].id).toBe(newest);
    expect(page.next_cursor).toBeNull();
    // The column list, asserted whole (invariant 23). A field added without a thought is a field
    // this fails on, which is the point: an export is the one place content leaves by accident.
    expect(Object.keys(page.rows[0]).sort()).toEqual([
      'action',
      'conversation_id',
      'created_at',
      'decided_at',
      'decided_by',
      'decision_note',
      'executed_at',
      'expires_at',
      'id',
      'requested_by',
      'status',
      'summary',
      'surface',
    ]);
    // The tool's own arguments, encrypted or not, are invariant 16's rule applied to an export it
    // did not name: never in this answer, in either column.
    expect(JSON.stringify(page.rows)).not.toContain('roster/secret.csv');
    expect(JSON.stringify(page.rows)).not.toContain('payload');
  });

  it('filters on the column’s own vocabulary, one value or several', async () => {
    await approval('alpha', '2026-09-10T09:00:00Z');
    await approval('alpha', '2026-09-11T09:00:00Z', { status: 'approved' });
    await approval('alpha', '2026-09-12T09:00:00Z', { status: 'declined' });
    await approval('alpha', '2026-09-13T09:00:00Z', { status: 'expired' });
    expect((await readApprovals(db, { client: 'alpha', statuses: ['pending'], limit: 100 })).rows).toHaveLength(1);
    expect(
      (await readApprovals(db, { client: 'alpha', statuses: ['approved', 'declined'], limit: 100 })).rows.map(
        (row) => row.status,
      ),
    ).toEqual(['declined', 'approved']);
    expect((await readApprovals(db, { client: 'alpha', limit: 100 })).rows).toHaveLength(4);
  });

  it('pages by the sort key, so an insertion cannot shift a page', async () => {
    for (const day of ['10', '11', '12', '13']) await approval('alpha', `2026-09-${day}T09:00:00Z`);
    const first = await readApprovals(db, { client: 'alpha', limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    // A row written between the two reads lands where its own key puts it and moves nothing.
    await approval('alpha', '2026-09-01T09:00:00Z');
    const second = await readApprovals(db, { client: 'alpha', limit: 2, cursor: first.next_cursor });
    expect(second.rows.map((row) => row.created_at)).toEqual(['2026-09-11T09:00:00.000Z', '2026-09-10T09:00:00.000Z']);
    const third = await readApprovals(db, { client: 'alpha', limit: 2, cursor: second.next_cursor });
    expect(third.rows.map((row) => row.created_at)).toEqual(['2026-09-01T09:00:00.000Z']);
    expect(third.next_cursor).toBeNull();
  });

  it('answers an empty page for a tenant with nothing, rather than failing', async () => {
    await approval('beta', '2026-09-10T09:00:00Z');
    expect(await readApprovals(db, { client: 'alpha', limit: 100 })).toEqual({ rows: [], next_cursor: null });
  });

  it('keeps paging past a deleted anchor, rather than looking done', async () => {
    await approval('alpha', '2026-09-10T09:00:00Z');
    await approval('alpha', '2026-09-11T09:00:00Z');
    const anchor = await approval('alpha', '2026-09-12T09:00:00Z');
    const first = await readApprovals(db, { client: 'alpha', limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].id).toBe(anchor);
    // A retention job removing the anchor between two reads must not make the page look
    // finished: the rows behind it are still owed, and `next_cursor: null` here would be a
    // paged export that silently dropped everything past the deleted row.
    await db.delete(approvals).where(eq(approvals.id, anchor));
    const second = await readApprovals(db, { client: 'alpha', limit: 100, cursor: first.next_cursor });
    expect(second.rows.map((row) => row.created_at)).toEqual(['2026-09-11T09:00:00.000Z', '2026-09-10T09:00:00.000Z']);
    expect(second.next_cursor).toBeNull();
  });
});

describe('readMemory', () => {
  it('answers this tenant’s entries, oldest first, with the entry and whose it is', async () => {
    const first = await memory('alpha', '2026-09-10T09:00:00Z');
    await memory('alpha', '2026-09-11T09:00:00Z', { scope: 'principal', principalId: 'u-member' });
    await memory('beta', '2026-09-12T09:00:00Z');
    const page = await readMemory(db, { client: 'alpha', limit: 100 });
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0].id).toBe(first);
    expect(Object.keys(page.rows[0]).sort()).toEqual([
      'created_at',
      'created_by',
      'id',
      'principal_id',
      'scope',
      'text',
    ]);
    // `thread_id` is a join key and is excluded; `text` is included, because a memory page with no
    // memories is not a page, and `memory_list` already returns exactly this to the model.
    expect(JSON.stringify(page.rows)).not.toContain('thread_id');
  });

  it('filters by scope and by principal, which are the tenant’s own columns', async () => {
    await memory('alpha', '2026-09-10T09:00:00Z');
    await memory('alpha', '2026-09-11T09:00:00Z', { scope: 'principal', principalId: 'u-member' });
    await memory('alpha', '2026-09-12T09:00:00Z', { scope: 'principal', principalId: 'u-coordinator' });
    expect((await readMemory(db, { client: 'alpha', scope: 'client', limit: 100 })).rows).toHaveLength(1);
    expect((await readMemory(db, { client: 'alpha', scope: 'principal', limit: 100 })).rows).toHaveLength(2);
    const one = await readMemory(db, { client: 'alpha', principal: 'u-member', limit: 100 });
    expect(one.rows.map((row) => row.principal_id)).toEqual(['u-member']);
  });

  it('pages oldest first, in its own direction', async () => {
    for (const day of ['10', '11', '12']) await memory('alpha', `2026-09-${day}T09:00:00Z`);
    const first = await readMemory(db, { client: 'alpha', limit: 2 });
    expect(first.rows.map((row) => row.created_at)).toEqual(['2026-09-10T09:00:00.000Z', '2026-09-11T09:00:00.000Z']);
    const second = await readMemory(db, { client: 'alpha', limit: 2, cursor: first.next_cursor });
    expect(second.rows.map((row) => row.created_at)).toEqual(['2026-09-12T09:00:00.000Z']);
    expect(second.next_cursor).toBeNull();
  });

  it('returns no entry of another tenant, whatever the filters say', async () => {
    await memory('beta', '2026-09-10T09:00:00Z', { scope: 'principal', principalId: 'u-member' });
    expect((await readMemory(db, { client: 'alpha', principal: 'u-member', limit: 100 })).rows).toEqual([]);
  });

  it('keeps paging past a deleted anchor, rather than looking done', async () => {
    const anchor = await memory('alpha', '2026-09-10T09:00:00Z');
    await memory('alpha', '2026-09-11T09:00:00Z');
    await memory('alpha', '2026-09-12T09:00:00Z');
    const first = await readMemory(db, { client: 'alpha', limit: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].id).toBe(anchor);
    await db.delete(memoryEntries).where(eq(memoryEntries.id, anchor));
    const second = await readMemory(db, { client: 'alpha', limit: 100, cursor: first.next_cursor });
    expect(second.rows.map((row) => row.created_at)).toEqual(['2026-09-11T09:00:00.000Z', '2026-09-12T09:00:00.000Z']);
    expect(second.next_cursor).toBeNull();
  });
});
