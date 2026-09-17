import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals } from '@harness/db';
import { StaticIdentity } from '@harness/identity-api/testing';
import type { Principal } from '@harness/identity-api';
import { FakeCoreToolsClient, MemorySurface, pendingApproval, useTestDb } from '../testing.js';
import type { ApprovalRow } from './cards.js';
import { decideApproval, threadReplyText, type DecidedOutcome } from './decisions.js';
import { surfacesOf } from './surfaces/registry.js';

const db = useTestDb();
const now = () => new Date('2026-09-15T12:00:00Z');

const LEAD: Principal = {
  id: 'u-coordinator',
  kind: 'user',
  level: 'lead',
  displayName: 'Coordinator',
  surfaces: { memory: 'U012' },
  attributes: {},
};

/** One posted, pending approval on file, with `over` applied last. */
async function seed(over: Record<string, unknown> = {}): Promise<ApprovalRow> {
  const [row] = await db
    .insert(approvals)
    .values(pendingApproval({ surface: 'memory', conversationId: 'memory', messageRef: 'm1', ...over }))
    .returning();
  return row;
}

function deps(surface: MemorySurface, core: FakeCoreToolsClient) {
  return {
    db,
    surfaces: surfacesOf([surface]),
    core,
    identity: new StaticIdentity([LEAD]),
    client: 'demo-practice',
    now,
  };
}

/**
 * The surface as the poller leaves it: one card already in the conversation, so its ref is `m1`
 * and the decision has something to edit in place rather than a missing message to log about.
 */
async function postedSurface(): Promise<MemorySurface> {
  const surface = new MemorySurface();
  await surface.postCard('memory', {
    id: 'harness_approval',
    title: 'Approval needed',
    notice: '',
    body: [],
    actions: [],
  });
  return surface;
}

