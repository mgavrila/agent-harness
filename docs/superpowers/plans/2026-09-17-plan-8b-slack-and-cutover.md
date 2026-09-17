# Plan 8b: Slack and cutover — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a human on Slack in front of the host built in Plan 8a and switch Hermes off. The Slack adapter delivers messages, mentions and attachments as `MessageEvent`s and streams replies through message edits at a bounded rate; one Slack app carries chat and approvals; Hermes, `hermes-init`, its image, its config, its cron scripts and its watchdogs go; Compose takes its final shape for this series; the client folder is `SOUL.md`, `identity.yaml`, `policy.yaml`, `routing.yaml`; the scaffolder and the docs follow.

**Architecture:** Four moves. (1) **Inbound Slack.** Bolt `message` and `app_mention` listeners become `SlackInbound` records; the transport downloads each attached file into `<storageDir>/incoming/` with the bot token; the session turns them into `MessageEvent`s with `mentioned` set for a mention or a direct message. `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` are the one app; `APPROVALS_SLACK_*` are retired. (2) **Streaming Slack.** `startStream` posts one message on the first delta and edits it at most every 1.5 seconds with the accumulated text, then once more on `end`; `capabilities.streaming: true`. (3) **Cutover.** The `hermes` and `hermes-init` services, `hermes.Dockerfile`, `clients/demo-practice/hermes.config.yaml`, `cron/` and `scripts/`, `svc-hermes`, the `HERMES_*` and `SLACK_HOME_*` variables and the `demo:playbooks` script are deleted; the storage volume's `incoming/` and `out/` directories are created and owned by the image rather than by an init container; the host gets the Slack tokens; the compose snapshot moves once. (4) **Scaffolder and docs.** The template list is the four-file client folder; the runbook says playbooks return in Plan 9.

**Tech Stack:** as Plan 8a. No new dependency: `@slack/bolt@^5.1.0` and `@slack/web-api@^8.1.1` are already in `surfaces/slack`.

**Spec:** `docs/superpowers/specs/2026-09-17-kernel-design.md` — this plan and `2026-09-17-plan-8a-runtime-and-host.md` together are the row "8 Runtime and host" of its section 10. This half implements the Slack half of section 4.3 ("one Slack app carries chat and approvals", attachments in `<storageDir>/incoming/`, streaming), decision 10, the Compose shape of section 7 for Plan 8 (`postgres`, `litellm`, `files`, `host`, `core-tools` build-only), and the exit criterion "a human talks to the agent in Slack through the host; an approval decided in Slack resumes the thread". It starts from Plan 8a's last commit.

## Global Constraints

Every task's requirements implicitly include this section, and every constraint of Plan 8a's Global Constraints holds here unchanged (gates, migrations, env documentation, dependency-cruiser rows, vocabulary, commit messages, TDD, no Compose up/down, no push).

- **Snapshots.** The tool-surface snapshot does not change in this plan. The compose snapshot changes in **Task 3 only**, which re-records it and describes the diff in the commit.
- **Environment variables.** This plan removes `APPROVALS_SLACK_BOT_TOKEN`, `APPROVALS_SLACK_APP_TOKEN`, `SLACK_HOME_CHANNEL`, `SLACK_HOME_CHANNEL_NAME`, `HERMES_UID` and `HERMES_GID` from `.env.example` (Tasks 1 and 3) and adds none. `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` and `SLACK_APPROVALS_CHANNEL` stay.
- **Vocabulary.** `hermes` stays a forbidden word in the kernel, the host and the runtime; after Task 3 it appears nowhere in shipping source or Compose, and only in the specs and plans under `docs/superpowers/` and in the runbook's one sentence saying it was retired.
- **No real Slack call in any test.** The adapter's transport is behind `SlackTransport`; every test drives `FakeSlack`/`FakeSlackEvents` and a fake `fetch`.
- **Deployability inside this plan.** Hermes serves Slack chat until Task 3 deletes it; from Task 3 the host does, on the one app. CI's image build (`--profile demo --profile build-only`) stays green at every commit.

---

## Facts verified for this plan

Read out of the worktree on 2026-09-17, after the Plan 8a plan was written; file names and identifiers, never line numbers.

| Fact | Value | Where |
|---|---|---|
| The Slack SDK versions in the adapter | `@slack/bolt 5.1.0`, `@slack/web-api 8.1.1`, `@slack/types 3.1.0` | `surfaces/slack/node_modules/*/package.json` |
| `GenericMessageEvent` | `type: 'message'; subtype: undefined; channel; user; text?; ts; thread_ts?; channel_type: ChannelTypes; files?: File[]; bot_id?` | `@slack/types/dist/events/message.d.ts` |
| `FileShareMessageEvent` | `subtype: 'file_share'; text; files?: File[]; user; ts; thread_ts?; channel; channel_type` | same |
| `AppMentionEvent` | `type: 'app_mention'; user?; text; ts; channel; thread_ts?; bot_id?` | `@slack/types/dist/events/app.d.ts` |
| A shared file carries `url_private_download` and `name` | `url_private?: string; url_private_download?: string` on the `File` shape | `@slack/types/dist/events/message.d.ts` |
| Bolt registers event listeners by name and sets the bot's user id on the context | `app.event(eventName, ...listeners)`; `context.botUserId?: string` | `@slack/bolt/dist/App.d.ts`, `dist/types/middleware.d.ts` |
| The Web API has native text streaming | `chat.startStream`, `chat.appendStream`, `chat.stopStream`; `startStream` takes `channel`, `thread_ts`, `markdown_text`/`chunks`, `recipient_user_id`, `recipient_team_id` ("required when starting a streaming conversation outside of a DM") | `@slack/web-api/dist/methods.d.ts`, `types/request/chat.d.ts`; decision 2 |
| `SlackApi` (the slice the adapter fakes) has `chat.postMessage`, `chat.update`, `chat.postEphemeral`, `files.uploadV2`, `views.open` | | `surfaces/slack/src/transport/types.ts` |
| `FakeSlack` mints `ts` values `1789000000.000001`… and records `posts`, `updates` | | `surfaces/slack/src/transport/fake.ts` |
| `hermes-init`'s jobs today | copies `SOUL.md`, `config.yaml`, `cron/`, `scripts/` into the Hermes volume; strips `APPROVALS_SLACK_*` from a copied `.env`; **creates `<storage>/out` and `<storage>/incoming` and chowns the storage volume to `HERMES_UID:HERMES_GID` (1000:1000)**, because a fresh named volume is root-owned and neither image has content at that path | `harness/compose/docker-compose.yml`, the `hermes-init` command |
| Both Node images run as the base image's `node` user (uid 1000) | `USER node` | `harness/compose/node.Dockerfile`, `files.Dockerfile` |
| Docker seeds a fresh named volume from the image's content at the mount path, ownership included | Docker's documented behaviour for named volumes mounted over a non-empty image directory | decision 4 |
| `SOUL.md` rule 9 names Hermes's cache directory | "Hermes saves each attachment as `/opt/data/cache/documents/<file name>` … Pass `incoming/<file name>` to `documents_ingest`" | `clients/demo-practice/SOUL.md` |
| The scaffolder copies a fixed list and every `scripts/*.sh` | `TEMPLATE_FILES = ['SOUL.md', 'hermes.config.yaml', 'policy.yaml', 'identity.yaml', '.env.example', 'routing.yaml', 'cron/playbooks.sh']`, `SCRIPT_DIR = 'scripts'`; its test scaffolds those files and pins the copied list; the CLI's "Next" text names two Slack apps | `scripts/src/domain/scaffold.ts`, `scaffold.test.ts`, `scripts/src/app/cli.ts` |
| CI builds every image with two profiles and copies `.env.ci` to `.env` for the Hermes `env_file` | | `.github/workflows/ci.yml` |
| The demo smoke checklist names `hermes`, `hermes-init`, `hermes cron list`, and the two-token check | | `docs/demo.md` |
| The runbook's Slack section is "two apps are required"; "Playbooks" documents the Hermes cron fleet | | `docs/runbook.md` |
| `.env.example`'s Slack block documents two apps, `SLACK_HOME_CHANNEL`, `SLACK_HOME_CHANNEL_NAME`, and a Hermes container block with `HERMES_UID`/`HERMES_GID` | | `.env.example` |
| After Plan 8a the Slack session stores an `onMessage` handler on `SlackEvents` that Bolt does not feed, declares `streaming: false`, and `SlackInbound` is `{ userId, channel, text, ts, threadTs, mentioned, files: { name, url }[] }` | | Plan 8a Task 5 |
| After Plan 8a the host's Compose service is `host` and still reads `APPROVALS_SLACK_*` | | Plan 8a Task 9 |

