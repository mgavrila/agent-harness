import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Level } from '@harness/shared';
import { connectTestClient, makeTestDeps, resultOf, startFakeGateway, textOf, useTestDb } from '../testing.js';
import { createCoreToolsServer } from './catalog.js';

const db = useTestDb();

async function client(level: Level, id = 'u-reader') {
  const fake = await startFakeGateway();
  onTestFinished(() => fake.close());
  const clientDir = await mkdtemp(path.join(tmpdir(), 'harness-client-'));
  await mkdir(path.join(clientDir, 'knowledge'), { recursive: true });
  await writeFile(
    path.join(clientDir, 'knowledge', 'front-desk.md'),
    '---\ntitle: Front desk\nmin_level: member\n---\n\nThe front desk answers the telephone until five.\n',
  );
  await writeFile(
    path.join(clientDir, 'knowledge', 'escalation.md'),
    '---\ntitle: Escalation\nmin_level: lead\n---\n\nEscalate an urgent matter to the duty lead.\n',
  );
  const deps = makeTestDeps(db, {
    clientDir,
    gateway: { baseUrl: fake.url, apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 200 },
    principal: {
      id,
      kind: 'user',
      level,
      displayName: 'Reader',
      surfaces: {},
      attributes: {},
    },
  });
  return { deps, tools: await connectTestClient(() => createCoreToolsServer(deps)) };
}

describe('knowledge_sync', () => {
  it('is an admin tool: an admin syncs the folder and gets the counts back', async () => {
    const { tools } = await client('admin');
    const result = resultOf<{ source: string; scanned: number; added: number; chunks: number }>(
      await tools.callTool({ name: 'knowledge_sync', arguments: {} }),
    );
    expect(result).toMatchObject({ source: 'client-folder', scanned: 2, added: 2 });
    expect(result.chunks).toBe(2);
  });

  it('is refused for a lead, because it rewrites what everyone can read', async () => {
    const { tools } = await client('lead');
    const refused = await tools.callTool({ name: 'knowledge_sync', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('blocked');
  });
});

describe('knowledge_search', () => {
  it('answers a member with the member-level document only, and cites it', async () => {
    const admin = await client('admin');
    await admin.tools.callTool({ name: 'knowledge_sync', arguments: {} });

    const member = await client('member');
    const found = resultOf<{ hits: { path: string; title: string; updated_at: string; text: string }[] }>(
      await member.tools.callTool({ name: 'knowledge_search', arguments: { query: 'telephone duty lead' } }),
    );
    expect(found.hits.map((h) => h.path)).toEqual(['front-desk.md']);
    expect(found.hits[0]).toMatchObject({ title: 'Front desk' });
    expect(found.hits[0].text).toContain('front desk');
  });

  it('answers a lead with both, newest access rules applied', async () => {
    const admin = await client('admin');
    await admin.tools.callTool({ name: 'knowledge_sync', arguments: {} });

    const lead = await client('lead');
    const found = resultOf<{ hits: { path: string }[] }>(
      await lead.tools.callTool({ name: 'knowledge_search', arguments: { query: 'telephone duty lead', k: 5 } }),
    );
    expect([...new Set(found.hits.map((h) => h.path))].sort()).toEqual(['escalation.md', 'front-desk.md']);
  });

  it('refuses a k above the limit and a query that is too short, at the schema', async () => {
    const { tools } = await client('member');
    const tooBig = await tools.callTool({ name: 'knowledge_search', arguments: { query: 'telephone', k: 99 } });
    expect(tooBig.isError).toBe(true);
    const tooShort = await tools.callTool({ name: 'knowledge_search', arguments: { query: 'a' } });
    expect(tooShort.isError).toBe(true);
  });
});
