# @harness/approvals

The Slack app a human approves through. It polls `approvals` for pending rows and posts a
Block Kit card, records the decision, calls `approvals_execute` over a stdio MCP client, and
drains the `tool_effects` outbox through Slack sinks on a timer.

## Layout

```
src/domain/slack/     the SlackApi interface, the WebClient adapter, FakeSlack, the button handlers
src/domain/render/    types (ids, ApprovalRow), blocks (cards), modal (the note dialog)
src/domain/execute/   the CoreToolsClient interface, the stdio MCP adapter, FakeCoreToolsClient
src/domain/poller.ts  claim a pending row, post its card, record the timestamp
src/domain/decisions.ts  the one writer of approvals.status outside core-tools
src/domain/sinks.ts   slack_message and slack_file senders for the outbox
src/domain/runner.ts  three independent loops: poll, dispatch, reconcile
src/domain/health.ts  GET /healthz for the cron watchdogs
src/app/main.ts       Bolt in Socket Mode, the runner, the health server
src/app/child-env.ts  the allowlist the core-tools child process is launched with
src/index.ts          the public API
src/testing.ts        ./testing: FakeSlack, FakeCoreToolsClient, useTestDb
```

## Two Slack apps, not one

This process needs `APPROVALS_SLACK_BOT_TOKEN` and `APPROVALS_SLACK_APP_TOKEN`, which are a
_different_ Slack app from Hermes's. Slack routes each Socket Mode event to exactly one of an
app's open connections, so one shared app loses about half of every button click. There is
deliberately no fallback to `SLACK_BOT_TOKEN`.

## What it must never do

- Write `approvals.status` anywhere but `decideApproval`.
- Call a tool handler directly. Execution goes through `approvals_execute` over MCP, so it
  lands in `audit_log` like any other call.
- Put a restricted value on a card. `containsRestrictedPattern` from `@harness/core-tools`
  guards the payload, the decision note and a tool's error text, and the file sink checks
  containment again before it uploads anything.

## Testing

```bash
pnpm --filter @harness/approvals test
```

Real Postgres (`harness_test`) through `useTestDb()`, `FakeSlack` and `FakeCoreToolsClient`
from `./testing`. No real Slack call anywhere in the suite.
