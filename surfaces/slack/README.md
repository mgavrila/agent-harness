# @harness/surface-slack

Slack as one messaging surface. Block Kit, Bolt in Socket Mode, and the slice of the Web API the
host needs, all behind `@harness/surface-api`.

```text
src/config.ts            the four variables this adapter reads, from deps.env only
src/session.ts           SurfaceSession over the transport: post, update, reply, upload, open a form
src/render/blocks.ts     a Card as Block Kit. Byte-pinned against what the app produced before Plan 6
src/render/modal.ts      a Form as a Slack modal view, and reading a submission back
src/transport/           the SlackApi slice, the WebClient adapter, the Bolt listener, the fakes
src/testing.ts           ./testing: FakeSlack, FakeSlackEvents, fakeSlackSession
```

## Two Slack apps, not one

This adapter needs `APPROVALS_SLACK_BOT_TOKEN` and `APPROVALS_SLACK_APP_TOKEN`, which are a
_different_ Slack app from Hermes's. Slack routes each Socket Mode event to exactly one of an
app's open connections, so one shared app loses about half of every button click. There is
deliberately no fallback to `SLACK_BOT_TOKEN`. It also reads `SLACK_APPROVALS_CHANNEL` (where
cards go). All three names are unchanged from before the surface contract existed.
`SLACK_ALLOWED_USERS` is gone: who may decide is the identity plug-in's answer now — a principal
of `kind: 'user'` at level `lead` or above, resolved from the Slack user id on this surface — not
a variable this adapter reads.

`Surface.secrets` names Hermes's `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` as well as this
adapter's own two, so an operator wiring a container that should not hold the approver's
credentials knows to leave all four out of it.

## Capabilities

Forms (a modal), private replies (ephemeral messages) and editing a posted card: all three.

## What is pinned

`src/render/blocks.test.ts` and `src/render/modal.test.ts` hold this adapter's output against the
literal Block Kit the approvals app produced before Plan 6, for the pending card, the approved and
declined decided cards and the edit modal. Those four expectations are evidence that a demo
deployment saw no change; edit them only when you mean to change what a human sees.
