# @harness/host

The one process that answers a message: it runs the kernel and an agent runtime together, one
conversation turn at a time, and resumes a thread once a parked approval is decided. It holds no
transport and no framework of its own — every plug-in is loaded by name, through a dynamic
import, and `pnpm arch` forbids a static edge from `harness/host/src` into any of them.

## The three plug-ins

| Plug-in  | Variable           | What it does                                                                                                                                                                                                                               |
| -------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Surfaces | `HARNESS_SURFACES` | Comma-separated adapter package names; the first is where an approval card is posted, every one of them is live for messages and decisions. Required, no default (`@harness/approvals`'s `loadSurfaces`).                                  |
| Identity | `HARNESS_IDENTITY` | Which plug-in resolves a surface user to a principal. Defaults to `@harness/identity-static`, reading `clients/<HARNESS_CLIENT>/identity.yaml`.                                                                                            |
| Runtime  | `HARNESS_RUNTIME`  | Which agent runtime drives the loop. Required, no default — a default here would name a specific plug-in's package in host source, the coupling `HARNESS_SURFACES` already avoids for the same reason; the demo's Compose service sets it. |

The host's own identity is `HARNESS_HOST_PRINCIPAL` (default `svc-host`), a service principal
declared in `identity.yaml`: reconciliation runs as it; a playbook runs as the service principal
its entry in `playbooks.yaml` names.

The host also ships one skill of its own, in `skills/`: `knowledge-sync`, which the knowledge
refresh playbook names. It is offered beside every pack's, and the host's directory is read first,
so a pack cannot shadow it. Refreshing a knowledge base is no product area's business, which is
why it cannot live in a pack — and `preflightPlaybook` requires a playbook's skill to be one the
host offers, so the host has to offer it.

Per-run ceilings the host hands the runtime: `HARNESS_RUN_MAX_MODEL_CALLS` (30),
`HARNESS_RUN_MAX_TOOL_CALLS` (60), `HARNESS_RUN_TIMEOUT_S` (600) — a run past any of them ends
with an error the human sees, and LiteLLM's own daily budget is the other half of this — and
`HARNESS_HISTORY_MAX_MESSAGES` (40), how many prior turns of a thread the runtime is handed
(also capped at 24,000 characters; the runtime's own checkpoint carries the rest).

The run API's own variables are `HARNESS_HOST_TOKEN` (no default; unset means no listener),
`HARNESS_HOST_BIND` (`127.0.0.1`) and `HARNESS_HOST_PORT` (8788). Before any of that, `main.ts`
calls `assertEmbedDims`, which compares `HARNESS_EMBED_DIMS` against the width
`knowledge_chunks.embedding` was created at and refuses to start when they disagree — better than
failing halfway through the first knowledge sync.

At startup the host also `mkdir -p`s `<storageDir>/incoming` and `<storageDir>/out` — a belt to
`node.Dockerfile`'s own braces, which already give the image that layout — so a bare-metal run or
a bind-mounted storage directory still has both.

## The flows

- **A message** (`handleMessage`, wired to every surface by `attachMessageHandlers`): resolve the
  principal (an unknown sender gets one refusal, once, and one audit row), find or create their
  thread, and — when the surface says the message is addressed to it (`MessageEvent.mentioned`:
  true for a direct message or a mention, false for a channel message that is neither, in which
  case the host returns without running) — run one turn (`runTurn`): append the turn, render the
  caller's memory snapshot into the request, ask the runtime, stream the reply as it arrives on a
  surface whose `capabilities.streaming` is true or
  post it once at `done` otherwise, append the answer, close the run. An inbound file is already
  downloaded into `<storageDir>/incoming/` by the surface before the host ever sees the message;
  `MessageEvent.attachments[].path` names it relative to that directory.
- **A decision** (`resumeOnDecision`, the approvals package's `onDecided` hook, wired through
  `decisionDeps`): once `@harness/approvals` records a decision and executes the approved action,
  find the thread the action was parked from and run one more turn on it, as the thread's own
  principal, with `resumeText(outcome)` — a host-authored message reporting what already
  happened — as the input. An approval parked outside a thread (the stdio server, the eval
  runner) has nothing to resume.
- **A playbook** (`executePlaybook`, driven by `startScheduler`'s tick every `SCHEDULER_TICK_MS`):
  claim the due rows and the requested ones (`claimDuePlaybooks`, skip-locked), preflight each
  (`preflightPlaybook`), open or reuse the playbook's own thread and run one turn as its service
  principal with `deliver` from the file, its one skill, its timeout and its cost cap; retry once
  on a transport failure; close the `playbook_runs` row; stage one failure notice
  (`stagePlaybookNotice`) through the outbox. `syncPlaybooks` reads `playbooks.yaml` into the
  table at startup.

`openKernel`/`kernel.close` gives each run its own `ToolDeps` and in-process MCP client; the
runtime never talks to Postgres or the kernel directly.

All three flows go through `serialize`, which chains a thread's turns on `host.turns`: a second
message in the same conversation, a decision resuming a thread that is still mid-turn, or a
playbook firing on its own thread waits for the turn in flight instead of running beside it. A runtime keeps its own state per thread — the Deep
Agents checkpointer is keyed on the thread id — and two turns writing it at once leave only the
one that finished last. The chain is per thread, so different conversations still run at once.

## The loops, and health

`@harness/approvals`'s three loops run in this same process: poll pending approvals and post
their cards, dispatch the effects outbox to a surface, and reconcile stuck rows. `startHealthServer`
serves `GET /healthz` for whatever probe an operator points at it — the two watchdog scripts that
used to poll it are gone — on `APPROVALS_HEALTH_PORT`/`APPROVALS_HEALTH_BIND` —
the names are unchanged from when `@harness/approvals` hosted its own process, because renaming
them would touch Compose, the snapshot and the runbook for no behaviour.

The scheduler is a fourth loop of the same shape; its status is on its handle and in the log, and
on the run API's `GET /v1/status`, never on `/healthz`.

## The run API

An HTTP way in, in `src/domain/api/`, for a caller with no messaging surface (spec 5.8). It is the
host's, not a surface's: the request says which loaded surface a run belongs to, so one listener
drives a run on any of them.

| Route                                       | What it answers                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/runs`                             | `202` and a Server-Sent Events stream: `run` with the run id, the runtime's own events, then `result`                          |
| `POST /v1/runs/:id/cancel?surface=&userId=` | `{ run_id, cancelled }`                                                                                                        |
| `GET /v1/threads/:id?surface=&userId=`      | the thread and its most recent 200 messages, newest last                                                                       |
| `GET /v1/status`                            | the client, the loaded surfaces, the primary one, the runs in flight, whether the host is draining, and the scheduler's status |

Every route is behind `Authorization: Bearer $HARNESS_HOST_TOKEN`, compared in constant time, the
status route included. **No token, no listener at all**: `app/main.ts` starts nothing and the
`listening` line ends `runApi=off (set HARNESS_HOST_TOKEN)`. The bearer secret says the caller may
use the API; it never says who they are acting as. That stays the identity plug-in's answer, from
the `surface` and `userId` the request names, resolved exactly as an adapter's message is. A run or
a thread belonging to another principal answers `404`, the same as one that does not exist.

The turn runs with `deliver: 'none'` — the stream is the reply, and nothing is posted to the named
surface — and the listener is closed before the drain at shutdown, so an open stream does not hold
the process up.

## Watching a turn

`TurnInput.observe` is the one hook `runTurn` grew for the run API, and the only thing that uses it
today. A watcher is handed the run id first — before the first runtime event, so a caller can
cancel a run it has not seen a word of — then every event the runtime produced, unfiltered, then
exactly one outcome. Exactly one on every path: the turn returning, the runtime failing, or a throw
on the way there, which reports `status: 'error'` with the reason the turn had already settled on
or `the runtime failed; see the host log`. A `runTurn` that rejects before the run is open calls the
watcher not at all, because there is no run to report.

A watcher is watching, not taking part. One that throws, or whose promise rejects, is logged once
for that event and changes nothing about the outcome or the run row. Its call is awaited, which is
what catches an `async` watcher's rejection — and also why a watcher should stay synchronous: the
turn waits for it between runtime events, so one that waits on network input/output
back-pressures the runtime's own loop. The run API's writer is where the restricted-pattern check
is applied on the way out; the events themselves are unfiltered.

## Shutdown

`app/main.ts` traps `SIGINT`/`SIGTERM` and closes everything in the reverse of startup order:
`scheduler.stop()` first, so no further tick starts, though its promise is awaited only after the
drain — the tick in flight is waiting on a turn that only the drain can abort. Then the run API's
listener, before the drain and with its open connections closed, so nothing new is accepted while
the turns in flight unwind and a caller still listening to a stream does not hold the shutdown
open. Then `drainActive`
— it cancels every run still in `host.active` and waits, for at most ten seconds, until each turn
has closed its run row and its kernel — and then the scheduler's own wait, under that same
ten-second bound: a runtime that ignores its abort is logged and the process stops anyway rather
than holding the shutdown open. Then stop the runner, close the health server, stop every surface,
stop the runtime, stop the identity plug-in, close the core-tools client, close the database pool.
The drain comes before all of those because each of them takes away something a turn is still
using: the runtime's `stop()` ends its checkpointer pool and
`closeDb()` the host's, and a turn that lost that race left its `runs` row `running` forever.
Nothing sweeps such a row — `harness_reconcile` reads approvals and dispatches, never `runs`. The
drain also sets `host.draining`, which is what keeps a turn still queued on a thread's chain from
starting behind it: it is dropped with a log line rather than opening a run nothing would be left
to close.

## Layout

```text
src/domain/host.ts             the Host type: everything a flow takes, built once per process
src/domain/runtime/registry.ts loadRuntime: HARNESS_RUNTIME, the same three failure modes as loadIdentity
src/domain/threads/repository.ts findOrCreateThread, appendMessage (with the redaction guard), recentHistory
src/domain/threads/trim.ts     trimHistory: the newest turns under a message and a character budget
src/domain/skills.ts           kernelSkillsDir, readSkillCatalogue: name, version, description off every SKILL.md
src/domain/persona.ts          readPersona: SOUL.md
src/domain/kernel.ts           openKernel: one run, one ToolDeps, one in-process MCP client
src/domain/conversation.ts     runTurn, handleMessage, attachMessageHandlers, serialize, cancelRun, drainActive
src/domain/resume.ts           resumeText, resumeOnDecision, decisionDeps: the onDecided hook
src/domain/playbooks/schema.ts     nextRunAfter (the playbook schema itself lives in @harness/config-api)
src/domain/playbooks/repository.ts syncPlaybooks, claimDuePlaybooks, finishPlaybookRun
src/domain/playbooks/preflight.ts  preflightPlaybook
src/domain/playbooks/notice.ts     stagePlaybookNotice, playbookNoticeKey
src/domain/playbooks/scheduler.ts  startScheduler, executePlaybook, SCHEDULER_TICK_MS
src/domain/api/types.ts        the run API's limits and defaults: the body, text and attachment caps
src/domain/api/sse.ts          the Server-Sent Events writer: 202, the three headers, the keep-alive
src/domain/api/routes.ts       bearerOk, readBody, callerOf, the four routes
src/domain/api/repository.ts   findRunFor, readThreadFor: this principal's row or nothing
src/domain/api/server.ts       startRunApi: the node:http listener
skills/knowledge-sync/         the one skill the host itself ships
src/app/main.ts                the composition root: env, the three plug-ins, the loops, health, shutdown
src/index.ts                   the public API
src/testing.ts                 ./testing: testKernelConfig, hostFixture, useTestDb
```

## The host never statically imports a plug-in

Surfaces, the identity plug-in and the runtime are all loaded by name, at startup, through a
dynamic import — the same shape `@harness/core-tools`'s `loadPacks` and `loadIdentity` and
`@harness/approvals`'s `loadSurfaces` already use. `pnpm arch` forbids a static edge from
`harness/host/src` into `surfaces/*`, `identities/*`, `runtimes/*` or `packs/*`; `src/testing.ts`
and `*.test.ts` are exempt, because a host test drives the real memory surface and the real
runtime loader against the packages that ship, and neither is shipped itself.

## Testing

```bash
pnpm --filter @harness/host test
```

Real Postgres (`harness_test`) through `useTestDb()` from `./testing`, `MemorySurface`, a static
identity and a scripted runtime — for the resume flow, driven the same way a real decision would
arrive: through `@harness/approvals`'s own handlers and poller, against `hostFixture`'s real
kernel.
