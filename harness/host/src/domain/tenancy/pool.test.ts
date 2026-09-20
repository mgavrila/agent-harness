import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, runs, threads } from '@harness/db';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { MemorySurface } from '@harness/surface-api/testing';
import { poolFixture, useTestDb, waitFor } from '../../testing.js';

const db = useTestDb();

// Every document here declares the memory surface and nothing else. A transport-backed surface
// would make `openTenant` demand that surface's secrets, and then `loadSurfaces` would open a
// real connection from a unit test; decision 6 says plainly that this plan cannot serve such a
// surface pooled anyway. `workspace` is the memory surface's tenant key, which is what makes
// pooled routing provable here at all.
const doc = (id: string, workspace?: string) =>
  parseClientDocument(
    fixtureDocument({
      id,
      displayName: id,
      runtime: 'scripted',
      surfaces: { memory: workspace ? { workspace } : {} },
    }),
  );

describe('createHost', () => {
  it('opens exactly the client HARNESS_CLIENT names, and refuses every other (invariant 19)', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha'), doc('beta')], dedicated: 'alpha' });
    expect([...f.pool.tenants.keys()]).toEqual(['alpha']);
    expect(f.pool.resolver.mode).toBe('dedicated');
    expect(f.pool.resolver.resolve({ from: 'api', clientId: 'beta' })).toBeNull();
    expect(await f.pool.tenantFor('beta')).toBeNull();
    await f.close();
  });

  it('opens every client the source lists when HARNESS_CLIENT is unset', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha'), doc('beta')] });
    expect([...f.pool.tenants.keys()].sort()).toEqual(['alpha', 'beta']);
    expect(f.pool.resolver.mode).toBe('pooled');
    await f.close();
  });

  it('gives each tenant its own configuration, its own persona and its own identity session', async () => {
    const f = await poolFixture(db, {
      documents: [
        parseClientDocument(
          fixtureDocument({
            id: 'alpha',
            displayName: 'A',
            runtime: 'scripted',
            persona: 'I am alpha.',
            surfaces: { memory: {} },
          }),
        ),
        parseClientDocument(
          fixtureDocument({
            id: 'beta',
            displayName: 'B',
            runtime: 'scripted',
            persona: 'I am beta.',
            surfaces: { memory: {} },
            packs: [],
          }),
        ),
      ],
    });
    expect(f.tenant('alpha').host.persona).toBe('I am alpha.');
    expect(f.tenant('beta').host.persona).toBe('I am beta.');
    expect(f.tenant('alpha').host.config.packs.all).toHaveLength(1);
    expect(f.tenant('beta').host.config.packs.all).toEqual([]);
    expect(f.tenant('alpha').host.config.client).toBe('alpha');
    expect(f.tenant('beta').host.config.client).toBe('beta');
    expect(f.tenant('alpha').host.identity).not.toBe(f.tenant('beta').host.identity);
    expect(f.tenant('alpha').host.surfaces).not.toBe(f.tenant('beta').host.surfaces);
    expect(f.tenant('alpha').host.runtime).not.toBe(f.tenant('beta').host.runtime);
    await f.close();
  });

  it('routes an event to the tenant whose workspace it names', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha', 'W-ALPHA'), doc('beta', 'W-BETA')] });
    expect(f.pool.resolver.resolve({ from: 'surface', surface: 'memory', tenantHint: 'W-BETA' })).toBe('beta');
    expect(f.pool.resolver.resolve({ from: 'surface', surface: 'memory', tenantHint: 'W-NOBODY' })).toBeNull();
    // The map the pool built came from each document's `tenantKeysOf`, so a key nobody declared
    // belongs to nobody, and a pooled host cannot guess for an event that names no workspace.
    expect(f.pool.resolver.resolve({ from: 'surface', surface: 'memory', tenantHint: null })).toBeNull();
    await f.close();
  });

  it('answers a message on one tenant and refuses the same message named for another', async () => {
    const f = await poolFixture(db, {
      documents: [doc('alpha', 'W-ALPHA'), doc('beta', 'W-BETA')],
      trajectories: { alpha: [{ say: 'Alpha here.' }], beta: [{ say: 'Beta here.' }] },
    });
    const alpha = f.surface('alpha');
    await alpha.say('U012', 'Who are you?', { tenantHint: 'W-ALPHA' });
    await waitFor(() => alpha.texts.length > 0);
    expect(alpha.texts.map((t) => t.text)).toEqual(['Alpha here.']);

    // The same surface, the same words, another tenant's workspace: refused before a turn opens,
    // audited under the tenant that refused it, and beta hears nothing of it either.
    await alpha.say('U012', 'And now?', { tenantHint: 'W-BETA' });
    expect(alpha.texts.map((t) => t.text)).toEqual(['Alpha here.']);
    expect(f.surface('beta').texts).toEqual([]);
    const refusals = await db.select().from(auditLog).where(eq(auditLog.decision, 'unauthorised'));
    expect(refusals.map((row) => [row.client, row.tool])).toEqual([['alpha', 'host_message']]);
    // And no thread was opened for it: the refusal is the whole of what happened.
    expect(await db.select().from(threads)).toHaveLength(1);
    await f.close();
  });

  it('opens one tenant when two callers miss together, rather than one each', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha')] });
    // A client the pool has not opened: the source learns about it after the warm-up, which is
    // the cold miss the run API takes every time it names a client on a pooled host.
    f.source.put(doc('gamma'), 'v1');
    const load = vi.spyOn(f.source, 'load');

    const [first, second] = await Promise.all([f.pool.tenantFor('gamma'), f.pool.tenantFor('gamma')]);

    // One tenant, handed to both callers. Two would mean two schedulers for one client — a
    // playbook firing twice — with the loser's runner, runtime and surfaces running unreferenced.
    expect(first).not.toBeNull();
    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(1);
    expect([...f.pool.tenants.keys()].sort()).toEqual(['alpha', 'gamma']);
    await f.close();
  });

  it("answers or drops a message that arrives while a document is reloading, and never audits it as another client's", async () => {
    const f = await poolFixture(db, {
      documents: [doc('alpha', 'W-ALPHA')],
      // Long enough to still be in flight when the reload begins, and well under the no-sleep
      // ceiling a test has to keep to.
      trajectories: { alpha: [{ sleep: 100 }, { say: 'Alpha here.' }] },
    });
    const before = f.tenant('alpha');
    // The session is held, the way a transport holds its connection, rather than looked up
    // through the pool: a message arrives on the socket that is already open, whatever the map
    // says at that instant.
    const connected = before.host.surfaces.find('memory') as MemorySurface;
    void connected.say('U012', 'Something slow.', { tenantHint: 'W-ALPHA' });
    await waitFor(() => before.host.active.size > 0);

    const reloading = f.pool.invalidate('alpha');
    await waitFor(() => before.host.draining);
    // Mid-reload, on the tenant's own surface, with its own workspace key: this belongs to the
    // tenant that is reloading, so it is answered or dropped — never refused as another client's.
    await connected.say('U012', 'And another.', { tenantHint: 'W-ALPHA' });
    await reloading;

    expect(await db.select().from(auditLog).where(eq(auditLog.decision, 'unauthorised'))).toEqual([]);
    // The turn the drain aborted closed its own row rather than being left `running` forever.
    expect((await db.select().from(runs)).filter((row) => row.status === 'running')).toEqual([]);

    // And the reopened tenant serves the next message, on its own fresh surface.
    const after = f.tenant('alpha');
    expect(after).not.toBe(before);
    await f.surface('alpha').say('U012', 'Are you back?', { tenantHint: 'W-ALPHA' });
    await waitFor(() => f.surface('alpha').texts.length > 0);
    expect(f.surface('alpha').texts.map((t) => t.text)).toEqual(['Alpha here.']);
    await f.close();
  });

  it('reopens a tenant whose document moved, and keeps the old one out of the map', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha')] });
    const before = f.tenant('alpha');
    // The source's own watch is what invalidates: nothing here calls `invalidate` by hand, which
    // is the path a deployment takes when somebody edits a document.
    f.source.put(parseClientDocument({ ...doc('alpha'), persona: 'Something else.' }), 'v2');
    await waitFor(() => f.pool.tenants.get('alpha')?.version === 'v2');
    const after = f.tenant('alpha');
    expect(after).not.toBe(before);
    expect(after.host.persona).toBe('Something else.');
    // The old tenant is shut, not merely forgotten.
    expect(before.host.draining).toBe(true);
    await f.close();
  });

  it('closes and reopens a tenant on invalidate, so no turn ever crosses a document version', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha')] });
    const before = f.tenant('alpha');
    await f.pool.invalidate('alpha');
    const after = f.tenant('alpha');
    expect(after).not.toBe(before);
    // A fresh `Host`, with its own runtime session, its own identity session and its own surfaces:
    // a document is never edited under a live tenant, it is replaced by a new one.
    expect(after.host.runtime).not.toBe(before.host.runtime);
    expect(after.host.identity).not.toBe(before.host.identity);
    expect(after.host.draining).toBe(false);
    await f.close();
  });

  it('keeps watching a tenant whose reopen failed, and reopens it on the next good version', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha')] });
    const before = f.tenant('alpha');
    // A document that parses but cannot be opened: the runtime it names is not installed. This is
    // the whole class — a missing secret, an undeclared service principal, an uninstalled pack —
    // and every one of them is something an operator fixes by editing the document again.
    f.source.put(parseClientDocument({ ...doc('alpha'), runtime: 'nonexistent' }), 'v2');
    await waitFor(() => !f.pool.tenants.has('alpha'));
    expect(before.host.draining).toBe(true);

    // The fix edit. Nothing in the pool is listening for it unless the watch outlived the tenant,
    // and a tenant nobody is watching is a client that stays dead until the process restarts.
    f.source.put(parseClientDocument({ ...doc('alpha'), persona: 'Fixed.' }), 'v3');
    await waitFor(() => f.pool.tenants.get('alpha')?.version === 'v3');
    expect(f.tenant('alpha').host.persona).toBe('Fixed.');
    await f.close();
  });

  it('applies a version that lands while the tenant is reopening', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha')] });
    const third = parseClientDocument({ ...doc('alpha'), persona: 'The third.' });
    const load = f.source.load.bind(f.source);
    // The second edit lands *inside* the reopen the first one started: the old tenant is gone from
    // the map and the new one does not exist yet, which is the window a watch tied to a tenant's
    // lifetime loses a change in. The tenant would then serve the previous version until somebody
    // edited the document again.
    vi.spyOn(f.source, 'load').mockImplementation(async (clientId) => {
      const loaded = await load(clientId);
      if (loaded?.version === 'v2') f.source.put(third, 'v3');
      return loaded;
    });

    f.source.put(parseClientDocument({ ...doc('alpha'), persona: 'The second.' }), 'v2');
    await waitFor(() => f.pool.tenants.get('alpha')?.version === 'v3');
    expect(f.tenant('alpha').host.persona).toBe('The third.');
    await f.close();
  });

  it('closes every tenant it opened, and refuses to open another once it is draining', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha'), doc('beta')] });
    await f.pool.drain(200);
    expect(f.pool.draining).toBe(true);
    expect(await f.pool.tenantFor('beta')).toBe(f.tenant('beta'));
    await f.pool.close();
    expect(f.pool.tenants.size).toBe(0);
    expect(await f.pool.tenantFor('alpha')).toBeNull();
    expect(f.source.closed).toBe(true);
    await f.close();
  });
});
