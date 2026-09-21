import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Level } from '@harness/shared';
import { TEST_MODELS, makeTestDeps, startFakeGateway, useTestDb } from '../../testing.js';
import type { ToolDeps } from '../tooling/types.js';
import { fuseByReciprocalRank, searchKnowledge, type KnowledgeCandidate } from './search.js';
import { syncKnowledge } from './sync.js';

const db = useTestDb();

const FILES: Record<string, string> = {
  'front-desk.md':
    '---\ntitle: Front desk\nmin_level: member\n---\n\nThe front desk answers the telephone until five o’clock and takes messages after that.\n',
  'escalation.md':
    '---\ntitle: Escalation\nmin_level: lead\n---\n\nEscalate an urgent matter to the duty lead by telephone, never by message.\n',
  'billing.md':
    '---\ntitle: Billing rates\nmin_level: admin\nprincipals: [u-analyst, svc-reports]\n---\n\nBilling rates are reviewed every quarter by the finance committee.\n',
};

/** One synced folder and a deps builder that varies only the principal. */
async function synced(): Promise<(level: Level, id?: string) => ToolDeps> {
  const fake = await startFakeGateway();
  onTestFinished(() => fake.close());
  const clientDir = await mkdtemp(path.join(tmpdir(), 'harness-client-'));
  const knowledgeDir = path.join(clientDir, 'knowledge');
  await mkdir(knowledgeDir, { recursive: true });
  for (const [name, text] of Object.entries(FILES)) {
    await writeFile(path.join(knowledgeDir, name), text);
  }
  const depsFor = (level: Level, id = 'u-reader'): ToolDeps =>
    makeTestDeps(db, {
      knowledgeDir,
      gateway: { baseUrl: fake.url, apiKey: 'sk-test', models: TEST_MODELS, timeoutMs: 5_000, maxCallsPerRun: 200 },
      principal: {
        id,
        kind: level === 'service' ? 'service' : 'user',
        level,
        displayName: 'Reader',
        surfaces: {},
        attributes: {},
      },
    });
  const result = await syncKnowledge(depsFor('admin'));
  expect(result).toMatchObject({ added: 3, skipped: [] });
  return depsFor;
}

const paths = (hits: { path: string }[]): string[] => [...new Set(hits.map((h) => h.path))].sort();

describe('searchKnowledge access', () => {
  it('shows a member only the member-level document, whatever it asks for', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('member'), { query: 'telephone', k: 10 });
    expect(paths(hits)).toEqual(['front-desk.md']);
  });

  it('shows a lead the member and lead documents, and not the admin one', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('lead'), { query: 'telephone', k: 10 });
    expect(paths(hits)).toEqual(['escalation.md', 'front-desk.md']);
  });

  it('shows an admin everything', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('admin'), { query: 'telephone rates', k: 10 });
    expect(paths(hits)).toEqual(['billing.md', 'escalation.md', 'front-desk.md']);
  });

  it('shows a named principal a document above their level, and nothing else above it', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('member', 'u-analyst'), { query: 'telephone rates', k: 10 });
    // `u-analyst` is named on billing.md, so a member sees it; escalation.md names nobody.
    expect(paths(hits)).toEqual(['billing.md', 'front-desk.md']);
  });

  it('shows a service principal only what names it, because a service is not on the level ladder', async () => {
    const depsFor = await synced();
    const named = await searchKnowledge(depsFor('service', 'svc-reports'), { query: 'telephone rates', k: 10 });
    expect(paths(named.hits)).toEqual(['billing.md']);
    const other = await searchKnowledge(depsFor('service', 'svc-nobody'), { query: 'telephone rates', k: 10 });
    expect(other.hits).toEqual([]);
  });

  it('never crosses a client boundary', async () => {
    const depsFor = await synced();
    const deps = depsFor('admin');
    const elsewhere = makeTestDeps(db, {
      knowledgeDir: deps.knowledgeDir,
      gateway: deps.gateway,
      client: 'other-client',
      principal: deps.principal,
    });
    expect((await searchKnowledge(elsewhere, { query: 'telephone', k: 10 })).hits).toEqual([]);
  });

  it('applies the filter before ranking, so k never spends a slot on a chunk the caller may not read', async () => {
    const depsFor = await synced();
    // Every word of this query is in escalation.md and none of them is in front-desk.md, so both
    // rankings put escalation.md first over the whole corpus. At k: 1 that is the only row either
    // ranking returns, which is what separates the two designs: a filter over the ranked result
    // answers nothing here, and the `WHERE` filter this code uses answers the one document the
    // caller may read. That is decision 5's "never ranked, never counted toward k" (invariant 7),
    // and it is the half of the invariant that a query with k at or above the fixture cannot see.
    const member = await searchKnowledge(depsFor('member'), { query: 'duty lead escalate urgent', k: 1 });
    expect(paths(member.hits)).toEqual(['front-desk.md']);
    // The same at the other end of the access rule: a service clears nothing on level and reads
    // billing.md only because it is named on it.
    const service = await searchKnowledge(depsFor('service', 'svc-reports'), {
      query: 'duty lead escalate urgent',
      k: 1,
    });
    expect(paths(service.hits)).toEqual(['billing.md']);
  });
});

