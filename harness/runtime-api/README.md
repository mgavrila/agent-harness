# @harness/runtime-api

The contract between the host and a runtime plug-in. A runtime turns one `RunRequest` into a
stream of `RunEvent`s by driving an MCP client already connected to a core-tools server built on
that run's `ToolDeps`. The host loads a runtime by name and never sees how it gets there.

It depends on `@harness/shared`, zod and the MCP client type, and on nothing else in the
workspace (`runtime-api-imports-only-shared`), which is what lets the host load a plug-in by name
at runtime instead of importing it at build time.

| Module               | Holds                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| `src/types.ts`       | every declaration: `RunRequest`, `RunEvent`, `RuntimeSession`, `Runtime`, ... |
| `src/runtime.ts`     | `defineRuntime`                                                               |
| `src/gateway.ts`     | the fake OpenAI-wire gateway, reached as `@harness/runtime-api/testing`       |
| `src/scripted.ts`    | `ScriptedRuntime`, a model-free runtime that replays a trajectory             |
| `src/tool-server.ts` | `toolServerFixture`, an in-process MCP server for runtime tests               |
| `src/conformance.ts` | `runtimeConformance`, the shared spec-4.2 test suite                          |
| `src/testing.ts`     | re-exports all of the above, reached as `@harness/runtime-api/testing`        |

`RunPrincipal` is written out here, structurally a subset of the identity contract's `Principal`,
because this leaf may not import `@harness/identity-api`: a contract that tied the loop to one
way of knowing who is asking would defeat the point of having a contract.

`hashArgs`, the stable fingerprint every `tool_call` event and every audit row stamps on a tool's
arguments, lives in `@harness/shared` for the same reason: both runtimes and the kernel need it,
and neither runtime may import the kernel.

## `RunRequest`

What a runtime is handed to produce one answer: `runId`/`threadId`, the `principal` acting,
`input` (the human's text plus attachments), `history` (prior turns, already trimmed), `persona`
(the client document's own `persona` section), the `skills` it may activate, a curated `memory`
snapshot, an MCP `tools` client, the
`model` route (with the `user` every model request must carry, for attribution), a `budget`
(model/tool call caps and a timeout), and the `signal` that ends the run early.

## The seven events

A run is a stream of `RunEvent`: `text` (a delta), `tool_call` (a name and an args hash, never
the arguments themselves), `tool_result` (`ok` | `pending` | `error`), `skill_activated`,
`usage`, and exactly one terminal event — `done` with the final text, or `error` with a message
that is always safe to post, never a payload value.

## The six rules (spec 4.2)

Every runtime plug-in must:

1. Call tools only through `request.tools`, never by any other channel.
2. Never read `process.env`; a runtime's configuration arrives on the request and on
   `RuntimeDeps.env`.
3. Emit exactly one `done` or `error`, as its last event.
4. Stop within one model call of `request.signal` aborting, with a single `error: 'cancelled'`.
5. Emit `skill_activated` before the first tool call that skill's body causes.
6. Send `request.model.user` on every request to the model.

`runtimeConformance(name, harness)` states these once, as `describe`/`it` blocks, so every
runtime package runs the same suite against its own fixture instead of restating the rules.
`ScriptedRuntime` is its first subject; a model-backed runtime plugs in by scripting the fake
gateway instead of a trajectory.

## The `testing` subpath

`@harness/runtime-api/testing` is what a runtime test, or a host test, reaches for:

- `startFakeGateway` — a fake OpenAI-wire gateway that streams and scripts tool calls; both the
  double every runtime test drives and the double core-tools' own model-gateway tests drive.
- `ScriptedRuntime` / `scriptedRuntime` / `parseTrajectory` / `readTrajectory` — a runtime with no
  model, replaying a `Trajectory` (`{ tool, args }`, `{ say }`, `{ skill, version }`, `{ sleep }`
  steps) through `request.tools`, so the host and the approvals bridge are tested against a real,
  loaded runtime.
- `toolServerFixture` / `fixtureRequest` — an in-process MCP server (no socket) publishing a
  handful of scripted tools, and a `RunRequest` builder that fills in every field but `tools`
  with a test default.
- `runtimeConformance` — the six-rule suite above.

## The dependency rule

`@harness/runtime-api` may depend on `@harness/shared`, zod and the MCP client/server packages,
and nothing else in the workspace. It never imports `@harness/core-tools`, `@harness/identity-api`
or the host: a runtime is a plug-in the host loads by name, and a contract that pulled in the
kernel would tie every runtime to the kernel's own dependencies.
