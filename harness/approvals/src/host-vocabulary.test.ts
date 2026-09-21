import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here);

/**
 * Words that belong to one messaging surface and must not appear in the host.
 *
 * The host posts a card, replies under a message and uploads a file. Which of those is a Block
 * Kit block, a Bolt listener or a `thread_ts` is the Slack adapter's business, and a word here in
 * host source is either an identifier the next reader will copy or a comment that teaches the
 * wrong model — and both end with the second adapter needing a special case.
 *
 * `*.test.ts` is excluded because a test names what it tests: the dual-surface suite drives the
 * real Slack adapter through its fake transport and says so. `*.test-helpers.ts` is excluded for
 * the same reason and no other — `surfaces/stub-surface.test-helpers.ts` exists only to make a
 * union of two adapters' credentials a real union, and explaining why takes naming the adapter it
 * is a second to. Nothing that ships is exempt.
 *
 * **The allowlist is empty and must stay empty.** A word that has to appear belongs in
 * `surfaces/slack`, or the comment carrying it should say what the host actually means: a
 * surface, a conversation, a message, a card.
 *
 * `socket ?mode` is here since Plan 11b: the Slack adapter receives signed requests now and
 * nothing in this repository holds a vendor's connection, so a kernel that names one is a kernel
 * describing a transport it no longer has. A plain `socket` is not forbidden — the host binds
 * one — and neither is `webhook`, `signature` or `hmac`: those are HTTP, which the host is
 * allowed to know about.
 */
const FORBIDDEN = /slack|bolt|block ?kit|thread_ts|\bblocks\b|socket ?mode/i;

const ALLOWLIST: { file: string; contains: string; reason: string }[] = [];

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts') && !/\.test(-helpers)?\.ts$/.test(entry.name)) found.push(full);
  }
  return found;
}

describe('the approvals host names no messaging surface', () => {
  it('finds no Slack vocabulary in harness/approvals/src', async () => {
    const hits: string[] = [];
    const files = await sourceFiles(root);
    // A scan that reached nothing would pass silently, which is the one way this test can lie.
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      const text = await readFile(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        const match = FORBIDDEN.exec(line);
        if (!match) return;
        const exempt = ALLOWLIST.some((a) => a.file === relative && line.includes(a.contains));
        if (!exempt) hits.push(`${relative}:${i + 1}: ${match[0]} — ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('keeps the allowlist empty, because every entry is a host that still knows one transport', () => {
    expect(ALLOWLIST).toEqual([]);
  });

  it('catches the words it claims to, so an empty result means the rule ran', () => {
    for (const line of [
      "import { App } from '@slack/bolt';",
      'const blocks = approvalBlocks(row);',
      '// the Block Kit card',
      'thread_ts: row.messageRef,',
      'a Slack channel id',
      '// opened in Socket Mode',
    ]) {
      expect(FORBIDDEN.test(line), line).toBe(true);
    }
    // And the shapes it must not catch: the words the host is supposed to use.
    for (const line of [
      'await session.postCard(conversation, card);',
      'const ref: MessageRef = { surface, id };',
      'server.on("connection", (socket) => socket.destroy());',
    ]) {
      expect(FORBIDDEN.test(line), line).toBe(false);
    }
  });
});
