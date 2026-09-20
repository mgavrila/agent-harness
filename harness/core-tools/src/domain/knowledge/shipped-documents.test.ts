import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readKnowledgeFolder } from './document.js';

// src/domain/knowledge -> src/domain -> src -> core-tools -> harness -> the repository root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe("the fixture client's knowledge folder", () => {
  it('parses, and the two documents sit at the two levels a restricted search relies on', async () => {
    const docs = await readKnowledgeFolder(path.join(repoRoot, 'clients', 'fixture', 'knowledge'));
    expect(docs.map((d) => [d.path, d.minLevel, d.minRank])).toEqual([
      ['escalation-and-billing.md', 'lead', 2],
      ['front-desk.md', 'member', 0],
    ]);
    // The pair turns on this: a member's search reaches the first document and not the second,
    // which is what makes "the assistant says it does not have that" a true answer rather than a
    // coincidence. A principal is named on the closed one by id.
    const [escalation, frontDesk] = docs;
    expect(escalation.principals).toEqual(['u-practice-manager']);
    expect(frontDesk.principals).toEqual([]);
    expect(frontDesk.title).toBe('Front desk hours and messages');
    expect(escalation.body).toContain('duty lead');
  });
});