---

## Decisions where the spec leaves a detail open

1. **`message` and `app_mention` both subscribed, delivered exactly once.** A channel message that mentions the bot arrives as both events when the bot is a member of the channel, and only as `app_mention` when it is not. The transport drops a `message` whose text contains `<@botUserId>` (the `app_mention` carries it) and handles `app_mention` as `mentioned: true`; a `message` in a direct message (`channel_type === 'im'`) is `mentioned: true`; any other `message` is `mentioned: false` and the host ignores it. Messages with a `bot_id`, and subtypes other than `file_share` (`message_changed`, `message_deleted`, `bot_message`, joins), are dropped. The mention token is stripped from the text.
2. **Streaming is `chat.postMessage` + `chat.update`, not the native streaming API.** `chat.startStream` exists in the installed SDK but wants a recipient user and team outside a direct message and is a newer surface this repository cannot exercise against Slack from a test. Edits are the well-trodden path and use the two calls the adapter already fakes. A `StreamHandle` posts the first delta as a message, then edits it at most once every `STREAM_EDIT_INTERVAL_MS = 1500` (Slack's `chat.update` tier allows ~50/min; one edit per 1.5 s per stream is well under it) with the accumulated text, and `end()` edits once more with the final text and resolves to that message's reference. `capabilities.streaming: true`. The native API is the upgrade path, noted in the adapter's README.
3. **Attachments are downloaded by the transport with the bot token into `<storageDir>/incoming/<ts>-<safe name>`.** `SlackDeps.storageDir` is the storage root; the file lands at `incoming/<ts with the dot replaced by a dash>-<name with anything outside [A-Za-z0-9._-] replaced by _>`, checked with `assertInsideRoot` before writing, and the `MessageEvent.attachments[].path` is that name relative to `incoming/`. A download that fails is logged and the attachment is dropped from the event; the message still runs. `documents_ingest` is idempotent by hash, so a re-shared file costs nothing.
4. **The storage volume's layout comes from the image, not an init container.** Both `node.Dockerfile` and `files.Dockerfile` gain `RUN mkdir -p /srv/harness-storage/incoming /srv/harness-storage/out && chown -R node:node /srv/harness-storage`; Docker seeds a fresh named volume from that directory, ownership included, whichever container mounts it first. An existing deployment's volume was chowned to 1000:1000 by `hermes-init` already and needs nothing. The host also `mkdir -p`s both directories at startup as a belt to the braces.
5. **`svc-hermes` goes; the two humans' Slack ids are still placeholders.** `identity.yaml` keeps `u-practice-manager`, `u-coordinator`, `svc-host`, `svc-local`; the operator replaces `U0123ABCD`/`U0456EFGH` with real member ids (the runbook's onboarding step says how to read one).
6. **The scaffolder's template list is the four files plus `.env.example`.** `['SOUL.md', 'identity.yaml', 'policy.yaml', 'routing.yaml', '.env.example']`; `SCRIPT_DIR` and the executable-bit code go; `routing.yaml` is no longer "skipped when absent" — it is required, like the others, and the `skipped` list stays for a template that lacks a file. The CLI's "Next" text names one Slack app.
7. **`SOUL.md` rule 9 becomes surface-neutral.** "Files a human attaches are already in the store. The message lists each one as `incoming/<name>`; pass that path to `documents_ingest`, never invent one and never pass an absolute one."
8. **Playbooks are gone until Plan 9.** The nightly expirations job, the two watchdogs and `pnpm demo:playbooks` are deleted with the Hermes cron fleet; the runbook's "Playbooks" section says so and points at Plan 9's scheduler. The `credentialing-expirations` skill stays in the pack (a human can ask for it).

---

## File structure

