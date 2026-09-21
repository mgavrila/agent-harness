import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

/**
 * Words that belong to one area of the product and must not appear in the kernel.
 *
 * Spec section 8. The kernel stores records and attachments; a provider, a credential, a licence
 * and an NPI are things the healthcare pack knows about. A word here in kernel source is either
 * a schema key an agent will read, an identifier the next reader will copy, or a comment that
 * teaches the wrong model — and all three end with a second pack needing a special case.
 *
 * `npi` is the one entry that is not a plain substring. Three letters that short turn up inside
 * ordinary English and ordinary identifiers — `openPipeline` contains them — so it matches only
 * where a letter does not sit on either side. An underscore still counts as a boundary, so
 * `record_npi` is caught and `openPipeline` is not.
 */
const DOMAIN_FORBIDDEN =
  /provider|credential|licen[cs]e|(?<![A-Za-z])npi(?![A-Za-z])|nppes|malpractice|dea_number|payer|roster/i;

/**
 * Words that belong to one messaging surface and must not appear in the kernel or in a pack.
 *
 * The kernel stages an effect and a pack releases a file; which of those becomes a Block Kit
 * block, a Bolt listener or a `thread_ts` is `surfaces/slack`'s business. A word here in kernel
 * or pack source is either a schema key an agent will read, an identifier the next reader will
 * copy, or a comment that teaches the wrong model.
 *
 * `evals/src` is **not** scanned for these, deliberately: `domain/report/render.ts` and
 * `report/build.ts` both say a missing metric "blocks promotion", which is English about
 * promotion gates and has nothing to do with Block Kit. Rewording eval prose to satisfy a
 * messaging rule would be the tail wagging the dog. `harness/approvals/src` is not scanned here
 * either — it has its own copy of this rule, in `harness/approvals/src/host-vocabulary.test.ts`,
 * because a test in this package that scanned another package's source would fail in whichever
 * suite happened to run it.
 *
 * `socket[ _-]?mode` is here since Plan 11b: the Slack adapter receives signed requests now and
 * nothing in this repository holds a vendor's connection, so a kernel that names one is a kernel
 * describing a transport it no longer has. A plain `socket` is not forbidden — the host binds
 * one — and neither is `webhook`, `signature` or `hmac`: those are HTTP, which the host is
 * allowed to know about.
 */
const MESSAGING_FORBIDDEN = /slack|bolt|block ?kit|thread_ts|\bblocks\b|socket[ _-]?mode/i;

/**
 * Words that belong to one agent framework or one identity vendor and must not appear in the
 * kernel, the runtime contract, the identity contract or the evals (spec decision 20).
 * `runtimes/deepagents` is the only place the first three may live — the runtime *contract* is
 * scanned for them precisely because the plug-in beneath it is not, and the whole point of the
 * contract is that the host can hold it without holding a framework. The Entra plug-in and the
 * Teams surface are Weave's and live in `identities/entra` and `surfaces/teams` when they exist. `teams` and `entra` are
 * word-bounded: "teams" is also English, and `agreementRate` in the evals contains the five
 * letters of the other.
 */
const FRAMEWORK_FORBIDDEN = /deepagents|langchain|langgraph|\bentra\b|\bteams\b/i;

/**
 * A client's name and the agent runtime's name (spec decision 20). The kernel serves whichever
 * client `HARNESS_CLIENT` names and whichever runtime launches it; a kernel that spells either
 * is a kernel that will need a special case for the second one.
 */
const DEPLOYMENT_FORBIDDEN = /demo-practice|hermes/i;

