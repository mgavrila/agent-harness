# @harness/approvals

The approvals domain. It polls `approvals` for pending rows and posts a card on the primary
messaging surface, records a decision from whoever the identity plug-in resolves as its
approver, executes it in-process against the kernel, and drains the `tool_effects` outbox
through the `surface_message` and `surface_file` sinks on a timer.

It holds no transport. Adapters are loaded by name from `HARNESS_SURFACES`, which is required and
has no default in this package — the demo's Compose service sets `@harness/surface-slack`. Everything
the host says is a neutral `Card`, `Form` or line of text from `@harness/surface-api`.

This package no longer hosts its own process. `src/app/main.ts` and `src/app/child-env.ts` are
gone — `@harness/host` is what opens a run and drives this domain, in the same process as the
kernel rather than as a stdio child of it.

## Layout

```text
src/domain/cards.ts      approvalCard, decidedCard, editForm: what a human reads, in neutral models
src/domain/surfaces/     loadSurfaces: HARNESS_SURFACES, the primary rule, the failure messages
src/domain/handlers.ts   the button and form handlers; who may decide comes from the identity plug-in
src/domain/execute/      the CoreToolsClient interface, the in-process adapter, FakeCoreToolsClient
src/domain/poller.ts     claim a pending row, post its card, record the message reference
src/domain/decisions.ts  the one writer of approvals.status outside core-tools
src/domain/sinks.ts      surface_message and surface_file senders for the outbox
src/domain/runner.ts     three independent loops: poll, dispatch, reconcile
src/domain/health.ts     GET /healthz for the cron watchdogs
src/index.ts             the public API
src/testing.ts           ./testing: MemorySurface, FakeCoreToolsClient, useTestDb
```

## Deciding by principal

A decision is accepted only from a `kind: 'user'` principal the identity plug-in resolves for the
surface user id that pressed the button, whose level clears `lead` — never from a service
principal, whatever its level, and never from an allowlist. Every refusal, whatever the reason,
gets the identical message: an outsider learns nothing about whether the approval even exists.

`decideApproval` executes the action through `CoreToolsClient.execute(approvalId, principal)`
**as that principal**: `createInProcessCoreToolsClient` (`src/domain/execute/in-process.ts`) opens
a fresh `runs` row for the call, builds one `ToolDeps` for it with `depsForRun`, connects an
in-process MCP client to a server on that bag, calls `approvals_execute`, and closes the run — so
the execution audits under the approver's own principal id, not a service account's. Housekeeping
(`reconcile`) runs the same way but as the host's own service principal.

`mayAct` (`src/domain/handlers.ts`) is what reads the identity plug-in: `DecisionDeps.identity`
is the `IdentitySession` the host connected, and `mayAct` calls `identity.resolve({ surface,
userId })` before anything else runs. `DecisionDeps.onDecided`, when the caller sets it, is
called after a decision is recorded, executed and shown; `@harness/host`'s `resumeOnDecision` is
the one implementation today — it looks the approval's `thread_id` up and runs one more turn on
that thread, as the thread's own principal, reporting what already happened.

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
