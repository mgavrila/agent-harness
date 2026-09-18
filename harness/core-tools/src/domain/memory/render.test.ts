import { describe, expect, it } from 'vitest';
import { makeTestDeps, useTestDb } from '../../testing.js';
import { addMemory } from './repository.js';
import { memorySnapshot, renderMemorySnapshot } from './render.js';
import type { MemoryEntry } from './types.js';

const db = useTestDb();

const entry = (id: string, scope: MemoryEntry['scope'], text: string): MemoryEntry => ({
  id,
  scope,
  text,
  created_by: 'u-test',
  created_at: '2026-09-15T12:00:00.000Z',
});

describe('renderMemorySnapshot', () => {
  it('is the empty string with no entries, so the runtime writes its own "(no memories yet)"', () => {
    expect(renderMemorySnapshot([])).toBe('');
  });

  it('lists principal entries first, then client entries, each with its id, under fixed headings', () => {
    const text = renderMemorySnapshot([
      entry('b2b2b2b2-0000-4000-8000-000000000002', 'client', 'The office closes at five.'),
      entry('a1a1a1a1-0000-4000-8000-000000000001', 'principal', 'Prefers bullet points.'),
    ]);
    expect(text).toBe(
      [
        '# Memory',
        '',
        '## Your notes (principal scope)',
        '- Prefers bullet points. (id: a1a1a1a1-0000-4000-8000-000000000001)',
        '',
        '## Shared notes (client scope)',
        '- The office closes at five. (id: b2b2b2b2-0000-4000-8000-000000000002)',
        '',
      ].join('\n'),
    );
  });

  it('marks an empty scope rather than dropping its heading', () => {
    const text = renderMemorySnapshot([entry('a1a1a1a1-0000-4000-8000-000000000001', 'principal', 'Only mine.')]);
    expect(text).toContain('## Shared notes (client scope)\n- (none)\n');
  });

  it('stays under twelve thousand characters at both caps', () => {
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 50; i += 1)
      entries.push(entry(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 'principal', 'p'.repeat(50)));
    for (let i = 0; i < 50; i += 1)
      entries.push(entry(`11111111-0000-4000-8000-${String(i).padStart(12, '0')}`, 'client', 'c'.repeat(80)));
    // 50 × 95 + 49 for the principal section, 50 × 125 + 49 for the client one, two headings and
    // the document's own frame: 11,174. The bound is 12,000, which is the next round number above
    // a snapshot that is already at both caps — a render over it means the shape changed.
    expect(renderMemorySnapshot(entries).length).toBeLessThan(12_000);
  });
});

describe('memorySnapshot', () => {
  it('renders exactly what the principal can see', async () => {
    await addMemory(makeTestDeps(db), { text: 'mine', scope: 'principal' });
    await addMemory(makeTestDeps(db, { principal: { ...makeTestDeps(db).principal, id: 'u-other' } }), {
      text: 'theirs',
      scope: 'principal',
    });
    const text = await memorySnapshot(db, 'test', 'u-test');
    expect(text).toContain('- mine (id: ');
    expect(text).not.toContain('theirs');
  });
});
