# @harness/surface-slack

Slack as one messaging surface. Block Kit, Bolt in Socket Mode, and the slice of the Web API the
host needs, all behind `@harness/surface-api`.

```text
src/config.ts            the three variables this adapter reads, from deps.env only
src/session.ts           SurfaceSession over the transport: post, update, reply, upload, open a form
src/stream.ts            startStream: a reply as one message edited at a bounded rate
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
while the chat runtime and the approvals process were separate, and that reasoning is gone with
the second process. The app needs Interactivity on (for the approval buttons and the note modal)
and is subscribed to `message.channels`, `message.groups`, `message.im`, `message.mpim` and
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
receives it but does not answer. A **channel** `message` that carries the mention token is dropped,
because `app_mention` already delivered it — Slack sends both when the bot is a channel member. A
direct message is kept whether or not it names the bot, with the token stripped: `app_mention` is
documented for channels, and dropping a DM on the assumption it arrives twice would lose it
outright. Messages with a `bot_id`, and any subtype but `file_share` (edits, deletions, joins),
are dropped.

**A follow-up inside a thread in a channel has to mention the bot again.** A reply is posted in a
thread under the message that caused it, so the natural next message is written in that thread —
where, in a channel, it arrives as an ordinary unmentioned `message` and the host stays silent.
Mention the bot in the thread and it answers, in that same thread. A direct message needs no
mention, in a thread or out of one.

A file attached to a message is downloaded by `transport/files.ts` with the bot token into
`<storageDir>/incoming/<message ts, dot replaced by a dash>-<file name, sanitised to
[A-Za-z0-9._-]>`, checked against the storage root before anything is written; two attachments
sharing a name in one message get `-2`, `-3`, ... before the extension. The URL is pinned to Slack
before the bot token is sent: `https:` on a `.slack.com` host, with redirects refused, and any
other URL drops that attachment the way a failed download does. A download over
`MAX_ATTACHMENT_BYTES` (64 MiB — Slack itself allows up to 1 GiB, which is not a size this host
buffers or stores unbounded) is refused: a declared `content-length` over the limit is refused
before a byte is read, and the body is otherwise streamed to disk and cut off — deleting whatever
was written so far — the moment it passes the limit regardless of what `content-length` claimed.
Any failed or refused download drops that one attachment (logged by name and reason, never by a
path or the signed URL) and the message is still delivered. `MessageEvent.attachments[].path` is
that name, relative to `incoming/`.

## Streaming

`startStream` (`src/stream.ts`) answers a run's text deltas as one message edited in place, over
the two calls the adapter already makes rather than Slack's native streaming API. The first delta
posts the message (in the thread, when asked to reply to one); every later delta is folded into
the next edit, which happens no sooner than `STREAM_EDIT_INTERVAL_MS` (1.5 s) after the previous
one — `chat.update` is a Tier 3 method (about fifty calls a minute per app), and one edit per 1.5 s
per reply leaves room for several replies at once and for the approvals loops' own calls. `end`
waits for the post, sends one last edit with the whole text, and returns the message; a trailing
edit still waiting on its interval is folded into that final edit rather than fired again on a
stray timer. A mid-stream edit's failure is swallowed — the text arrives with the next edit or the
final one — but a failed post or a failed final edit rejects `end` with a `SurfaceError`, which the
host logs.

Slack's Web API also has a native streaming surface (`chat.startStream`/`appendStream`/`stopStream`
in the installed SDK). It was not used here: outside a direct message it wants a recipient user and
team the adapter cannot always supply, and it is new enough that this repository has no way to
exercise it against real Slack from a test. `startStream`'s `opts.recipient` carries the user a
reply is for, so an adapter that adopts the native API later has it in hand already. Edits are the
well-trodden path in the meantime.

## Capabilities

Forms (a modal), private replies (ephemeral messages), editing a posted card and streaming: all
four.

## What is pinned

`src/render/blocks.test.ts` and `src/render/modal.test.ts` hold this adapter's output against the
literal Block Kit the approvals app produced before Plan 6, for the pending card, the approved and
declined decided cards and the edit modal. Those four expectations are evidence that a demo
deployment saw no change; edit them only when you mean to change what a human sees.
