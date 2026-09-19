import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { approvals } from '@harness/db';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { approvalIdOf, resultOf } from '@harness/core-tools/testing';
import { startFakeGateway } from '@harness/runtime-api/testing';
import { openKernel } from '../kernel.js';
import { poolFixture, useTestDb, waitFor, type PoolFixture } from '../../testing.js';

const db = useTestDb();

/** What alpha's knowledge folder holds, and the sentence both tenants search for. */
const KNOWLEDGE = '---\ntitle: Front desk\nmin_level: member\n---\n\nThe alpha front desk closes at five.\n';

const doc = (id: string, over: Record<string, unknown> = {}) =>
  parseClientDocument(fixtureDocument({ id, displayName: id, runtime: 'scripted', surfaces: { memory: {} }, ...over }));

/** One run's kernel client for a tenant, as one of that tenant's own principals. */
async function kernelFor(f: PoolFixture, clientId: string, principalId = 'u-coordinator') {
  const host = f.tenant(clientId).host;
  const principal = (await host.identity.get(principalId))!;
  return openKernel(host, { principal, threadId: null, surface: null, conversation: null });
}

describe('two tenants in one host (invariant 13)', () => {
  it('returns no record, field, memory entry, knowledge chunk, approval, thread or playbook of one to the other', async () => {
    // A real gateway for the embeddings `knowledge_sync` and `knowledge_search` need. Both
    // tenants reach the same one, so a hit that is missing is missing because of the client
    // scoping and not because the search could not run.
    const gateway = await startFakeGateway();
    onTestFinished(() => gateway.close());
    const knowledgeDir = await mkdtemp(path.join(tmpdir(), 'harness-knowledge-'));
    await writeFile(path.join(knowledgeDir, 'front-desk.md'), KNOWLEDGE, 'utf8');

    const f = await poolFixture(db, {
      documents: [
        doc('alpha', {
          // A workspace key, because a pooled host refuses an event that names none: the message
          // below is how alpha's thread and its messages come to exist at all.
          surfaces: { memory: { workspace: 'W-ALPHA' } },
          knowledge: { source: 'dir', path: knowledgeDir },
          playbooks: {
            playbooks: [
              {
                name: 'alpha-nightly',
                schedule: '0 3 * * *',
                skill: 'sample-skill',
                prompt: 'Do the alpha thing.',
                principal: 'svc-playbooks',
                cost_cap_usd: 1,
              },
            ],
          },
        }),
        doc('beta'),
      ],
      trajectories: { alpha: [{ say: 'Noted.' }] },
      env: { HARNESS_GATEWAY_URL: gateway.url },
    });
    const alpha = await kernelFor(f, 'alpha');
    const beta = await kernelFor(f, 'beta');
    try {
      // Alpha writes one of each, through the real kernel tools on its own tenant.
      const created = resultOf<{ provider_id: string }>(
        await alpha.client.callTool({
          name: 'providers_upsert',
          arguments: { name: 'Ada Lovelace', npi: '1234567890', fields: [{ name: 'first_name', value: 'Ada' }] },
        }),
      );
      const recordId = created.provider_id;
      await alpha.client.callTool({
        name: 'memory_add',
        arguments: { scope: 'client', text: 'Alpha closes at five.' },
      });
      expect(
        resultOf<{ chunks: number }>(await alpha.client.callTool({ name: 'knowledge_sync', arguments: {} })).chunks,
      ).toBeGreaterThan(0);
      // A member's `write.internal` call is parked for a human, which is how alpha gets an
      // approval row. It is approved by hand here: a pending row is not executable for anybody,
      // and what this proves is that an *executable* one is still not beta's.
      const asMember = await kernelFor(f, 'alpha', 'u-member');
      const approvalId = approvalIdOf(
        await asMember.client.callTool({
          name: 'providers_upsert',
          arguments: { name: 'Grace Hopper', npi: '1234567891' },
        }),
      );
      await asMember.close('done');
      await db.update(approvals).set({ status: 'approved' }).where(eq(approvals.id, approvalId));
      // And a thread of messages, driven the way a person would: a message on alpha's surface.
      await f.surface('alpha').say('U012', 'Alpha closes at five, remember.', { tenantHint: 'W-ALPHA' });
      await waitFor(() => f.surface('alpha').texts.length > 0);

      // Beta asks every read the kernel publishes, and sees none of it.
      const found = resultOf<{ providers: unknown[] }>(
        await beta.client.callTool({ name: 'providers_search', arguments: { query: 'Ada' } }),
      );
      expect(found.providers).toEqual([]);
      const read = await beta.client.callTool({ name: 'providers_get', arguments: { provider_id: recordId } });
      expect(read.isError ?? false).toBe(true);
      expect(JSON.stringify(read)).not.toContain('Ada');
      // The fields of that record, which is the other half of "no record of one to the other":
      // beta naming alpha's record id is told there is no such record, not what is on it.
      const pending = await beta.client.callTool({
        name: 'providers_list_pending',
        arguments: { provider_id: recordId },
      });
      expect(pending.isError ?? false).toBe(true);
      expect(JSON.stringify(pending)).not.toContain('first_name');
      const recalled = resultOf<{ entries: unknown[] }>(
        await beta.client.callTool({ name: 'memory_list', arguments: { scope: 'client' } }),
      );
      expect(recalled.entries).toEqual([]);
      const known = resultOf<{ hits: unknown[] }>(
        await beta.client.callTool({
          name: 'knowledge_search',
          arguments: { query: 'when does the front desk close' },
        }),
      );
      expect(known.hits).toEqual([]);
      const audited = resultOf<{ entries: unknown[] }>(
        await beta.client.callTool({ name: 'audit_query', arguments: { limit: 50 } }),
      );
      expect(JSON.stringify(audited)).not.toContain('providers_upsert');
      const sessions = resultOf<{ hits: unknown[] }>(
        await beta.client.callTool({ name: 'session_search', arguments: { query: 'closes at five' } }),
      );
      expect(sessions.hits).toEqual([]);
      const executed = await beta.client.callTool({
        name: 'approvals_execute',
        arguments: { approval_id: approvalId },
      });
      expect(executed.isError ?? false).toBe(true);
      const playbooks = resultOf<{ playbooks: { name: string }[] }>(
        await beta.client.callTool({ name: 'playbooks_list', arguments: {} }),
      );
      expect(playbooks.playbooks.map((p) => p.name)).toEqual([]);
      const documents = resultOf<{ documents: unknown[] }>(
        await beta.client.callTool({ name: 'documents_list', arguments: {} }),
      );
      expect(documents.documents).toEqual([]);

      // And the same reads on alpha answer, so none of the above passed because the read failed.
      expect(
        resultOf<{ providers: { name: string }[] }>(
          await alpha.client.callTool({ name: 'providers_search', arguments: { query: 'Ada' } }),
        ).providers.map((p) => p.name),
      ).toEqual(['Ada Lovelace']);
      expect(
        resultOf<{ fields: unknown[] }>(
          await alpha.client.callTool({ name: 'providers_list_pending', arguments: { provider_id: recordId } }),
        ).fields,
      ).toBeInstanceOf(Array);
      expect(
        resultOf<{ entries: { text: string }[] }>(
          await alpha.client.callTool({ name: 'memory_list', arguments: { scope: 'client' } }),
        ).entries.map((e) => e.text),
      ).toEqual(['Alpha closes at five.']);
      expect(
        resultOf<{ hits: { path: string }[] }>(
          await alpha.client.callTool({
            name: 'knowledge_search',
            arguments: { query: 'when does the front desk close' },
          }),
        ).hits.map((h) => h.path),
      ).toEqual(['front-desk.md']);
      expect(
        resultOf<{ hits: unknown[] }>(
          await alpha.client.callTool({ name: 'session_search', arguments: { query: 'closes at five' } }),
        ).hits.length,
      ).toBeGreaterThan(0);
      expect(
        resultOf<{ playbooks: { name: string }[] }>(
          await alpha.client.callTool({ name: 'playbooks_list', arguments: {} }),
        ).playbooks.map((p) => p.name),
      ).toEqual(['alpha-nightly']);
      // Alpha's own approval is still approved: beta's attempt to execute it changed nothing.
      expect(
        await db
          .select()
          .from(approvals)
          .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'approved'))),
      ).toHaveLength(1);
    } finally {
      await alpha.close('done');
      await beta.close('done');
      await f.close();
    }
  });
});
