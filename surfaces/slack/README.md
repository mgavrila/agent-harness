# @harness/surface-slack

Slack as one messaging surface. Block Kit, Bolt in Socket Mode, and the slice of the Web API the
host needs, all behind `@harness/surface-api`.

```text
src/config.ts            the three variables this adapter reads, from deps.env only
src/session.ts           SurfaceSession over the transport: post, update, reply, upload, open a form
src/stream.ts            startStream: a reply as one message edited at a bounded rate
src/format.ts            toMrkdwn: the model's Markdown as Slack mrkdwn, escaped for the API
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
message, for a mention, and for a reply inside a thread this assistant has posted in; a plain
channel message is `mentioned: false` and the host still receives it but does not answer. A **channel** `message` that carries the mention token is dropped,
because `app_mention` already delivered it — Slack sends both when the bot is a channel member. A
direct message is kept whether or not it names the bot, with the token stripped: `app_mention` is
documented for channels, and dropping a DM on the assumption it arrives twice would lose it
outright. Messages with a `bot_id`, any subtype but `file_share` (edits, deletions, joins), and any
message from Slack's own system user `USLACKBOT` (e.g. a "you were added to a channel" notice),
are dropped.

**A follow-up inside a thread the assistant has posted in needs no mention.** A reply is posted in
a thread under the message that caused it, so the natural next message is written in that thread,
and there the thread itself is the address: it arrives as an ordinary unmentioned `message` and is
classified `mentioned: true`, text untouched. A mention is still what starts a new thread or gets
an answer at a channel's top level, and a direct message needs no mention either way.

`classifyMessage` stays pure and reports the thread a channel reply belongs to; `classifyInbound`
decides. Behind it, `createThreadMemory` holds two bounded sets of `<channel>:<thread ts>` keys —
the threads the assistant has posted in, which `session.ts` records through
`SlackTransport.notePostedIn` whenever a turn replies in a thread or opens a stream in one, and
the threads a lookup said are somebody else's. Posting in a thread clears it from the second set
as it enters the first; nothing else does, so a thread the assistant joins late stops being
somebody else's at the moment it speaks there.

`notePostedIn` is given the message a reply answers, which inside an existing thread is not that
thread's root, and Slack keys every follow-up by the root. A third bounded store bridges the two:
the transport records `ts → thread_ts ?? ts` for each addressed message as it arrives, and
`notePostedIn` resolves the root through it, falling back to the id it was handed. A `notice` —
the host's unauthorised refusal — is the one post that claims no thread; it is something said
about a message rather than in answer to it, and a thread it claimed would answer the same sender
with another refusal for every line they wrote there.

Both sets are empty after a restart, so a key in neither is resolved by reading the thread once
(`conversations.replies`, 50 messages, covered by the `*:history` scopes already listed): a
message written by the bot user, or carrying this app's own `bot_id` (Bolt's `context.botId`),
means the thread is the assistant's. Another workspace bot's message does not — a GitHub or
PagerDuty thread is not a thread this assistant joined. Either answer is cached, so a busy thread
costs one call; a failed lookup is cached as nothing, treated as not addressed, and logged at most
once a minute for as long as it keeps failing.

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

## Outgoing text

`toMrkdwn` (`src/format.ts`) is what every reply passes through on its way out, because Slack does
not parse Markdown: `**bold**`, `# heading` and `[text](url)` reach a channel as literal
characters. It escapes `&`, `<` and `>` first — Slack's `mrkdwn` contract asks a caller to — and
holds the Slack syntax already in the text (`<@U…>`, `<#C…|…>`, `<!here>`, `<url|label>`) and a
line-leading `>` out of that pass, so escaping never corrupts a mention or the link syntax the
function itself emits afterwards. Code spans, fenced blocks and GFM tables (rendered as a fence,
since `mrkdwn` has no table of its own) are held aside and put back verbatim; a link's URL and a
bare URL are held too, before any emphasis runs, so an `_` or a `*` in a destination is never read
as a marker and never rewritten.

Emphasis is one left-to-right scan rather than one regex, so a bold span can hold an italic one
(`**bold *and emphatic*, too**`) and nothing the scan has converted is re-read as another marker.
Two rules are narrower than Markdown's, both because of Slack: a lone `*…*` is italic only around a
single word, inside a `**…**` span, or around one (`*italic **and strong** too*`), since a plain
`*two words*` is exactly what this function emits for bold and re-reading it would flip a bold
phrase to italic; and `__…__` is bold only between
non-word characters and around more than one word, so `__init__`, `__main__` and `MY__VAR__NAME`
keep their underscores. Everything but the escaping round-trips, and the one asterisk-wrapped
single word that does not is pinned by a test.

## Capabilities

Forms (a modal), private replies (ephemeral messages), editing a posted card and streaming: all
four.

## What is pinned

`src/render/blocks.test.ts` and `src/render/modal.test.ts` hold this adapter's output against the
literal Block Kit the approvals app produced before Plan 6, for the pending card, the approved and
declined decided cards and the edit modal. Those four expectations are evidence that a demo
deployment saw no change; edit them only when you mean to change what a human sees.