describe('decideApproval', () => {
  it('approves, executes once through core-tools, edits the card and replies under it', async () => {
    const row = await seed();
    const surface = await postedSurface();
    const core = new FakeCoreToolsClient();
    const res = await decideApproval(deps(surface, core), {
      approvalId: row.id,
      decision: 'approved',
      decidedBy: LEAD,
      surface: 'memory',
    });
    expect(res).toMatchObject({ outcome: 'decided', status: 'approved' });
    expect(core.executed).toEqual([row.id]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after).toMatchObject({ status: 'approved', decidedBy: 'u-coordinator' });
    expect(after.decidedAt).not.toBeNull();
    expect(surface.cards).toHaveLength(1);
    expect(surface.cards[0].card.actions).toEqual([]);
    expect(surface.texts).toHaveLength(1);
    expect(surface.texts[0].replyTo).toMatchObject({ surface: 'memory', conversation: 'memory', id: 'm1' });
    expect(surface.texts[0].text).toContain('approved by');
  });

  it('declines with a note, never executes, and carries the note into the reply', async () => {
    const row = await seed();
    const surface = await postedSurface();
    const core = new FakeCoreToolsClient();
    await decideApproval(deps(surface, core), {
      approvalId: row.id,
      decision: 'declined',
      decidedBy: LEAD,
      surface: 'memory',
      note: 'Use the Q4 roster, not Q3.',
    });
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after).toMatchObject({ status: 'declined', decisionNote: 'Use the Q4 roster, not Q3.' });
    expect(surface.texts[0].text).toContain('Use the Q4 roster, not Q3.');
    expect(surface.texts[0].text).toContain('Nothing was sent');
  });

  it('refuses a row that is already decided', async () => {
    const row = await seed({ status: 'declined' });
    const surface = new MemorySurface();
    const core = new FakeCoreToolsClient();
    const res = await decideApproval(deps(surface, core), {
      approvalId: row.id,
      decision: 'approved',
      decidedBy: LEAD,
      surface: 'memory',
    });
    expect(res).toEqual({ outcome: 'not_actionable' });
    expect(core.executed).toEqual([]);
    expect(surface.cards).toHaveLength(0);
  });

  it('refuses a row past its expiry', async () => {
    const row = await seed({ expiresAt: new Date('2026-09-15T11:00:00Z') });
    const res = await decideApproval(deps(new MemorySurface(), new FakeCoreToolsClient()), {
      approvalId: row.id,
      decision: 'approved',
      decidedBy: LEAD,
      surface: 'memory',
    });
    expect(res).toEqual({ outcome: 'not_actionable' });
  });

  it('refuses a row belonging to another client', async () => {
    const row = await seed({ client: 'other-clinic' });
    const res = await decideApproval(deps(new MemorySurface(), new FakeCoreToolsClient()), {
      approvalId: row.id,
      decision: 'approved',
      decidedBy: LEAD,
      surface: 'memory',
    });
    expect(res).toEqual({ outcome: 'not_actionable' });
  });

  it('refuses a decision that arrives on a surface the card was not posted to', async () => {
    const row = await seed();
    const elsewhere = new MemorySurface({ name: 'other', conversation: 'other' });
    const surfaces = surfacesOf([new MemorySurface(), elsewhere]);
    const core = new FakeCoreToolsClient();
    const res = await decideApproval(
      { db, surfaces, core, identity: new StaticIdentity([LEAD]), client: 'demo-practice', now },
      { approvalId: row.id, decision: 'approved', decidedBy: LEAD, surface: 'other' },
    );
    expect(res).toEqual({ outcome: 'wrong_surface' });
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
  });

  it('reports a failed execution without claiming anything was sent', async () => {
    const row = await seed();
    const surface = await postedSurface();
    const core = new FakeCoreToolsClient();
    core.failExecuteWith = 'approval is not executable: it must be approved and unexpired';
    const res = await decideApproval(deps(surface, core), {
      approvalId: row.id,
      decision: 'approved',
      decidedBy: LEAD,
      surface: 'memory',
    });
    expect(res).toMatchObject({ outcome: 'decided', execution: { status: 'failed' } });
    expect(surface.texts[0].text).toContain('Nothing was sent');
    expect(surface.texts[0].text).not.toContain('Executed');
  });

  it('still records the decision when the surface is unreachable', async () => {
    const row = await seed();
    const surface = await postedSurface();
    surface.failWith = 'conversation_not_found';
    const res = await decideApproval(deps(surface, new FakeCoreToolsClient()), {
      approvalId: row.id,
      decision: 'declined',
      decidedBy: LEAD,
      surface: 'memory',
    });
    expect(res).toMatchObject({ outcome: 'decided', status: 'declined' });
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('declined');
  });

  it('calls onDecided with the row, the principal and the execution after the card is updated', async () => {
    const row = await seed();
    const surface = await postedSurface();
    const core = new FakeCoreToolsClient();
    const seen: DecidedOutcome[] = [];
    await decideApproval(
      {
        ...deps(surface, core),
        onDecided: async (o) => {
          seen.push(o);
        },
      },
      { approvalId: row.id, decision: 'approved', decidedBy: LEAD, surface: 'memory' },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ decidedBy: LEAD, execution: { status: 'executed', tool: 'forms_release' } });
    expect(seen[0].row.status).toBe('approved');
  });

  it('says who decided by display name in the thread reply', async () => {
    const row = await seed();
    const surface = await postedSurface();
    await decideApproval(deps(surface, new FakeCoreToolsClient()), {
      approvalId: row.id,
      decision: 'declined',
      decidedBy: LEAD,
      surface: 'memory',
    });
    expect(surface.texts[0].text).toContain('declined by Coordinator');
  });
});

describe('threadReplyText', () => {
  it('withholds a note that fails the redaction check', async () => {
    const row = await seed({ status: 'declined', decidedBy: 'u-coordinator', decisionNote: 'bad ssn 123-45-6789' });
    const text = threadReplyText(row, 'Coordinator');
    expect(text).not.toContain('123-45-6789');
    expect(text).toContain('withheld');
  });
});