describe('searchKnowledge results', () => {
  it('returns everything the model needs to cite a chunk', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('admin'), { query: 'duty lead escalate urgent', k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    expect(top.path).toBe('escalation.md');
    expect(top).toMatchObject({ title: 'Escalation', ordinal: 0 });
    expect(top.text).toContain('Escalate an urgent matter');
    expect(top.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(top.score).toBeGreaterThan(0);
    // Ordered by the fused score, best first.
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
  });

  it('honours k, and clamps a caller that asks for more than the limit', async () => {
    const depsFor = await synced();
    expect((await searchKnowledge(depsFor('admin'), { query: 'telephone', k: 1 })).hits).toHaveLength(1);
    const many = await searchKnowledge(depsFor('admin'), { query: 'telephone', k: 999 });
    expect(many.hits.length).toBeLessThanOrEqual(3);
  });

  it('still answers when no word matches, because a nearest-neighbour search has no threshold', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('admin'), { query: 'zzzz qqqq', k: 2 });
    // The lexical half matches nothing; the vector half still returns its nearest chunks. The
    // tool's description tells the model a hit is the nearest text, not an answer.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('finds a document by an exact word the embedding would not favour', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('admin'), { query: 'quarter', k: 3 });
    expect(hits.map((h) => h.path)).toContain('billing.md');
  });
});

describe('fuseByReciprocalRank', () => {
  const candidate = (id: string): KnowledgeCandidate => ({
    chunk_id: id,
    document_id: `doc-${id}`,
    path: `${id}.md`,
    title: id,
    updated_at: '2026-09-15T12:00:00.000Z',
    ordinal: 0,
    text: id,
  });

  it('adds one over sixty-plus-rank per list, so agreement beats a single brilliant hit', () => {
    const vector = [candidate('a'), candidate('b'), candidate('c')];
    const lexical = [candidate('c'), candidate('b'), candidate('d')];
    const fused = fuseByReciprocalRank([vector, lexical], 4);
    expect(fused.map((h) => h.chunk_id)).toEqual(['c', 'b', 'a', 'd']);
    // c: 1/63 + 1/61; b: 1/62 + 1/62; a: 1/61; d: 1/63. Both lists found `b` and `c`, and both
    // beat the chunk either list put first on its own; `c` edges `b` because one list ranked it
    // first, which is the half-point a rank-1 hit is worth over a rank-2 one.
    expect(fused[0].score).toBeCloseTo(1 / 63 + 1 / 61, 12);
    expect(fused[3].score).toBeCloseTo(1 / 63, 12);
  });

  it('cuts to k and is deterministic on a tie', () => {
    const fused = fuseByReciprocalRank([[candidate('b')], [candidate('a')]], 5);
    expect(fused.map((h) => h.chunk_id)).toEqual(['a', 'b']);
    expect(fuseByReciprocalRank([[candidate('b')], [candidate('a')]], 1).map((h) => h.chunk_id)).toEqual(['a']);
  });

  it('is empty for empty lists', () => {
    expect(fuseByReciprocalRank([[], []], 5)).toEqual([]);
  });
});
