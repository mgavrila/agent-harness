# @harness/approvals

The approvals host. It polls `approvals` for pending rows and posts a card on the primary
messaging surface, records the decision, calls `approvals_execute` over a stdio MCP client, and
drains the `tool_effects` outbox through the `surface_message` and `surface_file` sinks on a
timer.

It holds no transport. Adapters are loaded by name from `HARNESS_SURFACES`, which is required and
has no default in this package — the demo's Compose service sets `@harness/surface-slack`. Everything
the host says is a neutral `Card`, `Form` or line of text from `@harness/surface-api`.

## Layout

```text
src/domain/cards.ts      approvalCard, decidedCard, editForm: what a human reads, in neutral models
src/domain/surfaces/     loadSurfaces: HARNESS_SURFACES, the primary rule, the failure messages
src/domain/handlers.ts   the button and form handlers, authorised per surface
src/domain/execute/      the CoreToolsClient interface, the stdio MCP adapter, FakeCoreToolsClient
src/domain/poller.ts     claim a pending row, post its card, record the message reference
src/domain/decisions.ts  the one writer of approvals.status outside core-tools
src/domain/sinks.ts      surface_message and surface_file senders for the outbox
src/domain/runner.ts     three independent loops: poll, dispatch, reconcile
src/domain/health.ts     GET /healthz for the cron watchdogs
src/app/main.ts          connects the surfaces, wires the handlers, starts the runner
src/app/child-env.ts     the allowlist the core-tools child process is launched with
src/index.ts             the public API
src/testing.ts           ./testing: MemorySurface, FakeCoreToolsClient, useTestDb
```

## Slack

See `surfaces/slack/README.md`. The short version is that the host needs its own Slack app, not
Hermes's.

## What it must never do

- Write `approvals.status` anywhere but `decideApproval`.
- Call a tool handler directly. Execution goes through `approvals_execute` over MCP, so it
  lands in `audit_log` like any other call.
- Put a restricted value on a card. `containsRestrictedPattern` from `@harness/core-tools/redaction`
  guards the payload, the decision note and a tool's error text, and the file sink checks
  containment again before it uploads anything.

## Testing

```bash
pnpm --filter @harness/approvals test
```

Real Postgres (`harness_test`) through `useTestDb()`, `MemorySurface` and `FakeCoreToolsClient`
from `./testing`. The dual-surface suite loads the real Slack adapter beside it over
`fakeSlackSession` from `@harness/surface-slack/testing`, so no call leaves the process.