| Task | Files |
|---|---|
| 1 Inbound Slack | `surfaces/slack/src/config.ts`, `index.ts`, `session.ts`, `testing.ts`, `transport/types.ts`, `transport/bolt.ts`, `transport/fake.ts`, `transport/files.ts` (new) + `files.test.ts`, `session.test.ts`, `index.test.ts`, `README.md`; `.env.example` |
| 2 Streaming Slack | `surfaces/slack/src/session.ts`, `stream.ts` (new) + `stream.test.ts`, `session.test.ts`, `README.md` |
| 3 Cutover | `harness/compose/docker-compose.yml`, `node.Dockerfile`, `files.Dockerfile`, `hermes.Dockerfile` (deleted), `docs/architecture/compose-surface.yaml`, `harness/core-tools/src/app/surface.test.ts`, `harness/host/src/app/main.ts`, `clients/demo-practice/hermes.config.yaml` (deleted), `cron/` (deleted), `scripts/` (deleted), `SOUL.md`, `identity.yaml`, `.env.example`, root `.env.example`, root `package.json`, `.github/workflows/ci.yml`, `scripts/src/domain/scaffold.ts` + test, `scripts/src/app/cli.ts` |
| 4 Docs | `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `docs/runbook.md`, `docs/demo.md`, `surfaces/slack/README.md`, `harness/host/README.md`, `docs/architecture/graph.svg` |

## Task order

Strictly sequential: Task 1 before Task 2 (streaming edits the session Task 1 rewrote); Task 2 before Task 3 (the cutover switches the host to the one app that Task 1 made the adapter read); Task 4 last.

---

## Tasks

### Task 1: Inbound Slack — one app, messages, mentions and attachments

The Slack adapter delivers what a human writes. Bolt `message` and `app_mention` listeners
narrow the payloads to `SlackInbound`, the transport downloads attached files into the storage
root's `incoming/` with the bot token, and the session hands the host a `MessageEvent` with
`mentioned` set for a mention or a direct message (Plan 8b decision 1). The adapter reads
`SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`: the one app.

**Files:**
- Modify: `surfaces/slack/src/config.ts`, `index.ts`, `index.test.ts`, `session.ts`, `session.test.ts`, `testing.ts`, `transport/types.ts`, `transport/bolt.ts`, `transport/fake.ts`, `README.md`
- Create: `surfaces/slack/src/transport/files.ts`, `files.test.ts`, `transport/bolt.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `MessageEvent`, `SurfaceDeps` from `@harness/surface-api`; `assertInsideRoot`, `createLogger` from `@harness/shared`.
- Produces:

  ```ts
  // transport/types.ts
  interface SlackInbound { userId: string; channel: string; text: string; ts: string; threadTs: string | null; mentioned: boolean; files: { name: string; path: string }[] }  // path relative to <storageDir>/incoming
  // transport/files.ts
  interface SlackFile { name: string; url: string }
  interface DownloadDeps { token: string; storageDir: string; fetch?: typeof fetch; log: Logger }
  function attachmentPath(ts: string, name: string): string                         // '<ts with . -> ->-<safe name>'
  function downloadAttachments(ts: string, files: readonly SlackFile[], deps: DownloadDeps): Promise<{ name: string; path: string }[]>
  // transport/bolt.ts
  function classifyMessage(event: RawMessage, botUserId: string | undefined): { userId: string; text: string; mentioned: boolean; files: SlackFile[] } | null   // null = drop
  // config.ts
  interface SlackConfig { botToken: string; appToken: string; defaultConversation: string }   // read from SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_APPROVALS_CHANNEL
  // testing.ts
  fakeSlackSession(over?: Partial<SlackConfig>, opts?: { storageDir?: string }): { session; api; events }
  ```

---

- [ ] **Step 1: Write the failing tests for the download and the classification**

Create `surfaces/slack/src/transport/files.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentPath, downloadAttachments } from './files.js';

let storageDir: string;
const log = { info() {}, warn() {}, error() {} };
beforeEach(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'harness-slack-files-'));
});
afterEach(() => rm(storageDir, { recursive: true, force: true }));

const fakeFetch = (bodies: Record<string, string | number>) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const key = String(url);
    const body = bodies[key];
    if (typeof body === 'number') return new Response('nope', { status: body });
    return new Response(body, { status: 200, headers: { 'x-auth': String((init?.headers as Record<string, string>)?.authorization) } });
  }) as typeof fetch;

describe('attachmentPath', () => {
  it('prefixes the message timestamp and neutralises the file name', () => {
    expect(attachmentPath('1789000000.000001', 'Dr Reyes licence (2026).pdf')).toBe('1789000000-000001-Dr_Reyes_licence__2026_.pdf');
    expect(attachmentPath('1.2', '../../etc/passwd')).toBe('1-2-.._.._etc_passwd');
  });
});

describe('downloadAttachments', () => {
  it('writes each file under incoming/ with the bot token and returns paths relative to incoming', async () => {
    const fetch = fakeFetch({ 'https://files.slack.com/a': 'PDF-A', 'https://files.slack.com/b': 'PDF-B' });
    const out = await downloadAttachments('1789000000.000001', [{ name: 'a.pdf', url: 'https://files.slack.com/a' }, { name: 'b.pdf', url: 'https://files.slack.com/b' }], { token: 'xoxb-test', storageDir, fetch, log });
    expect(out).toEqual([
      { name: 'a.pdf', path: '1789000000-000001-a.pdf' },
      { name: 'b.pdf', path: '1789000000-000001-b.pdf' },
    ]);
    expect(await readFile(path.join(storageDir, 'incoming', '1789000000-000001-a.pdf'), 'utf8')).toBe('PDF-A');
  });

  it('sends the bot token as a bearer', async () => {
    let seen: string | undefined;
    const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = (init?.headers as Record<string, string>).authorization;
      return new Response('x');
    }) as typeof fetch;
    await downloadAttachments('1.1', [{ name: 'x', url: 'https://files.slack.com/x' }], { token: 'xoxb-test', storageDir, fetch, log });
    expect(seen).toBe('Bearer xoxb-test');
  });

  it('drops a file whose download fails, logs it, and keeps the others', async () => {
    const warned: string[] = [];
    const fetch = fakeFetch({ 'https://files.slack.com/ok': 'fine', 'https://files.slack.com/bad': 500 });
    const out = await downloadAttachments('1.1', [{ name: 'bad.pdf', url: 'https://files.slack.com/bad' }, { name: 'ok.pdf', url: 'https://files.slack.com/ok' }], { token: 't', storageDir, fetch, log: { ...log, warn: (m: string) => warned.push(m) } });
    expect(out).toEqual([{ name: 'ok.pdf', path: '1-1-ok.pdf' }]);
    expect(warned[0]).toContain('bad.pdf');
    expect(warned[0]).not.toContain('files.slack.com');
  });
});
```