/**
 * What is scanned for what, and what is left out of each.
 *
 * `*.test.ts` is excluded everywhere because a test names what it tests: the healthcare suites in
 * `app/pack-healthcare/` are full of credentialing words on purpose. `shared/redaction/` is
 * excluded from the credentialing scan only, because `RESTRICTED_NAME_KEYS` is a list of
 * identifier stems — `dea_number` is one of them — that the kernel keeps on purpose (spec
 * section 6); it has no such exemption from the messaging scan, and needs none.
 *
 * `runtimes/deepagents/src` is scanned for everything *but* the framework words: it is the one
 * directory in the workspace that may spell them. It is scanned for the other three lists like
 * any other package — a runtime plug-in that knew what a credential was, or what a message
 * surface was, or which client it was serving, would be the coupling the runtime contract exists
 * to remove. The `credentialing-intake` and `credentialing-roster` skill names in its tests are
 * why tests are skipped here, as they are everywhere.
 *
 * `minFiles` guards against the one way this test can lie: a scan that reached nothing passes.
 *
 * `surfaces/http/src` is scanned for all four lists, unlike the other adapters. `surfaces/slack`
 * is exempt from the messaging list because it *is* the messaging vendor; this one is a plain
 * transport that belongs to nobody, and an HTTP adapter that had learned a product area, a
 * messaging vendor or a framework would be exactly the coupling the surface contract removes.
 *
 * `harness/config-api/src` is scanned for three of the four lists and deliberately not for the
 * messaging one. The client document's schema has to name the surfaces a tenant may declare, so
 * `surfaces.slack` with its team id and its two secret references is *data the schema admits*
 * rather than a coupling — the same status `surfaces/slack` itself has, which is scanned by
 * nothing. It is scanned for the other three like any contract: a document schema that knew a
 * product area, a framework or a client's name would be the coupling this package exists to
 * remove, which is also why `runtime` is a plug-in *name* there and not a literal.
 *
 * `identities/slack-groups/src` is exempt from the messaging list for the same reason
 * `surfaces/slack` is — it *is* the vendor — and scanned for the other two like `identities/static`.
 *
 * **The allowlist is empty and must stay empty.** A word that has to appear belongs in a pack or
 * in an adapter, or the comment that carries it should say what the kernel actually means: a
 * model *vendor*, a *record*, a *file*, a *surface*. Adding an entry here is a decision to write
 * down in ARCHITECTURE.md, not a way to get a red suite green.
 */
const SCANNED = [
  {
    what: 'credentialing vocabulary',
    root: 'harness/core-tools/src',
    forbidden: DOMAIN_FORBIDDEN,
    minFiles: 10,
    skip: [/\.test\.ts$/, /\/shared\/redaction\//],
  },
  {
    what: 'credentialing vocabulary',
    root: 'evals/src',
    forbidden: DOMAIN_FORBIDDEN,
    minFiles: 10,
    skip: [/\.test\.ts$/, /\.test-helpers\.ts$/],
  },
  {
    what: 'messaging vocabulary',
    root: 'harness/core-tools/src',
    forbidden: MESSAGING_FORBIDDEN,
    minFiles: 10,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'messaging vocabulary',
    root: 'packs/healthcare/src',
    forbidden: MESSAGING_FORBIDDEN,
    minFiles: 10,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'messaging vocabulary',
    root: 'packs/stories/src',
    forbidden: MESSAGING_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'harness/core-tools/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 10,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'evals/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 10,
    skip: [/\.test\.ts$/, /\.test-helpers\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'harness/identity-api/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'identities/static/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'harness/core-tools/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 10,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'evals/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 10,
    skip: [/\.test\.ts$/, /\.test-helpers\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'harness/identity-api/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'identities/static/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'identities/slack-groups/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 2,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'identities/slack-groups/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 2,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'credentialing vocabulary',
    root: 'harness/config-api/src',
    forbidden: DOMAIN_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'harness/config-api/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'harness/config-api/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'harness/files/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 4,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'harness/runtime-api/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'harness/runtime-api/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'credentialing vocabulary',
    root: 'runtimes/deepagents/src',
    forbidden: DOMAIN_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'messaging vocabulary',
    root: 'runtimes/deepagents/src',
    forbidden: MESSAGING_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'runtimes/deepagents/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'credentialing vocabulary',
    root: 'surfaces/http/src',
    forbidden: DOMAIN_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'messaging vocabulary',
    root: 'surfaces/http/src',
    forbidden: MESSAGING_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'surfaces/http/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'surfaces/http/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'harness/files/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 4,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'credentialing vocabulary',
    root: 'harness/host/src',
    forbidden: DOMAIN_FORBIDDEN,
    minFiles: 8,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'messaging vocabulary',
    root: 'harness/host/src',
    forbidden: MESSAGING_FORBIDDEN,
    minFiles: 8,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'harness/host/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 8,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'harness/host/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 8,
    skip: [/\.test\.ts$/],
  },
];

/**
 * Lines exempted by name, with the reason. Empty, and the one candidate that was expected to be
 * here is worth recording: `RELEASE_KEY_PREFIX` in `domain/files/release.ts` is a legacy
 * idempotency prefix that cannot be renamed without breaking deduplication across an upgrade,
 * but its value is `forms_release:`, which carries none of the words above — so it needs no
 * exemption and the list stays empty.
 */
const ALLOWLIST: { file: string; contains: string; reason: string }[] = [];

async function sourceFiles(dir: string, skip: RegExp[]): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full, skip)));
    else if (entry.name.endsWith('.ts')) found.push(full);
  }
  return found.filter((file) => !skip.some((pattern) => pattern.test(file.split(path.sep).join('/'))));
}

