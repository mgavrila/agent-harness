import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseKnowledgeDocument, readKnowledgeFolder } from './document.js';

const FRONT = `---
title: Front desk
min_level: member
---

The office closes at five.
`;

describe('parseKnowledgeDocument', () => {
  it('reads the frontmatter and hands back the body, the level and its rank', () => {
    const doc = parseKnowledgeDocument('front-desk.md', FRONT);
    expect(doc).toMatchObject({
      path: 'front-desk.md',
      title: 'Front desk',
      minLevel: 'member',
      minRank: 0,
      principals: [],
      body: 'The office closes at five.',
    });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the whole file, frontmatter included, so an access change re-syncs', () => {
    const open = parseKnowledgeDocument('a.md', FRONT);
    const closed = parseKnowledgeDocument('a.md', FRONT.replace('min_level: member', 'min_level: lead'));
    expect(closed.minRank).toBe(2);
    expect(closed.body).toBe(open.body);
    expect(closed.sha256).not.toBe(open.sha256);
  });

  it('defaults a document with no frontmatter to the lowest level and titles it from its heading', () => {
    const doc = parseKnowledgeDocument('policies/holidays.md', '# Public holidays\n\nThe clinic is closed.\n');
    expect(doc).toMatchObject({ title: 'Public holidays', minLevel: 'member', minRank: 0, principals: [] });
    expect(doc.body).toBe('# Public holidays\n\nThe clinic is closed.');
  });

  it('falls back to the file name when there is neither a title nor a heading', () => {
    expect(parseKnowledgeDocument('policies/after-hours.md', 'Call the duty phone.').title).toBe('after-hours');
  });

  it('carries named principals, whatever the level says', () => {
    const doc = parseKnowledgeDocument(
      'billing.md',
      '---\ntitle: Billing\nmin_level: admin\nprincipals: [u-coordinator, svc-playbooks]\n---\n\nRates.\n',
    );
    expect(doc).toMatchObject({ minLevel: 'admin', minRank: 3, principals: ['u-coordinator', 'svc-playbooks'] });
  });

  it('refuses an unknown level, an unknown key and a malformed principal, naming the file', () => {
    expect(() => parseKnowledgeDocument('x.md', '---\nmin_level: superuser\n---\n\nhi\n')).toThrow(ConfigError);
    expect(() => parseKnowledgeDocument('x.md', '---\nmin_level: superuser\n---\n\nhi\n')).toThrow(/"x\.md"/);
    // `service` is not a document level: a service principal is named by id or not at all.
    expect(() => parseKnowledgeDocument('x.md', '---\nmin_level: service\n---\n\nhi\n')).toThrow(/min_level/);
    expect(() => parseKnowledgeDocument('x.md', '---\nlevel: lead\n---\n\nhi\n')).toThrow(/level/);
    expect(() => parseKnowledgeDocument('x.md', '---\nprincipals: [Nobody]\n---\n\nhi\n')).toThrow(/principal/);
  });

  it('refuses a document with nothing under the frontmatter', () => {
    expect(() => parseKnowledgeDocument('empty.md', '---\ntitle: Empty\n---\n\n   \n')).toThrow(/is empty/);
  });
});

describe('readKnowledgeFolder', () => {
  it('walks markdown files in path order, including subfolders, and ignores everything else', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-knowledge-'));
    await mkdir(path.join(dir, 'policies'), { recursive: true });
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, 'front-desk.md'), FRONT);
    await writeFile(path.join(dir, 'policies', 'holidays.md'), '# Public holidays\n\nClosed.\n');
    await writeFile(path.join(dir, 'notes.txt'), 'not markdown');
    await writeFile(path.join(dir, '.git', 'hidden.md'), '# Hidden\n\nno\n');
    const docs = await readKnowledgeFolder(dir);
    expect(docs.map((d) => d.path)).toEqual(['front-desk.md', 'policies/holidays.md']);
  });

  it('answers an empty list for a folder that is not there, because a client need not have one', async () => {
    expect(await readKnowledgeFolder(path.join(tmpdir(), 'harness-knowledge-nonexistent'))).toEqual([]);
  });
});
