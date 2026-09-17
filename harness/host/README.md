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
declared in `identity.yaml`: reconciliation runs as it, and Plan 9's playbooks will too.

Per-run ceilings the host hands the runtime: `HARNESS_RUN_MAX_MODEL_CALLS` (30),
`HARNESS_RUN_MAX_TOOL_CALLS` (60), `HARNESS_RUN_TIMEOUT_S` (600) — a run past any of them ends
with an error the human sees, and LiteLLM's own daily budget is the other half of this — and
`HARNESS_HISTORY_MAX_MESSAGES` (40), how many prior turns of a thread the runtime is handed
(also capped at 24,000 characters; the runtime's own checkpoint carries the rest).

## The flows

- **A message** (`handleMessage`, wired to every surface by `attachMessageHandlers`): resolve the
  principal (an unknown sender gets one refusal, once, and one audit row), find or create their
  thread, and run one turn (`runTurn`) — append the turn, ask the runtime, stream or post the
  reply, append the answer, close the run.
- **A decision** (`resumeOnDecision`, the approvals package's `onDecided` hook, wired through
  `decisionDeps`): once `@harness/approvals` records a decision and executes the approved action,
  find the thread the action was parked from and run one more turn on it, as the thread's own
  principal, with `resumeText(outcome)` — a host-authored message reporting what already
  happened — as the input. An approval parked outside a thread (the stdio server, the eval
  runner) has nothing to resume.

`openKernel`/`kernel.close` gives each run its own `ToolDeps` and in-process MCP client; the
runtime never talks to Postgres or the kernel directly.

## The loops, and health

`@harness/approvals`'s three loops run in this same process: poll pending approvals and post
their cards, dispatch the effects outbox to a surface, and reconcile stuck rows. `startHealthServer`
serves `GET /healthz` for the watchdogs, on `APPROVALS_HEALTH_PORT`/`APPROVALS_HEALTH_BIND` —
the names are unchanged from when `@harness/approvals` hosted its own process, because renaming
them would touch Compose, the snapshot and the runbook for no behaviour.

## Shutdown

`app/main.ts` traps `SIGINT`/`SIGTERM` and closes everything in the reverse of startup order:
abort every run still in `host.active`, stop the runner, close the health server, stop every
surface, stop the runtime, stop the identity plug-in, close the core-tools client, close the
database pool.

## Layout

```text
src/domain/host.ts             the Host type: everything a flow takes, built once per process
src/domain/runtime/registry.ts loadRuntime: HARNESS_RUNTIME, the same three failure modes as loadIdentity
src/domain/threads/repository.ts findOrCreateThread, appendMessage (with the redaction guard), recentHistory
src/domain/threads/trim.ts     trimHistory: the newest turns under a message and a character budget
src/domain/skills.ts           readSkillCatalogue: name, version, description off every SKILL.md
src/domain/persona.ts          readPersona: SOUL.md
src/domain/kernel.ts           openKernel: one run, one ToolDeps, one in-process MCP client
src/domain/conversation.ts     runTurn, handleMessage, attachMessageHandlers, cancelRun
src/domain/resume.ts           resumeText, resumeOnDecision, decisionDeps: the onDecided hook
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
