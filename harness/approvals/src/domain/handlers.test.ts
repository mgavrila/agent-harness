import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals } from '@harness/db';
import { parseAllowedUsers } from '@harness/surface-api';
import { MemorySurface } from '@harness/surface-api/testing';
import { FakeCoreToolsClient, pendingApproval, useTestDb } from '../testing.js';
import { APPROVE_ACTION_ID, DECLINE_ACTION_ID, EDIT_ACTION_ID, EDIT_FORM_ID, EDIT_NOTE_FIELD_ID } from './cards.js';
import { registerApprovalHandlers } from './handlers.js';
import { surfacesOf } from './surfaces/registry.js';

const db = useTestDb();
const now = () => new Date('2026-09-15T12:00:00Z');

async function seed() {
  const [row] = await db
    .insert(approvals)
    .values(pendingApproval({ surface: 'memory', conversationId: 'memory', messageRef: 'm1' }))
    .returning();
  return row;
}

function wire(allowed = 'U012', capabilities: Partial<MemorySurface['capabilities']> = {}) {
  const surface = new MemorySurface({ allowedUsers: parseAllowedUsers(allowed), capabilities });
  const core = new FakeCoreToolsClient();
  registerApprovalHandlers(surface, { db, surfaces: surfacesOf([surface]), core, client: 'demo-practice', now });
  return { surface, core };
}

describe('approval handlers', () => {
  it('approves and executes when an allowed user presses Approve', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press(APPROVE_ACTION_ID, row.id, 'U012');
    expect(core.executed).toEqual([row.id]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('approved');
  });

  it('declines with no note when Decline is pressed', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press(DECLINE_ACTION_ID, row.id, 'U012');
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after).toMatchObject({ status: 'declined', decisionNote: null });
  });

  it('ignores an action that belongs to some other card', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press('someone_elses_button', row.id, 'U012');
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
  });

  it('opens the note form on Edit and changes nothing yet', async () => {
    const row = await seed();
    const { surface } = wire();
    await surface.press(EDIT_ACTION_ID, row.id, 'U012');
    expect(surface.forms).toHaveLength(1);
    expect(surface.forms[0].trigger).toBe('memory-trigger');
    expect(JSON.parse(surface.forms[0].form.metadata)).toEqual({ approval_id: row.id, conversation: 'memory' });
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
  });

  it('declines with the note when the form is submitted', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press(EDIT_ACTION_ID, row.id, 'U012');
    await surface.submit(EDIT_FORM_ID, { [EDIT_NOTE_FIELD_ID]: 'Use the Q4 roster.' }, 'U012');
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after).toMatchObject({ status: 'declined', decisionNote: 'Use the Q4 roster.' });
  });

  it('trusts the conversation carried in the form metadata', async () => {
    const row = await seed();
    const { surface } = wire('');
    await surface.submit(EDIT_FORM_ID, { [EDIT_NOTE_FIELD_ID]: '' }, 'U012', {
      metadata: JSON.stringify({ approval_id: row.id, conversation: 'elsewhere' }),
    });
    expect(surface.privates).toHaveLength(1);
    expect(surface.privates[0]).toMatchObject({ conversation: 'elsewhere', userId: 'U012' });
  });

  it('tells the user when the form metadata cannot be read', async () => {
    const { surface } = wire();
    await surface.submit(EDIT_FORM_ID, {}, 'U012', { metadata: 'not-json' });
    expect(surface.privates[0]).toMatchObject({ userId: 'U012', text: 'That approval no longer exists.' });
  });

  /**
   * A surface that opens a form from a button on a card has no conversation of its own to report
   * on the submission — the Slack adapter sends `''`. The memory surface always has one, so the
   * empty case is driven here by hand rather than left to a fake that cannot produce it.
   */
  it('falls back to the default conversation when the surface reports none and the metadata is unreadable', async () => {
    const { surface } = wire();
    await surface.submit(EDIT_FORM_ID, {}, 'U012', { metadata: '{}', conversation: '' });
    expect(surface.privates[0]).toMatchObject({
      conversation: 'memory',
      userId: 'U012',
      text: 'That approval no longer exists.',
    });
  });

  it('posts nothing when the button names an approval that does not exist', async () => {
    const { surface, core } = wire();
    await surface.press(APPROVE_ACTION_ID, '22222222-2222-4222-8222-222222222222', 'U012');
    expect(core.executed).toEqual([]);
    expect(surface.cards).toHaveLength(0);
  });

  it("refuses a user who is not on this surface's allowlist, and tells them so", async () => {
    const row = await seed();
    const { surface, core } = wire('U012');
    await surface.press(APPROVE_ACTION_ID, row.id, 'U999');
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
    expect(surface.privates[0]).toMatchObject({ userId: 'U999', text: 'You are not an approver for this workspace.' });
  });

  it('fails closed when the allowlist is empty, refusing even a would-be approver', async () => {
    const row = await seed();
    const { surface, core } = wire('');
    await surface.press(APPROVE_ACTION_ID, row.id, 'U012');
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
    expect(surface.privates[0].text).toBe('You are not an approver for this workspace.');
  });

  it('rejects a malformed approval id without throwing', async () => {
    const { surface, core } = wire();
    await expect(surface.press(APPROVE_ACTION_ID, 'not-a-uuid', 'U012')).resolves.toBeUndefined();
    expect(core.executed).toEqual([]);
    expect(surface.privates[0]).toMatchObject({ userId: 'U012', text: 'That approval no longer exists.' });
  });

  it('logs rather than throwing when the surface cannot take a private reply', async () => {
    const row = await seed();
    const { surface, core } = wire('U012', { privateReply: false });
    await expect(surface.press(APPROVE_ACTION_ID, row.id, 'U999')).resolves.toBeUndefined();
    expect(core.executed).toEqual([]);
    expect(surface.privates).toHaveLength(0);
  });
});
