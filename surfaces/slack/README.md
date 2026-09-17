# @harness/surface-slack

Slack as one messaging surface. Block Kit, Bolt in Socket Mode, and the slice of the Web API the
host needs, all behind `@harness/surface-api`.

```text
src/config.ts            the three variables this adapter reads, from deps.env only
src/session.ts           SurfaceSession over the transport: post, update, reply, upload, open a form
src/render/blocks.ts     a Card as Block Kit. Byte-pinned against what the app produced before Plan 6
src/render/modal.ts      a Form as a Slack modal view, and reading a submission back
src/transport/           the SlackApi slice, the WebClient adapter, the Bolt listener, the file
                         downloader, the fakes
src/testing.ts           ./testing: FakeSlack, FakeSlackEvents, fakeSlackSession
```

## One Slack app

This adapter reads `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` (Socket Mode) and
`SLACK_APPROVALS_CHANNEL` (where approval cards and released files go). One app carries chat and
approvals, because one process — the host — holds both connections; two apps were needed only
while Hermes and the approvals process were separate, and that reasoning is gone with the second
process. The app needs Interactivity on (for the approval buttons and the note modal) and is
subscribed to `message.channels`, `message.groups`, `message.im`, `message.mpim` and
`app_mention`; its bot scopes are `chat:write`, `app_mentions:read`, `channels:history`,
`groups:history`, `im:history`, `im:read`, `im:write`, `mpim:history`, `users:read`,
`files:read`, `files:write`. `SLACK_ALLOWED_USERS` is gone: who may decide is the identity
plug-in's answer now — a principal of `kind: 'user'` at level `lead` or above, resolved from the
Slack user id on this surface — not a variable this adapter reads.

`Surface.secrets` names this app's two tokens, so an operator wiring a container that should
never hold a Slack credential knows to leave both out of it.

## Inbound: messages, mentions and attachments

Bolt's `message` and `app_mention` listeners narrow every payload to a `SlackInbound` and hand it
to the one handler `SurfaceSession.onMessage` registered. `mentioned` is true for a direct
message and for a mention; a plain channel message is `mentioned: false` and the host still
receives it but does not answer. A `message` that carries the mention token is dropped, because
`app_mention` already delivered it — Slack sends both when the bot is a channel member. Messages
with a `bot_id`, and any subtype but `file_share` (edits, deletions, joins), are dropped.

A file attached to a message is downloaded by `transport/files.ts` with the bot token into
`<storageDir>/incoming/<message ts, dot replaced by a dash>-<file name, sanitised to
[A-Za-z0-9._-]>`, checked against the storage root before anything is written. A download that
fails drops that one attachment (logged by name, never by its signed URL) and the message is
still delivered. `MessageEvent.attachments[].path` is that name, relative to `incoming/`.

## Capabilities

Forms (a modal), private replies (ephemeral messages) and editing a posted card: all three.
Streaming is not yet: `capabilities.streaming` is false until Plan 8b's next task.

## What is pinned

`src/render/blocks.test.ts` and `src/render/modal.test.ts` hold this adapter's output against the
literal Block Kit the approvals app produced before Plan 6, for the pending card, the approved and
declined decided cards and the edit modal. Those four expectations are evidence that a demo
deployment saw no change; edit them only when you mean to change what a human sees.