describe('the kernel, the packs, the identity contract and the evals name no area of the product, no surface and no framework', () => {
  for (const { what, root, forbidden, minFiles, skip } of SCANNED) {
    it(`finds no ${what} in ${root}`, async () => {
      const hits: string[] = [];
      const files = await sourceFiles(path.join(repoRoot, root), skip);
      // A scan that reached nothing would pass silently, which is the one way this test can lie.
      expect(files.length).toBeGreaterThanOrEqual(minFiles);
      for (const file of files) {
        const relative = path.relative(repoRoot, file).split(path.sep).join('/');
        const text = await readFile(file, 'utf8');
        text.split('\n').forEach((line, i) => {
          const match = forbidden.exec(line);
          if (!match) return;
          const exempt = ALLOWLIST.some((a) => a.file === relative && line.includes(a.contains));
          if (!exempt) hits.push(`${relative}:${i + 1}: ${match[0]} — ${line.trim()}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }

  it('keeps the allowlist empty, because every entry is a kernel that still knows about a pack', () => {
    expect(ALLOWLIST).toEqual([]);
  });

  it('catches the words it claims to, so an empty result means the rule ran', () => {
    // Each regex, checked against what it is for. Without this, a typo that made one of them
    // match nothing would turn the scans above into assertions that always pass.
    for (const line of [
      'const providerId = 1;',
      '/** the credential this evidences */',
      'incoming/license.pdf',
      'a licence number',
      '// the NPI is ten digits',
      "const key = 'record_npi';",
      'VERIFY_NPPES_ENABLED',
      'malpractice carrier',
      "fields.name === 'dea_number'",
      'the payer roster',
    ]) {
      expect(DOMAIN_FORBIDDEN.test(line), line).toBe(true);
    }
    // And the two shapes it must not catch: an ordinary identifier that happens to contain the
    // three letters of `npi`, and a word the kernel legitimately uses.
    for (const line of ['await openPipeline(opts);', 'const record = await readRecord(deps, id);']) {
      expect(DOMAIN_FORBIDDEN.test(line), line).toBe(false);
    }
    for (const line of [
      "import { App } from '@slack/bolt';",
      'sink: `slack_message`,',
      '// the Block Kit card',
      'thread_ts: row.messageRef,',
      'const blocks = cardBlocks(card);',
      // All four ways the transport's name is written: a space, a hyphen, an underscore and
      // nothing at all. The hyphen is the npm package's own spelling and the likeliest re-entry,
      // and none of these four lines carries another forbidden word to pass on.
      '// opened in Socket Mode',
      '// the old socket-mode client',
      'const socket_mode = false;',
      'if (socketMode) return;',
    ]) {
      expect(MESSAGING_FORBIDDEN.test(line), line).toBe(true);
    }
    // And the shapes it must not catch: an ordinary identifier, the words the kernel uses, and a
    // plain socket — the host binds one, and what is forbidden is the transport's own mode.
    for (const line of [
      'const prompt = dataBlockSystemPrompt(role);',
      "sink: 'surface_message',",
      'server.on("connection", (socket) => socket.destroy());',
    ]) {
      expect(MESSAGING_FORBIDDEN.test(line), line).toBe(false);
    }
    for (const line of [
      "import { createDeepAgent } from 'deepagents';",
      "import { ChatOpenAI } from '@langchain/openai';",
      'const saver = new LangGraphPostgresSaver();',
      '// resolved through Entra ID',
      'a Teams activity id',
    ]) {
      expect(FRAMEWORK_FORBIDDEN.test(line), line).toBe(true);
    }
    // And the two shapes it must not catch: an identifier that happens to contain "teams",
    // and the evals' `agreementRate`, which contains the letters of "entra".
    for (const line of ['const teamsize = 3;', 'agreementRate: number;']) {
      expect(FRAMEWORK_FORBIDDEN.test(line), line).toBe(false);
    }
    for (const line of ['HARNESS_CLIENT: demo-practice', '// Hermes starts one process per session']) {
      expect(DEPLOYMENT_FORBIDDEN.test(line), line).toBe(true);
    }
  });
});