Add to `surfaces/slack/src/session.test.ts` a `describe('inbound messages')` block (the fake transport's `emitMessage` comes from Plan 8a Task 5):

```ts
describe('inbound messages', () => {
  it('delivers a mention as a MessageEvent that names the surface and the message', async () => {
    const { session, events } = fakeSlackSession();
    const seen: MessageEvent[] = [];
    session.onMessage(async (e) => {
      seen.push(e);
    });
    await events.emitMessage({ userId: 'U012', channel: 'C0DEMO', text: 'file these', ts: '1789000000.000001', threadTs: null, mentioned: true, files: [{ name: 'w9.pdf', path: '1789000000-000001-w9.pdf' }] });
    expect(seen).toEqual([
      {
        surface: 'slack',
        userId: 'U012',
        conversation: 'C0DEMO',
        text: 'file these',
        attachments: [{ name: 'w9.pdf', path: '1789000000-000001-w9.pdf' }],
        message: { surface: 'slack', conversation: 'C0DEMO', id: '1789000000.000001' },
        mentioned: true,
      },
    ]);
  });
});
```

and, in `transport/bolt.test.ts` (new; `classifyMessage` is a pure function, so Bolt itself is never constructed):

```ts
import { describe, expect, it } from 'vitest';
import { classifyMessage } from './bolt.js';

const BOT = 'UBOT';

describe('classifyMessage', () => {
  it('takes a direct message as addressed', () => {
    expect(classifyMessage({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U012', text: 'hi', ts: '1.1' }, BOT)).toEqual({ userId: 'U012', text: 'hi', mentioned: true, files: [] });
  });

  it('takes a channel message as not addressed, and drops one that mentions the bot (app_mention carries it)', () => {
    expect(classifyMessage({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U012', text: 'chatter', ts: '1.1' }, BOT)).toMatchObject({ mentioned: false });
    expect(classifyMessage({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U012', text: `<@${BOT}> hi`, ts: '1.1' }, BOT)).toBeNull();
  });

  it('takes an app_mention as addressed with the mention stripped', () => {
    expect(classifyMessage({ type: 'app_mention', channel: 'C1', user: 'U012', text: `<@${BOT}> file these`, ts: '1.1' }, BOT)).toEqual({ userId: 'U012', text: 'file these', mentioned: true, files: [] });
  });

  it('drops bot messages and every subtype but file_share, and keeps a file share with its files', () => {
    expect(classifyMessage({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U012', bot_id: 'B1', text: 'x', ts: '1.1' }, BOT)).toBeNull();
    expect(classifyMessage({ type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel', ts: '1.1' }, BOT)).toBeNull();
    expect(
      classifyMessage({ type: 'message', subtype: 'file_share', channel: 'D1', channel_type: 'im', user: 'U012', text: '', ts: '1.1', files: [{ name: 'w9.pdf', url_private_download: 'https://files.slack.com/w9' }] }, BOT),
    ).toEqual({ userId: 'U012', text: '', mentioned: true, files: [{ name: 'w9.pdf', url: 'https://files.slack.com/w9' }] });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @harness/surface-slack test`
Expected: FAIL — `./files.js` missing, `classifyMessage` not exported, the session test's `attachments` shape wrong.

- [ ] **Step 3: Write the download module**

Create `surfaces/slack/src/transport/files.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertInsideRoot, type Logger } from '@harness/shared';

export interface SlackFile {
  name: string;
  url: string;
}

export interface DownloadDeps {
  token: string;
  /** The storage root; files land under its `incoming/`. */
  storageDir: string;
  fetch?: typeof fetch;
  log: Logger;
}

/**
 * Where an attachment lands, relative to `incoming/`: the message timestamp (dot to dash, so the
 * name has one dot at most) and the file name with everything outside `[A-Za-z0-9._-]` replaced.
 * Two messages cannot share a `ts`, and `documents_ingest` is idempotent by content, so a file
 * shared twice is stored twice and ingested once.
 */
export function attachmentPath(ts: string, name: string): string {
  return `${ts.replace('.', '-')}-${name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

/**
 * Fetch each file with the bot token into `<storageDir>/incoming/`. A failure drops that one
 * file and warns with its name only: the URL is a signed private link and the message is a log
 * line. The target is checked against the storage root before anything is written.
 */
export async function downloadAttachments(
  ts: string,
  files: readonly SlackFile[],
  deps: DownloadDeps,
): Promise<{ name: string; path: string }[]> {
  const doFetch = deps.fetch ?? fetch;
  const incoming = path.join(deps.storageDir, 'incoming');
  await mkdir(incoming, { recursive: true });
  const out: { name: string; path: string }[] = [];
  for (const file of files) {
    const relative = attachmentPath(ts, file.name);
    try {
      const target = await assertInsideRoot(relative, incoming, () => {
        throw new Error('attachment path escapes the incoming directory');
      });
      const res = await doFetch(file.url, { headers: { authorization: `Bearer ${deps.token}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await writeFile(target, Buffer.from(await res.arrayBuffer()));
      out.push({ name: file.name, path: relative });
    } catch (err) {
      deps.log.warn(`slack: could not save attachment "${file.name}" (${err instanceof Error ? err.message : 'error'}); it is left out of the message`);
    }
  }
  return out;
}
```

- [ ] **Step 4: Rewrite the transport types, the Bolt listeners, the fake, the config and the session**

`transport/types.ts`: `SlackInbound.files` becomes `{ name: string; path: string }[]` (already downloaded). Add the raw event shape the classifier reads:

```ts
/** The fields of a Bolt `message` or `app_mention` payload the classifier reads. */
export interface RawMessage {
  type: 'message' | 'app_mention';
  subtype?: string;
  channel: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: { name?: string; url_private_download?: string }[];
}
```

`transport/bolt.ts` — add, above `boltTransport`:

```ts
/**
 * What an inbound payload means, or null to drop it (decision 1 of Plan 8b).
 *
 * `app_mention` is the one event that says the assistant was addressed in a channel; a `message`
 * that carries the mention is the same message arriving a second time (when the bot is a member)
 * and is dropped. A direct message is addressed by construction. Bots, edits, deletions and joins
 * are not messages from a person; a `file_share` is.
 */
export function classifyMessage(
  event: RawMessage,
  botUserId: string | undefined,
): { userId: string; text: string; mentioned: boolean; files: SlackFile[] } | null {
  if (event.bot_id || !event.user) return null;
  const mention = botUserId ? `<@${botUserId}>` : null;
  const text = event.text ?? '';
  const files = (event.files ?? [])
    .filter((f): f is { name: string; url_private_download: string } => typeof f.name === 'string' && typeof f.url_private_download === 'string')
    .map((f) => ({ name: f.name, url: f.url_private_download }));
  if (event.type === 'app_mention') {
    return { userId: event.user, text: mention ? text.replaceAll(mention, '').trim() : text.trim(), mentioned: true, files };
  }
  if (event.subtype !== undefined && event.subtype !== 'file_share') return null;
  if (mention && text.includes(mention)) return null;
  return { userId: event.user, text: text.trim(), mentioned: event.channel_type === 'im', files };
}
```

and inside `boltTransport(config, log, storageDir)` (the new third argument) a `messageHandler` slot fed by two listeners:

```ts
  const deliver = async (raw: RawMessage, botUserId: string | undefined): Promise<void> => {
    if (!messageHandler) {
      log.warn('a Slack message arrived before a handler was registered');
      return;
    }
    const classified = classifyMessage(raw, botUserId);
    if (!classified) return;
    const files = await downloadAttachments(raw.ts, classified.files, { token: config.botToken, storageDir, log });
    await messageHandler({
      userId: classified.userId,
      channel: raw.channel,
      text: classified.text,
      ts: raw.ts,
      threadTs: raw.thread_ts ?? null,
      mentioned: classified.mentioned,
      files,
    });
  };
  bolt.event('message', async ({ event, context }) => deliver(event as unknown as RawMessage, context.botUserId));
  bolt.event('app_mention', async ({ event, context }) => deliver(event as unknown as RawMessage, context.botUserId));
```

Rewrite the transport's header comment: one app now carries chat and approvals, because one process holds both connections; the "two apps" reasoning is gone with the second process. `transport/fake.ts`: `emitMessage(message: SlackInbound)` stays; nothing else changes. `config.ts`:

```ts
export interface SlackConfig {
  botToken: string;
  appToken: string;
  /** Where approval cards go: a channel id. */
  defaultConversation: string;
}

/** Read this adapter's configuration off the environment the host handed over. One app: chat and approvals share it. */
export function slackConfig(env: EnvSource): SlackConfig {
  return {
    botToken: requiredEnv('SLACK_BOT_TOKEN', ' (the Slack app the host connects as; see docs/runbook.md)', env),
    appToken: requiredEnv('SLACK_APP_TOKEN', ' (Socket Mode app-level token; see docs/runbook.md)', env),
    defaultConversation: requiredEnv('SLACK_APPROVALS_CHANNEL', '', env),
  };
}
```

`index.ts`: `secrets: ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']`, `connect: (deps) => Promise.resolve(createSlackSession(boltTransport(config, deps.log, deps.storageDir), config))`, and the comment: the two tokens are the one app's. `index.test.ts` expects the two secrets. `session.ts`'s `onMessage` maps `message.files` straight to `attachments` (name and path). `testing.ts`'s `fakeSlackSession` config drops nothing more (the allowlist went in Plan 8a).

- [ ] **Step 5: Retire the second app in `.env.example`**

Replace the whole `# --- Slack adapter` block with:

```
# --- Slack adapter (@harness/surface-slack) ---
# ONE Slack app, in Socket Mode, with Interactivity on. Bot scopes: chat:write, app_mentions:read,
# channels:history, groups:history, im:history, im:read, im:write, mpim:history, users:read,
# files:read, files:write. Subscribe the app to the message.channels, message.groups, message.im,
# message.mpim and app_mention events. Invite the bot to the channels it should answer in.
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
# Channel the host posts approval cards and released files into (a channel id, e.g. C0123456789).
SLACK_APPROVALS_CHANNEL=
```

(`SLACK_HOME_CHANNEL` and `SLACK_HOME_CHANNEL_NAME` are Hermes's and go in Task 3 with the rest of the Hermes block; leave them for now so Hermes keeps starting.) In `clients/demo-practice/.env.example` make the same replacement.

- [ ] **Step 6: Run the adapter suite green, the gates, commit**

Run: `pnpm --filter @harness/surface-slack test`, then `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`.
Expected: all green. The env scan passes: `APPROVALS_SLACK_*` are no longer read by any source (the `.env.example` lines may go now; Compose still interpolates them into the `host` service until Task 3, which is fine — the compose check compares the rendered file with the recorded one, and neither has moved). Both snapshots unchanged.

Update `surfaces/slack/README.md`: one app, the scopes and event subscriptions, the inbound flow, `incoming/`, the mention rule.

```bash
git add surfaces/slack .env.example clients/demo-practice/.env.example
git commit -m "feat(surface-slack): deliver messages, mentions and attachments from one Slack app"
```

### Task 2: Streaming replies on Slack

`startStream` over the two calls the adapter already makes: the first delta posts a message,
later deltas edit it at a bounded rate, `end` edits once more with the whole text and returns
the message's reference (decision 2). `capabilities.streaming` becomes true, so the host streams
on Slack instead of posting once at `done`.

**Files:**
- Create: `surfaces/slack/src/stream.ts`, `stream.test.ts`
- Modify: `surfaces/slack/src/session.ts`, `session.test.ts`, `README.md`

**Interfaces:**
- Produces:

  ```ts
  // stream.ts
  const STREAM_EDIT_INTERVAL_MS = 1500
  interface StreamDeps { api: SlackApi; conversation: string; threadTs?: string; now?: () => number; setTimeout?: typeof setTimeout }
  function createEditStream(deps: StreamDeps): StreamHandle
  ```

---

- [ ] **Step 1: Write the failing stream test**

Create `surfaces/slack/src/stream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { STREAM_EDIT_INTERVAL_MS, createEditStream } from './stream.js';
import { FakeSlack } from './transport/fake.js';

/** A clock and a timer the test advances by hand. */
function clock() {
  let at = 0;
  const timers: { due: number; fn: () => void }[] = [];
  return {
    now: () => at,
    setTimeout: ((fn: () => void, ms: number) => {
      timers.push({ due: at + ms, fn });
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout,
    async advance(ms: number) {
      at += ms;
      for (const t of timers.splice(0).filter((t) => t.due <= at)) t.fn();
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('createEditStream', () => {
  it('posts the first delta as a message, edits with the accumulated text no more than once per interval, and ends with a final edit', async () => {
    const api = new FakeSlack();
    const c = clock();
    const stream = createEditStream({ api, conversation: 'C0DEMO', now: c.now, setTimeout: c.setTimeout });
    stream.append('Hel');
    await c.advance(0);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0]).toMatchObject({ channel: 'C0DEMO', text: 'Hel' });
    stream.append('lo ');
    stream.append('there');
    await c.advance(100);
    expect(api.updates).toHaveLength(0);
    await c.advance(STREAM_EDIT_INTERVAL_MS);
    expect(api.updates).toHaveLength(1);
    expect(api.updates[0]).toMatchObject({ channel: 'C0DEMO', ts: api.posts[0].ts ?? '1789000000.000001', text: 'Hello there' });
    stream.append('!');
    const ref = await stream.end();
    expect(api.updates.at(-1)).toMatchObject({ text: 'Hello there!' });
    expect(ref).toEqual({ surface: 'slack', conversation: 'C0DEMO', id: '1789000000.000001' });
  });

  it('replies in the thread it was asked to', async () => {
    const api = new FakeSlack();
    const stream = createEditStream({ api, conversation: 'C0DEMO', threadTs: '1700000000.000100' });
    stream.append('x');
    await stream.end();
    expect(api.posts[0].thread_ts).toBe('1700000000.000100');
  });

  it('posts nothing for an empty stream and still returns a reference-less end', async () => {
    const api = new FakeSlack();
    const stream = createEditStream({ api, conversation: 'C0DEMO' });
    const ref = await stream.end();
    expect(api.posts).toHaveLength(0);
    expect(ref).toEqual({ surface: 'slack', conversation: 'C0DEMO', id: '' });
  });
});
```

Add to `session.test.ts`'s capabilities case: `streaming: true, inlineConfirm: false`, and one case that `session.startStream('C0DEMO', { replyTo: ref })` appends and ends through the fake api (one post, one final update in the thread).

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @harness/surface-slack test`
Expected: FAIL — `Cannot find module './stream.js'`.

- [ ] **Step 3: Write the stream**

Create `surfaces/slack/src/stream.ts`:

```ts
import type { MessageRef, StreamHandle } from '@harness/surface-api';
import type { SlackApi } from './transport/types.js';

const NAME = 'slack';

/**
 * How often a streamed reply is edited. `chat.update` is a Tier 3 method (about fifty calls a
 * minute per app); one edit every 1.5 s per reply leaves room for several replies at once and
 * for the approvals loops' own calls.
 */
export const STREAM_EDIT_INTERVAL_MS = 1500;

export interface StreamDeps {
  api: SlackApi;
  conversation: string;
  threadTs?: string;
  now?: () => number;
  setTimeout?: typeof setTimeout;
}

/**
 * A streamed reply as one message edited in place. The first delta posts the message; every
 * later delta is folded into the next edit, which happens no sooner than the interval after the
 * previous call; `end` waits for the post, edits once more with the whole text, and returns the
 * message. Errors on an edit are swallowed — the text arrives with the next edit or the final
 * one — and a failed first post fails `end`, so the host logs it once.
 */
export function createEditStream(deps: StreamDeps): StreamHandle {
  const now = deps.now ?? (() => Date.now());
  const schedule = deps.setTimeout ?? setTimeout;
  let text = '';
  let ts: string | null = null;
  let posting: Promise<void> | null = null;
  let lastCall = 0;
  let pending = false;

  const post = (): Promise<void> =>
    (posting ??= deps.api.chat
      .postMessage({ channel: deps.conversation, text, thread_ts: deps.threadTs })
      .then((res) => {
        ts = res.ts ?? '';
        lastCall = now();
      }));

  const edit = async (): Promise<void> => {
    await posting;
    if (!ts) return;
    lastCall = now();
    await deps.api.chat.update({ channel: deps.conversation, ts, text }).catch(() => undefined);
  };

  const scheduleEdit = (): void => {
    if (pending) return;
    pending = true;
    const wait = Math.max(0, STREAM_EDIT_INTERVAL_MS - (now() - lastCall));
    schedule(() => {
      pending = false;
      void edit();
    }, wait);
  };

  return {
    append(delta) {
      text += delta;
      if (!posting) void post();
      else scheduleEdit();
    },
    async end() {
      if (!posting) return { surface: NAME, conversation: deps.conversation, id: '' };
      await posting;
      if (ts) await deps.api.chat.update({ channel: deps.conversation, ts, text });
      return { surface: NAME, conversation: deps.conversation, id: ts ?? '' };
    },
  };
}
```

In `session.ts`: `capabilities: { forms: true, privateReply: true, update: true, streaming: true, inlineConfirm: false }` and

```ts
    startStream(conversation, opts = {}) {
      assertConversation(conversation);
      return createEditStream({ api, conversation, threadTs: opts.replyTo?.id });
    },
```

The final `end` edit is awaited without a catch, so a reply that never reached Slack is an error the host logs (Plan 8a's `runTurn` catches it).

- [ ] **Step 4: Run green, the gates, commit**

Run: `pnpm --filter @harness/surface-slack test`, then the four gates and `pnpm test`.
Expected: all green; both snapshots unchanged.

Add a "Streaming" section to `surfaces/slack/README.md` (edits at a bounded rate; the native streaming API as the upgrade path and why it was not used).

```bash
git add surfaces/slack
git commit -m "feat(surface-slack): stream a reply as one message edited at a bounded rate"
```

### Task 3: The cutover — Hermes retired, one app, the final Compose shape, the four-file client folder

**Files:**
- Delete: `harness/compose/hermes.Dockerfile`, `clients/demo-practice/hermes.config.yaml`, `clients/demo-practice/cron/playbooks.sh`, `clients/demo-practice/scripts/harness-outbox-watchdog.sh`, `clients/demo-practice/scripts/harness-reconcile-watchdog.sh`
- Modify: `harness/compose/docker-compose.yml`, `node.Dockerfile`, `files.Dockerfile`, `docs/architecture/compose-surface.yaml` (re-recorded), `harness/core-tools/src/app/surface.test.ts`, `harness/host/src/app/main.ts`, `clients/demo-practice/SOUL.md`, `identity.yaml`, `.env.example`, root `.env.example`, root `package.json`, `.github/workflows/ci.yml`, `scripts/src/domain/scaffold.ts`, `scaffold.test.ts`, `scripts/src/app/cli.ts`

---

- [ ] **Step 1: Write the failing expectations**

In `harness/core-tools/src/app/surface.test.ts`:

- "the files worker boundary": the reached-by case iterates `['host']` only and is renamed "is reached by the host, which tells core-tools where the worker is".
- "the Compose stack names no client and mounts no socket": add

```ts
  it('runs exactly the five services of the kernel design, and no Hermes', async () => {
    const { services } = parseYaml(await rendered()) as { services: Record<string, unknown> };
    expect(Object.keys(services).sort()).toEqual(['core-tools', 'files', 'host', 'litellm', 'postgres']);
    expect(await rendered()).not.toMatch(/hermes/i);
  });

  it('gives the host the one Slack app and no second one', async () => {
    const { services } = parseYaml(await rendered()) as { services: Record<string, { environment?: Record<string, string> }> };
    expect(services.host.environment?.SLACK_BOT_TOKEN).toBeDefined();
    expect(services.host.environment?.SLACK_APP_TOKEN).toBeDefined();
    expect(Object.keys(services.host.environment ?? {}).filter((k) => k.startsWith('APPROVALS_SLACK'))).toEqual([]);
  });
```

In `scripts/src/domain/scaffold.test.ts` the scaffold writes only `SOUL.md`, `identity.yaml`, `policy.yaml`, `routing.yaml` and `.env.example` (drop `hermes.config.yaml`, `cron/`, `scripts/`); the copied-list expectation becomes those five; the "reports routing.yaml as skipped" and "copies routing.yaml when it exists" cases collapse into one that asserts a template missing `routing.yaml` reports it as skipped; the executable-bit case goes (nothing copied is executable); the `hermes.config.yaml` substitution assertions become an `identity.yaml` one (`HARNESS_CLIENT=river-clinic` in `.env.example` stays).

Run: `pnpm --filter @harness/core-tools exec vitest run src/app/surface.test.ts && pnpm --filter @harness/scripts test` — Expected: FAIL.

- [ ] **Step 2: Compose and the images**

In `harness/compose/docker-compose.yml`:

- delete the `hermes-init` and `hermes` services and the `hermesdata` volume;
- in `host`, replace the `APPROVALS_SLACK_BOT_TOKEN`/`APPROVALS_SLACK_APP_TOKEN` lines with `SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN:-}'` and `SLACK_APP_TOKEN: '${SLACK_APP_TOKEN:-}'`, and change the comment to "The one Slack app: chat and approvals." (the `SLACK_ALLOWED_USERS` line went in Plan 8a Task 9);
- rewrite the header comment: `postgres` and `litellm` have no profile; `files` and `host` are the `demo` profile; `core-tools` is build-only for the inspector and the eval runner; every client path derives from `HARNESS_CLIENT`; no Docker socket.

In `node.Dockerfile` add, before `USER node`:

```dockerfile
# The storage volume's layout. Docker seeds a fresh named volume from the image's directory at the
# mount path, ownership included, so the first container to mount `storage` leaves `incoming/` and
# `out/` owned by the uid the host runs as. hermes-init used to chown the volume; nothing needs to.
RUN mkdir -p /srv/harness-storage/incoming /srv/harness-storage/out && chown -R node:node /srv/harness-storage
```

and the same lines in `files.Dockerfile` (both images mount the volume; whichever starts first seeds it). Rewrite `node.Dockerfile`'s header (the host: the runtime, the surfaces and the identity plug-in it loads, core-tools in-process; the whole workspace is installed because the plug-ins are workspace packages). Delete `hermes.Dockerfile`. In `harness/host/src/app/main.ts` add, after `config` is built: `await mkdir(path.join(config.storageDir, 'incoming'), { recursive: true }); await mkdir(outRoot(config.storageDir), { recursive: true });` (decision 4's belt). In `.github/workflows/ci.yml` delete the `cp .env.ci .env` step and its comment (no service has an `env_file` any more).

- [ ] **Step 3: The client folder and the variables**

Delete `clients/demo-practice/hermes.config.yaml`, `cron/` and `scripts/`. In `clients/demo-practice/SOUL.md` replace rule 9 with:

```
9. **Files a human attaches are already in the store.** The message lists each
   one as `incoming/<name>`; pass that path to `documents_ingest`. Never invent
   a path and never pass an absolute one.
```

and change "You work in Slack with" to "You work in chat with" in the opening paragraph (the persona is not the surface's). In `identity.yaml` delete the `svc-hermes` entry and reword the header's placeholder note: "Replace the two Slack member ids with the real ones before the first run; see the runbook's onboarding section for how to read a member id." In the root `.env.example` delete the `# --- Hermes container` block (`HERMES_UID`, `HERMES_GID`) and the `SLACK_HOME_CHANNEL`/`SLACK_HOME_CHANNEL_NAME` lines; reword any remaining "Hermes" sentence (the `HARNESS_PRINCIPAL` comment says "the Hermes and approvals containers set their own" — it becomes "the host uses HARNESS_HOST_PRINCIPAL"). Same in `clients/demo-practice/.env.example`. In the root `package.json` delete `demo:playbooks` and change `demo:logs` to `... logs -f host`.

- [ ] **Step 4: The scaffolder**

In `scripts/src/domain/scaffold.ts`: `TEMPLATE_FILES = ['SOUL.md', 'identity.yaml', 'policy.yaml', 'routing.yaml', '.env.example'] as const`; delete `SCRIPT_DIR`, the scripts loop, and the executable-bit code in `copyTextFile`; update the header comment (a client is content and configuration: four files and an env example). In `scripts/src/app/cli.ts` replace steps 2 and 4 of the "Next" text with: "2. Create one Slack app (Socket Mode and Interactivity on; see docs/runbook.md), paste its two tokens and the approvals channel id, and put the two humans' Slack member ids in identity.yaml." and "4. `COMPOSE_PROJECT_NAME=<slug> docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo up -d --build`, or `pnpm demo:up` with HARNESS_CLIENT set in .env."

- [ ] **Step 5: Re-record, run everything, commit**

Run: `pnpm surface:record`; inspect `git diff docs/architecture/compose-surface.yaml`: the `hermes-init` and `hermes` services and the `hermesdata` volume gone, `host` with `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` in place of the `APPROVALS_SLACK_*` pair, nothing else. Then `grep -ri hermes --include='*.ts' --include='*.yml' --include='*.yaml' --include='Dockerfile' --include='*.json' harness surfaces identities runtimes packs scripts clients evals .github` prints nothing. Then the four gates and `pnpm test`.
Expected: all green; the env scan passes with the removed names gone from source and example alike; `docker compose --env-file .env.ci -f harness/compose/docker-compose.yml --profile demo --profile build-only config` renders (CI builds it).

```bash
git add -A harness/compose docs/architecture/compose-surface.yaml harness/core-tools/src/app/surface.test.ts harness/host/src/app/main.ts clients/demo-practice .env.example package.json .github/workflows/ci.yml scripts
git commit -m "feat(compose): retire Hermes; one Slack app on the host; the four-file client folder"
```

### Task 4: Documentation

**Files:**
- Modify: `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `docs/runbook.md`, `docs/demo.md`, `surfaces/slack/README.md`, `harness/host/README.md`, `docs/architecture/graph.svg`

---

- [ ] **Step 1: The runbook**

- "The host and its surfaces": add "Inbound messages" — the mention rule (a channel message is answered only when the bot is mentioned; a direct message always), attachments in `incoming/`, streaming by edits.
- Replace "Slack credentials: two apps are required" with "Slack credentials: one app" — the scopes and event subscriptions from `.env.example`, Socket Mode and Interactivity on, invite the bot to the approvals channel and to every channel it should answer in; how to read a member id (profile → "Copy member ID") for `identity.yaml`.
- "Health": no watchdogs; `curl http://127.0.0.1:8787/healthz` is the manual check.
- "Onboarding a client": `pnpm new-client` writes the four files and `.env.example`; step 2 names `svc-host` and the two humans' member ids; step 3 is one app; `pnpm demo:up` with `HARNESS_CLIENT` set.
- "Playbooks": replaced by three sentences — the Hermes cron fleet is retired with Hermes; scheduled work returns in Plan 9 as `playbooks.yaml` and a scheduler in the host with a service principal; until then the `credentialing-expirations` skill runs when a human asks for it.
- "Runs and principals": every message from a person runs as that person's principal; `svc-host` for reconcile; `svc-local` for the stdio server.

- [ ] **Step 2: The demo, the README, ARCHITECTURE, CONTRIBUTING**

- `docs/demo.md`: "Before you start" loses `pnpm demo:playbooks` and the two-app table for a one-app paragraph; step 1 says "The host loads `credentialing-intake`…"; step 3 loses "the same skill runs nightly" (until Plan 9); the smoke checklist becomes: `ps` shows `postgres`, `litellm`, `files`, `host` up; `curl http://127.0.0.1:8787/healthz` answers `ok: true`; `exec host printenv SLACK_APP_TOKEN` prints the one token; a direct message to the bot is answered; a mention in a channel is answered and an unmentioned message is not.
- `README.md`: line 6 becomes "Runtime: Deep Agents JS behind `@harness/runtime-api`, hosted by `@harness/host`"; "Run the demo practice" drops nothing but says one Slack app; "Layout" loses nothing (Plan 8a added the entries).
- `ARCHITECTURE.md`: "Surfaces" gains the inbound paragraph (mention rule, attachments, streaming by edits, `startStream`'s `recipient` hint); "The host and the runtime" (Plan 8a) loses "Hermes serves Slack chat until Plan 8b".
- `CONTRIBUTING.md`: "Adding a pack", step 10 loses the `hermes.config.yaml` bullet — `HARNESS_PACKS` in `.env` is the whole answer; "Adding a surface", step 4 describes `onMessage`'s `mentioned` rule and `startStream` with the Slack edits as the example.
- `surfaces/slack/README.md` and `harness/host/README.md`: final wording (one app, inbound, streaming; the host's startup `mkdir`).

- [ ] **Step 3: Regenerate the graph, run the gates, commit**

Run `pnpm arch:graph` if `which dot` prints a path; then the four gates and `pnpm test`.

```bash
git add README.md ARCHITECTURE.md CONTRIBUTING.md docs surfaces/slack/README.md harness/host/README.md
git commit -m "docs: one Slack app on the host, Hermes retired, playbooks return in Plan 9"
```

---

## Self-review

| Spec item | Task |
|---|---|
| 4.3 / decision 10: one Slack app carries chat and approvals; attachments land in `<storageDir>/incoming/`; `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` the one app, `APPROVALS_SLACK_*` retired, `SLACK_APPROVALS_CHANNEL` stays | 1, 3 |
| 4.3 `startStream` on Slack; `capabilities.streaming` | 2 |
| 3.2 step 1: `MessageEvent { surface: 'slack', userId, conversation, text, attachments, message, mentioned }` | 1 |
| 5.3 group conversations: answered only when mentioned or in a direct message (the adapter's half) | 1 (`classifyMessage`) |
| Decision 1 (spec): Hermes retired in Plan 8 | 3 |
| Section 7: Compose = `postgres`, `litellm`, `files`, `host`, `core-tools` build-only; no Docker socket; every client path from `HARNESS_CLIENT`; the client folder `SOUL.md`, `identity.yaml`, `policy.yaml`, `routing.yaml`; the scaffolder writes it; the runbook's onboarding is a folder, an `.env` and `pnpm demo:up` | 3, 4 |
| Section 7 "SOUL.md rules 6 and 9 rewritten (attachments are in incoming/)" | 3 (rule 6 was Plan 7's) |
| Section 10 exit criterion: a human talks to the agent in Slack through the host; an approval decided in Slack resumes the thread (the resume is Plan 8a's; the Slack card and press are unchanged and now carry a principal) | 1, 2, 3 with Plan 8a Tasks 5–8 |
| Decision 20 vocabulary: `hermes` nowhere in shipping source or Compose | 3 (the grep step) |
| Playbooks, cron and watchdogs retired, said in the runbook (the brief's instruction) | 3, 4 |

Not in this plan, and said where: `playbooks.yaml` and the scheduler (Plan 9); memory rendered into `RunRequest.memory` (Plan 9); the run API and `HARNESS_HOST_TOKEN` (Plan 10); Slack's native streaming API (decision 2, the adapter's README).

**Placeholder scan.** No "TBD", "TODO", "implement later", "similar to Task N" or "add appropriate …"; every code step carries the code; every path is exact.

**Type consistency.** `SlackInbound.files: { name, path }[]` (Task 1) is what `session.ts` maps to `MessageEvent.attachments` (Task 1) and what `FakeSlackEvents.emitMessage` takes in `session.test.ts`; `SlackConfig { botToken, appToken, defaultConversation }` (Task 1) is what `boltTransport(config, log, storageDir)` and `createSlackSession` read; `createEditStream` (Task 2) returns the contract's `StreamHandle` and is what `session.startStream` returns; `RawMessage` (Task 1) is what `classifyMessage` takes and both Bolt listeners cast to; the five `TEMPLATE_FILES` (Task 3) are what `scaffold.test.ts` scaffolds and asserts.
