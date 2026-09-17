import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, encrypt, toolEffects } from '@harness/db';
import { dispatchStagedEffects } from '@harness/core-tools/effects';
import { StaticIdentity } from '@harness/identity-api/testing';
import type { Principal } from '@harness/identity-api';
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
import { STUB_SECRET, stubSession, stubSurface } from './stub-surface.test-helpers.js';

const db = useTestDb();
const key = randomBytes(32);
const now = () => new Date('2026-09-15T12:00:00Z');

const LEAD: Principal = {
  id: 'u-coordinator',
  kind: 'user',
  level: 'lead',
  displayName: 'Coordinator',
  surfaces: { slack: 'U012', memory: 'U012', stub: 'U012' },
  attributes: {},
};

/**
 * Three surfaces at once: Slack, through the real adapter on a fake transport, the memory adapter
 * beside it, and a credential-declaring stub third. This is the suite that proves the host is not
 * a Slack app with an interface in front of it — cards go to the primary, effects go where they
 * are addressed, and a decision can only be taken where the card is.
 *
 * The stub earns its place in the last case: the memory adapter declares no credentials, so
 * without a third adapter the union below is Slack's own list and asserts nothing.
 */
function wire() {
  const slack = fakeSlackSession();
  const memory = new MemorySurface();
  const stub = stubSession();
  // The secrets come off the three adapters' own `Surface.secrets`, the way `loadSurfaces` builds
  // them, rather than out of an array written here. Otherwise the last case below proves only
  // that the host collected what this file remembered.
  const declared = [...new Set([slackSurface, memorySurface, stubSurface].flatMap((s) => [...s.secrets]))];
  const surfaces = surfacesOf([slack.session, memory, stub], declared);
  const core = new FakeCoreToolsClient();
  const identity = new StaticIdentity([LEAD]);
  for (const session of surfaces.all) {
    registerApprovalHandlers(session, { db, surfaces, core, identity, client: 'demo-practice', now });
  }
  return { slack, memory, stub, surfaces, core };
}

describe('a host with several surfaces loaded', () => {
  it('posts every approval card on the primary surface only', async () => {
    await db.insert(approvals).values(pendingApproval());
    const { slack, memory, stub, surfaces } = wire();
    const out = await postPendingApprovals({ db, surface: surfaces.primary, client: 'demo-practice', now });
    expect(out).toMatchObject({ posted: 1 });
    expect(slack.api.posts).toHaveLength(1);
    expect(memory.cards).toHaveLength(0);
    expect(stub.cards).toHaveLength(0);
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
    expect(slack.api.posts[0].text).toBe('Approval needed: forms_release (external) requested by u-coordinator');
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
    expect(slack.api.posts[1].text).toContain('Coordinator');
  });

  it('refuses the same decision when it arrives on the other surface', async () => {
    await db.insert(approvals).values(pendingApproval());
    const { memory, surfaces, core } = wire();
    await postPendingApprovals({ db, surface: surfaces.primary, client: 'demo-practice', now });
    const [row] = await db.select().from(approvals);
    const result = await decideApproval(
      { db, surfaces, core, identity: new StaticIdentity([LEAD]), client: 'demo-practice', now },
      { approvalId: row.id, decision: 'approved', decidedBy: LEAD, surface: 'memory' },
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
   * What a host running this domain in a separate process from the kernel would strip from a
   * child's environment. Since Plan 8's host runs the kernel in-process, nothing here spawns a
   * child any more, but the union of every loaded adapter's declared credentials is still what a
   * deployment needs if it ever does.
   */
  it('collects the credentials of every loaded adapter, from the adapters themselves', () => {
    const { surfaces } = wire();
    // Stated so the case below cannot go quietly hollow: with only these two loaded, the union
    // would be Slack's list and a host that dropped every list but the first would pass.
    expect([...memorySurface.secrets]).toEqual([]);
    expect([...slackSurface.secrets].length).toBeGreaterThan(0);
    // Exact membership, from the adapters' own declarations rather than a list written here. A
    // set, because the order is load order and nothing depends on it.
    expect(new Set(surfaces.secrets)).toEqual(new Set([...slackSurface.secrets, STUB_SECRET]));
    // A union, not a concatenation: a name two adapters both read is carried once.
    expect(surfaces.secrets).toHaveLength(slackSurface.secrets.length + 1);
  });
});
