import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, encrypt, toolEffects } from '@harness/db';
import { dispatchStagedEffects } from '@harness/core-tools/effects';
import { parseAllowedUsers } from '@harness/surface-api';
import { MemorySurface } from '@harness/surface-api/testing';
import { surface as slackSurface } from '@harness/surface-slack';
import { fakeSlackSession } from '@harness/surface-slack/testing';
import { surface as memorySurface } from '@harness/surface-memory';
import { FakeCoreToolsClient, pendingApproval, useTestDb } from '../../testing.js';
import { APPROVE_ACTION_ID } from '../cards.js';
import { decideApproval } from '../decisions.js';
import { registerApprovalHandlers } from '../handlers.js';
import { postPendingApprovals } from '../poller.js';
import { surfaceSinks } from '../sinks.js';
import { surfacesOf } from './registry.js';

const db = useTestDb();
const key = randomBytes(32);
const now = () => new Date('2026-09-15T12:00:00Z');

/**
 * Two surfaces at once: Slack, through the real adapter on a fake transport, and the memory
 * adapter beside it. This is the suite that proves the host is not a Slack app with an interface
 * in front of it — cards go to the primary, effects go where they are addressed, and a decision
 * can only be taken where the card is.
 */
function wire() {
  const slack = fakeSlackSession({ allowedUsers: parseAllowedUsers('U012') });
  const memory = new MemorySurface({ allowedUsers: parseAllowedUsers('U012') });
  // The secrets come off the two adapters' own `Surface.secrets`, the way `loadSurfaces` builds
  // them, rather than out of an array written here. Otherwise the last case below proves only
  // that the host collected what this file remembered.
  const declared = [...new Set([...slackSurface.secrets, ...memorySurface.secrets])];
  const surfaces = surfacesOf([slack.session, memory], declared);
  const core = new FakeCoreToolsClient();
  for (const session of surfaces.all) {
    registerApprovalHandlers(session, { db, surfaces, core, client: 'demo-practice', now });
  }
  return { slack, memory, surfaces, core };
}

describe('a host with two surfaces loaded', () => {
  it('posts every approval card on the primary surface only', async () => {
    await db.insert(approvals).values(pendingApproval());
    const { slack, memory, surfaces } = wire();
    const out = await postPendingApprovals({ db, surface: surfaces.primary, client: 'demo-practice', now });
    expect(out).toMatchObject({ posted: 1 });
    expect(slack.api.posts).toHaveLength(1);
    expect(memory.cards).toHaveLength(0);
    const [row] = await db.select().from(approvals);
    expect(row).toMatchObject({ surface: 'slack', conversationId: 'C0DEMO' });
    expect(row.messageRef).not.toBeNull();
  });

  it("renders that card as Block Kit, which is the adapter's business and nobody else's", async () => {
    await db.insert(approvals).values(pendingApproval());
    const { slack, surfaces } = wire();
    await postPendingApprovals({ db, surface: surfaces.primary, client: 'demo-practice', now });
    const blocks = slack.api.posts[0].blocks as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['section', 'context', 'section', 'actions', 'context']);
    expect(slack.api.posts[0].text).toBe('Approval needed: forms_release (external) requested by hermes');
  });

  it('accepts the decision on the surface that posted the card, and edits it there', async () => {
    await db.insert(approvals).values(pendingApproval());
    const { slack, surfaces, core } = wire();
    await postPendingApprovals({ db, surface: surfaces.primary, client: 'demo-practice', now });
    const [row] = await db.select().from(approvals);
    await slack.events.emitAction({
      userId: 'U012',
      channel: 'C0DEMO',
      actionId: APPROVE_ACTION_ID,
      value: row.id,
      triggerId: 'T1',
      messageTs: row.messageRef,
    });
    expect(core.executed).toEqual([row.id]);
    expect(slack.api.updates).toHaveLength(1);
    // The reply goes under the card, which on Slack is a thread.
    expect(slack.api.posts[1].thread_ts).toBe(row.messageRef);
    expect(slack.api.posts[1].text).toContain('<@U012>');
  });

  it('refuses the same decision when it arrives on the other surface', async () => {
    await db.insert(approvals).values(pendingApproval());
    const { memory, surfaces, core } = wire();
    await postPendingApprovals({ db, surface: surfaces.primary, client: 'demo-practice', now });
    const [row] = await db.select().from(approvals);
    const result = await decideApproval(
      { db, surfaces, core, client: 'demo-practice', now },
      { approvalId: row.id, decision: 'approved', decidedBy: 'U012', surface: 'memory' },
    );
    expect(result).toEqual({ outcome: 'wrong_surface' });
    expect(core.executed).toEqual([]);
    expect(memory.cards).toHaveLength(0);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
  });

  it('sends an effect to the surface its payload names, and to the primary when it names none', async () => {
    const { slack, memory, surfaces } = wire();
    await db.insert(toolEffects).values([
      {
        client: 'demo-practice',
        tool: 'harness_notify',
        sink: 'surface_message',
        idempotencyKey: 'demo-practice:to-memory',
        payloadEncrypted: encrypt(JSON.stringify({ text: 'for the memory surface', surface: 'memory' }), key),
        summary: 'a note',
      },
      {
        client: 'demo-practice',
        tool: 'harness_notify',
        sink: 'surface_message',
        idempotencyKey: 'demo-practice:to-primary',
        payloadEncrypted: encrypt(JSON.stringify({ text: 'for whoever is primary' }), key),
        summary: 'a note',
      },
    ]);
    const out = await dispatchStagedEffects(db, surfaceSinks(surfaces), { key });
    expect(out).toMatchObject({ dispatched: 2 });
    expect(memory.texts.map((t) => t.text)).toEqual(['for the memory surface']);
    expect(slack.api.posts.map((p) => p.text)).toEqual(['for whoever is primary']);
  });

  /**
   * What the host hands the child-process allowlist. `child-env.test.ts` proves the stripping
   * itself; that assertion lives beside `app/child-env.ts`, because a test under `domain/` may
   * not reach into `app/`.
   */
  it('collects the credentials of every loaded adapter, from the adapters themselves', () => {
    const { surfaces } = wire();
    // The adapters declare these; nothing here does. If the Slack adapter's list ever changes,
    // this test follows it.
    expect(surfaces.secrets).toEqual(expect.arrayContaining([...slackSurface.secrets]));
    expect(surfaces.secrets).toEqual(expect.arrayContaining([...memorySurface.secrets]));
    expect(surfaces.secrets.length).toBeGreaterThan(0);
    // A union, not a concatenation: a name two adapters both read is stripped once.
    expect(new Set(surfaces.secrets).size).toBe(surfaces.secrets.length);
  });
});
